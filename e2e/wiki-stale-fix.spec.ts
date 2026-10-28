/**
 * The Stale check's fix paths (plan muninn-wiki-drift-check, PR 3), end to end.
 *
 * What no unit test can prove, and this spec exists for:
 *
 *   1. **Apply drops the counts on the next read**: the click in the real tab
 *      POSTs `/api/wiki/stale/apply`, the server writes the page through the
 *      write queue, and the tab, the pill and the rail drop together.
 *   2. **Send to Gardener on two linking pages leaves ONE live Stale check
 *      card holding both (D20)**: group 1 goes `stale`, group 2 holds both
 *      rows, and the reader shows ⧗ 2 fixes in review on the pill and the rail.
 *   3. **A lint seed run leaves that card untouched (D19)** and skips, as
 *      claimed, a lint finding on a page the card holds.
 *   4. **The Gardener names the kind (D28)**: the kind filter beside the status
 *      chips, the STALE CHECK tag, and «replaced by group 2» on group 1.
 *   5. **Accept writes both pages in one queue section with one `log.md` entry
 *      naming both**, leaves a dangling wikilink already on a page untouched,
 *      and the counts on the rail, the pill, the tab and the home drop to the
 *      same number.
 *   6. **Dismiss keeps the text as written**: the passage reads «Still true».
 *   7. **A read-only instance shows no Apply or Send (D25)**: the tab is gone.
 *   8. **A fix commit is not a page change (D29)**: the hub links back to
 *      notes/d.md, so a fix commit that dated its page would make the hub To
 *      check for it; the wiki-wide total drops after Apply and Accept instead,
 *      and after the hub's own status-line fix the fixed pages stay out only
 *      because their `fixed` rows followed its new content hash.
 *   9. **A fix in flight cannot be sent twice, and the tab tells the answer**
 *      (fix round 1 batch 6): Apply's and Send's buttons stay disabled through
 *      a repaint while the request is held; Apply's and Send's results (the
 *      group, a dropped edit) show in the notice, in the token colour of their
 *      tone; the next answer replaces an error notice.
 *
 * **What is stubbed and why.** No model is called: the verdict rows Check would
 * write are inserted under keys the server's own key functions derive (a
 * `bun -e` over `src/wiki/stale-confirm.ts`, since Playwright runs this file
 * under Node). The knowledge API port is dead, so the post-write reindex is
 * best effort, as it must be.
 *
 * Ports from `e2e/ports.ts`; `e2eEnv()` blanks the platform tokens and the
 * instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

test.describe.configure({ mode: "serial" });

const PORT = e2ePort("wiki-stale-fix");
const RO_PORT = e2ePort("wiki-stale-fix/readonly");
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2estalefix";
const DAY = 86_400_000;
/** In a folder, so the group key `stale-check:repos/hub.md:<n>` carries a `/`. */
const HUB = "repos/hub.md";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;
/** The hub links back to notes/d.md with a dated claim: a mutual link, so a
 *  fix commit that counted as a page change would make the hub To check for d. */
const HUB_TEXT = page("Hub", "- [[p]] is in-flight, two PRs open\n\nThe pin moved to 18.06. The [[d]] note was moved on 12.05.");
/** notes/a.md is also one end of a lint 8.1 pair (two shared PRs with notes/e.md, no link). */
const A_TEXT = page("A", "The pin in [[hub]] landed on 23.05. Shipped RuneLind/muninn#901 and RuneLind/muninn#902.", "status_date: 2026-09-20\n");
const E_TEXT = page("E", "Done in RuneLind/muninn#901 and RuneLind/muninn#902.", "status_date: 2026-09-10\n");
/** notes/b.md carries a dangling wikilink a Stale check Accept must leave alone. */
const B_TEXT = page("B", "Since [[hub]] moved on 2.06 the pin is draft. See [[No Such Page]].");
const C_TEXT = page("C", "The lock in [[hub]] was set on 3.05 by the old rule.");
const D_TEXT = page("D", "The hub [[hub]] pinned it on 12.05 last time.");

const EDITS: Record<string, { old: string; new: string; home?: string }> = {
  "notes/a.md": { old: "landed on 23.05", new: "landed on 18.06" },
  "notes/b.md": { old: "the pin is draft", new: "the pin is shipped" },
  "notes/c.md": { old: "by the old rule", new: "by the new rule" },
  "notes/d.md": { old: "pinned it on 12.05", new: "pinned it on 18.06" },
};

let root = "";
let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;

function git(args: string[], atMs: number): void {
  const date = new Date(atMs).toISOString();
  execFileSync("git", ["-C", root, ...args], {
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

async function write(rel: string, body: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root, rel), body, "utf8");
}
const read = (rel: string) => readFile(path.join(root, rel), "utf8");

/** The verdict keys, derived by the server's own key functions under Bun. */
function serverKeys(): { hit: string; passages: Record<string, string> } {
  const code = `
    import { getWikiIndex } from "./src/wiki/store.ts";
    import { linkingBuckets } from "./src/wiki/stale.ts";
    import { changedHashOf, passageVerdictKey, statusLineVerdictKey } from "./src/wiki/stale-confirm.ts";
    const index = await getWikiIndex({ root: process.env.STALE_ROOT });
    const hit = index.statusLineHits.get("${HUB}")[0];
    const buckets = await linkingBuckets(index, "${HUB}");
    const hash = await changedHashOf(index, "${HUB}");
    const passages = {};
    for (const l of buckets.linking) passages[l.relPath] = passageVerdictKey(index, "${HUB}", hash, l);
    console.log(JSON.stringify({ hit: statusLineVerdictKey(index, "${HUB}", hit), passages }));
    process.exit(0);
  `;
  const out = execFileSync("bun", ["--no-env-file", "-e", code], { cwd: REPO_ROOT, env: { ...process.env, STALE_ROOT: root }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}

function boot(port: number, extra: Record<string, string>): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // A collection makes the wiki a Gardener scope (and Send possible).
      WIKI_EXTRA: `${WIKI}=${root}=${WIKI}`,
      KNOWLEDGE_API_URL: `http://127.0.0.1:${e2ePort("wiki-stale-fix/dead-huginn")}`,
      ...extra,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`muninn did not start at ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-fix-"));
  const now = Date.now();
  git(["init", "-q", "-b", "main"], now);
  // The server commits Apply and Accept with no `-c`; a CI runner has no global identity.
  git(["config", "user.email", "e2e@example.invalid"], now);
  git(["config", "user.name", "e2e"], now);
  await write("plans/p.md", page("P", "The plan.", "plan_status: shipped\n"));
  await write(HUB, page("Hub", "First."));
  await write("notes/a.md", A_TEXT);
  await write("notes/b.md", B_TEXT);
  await write("notes/c.md", C_TEXT);
  await write("notes/d.md", D_TEXT);
  await write("notes/e.md", E_TEXT);
  git(["add", "-A"], now - 30 * DAY);
  git(["commit", "-q", "-m", "seed"], now - 30 * DAY);
  await write(HUB, HUB_TEXT);
  // 5 days: older than a fix made now by more than the 2-day margin.
  git(["add", "-A"], now - 5 * DAY);
  git(["commit", "-q", "-m", "hub: the pin moves"], now - 5 * DAY);

  const keys = serverKeys();
  expect(Object.keys(keys.passages).sort()).toEqual(["notes/a.md", "notes/b.md", "notes/c.md", "notes/d.md"]);
  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  await sql`DELETE FROM wiki_proposals WHERE wiki_name = ${WIKI}`;
  await sql`
    INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, edit, checked_by)
    VALUES (${WIKI}, 'status-line', ${HUB}, ${keys.hit}, 'stale', 'E2E: the plan shipped', ${sql.json({ old: "is in-flight, two PRs open", new: "is shipped", home: "" })}, 'model:e2e')
  `;
  for (const [rel, edit] of Object.entries(EDITS)) {
    await sql`
      INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, edit, checked_by)
      VALUES (${WIKI}, 'passage', ${rel}, ${keys.passages[rel]!}, 'stale', ${`E2E: ${rel} is out of date`}, ${sql.json(edit)}, 'model:e2e')
    `;
  }
  server = boot(PORT, {});
  roServer = boot(RO_PORT, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE), waitUp(RO_BASE)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  try {
    if (sql) {
      await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
      await sql`DELETE FROM wiki_proposals WHERE wiki_name = ${WIKI}`;
    }
  } finally {
    await sql?.end();
  }
  await rm(root, { recursive: true, force: true });
});

async function openHub(p: Page, base = BASE): Promise<void> {
  await p.goto(`${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(HUB)}`);
  await expect(p.locator(".wiki-article")).toContainText("The pin moved");
}
async function openTab(p: Page): Promise<void> {
  await openHub(p);
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await expect(p.locator("#staleBody .wiki-stale-head")).toBeVisible();
}
const head = (p: Page) => p.locator("#staleBody .wiki-stale-head");
const pill = (p: Page) => p.locator("#wikiStalePill [data-stale-pill]");
const railBadge = (p: Page) => p.locator(`.wiki-list-item[data-relpath="${HUB}"] .wiki-stale-rail`);
/** One linking page's Draft fix button. */
async function fixButton(p: Page, rel: string, action: "apply" | "send") {
  const item = p.locator(`#staleBody [data-stale-linking="${rel}"]`);
  const fix = item.locator(".wiki-stale-fix");
  if (!(await fix.evaluate((d) => (d as HTMLDetailsElement).open))) await fix.locator("summary").click();
  return item.locator(`[data-stale-${action}][data-variant="new"]`);
}
/** The tab's one notice line (an action's outcome). */
const notice = (p: Page) => p.locator("#staleBody [data-stale-notice]");
/** A theme token's colour as the page resolves it, on a body probe. */
const tokenColor = (p: Page, token: string) =>
  p.evaluate((t) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
async function expectNoticeTone(p: Page, token: string): Promise<void> {
  const want = await tokenColor(p, token);
  expect(want).not.toBe(await tokenColor(p, "--text-primary"));
  expect(await notice(p).evaluate((e) => getComputedStyle(e).color)).toBe(want);
}
/** Reopen the hub from the rail (a page load, so the tab repaints) and wait for its report. */
async function reopenHub(p: Page): Promise<void> {
  const reloaded = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?page="));
  await p.locator(`.wiki-list-item[data-relpath="${HUB}"]`).click();
  await reloaded;
}
/** The wiki-wide Stale check summary: its total To check, and the changed pages. */
async function wikiTotals(): Promise<{ toCheck: number; changed: string[] }> {
  const s = (await (await fetch(`${BASE}/api/wiki/stale?wiki=${WIKI}`)).json()) as { totals: { toCheck: number }; pages: { relPath: string; changed: boolean }[] };
  return { toCheck: s.totals.toCheck, changed: s.pages.filter((r) => r.changed).map((r) => r.relPath).sort() };
}
const liveRows = async () =>
  (await sql!`SELECT group_key, target_path, status FROM wiki_proposals WHERE wiki_name = ${WIKI} AND kind = 'stale-check' ORDER BY group_key, target_path`).map((r) => [r.group_key, r.target_path, r.status]);

test("Apply on a linking page writes it, and the tab, the pill and the rail drop on the next read", async ({ page: p }) => {
  await openTab(p);
  await expect(head(p)).toHaveText("⚠ 1 stale status line · 4 linking pages to check");
  await expect(pill(p)).toHaveText("⚠ 1 stale status line · 4 linking pages to check");
  await expect(railBadge(p)).toHaveText("⚠ 1 · 4");
  expect(await wikiTotals()).toEqual({ toCheck: 4, changed: [HUB] });
  // Batch 6: the request is held, so the fix is in flight while the tab repaints.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let posts = 0;
  await p.route("**/api/wiki/stale/apply", async (route) => {
    posts++;
    await held;
    await route.continue();
  });
  const applied = p.waitForResponse((r) => r.url().endsWith("/api/wiki/stale/apply"));
  await (await fixButton(p, "notes/d.md", "apply")).click();
  await expect.poll(() => posts).toBe(1);
  const dButtons = p.locator('#staleBody [data-stale-linking="notes/d.md"] :is([data-stale-apply], [data-stale-send])');
  await reopenHub(p);
  // The repaint drew the buttons anew: both are still disabled, so a second click sends nothing.
  await expect(dButtons).toHaveCount(2);
  for (const b of await dButtons.all()) await expect(b).toBeDisabled();
  release();
  expect((await applied).status()).toBe(200);
  expect(posts).toBe(1);
  await p.unroute("**/api/wiki/stale/apply");
  await expect(notice(p)).toHaveText("Applied to notes/d.md.");
  await expectNoticeTone(p, "--status-success");
  await expect(head(p)).toHaveText("⚠ 1 stale status line · 3 linking pages to check");
  await expect(pill(p)).toHaveText("⚠ 1 stale status line · 3 linking pages to check");
  await expect(railBadge(p)).toHaveText("⚠ 1 · 3");
  expect(await read("notes/d.md")).toBe(D_TEXT.replace("pinned it on 12.05", "pinned it on 18.06"));
  expect(await read("log.md")).toContain("stale-check | D");
  // D29: the `fixed` row on the new passage.
  expect((await sql!`SELECT page FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND kind = 'fixed'`).map((r) => r.page)).toEqual(["notes/d.md"]);
  // The fix commit is not a page change: d is no changed page, so the hub's
  // link back to it is not To check, and the wiki-wide total drops too.
  expect(await wikiTotals()).toEqual({ toCheck: 3, changed: [HUB] });
});

test("Send on two linking pages leaves ONE live Stale check card holding both, and ⧗ 2 shows on the pill and the rail", async ({ page: p }) => {
  await openTab(p);
  // Batch 6: a refused Send shows its error; it stands through a reload of the
  // page (R2B4), and the next answer replaces it.
  await p.route("**/api/wiki/stale/send", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "E2E: refused once" }) }), { times: 1 });
  await (await fixButton(p, "notes/a.md", "send")).click();
  await expect(notice(p)).toHaveText("The fix was not sent to the Gardener: E2E: refused once");
  await expectNoticeTone(p, "--status-error");
  await reopenHub(p);
  await expect(notice(p)).toHaveText("The fix was not sent to the Gardener: E2E: refused once");
  // The server drops no edit on this first Send, so the answer is given one,
  // as a Send over a moved page answers: the tab tells it, reason and all.
  await p.route(
    "**/api/wiki/stale/send",
    async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, dropped: [{ page: "notes/z.md", old: "E2E old text", reason: "E2E: no longer on the page" }] } });
    },
    { times: 1 },
  );
  const told = {
    "notes/a.md": ["Sent to the Gardener as group 1: 1 fix on 1 page. Dropped 1 earlier fix that no longer fits: «E2E old text» on notes/z.md (E2E: no longer on the page).", "--status-warning"],
    "notes/b.md": ["Sent to the Gardener as group 2 (replaces group 1): 2 fixes on 2 pages.", "--status-success"],
  } as const;
  for (const rel of ["notes/a.md", "notes/b.md"] as const) {
    const sent = p.waitForResponse((r) => r.url().endsWith("/api/wiki/stale/send"));
    await (await fixButton(p, rel, "send")).click();
    expect((await sent).status()).toBe(200);
    await expect(p.locator(`#staleBody [data-stale-linking="${rel}"] [data-stale-in-review]`)).toBeVisible();
    // The later success replaces the earlier notice.
    await expect(notice(p)).toHaveText(told[rel][0]);
    await expectNoticeTone(p, told[rel][1]);
  }
  expect(await liveRows()).toEqual([
    [`stale-check:${HUB}:1`, "notes/a.md", "stale"],
    [`stale-check:${HUB}:2`, "notes/a.md", "draft"],
    [`stale-check:${HUB}:2`, "notes/b.md", "draft"],
  ]);
  await expect(p.locator("#wikiStalePill [data-stale-pill-review]")).toHaveText("⧗ 2 fixes in review");
  await expect(railBadge(p)).toHaveText("⚠ 1 · 3 ⧗ 2");
  // A Send writes nothing.
  expect(await read("notes/a.md")).toBe(A_TEXT);
});

test("a lint seed run leaves the Stale check card untouched and skips the finding on its page as claimed", async () => {
  const res = await fetch(`${BASE}/api/wiki/lint-proposals?wiki=${WIKI}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { claimed: number; staled: number; proposed: number };
  // The 8.1 pair (notes/a.md ↔ notes/e.md) writes notes/a.md, which the card holds.
  expect(body).toMatchObject({ claimed: 1, staled: 0, proposed: 0 });
  expect((await sql!`SELECT count(*)::int AS n FROM wiki_proposals WHERE wiki_name = ${WIKI} AND kind = 'lint'`)[0]!.n).toBe(0);
  expect(await liveRows()).toEqual([
    [`stale-check:${HUB}:1`, "notes/a.md", "stale"],
    [`stale-check:${HUB}:2`, "notes/a.md", "draft"],
    [`stale-check:${HUB}:2`, "notes/b.md", "draft"],
  ]);
});

test("the Gardener: a kind filter beside the status chips, the STALE CHECK tag, «replaced by group 2» on group 1", async ({ page: p }) => {
  await p.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
  const live = p.locator(`.gard-card[data-group="stale-check:${HUB}:2"]`);
  await expect(live).toBeVisible();
  // The tag reads STALE CHECK on screen (the badge CSS upper-cases its text).
  expect(await live.locator(".gard-badge.badge-stale-check").evaluate((e) => (e as HTMLElement).innerText)).toBe("STALE CHECK");
  // Batch 6: the tag has its own look — outlined in the accent, not the stale chip's warning fill.
  const tagLook = await live.locator(".gard-badge.badge-stale-check").evaluate((e) => ({ color: getComputedStyle(e).color, fill: getComputedStyle(e).backgroundColor }));
  expect(tagLook).toEqual({ color: await tokenColor(p, "--accent-light"), fill: "rgba(0, 0, 0, 0)" });
  expect(tagLook.color).not.toBe(await tokenColor(p, "--status-warning"));
  await expect(live.locator(".gard-title")).toHaveText(`Stale check: ${HUB}`);
  await expect(live.locator(".gard-group-diff")).toHaveCount(2);
  await p.locator('#gardFilters [data-kind="lint"]').click();
  await expect(live).toHaveCount(0);
  await p.locator('#gardFilters [data-kind="stale-check"]').click();
  await expect(live).toBeVisible();
  await p.locator('#gardFilters [data-status="stale"]').click();
  const old = p.locator(`.gard-card[data-group="stale-check:${HUB}:1"]`);
  await expect(old.locator("[data-replaced-by-group]")).toHaveText("replaced by group 2");
  await expect(live).toHaveCount(0);
});

test("Accept writes both pages in one section with one log.md entry, keeps the dangling link, and every surface drops to the same number", async ({ page: p }) => {
  const logBefore = await read("log.md");
  await p.goto(`${BASE}/wiki/gardener?wiki=${WIKI}`);
  const card = p.locator(`.gard-card[data-group="stale-check:${HUB}:2"]`);
  const done = p.waitForResponse((r) => r.url().includes("/approve"));
  await card.locator('[data-group-action="approve"]').click();
  expect((await done).status()).toBe(200);
  expect(await read("notes/a.md")).toBe(A_TEXT.replace("landed on 23.05", "landed on 18.06"));
  // Byte-exact: the dangling [[No Such Page]] that was already there survives.
  expect(await read("notes/b.md")).toBe(B_TEXT.replace("the pin is draft", "the pin is shipped"));
  const log = await read("log.md");
  // ONE new entry, naming both pages under the changed page.
  expect(log.split("## [").length - logBefore.split("## [").length).toBe(1);
  expect(log).toContain(`update | Stale check: ${HUB}\n- via stale-check, 2 pages: notes/a.md, notes/b.md`);
  expect((await sql!`SELECT page FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND kind = 'fixed' ORDER BY page`).map((r) => r.page)).toEqual(["notes/a.md", "notes/b.md", "notes/d.md"]);

  await openTab(p);
  const words = "⚠ 1 stale status line · 1 linking page to check";
  await expect(head(p)).toHaveText(words);
  await expect(pill(p)).toHaveText(words);
  await expect(railBadge(p)).toHaveText("⚠ 1 · 1");
  await expect(p.locator("#wikiStalePill [data-stale-pill-review]")).toHaveCount(0);
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&view=stale`);
  await expect(p.locator(`.wiki-stale-home-row[data-relpath="${HUB}"] .wiki-stale-home-counts`)).toHaveText(words);
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toHaveText(`${words} on 1 page`);
  expect(await wikiTotals()).toEqual({ toCheck: 1, changed: [HUB] });
});

test("Dismiss keeps the text as written; Apply on the status line drops the stale line", async ({ page: p }) => {
  await openTab(p);
  const sent = p.waitForResponse((r) => r.url().endsWith("/api/wiki/stale/send"));
  await (await fixButton(p, "notes/c.md", "send")).click();
  expect((await sent).status()).toBe(200);
  expect((await liveRows()).filter((r) => r[2] === "draft")).toEqual([[`stale-check:${HUB}:3`, "notes/c.md", "draft"]]);
  const res = await fetch(`${BASE}/api/wiki/proposals/group/${encodeURIComponent(`stale-check:${HUB}:3`)}/reject?wiki=${WIKI}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(await res.json()).toEqual({ outcome: "rejected", rejected: 1, kept: 1, keptSkipped: 0 });
  expect(await read("notes/c.md")).toBe(C_TEXT);
  await openTab(p);
  await expect(p.locator('#staleBody [data-stale-linking="notes/c.md"] .wiki-stale-verdict')).toContainText("Still true");
  await expect(p.locator('#staleBody [data-stale-linking="notes/c.md"] .wiki-stale-verdict')).toContainText("Kept as written");

  // The status-line hit's Apply: the line is rewritten and the stale line goes.
  const hit = p.locator("#staleBody [data-stale-hit]");
  await hit.locator(".wiki-stale-fix summary").click();
  const applied = p.waitForResponse((r) => r.url().endsWith("/api/wiki/stale/apply"));
  await hit.locator('[data-stale-apply][data-variant="new"]').click();
  expect((await applied).status()).toBe(200);
  // The hub's content hash moved: a, b and d stay out of To check only
  // because their `fixed` rows followed it (their fix commits date nothing).
  await expect(head(p)).toHaveText("⚠ 0 stale status lines · 1 linking page to check");
  expect(await wikiTotals()).toEqual({ toCheck: 1, changed: [HUB] });
  await expect(p.locator(".wiki-article")).toContainText("is shipped");
  expect(await read(HUB)).toBe(HUB_TEXT.replace("is in-flight, two PRs open", "is shipped"));
});

test("a read-only instance shows no STALE tab, so no Apply or Send", async ({ page: p }) => {
  await openHub(p, RO_BASE);
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).toBeHidden();
  await expect(p.locator("[data-stale-apply], [data-stale-send]")).toHaveCount(0);
  const res = await fetch(`${RO_BASE}/api/wiki/stale/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: WIKI, page: HUB, kind: "passage", linking: "notes/c.md", variant: "new" }) });
  expect(res.status).toBe(403);
});
