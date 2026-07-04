import { test, expect } from "bun:test";
import {
  extractTikTokVideoId,
  frameBudgetFor,
  parseYtDlpJson,
  parseShowinfoTimestamps,
} from "./media.ts";

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

test("frameBudgetFor hard-caps at 30 for longer clips", () => {
  expect(frameBudgetFor(181)).toBe(30);
  expect(frameBudgetFor(600)).toBe(30);
});

test("frameBudgetFor is defensive against non-finite input", () => {
  expect(frameBudgetFor(NaN)).toBe(15);
  expect(frameBudgetFor(0)).toBe(15);
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
