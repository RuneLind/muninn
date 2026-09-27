/**
 * The TikTok route's URL handling. Mock-free (the resolver takes its fetch as
 * an argument); runs in the main `bun test` batch.
 */

import { test, expect } from "bun:test";
import {
  SHORT_LINK_MAX_HOPS,
  isShortLink,
  parseAllowedTikTokUrl,
  resolveTikTokShortLink,
  shortLinkRequestUrl,
  tiktokDownloadUrl,
  tiktokPathVideoId,
} from "./tiktok-url.ts";

// `_VALID_URL` of TikTokIE and TikTokVMIE, copied from yt-dlp 2026.08.19
// (`yt_dlp/extractor/tiktok.py:709` and `:1512`). Python `re.match`: anchored
// at the start only.
const TIKTOK_IE = /^https?:\/\/www\.tiktokv?\.com\/(?:embed|(?:share|@(?<user_id>[\w.-]+)?)\/video)\/(?<id>\d+)/;
const TIKTOK_VM_IE = /^https?:\/\/(?:(?:vm|vt)\.tiktok\.com|(?:www\.)tiktok\.com\/t)\/(?<id>\w+)/;

const DOWNLOAD_URLS: Array<[string, string]> = [
  [
    "https://www.tiktok.com/@u.ser/video/7412345678901234567?is_from_webapp=1&sender_device=pc",
    "https://www.tiktok.com/@u.ser/video/7412345678901234567?is_from_webapp=1&sender_device=pc",
  ],
  ["https://tiktok.com/@u/video/7412345678901234567", "https://www.tiktok.com/@u/video/7412345678901234567"],
  ["https://tiktok.com/@u/video/7412345678901234567?q=1", "https://www.tiktok.com/@u/video/7412345678901234567?q=1"],
  ["https://m.tiktok.com/@u/video/7412345678901234567", "https://www.tiktok.com/@u/video/7412345678901234567"],
  ["https://m.tiktok.com/v/7412345678901234567.html", "https://www.tiktok.com/@/video/7412345678901234567"],
  ["https://m.tiktok.com/v/7412345678901234567.html?_r=1&u_code=x", "https://www.tiktok.com/@/video/7412345678901234567"],
];

for (const [input, expected] of DOWNLOAD_URLS) {
  test(`tiktokDownloadUrl hands yt-dlp an extractor-matched URL for ${input}`, () => {
    const out = tiktokDownloadUrl(parseAllowedTikTokUrl(input)!);
    expect(out).toBe(expected);
    // The allowlist is `TikTok` alone, so every video shape must land on its
    // pattern and never on `vm.tiktok`'s, which re-follows a chain ungated.
    expect(TIKTOK_IE.test(out)).toBe(true);
    expect(TIKTOK_VM_IE.test(out)).toBe(false);
  });
}

const SHORT_LINKS = [
  "https://vm.tiktok.com/ZMabc123/",
  "https://vt.tiktok.com/ZSabc123",
  "https://www.tiktok.com/t/ZTRabc123/",
  "https://tiktok.com/t/ZTRabc123",
  "https://m.tiktok.com/t/ZTRabc123",
];

for (const short of SHORT_LINKS) {
  test(`${short} is a short link and never becomes a download URL`, () => {
    const u = parseAllowedTikTokUrl(short)!;
    expect(isShortLink(u)).toBe(true);
    // Every shape TikTokVMIE matches, so none may reach yt-dlp unresolved.
    expect(() => tiktokDownloadUrl(u)).toThrow(/short link must be resolved/);
  });
}

for (const [video] of DOWNLOAD_URLS) {
  test(`${video} is not a short link`, () => {
    expect(isShortLink(parseAllowedTikTokUrl(video)!)).toBe(false);
  });
}

/** A fetch stub that serves `routes[url]` and records every URL requested. */
function stubFetch(routes: Record<string, { status: number; location?: string }>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    expect(init?.redirect).toBe("manual");
    const r = routes[url];
    if (!r) throw new Error(`unexpected request ${url}`);
    return new Response(null, {
      status: r.status,
      headers: r.location ? { location: r.location } : {},
    });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

test("a normal vm.tiktok → www.tiktok chain resolves to the video URL", async () => {
  const { fetchImpl, requested } = stubFetch({
    "https://vm.tiktok.com/ZMabc123/": {
      status: 301,
      location: "https://www.tiktok.com/@u/video/7412345678901234567?_r=1",
    },
    "https://www.tiktok.com/@u/video/7412345678901234567?_r=1": { status: 200 },
  });
  expect(await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl)).toEqual({
    kind: "resolved",
    url: "https://www.tiktok.com/@u/video/7412345678901234567?_r=1",
  });
  expect(requested).toHaveLength(2);
});

test("a relative Location resolves against the current hop", async () => {
  const { fetchImpl } = stubFetch({
    "https://vt.tiktok.com/ZSabc123": { status: 302, location: "/@u/video/7412345678901234567" },
    "https://vt.tiktok.com/@u/video/7412345678901234567": { status: 200 },
  });
  expect(await resolveTikTokShortLink("https://vt.tiktok.com/ZSabc123", fetchImpl)).toEqual({
    kind: "resolved",
    url: "https://vt.tiktok.com/@u/video/7412345678901234567",
  });
});

for (const location of [
  "http://127.0.0.1:8080/x",
  "https://127.0.0.1/x",
  "https://evil.test/@u/video/1",
  "https://www.tiktok.com.evil.test/@u/video/1",
  "http://www.tiktok.com/@u/video/1",
]) {
  test(`a hop off TikTok is refused before it is requested: ${location}`, async () => {
    const { fetchImpl, requested } = stubFetch({
      "https://vm.tiktok.com/ZMabc123/": { status: 302, location: "https://www.tiktok.com/redir" },
      "https://www.tiktok.com/redir": { status: 302, location },
    });
    const res = await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl);
    expect(res.kind).toBe("refused");
    expect(requested).toEqual(["https://vm.tiktok.com/ZMabc123/", "https://www.tiktok.com/redir"]);
  });
}

test(`a chain longer than ${SHORT_LINK_MAX_HOPS} redirects is refused without requesting the next hop`, async () => {
  const routes: Record<string, { status: number; location?: string }> = {};
  for (let i = 0; i <= SHORT_LINK_MAX_HOPS + 1; i++) {
    routes[`https://www.tiktok.com/r${i}`] = { status: 302, location: `https://www.tiktok.com/r${i + 1}` };
  }
  const { fetchImpl, requested } = stubFetch(routes);
  const res = await resolveTikTokShortLink("https://www.tiktok.com/r0", fetchImpl);
  expect(res).toEqual({ kind: "refused", reason: `more than ${SHORT_LINK_MAX_HOPS} redirects` });
  // SHORT_LINK_MAX_HOPS redirects followed: one request per hop plus the first.
  expect(requested).toHaveLength(SHORT_LINK_MAX_HOPS + 1);
});

test(`exactly ${SHORT_LINK_MAX_HOPS} redirects still resolve`, async () => {
  const routes: Record<string, { status: number; location?: string }> = {};
  for (let i = 0; i < SHORT_LINK_MAX_HOPS; i++) {
    routes[`https://www.tiktok.com/r${i}`] = { status: 302, location: `https://www.tiktok.com/r${i + 1}` };
  }
  routes[`https://www.tiktok.com/r${SHORT_LINK_MAX_HOPS}`] = { status: 200 };
  const { fetchImpl } = stubFetch(routes);
  expect(await resolveTikTokShortLink("https://www.tiktok.com/r0", fetchImpl)).toEqual({
    kind: "resolved",
    url: `https://www.tiktok.com/r${SHORT_LINK_MAX_HOPS}`,
  });
});

test("a network error is a failure, not a refusal", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  expect(await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl)).toEqual({
    kind: "failed",
    reason: "ECONNRESET",
  });
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} with a Location is followed`, async () => {
    const { fetchImpl, requested } = stubFetch({
      "https://vm.tiktok.com/ZMabc123/": { status, location: "https://www.tiktok.com/@u/video/1" },
      "https://www.tiktok.com/@u/video/1": { status: 200 },
    });
    const res = await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl);
    expect(res).toEqual({ kind: "resolved", url: "https://www.tiktok.com/@u/video/1" });
    expect(requested).toHaveLength(2);
  });
}

// A non-2xx status that is not a redirect ends the chain as a failure, not as
// "resolved" on a URL that then reads as no video. 405 included: no GET retry.
for (const status of [300, 304, 403, 404, 405, 429, 503]) {
  test(`HTTP ${status} is a failure naming the status, even with a Location`, async () => {
    const { fetchImpl, requested } = stubFetch({
      "https://vm.tiktok.com/ZMabc123/": { status, location: "https://www.tiktok.com/@u/video/1" },
    });
    const res = await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl);
    expect(res).toEqual({ kind: "failed", reason: `HTTP ${status} from https://vm.tiktok.com/ZMabc123/` });
    expect(requested).toEqual(["https://vm.tiktok.com/ZMabc123/"]);
  });
}

test("a failure status on a later hop is a failure too", async () => {
  const { fetchImpl, requested } = stubFetch({
    "https://vm.tiktok.com/ZMabc123/": { status: 301, location: "https://www.tiktok.com/@u/video/1" },
    "https://www.tiktok.com/@u/video/1": { status: 429 },
  });
  const res = await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl);
  expect(res).toEqual({ kind: "failed", reason: "HTTP 429 from https://www.tiktok.com/@u/video/1" });
  expect(requested).toHaveLength(2);
});

test("a 2xx other than 200 ends the chain where it stands", async () => {
  const { fetchImpl } = stubFetch({ "https://www.tiktok.com/@u/video/1": { status: 204 } });
  expect(await resolveTikTokShortLink("https://www.tiktok.com/@u/video/1", fetchImpl)).toEqual({
    kind: "resolved",
    url: "https://www.tiktok.com/@u/video/1",
  });
});

// `m.tiktok.com` answers 404 on a valid `/t/<code>` (measured 2026-09-27).
for (const [short, requestedAt] of [
  ["https://m.tiktok.com/t/ZS4YoeRv2/", "https://www.tiktok.com/t/ZS4YoeRv2/"],
  ["https://tiktok.com/t/ZS4YoeRv2/?a=1", "https://www.tiktok.com/t/ZS4YoeRv2/?a=1"],
  ["https://www.tiktok.com/t/ZS4YoeRv2/", "https://www.tiktok.com/t/ZS4YoeRv2/"],
  ["https://vm.tiktok.com/ZMabc123/", "https://vm.tiktok.com/ZMabc123/"],
  ["https://vt.tiktok.com/ZSabc123", "https://vt.tiktok.com/ZSabc123"],
] as Array<[string, string]>) {
  test(`${short} is requested at ${requestedAt}`, () => {
    expect(shortLinkRequestUrl(parseAllowedTikTokUrl(short)!)).toBe(requestedAt);
  });
}

for (const [url, id] of [
  ["https://www.tiktok.com/@u/video/7412345678901234567?x=1", "7412345678901234567"],
  ["https://www.tiktok.com/?x=/video/7412345678901234567", null],
  ["https://www.tiktok.com/#/video/7412345678901234567", null],
  ["https://www.tiktok.com/?_r=1", null],
] as Array<[string, string | null]>) {
  test(`tiktokPathVideoId reads the path only: ${url}`, () => {
    expect(tiktokPathVideoId(new URL(url))).toBe(id);
  });
}

// `/t/` needs a code: TikTokVMIE requires `\w+` after it, so a bare `/t/` is
// no short link (it fails inside the job as "No suitable extractor").
for (const url of ["https://www.tiktok.com/t/", "https://www.tiktok.com/t/-abc"]) {
  test(`${url} is not a short link`, () => {
    expect(isShortLink(parseAllowedTikTokUrl(url)!)).toBe(false);
  });
}
