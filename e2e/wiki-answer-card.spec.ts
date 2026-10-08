/**
 * The answer card's client (answer cards PR 3) in the /wiki reader: a real
 * muninn, the real test database, `MUNINN_AUTH` off with `WIKI_ANSWER_OWNER`
 * set, and three temp wikis — two in `WIKI_ANSWER_WIKIS` (English, Norwegian)
 * and one outside it.
 *
 * What a unit test cannot show: the reader bundle hydrates the server-rendered
 * card from `/api/wiki/page`'s `answers` flag, the composer posts to the real
 * route and the card repaints from the real GET (owner name, the server's
 * `asked`, `edited N×`, the log fold), a double-click stores one answer, a
 * second browser's edit turns a stale edit into the conflict message, a closed
 * card offers no composer while a reopened one takes an answer, and a wiki
 * outside the list never fetches answers at all. Plus token + 4.5:1 in both
 * themes for the new text-on-tint pairs, and the 390px focus layout. And
 * `WIKI_ANSWER_GROUPS`: a `to="fag"` card names the group, a member's answer
 * (seeded with its NAV ident, since auth off has one author) is asked and
 * carries the group chip, a non-member's is not asked.
 *
 * Synthetic fixtures only. Rows are deleted by wiki name before and after.
 * ENV PREREQUISITE: `bun run db:setup:test`. No model calls.
 */

import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-answer-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-answer-card";
const WIKI_NO = "e2e-answer-card-no";
const WIKI_RO = "e2e-answer-card-ro";
const REL = "plans/card.mdx";
const STYLE_REL = "plans/style.mdx";
const FIX_REL = "plans/fix.mdx";
// Synthetic throughout: invented names, ids and wording.
const OWNER = "Rune Owner";

const q = (id: string, text: string, attrs = "") => [`<Question id="${id}"${attrs}>`, "", `**${text}**`, "", "</Question>", ""];

const PAGE = [
  "---",
  "title: Card page",
  "type: plan",
  "---",
  "",
  "# Card page",
  "",
  ...q("O1", "Keep the export block in one language?", ' choices="A|B"'),
  ...q("O2", "Was the old flag dropped?"),
  ...q("O3", "Was the reopened one settled?"),
  ...q("O4", "Double-click safe?"),
  ...q("O5", "Who edits last?"),
  "<DecisionLog>",
  "",
  "- **D99** — The page's language.",
  "- **O1** — Export block language?",
  "- **O2** — Old flag? Closed 2026-10-08 (D99).",
  "- **O3** — Settled? Closed 2026-10-08 (D99). Reopened 2026-10-09.",
  "- **O4** — Double-click?",
  "- **O5** — Edits?",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// Every new text-on-tint pair on one screen: an answered card with a choice,
// an edit and its log (C1), an answer from someone the page did not ask (C4),
// a closed card holding an uncopied answer (C2) and an empty composer (C3).
const STYLE_PAGE = [
  "---",
  "title: Style page",
  "type: plan",
  "---",
  "",
  ...q("C1", "Answered and edited?", ' choices="A|B"'),
  ...q("C2", "Closed with a new answer?"),
  ...q("C3", "Still open?", ' choices="A|B"'),
  ...q("C4", "Asked someone else?", ' to="Kari Nordmann (X222222)"'),
  "<DecisionLog>",
  "",
  "- **D99** — Done.",
  "- **C1** — One.",
  "- **C2** — Two. Closed 2026-10-08 (D99).",
  "- **C3** — Three.",
  "- **C4** — Four.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

const PAGE_NO = [
  "---",
  "title: Kortside",
  "type: plan",
  'questions_to: ["Kari Nordmann (X222222)"]',
  "---",
  "",
  ...q("O1", "Skal blokken være på norsk?", ' choices="A|B"'),
  "<DecisionLog>",
  "",
  "- **O1** — Språk?",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// Fix round 1: one question per case, so no case reads another's answers.
// F7's stored choice is one the page no longer offers.
const FIX_PAGE = [
  "---",
  "title: Fix page",
  "type: plan",
  "---",
  "",
  ...q("F1", "Edited from a stale version?", ' choices="A|B"'),
  ...q("F2", "Saved to trigger a reload?"),
  ...q("F3", "First of two saves?"),
  ...q("F4", "Second of two saves?"),
  ...q("F5", "Saved while the reload fails?"),
  ...q("F6", "Where does focus go?"),
  ...q("F7", "A renamed choice?", ' choices="X|Y"'),
  ...q("F8", "Log fold kept open?"),
  ...q("F9", "Typing elsewhere?"),
  ...q("F10", "Saved while typing elsewhere?"),
  ...q("F11", "Someone else's answer?"),
  ...q("F12", "Submitted twice?"),
  ...q("F13", "Changed while focused?"),
  ...q("F14", "Saved while another card holds focus?"),
  // Fix round 2.
  ...q("F15", "A conflict whose reload fails?"),
  ...q("F16", "Focus on [a link](#f16-target) in the question?"),
  ...q("F17", "A reload that says answerable false?"),
  ...q("F18", "Saved to reload another card?"),
].join("\n");

// Fix round 3: where focus goes across a repaint, one question per cell of the
// table in the "answer card focus" describe. Odd ids are the card under test,
// the even id after each is the card whose save reloads the answers.
const FOCUS_REL = "plans/focus.mdx";
const FOCUS_PAGE = [
  "---",
  "title: Focus page",
  "type: plan",
  "---",
  "",
  ...q("G1", "Repainted while nothing has focus?"),
  ...q("G2", "Saved to reload G1?"),
  ...q("G3", "Repainted while the search box has focus?"),
  ...q("G4", "Saved to reload G3?"),
  ...q("G5", "Repainted while its id link has focus?"),
  ...q("G6", "Saved to reload G5?"),
  ...q("G7", "Decided, repainted while its decision link has focus?"),
  ...q("G8", "Saved to reload G7?"),
  ...q("G9", "Edit gone after a repaint?"),
  ...q("G10", "Saved to reload G9?"),
  ...q("G11", "New-answer composer kept across a repaint?", ' choices="A|B"'),
  ...q("G12", "Saved to reload G11?"),
  ...q("G13", "New-answer composer gone after a repaint?"),
  ...q("G14", "Saved to reload G13?"),
  ...q("G15", "Load again gone once it worked?"),
  ...q("G16", "Edit form kept across repaints?", ' choices="A|B"'),
  ...q("G17", "Saved again and again to reload G16?"),
  ...q("G18", "Edit form gone after a repaint?"),
  ...q("G19", "Saved to reload G18?"),
  ...q("G20", "An edit save refused?"),
  ...q("G21", "An edit save that works?"),
  ...q("G22", "A conflict whose reload says answerable false?"),
  "<DecisionLog>",
  "",
  "- **D99** — Done.",
  "- **G5** — Still open.",
  "- **G7** — Decided. Closed 2026-10-08 (D99).",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// PR 5 fix round 1: the admin Redact control (auth off is admin). One
// question per case; R8 is the card whose save reloads the others.
const REDACT_REL = "plans/redact.mdx";
const REDACT_PAGE = [
  "---",
  "title: Redact page",
  "type: plan",
  "---",
  "",
  ...q("R1", "Escape out of the confirm?"),
  ...q("R2", "Redacted elsewhere while the confirm is open?"),
  ...q("R3", "A redact the server refuses?"),
  ...q("R4", "A redact that works?"),
  ...q("R5", "A redact whose reload fails?"),
  ...q("R7", "Redact beside an open editor?"),
  ...q("R8", "Saved to reload R2?"),
  ...q("R9", "The confirm's look?"),
  // Fix round 2.
  ...q("R10", "A redact that answers 404?"),
  ...q("R11", "Edit while a redact is out?"),
  ...q("R12", "An editor open on an answer redacted elsewhere?"),
  ...q("R13", "Saved to reload R12?"),
  ...q("R14", "Escape out of the confirm in focus mode?"),
].join("\n");

// PR 5b fix round 1: an answer the retention sweep deletes while it is being
// edited. S4 is the card whose save reloads S3's answers.
const SWEEP_REL = "plans/sweep.mdx";
const SWEEP_PAGE = [
  "---",
  "title: Sweep page",
  "type: plan",
  "---",
  "",
  ...q("S1", "Swept between Edit and Save?", ' choices="A|B"'),
  ...q("S3", "Swept while its editor is open, seen on a reload?"),
  ...q("S4", "Saved to reload S3?"),
  // Fix round 2: two answers of the viewer's own (auth off: every answer is
  // the viewer's), one swept under its editor; and a sweep seen mid-save.
  ...q("S5", "Swept while the viewer has another answer here?"),
  ...q("S6", "Swept while its save is out, seen on another card's reload?"),
  ...q("S7", "Saved to reload S6 mid-save?"),
  ...q("S8", "A carried draft cancelled?"),
].join("\n");

// A save the server refuses for good: the answer was redacted, or the
// question closed, after the card was loaded. T2 is closed by rewriting this
// page mid-test, so its own file keeps the rewrite away from other cases.
const TERMINAL_REL = "plans/terminal.mdx";
const terminalPage = (closed: boolean) =>
  [
    "---",
    "title: Terminal page",
    "type: plan",
    "---",
    "",
    ...q("T1", "Redacted while its editor is open?"),
    ...q("T2", "Closed while its answer is being written?"),
    ...q("T3", "Redacted under its editor, and the reload fails?"),
    ...(closed ? ["<DecisionLog>", "", "- **T2** — Closed mid-write. Closed 2026-10-08 (D98).", "", "</DecisionLog>", ""] : []),
  ].join("\n");

// WIKI_ANSWER_GROUPS: synthetic groups and idents (Z99xxxx). The answers are
// seeded by SQL with an author ident — auth off has only the owner, no ident.
const GROUPS_REL = "plans/groups.mdx";
const GROUPS_PAGE = [
  "---",
  "title: Groups page",
  "type: plan",
  "---",
  "",
  ...q("H1", "For the domain experts?", ' to="fag"'),
].join("\n");
const GROUPS_ENV = "fag=Z990001,Z990002;utvikler=Z990002,Z990003";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | undefined;
let base = "";
let sql: postgres.Sql | undefined;

const deleteRows = async () => {
  await sql!`DELETE FROM wiki_answers WHERE wiki IN (${WIKI}, ${WIKI_NO}, ${WIKI_RO})`;
};

async function api(body: Record<string, unknown>): Promise<{ answerId: string; version: number }> {
  const res = await fetch(`${BASE}/api/wiki/answers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wiki: WIKI, ...body }),
  });
  if (!res.ok) throw new Error(`seed POST ${res.status}: ${await res.text()}`);
  return res.json();
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(90_000);
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql.unsafe(readFileSync(path.join(REPO_ROOT, "db/migrations/082-wiki-answers.sql"), "utf8"));
  await deleteRows();
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answer-card-"));
  for (const dir of ["a", "no", "ro"]) await mkdir(path.join(base, dir, "plans"), { recursive: true });
  await writeFile(path.join(base, "a", REL), PAGE, "utf8");
  await writeFile(path.join(base, "a", STYLE_REL), STYLE_PAGE, "utf8");
  await writeFile(path.join(base, "a", FIX_REL), FIX_PAGE, "utf8");
  await writeFile(path.join(base, "a", FOCUS_REL), FOCUS_PAGE, "utf8");
  await writeFile(path.join(base, "a", REDACT_REL), REDACT_PAGE, "utf8");
  await writeFile(path.join(base, "a", SWEEP_REL), SWEEP_PAGE, "utf8");
  await writeFile(path.join(base, "a", GROUPS_REL), GROUPS_PAGE, "utf8");
  await writeFile(path.join(base, "a", TERMINAL_REL), terminalPage(false), "utf8");
  await writeFile(path.join(base, "ro", REL), PAGE, "utf8");
  await writeFile(path.join(base, "no", REL), PAGE_NO, "utf8");
  await writeFile(path.join(base, "no", ".wiki-reader.json"), JSON.stringify({ language: "no" }), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${path.join(base, "a")},${WIKI_NO}=${path.join(base, "no")},${WIKI_RO}=${path.join(base, "ro")}`,
      WIKI_ANSWER_WIKIS: `${WIKI},${WIKI_NO}`,
      WIKI_ANSWER_OWNER: OWNER,
      WIKI_ANSWER_GROUPS: GROUPS_ENV,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }

  // The style page's state, through the real route.
  const c1 = await api({ relPath: STYLE_REL, questionId: "C1", choice: "A", body: "First thought." });
  await api({ relPath: STYLE_REL, questionId: "C1", choice: "B", body: "Second thought.", answerId: c1.answerId, baseVersion: 1 });
  await api({ relPath: STYLE_REL, questionId: "C4", body: "Not asked, answered anyway." });
  // C2 is closed, so the route refuses it: an answer saved before the close.
  await sql`INSERT INTO wiki_answers (answer_id, version, wiki, rel_path, question_id, author_name, body, question_hash)
            VALUES (${randomUUID()}, 1, ${WIKI}, ${STYLE_REL}, 'C2', ${OWNER}, 'Saved before the close.', 'seed')`;

  // The fix page's seeded state.
  await api({ relPath: FIX_REL, questionId: "F1", choice: "A", body: "F1 version one." });
  // F7 was answered with "A" when the page offered A|B; it now offers X|Y.
  await sql`INSERT INTO wiki_answers (answer_id, version, wiki, rel_path, question_id, author_name, choice, body, question_hash)
            VALUES (${randomUUID()}, 1, ${WIKI}, ${FIX_REL}, 'F7', ${OWNER}, 'A', 'Picked A back then.', 'seed')`;
  const f8 = await api({ relPath: FIX_REL, questionId: "F8", body: "F8 version one." });
  await api({ relPath: FIX_REL, questionId: "F8", body: "F8 version two.", answerId: f8.answerId, baseVersion: 1 });
  await api({ relPath: FIX_REL, questionId: "F13", body: "F13 version one." });

  // The focus page's seeded answers: each one the viewer's, so it has an Edit.
  for (const id of ["G9", "G18", "G20", "G21"]) await api({ relPath: FOCUS_REL, questionId: id, body: `${id} version one.` });
  await api({ relPath: FOCUS_REL, questionId: "G16", choice: "A", body: "G16 version one." });
  for (const id of ["R1", "R2", "R3", "R4", "R5", "R7", "R9", "R10", "R11", "R12", "R14"]) {
    await api({ relPath: REDACT_REL, questionId: id, body: `${id} text.` });
  }
  await api({ relPath: SWEEP_REL, questionId: "S1", choice: "A", body: "S1 version one." });
  await api({ relPath: SWEEP_REL, questionId: "S3", body: "S3 version one." });
  await api({ relPath: SWEEP_REL, questionId: "S5", body: "S5 first answer." });
  await api({ relPath: SWEEP_REL, questionId: "S5", body: "S5 second answer." });
  await api({ relPath: SWEEP_REL, questionId: "S6", body: "S6 version one." });
  await api({ relPath: SWEEP_REL, questionId: "S8", body: "S8 first answer." });
  await api({ relPath: SWEEP_REL, questionId: "S8", body: "S8 second answer." });

  for (const id of ["T1", "T3"]) await api({ relPath: TERMINAL_REL, questionId: id, body: `${id} version one.` });

  // The groups page: a fag member (also in utvikler) and a utvikler-only author.
  for (const [name, ident, body] of [
    ["Nordmann, Kari", "Z990002", "From a fag member."],
    ["Utvikler, Ola", "Z990003", "From a developer."],
  ] as const) {
    await sql`INSERT INTO wiki_answers (answer_id, version, wiki, rel_path, question_id, author_name, author_nav_ident, body, question_hash)
              VALUES (${randomUUID()}, 1, ${WIKI}, ${GROUPS_REL}, 'H1', ${name}, ${ident}, ${body}, 'seed')`;
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (sql) await deleteRows();
  await sql?.end();
  if (base) await rm(base, { recursive: true, force: true });
});

function watch(page: Page): { failed: string[]; errors: string[]; answerGets: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  const answerGets: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === "/api/wiki/answers" && req.method() === "GET") answerGets.push(u.search);
  });
  page.on("response", (res) => {
    const u = new URL(res.url());
    const similarDegrade = u.pathname === "/api/wiki/similar" && res.status() === 404;
    if (u.origin === BASE && res.status() >= 400 && !similarDegrade) failed.push(`${res.status()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors, answerGets };
}

const card = (page: Page, id: string) => page.locator(`.wiki-article section.question[data-question-id="${id}"]`);

async function openPage(page: Page, wiki = WIKI, rel = REL) {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article section.question").first()).toBeVisible();
  return seen;
}

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

const rowsFor = async (questionId: string, rel = REL) =>
  sql!`SELECT answer_id, version, author_name, choice, body FROM wiki_answers
       WHERE wiki = ${WIKI} AND rel_path = ${rel} AND question_id = ${questionId} ORDER BY version`;

test.describe("Wiki reader: the answer card's composer", () => {
  test("answer with a choice and a body → Answered, the owner, asked; edit → edited 1× with both versions in the log", async ({ page }) => {
    const seen = await openPage(page);
    const o1 = card(page, "O1");
    await expect(o1.locator("form.q-composer")).toBeVisible();
    await expect(o1.locator(".q-state")).toHaveText("Open");
    await expect(o1.locator('input[type="radio"]')).toHaveCount(3);
    await expect(o1.locator(".q-choice")).toHaveText(["A", "B", "Not sure yet"]);
    await expect(o1.locator("button.q-save")).toBeDisabled();

    await o1.locator(".q-choice", { hasText: "B" }).click();
    await o1.locator("textarea.q-text").fill("Use the page's language.\nSecond line.");
    await expect(o1.locator(".q-count")).toHaveText("37 / 8000");
    await o1.locator("button.q-save").click();

    await expect(o1.locator(".q-state")).toHaveText("Answered");
    await expect(o1).toHaveAttribute("data-answer-state", "answered");
    const item = o1.locator(".q-answer");
    await expect(item).toHaveCount(1);
    await expect(item.locator(".q-author")).toHaveText(OWNER);
    await expect(item.locator(".q-asked")).toHaveText("asked");
    await expect(item.locator(".q-pick")).toHaveText("B");
    await expect(item.locator(".q-answer-body")).toHaveText("Use the page's language.\nSecond line.");
    // The viewer has an answer now: no second composer, an Edit instead.
    await expect(o1.locator("form.q-composer")).toHaveCount(0);

    await item.locator("button.q-edit").click();
    const edit = o1.locator("form.q-composer-edit");
    await expect(edit.locator("textarea.q-text")).toHaveValue("Use the page's language.\nSecond line.");
    await expect(edit.locator('input[value="B"]')).toBeChecked();
    await edit.locator(".q-choice", { hasText: "Not sure yet" }).click();
    await edit.locator("textarea.q-text").fill("Not sure after all.");
    await edit.locator("button.q-save").click();

    const after = o1.locator(".q-answer");
    await expect(after.locator(".q-edited")).toHaveText("· edited 1×");
    await expect(after.locator(":scope > .q-pick")).toHaveText("Not sure yet");
    await expect(after.locator(":scope > .q-answer-body")).toHaveText("Not sure after all.");
    await after.locator(".q-log > summary").click();
    await expect(after.locator(".q-log > summary")).toHaveText("Earlier versions (1)");
    await expect(after.locator(".q-log-item .q-by")).toContainText("version 1");
    await expect(after.locator(".q-log-item .q-answer-body")).toHaveText("Use the page's language.\nSecond line.");

    const rows = await rowsFor("O1");
    expect(rows.map((r) => [r.version, r.author_name, r.choice, r.body])).toEqual([
      [1, OWNER, "B", "Use the page's language.\nSecond line."],
      [2, OWNER, "not-sure", "Not sure after all."],
    ]);
    expect(new Set(rows.map((r) => r.answer_id)).size).toBe(1);
    expectClean(seen);
  });

  test("a closed card has no composer; a reopened card takes an answer", async ({ page }) => {
    const seen = await openPage(page);
    await expect(card(page, "O2").locator(".q-state")).toHaveText("Decided → D99");
    await expect(card(page, "O3").locator("form.q-composer")).toBeVisible();
    await expect(card(page, "O2").locator("form.q-composer, textarea, button.q-save")).toHaveCount(0);

    const o3 = card(page, "O3");
    await o3.locator("textarea.q-text").fill("Settled after the reopen.");
    await o3.locator("button.q-save").click();
    await expect(o3.locator(".q-state")).toHaveText("Answered");
    expect((await rowsFor("O3")).map((r) => r.body)).toEqual(["Settled after the reopen."]);
    expectClean(seen);
  });

  test("a double-click on Save stores one answer", async ({ page }) => {
    const seen = await openPage(page);
    const o4 = card(page, "O4");
    await o4.locator("textarea.q-text").fill("Once.");
    await o4.locator("button.q-save").dblclick();
    await expect(o4.locator(".q-answer")).toHaveCount(1);
    // Let any second request land before counting.
    await page.waitForTimeout(500);
    expect((await rowsFor("O4")).length).toBe(1);
    await expect(o4.locator(".q-answer")).toHaveCount(1);
    expectClean(seen);
  });

  test("an edit made from a stale version shows the conflict message and the newer answer", async ({ browser }) => {
    const first = await api({ relPath: REL, questionId: "O5", body: "Version one." });
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const seenA = await openPage(a);
    await openPage(b);

    await card(a, "O5").locator("button.q-edit").click();
    await card(a, "O5").locator("textarea.q-text").fill("A's edit, from version one.");

    await card(b, "O5").locator("button.q-edit").click();
    await card(b, "O5").locator("textarea.q-text").fill("B got there first.");
    await card(b, "O5").locator("button.q-save").click();
    await expect(card(b, "O5").locator(".q-edited")).toHaveText("· edited 1×");

    await card(a, "O5").locator("button.q-save").click();
    const msg = card(a, "O5").locator(".q-msg");
    await expect(msg).toBeVisible();
    // A's text is still in the editor, and the newer answer is on screen above it.
    await expect(card(a, "O5").locator("textarea.q-text")).toHaveValue("A's edit, from version one.");
    await expect(card(a, "O5").locator(".q-answer > .q-answer-body")).toHaveText("B got there first.");
    await expect(msg).toHaveText(
      "This answer changed somewhere else. The latest version is shown above; your text is still in the editor, and saving it replaces that version.",
    );
    const rows = await rowsFor("O5");
    expect(rows.map((r) => [r.answer_id, r.version, r.body])).toEqual([
      [first.answerId, 1, "Version one."],
      [first.answerId, 2, "B got there first."],
    ]);
    // Saving again is now a deliberate replace of version 2.
    await card(a, "O5").locator("button.q-save").click();
    await expect(card(a, "O5").locator(".q-edited")).toHaveText("· edited 2×");
    await expect(card(a, "O5").locator(".q-answer > .q-answer-body")).toHaveText("A's edit, from version one.");
    expect((await rowsFor("O5")).map((r) => [r.version, r.body])).toEqual([
      [1, "Version one."],
      [2, "B got there first."],
      [3, "A's edit, from version one."],
    ]);
    // The 409 is the one failed response, and it is the expected one.
    expect(seenA.failed).toEqual(["409 /api/wiki/answers"]);
    expect(seenA.errors).toEqual([]);
    await ctxA.close();
    await ctxB.close();
  });

  test("a wiki outside WIKI_ANSWER_WIKIS renders the card read-only and never asks for answers", async ({ page }) => {
    const seen = await openPage(page, WIKI_RO);
    await page.waitForTimeout(800);
    const cards = page.locator(".wiki-article section.question");
    await expect(cards).toHaveCount(5);
    await expect(cards.first()).toHaveAttribute("data-wiki-answerable", "false");
    await expect(page.locator(".wiki-article .q-composer, .wiki-article .q-answers, .wiki-article .q-edit")).toHaveCount(0);
    expect(seen.answerGets).toEqual([]);
    expectClean(seen);
  });

  test('language "no": the composer, the states and "not asked" in Norwegian', async ({ page }) => {
    const seen = await openPage(page, WIKI_NO);
    const o1 = card(page, "O1");
    await expect(o1.locator(".q-choice")).toHaveText(["A", "B", "Vet ikke ennå"]);
    await expect(o1.locator("button.q-save")).toHaveText("Lagre svar");
    await expect(o1.locator("textarea.q-text")).toHaveAttribute("placeholder", "Svaret ditt …");
    await o1.locator(".q-choice", { hasText: "A" }).click();
    await o1.locator("button.q-save").click();
    await expect(o1.locator(".q-state")).toHaveText("Besvart");
    // questions_to names Kari, so the owner's answer is "ikke spurt".
    await expect(o1.locator(".q-asked")).toHaveText("ikke spurt");
    await expect(o1.locator("button.q-edit")).toHaveText("Endre");
    expectClean(seen);
  });
});

test.describe("Wiki reader: the answer card under reloads, failures and focus", () => {
  const fixCard = (page: Page, id: string) => card(page, id);
  /** Open the fix page and wait for the first answers load to land (F1 holds a
   *  seeded answer), so a route installed afterwards sees only later requests. */
  const openFix = async (page: Page) => {
    const seen = await openPage(page, WIKI, FIX_REL);
    await expect(fixCard(page, "F1").locator(".q-answer")).toHaveCount(1);
    return seen;
  };

  test("an edit keeps the version it was started from: a newer one saved meanwhile is a 409, not an overwrite", async ({ page }) => {
    const seen = await openFix(page);
    const f1 = fixCard(page, "F1");
    await f1.locator("button.q-edit").click();
    await f1.locator("textarea.q-text").fill("F1 edit made from version one.");
    // Another tab saves version 2 while this editor is open.
    const [row] = await rowsFor("F1", FIX_REL);
    await api({ relPath: FIX_REL, questionId: "F1", choice: "B", body: "F1 version two, from elsewhere.", answerId: row!.answer_id, baseVersion: 1 });
    // A save on another card reloads the answers, version 2 included.
    const f2 = fixCard(page, "F2");
    await f2.locator("textarea.q-text").fill("F2 saved.");
    await f2.locator("button.q-save").click();
    await expect(f2.locator(".q-answer")).toHaveCount(1);
    const post = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/wiki/answers");
    await f1.locator("button.q-save").click();
    // Sent from version 1, the base the editor was opened on: refused.
    expect((await post).status()).toBe(409);
    await expect(f1.locator(".q-msg-warn")).toBeVisible();
    await expect(f1.locator(".q-answer > .q-answer-body")).toHaveText("F1 version two, from elsewhere.");
    await expect(f1.locator("textarea.q-text")).toHaveValue("F1 edit made from version one.");
    expect((await rowsFor("F1", FIX_REL)).map((r) => [r.version, r.body])).toEqual([
      [1, "F1 version one."],
      [2, "F1 version two, from elsewhere."],
    ]);
    expect(seen.failed).toEqual(["409 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("two reloads that return in reverse order: the newer list stays painted and no composer comes back", async ({ page }) => {
    const seen = await openFix(page);
    let gets = 0;
    await page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      gets++;
      // The first reload's answer is read now and delivered last.
      const res = await route.fetch();
      if (gets === 1) await sleep(1500);
      await route.fulfill({ response: res });
    });
    const f3 = fixCard(page, "F3");
    const f4 = fixCard(page, "F4");
    await f3.locator("textarea.q-text").fill("F3 first.");
    await f3.locator("button.q-save").click();
    // F3's reload is out (and held); F4's save and reload go after it.
    await expect.poll(() => gets).toBe(1);
    await f4.locator("textarea.q-text").fill("F4 second.");
    await f4.locator("button.q-save").click();
    await expect(f4.locator(".q-answer")).toHaveCount(1);
    await expect.poll(() => gets).toBe(2);
    // Let the delayed, older list land.
    await page.waitForTimeout(2000);
    await expect(f4.locator(".q-answer")).toHaveCount(1);
    await expect(f4.locator("form.q-composer")).toHaveCount(0);
    await expect(f3.locator(".q-answer")).toHaveCount(1);
    expect((await rowsFor("F4", FIX_REL)).length).toBe(1);
    expectClean(seen);
  });

  test("a save whose reload fails: the card leaves Saving, shows the answer and offers to load again", async ({ page }) => {
    const seen = await openFix(page);
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) })
        : route.fallback(),
    );
    const f5 = fixCard(page, "F5");
    await f5.locator("textarea.q-text").fill("F5 saved anyway.");
    await f5.locator("button.q-save").click();
    const msg = f5.locator(".q-msg");
    await expect(msg).toContainText("The answer was saved, but the answers could not be loaded again.");
    await expect(f5.locator("button.q-save")).toHaveCount(0);
    await expect(f5.locator(".q-answer > .q-answer-body")).toHaveText("F5 saved anyway.");
    await expect(f5.locator("button.q-edit")).toBeEnabled();
    await page.unroute("**/api/wiki/answers?*");
    await msg.locator("button.q-retry").click();
    await expect(f5.locator(".q-msg")).toHaveCount(0);
    await expect(f5.locator(".q-asked")).toHaveText("asked");
    expect((await rowsFor("F5", FIX_REL)).length).toBe(1);
    expect(seen.failed).toEqual(["500 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("the first load fails: each card says so in one quiet line and offers no composer", async ({ page }) => {
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 503, body: "no" }) : route.fallback(),
    );
    await openPage(page, WIKI, FIX_REL);
    const f2 = fixCard(page, "F2");
    await expect(f2.locator(".q-answers-error")).toHaveText("Answers could not be loaded.");
    await expect(page.locator(".wiki-article .q-answers-error")).toHaveCount(18);
    await expect(page.locator(".wiki-article form.q-composer")).toHaveCount(0);
  });

  test("focus lands on the saved answer's Edit after Save, and back on Edit after Cancel", async ({ page }) => {
    const seen = await openFix(page);
    const f6 = fixCard(page, "F6");
    await f6.locator("textarea.q-text").fill("F6 answer.");
    await f6.locator("button.q-save").click();
    const edit = f6.locator("button.q-edit");
    await expect(edit).toBeFocused();
    await edit.click();
    await expect(f6.locator("textarea.q-text")).toBeFocused();
    await f6.locator("button.q-cancel").click();
    await expect(f6.locator("button.q-edit")).toBeFocused();
    expectClean(seen);
  });

  test("a stored choice the page no longer offers is dropped from the edit, and a picked choice can be cleared", async ({ page }) => {
    const seen = await openFix(page);
    const f7 = fixCard(page, "F7");
    await expect(f7.locator(".q-answer > .q-pick")).toHaveText("A");
    await f7.locator("button.q-edit").click();
    await expect(f7.locator('input[type="radio"]:checked')).toHaveCount(0);
    await f7.locator("textarea.q-text").fill("No choice now, just text.");
    const post = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/wiki/answers");
    await f7.locator("button.q-save").click();
    // Sent with no choice, not the stale "A" the route would refuse.
    expect((await post).status()).toBe(200);
    await expect(f7.locator(".q-edited")).toHaveText("· edited 1×");
    const rows = await rowsFor("F7", FIX_REL);
    expect(rows.map((r) => [r.version, r.choice, r.body])).toEqual([
      [1, "A", "Picked A back then."],
      [2, null, "No choice now, just text."],
    ]);
    // A picked choice can be cleared again before saving.
    await f7.locator("button.q-edit").click();
    await expect(f7.locator("button.q-clear-choice")).toBeHidden();
    await f7.locator(".q-choice", { hasText: "X" }).click();
    await expect(f7.locator("button.q-clear-choice")).toBeVisible();
    await f7.locator("button.q-clear-choice").click();
    await expect(f7.locator('input[type="radio"]:checked')).toHaveCount(0);
    await expect(f7.locator("button.q-clear-choice")).toBeHidden();
    await f7.locator("button.q-cancel").click();
    expectClean(seen);
  });

  test("a reload repaints only changed cards: typing elsewhere keeps focus and caret, and an open log fold stays open", async ({ page }) => {
    const seen = await openFix(page);
    const f8 = fixCard(page, "F8");
    await f8.locator(".q-log > summary").click();
    await expect(f8.locator(".q-log")).toHaveAttribute("open", "");
    // F8 changes elsewhere, so the coming reload repaints it.
    const [row] = await rowsFor("F8", FIX_REL);
    await api({ relPath: FIX_REL, questionId: "F8", body: "F8 version three.", answerId: row!.answer_id, baseVersion: 2 });
    await page.route("**/api/wiki/answers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const res = await route.fetch();
      await sleep(800);
      await route.fulfill({ response: res });
    });
    const f10 = fixCard(page, "F10");
    // An unchanged card is not repainted at all: its nodes survive the reload.
    await f9Text(page).evaluate((el) => ((el as unknown as { __kept: boolean }).__kept = true));
    await f10.locator("textarea.q-text").fill("F10 saved while typing elsewhere.");
    await f10.locator("button.q-save").click();
    const f9 = f9Text(page);
    await f9.click();
    await f9.pressSequentially("abcdef");
    await f9.press("ArrowLeft");
    await f9.press("ArrowLeft");
    // The save lands and the answers reload while F9 holds focus.
    await expect(f10.locator(".q-answer")).toHaveCount(1);
    await expect(f8.locator(".q-edited")).toHaveText("· edited 2×");
    await expect(f9).toBeFocused();
    await f9.pressSequentially("X");
    await expect(f9).toHaveValue("abcdXef");
    await expect(f8.locator(".q-log")).toHaveAttribute("open", "");
    await expect(f8.locator(".q-log > summary")).toHaveText("Earlier versions (2)");
    expect(await f9.evaluate((el) => (el as unknown as { __kept?: boolean }).__kept === true)).toBe(true);
    expectClean(seen);
  });

  test("a card that changes under focus is repainted with focus back on the same control", async ({ page }) => {
    const seen = await openFix(page);
    await page.route("**/api/wiki/answers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const res = await route.fetch();
      await sleep(800);
      await route.fulfill({ response: res });
    });
    const f13 = fixCard(page, "F13");
    const f14 = fixCard(page, "F14");
    await f14.locator("textarea.q-text").fill("F14 saved.");
    await f14.locator("button.q-save").click();
    // While F14's save is out, F13 changes elsewhere and the reader moves to it.
    const [row] = await rowsFor("F13", FIX_REL);
    await api({ relPath: FIX_REL, questionId: "F13", body: "F13 version two.", answerId: row!.answer_id, baseVersion: 1 });
    await f13.locator("button.q-edit").focus();
    await expect(f14.locator(".q-answer")).toHaveCount(1);
    await expect(f13.locator(".q-answer > .q-answer-body")).toHaveText("F13 version two.");
    await expect(f13.locator("button.q-edit")).toBeFocused();
    expectClean(seen);
  });

  test("an answer that is not the viewer's has no Edit", async ({ page }) => {
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              answerable: true,
              answers: [
                {
                  answerId: "00000000-0000-4000-8000-000000000011",
                  questionId: "F11",
                  version: 1,
                  versionCount: 1,
                  authorName: "Kari Nordmann",
                  choice: null,
                  body: "Someone else's answer.",
                  createdAt: Date.now(),
                  firstCreatedAt: Date.now(),
                  exported: false,
                  redacted: false,
                  mine: false,
                  asked: false,
                },
              ],
            }),
          })
        : route.fallback(),
    );
    await openPage(page, WIKI, FIX_REL);
    const f11 = fixCard(page, "F11");
    await expect(f11.locator(".q-answer > .q-answer-body")).toHaveText("Someone else's answer.");
    await expect(f11.locator("button.q-edit")).toHaveCount(0);
    // Not the viewer's answer, so the viewer still gets a composer of their own.
    await expect(f11.locator("form.q-composer")).toBeVisible();
  });

  test("one request in flight per card: a second submit while the first is out sends nothing", async ({ page }) => {
    const seen = await openFix(page);
    let posts = 0;
    await page.route("**/api/wiki/answers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts++;
      const res = await route.fetch();
      await sleep(600);
      await route.fulfill({ response: res });
    });
    const f12 = fixCard(page, "F12");
    await f12.locator("textarea.q-text").fill("Once, however often submitted.");
    // Two submit events, each on the form on screen at that moment: the Save
    // button's disabled state plays no part.
    await f12.evaluate((section) => {
      for (let i = 0; i < 2; i++) {
        section.querySelector("form.q-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
    await expect(f12.locator(".q-answer")).toHaveCount(1);
    await page.waitForTimeout(800);
    expect(posts).toBe(1);
    expect((await rowsFor("F12", FIX_REL)).length).toBe(1);
    expectClean(seen);
  });
});

test.describe("Wiki reader: the answer card, fix round 2", () => {
  const openFix = async (page: Page) => {
    const seen = await openPage(page, WIKI, FIX_REL);
    await expect(card(page, "F1").locator(".q-answer")).toHaveCount(1);
    return seen;
  };

  test("a repaint leaves focus alone when it is on a part the repaint does not replace", async ({ page }) => {
    const seen = await openFix(page);
    await page.route("**/api/wiki/answers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const res = await route.fetch();
      await sleep(800);
      await route.fulfill({ response: res });
    });
    const f16 = card(page, "F16");
    const f18 = card(page, "F18");
    await f18.locator("textarea.q-text").fill("F18 saved.");
    await f18.locator("button.q-save").click();
    // While F18's save is out, F16 changes elsewhere and the reader focuses
    // the link in F16's question text.
    await api({ relPath: FIX_REL, questionId: "F16", body: "F16 answered elsewhere." });
    const link = f16.locator(".q-body a");
    await link.focus();
    await expect(f18.locator(".q-answer")).toHaveCount(1);
    await expect(f16.locator(".q-answer > .q-answer-body")).toHaveText("F16 answered elsewhere.");
    await expect(link).toBeFocused();
    expectClean(seen);
  });

  test("a 409 whose reload fails keeps the conflict message and offers to load again", async ({ page }) => {
    const seen = await openFix(page);
    await page.route("**/api/wiki/answers", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "x", code: "version_conflict" }) })
        : route.fallback(),
    );
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) })
        : route.fallback(),
    );
    const f15 = card(page, "F15");
    await f15.locator("textarea.q-text").fill("F15 text.");
    await f15.locator("button.q-save").click();
    const msg = f15.locator(".q-msg-warn");
    // Load again appears only once the reload has failed: the text checks
    // below then read the final message, not the one shown before the reload.
    await expect(msg.locator("button.q-retry")).toBeVisible();
    await expect(msg).toContainText("This answer changed somewhere else.");
    await expect(msg).toContainText("Answers could not be loaded.");
    await expect(f15.locator("textarea.q-text")).toHaveValue("F15 text.");
    expect(seen.failed).toEqual(["409 /api/wiki/answers", "500 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("a save whose reload answers answerable:false keeps the cards and offers to load again", async ({ page }) => {
    const seen = await openFix(page);
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answerable: false, answers: [] }) })
        : route.fallback(),
    );
    const f17 = card(page, "F17");
    await f17.locator("textarea.q-text").fill("F17 saved.");
    await f17.locator("button.q-save").click();
    const msg = f17.locator(".q-msg");
    await expect(msg).toContainText("The answer was saved, but the answers could not be loaded again.");
    await expect(msg.locator("button.q-retry")).toBeVisible();
    await expect(f17.locator(".q-answer > .q-answer-body")).toHaveText("F17 saved.");
    // The other cards keep what the first load painted.
    await expect(card(page, "F1").locator(".q-answer")).toHaveCount(1);
    expectClean(seen);
  });
});

/**
 * Fix round 3: where focus goes when a card is repainted, one test per cell.
 *
 * | Focus before the repaint                         | Control after   | Focus after                      |
 * |--------------------------------------------------|-----------------|----------------------------------|
 * | nothing (`<body>`)                               | —               | untouched                        |
 * | outside every card (the search box)              | —               | untouched                        |
 * | another card (F9's textarea)                     | —               | untouched (fix round 1 pin)      |
 * | question text link (F16)                         | always there    | untouched (fix round 2 pin)      |
 * | `a.q-id`, `a.q-decision`                         | always there    | untouched                        |
 * | `.q-answers` (Edit)                              | there (F13)     | same control (fix round 1 pin)   |
 * | `.q-answers` (Edit)                              | gone            | the card                         |
 * | `.q-composer`, new answer                        | there           | same control, caret + selection  |
 * | `.q-composer`, new answer                        | gone            | the card                         |
 * | `.q-msg` Load again, pressed, its load still out | there           | stays on it (`aria-disabled`)    |
 * | `.q-msg` Load again, the load worked             | gone            | the card                         |
 * | edit form inside `.q-answers`                    | there           | same control, caret + selection  |
 * | edit form inside `.q-answers`                    | gone            | the card                         |
 * | edit form Save, refused (400/403/409/network)    | disabled in flight | the card                      |
 * | edit form Save, saved                            | gone            | the answer's Edit (save rule)    |
 *
 * `.q-msg` with Load again never survives a repaint (a good load, a save,
 * Edit and Cancel all clear it), and `.q-answers-error` holds nothing
 * focusable: neither has a "there" cell.
 */
test.describe("Wiki reader: answer card focus across a repaint", () => {
  const openFocus = async (page: Page) => {
    const seen = await openPage(page, WIKI, FOCUS_REL);
    await expect(card(page, "G9").locator(".q-answer")).toHaveCount(1);
    return seen;
  };
  /** Hold every answer POST, so focus can move before the save's reload. */
  const holdPosts = (page: Page) =>
    page.route("**/api/wiki/answers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const res = await route.fetch();
      await sleep(800);
      await route.fulfill({ response: res });
    });
  /** Rewrite the answers list of every GET from now on. */
  const rewriteGets = (page: Page, fn: (answers: Record<string, unknown>[]) => Record<string, unknown>[]) =>
    page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { answers: Record<string, unknown>[] };
      await route.fulfill({ response: res, json: { ...body, answers: fn(body.answers) } });
    });
  /** Save on a trigger card: its POST is held, its reload repaints the rest. */
  const saveOn = async (c: Locator, text: string) => {
    if ((await c.locator("button.q-edit").count()) > 0) await c.locator("button.q-edit").click();
    await c.locator("textarea.q-text").fill(text);
    await c.locator("button.q-save").click();
  };
  const otherAnswer = (questionId: string, mine: boolean) => ({
    answerId: randomUUID(),
    questionId,
    version: 1,
    versionCount: 1,
    authorName: "Kari Nordmann",
    choice: null,
    body: `${questionId} answered elsewhere.`,
    createdAt: Date.now(),
    firstCreatedAt: Date.now(),
    exported: false,
    redacted: false,
    mine,
    asked: false,
  });
  const activeIsBody = (page: Page) => page.evaluate(() => document.activeElement === document.body);
  const selection = (l: Locator) =>
    l.evaluate((el) => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd]);

  test("nothing focused: a repaint leaves focus on the page body", async ({ page }) => {
    const seen = await openFocus(page);
    await api({ relPath: FOCUS_REL, questionId: "G1", body: "G1 answered elsewhere." });
    await page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      await sleep(800);
      await route.fulfill({ response: res });
    });
    const g2 = card(page, "G2");
    await g2.locator("textarea.q-text").fill("G2 saved.");
    await g2.locator("button.q-save").click();
    // The save moves focus to G2's Edit; the reader then clicks away while the
    // reload is out.
    await expect(g2.locator("button.q-edit")).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await activeIsBody(page)).toBe(true);
    await expect(card(page, "G1").locator(".q-answer-body")).toHaveText("G1 answered elsewhere.");
    expect(await activeIsBody(page)).toBe(true);
    expectClean(seen);
  });

  test("focus outside every card: the search box keeps focus through a repaint", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    await saveOn(card(page, "G4"), "G4 saved.");
    await api({ relPath: FOCUS_REL, questionId: "G3", body: "G3 answered elsewhere." });
    const search = page.locator("#wikiSearch");
    await search.focus();
    await expect(card(page, "G3").locator(".q-answer-body")).toHaveText("G3 answered elsewhere.");
    await expect(search).toBeFocused();
    expectClean(seen);
  });

  test("focus on the card's id link: a repaint leaves it there", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    await saveOn(card(page, "G6"), "G6 saved.");
    await api({ relPath: FOCUS_REL, questionId: "G5", body: "G5 answered elsewhere." });
    const link = card(page, "G5").locator("a.q-id");
    await link.focus();
    await expect(card(page, "G5").locator(".q-answer-body")).toHaveText("G5 answered elsewhere.");
    await expect(link).toBeFocused();
    expectClean(seen);
  });

  test("focus on a decided card's decision link: a repaint leaves it there", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    await rewriteGets(page, (answers) => [...answers, otherAnswer("G7", false)]);
    await saveOn(card(page, "G8"), "G8 saved.");
    const g7 = card(page, "G7");
    const link = g7.locator("a.q-decision");
    await link.focus();
    await expect(g7.locator(".q-answer-body")).toHaveText("G7 answered elsewhere.");
    await expect(g7.locator(".q-new")).toBeVisible();
    await expect(link).toBeFocused();
    expectClean(seen);
  });

  test("focus on an Edit the repaint removes: the card holds focus", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    // The reload says G9's answer was redacted meanwhile: no Edit on it.
    await rewriteGets(page, (answers) =>
      answers.map((a) => (a.questionId === "G9" ? { ...a, redacted: true, body: "", choice: null } : a)),
    );
    await saveOn(card(page, "G10"), "G10 saved.");
    const g9 = card(page, "G9");
    await g9.locator("button.q-edit").focus();
    await expect(g9.locator(".q-redacted")).toBeVisible();
    await expect(g9.locator("button.q-edit")).toHaveCount(0);
    await expect(g9).toBeFocused();
    expectClean(seen);
  });

  test("typing in a new-answer composer whose card repaints: focus, caret and selection stay", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    // Someone else answers G11: the card repaints and keeps the viewer's composer.
    await rewriteGets(page, (answers) => [...answers, otherAnswer("G11", false)]);
    await saveOn(card(page, "G12"), "G12 saved.");
    const g11 = card(page, "G11");
    const text = g11.locator("textarea.q-text");
    await text.fill("abcdef");
    await text.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(2, 4));
    await expect(g11.locator(".q-answer-body")).toHaveText("G11 answered elsewhere.");
    await expect(text).toBeFocused();
    expect(await selection(text)).toEqual([2, 4]);
    await text.press("X");
    await expect(text).toHaveValue("abXef");
    expectClean(seen);
  });

  test("typing in a new-answer composer the repaint removes: the card holds focus", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    // The viewer's own answer to G13 arrives (saved in another tab): the
    // composer gives way to it.
    await rewriteGets(page, (answers) => [...answers, otherAnswer("G13", true)]);
    await saveOn(card(page, "G14"), "G14 saved.");
    const g13 = card(page, "G13");
    await g13.locator("textarea.q-text").fill("Half a thought");
    await expect(g13.locator(".q-answer-body")).toHaveText("G13 answered elsewhere.");
    await expect(g13.locator("form.q-composer")).toHaveCount(0);
    await expect(g13).toBeFocused();
    expectClean(seen);
  });

  test("Load again that works: the line goes and the card holds focus", async ({ page }) => {
    const seen = await openFocus(page);
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) })
        : route.fallback(),
    );
    const g15 = card(page, "G15");
    await g15.locator("textarea.q-text").fill("G15 saved.");
    await g15.locator("button.q-save").click();
    const retry = g15.locator(".q-msg button.q-retry");
    await expect(retry).toBeVisible();
    await page.unroute("**/api/wiki/answers?*");
    // The retry's load is held, so a second press lands while it is out.
    await page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      await sleep(800);
      await route.fulfill({ response: res });
    });
    const getsBefore = seen.answerGets.length;
    await retry.focus();
    await retry.press("Enter");
    await retry.press("Enter");
    await expect(retry).toBeFocused();
    await expect(g15.locator(".q-msg")).toHaveCount(0);
    await expect(g15).toBeFocused();
    expect(seen.answerGets.length - getsBefore).toBe(1);
    expect(seen.failed).toEqual(["500 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("an open edit form: each of its controls keeps focus through a repaint, the textarea its caret and selection", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    const g16 = card(page, "G16");
    const g17 = card(page, "G17");
    const [row] = await rowsFor("G16", FOCUS_REL);
    await g16.locator("button.q-edit").click();
    const text = g16.locator("form.q-composer textarea.q-text");
    await text.fill("abcdef");
    const controls: [string, Locator][] = [
      ["textarea", text],
      ["radio B", g16.locator('form.q-composer input[type="radio"][value="B"]')],
      ["Clear choice", g16.locator("form.q-composer button.q-clear-choice")],
      ["Save", g16.locator("form.q-composer button.q-save")],
      ["Cancel", g16.locator("form.q-composer button.q-cancel")],
    ];
    let version = 1;
    for (const [name, control] of controls) {
      await saveOn(g17, `G17 save before ${name}.`);
      // G16 changes elsewhere, so the coming reload repaints it.
      await api({ relPath: FOCUS_REL, questionId: "G16", choice: "A", body: `G16 version ${version + 1}.`, answerId: row!.answer_id, baseVersion: version });
      version++;
      await control.focus();
      if (name === "textarea") await text.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(2, 4));
      await expect(g16.locator(".q-answer > .q-by .q-edited")).toHaveText(`· edited ${version - 1}×`);
      await expect(control, name).toBeFocused();
      if (name === "textarea") expect(await selection(text)).toEqual([2, 4]);
    }
    await expect(text).toHaveValue("abcdef");
    expectClean(seen);
  });

  test("an open edit form whose answer the repaint removes: the draft moves into the new-answer composer, focus stays in its text", async ({ page }) => {
    const seen = await openFocus(page);
    await holdPosts(page);
    // The reload no longer lists G18's answer (PR 5b: the retention sweep), so
    // its editor closes and the draft becomes a new answer's.
    await rewriteGets(page, (answers) => answers.filter((a) => a.questionId !== "G18"));
    const g18 = card(page, "G18");
    await g18.locator("button.q-edit").click();
    await saveOn(card(page, "G19"), "G19 saved.");
    await g18.locator("textarea.q-text").focus();
    await expect(g18.locator(".q-answer")).toHaveCount(0);
    await expect(g18.locator(".q-msg")).toHaveText(
      "The answer you were editing was removed. Your text is kept below; saving it adds it as a new answer.",
    );
    // Its Cancel is the carried draft's discard (fix round 2).
    await expect(g18.locator("button.q-cancel")).toHaveCount(1);
    await expect(g18.locator("textarea.q-text")).toHaveValue("G18 version one.");
    await expect(g18.locator("textarea.q-text")).toBeFocused();
    expectClean(seen);
  });

  test("an edit Save the server refuses: the card holds focus, whatever the refusal", async ({ page }) => {
    const seen = await openFocus(page);
    const g20 = card(page, "G20");
    await g20.locator("button.q-edit").click();
    await g20.locator("textarea.q-text").fill("G20 edit.");
    const refusals: [string, (route: Route) => Promise<void>][] = [
      ["400", (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Refused for the test." }) })],
      ["403", (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Not yours." }) })],
      ["409", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "x", code: "version_conflict" }) })],
      ["network", (r) => r.abort()],
    ];
    for (const [name, refuse] of refusals) {
      await page.route("**/api/wiki/answers", (route) => (route.request().method() === "POST" ? refuse(route) : route.fallback()));
      await g20.locator("form.q-composer button.q-save").click();
      await expect(g20.locator(".q-msg"), name).toBeVisible();
      await expect(g20.locator("form.q-composer button.q-save"), name).toBeEnabled();
      await expect(g20, name).toBeFocused();
      await page.unroute("**/api/wiki/answers");
    }
    await expect(g20.locator("textarea.q-text")).toHaveValue("G20 edit.");
    expect(seen.errors).toEqual([]);
  });

  test("an edit Save that works: focus lands on the answer's Edit", async ({ page }) => {
    const seen = await openFocus(page);
    const g21 = card(page, "G21");
    await g21.locator("button.q-edit").click();
    await g21.locator("textarea.q-text").fill("G21 edited.");
    await g21.locator("form.q-composer button.q-save").click();
    await expect(g21.locator(".q-edited")).toHaveText("· edited 1×");
    await expect(g21.locator("button.q-edit")).toBeFocused();
    expectClean(seen);
  });

  test("a 409 whose reload answers answerable:false shows the conflict and offers to load again", async ({ page }) => {
    const seen = await openFocus(page);
    await page.route("**/api/wiki/answers", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "x", code: "version_conflict" }) })
        : route.fallback(),
    );
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answerable: false, answers: [] }) })
        : route.fallback(),
    );
    const g22 = card(page, "G22");
    await g22.locator("textarea.q-text").fill("G22 text.");
    await g22.locator("button.q-save").click();
    const msg = g22.locator(".q-msg-warn");
    // Load again appears only once the reload has answered.
    await expect(msg.locator("button.q-retry")).toBeVisible();
    await expect(msg).toContainText("This answer changed somewhere else.");
    await expect(msg).toContainText("Answers could not be loaded.");
    await expect(g22.locator("textarea.q-text")).toHaveValue("G22 text.");
    expect(seen.failed).toEqual(["409 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });
});


test.describe("Wiki reader: the admin Redact control (PR 5 fix round 1)", () => {
  const openRedact = async (page: Page) => {
    const seen = await openPage(page, WIKI, REDACT_REL);
    await expect(card(page, "R1").locator(".q-answer")).toHaveCount(1);
    return seen;
  };
  const redactPosts = (page: Page) => {
    const posts: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/wiki/answers/redact") posts.push(r.method());
    });
    return posts;
  };

  test("Escape inside the confirm cancels it and puts focus back on Redact…", async ({ page }) => {
    const seen = await openRedact(page);
    const posts = redactPosts(page);
    const r1 = card(page, "R1");
    await r1.locator("button.q-redact").click();
    await expect(r1.locator("button.q-redact-no")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(r1.locator(".q-redact-confirm")).toHaveCount(0);
    await expect(r1.locator("button.q-redact")).toBeFocused();
    // From the Redact button inside the confirm too.
    await r1.locator("button.q-redact").click();
    await r1.locator("button.q-redact-yes").focus();
    await page.keyboard.press("Escape");
    await expect(r1.locator(".q-redact-confirm")).toHaveCount(0);
    await expect(r1.locator("button.q-redact")).toBeFocused();
    expect(posts).toEqual([]);
    await expect(r1.locator(".q-answer-body")).toHaveText("R1 text.");
    expectClean(seen);
  });

  test("the confirm closes when a reload shows the answer redacted elsewhere; the card holds focus", async ({ page }) => {
    const seen = await openRedact(page);
    const r2 = card(page, "R2");
    await r2.locator("button.q-redact").click();
    await page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { answers: Record<string, unknown>[] };
      const answers = body.answers.map((a) => (a.questionId === "R2" ? { ...a, redacted: true, body: "", choice: null } : a));
      await route.fulfill({ response: res, json: { ...body, answers } });
    });
    await page.route("**/api/wiki/answers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const res = await route.fetch();
      await sleep(600);
      await route.fulfill({ response: res });
    });
    const r8 = card(page, "R8");
    await r8.locator("textarea.q-text").fill("R8 saved.");
    await r8.locator("button.q-save").click();
    await r2.locator("button.q-redact-no").focus();
    await expect(r2.locator(".q-redacted")).toBeVisible();
    await expect(r2.locator(".q-redact-confirm")).toHaveCount(0);
    await expect(r2).toBeFocused();
    expectClean(seen);
  });

  test("a redact the server refuses: the reason in the reader's words, focus back on that answer's Redact…", async ({ page }) => {
    const seen = await openRedact(page);
    const r3 = card(page, "R3");
    const refusals: [string, (route: Route) => Promise<void>, string][] = [
      [
        "403",
        (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "only an admin may redact answers", code: "admin_only" }) }),
        "The answer was not redacted: you may not redact answers.",
      ],
      [
        "404",
        (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no such answer", code: "unknown_answer" }) }),
        "The answer was not redacted: the answer no longer exists.",
      ],
      ["network", (r) => r.abort(), "The answer was not redacted: could not reach the server."],
    ];
    for (const [name, refuse, text] of refusals) {
      await page.route("**/api/wiki/answers/redact", (route) => refuse(route));
      await r3.locator("button.q-redact").click();
      await r3.locator("button.q-redact-yes").click();
      await expect(r3.locator(".q-msg-error"), name).toHaveText(text);
      await expect(r3.locator("button.q-redact"), name).toBeFocused();
      await page.unroute("**/api/wiki/answers/redact");
    }
    await expect(r3.locator(".q-answer-body")).toHaveText("R3 text.");
    expect(seen.errors).toEqual([]);
  });

  test("a redact that works: the answer shows redacted and the card holds focus", async ({ page }) => {
    const seen = await openRedact(page);
    const r4 = card(page, "R4");
    await r4.locator("button.q-redact").click();
    await r4.locator("button.q-redact-yes").click();
    await expect(r4.locator(".q-redacted")).toBeVisible();
    await expect(r4.locator("button.q-redact")).toHaveCount(0);
    await expect(r4).toBeFocused();
    expectClean(seen);
  });

  test("a redact whose reload fails says it was redacted, shows it redacted and offers to load again", async ({ page }) => {
    const seen = await openRedact(page);
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) })
        : route.fallback(),
    );
    const r5 = card(page, "R5");
    await r5.locator("button.q-redact").click();
    await r5.locator("button.q-redact-yes").click();
    const msg = r5.locator(".q-msg-warn");
    await expect(msg).toContainText("The answer was redacted, but the answers could not be loaded again.");
    await expect(msg.locator("button.q-retry")).toBeVisible();
    await expect(r5.locator(".q-redacted")).toBeVisible();
    await expect(r5).not.toContainText("R5 text.");
    expect(seen.failed).toEqual(["500 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("an answer whose editor is open offers no Redact…; Edit closes an open confirm", async ({ page }) => {
    const seen = await openRedact(page);
    const r7 = card(page, "R7");
    await r7.locator("button.q-redact").click();
    await expect(r7.locator(".q-redact-confirm")).toBeVisible();
    await r7.locator("button.q-edit").click();
    await expect(r7.locator("form.q-composer")).toBeVisible();
    await expect(r7.locator(".q-redact-confirm")).toHaveCount(0);
    await expect(r7.locator("button.q-redact")).toHaveCount(0);
    await r7.locator("button.q-cancel").click();
    await expect(r7.locator("button.q-redact")).toBeVisible();
    expectClean(seen);
  });

  test("while a redact is out, that answer offers no Edit, and the editor never opens over it", async ({ page }) => {
    const seen = await openRedact(page);
    const r11 = card(page, "R11");
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/answers/redact", async (route) => {
      const res = await route.fetch();
      await gate;
      await route.fulfill({ response: res });
    });
    try {
      await r11.locator("button.q-redact").click();
      await r11.locator("button.q-redact-yes").click();
      await expect(r11.locator("button.q-redact-yes")).toHaveText("Redacting …");
      await expect(r11.locator("button.q-edit")).toHaveCount(0);
    } finally {
      release();
    }
    await expect(r11.locator(".q-redacted")).toBeVisible();
    await expect(r11.locator("form.q-composer")).toHaveCount(0);
    expectClean(seen);
  });

  test("an editor open on an answer a reload shows redacted closes, and its draft is gone", async ({ page }) => {
    const seen = await openRedact(page);
    const r12 = card(page, "R12");
    await r12.locator("button.q-edit").click();
    await r12.locator("textarea.q-text").fill("R12 text, being edited.");
    await page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { answers: Record<string, unknown>[] };
      const answers = body.answers.map((a) => (a.questionId === "R12" ? { ...a, redacted: true, body: "", choice: null } : a));
      await route.fulfill({ response: res, json: { ...body, answers } });
    });
    const r13 = card(page, "R13");
    await r13.locator("textarea.q-text").fill("R13 saved.");
    await r13.locator("button.q-save").click();
    await expect(r12.locator(".q-redacted")).toBeVisible();
    await expect(r12.locator("form.q-composer")).toHaveCount(0);
    await expect(page.locator("textarea.q-text")).toHaveCount(0);
    await expect(r12).not.toContainText("R12 text");
    expectClean(seen);
  });

  test("a redact that answers 404 loads the answers again: the gone answer leaves, with no Redact… left on it", async ({ page }) => {
    const seen = await openRedact(page);
    const r10 = card(page, "R10");
    await page.route("**/api/wiki/answers/redact", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no such answer", code: "unknown_answer" }) }),
    );
    await page.route("**/api/wiki/answers?*", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { answers: Record<string, unknown>[] };
      await route.fulfill({ response: res, json: { ...body, answers: body.answers.filter((a) => a.questionId !== "R10") } });
    });
    await r10.locator("button.q-redact").click();
    await r10.locator("button.q-redact-yes").click();
    await expect(r10.locator(".q-msg-error")).toHaveText("The answer was not redacted: the answer no longer exists.");
    await expect(r10.locator(".q-answer")).toHaveCount(0);
    await expect(r10.locator("button.q-redact")).toHaveCount(0);
    await expect(r10).toBeFocused();
    expect(seen.errors).toEqual([]);
  });

  test("Escape in the confirm in focus mode closes the confirm and leaves focus mode on", async ({ page }) => {
    const seen = await openRedact(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
    const r14 = card(page, "R14");
    await r14.locator("button.q-redact").click();
    await expect(r14.locator("button.q-redact-no")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(r14.locator(".q-redact-confirm")).toHaveCount(0);
    await expect(r14.locator("button.q-redact")).toBeFocused();
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the confirm's Cancel border reads at 3:1 on the error tint, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openRedact(page);
      const r9 = card(page, "R9");
      await r9.locator("button.q-redact").click();
      await page.mouse.move(0, 0);
      const soft = await page.evaluate(() => {
        const p = document.createElement("span");
        p.style.color = "var(--text-soft)";
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      });
      const no = r9.locator("button.q-redact-no");
      expect(await no.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(soft);
      const ratio = await no.evaluate((el) => {
        const lum = (c: string) => {
          const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number) as [number, number, number];
          const ch = (v: number) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        const a = lum(getComputedStyle(el).borderTopColor);
        const b = lum(getComputedStyle(el.closest(".q-redact-confirm")!).backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
      expectClean(seen);
    });
  }
});

const f9Text = (page: Page) => card(page, "F9").locator("textarea.q-text");

test.describe("Wiki reader: an answer swept while it is being edited (PR 5b fix round 1)", () => {
  const sweep = (questionId: string) =>
    sql!`DELETE FROM wiki_answers WHERE wiki = ${WIKI} AND rel_path = ${SWEEP_REL} AND question_id = ${questionId}`;
  const GONE = "The answer you were editing was removed. Your text is kept below; saving it adds it as a new answer.";

  test("rows deleted between Edit and Save: the draft moves into the new-answer composer, and saves as a new answer", async ({ page }) => {
    const seen = await openPage(page, WIKI, SWEEP_REL);
    const s1 = card(page, "S1");
    await expect(s1.locator(".q-answer")).toHaveCount(1);
    const before = (await rowsFor("S1", SWEEP_REL))[0]!.answer_id as string;
    await s1.locator("button.q-edit").click();
    await s1.locator("input[type=radio][value=B]").check();
    await s1.locator("textarea.q-text").fill("S1 edited after the sweep.");
    await sweep("S1");
    await s1.locator("button.q-save").click();

    await expect(s1.locator(".q-msg")).toHaveText(GONE);
    await expect(s1.locator(".q-answer")).toHaveCount(0);
    // One composer, the NEW-answer one, holding the draft; its Cancel discards it.
    await expect(s1.locator("form.q-composer")).toHaveCount(1);
    await expect(s1.locator("form.q-composer")).not.toHaveClass(/q-composer-edit/);
    await expect(s1.locator("button.q-cancel")).toHaveCount(1);
    await expect(s1.locator("textarea.q-text")).toHaveValue("S1 edited after the sweep.");
    await expect(s1.locator("input[type=radio][value=B]")).toBeChecked();

    await s1.locator("button.q-save").click();
    await expect(s1.locator(".q-answer")).toHaveCount(1);
    await expect(s1.locator(".q-msg")).toHaveCount(0);
    const rows = await rowsFor("S1", SWEEP_REL);
    expect(rows.map((r) => ({ version: r.version, choice: r.choice, body: r.body }))).toEqual([
      { version: 1, choice: "B", body: "S1 edited after the sweep." },
    ]);
    expect(rows[0]!.answer_id).not.toBe(before);
    expect(seen.errors).toEqual([]);
  });

  test("a reload that shows the edited answer gone (another card's save) carries the draft into the composer", async ({ page }) => {
    const seen = await openPage(page, WIKI, SWEEP_REL);
    const s3 = card(page, "S3");
    await expect(s3.locator(".q-answer")).toHaveCount(1);
    await s3.locator("button.q-edit").click();
    await s3.locator("textarea.q-text").fill("S3 text, mid-edit.");
    await sweep("S3");
    const s4 = card(page, "S4");
    await s4.locator("textarea.q-text").fill("S4 saved.");
    await s4.locator("button.q-save").click();

    await expect(s3.locator(".q-msg")).toHaveText(GONE);
    await expect(s3.locator(".q-answer")).toHaveCount(0);
    await expect(s3.locator("button.q-cancel")).toHaveCount(1);
    await expect(s3.locator("textarea.q-text")).toHaveValue("S3 text, mid-edit.");
    expectClean(seen);
  });

  test("the viewer has another answer to the same question: the carried draft keeps its composer, no Edit can overwrite it, and it saves as a new answer", async ({ page }) => {
    const seen = await openPage(page, WIKI, SWEEP_REL);
    const s5 = card(page, "S5");
    await expect(s5.locator(".q-answer")).toHaveCount(2);
    const rows = await rowsFor("S5", SWEEP_REL);
    const swept = rows.find((r) => r.body === "S5 first answer.")!.answer_id as string;
    const kept = rows.find((r) => r.body === "S5 second answer.")!.answer_id as string;
    await s5.locator(`button.q-edit[data-answer-id="${swept}"]`).click();
    await s5.locator("textarea.q-text").fill("S5 typed before the sweep.");
    await sql!`DELETE FROM wiki_answers WHERE answer_id = ${swept}`;
    await s5.locator("button.q-save").click();

    await expect(s5.locator(".q-msg")).toHaveText(GONE);
    await expect(s5.locator(".q-answer")).toHaveCount(1);
    // The line says the text is kept below: it is, in a new-answer composer.
    await expect(s5.locator("form.q-composer")).toHaveCount(1);
    await expect(s5.locator("form.q-composer")).not.toHaveClass(/q-composer-edit/);
    await expect(s5.locator("textarea.q-text")).toHaveValue("S5 typed before the sweep.");
    // The other answer offers no Edit while the draft is kept: one would overwrite it.
    await expect(s5.locator("button.q-edit")).toHaveCount(0);

    await s5.locator("button.q-save").click();
    await expect(s5.locator(".q-answer")).toHaveCount(2);
    await expect(s5.locator("form.q-composer")).toHaveCount(0);
    await expect(s5.locator("button.q-edit")).toHaveCount(2);
    const after = await rowsFor("S5", SWEEP_REL);
    expect(after.map((r) => r.body).sort()).toEqual(["S5 second answer.", "S5 typed before the sweep."]);
    expect(after.some((r) => r.answer_id === kept)).toBe(true);
    expect(seen.errors).toEqual([]);
  });

  test("Cancel on a carried draft discards it and gives the other answer its Edit back", async ({ page }) => {
    const seen = await openPage(page, WIKI, SWEEP_REL);
    const s8 = card(page, "S8");
    await expect(s8.locator(".q-answer")).toHaveCount(2);
    const target = (await rowsFor("S8", SWEEP_REL)).find((r) => r.body === "S8 first answer.")!.answer_id as string;
    await s8.locator(`button.q-edit[data-answer-id="${target}"]`).click();
    await s8.locator("textarea.q-text").fill("S8 draft to discard.");
    await sql!`DELETE FROM wiki_answers WHERE answer_id = ${target}`;
    await s8.locator("button.q-save").click();
    await expect(s8.locator(".q-msg")).toHaveText(GONE);
    await expect(s8.locator("textarea.q-text")).toHaveValue("S8 draft to discard.");

    await s8.locator("button.q-cancel").click();
    await expect(s8.locator("form.q-composer")).toHaveCount(0);
    await expect(s8.locator(".q-msg")).toHaveCount(0);
    await expect(s8.locator("button.q-edit")).toHaveCount(1);
    await s8.locator("button.q-edit").click();
    await expect(s8.locator("textarea.q-text")).toHaveValue("S8 second answer.");
    expect(seen.errors).toEqual([]);
  });

  test("a reload from another card landing while the edit's save is out leaves the editor alone; the 404 then carries the draft", async ({ page }) => {
    const seen = await openPage(page, WIKI, SWEEP_REL);
    const s6 = card(page, "S6");
    await expect(s6.locator(".q-answer")).toHaveCount(1);
    const s6Id = (await rowsFor("S6", SWEEP_REL))[0]!.answer_id as string;
    // Hold S6's save until S7's save and reload have landed.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let s6Posted!: () => void;
    const s6Out = new Promise<void>((r) => (s6Posted = r));
    await page.route("**/api/wiki/answers", async (route) => {
      const req = route.request();
      if (req.method() !== "POST" || !(req.postData() ?? "").includes('"questionId":"S6"')) return route.fallback();
      s6Posted();
      await released;
      await route.continue();
    });
    await s6.locator("button.q-edit").click();
    await s6.locator("textarea.q-text").fill("S6 typed, saving.");
    await s6.locator("button.q-save").click();
    await s6Out;
    await sql!`DELETE FROM wiki_answers WHERE answer_id = ${s6Id}`;
    const s7 = card(page, "S7");
    await s7.locator("textarea.q-text").fill("S7 saved.");
    await s7.locator("button.q-save").click();
    await expect(s7.locator(".q-answer")).toHaveCount(1);
    // That reload no longer lists S6's answer, but its save is still out.
    await expect(s6.locator(".q-answer")).toHaveCount(0);
    await expect(s6.locator(".q-msg")).toHaveCount(0);
    release();

    await expect(s6.locator(".q-msg")).toHaveText(GONE);
    await expect(s6.locator("textarea.q-text")).toHaveValue("S6 typed, saving.");
    await expect(s6.locator("form.q-composer")).not.toHaveClass(/q-composer-edit/);
    expect(seen.errors).toEqual([]);
  });
});

test.describe("Wiki reader: a save the server refuses for good", () => {
  test("an edit whose answer an admin redacted meanwhile: the editor closes, its draft is gone, and the card shows the answer redacted", async ({ page }) => {
    const seen = await openPage(page, WIKI, TERMINAL_REL);
    const t1 = card(page, "T1");
    await expect(t1.locator(".q-answer")).toHaveCount(1);
    await t1.locator("button.q-edit").click();
    await t1.locator("textarea.q-text").fill("T1 draft, redacted under it.");
    // The admin's redact, elsewhere: the real route, so the save meets the real 409.
    const answerId = (await rowsFor("T1", TERMINAL_REL))[0]!.answer_id as string;
    const res = await fetch(`${BASE}/api/wiki/answers/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answerId }),
    });
    expect(res.status).toBe(200);
    await t1.locator("button.q-save").click();

    await expect(t1.locator(".q-msg-error")).toHaveText("The answer you were editing was redacted. Your change was not saved.");
    await expect(t1.locator(".q-redacted")).toBeVisible();
    await expect(t1.locator("form.q-composer")).toHaveCount(0);
    await expect(t1.locator("textarea.q-text")).toHaveCount(0);
    await expect(t1).not.toContainText("T1 draft");
    expect(seen.failed).toEqual(["409 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("the same refusal whose reload fails: the editor still closes and the answer still shows redacted", async ({ page }) => {
    const seen = await openPage(page, WIKI, TERMINAL_REL);
    const t3 = card(page, "T3");
    await expect(t3.locator(".q-answer")).toHaveCount(1);
    await t3.locator("button.q-edit").click();
    await t3.locator("textarea.q-text").fill("T3 draft, redacted under it.");
    const answerId = (await rowsFor("T3", TERMINAL_REL))[0]!.answer_id as string;
    const res = await fetch(`${BASE}/api/wiki/answers/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answerId }),
    });
    expect(res.status).toBe(200);
    await page.route("**/api/wiki/answers?*", (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback(),
    );
    await t3.locator("button.q-save").click();

    await expect(t3.locator(".q-msg-error")).toHaveText("The answer you were editing was redacted. Your change was not saved.");
    await expect(t3.locator(".q-redacted")).toBeVisible();
    await expect(t3.locator("textarea.q-text")).toHaveCount(0);
    await expect(t3.locator("button.q-edit")).toHaveCount(0);
    await expect(t3).not.toContainText("T3 version one.");
    await expect(t3).not.toContainText("T3 draft");
    expect(seen.failed).toEqual(["409 /api/wiki/answers", "500 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });

  test("a new answer to a question closed meanwhile: no composer, the card reads Closed, and says why", async ({ page }) => {
    const seen = await openPage(page, WIKI, TERMINAL_REL);
    const t2 = card(page, "T2");
    await expect(t2.locator(".q-state")).toHaveText("Open");
    await t2.locator("textarea.q-text").fill("T2 text, written as it closed.");
    await writeFile(path.join(base, "a", TERMINAL_REL), terminalPage(true), "utf8");
    await t2.locator("button.q-save").click();

    await expect(t2.locator(".q-msg-error")).toHaveText("The answer was not saved: the question was closed while you were writing.");
    await expect(t2.locator("form.q-composer")).toHaveCount(0);
    await expect(t2.locator("textarea.q-text, button.q-save")).toHaveCount(0);
    await expect(t2.locator(".q-state")).toHaveText("Closed");
    await expect(t2).toHaveClass(/\bq-closed\b/);
    await expect(t2).not.toHaveClass(/\bq-open\b/);
    expect(await rowsFor("T2", TERMINAL_REL)).toHaveLength(0);
    expect(seen.failed).toEqual(["409 /api/wiki/answers"]);
    expect(seen.errors).toEqual([]);
  });
});

test.describe("Wiki reader: the answer card's look", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`new text-on-tint pairs read at 4.5:1 on their tokens, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page, WIKI, STYLE_REL);
      await expect(card(page, "C1").locator(".q-answer")).toHaveCount(1);
      await card(page, "C1").locator(".q-log > summary").click();
      await page.mouse.move(0, 0);
      const token = (name: string) =>
        page.evaluate((v) => {
          const p = document.createElement("span");
          p.style.color = `var(${v})`;
          document.body.appendChild(p);
          const c = getComputedStyle(p).color;
          p.remove();
          return c;
        }, name);
      const soft = await token("--text-soft");
      const primary = await token("--text-primary");
      const c1 = card(page, "C1");
      const c3 = card(page, "C3");
      const pinned: [string, ReturnType<Page["locator"]>, string][] = [
        ["by line", c1.locator(".q-answer > .q-by").first(), soft],
        ["counter", c3.locator(".q-count"), soft],
        ["log summary", c1.locator(".q-log > summary"), soft],
        ["author", c1.locator(".q-author"), primary],
        ["asked", c1.locator(".q-asked"), primary],
        ["not asked", card(page, "C4").locator(".q-asked"), soft],
        ["choice chip", c1.locator(".q-answer > .q-pick"), primary],
        ["answered pill", c1.locator(".q-state"), primary],
        ["new badge", card(page, "C2").locator(".q-new"), primary],
        ["composer choice", c3.locator(".q-choice").first(), primary],
        ["edit button", c1.locator("button.q-edit"), primary],
      ];
      await expect(card(page, "C2").locator(".q-new")).toHaveText("1 new");
      await expect(card(page, "C4").locator(".q-asked")).toHaveText("not asked");
      // "not asked" is muted, not a third warning: its fill differs from the
      // Answered pill's and the "N new" badge's.
      const bg = (loc: ReturnType<Page["locator"]>) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
      const notAskedBg = await bg(card(page, "C4").locator(".q-asked"));
      expect(notAskedBg).not.toBe(await bg(c1.locator(".q-state")));
      expect(notAskedBg).not.toBe(await bg(card(page, "C2").locator(".q-new")));
      for (const [name, loc, color] of pinned) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), `${name} token`).toBe(color);
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      // The answer body and the textarea's own text.
      expect(await paintedContrast(c1.locator(".q-answer > .q-answer-body")), "body contrast").toBeGreaterThanOrEqual(4.5);
      await c3.locator("textarea.q-text").fill("typed");
      expect(await paintedContrast(c3.locator("textarea.q-text")), "textarea contrast").toBeGreaterThanOrEqual(4.5);
      expect(await paintedContrast(c3.locator("button.q-save")), "save contrast").toBeGreaterThanOrEqual(4.5);
      // Over the cap, the composer says why Save is disabled.
      await c3.locator("textarea.q-text").fill("x".repeat(8002));
      const over = c3.locator(".q-over");
      await expect(over).toBeVisible();
      await expect(over).toHaveText("Too long: remove 2 characters to save.");
      await expect(c3.locator("button.q-save")).toBeDisabled();
      expect(await over.evaluate((el) => getComputedStyle(el).color), "over-cap token").toBe(primary);
      expect(await paintedContrast(over), "over-cap contrast").toBeGreaterThanOrEqual(4.5);
      await c3.locator("textarea.q-text").fill("typed");
      await expect(over).toBeHidden();
      // The Clear choice control, once a choice is picked.
      await c3.locator(".q-choice").first().click();
      const clear = c3.locator("button.q-clear-choice");
      await expect(clear).toBeVisible();
      expect(await paintedContrast(clear), "clear choice contrast").toBeGreaterThanOrEqual(4.5);
      await clear.click();

      // The two message tones, from stubbed refusals (no row is written).
      await page.route("**/api/wiki/answers", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "a refusal", code: "x" }) })
          : route.fallback(),
      );
      await c3.locator("button.q-save").click();
      const err = c3.locator(".q-msg-error");
      await expect(err).toHaveText("The answer was not saved: a refusal");
      expect(await paintedContrast(err), "error message contrast").toBeGreaterThanOrEqual(4.5);
      await page.unroute("**/api/wiki/answers");
      await page.route("**/api/wiki/answers", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "x", code: "version_conflict" }) })
          : route.fallback(),
      );
      await c3.locator("textarea.q-text").fill("typed again");
      await c3.locator("button.q-save").click();
      const warn = c3.locator(".q-msg-warn");
      await expect(warn).toBeVisible();
      expect(await paintedContrast(warn), "warn message contrast").toBeGreaterThanOrEqual(4.5);
      expect(seen.errors).toEqual([]);
    });
  }

  test("at 390px in focus mode the cards do not scroll the page sideways", async ({ page }) => {
    const seen = await openPage(page, WIKI, STYLE_REL);
    await expect(card(page, "C1").locator(".q-answer")).toHaveCount(1);
    await card(page, "C1").locator(".q-log > summary").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    const m = await page.evaluate(() => {
      const art = document.querySelector(".wiki-article")!.getBoundingClientRect().right;
      const all = Array.from(document.querySelectorAll(".wiki-article section.question")).flatMap((s) => [
        s,
        ...Array.from(s.querySelectorAll("*")),
      ]);
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth + 1,
        checked: all.length,
        overflow: all
          .filter((e) => e.getBoundingClientRect().right > art + 1)
          .map((e) => `${e.tagName.toLowerCase()}.${e.className} +${Math.round(e.getBoundingClientRect().right - art)}px`),
      };
    });
    expect(m.page).toBe(true);
    expect(m.checked).toBeGreaterThan(30);
    expect(m.overflow).toEqual([]);
    // No "·" sits in a by line as a bare text node, where a wrap could leave
    // it alone at the start of a line.
    const bare = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".wiki-article .q-by")).flatMap((by) =>
        Array.from(by.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").includes("·"))
          .map((n) => n.textContent),
      ),
    );
    expect(bare).toEqual([]);
    expectClean(seen);
  });
});

test.describe("Wiki reader: answer groups (WIKI_ANSWER_GROUPS)", () => {
  const answerBy = (page: Page, body: string) =>
    card(page, "H1").locator(".q-answer").filter({ has: page.locator(".q-answer-body", { hasText: body }) });
  const chips = (loc: Locator) =>
    loc.locator(".q-by .q-group").evaluateAll((els) => els.map((e) => e.lastChild?.textContent ?? ""));

  test('a to="fag" card names the group; a member is asked with its chips, a non-member is not; no ident reaches the page', async ({ page }) => {
    const seen = await openPage(page, WIKI, GROUPS_REL);
    const h1 = card(page, "H1");
    await expect(h1.locator(".q-for")).toHaveText("For fag");
    await expect(h1.locator(".q-answer")).toHaveCount(2);
    const member = answerBy(page, "From a fag member.");
    await expect(member.locator(".q-asked")).toHaveText("asked");
    expect(await chips(member)).toEqual(["fag", "utvikler"]);
    await expect(member.locator(".q-group").first()).toHaveText("group fag");
    const dev = answerBy(page, "From a developer.");
    await expect(dev.locator(".q-asked")).toHaveText("not asked");
    expect(await chips(dev)).toEqual(["utvikler"]);
    expect(await page.content()).not.toMatch(/Z9900\d\d/);
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the group chip reads at 4.5:1 on its token, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page, WIKI, GROUPS_REL);
      const chip = answerBy(page, "From a developer.").locator(".q-group");
      await expect(chip).toHaveCount(1);
      const soft = await page.evaluate(() => {
        const p = document.createElement("span");
        p.style.color = "var(--text-soft)";
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      });
      expect(await chip.evaluate((el) => getComputedStyle(el).color), "group chip token").toBe(soft);
      expect(await paintedContrast(chip), "group chip contrast").toBeGreaterThanOrEqual(4.5);
      expectClean(seen);
    });
  }
});
