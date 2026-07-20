import { test, expect } from "bun:test";
import {
  extractDocLinks,
  pickEnrichmentLink,
  youTubeVideoId,
} from "./link-enrichment.ts";

// A realistic x-feed doc footer (huginn x_fetcher.py): the SINGULAR `**Link:**`
// is the tweet's own permalink; the PLURAL `**Links:**` carries external dests.
function doc(footer: string): string {
  return [
    "# @karpathy — Andrej Karpathy",
    "",
    "just dropped a 28-minute video on agent design",
    "",
    "---",
    "",
    "- **Engagement:** 1,200 likes",
    "- **Date:** Fri Jul 04 12:00:00 +0000 2026",
    "- **Type:** tweet",
    "- **Link:** https://x.com/karpathy/status/1789",
    footer,
  ].join("\n");
}

test("extractDocLinks parses only the plural **Links:** line, not the singular permalink", () => {
  const text = doc("- **Links:** https://youtu.be/dQw4w9WgXcQ");
  expect(extractDocLinks(text)).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
});

test("extractDocLinks ignores a doc with no plural **Links:** line (own permalink only)", () => {
  const text = doc("- **Type:** note"); // no Links line at all
  expect(extractDocLinks(text)).toEqual([]);
});

test("extractDocLinks token-splits several space-joined URLs on one line", () => {
  const text = doc(
    "- **Links:** https://youtu.be/abc12345678 https://example.com/post https://blog.dev/x",
  );
  expect(extractDocLinks(text)).toEqual([
    "https://youtu.be/abc12345678",
    "https://example.com/post",
    "https://blog.dev/x",
  ]);
});

test("extractDocLinks filters out x.com / twitter.com / t.co (and subdomains)", () => {
  const text = doc(
    "- **Links:** https://x.com/self/status/1 https://mobile.twitter.com/y https://t.co/abcd https://real.com/article",
  );
  expect(extractDocLinks(text)).toEqual(["https://real.com/article"]);
});

test("extractDocLinks skips non-http tokens and unparseable ones", () => {
  const text = doc("- **Links:** (see) mailto:a@b.com https://ok.com/x ftp://nope");
  expect(extractDocLinks(text)).toEqual(["https://ok.com/x"]);
});

test("extractDocLinks does not match the singular **Link:** even if it held an external url", () => {
  // Defensive: the singular line is the permalink, but even a hypothetical
  // external value on it must not be treated as a destination.
  const text = [
    "body",
    "- **Link:** https://external.com/somewhere",
    "- **Type:** tweet",
  ].join("\n");
  expect(extractDocLinks(text)).toEqual([]);
});

test("youTubeVideoId handles watch, youtu.be, and shorts; null otherwise", () => {
  expect(youTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(youTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(youTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(youTubeVideoId("https://youtube.com/watch?v=abc12345678&t=30s")).toBe("abc12345678");
  expect(youTubeVideoId("https://example.com/article")).toBeNull();
  // Not a youtube video shape (channel page) → null.
  expect(youTubeVideoId("https://www.youtube.com/@karpathy")).toBeNull();
});

test("pickEnrichmentLink: youtube link → youtube kind", () => {
  expect(pickEnrichmentLink(["https://youtu.be/dQw4w9WgXcQ"])).toEqual({
    url: "https://youtu.be/dQw4w9WgXcQ",
    kind: "youtube",
  });
});

test("pickEnrichmentLink: non-youtube link → article kind", () => {
  expect(pickEnrichmentLink(["https://example.com/post"])).toEqual({
    url: "https://example.com/post",
    kind: "article",
  });
});

test("pickEnrichmentLink: picks the FIRST external link", () => {
  expect(
    pickEnrichmentLink(["https://example.com/a", "https://youtu.be/dQw4w9WgXcQ"]),
  ).toEqual({ url: "https://example.com/a", kind: "article" });
});

test("pickEnrichmentLink: empty list → null", () => {
  expect(pickEnrichmentLink([])).toBeNull();
});
