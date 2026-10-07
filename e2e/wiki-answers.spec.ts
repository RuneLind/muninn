/**
 * The answer store's API over HTTP (answer cards PR 2): a real muninn, the real
 * test database, a temp wiki, `MUNINN_AUTH` off.
 *
 * What a unit test cannot show: the route group is registered by the real boot
 * (`createDashboardRoutes` + the global origin and auth middlewares in
 * `src/index.ts`), `WIKI_ANSWER_WIKIS` and `WIKI_ANSWER_OWNER` are read from
 * the process env through `loadConfig`, and the reader renders a card on a
 * wiki outside that list without the answerable flag.
 *
 * Acceptance rows 2, 3 (the API half) and 5: an answer's author is the owner
 * even when the body names someone else, a second boot with no owner refuses
 * the write, an edit is version 2 of one answer, and an unknown page, an
 * unknown question, a closed question and a choice outside the set are all
 * refused.
 *
 * Two muninns (an owner, no owner) over the same temp wikis; rows are deleted
 * by wiki name before and after. ENV PREREQUISITE: `bun run db:setup:test`.
 * No model calls.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-answers");
const NO_OWNER_PORT = e2ePort("wiki-answers/no-owner");
const BASE = `http://127.0.0.1:${PORT}`;
const NO_OWNER_BASE = `http://127.0.0.1:${NO_OWNER_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-answers";
const READONLY_WIKI = "e2e-answers-readonly";
const REL = "plans/questions.mdx";
// Synthetic throughout: invented names, ids and wording.
const OWNER = "Rune Owner (e2e)";

const PAGE = [
  "---",
  "title: Answer page",
  "type: plan",
  "---",
  "",
  "# Answer page",
  "",
  '<Question id="O1" choices="A|B">',
  "",
  "**Keep the export block in Norwegian?**",
  "",
  "</Question>",
  "",
  '<Question id="O2">',
  "",
  "Already decided?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **D99** — The page's language.",
  "- **O1** — Export block language?",
  "- **O2** — Decided? Closed 2026-10-08 (D99).",
  "",
  "</DecisionLog>",
  "",
].join("\n");

const servers: ChildProcess[] = [];
let base = "";
let sql: postgres.Sql | undefined;

async function boot(port: number, owner: string): Promise<void> {
  const server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${path.join(base, "a")},${READONLY_WIKI}=${path.join(base, "b")}`,
      WIKI_ANSWER_WIKIS: WIKI,
      // "" beats a dotenv line; e2eEnv() already blanks both, this states it.
      WIKI_ANSWER_OWNER: owner,
    },
    stdio: "ignore",
  });
  servers.push(server);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/wiki/pages?wiki=${WIKI}`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + port);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const deleteRows = async () => {
  await sql!`DELETE FROM wiki_answers WHERE wiki IN (${WIKI}, ${READONLY_WIKI})`;
};

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  // Migration 082 (idempotent), so a test database built before it still runs this file.
  await sql.unsafe(readFileSync(path.join(REPO_ROOT, "db/migrations/082-wiki-answers.sql"), "utf8"));
  await deleteRows();
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answers-"));
  for (const dir of ["a", "b"]) {
    await mkdir(path.join(base, dir, "plans"), { recursive: true });
    await writeFile(path.join(base, dir, REL), PAGE, "utf8");
  }
  await Promise.all([boot(PORT, OWNER), boot(NO_OWNER_PORT, "")]);
});

test.afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  if (sql) await deleteRows();
  await sql?.end();
  if (base) await rm(base, { recursive: true, force: true });
});

const answer = (over: Record<string, unknown> = {}) => ({
  wiki: WIKI,
  relPath: REL,
  questionId: "O1",
  choice: "B",
  body: "The page's language, says Mallory.",
  ...over,
});

test.describe("Answer store API (MUNINN_AUTH=off)", () => {
  test("the author is the owner even when the body names someone else; an edit is version 2 of one answer", async ({ request }) => {
    const created = await request.post(`${BASE}/api/wiki/answers`, {
      data: answer({ authorName: "Mallory", author: { name: "Mallory", userId: "u-mallory" } }),
    });
    expect(created.status()).toBe(201);
    const saved = await created.json();
    expect(saved.authorName).toBe(OWNER);

    const edited = await request.post(`${BASE}/api/wiki/answers`, {
      data: answer({ body: "Edited: the page's language.", answerId: saved.answerId }),
    });
    expect(edited.status()).toBe(200);
    expect((await edited.json()).version).toBe(2);

    const list = await request.get(`${BASE}/api/wiki/answers?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}&versions=1`);
    expect(list.status()).toBe(200);
    const { answerable, answers } = await list.json();
    expect(answerable).toBe(true);
    const mine = answers.filter((a: { answerId: string }) => a.answerId === saved.answerId);
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({
      version: 2,
      versionCount: 2,
      authorName: OWNER,
      body: "Edited: the page's language.",
      choice: "B",
      exported: false,
      mine: true,
    });
    expect(mine[0].earlier.map((v: { version: number }) => v.version)).toEqual([1]);

    const rows = await sql!`SELECT version, author_name, author_user_id FROM wiki_answers WHERE answer_id = ${saved.answerId} ORDER BY version`;
    expect(rows.map((r) => [r.version, r.author_name, r.author_user_id])).toEqual([
      [1, OWNER, null],
      [2, OWNER, null],
    ]);
  });

  test("an instance with no WIKI_ANSWER_OWNER refuses the write", async ({ request }) => {
    const res = await request.post(`${NO_OWNER_BASE}/api/wiki/answers`, { data: answer() });
    expect(res.status()).toBe(503);
    expect((await res.json()).code).toBe("owner_unset");
  });

  test("an unknown page, an unknown question, a closed question and a choice outside the set are refused", async ({ request }) => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ relPath: "plans/nope.mdx" }, 404, "no_page"],
      [{ questionId: "O9" }, 404, "unknown_question"],
      [{ questionId: "O2", choice: null }, 409, "question_closed"],
      [{ choice: "C" }, 400, "bad_choice"],
    ];
    const got: string[] = [];
    for (const [over] of cases) {
      const res = await request.post(`${BASE}/api/wiki/answers`, { data: answer(over) });
      got.push(`${res.status()} ${(await res.json()).code}`);
    }
    expect(got).toEqual(cases.map(([, s, c]) => `${s} ${c}`));
  });

  test("a wiki missing from WIKI_ANSWER_WIKIS refuses the POST and renders the card read-only", async ({ request, page }) => {
    const res = await request.post(`${BASE}/api/wiki/answers`, { data: answer({ wiki: READONLY_WIKI }) });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("not_answerable");

    const ro = await (await request.get(`${BASE}/api/wiki/page?wiki=${READONLY_WIKI}&relPath=${encodeURIComponent(REL)}`)).json();
    expect(ro.answers).toBeUndefined();
    const rw = await (await request.get(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`)).json();
    expect(rw.answers).toEqual({ answerable: true, canExport: true, owner: OWNER });

    await page.goto(`${BASE}/wiki?wiki=${READONLY_WIKI}&relPath=${encodeURIComponent(REL)}`);
    const card = page.locator(".wiki-article section.question").first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-wiki-answerable", "false");
    await expect(card.locator(".q-for")).toHaveCount(0);

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    const live = page.locator(".wiki-article section.question").first();
    await expect(live).toHaveAttribute("data-wiki-answerable", "true");
    await expect(live.locator(".q-for")).toHaveText(`For ${OWNER}`);
  });
});
