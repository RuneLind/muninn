/**
 * `GET /api/wiki/decision-chain` — one page's decision chain as lineage lines,
 * driven through the real route over a temp wiki.
 *
 * What a unit test of `analyzeDecisionChains` cannot see: the page resolution
 * and its 400/404 ladder, the frontmatter strip before parsing, and the
 * `DECISION_CHAIN_LINES_MAX` cut with `total` counted before it.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { DECISION_CHAIN_LINES_MAX } from "../../format/decision-chain.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";

function page(title: string, body: string[]): string {
  return ["---", `title: ${title}`, "---", "", ...body, ""].join("\n");
}

const PLAN = page("Plan", [
  "<DecisionLog>",
  "",
  "- **O1** — Which store? Closed 2026-10-01 (D1).",
  "- **O2** — Which shape? Closed 2026-10-02 (D2).",
  "- **D1** — Use the flat file.",
  "- **D2** — ~~Rows per item.~~ Reversed, superseded by D3.",
  "- **D3** — One row per group.",
  "",
  "</DecisionLog>",
  "",
  "**PR ledger.**",
  "",
  "| PR | State | Decisions |",
  "|---|---|---|",
  "| 1 — store | merged [#11](https://example.test/pull/11) | D1 |",
  "| 2 — rows | dropped | D2 |",
  "| 3 — groups | open | D3 |",
  "",
]);

describe("GET /api/wiki/decision-chain", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-chain-route-"));
    const wide = ["<DecisionLog>", ""];
    for (let i = 1; i <= 25; i++) wide.push(`- **O${i}** — Question ${i}? Closed 2026-10-01 (D${i}).`);
    for (let i = 1; i <= 25; i++) wide.push(`- **D${i}** — Decision ${i}.`);
    wide.push("", "</DecisionLog>");
    const files: Array<[string, string]> = [
      ["plans/plan.md", PLAN],
      ["plans/plain.md", page("Plain", ["No decisions here."])],
      ["plans/wide.md", page("Wide", wide)],
    ];
    for (const [rel, body] of files) {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), body, "utf8");
    }
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `chainwiki=${root}`;
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

  const chains = async (relPath: string): Promise<{ chains: string[]; total: number }> => {
    const res = await app.request(`/api/wiki/decision-chain?wiki=chainwiki&relPath=${encodeURIComponent(relPath)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { chains: string[]; total: number };
  };

  test("the page's lineage, newest decision first, with PR states and the reversal", async () => {
    expect(await chains("plans/plan.md")).toEqual({
      chains: ["D3 → PR 3 (open)", "O2 → D2 (reversed by D3) → PR 2 (dropped)", "O1 → D1 → PR 1 (merged)"],
      total: 3,
    });
  });

  test("a page with no decision log answers an empty list", async () => {
    expect(await chains("plans/plain.md")).toEqual({ chains: [], total: 0 });
  });

  test("at most DECISION_CHAIN_LINES_MAX lines; total counts every chain", async () => {
    const body = await chains("plans/wide.md");
    expect(body.total).toBe(25);
    expect(body.chains).toHaveLength(DECISION_CHAIN_LINES_MAX);
    expect(body.chains[0]).toBe("O25 → D25");
  });

  test("the shared ladder: no page → 400, unknown page → 404, unknown wiki → 404", async () => {
    expect((await app.request("/api/wiki/decision-chain?wiki=chainwiki")).status).toBe(400);
    expect((await app.request("/api/wiki/decision-chain?wiki=chainwiki&relPath=plans/nope.md")).status).toBe(404);
    expect((await app.request("/api/wiki/decision-chain?wiki=nosuch&relPath=plans/plan.md")).status).toBe(404);
  });
});
