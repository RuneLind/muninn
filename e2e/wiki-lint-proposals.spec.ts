/**
 * LINT CHECK 8 end to end — findings → proposal rows → the group card → the
 * bytes an Accept writes.
 *
 * What no unit test in this chain can reach:
 *
 *  1. **The finding really carries its fix to the DB.** `lintWiki` is pure,
 *     `seedLintProposals` takes injected seams, and the route is a third thing;
 *     every one of them is green with the chain broken.
 *  2. **A group renders as ONE card.** The client folds rows by `group_key`, and
 *     a payload that lost the column renders N cards with one diff each — which
 *     is exactly the half-approvable state the column exists to prevent.
 *  3. **Accept writes THAT edit and nothing else.** The apply path runs the
 *     alias strip, body-link containment and a trailing-newline normalisation
 *     for every other kind; the assertion here is on the file BYTES.
 *  4. **Dismiss is durable.** The skip list is "any status", so a re-POST after
 *     a dismissal must not put the card back.
 *
 * No model call and no fake service: the wiki is a temp dir and the rows go into
 * the test database.
 *
 * Playwright runs this file under NODE — hence `postgres` rather than `Bun.sql`.
 *
 * ENV PREREQUISITE / SPAWN ENV: a working `.env` at the repo root, plus
 * `e2eEnv()` to keep this muninn off Telegram/Slack and off the host's
 * instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-lint-proposals");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-lint";

/** A frontmatter page. Every fixture carries a `status_date:`, because the rule
 *  that picks "the newer page" and "the head" falls back to mtime otherwise —
 *  and a fixture written in one pass has one mtime. */
function md(title: string, date: string, extra: string[], body: string): string {
  return ["---", `title: ${title}`, `status_date: ${date}`, ...extra, "---", "", body, ""].join("\n");
}

// 8.1 — two pages that landed the same two PRs and link each other nowhere.
const STRIP = "plans/chain-strip.mdx";
const CODE = "plans/summary-code.mdx";
// 8.2 — two plans and a blog, mutually linked, none of them naming a series.
const LEAD = "plans/rail-lead.mdx";
const FOLLOW = "plans/rail-follow.mdx";
const BLOG = "blogs/rail-explained.mdx";
// 8.3 — one series key spelled two ways.
const PROV_HEAD = "plans/prov-head.mdx";
const PROV_VAR = "plans/prov-var.mdx";

const PAGES: Array<[string, string]> = [
  [STRIP, md("Chain strip", "2026-09-17", ["plan_status: shipped"], "Landed RuneLind/muninn#553 and RuneLind/muninn#552.")],
  [CODE, md("Summary code", "2026-09-16", ["plan_status: shipped"], "Shipped in RuneLind/muninn#552 and RuneLind/muninn#553.")],
  [LEAD, md("Rail lead", "2026-09-18", ["plan_status: in-flight"], "See [[Rail follow]] and [[Rail explained]].")],
  [FOLLOW, md("Rail follow", "2026-09-12", [], "See [[Rail lead]].")],
  [BLOG, md("Rail explained", "2026-09-05", [], "See [[Rail lead]].")],
  [PROV_HEAD, md("Prov head", "2026-09-14", ["plan_status: in-flight", "series: prov"], "Body.")],
  [PROV_VAR, md("Prov variant", "2026-09-13", ["series: Prov"], "Body.")],
];

let server: ChildProcess | undefined;
let root = "";
let sql: ReturnType<typeof postgres> | null = null;

async function writeWiki(): Promise<void> {
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
}

const read = (rel: string) => readFile(path.join(root, rel), "utf8");

async function api(pathAndQuery: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${pathAndQuery}`, init);
  return { status: res.status, body: await res.json() };
}

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM wiki_proposals WHERE wiki_name = ${WIKI}`;
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-lint-"));
  await writeWiki();

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // A collection is what makes the wiki a gate scope at all (a
      // collection-less `WIKI_EXTRA` wiki has no proposals surface). Nothing
      // answers on the knowledge API port, so the post-apply reindex fails
      // harmlessly — which is also the point: an apply must not depend on it.
      WIKI_EXTRA: `${WIKI}=${root}=wiki`,
      KNOWLEDGE_API_URL: `http://127.0.0.1:${e2ePort("wiki-lint-proposals/dead-huginn")}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  try {
    if (sql) await sql`DELETE FROM wiki_proposals WHERE wiki_name = ${WIKI}`;
  } finally {
    await sql?.end();
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test.describe.configure({ mode: "serial" });

test.describe("wiki lint fixes", () => {
  test("the findings carry all three check-8 kinds, filed against the right pages", async () => {
    const { body } = await api(`/api/wiki/linter-findings?wiki=${WIKI}`);
    expect(body.counts["same-work-no-link"]).toBe(1);
    expect(body.counts["series-unnamed"]).toBe(1);
    expect(body.counts["series-inconsistent"]).toBe(1);

    const pair = body.findings.find((f: any) => f.check === "same-work-no-link");
    // Filed against the NEWER page — the one the See-also line is written on.
    expect(pair.relPath).toBe(STRIP);
    expect(pair.detail).toContain(CODE);
    expect(pair.detail).toContain("shares RuneLind/muninn#553, RuneLind/muninn#552");

    const cluster = body.findings.find((f: any) => f.check === "series-unnamed");
    expect(cluster.relPath).toBe(LEAD);
    expect(cluster.detail).toContain(BLOG);

    const variant = body.findings.find((f: any) => f.check === "series-inconsistent");
    expect(variant.message).toContain("spelled 2 ways");
  });

  test("POST /api/wiki/lint-proposals creates one row per touched page", async () => {
    const { status, body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, { method: "POST" });
    expect(status).toBe(200);
    // 8.1 one page · 8.2 three pages · 8.3 one page.
    expect(body).toMatchObject({ proposed: 3, rows: 5, skipped: 0 });

    const rows = await sql!<{ target_path: string; group_key: string; kind: string }[]>`
      SELECT target_path, group_key, kind FROM wiki_proposals WHERE wiki_name = ${WIKI}
    `;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.kind === "lint" && r.group_key)).toBe(true);
    // Three distinct groups, and the 8.2 one holds exactly its three pages.
    const byGroup = new Map<string, string[]>();
    for (const r of rows) byGroup.set(r.group_key, [...(byGroup.get(r.group_key) ?? []), r.target_path]);
    expect(byGroup.size).toBe(3);
    expect([...byGroup.values()].map((v) => v.length).sort()).toEqual([1, 1, 3]);
  });

  test("a second POST proposes nothing — the group keys are already taken", async () => {
    const { body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, { method: "POST" });
    expect(body).toMatchObject({ proposed: 0, rows: 0, skipped: 3 });
  });

  test("the gate renders ONE card per group, with one labelled diff per page", async ({ page }) => {
    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const cards = page.locator(".gard-card[data-group]");
    await expect(cards).toHaveCount(3);

    // The 8.2 card: three diffs, three paths, one Accept.
    const cluster = page.locator(`.gard-card[data-group]`).filter({ hasText: "Rail lead" }).first();
    await expect(cluster.locator(".gard-group-diff")).toHaveCount(3);
    const labels = await cluster.locator(".gard-group-diff-path").allTextContents();
    expect(labels.sort()).toEqual([BLOG, FOLLOW, LEAD].sort());
    await expect(cluster.locator('[data-group-action="approve"]')).toHaveText("Accept all 3");
    await expect(cluster.locator('[data-group-action="reject"]')).toHaveCount(1);

    // The 8.1 card is a group of one — one diff, one Accept.
    const pair = page.locator(`.gard-card[data-group]`).filter({ hasText: "Chain strip" }).first();
    await expect(pair.locator(".gard-group-diff")).toHaveCount(1);
    await expect(pair.locator('[data-group-action="approve"]')).toHaveText("Accept all 1");
  });

  test("accepting 8.1 writes ONE See-also line on the newer page and nothing else", async ({ page }) => {
    const before = await read(STRIP);
    const otherBefore = await read(CODE);

    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const card = page.locator(`.gard-card[data-group]`).filter({ hasText: "Chain strip" }).first();
    await card.locator('[data-group-action="approve"]').click();
    await expect(card.locator(".gard-badge.chip-applied")).toHaveCount(1);

    // Byte-exact: the page's own content plus the wire stage's own bullet shape.
    expect(await read(STRIP)).toBe(`${before.replace(/\s+$/, "")}\n\n## See also\n- [[Summary code]]\n`);
    // Nothing on the older page — the fix is one-sided by design.
    expect(await read(CODE)).toBe(otherBefore);
  });

  test("accepting 8.2 writes exactly three series: lines and one series_label:", async ({ page }) => {
    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const card = page.locator(`.gard-card[data-group]`).filter({ hasText: "Rail lead" }).first();
    await card.locator('[data-group-action="approve"]').click();
    await expect(card.locator(".gard-badge.chip-applied")).toHaveCount(1);

    const members = await Promise.all([LEAD, FOLLOW, BLOG].map(read));
    for (const body of members) expect(body).toContain("series: rail-lead\n");
    // The label rides on the HEAD alone — one edit renames the series.
    const labelled = members.filter((b) => b.includes("series_label:"));
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toContain("series_label: Rail lead\n");
    // …and every member kept its body: this is a frontmatter line upsert.
    expect(members[0]).toContain("See [[Rail follow]] and [[Rail explained]].");
  });

  test("dismissing a group keeps it dismissed across a re-POST", async ({ page }) => {
    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const card = page.locator(`.gard-card[data-group]`).filter({ hasText: "Prov" }).first();
    await card.locator('[data-group-action="reject"]').click();
    await expect(card.locator(".gard-badge.chip-rejected")).toHaveCount(1);

    const before = await read(PROV_VAR);
    const dismissed = await sql!<{ group_key: string }[]>`
      SELECT DISTINCT group_key FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND status = 'rejected'
    `;
    expect(dismissed).toHaveLength(1);
    const dismissedKey = dismissed[0]!.group_key;

    const { body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, { method: "POST" });
    expect(body.skipped).toBeGreaterThanOrEqual(1);

    // The dismissed group is still a FINDING — the lint is deterministic and the
    // wiki is unchanged — so the only thing stopping it coming back is its
    // `rejected` rows being in the skip list. Nothing new carries its key, and
    // the page it would have edited is untouched.
    const live = await sql!<{ group_key: string; status: string }[]>`
      SELECT group_key, status FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND group_key = ${dismissedKey}
    `;
    expect(live.map((r) => r.status)).toEqual(["rejected"]);
    expect(await read(PROV_VAR)).toBe(before);
  });

  /**
   * The one case that is NOT a treadmill bug: accepting 8.1 links the pair, and
   * a link plus a shared PR ref IS the 8.2 cluster edge — so the pair becomes an
   * unnamed two-page series. That is the rule escalating correctly (they are one
   * piece of work; now name it), and it is asserted here so the behaviour is a
   * decision rather than a surprise in a later run.
   */
  test("the accepted 8.1 pair becomes an 8.2 candidate on the next lint", async () => {
    const { body } = await api(`/api/wiki/linter-findings?wiki=${WIKI}`);
    expect(body.counts["same-work-no-link"]).toBe(0);
    const cluster = body.findings.find(
      (f: any) => f.check === "series-unnamed" && f.detail.includes(CODE),
    );
    expect(cluster).toBeDefined();
    expect(cluster.detail).toContain(STRIP);
  });
});
