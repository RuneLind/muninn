/**
 * Run now on the triage status line (decision-triage visibility PR 3, mimir
 * plans/muninn-decision-triage-visibility.mdx). The refusals, the single-flight
 * and the `/agents` run are unit-tested (`wiki-decision-triage-run.test.ts`,
 * `loop-deps.test.ts`, `loop.test.ts`); what only a real server and page hold:
 * a click runs a real model-off pass, the line updates from the run line it wrote
 * into the temp `DECISION_TRIAGE_DIR`, and `/agents` lists the pass as TRIAGE.
 * The disabled state with the pass off is in `wiki-decision-inbox.spec.ts`.
 *
 * Its own muninn, because the pass is on only with `SCHEDULER_ENABLED=true`. So
 * nothing else in it runs: no bot token (`e2eEnv()`), no stale-confirm wikis, and
 * `HOME` is a temp dir whose work-map state, and the triage dir's state, read a
 * success a minute ago, so neither loop's check is due and no model is called.
 * ENV PREREQUISITE: `bun run db:setup:test`.
 */

import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-decision-run-now");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-run-now";
const PAGE = `---\ntitle: Run now cards\n---\n\n<Question id="O1" choices="A|B">\n\n**Run it?**\n\n**Recommendation: A.** It holds.\n\n</Question>\n`;

let server: ChildProcess | undefined;
const roots: string[] = [];
let triageDir = "";

/** The Your work card, which holds the Decisions section, paints from a work map. */
const mapJson = (runAtMs: number) => JSON.stringify({
  version: 1, wiki: WIKI, runAtMs, model: "test-model",
  coverage: { sessionsSinceMs: runAtMs - 8 * 86_400_000, sessionsAsOfMs: runAtMs, touchWindowDays: 28, activePages: 1, threads: 1, logEntries: 1, logEntriesInWindow: 1, digestChars: 100, metadataFilter: { degraded: false }, warnings: [] },
  summary: "", needsYou: [], themes: [], efforts: [], loose: [],
});
const fresh = (wiki: string) => JSON.stringify({ wiki, lastSuccessAt: Date.now() - 60_000, attempts: [{ at: Date.now() - 60_000, outcome: "ok" }] });

test.beforeAll(async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "muninn-e2e-run-now-"));
  roots.push(tmp);
  const wiki = path.join(tmp, "wiki");
  await mkdir(path.join(wiki, "plans"), { recursive: true });
  await writeFile(path.join(wiki, "plans", "run-now.mdx"), PAGE, "utf8");
  await writeFile(path.join(wiki, ".work-map.json"), mapJson(Date.now() - 60_000), "utf8");
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", ["-C", wiki, ...args], { stdio: "ignore", env });
  const home = path.join(tmp, "home");
  await mkdir(path.join(home, ".muninn", "work-map"), { recursive: true });
  await writeFile(path.join(home, ".muninn", "work-map", `${WIKI}.json`), fresh(WIKI), "utf8");
  triageDir = path.join(tmp, "triage");
  await mkdir(path.join(triageDir, "state"), { recursive: true });
  await writeFile(path.join(triageDir, "state", `${WIKI}.json`), fresh(WIKI), "utf8");
  await mkdir(path.join(tmp, "repos"));
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      HOME: home,
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "true",
      WIKI_STALE_CONFIRM_WIKIS: "",
      WIKI_DIR: "",
      WIKI_EXTRA: `${WIKI}=${wiki}`,
      WORK_MAP_WIKIS: WIKI,
      WIKI_ANSWER_WIKIS: WIKI,
      WIKI_ANSWER_OWNER: "Test Owner (T000001)",
      DECISION_TRIAGE_DIR: triageDir,
      DECISION_TRIAGE_REPO_ROOTS: path.join(tmp, "repos"),
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${WIKI}`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

test("Run now runs a model-off pass, the line updates from its run line, and /agents lists it as TRIAGE", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  const tri = page.locator("#wikiWorkInbox .wiki-wi-tri");
  await expect(tri).toContainText("Triage has not run on this wiki");
  await expect(tri).toContainText("model off");
  const run = tri.locator('[data-wi-act="tri-run"]');
  await expect(run).toHaveText("Run now");
  await expect(run).not.toHaveAttribute("aria-disabled", "true");

  await run.click();
  await expect(tri).toContainText(/Triage checked \d{2}:\d{2} · 1 card · 0 with code facts/);
  await expect(run).toHaveText("Run now");
  await expect(page.locator("[data-wi-run-msg]")).toHaveCount(0);

  const lines = (await readFile(path.join(triageDir, `${WIKI}.jsonl`), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines.map((l) => l.type)).toEqual(["card", "run"]);
  expect(lines[1]).toMatchObject({ wiki: WIKI, model: "none", promptVersion: "off", cards: 1, outcome: "ok" });

  await page.goto(`${BASE}/agents`);
  const row = page.locator(".rf-row", { hasText: `Decision triage: ${WIKI}` });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".kind-chip")).toHaveText("TRIAGE");
  await expect(row).not.toHaveClass(/failed/);
});
