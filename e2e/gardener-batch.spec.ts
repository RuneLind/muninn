/**
 * `/wiki/gardener` — batch review: the ungrouped drafts filed into sections
 * ("AI and tech", "Life", "Entertainment — films and TV") by path and
 * tags, each with Approve all (and Reject all on entertainment), run one card at
 * a time through the per-card routes.
 *
 * What no unit test reaches: the listing's `category` from a real draft's tags,
 * the sections on the page, a batch writing every page to disk and settling
 * every row, the same-page pair left for a human, and the other section left
 * alone.
 *
 * A throwaway bot under `MUNINN_BOTS_DIR` owns a temp wiki (no git repo, so the
 * commit is skipped); the rows go into the test database. Playwright runs this
 * file under NODE — hence `postgres`, not `Bun.sql`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("gardener-batch");
const BASE = `http://127.0.0.1:${PORT}`;
const DEAD_HUGINN = `http://127.0.0.1:${e2ePort("gardener-batch/dead-huginn")}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BOT = "e2ebatch";
const PLAIN_BOT = "e2ebatchplain";
const COLLECTION = "youtube-summaries";

let server: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let tmpRoot = "";
let wikiDir = "";
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

const page_ = (title: string, tags: string) => page(title, tags);
function page(title: string, tags: string): string {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(title)}`;
  return `---\ntype: source\ntitle: ${title}\naliases: []\ncreated: 2026-11-11\nupdated: 2026-11-11\ntags: [${tags}]\nurl: ${url}\nsources: [${url}]\n---\n\n# ${title}\n\nBody.\n`;
}

async function seedDraft(key: string, title: string, tags: string, target = `sources/${title}.mdx`): Promise<void> {
  const docId = `e2e-batch/${key}.md`;
  const [row] = await sql!`
    INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, draft, source_docs, status)
    VALUES (${BOT}, ${`source:${COLLECTION}:${docId}`}, 'source', 'create', ${target},
            ${page(title, tags)}, ${sql!.json([{ collection: COLLECTION, docId, title, url: "" }])}, 'draft')
    RETURNING id`;
  ids[key] = row!.id;
}

async function statusOf(key: string): Promise<string> {
  const [row] = await sql!`SELECT status FROM wiki_proposals WHERE id = ${ids[key]!}`;
  return row!.status;
}

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "e2e-batch-"));
  const botDir = path.join(tmpRoot, "bots", BOT);
  wikiDir = path.join(tmpRoot, "wiki");
  mkdirSync(botDir, { recursive: true });
  mkdirSync(path.join(wikiDir, "sources"), { recursive: true });
  writeFileSync(path.join(wikiDir, "index.md"), "# Index\n");
  writeFileSync(path.join(botDir, "CLAUDE.md"), "# throwaway e2e bot\n");
  writeFileSync(path.join(botDir, "config.json"), JSON.stringify({ wikiDir }));
  // A second bot whose wiki has no life/ domain (fix round 2 batch 1).
  const plainDir = path.join(tmpRoot, "bots", PLAIN_BOT);
  mkdirSync(plainDir, { recursive: true });
  mkdirSync(path.join(tmpRoot, "plain-wiki", "sources"), { recursive: true });
  writeFileSync(path.join(tmpRoot, "plain-wiki", "index.md"), "# Index\n");
  writeFileSync(path.join(plainDir, "CLAUDE.md"), "# throwaway e2e bot\n");
  writeFileSync(path.join(plainDir, "config.json"), JSON.stringify({ wikiDir: path.join(tmpRoot, "plain-wiki") }));

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql`DELETE FROM wiki_proposals WHERE bot_name IN ${sql([BOT, PLAIN_BOT])}`;
  await seedDraft("ai1", "Agent Skills Primer", "agent-skills, claude-code");
  await seedDraft("ai2", "Local Model Hardware", "local-ai, hardware, streaming");
  await seedDraft("twinA", "Same Page", "claude-code");
  await seedDraft("twinB", "Same Page Again", "claude-code", "sources/Same Page.mdx");
  // Films and TV land under life/, as the drafter files them; an AI-domain page
  // tagged entertainment stays in "AI and tech".
  await seedDraft("film1", "Sci-Fi Film Countdown", "film, science-fiction, entertainment", "life/sources/Sci-Fi Film Countdown.mdx");
  await seedDraft("film2", "Netflix Series Ranking", "netflix, tv-series", "life/sources/Netflix Series Ranking.mdx");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      MUNINN_BOTS_DIR: path.join(tmpRoot, "bots"),
      KNOWLEDGE_API_URL: DEAD_HUGINN,
      SCHEDULER_ENABLED: "false",
      LOG_DIR: "none",
      [`TELEGRAM_BOT_TOKEN_${BOT.toUpperCase()}`]: "",
      [`TELEGRAM_BOT_TOKEN_${PLAIN_BOT.toUpperCase()}`]: "",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) break;
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
    if (sql) await sql`DELETE FROM wiki_proposals WHERE bot_name IN ${sql([BOT, PLAIN_BOT])}`;
  } finally {
    await sql?.end();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const head = (p: Page, section: string) => p.locator(`.gard-batch-head[data-batch-section="${section}"]`);
const sectionCards = (p: Page, section: string) =>
  p.locator(`.gard-batch-head[data-batch-section="${section}"] ~ .gard-card`);

test("drafts are filed by their tags, and the same-page pair is left out of Approve all", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const other = head(page, "ai");
  const ent = head(page, "entertainment");
  await expect(other).toContainText("AI and tech");
  await expect(other).toContainText("4 drafts");
  await expect(other.locator('[data-batch-action="approve"]')).toHaveText("Approve 2 of 4 AI drafts");
  await expect(other.locator('[data-batch-action="reject"]')).toHaveCount(0);
  await expect(other.locator(".gard-batch-note")).toHaveText("left for you: 2 another draft writes the same page");
  await expect(ent).toContainText("2 drafts");
  await expect(ent.locator('[data-batch-action="approve"]')).toHaveText("Approve all 2 Entertainment drafts");
  await expect(ent.locator('[data-batch-action="reject"]')).toHaveText("Reject all 2 Entertainment drafts");
  // "AI and tech" leads, and each film card sits under the entertainment header.
  const order = await page.locator(".gard-batch-head").evaluateAll((els) => els.map((e) => e.getAttribute("data-batch-section")));
  expect(order).toEqual(["ai", "entertainment"]);
  await expect(page.locator(`.gard-batch-head[data-batch-section="entertainment"] ~ .gard-card[data-id="${ids.film1}"]`)).toHaveCount(1);
  await expect(sectionCards(page, "entertainment")).toHaveCount(2);
});

test("Approve all writes every page in its section and leaves the rest as drafts", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("2 of 2 approved", { timeout: 30_000 });
  expect(await statusOf("ai1")).toBe("applied");
  expect(await statusOf("ai2")).toBe("applied");
  expect(existsSync(path.join(wikiDir, "sources/Agent Skills Primer.mdx"))).toBe(true);
  expect(existsSync(path.join(wikiDir, "sources/Local Model Hardware.mdx"))).toBe(true);
  for (const key of ["twinA", "twinB", "film1", "film2"]) expect(await statusOf(key)).toBe("draft");
  expect(existsSync(path.join(wikiDir, "sources/Same Page.mdx"))).toBe(false);
  // The pair is still reviewable one by one.
  await expect(page.locator(`.gard-card[data-id="${ids.twinA}"] [data-action="approve"]`)).toBeEnabled();
});

test("Reject all on entertainment rejects only the films", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await head(page, "entertainment").locator('[data-batch-action="reject"]').click();
  await expect(head(page, "entertainment").locator(".gard-batch-note")).toContainText("2 of 2 rejected", { timeout: 30_000 });
  expect(await statusOf("film1")).toBe("rejected");
  expect(await statusOf("film2")).toBe("rejected");
  expect(await statusOf("twinA")).toBe("draft");
});

// Fix round 1 batch 1 (review findings 1, 6). Both seed their own drafts: the
// tests above have settled the first ones.
test("a fault every card shares stops the batch at the first card", async ({ page }) => {
  await seedDraft("f1", "Fault One", "claude-code");
  await seedDraft("f2", "Fault Two", "claude-code");
  let hits = 0;
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    hits += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ outcome: "error", error: "bot has no wikiDir configured" }) });
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("bot has no wikiDir configured");
  expect(hits).toBe(1);
  await page.unroute("**/api/wiki/proposals/*/approve*");
  await sql!`DELETE FROM wiki_proposals WHERE id IN ${sql!([ids.f1!, ids.f2!])}`;
});

test("Approve all does not post a card whose single Approve is still in flight", async ({ page }) => {
  await seedDraft("c1", "Click One", "claude-code");
  await seedDraft("c2", "Click Two", "claude-code");
  const posts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    posts.push(id);
    if (id === ids.c1 && posts.filter((p) => p === ids.c1).length === 1) await held;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await page.locator(`.gard-card[data-id="${ids.c1}"] [data-action="approve"]`).click();
  await expect.poll(() => posts.length).toBe(1);
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect.poll(() => posts.includes(ids.c2!)).toBe(true);
  release();
  const note = head(page, "ai").locator(".gard-batch-note");
  await expect(note).toContainText(/^\d+ of \d+ approved/, { timeout: 30_000 });
  await expect(note).not.toContainText("failed");
  expect(posts.filter((p) => p === ids.c1)).toHaveLength(1);
  await expect.poll(() => statusOf("c1")).toBe("applied");
  expect(await statusOf("c2")).toBe("applied");
});

// Fix round 1 batch 3 (review findings 7, 8).
test("a batch re-reads the listing first, so a draft settled elsewhere is not posted", async ({ page }) => {
  await seedDraft("s1", "Settled Elsewhere", "claude-code");
  await seedDraft("s2", "Still A Draft", "claude-code");
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await expect(page.locator(`.gard-card[data-id="${ids.s1}"]`)).toHaveCount(1);
  // Another tab rejects s1 after this one loaded.
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE id = ${ids.s1!}`;
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  const note = head(page, "ai").locator(".gard-batch-note");
  await expect(note).toContainText("1 of 1 approved", { timeout: 30_000 });
  await expect(note).not.toContainText("failed");
  expect(await statusOf("s1")).toBe("rejected");
  expect(await statusOf("s2")).toBe("applied");
});

test("a finished batch's note survives the Pending filter emptying, and leaves with a filter change", async ({ page }) => {
  // Only one draft left anywhere, so the batch empties the Pending view.
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("film3", "Anime Film Picks", "anime, film", "life/sources/Anime Film Picks.mdx");
  await sql!`
    INSERT INTO wiki_proposals (bot_name, wiki_name, topic_key, kind, mode, target_path, draft, source_docs, status, group_key)
    VALUES (${BOT}, ${BOT}, 'lint:e2e:batch:index.md', 'lint', 'update', 'index.md', '# Index\n', '[]'::jsonb, 'draft', 'lint:e2e:batch')`;
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await page.locator('#gardFilters .gard-filter[data-kind="pages"]').click();
  await page.locator('#gardFilters .gard-filter[data-status="draft"]').click();
  await head(page, "entertainment").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "entertainment").locator(".gard-batch-note")).toContainText("1 of 1 approved", { timeout: 30_000 });
  // Another filter: the result was about a view that is gone.
  await page.locator('#gardFilters .gard-filter[data-kind="lint"]').click();
  await expect(page.locator(".gard-card[data-group]")).toHaveCount(1);
  await expect(page.locator(".gard-batch-head[data-batch-section]")).toHaveCount(0);
});

// Fix round 2 batch 1 (batch-3 verify findings 1, 2, 4).
test("a batch takes only the drafts on screen at the click, never one that arrived since", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("u1", "Seen Draft", "claude-code");
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await expect(head(page, "ai").locator('[data-batch-action="approve"]')).toHaveText("Approve all 1 AI draft");
  await seedDraft("u2", "Unseen Draft", "claude-code");
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("1 of 1 approved", { timeout: 30_000 });
  expect(await statusOf("u1")).toBe("applied");
  expect(await statusOf("u2")).toBe("draft");
});

test("a single Approve that lands while the batch re-reads the listing is not posted again", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("r1", "Race One", "claude-code");
  await seedDraft("r2", "Race Two", "claude-code");
  const posts: string[] = [];
  let releaseApprove!: () => void;
  const approveHeld = new Promise<void>((r) => (releaseApprove = r));
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    posts.push(id);
    if (id === ids.r1 && posts.length === 1) await approveHeld;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await page.locator(`.gard-card[data-id="${ids.r1}"] [data-action="approve"]`).click();
  await expect.poll(() => posts.length).toBe(1);
  // The batch's listing re-read is answered while r1 is still a draft, and
  // reaches the page only after r1's approve has landed.
  await page.route("**/api/wiki/proposals?*", async (route) => {
    const stale = await route.fetch();
    const landed = page.waitForResponse((r) => r.url().includes(`/api/wiki/proposals/${ids.r1}/approve`));
    releaseApprove();
    await landed;
    await route.fulfill({ response: stale });
  });
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  const note = head(page, "ai").locator(".gard-batch-note");
  await expect(note).toContainText(/approved/, { timeout: 30_000 });
  await expect(note).not.toContainText("…");
  expect(posts.filter((p) => p === ids.r1)).toHaveLength(1);
  await expect(note).not.toContainText("failed");
  await page.unroute("**/api/wiki/proposals?*");
  await page.unroute("**/api/wiki/proposals/*/approve*");
});

test("the batch shows Stop at once, and Stop during the listing re-read posts nothing", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("p1", "Pending One", "claude-code");
  let releaseList!: () => void;
  const listHeld = new Promise<void>((r) => (releaseList = r));
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await page.route("**/api/wiki/proposals?*", async (route) => {
    await listHeld;
    await route.continue();
  });
  let approves = 0;
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    approves += 1;
    await route.continue();
  });
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await head(page, "ai").locator("[data-batch-stop]").click();
  releaseList();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("Stopped: 0 of 1 approved");
  expect(approves).toBe(0);
  expect(await statusOf("p1")).toBe("draft");
});

test("a page edited after the click's listing drops its update draft from the batch", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  const rel = "sources/Drift Target.mdx";
  const before = page_("Drift Target", "claude-code");
  writeFileSync(path.join(wikiDir, rel), before);
  const [row] = await sql!`
    INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, base_hash, draft, source_docs, status)
    VALUES (${BOT}, 'source:e2e:drift', 'source', 'update', ${rel}, ${createHash("sha256").update(before).digest("hex")},
            ${before + "\nMore.\n"}, ${sql!.json([{ collection: COLLECTION, docId: "e2e-batch/drift.md", title: "Drift Target", url: "" }])}, 'draft')
    RETURNING id`;
  ids.drift = row!.id;
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await expect(head(page, "ai").locator('[data-batch-action="approve"]')).toHaveText("Approve all 1 AI draft");
  writeFileSync(path.join(wikiDir, rel), before + "\nEdited by hand.\n");
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("0 of 0 approved");
  expect(await statusOf("drift")).toBe("draft");
  expect(readFileSync(path.join(wikiDir, rel), "utf8")).toContain("Edited by hand.");
});

// Fix round 2 batch 2 (batch-3 verify finding 3, batch-1 verify finding 1).
test("a card whose single Approve is in flight stays locked through the batch's re-renders", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("h1", "Held One", "claude-code");
  await seedDraft("h2", "Held Two", "claude-code");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    if (route.request().url().includes(ids.h1!)) await held;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const h1 = page.locator(`.gard-card[data-id="${ids.h1}"]`);
  await h1.locator('[data-action="approve"]').click();
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("1 of 1 approved", { timeout: 30_000 });
  await expect(h1.locator('[data-action="approve"]')).toBeDisabled();
  await expect(h1.locator(".gard-outcome")).toHaveText("Applying…");
  release();
  await expect.poll(() => statusOf("h1")).toBe("applied");
  await page.unroute("**/api/wiki/proposals/*/approve*");
});

test("a filter change during a batch drops its result when it ends", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("v1", "View One", "claude-code");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("Approving 1 of 1");
  await page.locator('#gardFilters .gard-filter[data-kind="lint"]').click();
  release();
  await expect.poll(() => statusOf("v1")).toBe("applied");
  await page.waitForTimeout(300);
  await expect(page.locator(".gard-batch-head[data-batch-section]")).toHaveCount(0);
  await page.unroute("**/api/wiki/proposals/*/approve*");
});

// Class check on the gate client's per-card state (round-2 verify findings 1, 2).
test("a single click that fails after a batch re-render unlocks its card and shows the error", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("k1", "Fails Late", "claude-code");
  await seedDraft("k2", "Batch Other", "claude-code");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    if (!route.request().url().includes(ids.k1!)) return route.continue();
    await held;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "boom-409" }) });
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const k1 = page.locator(`.gard-card[data-id="${ids.k1}"]`);
  await k1.locator('[data-action="approve"]').click();
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("1 of 1 approved", { timeout: 30_000 });
  release();
  await expect(k1.locator(".gard-outcome")).toHaveText("boom-409");
  await expect(k1.locator('[data-action="approve"]')).toBeEnabled();
  await page.unroute("**/api/wiki/proposals/*/approve*");
});

test("a twin approved in this tab blocks its pair even when the browser clock runs behind", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("t1", "Clock Twin", "claude-code", "sources/Clock Twin.mdx");
  await seedDraft("t2", "Clock Twin Again", "claude-code", "sources/Clock Twin.mdx");
  // The browser's clock is a day behind the server's.
  await page.addInitScript(() => {
    const shift = -86_400_000;
    const RealDate = Date;
    const now = RealDate.now.bind(RealDate);
    RealDate.now = () => now() + shift;
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await page.locator(`.gard-card[data-id="${ids.t1}"] [data-action="approve"]`).click();
  await expect.poll(() => statusOf("t1")).toBe("applied");
  await expect(page.locator(`.gard-card[data-id="${ids.t1}"] [data-action="approve"]`)).toHaveCount(0);
  // Nothing left to approve: the header offers no Approve all and says why.
  await expect(head(page, "ai").locator('[data-batch-action="approve"]')).toHaveCount(0);
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("1 page written since drafting");
  expect(await statusOf("t2")).toBe("draft");
});

// Three sections and the section chip row.
test("the section chips count each section and show only the chosen one, with its Approve all", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("x1", "Agent Notes", "claude-code");
  await seedDraft("x2", "Agent Notes Two", "claude-code");
  await seedDraft("lf1", "Morning Habits", "focus, health", "life/sources/Morning Habits.mdx");
  await seedDraft("en1", "Series Ranking", "netflix, tv-series", "life/sources/Series Ranking.mdx");
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const chip = (s: string) => page.locator(`#gardFilters .gard-filter[data-section="${s}"]`);
  await expect(page.locator('#gardFilters .gard-filter[data-section=""]')).toHaveText("All sections 4");
  await expect(chip("ai")).toHaveText("AI 2");
  await expect(chip("life")).toHaveText("Life 1");
  await expect(chip("entertainment")).toHaveText("Entertainment 1");
  const order = await page.locator(".gard-batch-head[data-batch-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-batch-section")));
  expect(order).toEqual(["ai", "life", "entertainment"]);
  await expect(head(page, "life")).toContainText("Life");

  await chip("life").click();
  await expect(page.locator(".gard-batch-head[data-batch-section]")).toHaveCount(1);
  await expect(page.locator(".gard-card")).toHaveCount(1);
  await expect(page.locator(`.gard-card[data-id="${ids.lf1}"]`)).toHaveCount(1);
  await head(page, "life").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "life").locator(".gard-batch-note")).toContainText("1 of 1 approved", { timeout: 30_000 });
  expect(await statusOf("lf1")).toBe("applied");
  for (const k of ["x1", "x2", "en1"]) expect(await statusOf(k)).toBe("draft");
  await expect(chip("life")).toHaveText("Life 0");

  await page.locator('#gardFilters .gard-filter[data-section=""]').click();
  await expect(page.locator(`.gard-card[data-id="${ids.x1}"]`)).toHaveCount(1);
});

// Fix round 1 batch 1 (review finding 1).
test("a section chip clicked during a batch keeps the running section's header and Stop", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("rb1", "Running One", "claude-code");
  await seedDraft("rb2", "Running Two", "claude-code");
  await seedDraft("rl1", "Life While Running", "focus", "life/sources/Life While Running.mdx");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/proposals/*/approve*", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await head(page, "ai").locator('[data-batch-action="approve"]').click();
  await expect(head(page, "ai").locator(".gard-batch-note")).toContainText("Approving 1 of 2");
  await page.locator('#gardFilters .gard-filter[data-section="life"]').click();
  await expect(head(page, "ai").locator("[data-batch-stop]")).toHaveCount(1);
  await head(page, "ai").locator("[data-batch-stop]").click();
  release();
  // Stop ended it after the card in flight; the view changed, so the result goes.
  // Exactly one card (the newest, first in list order) went through.
  await expect.poll(async () => [await statusOf("rb1"), await statusOf("rb2")].sort().join()).toBe("applied,draft");
  await expect(head(page, "ai")).toHaveCount(0);
  expect(await statusOf("rl1")).toBe("draft");
  await page.unroute("**/api/wiki/proposals/*/approve*");
});

// Fix round 1 batch 2 (review finding 2): the chip counts follow the status and kind filters.
test("the section chips count what the status and kind filters let through", async ({ page }) => {
  await sql!`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE bot_name = ${BOT} AND status = 'draft'`;
  await seedDraft("cf1", "Count One", "claude-code");
  await seedDraft("cf2", "Count Life", "focus", "life/sources/Count Life.mdx");
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const chip = (s: string) => page.locator(`#gardFilters .gard-filter[data-section="${s}"]`);
  await expect(chip("ai")).toHaveText("AI 1");
  await page.locator('#gardFilters .gard-filter[data-kind="lint"]').click();
  await expect(chip("ai")).toHaveText("AI 0");
  await expect(chip("life")).toHaveText("Life 0");
  await expect(chip("")).toHaveText("All sections 0");
  await page.locator('#gardFilters .gard-filter[data-kind=""]').click();
  await page.locator('#gardFilters .gard-filter[data-status="applied"]').click();
  await expect(chip("life")).toHaveText("Life 0");
});

// Fix round 2 batch 1 (batch-1 verify finding 2): a wiki with no life domain hides the chips.
test("a wiki with no life/ rows hides the section chips and calls its one section Drafts", async ({ page }) => {
  await sql!`
    INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, draft, source_docs, status)
    VALUES (${PLAIN_BOT}, 'source:e2e:plain', 'source', 'create', 'sources/Plain Page.mdx', ${page_("Plain Page", "claude-code")},
            ${sql!.json([{ collection: COLLECTION, docId: "e2e-batch/plain.md", title: "Plain Page", url: "" }])}, 'draft')`;
  await page.goto(`${BASE}/wiki/gardener?bot=${PLAIN_BOT}`);
  await expect(head(page, "ai")).toContainText("Drafts");
  await expect(head(page, "ai").locator('[data-batch-action="approve"]')).toHaveText("Approve all 1 draft");
  for (const s of ["", "ai", "life", "entertainment"]) {
    await expect(page.locator(`#gardFilters .gard-filter[data-section="${s}"]`)).toBeHidden();
  }
  await expect(page.locator('#gardFilters .gard-filter[data-kind="lint"]')).toBeVisible();
  // And on the bot with a life domain they show.
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  await expect(page.locator('#gardFilters .gard-filter[data-section="life"]')).toBeVisible();
});
