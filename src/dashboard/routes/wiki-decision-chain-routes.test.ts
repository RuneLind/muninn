/**
 * `GET /api/wiki/decision-chain` — one page's decision chain as lineage lines,
 * driven through the real route over a temp wiki.
 *
 * What a unit test of `analyzeDecisionChains` cannot see: the page resolution
 * and its 400/404 ladder, the frontmatter strip before parsing (a DecisionLog
 * inside the frontmatter is not read), and the `DECISION_CHAIN_LINES_MAX` cut
 * with `total` counted before it.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { DECISION_CHAIN_LINES_MAX } from "../../format/decision-chain.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import { checkDecisionChain } from "../../wiki/lint-decision-chain.ts";
import { testTempDir } from "../../test/temp-dir.ts";

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

// Fix round 1, batch 4 (F10, F12). Synthetic text only.
const NEXT = ["<NextMoves>", "", '<Lane kind="you">', "", "1. Run it.", "", "</Lane>", "", "</NextMoves>", ""];

/** A page whose edges sit inside wikilink labels: `[[t|l]]` reads as `l`. */
const LINKED = page("Linked", [
  ...NEXT,
  "<DecisionLog>",
  "",
  "- **O1** — Which store? Closed 2026-10-01 (D1).",
  "- **S1** — Which shape?",
  "- **S2** — Which order? Closed 2026-10-02 (D2).",
  "- **O2** — Which key? Closed 2026-10-03 (D5).",
  "- **D1** — Use the [[plans/other|PR 7 plan]] shape.",
  "- **D2** — Order by date.",
  "- **D3** — Lukker [[plans/x|S1]] now.",
  "- **D4** — Lukker [[plans/y|S2]] too.",
  "- **D5** — Key by id.",
  "",
  "</DecisionLog>",
  "",
]);

/** A proposed plan with a trailing comment on its status, a glance slate and
 *  no ledger: the slate's rows read as planned. */
const COMMENTED = [
  "---",
  "title: Commented",
  "plan_status: proposed   # pending O2",
  "---",
  "",
  ...NEXT,
  "<DecisionLog>",
  "",
  "- **D1** — Ship PR 1 first.",
  "- **D2** — Then PR 2.",
  "- **D3** — Then PR 3.",
  "",
  "</DecisionLog>",
  "",
  "### At a glance",
  "",
  "| PR | What |",
  "|---|---|",
  "| 1 | a |",
  "| 2 | b |",
  "| 3 | c |",
  "| 4 | d |",
  "",
].join("\n");

/** A DecisionLog inside a frontmatter block scalar parses as one when the
 *  frontmatter is left in; the route strips it first. */
const FRONTMATTER_LOG = [
  "---",
  "title: Frontmatter",
  "note: |",
  "  <DecisionLog>",
  "",
  "  - **D9** — Ship PR 9.",
  "",
  "  </DecisionLog>",
  "---",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Ship PR 1.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

/** The chain view's rows, read back off the HTML as lineage lines. */
function viewLines(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<div class="dc-row[^"]*">([\s\S]*?)<\/span><\/div>/g)) {
    const row = m[1]!;
    const qs = [...(row.match(/<span class="dc-qs">([\s\S]*?)<\/span><span class="dc-arrow/)?.[1] ?? "").matchAll(/<summary>([^<]*)<\/summary>/g)].map((x) => x[1]!);
    const dec = row.match(/<span class="dc-dec"><details[^>]*><summary>([^<]*)<\/summary>/)![1]!;
    const by = row.match(/<span class="dc-by">[^<]* ([^\s<]+)<\/span>/)?.[1];
    const reversed = row.includes("dc-snudd") ? ` (reversed${by ? ` by ${by}` : ""})` : "";
    const outs = [...row.matchAll(/<span class="dc-out dc-s-([a-z-]+)[^"]*"[^>]*>([^<]*)<\/span>/g)].map(
      (x) => `${x[2]}${x[1] !== "unknown" ? ` (${x[1]})` : ""}`,
    );
    out.push([qs.join(", "), `${dec}${reversed}`, outs.join(", ")].filter(Boolean).join(" → "));
  }
  return out;
}

describe("GET /api/wiki/decision-chain", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-chain-route-"));
    const wide = ["<DecisionLog>", ""];
    for (let i = 1; i <= 25; i++) wide.push(`- **O${i}** — Question ${i}? Closed 2026-10-01 (D${i}).`);
    for (let i = 1; i <= 25; i++) wide.push(`- **D${i}** — Decision ${i}.`);
    wide.push("", "</DecisionLog>");
    const files: Array<[string, string]> = [
      ["plans/plan.md", PLAN],
      ["plans/plain.md", page("Plain", ["No decisions here."])],
      ["plans/wide.md", page("Wide", wide)],
      ["plans/linked.md", LINKED],
      ["plans/commented.md", COMMENTED],
      ["plans/frontmatter.md", FRONTMATTER_LOG],
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

  test("a DecisionLog in the frontmatter is not read", async () => {
    expect((await chains("plans/frontmatter.md")).chains).toEqual(["D1 → PR 1"]);
  });

  // `[[t|l]]` reads as `l`: D1's PR 7 and D3's «Lukker S1» sit inside labels.
  const LINKED_LINES = ["O2 → D5", "S1 → D3", "S2 → D2", "O1 → D1 → PR 7"];

  test("F10: the route reads a wikilink as its label", async () => {
    expect((await chains("plans/linked.md")).chains).toEqual(LINKED_LINES);
  });

  test("F10: the reader's chain view draws the route's lines", () => {
    expect(viewLines(renderWikiHtml(LINKED, () => undefined, { views: true }))).toEqual(LINKED_LINES);
  });

  test("F10: the lint reads the same text — D4's «Lukker S2» inside a label conflicts with D2", () => {
    const lint = checkDecisionChain({ relPath: "plans/linked.md" }, LINKED);
    expect(lint.map((f) => `${f.check} ${f.line}`)).toEqual(["chain-close-conflict 24"]);
    expect(lint[0]!.message).toContain("D4 closes S2");
  });

  const COMMENTED_LINES = ["D3 → PR 3 (planned)", "D2 → PR 2 (planned)", "D1 → PR 1 (planned)"];

  test("F12: a commented `plan_status: proposed` reads the glance slate on the route", async () => {
    expect((await chains("plans/commented.md")).chains).toEqual(COMMENTED_LINES);
  });

  test("F12: … and draws it on the reader's page", async () => {
    const res = await app.request("/api/wiki/page?wiki=chainwiki&relPath=plans%2Fcommented.md");
    expect(res.status).toBe(200);
    const html = ((await res.json()) as { html: string }).html;
    expect(html).toContain("dc-strip");
    expect(viewLines(html)).toEqual(COMMENTED_LINES);
  });
});
