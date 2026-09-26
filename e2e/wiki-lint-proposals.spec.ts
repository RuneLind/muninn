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
// 8.2 — two plans, a blog and a note, mutually linked, none naming a series.
// The cluster needs TWO open plans (`SERIES_CLUSTER_MIN_PLANS`).
const LEAD = "plans/rail-lead.mdx";
const FOLLOW = "plans/rail-follow.mdx";
const BLOG = "blogs/rail-explained.mdx";
// The SIMULTANEOUS overlap: `OVERLAP` is a member of the 8.2 cluster (mutual
// link with LEAD) AND one end of an 8.1 pair with FOLLOW (two shared PR refs,
// no link either way). One of those two findings may hold its pages.
const OVERLAP = "plans/rail-overlap.mdx";
// The SEQUENTIAL one: `HEAL_A`/`HEAL_B` are an 8.2 cluster today, and
// accepting the `HEAL_C` 8.1 pair links C into it — which GROWS the member set,
// mints a different group key, and leaves the first group describing a finding
// that no longer exists in that shape.
const HEAL_A = "plans/heal-a.mdx";
const HEAL_B = "plans/heal-b.mdx";
const HEAL_C = "plans/heal-c.mdx";
// 8.3 — one series key spelled two ways.
const PROV_HEAD = "plans/prov-head.mdx";
const PROV_VAR = "plans/prov-var.mdx";

const PAGES: Array<[string, string]> = [
  [STRIP, md("Chain strip", "2026-09-17", ["plan_status: shipped"], "Landed RuneLind/muninn#553 and RuneLind/muninn#552.")],
  [CODE, md("Summary code", "2026-09-16", ["plan_status: shipped"], "Shipped in RuneLind/muninn#552 and RuneLind/muninn#553.")],
  [LEAD, md("Rail lead", "2026-09-18", ["plan_status: in-flight"], "See [[Rail follow]], [[Rail explained]] and [[Rail overlap]].")],
  [FOLLOW, md("Rail follow", "2026-09-12", ["plan_status: proposed"], "See [[Rail lead]]. Landed RuneLind/muninn#601 and RuneLind/muninn#602.")],
  [BLOG, md("Rail explained", "2026-09-05", [], "See [[Rail lead]].")],
  [OVERLAP, md("Rail overlap", "2026-09-16", [], "See [[Rail lead]]. Shipped in RuneLind/muninn#601, RuneLind/muninn#602.")],
  [HEAL_A, md("Heal a", "2026-09-08", ["plan_status: in-flight"], "See [[Heal b]]. Landed RuneLind/muninn#701 and RuneLind/muninn#702.")],
  [HEAL_B, md("Heal b", "2026-09-07", ["plan_status: proposed"], "See [[Heal a]].")],
  [HEAL_C, md("Heal c", "2026-09-09", ["plan_status: in-flight"], "Shipped in RuneLind/muninn#701, RuneLind/muninn#702.")],
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

/** The group verbs are wiki-scoped — a group key is a hash over wiki-RELATIVE
 *  paths and is not unique across wikis. */
const groupUrl = (key: string, verb: "approve" | "reject") =>
  `/api/wiki/proposals/group/${encodeURIComponent(key)}/${verb}?wiki=${WIKI}`;

/** The seeding and group POSTs take application/json (415 otherwise). */
const JSON_POST: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

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
    // Three unlinked pairs, two unnamed clusters, one half-written series.
    expect(body.counts["same-work-no-link"]).toBe(3);
    expect(body.counts["series-unnamed"]).toBe(2);
    expect(body.counts["series-inconsistent"]).toBe(1);

    const pair = body.findings.find((f: any) => f.check === "same-work-no-link");
    // Filed against the NEWER page — the one the See-also line is written on.
    expect(pair.relPath).toBe(STRIP);
    expect(pair.detail).toContain(CODE);
    expect(pair.detail).toContain("shares RuneLind/muninn#553, RuneLind/muninn#552");

    const cluster = body.findings.find((f: any) => f.check === "series-unnamed" && f.relPath === LEAD);
    expect(cluster.detail).toContain(BLOG);
    expect(cluster.detail).toContain(OVERLAP);

    const variant = body.findings.find((f: any) => f.check === "series-inconsistent");
    expect(variant.message).toContain("spelled 2 ways");
  });

  test("POST /api/wiki/lint-proposals creates one row per touched page", async () => {
    const { status, body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, JSON_POST);
    expect(status).toBe(200);
    // Five groups: two 8.1 pairs (one page each), two 8.2 clusters (4 and 2),
    // and the 8.3 spelling fix. The THIRD 8.1 pair — OVERLAP × FOLLOW — is
    // CLAIMED: both its pages are already held by the 8.2 cluster, and two live
    // rows on one page is the state where applying either group stales the
    // other forever.
    expect(body).toMatchObject({ proposed: 5, rows: 9, skipped: 0, claimed: 1, staled: 0, refused: 0 });

    const rows = await sql!<{ target_path: string; group_key: string; kind: string }[]>`
      SELECT target_path, group_key, kind FROM wiki_proposals WHERE wiki_name = ${WIKI}
    `;
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.kind === "lint" && r.group_key)).toBe(true);
    const byGroup = new Map<string, string[]>();
    for (const r of rows) byGroup.set(r.group_key, [...(byGroup.get(r.group_key) ?? []), r.target_path]);
    expect(byGroup.size).toBe(5);
    expect([...byGroup.values()].map((v) => v.length).sort()).toEqual([1, 1, 1, 2, 4]);
  });

  test("a second POST proposes nothing — the group keys are already taken", async () => {
    const { body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, JSON_POST);
    expect(body).toMatchObject({ proposed: 0, rows: 0, skipped: 5, staled: 0 });
  });

  /**
   * THE core invariant: one page is held by at most one LIVE group.
   *
   * `plans/chain-strip.mdx` is the newer end of the 8.1 pair. After the 8.1 fix
   * applies it also becomes a member of an 8.2 cluster — and a page carrying two
   * live rows shares a `base_hash` between them, so applying either group leaves
   * the other permanently `stale` and the skip list then refuses to re-propose
   * the loser's key. The series is unnameable forever.
   */
  test("no page carries two live rows after the first seeding pass", async () => {
    const live = await sql!<{ target_path: string; n: string }[]>`
      SELECT target_path, COUNT(*)::text AS n FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND status IN ('draft','approved')
      GROUP BY target_path HAVING COUNT(*) > 1
    `;
    expect(live).toEqual([]);
  });

  test("the payload skips the drafted-page machinery for a lint row", async () => {
    const { body } = await api(`/api/wiki/proposals?wiki=${WIKI}`);
    const lint = body.proposals.filter((p: any) => p.kind === "lint");
    expect(lint.length).toBeGreaterThan(0);
    // The card renders the rationale and the diff and nothing else. Measured on
    // a mimir clone, 183 lint rows shipped a 10.3 MB payload, nearly all of it
    // `previewHtml` for pages the reviewer can open in the reader.
    for (const row of lint) {
      expect([row.targetPath, row.previewHtml]).toEqual([row.targetPath, ""]);
      expect([row.targetPath, row.wiring]).toEqual([row.targetPath, null]);
      expect([row.targetPath, row.unresolvedLinks]).toEqual([row.targetPath, []]);
      expect(row.diff?.length).toBeGreaterThan(0);
    }
  });

  test("the gate renders ONE card per group, with one labelled diff per page", async ({ page }) => {
    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const cards = page.locator(".gard-card[data-group]");
    await expect(cards).toHaveCount(5);

    // The 8.2 card: four diffs, four paths, one Accept.
    const cluster = page.locator(`.gard-card[data-group]`).filter({ hasText: "Rail lead" }).first();
    await expect(cluster.locator(".gard-group-diff")).toHaveCount(4);
    const labels = await cluster.locator(".gard-group-diff-path").allTextContents();
    expect(labels.map((t) => t.split(" ")[0]).sort()).toEqual([BLOG, FOLLOW, LEAD, OVERLAP].sort());
    await expect(cluster.locator('[data-group-action="approve"]')).toHaveText("Accept all 4");
    await expect(cluster.locator('[data-group-action="reject"]')).toHaveCount(1);

    // The 8.1 card is a group of one — one diff, one Accept.
    const pair = page.locator(`.gard-card[data-group]`).filter({ hasText: "Chain strip" }).first();
    await expect(pair.locator(".gard-group-diff")).toHaveCount(1);
    await expect(pair.locator('[data-group-action="approve"]')).toHaveText("Accept all 1");
  });

  test("a group card holds every row whatever the status filter shows", async ({ page }) => {
    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const cluster = page.locator(`.gard-card[data-group]`).filter({ hasText: "Rail lead" }).first();
    // The card is titled by the page the FINDING was filed against. The rows
    // arrive newest-created first, so `rows[0]` is the LAST member the seeder
    // inserted — an accident of the cluster's own date order.
    await expect(cluster.locator(".gard-title")).toHaveText("Rail lead");
    // The status chip summarises the SET, not `rows[0]`.
    await expect(cluster.locator(".gard-badge.chip-draft")).toHaveText("4 draft");
    // A filter selects which CARDS show, never which rows a card holds.
    await page.locator('.gard-filter[data-status="draft"]').click();
    await expect(cluster.locator(".gard-group-diff")).toHaveCount(4);
    await page.locator('.gard-filter[data-status=""]').click();
  });

  test("accepting 8.1 writes ONE See-also line on the newer page and nothing else", async ({ page }) => {
    const before = await read(STRIP);
    const otherBefore = await read(CODE);

    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const pairCount = page
      .locator("#lintList .lint-group")
      .filter({ hasText: "Same work, no link" })
      .locator(".lint-count");
    await expect(pairCount).toHaveText("3");

    const card = page.locator(`.gard-card[data-group]`).filter({ hasText: "Chain strip" }).first();
    await card.locator('[data-group-action="approve"]').click();
    await expect(card.locator(".gard-badge.chip-applied")).toHaveCount(1);
    // An applied fix changes what the linter finds, so the panel is refreshed
    // by the action — no manual Refresh, no reload.
    await expect(pairCount).toHaveText("2");

    // Byte-exact: the page's own content plus the wire stage's own bullet shape.
    expect(await read(STRIP)).toBe(`${before.replace(/\s+$/, "")}\n\n## See also\n- [[Summary code]]\n`);
    // Nothing on the older page — the fix is one-sided by design.
    expect(await read(CODE)).toBe(otherBefore);
  });

  test("accepting 8.2 writes one series: line per member and one series_label:", async ({ page }) => {
    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const card = page.locator(`.gard-card[data-group]`).filter({ hasText: "Rail lead" }).first();
    await card.locator('[data-group-action="approve"]').click();
    await expect(card.locator(".gard-badge.chip-applied")).toHaveCount(1);

    const members = await Promise.all([LEAD, FOLLOW, BLOG, OVERLAP].map(read));
    for (const body of members) expect(body).toContain("series: rail-lead\n");
    // The label rides on the HEAD alone — one edit renames the series.
    const labelled = members.filter((b) => b.includes("series_label:"));
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toContain("series_label: Rail lead\n");
    // …and every member kept its body: this is a frontmatter line upsert.
    expect(members[0]).toContain("See [[Rail follow]], [[Rail explained]] and [[Rail overlap]].");
    // ONE log.md entry for the whole group, naming every page and the seeder.
    const log = await read("log.md");
    expect(log).toContain(`- via lint-proposals, 4 pages: ${BLOG}, ${FOLLOW}, ${LEAD}, ${OVERLAP}`);
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

    const { body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, JSON_POST);
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
    // The pair that was accepted is linked now, so it is no longer a finding.
    expect(
      body.findings.filter((f: any) => f.check === "same-work-no-link" && f.relPath === STRIP),
    ).toEqual([]);
    const cluster = body.findings.find(
      (f: any) => f.check === "series-unnamed" && f.detail.includes(CODE),
    );
    expect(cluster).toBeDefined();
    expect(cluster.detail).toContain(STRIP);
  });

  /**
   * THE SEQUENTIAL case. Accepting the `HEAL_C` pair links C into the A/B
   * cluster, which GROWS the member set and therefore mints a DIFFERENT group
   * key. The first group's card now describes a finding that no longer exists
   * in that shape — and because the skip rule is by key, leaving it live would
   * keep C's pages claimed forever and the series unnameable.
   */
  test("accepting 8.1 retires the superseded 8.2 group and proposes its successor", async ({ page }) => {
    const before = await sql!<{ group_key: string }[]>`
      SELECT DISTINCT group_key FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND status = 'draft' AND target_path = ${HEAL_A}
    `;
    expect(before).toHaveLength(1);
    const oldKey = before[0]!.group_key;

    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const pair = page.locator(`.gard-card[data-group]`).filter({ hasText: "Heal c" }).first();
    await pair.locator('[data-group-action="approve"]').click();
    await expect(pair.locator(".gard-badge.chip-applied")).toHaveCount(1);
    expect(await read(HEAL_C)).toContain("- [[Heal a]]");

    const { body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, JSON_POST);
    expect(body.staled).toBe(2);
    expect(body.proposed).toBe(1);

    // The old group is retired…
    const old = await sql!<{ status: string }[]>`
      SELECT status FROM wiki_proposals WHERE wiki_name = ${WIKI} AND group_key = ${oldKey}
    `;
    expect(old.map((r) => r.status)).toEqual(["stale", "stale"]);
    // …a successor covering all THREE pages is live…
    const live = await sql!<{ group_key: string; target_path: string }[]>`
      SELECT group_key, target_path FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND status = 'draft' AND target_path IN (${HEAL_A}, ${HEAL_B}, ${HEAL_C})
    `;
    expect(new Set(live.map((r) => r.group_key)).size).toBe(1);
    expect(live.map((r) => r.target_path).sort()).toEqual([HEAL_A, HEAL_B, HEAL_C].sort());
    expect(live[0]!.group_key).not.toBe(oldKey);
    // …and no page anywhere carries two live rows.
    const doubled = await sql!<{ target_path: string }[]>`
      SELECT target_path FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND status IN ('draft','approved')
      GROUP BY target_path HAVING COUNT(*) > 1
    `;
    expect(doubled).toEqual([]);
  });

  /**
   * THE STOPPED path. A member edited on disk after seeding fails its CAS, so
   * the apply halts there — and everything it never reached goes back to
   * `draft`, or the card renders with no verb at all and the reviewer can only
   * reload past it.
   */
  test("a member edited after seeding stops the group, and the card stays actionable", async ({ page }) => {
    await writeFile(path.join(root, HEAL_B), (await read(HEAL_B)) + "\nEdited after drafting.\n", "utf8");

    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const card = page.locator(`.gard-card[data-group]`).filter({ hasText: "Heal a" }).first();
    await card.locator('[data-group-action="approve"]').click();

    // The note names the boundary and survives the reload the stop triggers.
    await expect(card.locator(".gard-outcome")).toContainText(`Stopped at ${HEAL_B}`);
    await expect(card.locator(".gard-badge.badge-group")).toHaveText("3 pages");
    // The chip summarises the status SET — the card used to read `applied` off
    // `rows[0]` and claim the whole fix had landed. Order follows the rows, so
    // the assertion is on the parts.
    const chip = await card.locator(".gard-badge[class*='chip-']").last().textContent();
    expect(chip!.split(" · ").sort()).toEqual(["1 applied", "1 draft", "1 stale"]);
    // Rows before the boundary stay written; the rest are reviewable again.
    expect(await read(HEAL_A)).toContain("series: ");
    await expect(card.locator('[data-group-action="approve"]')).toHaveCount(1);
    await expect(card.locator('[data-group-action="reject"]')).toHaveCount(1);

    // A status filter picks which CARDS show, never which ROWS a card holds —
    // and only a MIXED group can tell the two apart. Filtered to `draft`, a
    // card built from the filtered list renders a one-page fix over a
    // three-page group, with the applied member silently missing.
    await page.locator('.gard-filter[data-status="draft"]').click();
    await expect(card.locator(".gard-group-diff")).toHaveCount(3);
    await expect(card.locator(".gard-badge.badge-group")).toHaveText("3 pages");
    await page.locator('.gard-filter[data-status=""]').click();

    // …and the buttons DO something. The stop left one row `draft`, so a second
    // Accept has to apply it — an all-or-nothing gate answers 409 `mixed` here
    // and the reverted rows can never be applied at all.
    const beforeSecond = await read(HEAL_C);
    await card.locator('[data-group-action="approve"]').click();
    await expect(card.locator(".gard-badge.chip-stale")).toHaveCount(1);
    expect(await read(HEAL_C)).not.toBe(beforeSecond);
    expect(await read(HEAL_C)).toContain("series: ");
    // The chip is coloured by the SET, not by `rows[0]`: nothing is reviewable
    // any more, but a stale member means the card is not `applied` either.
    const settled = await card.locator(".gard-badge.chip-stale").textContent();
    expect(settled!.split(" · ").sort()).toEqual(["1 stale", "2 applied"]);
    await expect(card.locator('[data-group-action="approve"]')).toHaveCount(0);
  });

  /**
   * A row the apply short-circuits (step 2a: the page already IS the draft)
   * wrote nothing, and the answer keeps it out of `applied`. The note lands on
   * a card that has just STOPPED being reviewable — every row is `applied` —
   * which is why the actions row is rendered outside the reviewable guard.
   */
  test("a page that already carries the edit is reported as noop, on a card with no verbs", async ({ page }) => {
    // The OVERLAP × FOLLOW pair was claimed on the first pass; with the cluster
    // applied, its pages are free and this seeds it.
    const { body } = await api(`/api/wiki/lint-proposals?wiki=${WIKI}`, JSON_POST);
    expect(body.proposed).toBeGreaterThan(0);
    const rows = await sql!<{ group_key: string; target_path: string; draft: string }[]>`
      SELECT group_key, target_path, draft FROM wiki_proposals
      WHERE wiki_name = ${WIKI} AND status = 'draft' AND group_key LIKE 'lint:same-work-no-link:%'
    `;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    // Write the draft's exact bytes by hand: `applyInner` short-circuits at 2a
    // BEFORE the base_hash check, so this is a noop and not a stale row.
    await writeFile(path.join(root, row.target_path), row.draft, "utf8");

    await page.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
    const card = page.locator(`.gard-card[data-group="${row.group_key}"]`);
    await card.locator('[data-group-action="approve"]').click();

    await expect(card.locator(".gard-outcome")).toContainText("already carried the edit");
    await expect(card.locator('[data-group-action="approve"]')).toHaveCount(0);
  });
});
