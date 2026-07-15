import { test, expect, describe } from "bun:test";
import { isHttpUrl, sourcesHtml, type GardenerSourceDoc } from "./wiki-gardener-sources.ts";

const doc = (over: Partial<GardenerSourceDoc>): GardenerSourceDoc => ({
  collection: "youtube-summaries",
  docId: "2026-07-15_x.md",
  title: "A Title",
  url: "https://example.com/x",
  ...over,
});

describe("isHttpUrl", () => {
  test("accepts http/https, rejects file:// and empty", () => {
    expect(isHttpUrl("http://a.com")).toBe(true);
    expect(isHttpUrl("https://a.com")).toBe(true);
    expect(isHttpUrl("file:///Users/rune/x.md")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});

describe("sourcesHtml", () => {
  test("http(s) url renders as a clickable link", () => {
    const html = sourcesHtml([doc({ url: "https://example.com/x", title: "Clickable" })]);
    expect(html).toContain('<a href="https://example.com/x"');
    expect(html).toContain("Clickable");
  });

  test("file:// url renders as plain text, not a link", () => {
    const html = sourcesHtml([
      doc({ url: "file:///Users/rune/source/private/huginn/data/sources/a.md", title: "Local Doc" }),
    ]);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
    expect(html).toContain("Local Doc");
  });

  test("empty url renders as plain text", () => {
    const html = sourcesHtml([doc({ url: "", title: "No URL" })]);
    expect(html).not.toContain("<a ");
    expect(html).toContain("No URL");
  });

  test("empty docs → empty string", () => {
    expect(sourcesHtml([])).toBe("");
  });
});
