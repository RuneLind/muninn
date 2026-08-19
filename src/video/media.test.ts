import { test, expect } from "bun:test";
import {
  extractTikTokVideoId,
  extractXStatusId,
  canonicalXStatusUrl,
  frameBudgetFor,
  summarizeTimeoutFor,
  parseYtDlpJson,
  parseShowinfoTimestamps,
  YTDLP_FORMAT_SELECTOR,
} from "./media.ts";

// -- YTDLP_FORMAT_SELECTOR --------------------------------------------------
// These pin the properties that cost us the narration on TikTok
// 7646424593388883214, plus the size cap whose absence blew a real X capture
// from 173 MB to 824 MB. They are assertions about a string because yt-dlp owns
// the actual selection; the empirical check is "download a portrait video and
// ffprobe it for an audio stream", which lives outside the unit suite.
//
// No `/` appears inside the quoted regexes, so a plain split gives the tiers.
const TIERS = YTDLP_FORMAT_SELECTOR.split("/");

test("YTDLP_FORMAT_SELECTOR prefers h264 before any unconstrained fallback", () => {
  const firstH264 = TIERS.findIndex((t) => /vcodec/.test(t));
  const firstUnfiltered = TIERS.findIndex((t) => !t.includes("["));
  expect(firstH264).toBeGreaterThanOrEqual(0);
  // An unfiltered tier matches anything, so one ahead of the h264 tiers would
  // re-admit TikTok's audio-less bytevc1 (h265) formats.
  expect(firstUnfiltered).toBeGreaterThan(firstH264);
});

test("YTDLP_FORMAT_SELECTOR matches every h264 spelling hosts use", () => {
  // TikTok reports a bare `h264`, YouTube `avc1.42001E`. Matching only one
  // spelling is the bug this pins — `^=avc1` alone selected nothing on TikTok
  // and fell through to an audio-less h265 format.
  const patterns = [...YTDLP_FORMAT_SELECTOR.matchAll(/vcodec~='([^']+)'/g)];
  expect(patterns.length).toBeGreaterThan(0);
  for (const [, pattern] of patterns) {
    const re = new RegExp(pattern!);
    expect(re.test("h264")).toBe(true);
    expect(re.test("avc1.42001E")).toBe(true);
    expect(re.test("h265")).toBe(false);
    expect(re.test("hevc")).toBe(false);
  }
});

test("YTDLP_FORMAT_SELECTOR caps width and height together, above 1024", () => {
  // Two traps in one: a cap at or below 1024 matches nothing on portrait TikTok
  // (heights are 1024/1280/1920), and capping only `height` leaves landscape
  // uncapped — which is how X's vcodec-less formats reached 824 MB.
  const capped = TIERS.filter((t) => t.includes("<="));
  expect(capped.length).toBeGreaterThan(0);
  for (const tier of capped) {
    const dims = Object.fromEntries(
      [...tier.matchAll(/(width|height)\s*<=\s*(\d+)/g)].map(
        ([, dim, n]) => [dim, Number(n)],
      ),
    );
    expect(dims.width).toBeGreaterThanOrEqual(1280);
    expect(dims.height).toBeGreaterThanOrEqual(1280);
  }
});

test("YTDLP_FORMAT_SELECTOR ends with a split-stream fallback", () => {
  // Every `b`-family tier is pre-merged-only, so a DASH/HLS host with separate
  // audio and video streams matches none of them and yt-dlp exits 1.
  expect(TIERS.at(-1)).toBe("bv*+ba");
});

// -- extractTikTokVideoId ---------------------------------------------------

test("extractTikTokVideoId parses a canonical /video/ URL", () => {
  expect(
    extractTikTokVideoId("https://www.tiktok.com/@someuser/video/7364512345678901234"),
  ).toBe("7364512345678901234");
});

test("extractTikTokVideoId works with query strings and trailing paths", () => {
  expect(
    extractTikTokVideoId("https://www.tiktok.com/@u/video/12345?is_from_webapp=1&lang=en"),
  ).toBe("12345");
});

test("extractTikTokVideoId returns null for photo-mode URLs", () => {
  expect(
    extractTikTokVideoId("https://www.tiktok.com/@someuser/photo/7364512345678901234"),
  ).toBeNull();
});

test("extractTikTokVideoId returns null for vm/vt short links", () => {
  expect(extractTikTokVideoId("https://vm.tiktok.com/ZMabcd123/")).toBeNull();
  expect(extractTikTokVideoId("https://vt.tiktok.com/ZSabcd123/")).toBeNull();
});

test("extractTikTokVideoId returns null for garbage input", () => {
  expect(extractTikTokVideoId("")).toBeNull();
  expect(extractTikTokVideoId("not a url")).toBeNull();
  expect(extractTikTokVideoId("https://example.com/video/")).toBeNull();
  expect(extractTikTokVideoId("https://www.tiktok.com/@user")).toBeNull();
});

test("extractTikTokVideoId does NOT misfire on X status URLs ending in /video/1", () => {
  // X media-slot URLs end in /video/<slot-index> — without the host gate this
  // would extract "1" as a TikTok id and poison dedup.
  expect(
    extractTikTokVideoId("https://x.com/Kenjatina_og/status/2081279674966044799/video/1"),
  ).toBeNull();
});

// -- extractXStatusId / canonicalXStatusUrl ---------------------------------

test("extractXStatusId parses status URLs with and without /video/N suffix", () => {
  expect(
    extractXStatusId("https://x.com/Kenjatina_og/status/2081279674966044799/video/1"),
  ).toBe("2081279674966044799");
  expect(extractXStatusId("https://x.com/user/status/123456")).toBe("123456");
  expect(extractXStatusId("https://twitter.com/user/status/123456?s=20")).toBe("123456");
  expect(extractXStatusId("https://www.x.com/user/status/123456")).toBe("123456");
});

test("extractXStatusId returns null for non-X hosts and non-status URLs", () => {
  expect(extractXStatusId("https://www.tiktok.com/@u/video/12345")).toBeNull();
  expect(extractXStatusId("https://x.com/user")).toBeNull();
  expect(extractXStatusId("not a url")).toBeNull();
  expect(extractXStatusId("")).toBeNull();
});

test("canonicalXStatusUrl strips the /video/N suffix and query strings", () => {
  expect(
    canonicalXStatusUrl("https://x.com/Kenjatina_og/status/2081279674966044799/video/1"),
  ).toBe("https://x.com/Kenjatina_og/status/2081279674966044799");
  expect(canonicalXStatusUrl("https://x.com/user/status/123?s=20")).toBe(
    "https://x.com/user/status/123",
  );
  expect(canonicalXStatusUrl("https://x.com/user/status/123")).toBe(
    "https://x.com/user/status/123",
  );
});

test("canonicalXStatusUrl returns null when there is no status id", () => {
  expect(canonicalXStatusUrl("https://x.com/user")).toBeNull();
  expect(canonicalXStatusUrl("https://www.tiktok.com/@u/video/123")).toBeNull();
});

// -- frameBudgetFor ---------------------------------------------------------

test("frameBudgetFor gives 15 frames for clips up to a minute", () => {
  expect(frameBudgetFor(5)).toBe(15);
  expect(frameBudgetFor(30)).toBe(15);
  expect(frameBudgetFor(60)).toBe(15);
});

test("frameBudgetFor gives 25 frames from 1 to 3 minutes", () => {
  expect(frameBudgetFor(61)).toBe(25);
  expect(frameBudgetFor(120)).toBe(25);
  expect(frameBudgetFor(180)).toBe(25);
});

test("frameBudgetFor holds 30 frames from 3 to 10 minutes", () => {
  expect(frameBudgetFor(181)).toBe(30);
  expect(frameBudgetFor(600)).toBe(30);
});

test("frameBudgetFor grows past 10 minutes instead of collapsing the spacing", () => {
  // ~40s spacing until the ceiling: a flat 30 sampled a 60-min tutorial once
  // per 120s and a 3h X workshop once per 360s.
  expect(frameBudgetFor(601)).toBe(30);
  expect(frameBudgetFor(1200)).toBe(30);
  expect(frameBudgetFor(1600)).toBe(40);
  expect(frameBudgetFor(2400)).toBe(60);
  // Hard ceiling — 60 portrait frames is already ~37k tokens of images.
  expect(frameBudgetFor(3600)).toBe(60);
  expect(frameBudgetFor(10800)).toBe(60);
});

test("frameBudgetFor is defensive against non-finite input", () => {
  expect(frameBudgetFor(NaN)).toBe(15);
  expect(frameBudgetFor(0)).toBe(15);
});

// -- summarizeTimeoutFor ----------------------------------------------------

test("summarizeTimeoutFor holds the 600s floor up to 30 frames, then scales", () => {
  expect(summarizeTimeoutFor(0, 120_000)).toBe(600_000);
  expect(summarizeTimeoutFor(30, 120_000)).toBe(600_000);
  // Past the old flat budget every extra frame is another read in the same
  // multi-turn session: the 60-frame ceiling gets 20 min.
  expect(summarizeTimeoutFor(60, 120_000)).toBe(1_200_000);
  // A bot configured slower than the computed budget still wins.
  expect(summarizeTimeoutFor(0, 900_000)).toBe(900_000);
});

// -- parseYtDlpJson ---------------------------------------------------------

test("parseYtDlpJson extracts the fields we need", () => {
  const line = JSON.stringify({
    id: "7364512345678901234",
    title: "How diffusion models work",
    duration: 47,
    uploader: "airesearcher",
    webpage_url: "https://www.tiktok.com/@airesearcher/video/7364512345678901234",
    extra: "ignored",
  });
  expect(parseYtDlpJson(line)).toEqual({
    id: "7364512345678901234",
    title: "How diffusion models work",
    duration: 47,
    uploader: "airesearcher",
    webpageUrl: "https://www.tiktok.com/@airesearcher/video/7364512345678901234",
  });
});

test("parseYtDlpJson coerces a numeric id to string", () => {
  const parsed = parseYtDlpJson(JSON.stringify({ id: 12345, title: "x" }));
  expect(parsed?.id).toBe("12345");
});

test("parseYtDlpJson defaults missing optional fields", () => {
  const parsed = parseYtDlpJson(JSON.stringify({ id: "abc" }));
  expect(parsed).toEqual({
    id: "abc",
    title: "",
    duration: 0,
    uploader: "",
    webpageUrl: undefined,
  });
});

test("parseYtDlpJson returns null for non-JSON and non-object lines", () => {
  expect(parseYtDlpJson("")).toBeNull();
  expect(parseYtDlpJson("[download] 100% of 2.5MiB")).toBeNull();
  expect(parseYtDlpJson("{ not valid json")).toBeNull();
  expect(parseYtDlpJson("null")).toBeNull();
  expect(parseYtDlpJson("[1,2,3]")).toBeNull();
});

test("parseYtDlpJson returns null when id is absent", () => {
  expect(parseYtDlpJson(JSON.stringify({ title: "no id here" }))).toBeNull();
});

// -- parseShowinfoTimestamps ------------------------------------------------

test("parseShowinfoTimestamps extracts pts_time values in order", () => {
  const stderr = [
    "[Parsed_showinfo_1 @ 0x600001] n:0 pts:0 pts_time:0 pos:0 fmt:yuvj420p",
    "[Parsed_showinfo_1 @ 0x600001] n:1 pts:12800 pts_time:4.267 pos:0 fmt:yuvj420p",
    "[Parsed_showinfo_1 @ 0x600001] n:2 pts:30000 pts_time:12.5 pos:0 fmt:yuvj420p",
  ].join("\n");
  expect(parseShowinfoTimestamps(stderr)).toEqual([0, 4.267, 12.5]);
});

test("parseShowinfoTimestamps returns empty array when no matches", () => {
  expect(parseShowinfoTimestamps("ffmpeg version 6.0\nno frames here")).toEqual([]);
});

test("parseShowinfoTimestamps clamps negative pts_time to 0", () => {
  expect(parseShowinfoTimestamps("n:0 pts_time:-0.033 x\nn:1 pts_time:2.0 y")).toEqual([0, 2.0]);
});

test("parseShowinfoTimestamps skips non-numeric artifacts", () => {
  // A stray "pts_time:" with no number should not crash or add an entry.
  const stderr = "n:0 pts_time:1.5 x\nn:1 pts_time: y\nn:2 pts_time:3.0 z";
  expect(parseShowinfoTimestamps(stderr)).toEqual([1.5, 3.0]);
});
