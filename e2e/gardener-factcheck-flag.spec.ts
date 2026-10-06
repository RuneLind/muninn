/**
 * `/wiki/gardener` — the "needs a redraft" fact-check flag (mimir
 * `plans/muninn-summary-factcheck.mdx`, PR 3).
 *
 * What no unit test reaches: the listing payload carrying `factcheck` from the
 * real `summary_factchecks` table to the card, the card disabling ONLY a locked
 * draft's Approve, the Redraft button reaching the real route, a failed Redraft
 * leaving the draft as it was, a successful one replacing it (the old card says
 * so, the new card is unlocked), and the client keeping its own Redraft state
 * across the re-renders the page does on its own.
 *
 * A throwaway bot under `MUNINN_BOTS_DIR` owns a temp wiki; the rows go into the
 * test database. One in-process `node:http` server plays huginn (the redraft's
 * doc fetch) AND the bot's `openai-compat` model, so the successful Redraft runs
 * the real drafter end to end with a canned page. The doc the failing case
 * redrafts answers 500, which is the doc-fetch error outcome.
 *
 * Playwright runs this file under NODE — hence `postgres`, not `Bun.sql`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("gardener-factcheck-flag");
const FAKE_PORT = e2ePort("gardener-factcheck-flag/fake");
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2efcflag";
const COLLECTION = "tiktok-summaries";
const DOC_BAD = "health/e2e-fcflag-bad.md";
const DOC_OK = "health/e2e-fcflag-ok.md";
const DOC_UNCHECKED = "health/e2e-fcflag-unchecked.md";
const DOC_NEWER = "health/e2e-fcflag-newer.md";
const DOC_APPROVED = "health/e2e-fcflag-approved.md";
const DOC_GOOD = "health/e2e-fcflag-good.md";
const ALL_DOCS = [DOC_BAD, DOC_OK, DOC_UNCHECKED, DOC_NEWER, DOC_APPROVED, DOC_GOOD];
const videoUrl = (n: number) => `https://www.tiktok.com/@e2e/video/${7000 + n}`;
const GOOD_URL = videoUrl(6);
const GOOD_BODY =
  "The creator says five words said each morning raise cortisol and wake you up. It takes 21 days to form a habit, so repeat them for three weeks. The video frames this as rewiring the mind and asks viewers to commit to the practice every day, ideally before checking a phone. It closes by asking viewers to share the list with a friend, and repeats that the words work best when said out loud in the same order every morning.";

let server: ChildProcess | undefined;
let fake: Server | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let tmpRoot = "";
let modelCalls = 0;
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

function page(title: string, url: string, body = "Body."): string {
  return `---\ntype: source\ntitle: ${title}\naliases: []\ncreated: 2026-10-05\nupdated: 2026-10-05\ntags: []\nurl: ${url}\nsources: [${url}]\n---\n\n# ${title}\n\n${body}\n`;
}

async function seedDraft(
  key: string,
  docId: string,
  title: string,
  url: string,
  opts: { status?: string; age?: string } = {},
): Promise<void> {
  const [row] = await sql!`
    INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, draft, source_docs, status, created_at)
    VALUES (${BOT}, ${`source:${COLLECTION}:${docId}`}, 'source', 'create', ${`life/sources/${title}.mdx`},
            ${page(title, url)}, ${sql!.json([{ collection: COLLECTION, docId, title, url }])},
            ${opts.status ?? "draft"}, now() - ${opts.age ?? "1 day"}::interval)
    RETURNING id`;
  ids[key] = row!.id;
}

async function seedCheck(docId: string, verdicts: string[], age = "0 seconds"): Promise<void> {
  const claims = verdicts.map((verdict, i) => ({ index: i + 1, title: `claim ${i + 1}`, verdict, outcome: "verified", sources: [] }));
  const answer = verdicts.map((v, i) => `### ${v} Claim ${i + 1}/${verdicts.length} — claim ${i + 1}\n\nEvidence.`).join("\n\n");
  await sql!`
    INSERT INTO summary_factchecks (collection, doc_id, url, body_sha256, answer, claims, bot_name, created_at)
    VALUES (${COLLECTION}, ${docId}, null, ${"a".repeat(64)}, ${answer}, ${sql!.json(claims)}, 'jarvis', now() - ${age}::interval)`;
}

async function cleanRows(): Promise<void> {
  await sql!`DELETE FROM wiki_proposals WHERE bot_name = ${BOT}`;
  await sql!`DELETE FROM source_draft_attempts WHERE bot_name = ${BOT}`;
  await sql!`DELETE FROM summary_factchecks WHERE collection = ${COLLECTION} AND doc_id IN ${sql!(ALL_DOCS)}`;
}

/** The canned drafter reply: an OpenAI-compatible stream carrying one page. */
function writeCompletion(res: ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${JSON.stringify({ model: "e2e-fake", choices: [{ index: 0, delta: { content } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startFake(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p === "/v1/chat/completions") {
      modelCalls += 1;
      req.resume();
      // The old draft's title: Redraft pins it as the title override.
      return writeCompletion(res, page("Redraft Me", GOOD_URL, "The video claims the words raise cortisol; sources say they lower it."));
    }
    const m = /^\/api\/document\/([^/]+)\/(.+)$/.exec(p);
    if (m && m[1] === COLLECTION && m[2] === DOC_GOOD) {
      if (url.searchParams.get("raw") === "1") return json({ detail: "not found" }, 404);
      return json({ id: DOC_GOOD, text: GOOD_BODY, metadata: { url: GOOD_URL } });
    }
    if (m) return json({ detail: "huginn is failing on purpose" }, 500);
    return json({ status: "ok" });
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "e2e-fcflag-"));
  const botDir = path.join(tmpRoot, "bots", BOT);
  const wikiDir = path.join(tmpRoot, "wiki");
  mkdirSync(botDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(path.join(wikiDir, "index.md"), "# Index\n");
  writeFileSync(path.join(botDir, "CLAUDE.md"), "# throwaway e2e bot\n");
  writeFileSync(
    path.join(botDir, "config.json"),
    JSON.stringify({ wikiDir, connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1` }),
  );

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await cleanRows();
  await seedDraft("bad", DOC_BAD, "Checked With Errors", videoUrl(1));
  await seedDraft("ok", DOC_OK, "Checked All Fine", videoUrl(2));
  await seedDraft("unchecked", DOC_UNCHECKED, "Never Checked", videoUrl(3));
  // Item 1: drafted AFTER the check was saved, yet built without it.
  await seedDraft("newer", DOC_NEWER, "Drafted During The Check", videoUrl(4), { age: "0 seconds" });
  await seedDraft("approved", DOC_APPROVED, "Approved Mid Apply", videoUrl(5), { status: "approved" });
  await seedDraft("good", DOC_GOOD, "Redraft Me", GOOD_URL);
  await seedCheck(DOC_BAD, ["❌", "⚠️", "✅"]);
  await seedCheck(DOC_OK, ["✅", "❓"]);
  await seedCheck(DOC_NEWER, ["❌"], "1 hour");
  await seedCheck(DOC_APPROVED, ["❌"]);
  await seedCheck(DOC_GOOD, ["❌", "✅"]);

  fake = await startFake();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      MUNINN_BOTS_DIR: path.join(tmpRoot, "bots"),
      KNOWLEDGE_API_URL: FAKE,
      SCHEDULER_ENABLED: "false",
      LOG_DIR: "none",
      [`TELEGRAM_BOT_TOKEN_${BOT.toUpperCase()}`]: "",
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
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
  try {
    if (sql) await cleanRows();
  } finally {
    await sql?.end();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const card = (p: Page, key: string) => p.locator(`.gard-card[data-id="${ids[key]}"]`);
const SEEDED = 6;

test("a draft made before a ❌/⚠️ check is flagged, its Approve disabled, Redraft offered", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const bad = card(page, "bad");
  const note = bad.locator('.gard-fc-note[data-fc="needs-redraft"]');
  await expect(note).toContainText("Drafted without the current fact-check (");
  await expect(note).toContainText("1 ❌, 1 ⚠️");
  await expect(bad.locator('[data-action="approve"]')).toBeDisabled();
  await expect(bad.locator('[data-action="redraft"]')).toBeEnabled();
  await expect(bad.locator('[data-action="reject"]')).toBeEnabled();

  // A ✅/❓-only check flags nothing, and an unchecked doc is untouched.
  for (const key of ["ok", "unchecked"]) {
    await expect(card(page, key).locator(".gard-fc-note")).toHaveCount(0);
    await expect(card(page, key).locator('[data-action="approve"]')).toBeEnabled();
    await expect(card(page, key).locator('[data-action="redraft"]')).toHaveCount(0);
  }
});

// Item 1: the drafter read "no check", the check was saved during its model
// call, and the row landed after the check. A timestamp cannot tell that
// apart from a draft that carries the check; the row's recorded digest can.
test("a draft NEWER than its check that does not carry it is locked too", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const newer = card(page, "newer");
  await expect(newer.locator('[data-action="approve"]')).toBeDisabled();
  await expect(newer.locator('.gard-fc-note[data-fc="needs-redraft"]')).toContainText("1 ❌");
  await expect(newer.locator('[data-action="redraft"]')).toBeEnabled();
});

test("a Redraft that fails leaves the draft and the disabled Approve as they were", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const bad = card(page, "bad");
  const answer = page.waitForResponse((r) => r.url().includes(`/api/wiki/proposals/${ids.bad}/redraft`));
  await bad.locator('[data-action="redraft"]').click();
  const res = await answer;
  expect(res.status()).toBe(500);
  expect((await res.json()).outcome).toBe("error");
  await expect(bad.locator(".gard-outcome.err")).toContainText("failed");
  await expect(bad.locator('[data-action="approve"]')).toBeDisabled();
  await expect(bad.locator('[data-action="redraft"]')).toBeEnabled();
  const [row] = await sql!`SELECT status FROM wiki_proposals WHERE id = ${ids.bad!}`;
  expect(row!.status).toBe("draft");
  const [count] = await sql!`SELECT count(*)::int AS n FROM wiki_proposals WHERE bot_name = ${BOT}`;
  expect(count!.n).toBe(SEEDED);
  expect(modelCalls).toBe(0);
});

test("Redraft takes application/json, like every gate write", async () => {
  const res = await fetch(`${BASE}/api/wiki/proposals/${ids.bad}/redraft`, { method: "POST" });
  expect(res.status).toBe(415);
});

// Item 10: the client's own answers to a Redraft, each stubbed at the network
// boundary so only the page's handling is under test.
test.describe("the card's handling of each Redraft answer", () => {
  const stubRedraft = async (p: Page, reply: () => Promise<{ status: number; body: string; contentType: string }>) => {
    await p.route(`**/api/wiki/proposals/${ids.bad}/redraft**`, async (route) => {
      const r = await reply();
      await route.fulfill({ status: r.status, body: r.body, contentType: r.contentType });
    });
  };

  test("superseded_meanwhile: the message survives the reload it triggers", async ({ page }) => {
    await stubRedraft(page, async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "superseded_meanwhile", reason: "x" }) }));
    await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
    // Mark the card element, so the assertion runs on the one the reload renders.
    await card(page, "bad").evaluate((el) => el.setAttribute("data-e2e-before", ""));
    await card(page, "bad").locator('[data-action="redraft"]').click();
    await expect(page.locator(".gard-card[data-e2e-before]")).toHaveCount(0);
    await expect(card(page, "bad")).toContainText("This draft changed meanwhile; nothing was replaced.");
  });

  test("in flight: a re-render keeps Redraft, Reject and Approve disabled", async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await stubRedraft(page, async () => {
      await held;
      return { status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "skipped", reason: "stub" }) };
    });
    await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
    const bad = card(page, "bad");
    await bad.locator('[data-action="redraft"]').click();
    await expect(bad.locator('[data-action="redraft"]')).toBeDisabled();
    // Any re-render — here the status filter — rebuilds every card.
    await page.locator('#gardFilters .gard-filter[data-status=""]').click();
    await expect(card(page, "bad").locator('[data-action="redraft"]')).toBeDisabled();
    await expect(card(page, "bad").locator('[data-action="reject"]')).toBeDisabled();
    await expect(card(page, "bad").locator('[data-action="approve"]')).toBeDisabled();
    await expect(card(page, "bad").locator(".gard-outcome")).toContainText("Redrafting…");
    release();
    await expect(card(page, "bad").locator(".gard-outcome.err")).toContainText("Not redrafted (skipped): stub");
    await expect(card(page, "bad").locator('[data-action="redraft"]')).toBeEnabled();
    await expect(card(page, "bad").locator('[data-action="approve"]')).toBeDisabled();
  });

  test("a non-JSON error body names the status, not a parse error", async ({ page }) => {
    await stubRedraft(page, async () => ({ status: 502, contentType: "text/html", body: "<html><body>Bad Gateway</body></html>" }));
    await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
    await card(page, "bad").locator('[data-action="redraft"]').click();
    const out = card(page, "bad").locator(".gard-outcome.err");
    await expect(out).toContainText("Failed (502)");
    await expect(out).not.toContainText("Unexpected token");
    await expect(out).not.toContainText("Network error");
  });

  test("covered reloads the list", async ({ page }) => {
    await stubRedraft(page, async () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "covered", reason: "a live source proposal already covers this url" }) }));
    await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
    await card(page, "bad").evaluate((el) => el.setAttribute("data-e2e-before", ""));
    await card(page, "bad").locator('[data-action="redraft"]').click();
    // The list was fetched and rendered again: the marked element is gone.
    await expect(page.locator(".gard-card[data-e2e-before]")).toHaveCount(0);
    await expect(card(page, "bad")).toContainText("Not redrafted (covered)");
  });
});

// Item 15: the info note is 12.5px text, so AA is 4.5:1 in both themes — and
// its colour is the token, resolved on a body probe, not a literal.
test("the at-apply info note clears AA in both themes", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
    const note = card(page, "approved").locator('.gard-fc-note.info[data-fc="missing-block"]');
    await expect(note).toBeVisible();
    expect(await paintedContrast(note), `${scheme} info note`).toBeGreaterThanOrEqual(4.5);
    const token = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-soft)";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(await note.evaluate((el) => getComputedStyle(el).color)).toBe(token);
  }
});

// Items 9 and 19: a successful Redraft through the real route, the real drafter
// and the canned model page. The old card says it was replaced (not "target
// changed"), and the new card carries the check, so nothing locks it.
test("a successful Redraft replaces the card: the old one says so, the new one is unlocked", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const answer = page.waitForResponse((r) => r.url().includes(`/api/wiki/proposals/${ids.good}/redraft`));
  await card(page, "good").locator('[data-action="redraft"]').click();
  const res = await answer;
  const body = await res.json();
  expect(res.status(), JSON.stringify(body)).toBe(200);
  expect(body.outcome, JSON.stringify(body)).toBe("drafted");
  expect(modelCalls).toBe(1);
  ids.goodNew = body.proposalId;

  const old = card(page, "good");
  await expect(old.locator(".gard-badge.chip-stale")).toBeVisible();
  await expect(old.locator(".gard-stale-note")).toContainText("Replaced by a redraft");
  await expect(old.locator(".gard-stale-note")).not.toContainText("Target changed");
  const fresh = card(page, "goodNew");
  await expect(fresh.locator('[data-action="approve"]')).toBeEnabled();
  await expect(fresh.locator(".gard-fc-note")).toHaveCount(0);
  await expect(fresh.locator('[data-action="redraft"]')).toHaveCount(0);
  const [row] = await sql!`SELECT draft, status FROM wiki_proposals WHERE id = ${body.proposalId}`;
  expect(row!.status).toBe("draft");
  expect(row!.draft).toContain("<!-- factcheck:start -->");
});
