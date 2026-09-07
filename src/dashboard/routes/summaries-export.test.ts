/**
 * `GET /api/summaries/export` end to end with no huginn and no real frames
 * root: the document is injected, the frames come from a temp root, and the
 * archive is verified by `unzip`.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSummariesExportRoutes, contentDisposition, type SummaryExportDoc } from "./summaries-export.ts";
import { KnowledgeApiError } from "../../ai/knowledge-api-client.ts";

const config = { knowledgeApiUrl: "http://127.0.0.1:1" } as never;

let root = "";
const docs = new Map<string, SummaryExportDoc>();
const calls: Array<[string, string]> = [];

function app(): Hono {
  const a = new Hono();
  registerSummariesExportRoutes(a, config, {
    framesRoot: root,
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

  test("refusals are JSON and precede any bytes", async () => {
    const a = app();
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
