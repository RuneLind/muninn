/**
 * `/wiki/gardener` — the "drafted before fact-check" flag (mimir
 * `plans/muninn-summary-factcheck.mdx`, PR 3).
 *
 * What no unit test reaches: the listing payload carrying `factcheck` from the
 * real `summary_factchecks` table to the card, the card disabling ONLY that
 * draft's Approve, the Redraft button reaching the real route, and a failed
 * Redraft leaving both the draft and the disabled Approve as they were.
 *
 * A throwaway bot under `MUNINN_BOTS_DIR` owns a temp wiki; the rows go into the
 * test database. Huginn is a dead port, so Redraft's doc fetch fails before any
 * model call — the model-failure outcome, end to end.
 *
 * Playwright runs this file under NODE — hence `postgres`, not `Bun.sql`.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("gardener-factcheck-flag");
const DEAD_HUGINN = `http://127.0.0.1:${e2ePort("gardener-factcheck-flag/dead-huginn")}`;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2efcflag";
const COLLECTION = "tiktok-summaries";
const DOC_BAD = "health/e2e-fcflag-bad.md";
const DOC_OK = "health/e2e-fcflag-ok.md";
const DOC_UNCHECKED = "health/e2e-fcflag-unchecked.md";

let server: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let tmpRoot = "";
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

function page(title: string): string {
  return `---\ntype: source\ntitle: ${title}\naliases: []\ncreated: 2026-10-05\nupdated: 2026-10-05\ntags: []\nurl: https://www.tiktok.com/@e2e/video/${title.length}\nsources: [https://www.tiktok.com/@e2e/video/${title.length}]\n---\n\n# ${title}\n\nBody.\n`;
}

async function seedDraft(key: string, docId: string, title: string): Promise<void> {
  const [row] = await sql!`
    INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, draft, source_docs, status, created_at)
    VALUES (${BOT}, ${`source:${COLLECTION}:${docId}`}, 'source', 'create', ${`life/sources/${title}.mdx`},
            ${page(title)}, ${sql!.json([{ collection: COLLECTION, docId, title, url: "https://www.tiktok.com/@e2e/video/1" }])},
            'draft', now() - interval '1 day')
    RETURNING id`;
  ids[key] = row!.id;
}

async function seedCheck(docId: string, verdicts: string[]): Promise<void> {
  const claims = verdicts.map((verdict, i) => ({ index: i + 1, title: `claim ${i + 1}`, verdict, outcome: "verified", sources: [] }));
  const answer = verdicts.map((v, i) => `### ${v} Claim ${i + 1}/${verdicts.length} — claim ${i + 1}\n\nEvidence.`).join("\n\n");
  await sql!`
    INSERT INTO summary_factchecks (collection, doc_id, url, body_sha256, answer, claims, bot_name, created_at)
    VALUES (${COLLECTION}, ${docId}, null, ${"a".repeat(64)}, ${answer}, ${sql!.json(claims)}, 'jarvis', now())`;
}

async function cleanRows(): Promise<void> {
  await sql!`DELETE FROM wiki_proposals WHERE bot_name = ${BOT}`;
  await sql!`DELETE FROM summary_factchecks WHERE collection = ${COLLECTION} AND doc_id IN (${DOC_BAD}, ${DOC_OK}, ${DOC_UNCHECKED})`;
}

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "e2e-fcflag-"));
  const botDir = path.join(tmpRoot, "bots", BOT);
  const wikiDir = path.join(tmpRoot, "wiki");
  mkdirSync(botDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(path.join(wikiDir, "index.md"), "# Index\n");
  writeFileSync(path.join(botDir, "CLAUDE.md"), "# throwaway e2e bot\n");
  writeFileSync(path.join(botDir, "config.json"), JSON.stringify({ wikiDir }));

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await cleanRows();
  await seedDraft("bad", DOC_BAD, "Checked With Errors");
  await seedDraft("ok", DOC_OK, "Checked All Fine");
  await seedDraft("unchecked", DOC_UNCHECKED, "Never Checked");
  await seedCheck(DOC_BAD, ["❌", "⚠️", "✅"]);
  await seedCheck(DOC_OK, ["✅", "❓"]);

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
    if (sql) await cleanRows();
  } finally {
    await sql?.end();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const card = (p: import("@playwright/test").Page, key: string) => p.locator(`.gard-card[data-id="${ids[key]}"]`);

test("a draft made before a ❌/⚠️ check is flagged, its Approve disabled, Redraft offered", async ({ page }) => {
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
  const bad = card(page, "bad");
  await expect(bad.locator('.gard-fc-note[data-fc="drafted-before"]')).toContainText("Drafted before fact-check (");
  await expect(bad.locator('.gard-fc-note[data-fc="drafted-before"]')).toContainText("1 ❌, 1 ⚠️");
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
  expect(count!.n).toBe(3);
});

test("Redraft takes application/json, like every gate write", async () => {
  const res = await fetch(`${BASE}/api/wiki/proposals/${ids.bad}/redraft`, { method: "POST" });
  expect(res.status).toBe(415);
});
