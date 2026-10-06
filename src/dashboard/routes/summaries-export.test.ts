/**
 * `GET /api/summaries/export` end to end with no huginn and no real frames
 * root: the document is injected, the frames come from a temp root, and the
 * archive is verified by `unzip`.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSummariesExportRoutes, contentDisposition, type SummaryExportDoc } from "./summaries-export.ts";
import { KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import type { SummaryFactcheck } from "../../db/summary-factchecks.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "../../summaries/factcheck-block.ts";
import { factcheckBodySha256 } from "../../summaries/factcheck-body.ts";
import { EXPORT_FACTCHECK_STALE_NOTE } from "../../summaries/export.ts";

const config = { knowledgeApiUrl: "http://127.0.0.1:1" } as never;

let root = "";
const docs = new Map<string, SummaryExportDoc>();
const calls: Array<[string, string]> = [];
const factchecks = new Map<string, SummaryFactcheck>();

function app(): Hono {
  const a = new Hono();
  registerSummariesExportRoutes(a, config, {
    framesRoot: root,
    getFactcheck: async (_collection, docId) => {
      if (docId === "fc-lookup-fails.md") throw new Error("db down");
      return factchecks.get(docId) ?? null;
    },
    fetchDoc: async (collection, docId) => {
      calls.push([collection, docId]);
      if (docId === "boom.md") throw new KnowledgeApiError("Knowledge API unreachable", 503);
      return docs.get(docId) ?? null;
    },
  });
  return a;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "muninn-export-"));
  mkdirSync(join(root, "vimeo", "42"), { recursive: true });
  writeFileSync(join(root, "vimeo", "42", "187.jpg"), new Uint8Array([0xff, 0xd8, 1, 2, 3]));
  docs.set("ai/Talk - Kari.md", {
    title: "Talk: Kari",
    url: "https://vimeo.com/42",
    metadata: { speaker: "Kari" },
    text:
      "[vimeo-summaries > ai > Talk - Kari]\n\nIntro ![Slide at 00:03:07](/api/frames/vimeo/42/187.jpg) " +
      "and ![missing](/api/vimeo/frames/42/999.jpg) at [00:03:07]\n\n## Transcript\n### [00:00:00]\nhi",
  });
  docs.set("plain.md", { text: "just text, no frames" });
  // A planted symlink under the root: <root>/vimeo/43 → a directory outside it.
  const outside = join(root, "..", `muninn-export-outside-${process.pid}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "7.jpg"), new TextEncoder().encode("SECRET-NOT-A-FRAME"));
  symlinkSync(outside, join(root, "vimeo", "43"));
  docs.set("linked.md", { text: "![s](/api/frames/vimeo/43/7.jpg)" });
  docs.set("other-source.md", { text: "![s](/api/frames/vimeo/42/187.jpg)" });
  docs.set("x-video.md", { url: "https://x.com/a/status/2", text: "Summary.\n\n## Transcript\n\nwords" });
  docs.set("x-post.md", { url: "https://x.com/a/status/1", text: "Summary of a pasted post." });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("GET /api/summaries/export", () => {
  test("a Vimeo doc: page + the frames on disk, relative paths, a named attachment", async () => {
    const res = await app().request("/api/summaries/export?source=vimeo&docId=" + encodeURIComponent("ai/Talk - Kari.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe(contentDisposition("Talk Kari"));
    expect(calls.at(-1)).toEqual(["vimeo-summaries", "ai/Talk - Kari.md"]);

    const dir = mkdtempSync(join(tmpdir(), "muninn-export-out-"));
    try {
      const path = join(dir, "x.zip");
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
      expect(await Bun.$`unzip -t ${path}`.text()).toContain("No errors detected");
      // The missing frame is not an entry, and not a reason to refuse.
      expect((await Bun.$`unzip -Z1 ${path}`.text()).trim().split("\n")).toEqual(["index.html", "frames/187.jpg"]);
      const html = await Bun.$`unzip -p ${path} index.html`.text();
      expect(html).toContain('<img src="frames/187.jpg" alt="Slide at 00:03:07">');
      expect(html).toContain('<img src="frames/999.jpg" alt="missing">');
      expect(html).not.toContain("/api/");
      expect(html).not.toContain("[vimeo-summaries");
      expect(html).toContain("<title>Talk: Kari</title>");
      expect(html).toContain("<span>Kari</span>");
      expect(html).toContain('href="https://vimeo.com/42#t=187s"');
      expect(html).toContain('<details class="transcript">');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a doc with no frames exports the page alone; the title falls back to the id", async () => {
    const res = await app().request("/api/summaries/export?source=article&docId=plain.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(contentDisposition("plain"));
    expect(calls.at(-1)).toEqual(["article-summaries", "plain.md"]);
    const dir = mkdtempSync(join(tmpdir(), "muninn-export-out-"));
    try {
      const path = join(dir, "x.zip");
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
      expect((await Bun.$`unzip -Z1 ${path}`.text()).trim()).toBe("index.html");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a frame reached through a symlink out of the root is not packaged", async () => {
    const res = await app().request("/api/summaries/export?source=vimeo&docId=linked.md");
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain("SECRET-NOT-A-FRAME");
  });

  test("only the exporting source's frames are packaged", async () => {
    const res = await app().request("/api/summaries/export?source=article&docId=other-source.md");
    expect(res.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "muninn-export-out-"));
    try {
      const path = join(dir, "x.zip");
      writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
      expect((await Bun.$`unzip -Z1 ${path}`.text()).trim()).toBe("index.html");
      expect(await Bun.$`unzip -p ${path} index.html`.text()).not.toContain("/api/frames/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("x-article is labelled per document: a transcript means an X video", async () => {
    const page = async (docId: string) => {
      const res = await app().request("/api/summaries/export?source=x-article&docId=" + docId);
      expect(res.status).toBe(200);
      const dir = mkdtempSync(join(tmpdir(), "muninn-export-out-"));
      try {
        const path = join(dir, "x.zip");
        writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
        return await Bun.$`unzip -p ${path} index.html`.text();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(await page("x-video.md")).toContain('<a href="https://x.com/a/status/2" target="_blank" rel="noopener">Watch on X ↗</a>');
    expect(await page("x-post.md")).toContain('<a href="https://x.com/a/status/1" target="_blank" rel="noopener">Read on X ↗</a>');
  });

  test("refusals are JSON and precede any bytes", async () => {
    const a = app();
    for (const bad of ["../mimir/x.md", "a/./b.md", "a//b.md", "..", "a/..", "./x"]) {
      const r = await a.request("/api/summaries/export?source=vimeo&docId=" + encodeURIComponent(bad));
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect(calls.some(([, d]) => d.includes(".."))).toBe(false);
    expect((await a.request("/api/summaries/export?source=bogus&docId=x")).status).toBe(400);
    expect((await a.request("/api/summaries/export?source=vimeo&docId=%20")).status).toBe(400);
    expect((await a.request("/api/summaries/export?source=vimeo&docId=nope.md")).status).toBe(404);
    const down = await a.request("/api/summaries/export?source=vimeo&docId=boom.md");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "Knowledge API unreachable" });
  });
});

describe("contentDisposition", () => {
  test("ASCII fallback plus RFC 5987 form", () => {
    expect(contentDisposition('Æ "x"')).toBe(`attachment; filename="_ 'x'.zip"; filename*=UTF-8''%C3%86%20%22x%22.zip`);
  });
});

describe("GET /api/summaries/export — the saved fact check", () => {
  const CHECKED = Date.UTC(2026, 9, 5, 10, 0, 0);
  const ANSWER = "One claim is wrong.\n\n### ❌ Claim 1/1 — Coffee cures colds\n\nNo trial supports it.\n\nConfidence: 20/100";
  const SUMMARY = "Intro line.\n\nCoffee cures colds, the talk says.\n\n## Visual reference\n\nA slide.\n\n> 💬 **Takeaway:** coffee.";
  const TRANSCRIPT = "## Transcript\n\n### [00:00:00]\n\nCoffee cures colds.\n";
  const plain = `${SUMMARY}\n\n${TRANSCRIPT}`;
  // PR 2's write-back: the block inserted into the transcript-less body.
  const written = `${insertSummaryFactcheckBlock(SUMMARY, buildSummaryFactcheckBlock(ANSWER, "2026-10-05"))}\n\n${TRANSCRIPT}`;
  const row = (text: string, over: Partial<SummaryFactcheck> = {}): SummaryFactcheck => ({
    collection: "vimeo-summaries",
    docId: "x",
    url: null,
    bodySha256: factcheckBodySha256(text),
    answer: ANSWER,
    claims: [{ index: 1, title: "Coffee cures colds", verdict: "❌", outcome: "verified", sources: [] }],
    botName: "jarvis",
    createdAt: CHECKED,
    transcript: null,
    transcriptSha256: null,
    appliedAt: null,
    ...over,
  });

  async function exportHtml(docId: string): Promise<string> {
    const res = await app().request("/api/summaries/export?source=vimeo&docId=" + encodeURIComponent(docId));
    expect(res.status).toBe(200);
    // A store-only archive: the page's bytes sit in it verbatim.
    return new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  }
  const headings = (html: string) => html.match(/<h2>Fact check \(/g)?.length ?? 0;

  beforeAll(() => {
    docs.set("fc-plain.md", { text: plain, textSource: "file" });
    factchecks.set("fc-plain.md", row(plain));
    docs.set("fc-written.md", { text: written, textSource: "file" });
    factchecks.set("fc-written.md", row(written));
    docs.set("fc-stale.md", { text: plain.replace("Intro line.", "Rewritten intro."), textSource: "file" });
    factchecks.set("fc-stale.md", row(plain));
    docs.set("fc-norow.md", { text: written, textSource: "file" });
    docs.set("fc-lookup-fails.md", { text: plain, textSource: "file" });
  });

  test.each([["fc-plain.md"], ["fc-written.md"]])(
    "%s: one Fact check section, above the visual reference and outside the collapsed transcript",
    async (docId) => {
      const html = await exportHtml(docId);
      expect(headings(html)).toBe(1);
      expect(html).toContain("<h2>Fact check (2026-10-05)</h2>");
      expect(html.indexOf("Fact check (")).toBeLessThan(html.indexOf("<h2>Visual reference</h2>"));
      expect(html.indexOf("Fact check (")).toBeLessThan(html.indexOf('<details class="transcript">'));
      expect(html).toContain("No trial supports it.");
      expect(html).not.toContain("<!--");
      expect(html).not.toContain("&lt;!--");
      expect(html).not.toContain(EXPORT_FACTCHECK_STALE_NOTE.replaceAll("_", ""));
    },
  );

  test("a check older than the summary's last change carries the stale note", async () => {
    const html = await exportHtml("fc-stale.md");
    expect(headings(html)).toBe(1);
    expect(html).toContain(EXPORT_FACTCHECK_STALE_NOTE.replaceAll("_", ""));
  });

  test("no row: the document is exported as it is, its own block once", async () => {
    expect(headings(await exportHtml("fc-norow.md"))).toBe(1);
  });

  test("a failed lookup exports without a check rather than failing", async () => {
    expect(headings(await exportHtml("fc-lookup-fails.md"))).toBe(0);
  });
});
