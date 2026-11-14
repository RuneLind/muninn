/**
 * `GET /api/wiki/ref` — the targets of a cross-page id (`D9 i [[page]]`,
 * living facts PR 4): kind, anchor and hover text for each asked id the page
 * defines. The anchors must be the ones `GET /api/wiki/page` renders, so the
 * test reads both routes. Visibility (a writable wiki under the read slice is
 * unknown) is pinned beside the other read routes in
 * `wiki-read-slice-routes.test.ts`. Synthetic pages only.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import type { XrefAnswer } from "../../wiki/core/cross-ref.ts";
import { testTempDir } from "../../test/temp-dir.ts";

const A = [
  "---",
  "title: Page A",
  "---",
  "",
  '<Query id="o5" question="A lower-case query?" answer="Yes.">',
  "",
  "Body.",
  "",
  "</Query>",
  "",
  '<Query id="Q-3" question="How many cases?" answer="Twelve.">',
  "",
  "Body.",
  "",
  "</Query>",
  "",
  "<DecisionLog>",
  "",
  "- **O1** — Should we ship? Closed 2026-10-01 (D2).",
  "- **O5** — The upper-case item.",
  "- **D2** — Ship on Friday.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

describe("GET /api/wiki/ref", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-ref-route-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
    await writeFile(path.join(root, "plans/a.md"), A, "utf8");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `refwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const ref = async (ids: string): Promise<XrefAnswer> => {
    const res = await app.request(`/api/wiki/ref?wiki=refwiki&relPath=plans%2Fa.md&ids=${encodeURIComponent(ids)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as XrefAnswer;
  };

  test("each id the page defines, with the anchor the page route renders; unknown ids left out", async () => {
    const body = await ref("O1,O5,Q-3,D2,X9");
    expect(body.title).toBe("Page A");
    expect(Object.keys(body.refs).sort()).toEqual(["D2", "O1", "O5", "Q-3"]);
    expect(body.refs.O1).toMatchObject({ kind: "decision", anchor: "o1", text: "Should we ship?", state: "decided", decision: "D2" });
    expect(body.refs["Q-3"]).toMatchObject({ kind: "query", anchor: "q-3", text: "How many cases?", answer: "Twelve." });
    // The Query card holds `o5`, so the item's anchor is the allocator's `o5-2`.
    expect(body.refs.O5!.anchor).toBe("o5-2");
    const page = (await (await app.request("/api/wiki/page?wiki=refwiki&relPath=plans%2Fa.md")).json()) as { html: string };
    for (const t of Object.values(body.refs)) expect(page.html, t.anchor).toContain(`id="${t.anchor}"`);
  });

  test("the shared ladder, and ids are required", async () => {
    expect((await app.request("/api/wiki/ref?wiki=refwiki&ids=D1")).status).toBe(400);
    expect((await app.request("/api/wiki/ref?wiki=refwiki&relPath=plans/nope.md&ids=D1")).status).toBe(404);
    expect((await app.request("/api/wiki/ref?wiki=nosuch&relPath=plans/a.md&ids=D1")).status).toBe(404);
    expect((await app.request("/api/wiki/ref?wiki=refwiki&relPath=plans/a.md")).status).toBe(400);
    expect((await app.request("/api/wiki/ref?wiki=refwiki&relPath=plans/a.md&ids=omtalt")).status).toBe(400);
  });
});
