/**
 * Answers on the pod (answer cards PR 5): `MUNINN_PROFILE=nais`,
 * `MUNINN_AUTH=entra` against a stub Texas, one read-only wiki that takes
 * answers, and `WIKI_ANSWER_SCANNER` pointing at a synthetic stub module.
 *
 * What a unit test cannot see and this spec asserts on a real muninn:
 *
 *   1. The zone admits role `user` to GET and POST `/api/wiki/answers` and to
 *      nothing else under that path — export, confirm and redact are the zone's
 *      403 — while an admin (in `MUNINN_ADMIN_IDENTS`) reaches all of them.
 *   2. An answer is stored under the ENTRA identity (`users.id`, oid, NAV
 *      ident, read back out of Postgres) and labelled asked / not asked by the
 *      page's `questions_to:`.
 *   3. The scanner hook: a body carrying the stub's marker is 422 with the
 *      stub's own reason and nothing is stored; an ident-shaped string passes
 *      (what to refuse is the scanner's policy, which ships NAV-side). A second
 *      muninn with no scanner configured answers 503 to any body.
 *   4. The GET never carries an oid or a NAV ident, under any key.
 *   5. In the browser, a colleague's card is answerable and shows the
 *      scanner's reason; an admin's card offers Redact with an inline confirm.
 *   6. The «Oppfølging» block (reader lenses PR 3, acceptance 6) on a second
 *      read-only wiki with `roleKeys`, and two colleagues in two
 *      `WIKI_ANSWER_GROUPS` groups: each sees their own lane first and marked,
 *      fag answers the lane's questions in it with one composer per question,
 *      an utvikler's answer reads «ikke spurt» (D31), an admin's «Se som rolle»
 *      changes the view and no request, and no page payload carries a member's
 *      ident.
 *
 * The stub Texas is an in-process `node:http` server (Playwright runs this file
 * under Node), the `entra-identity.spec.ts` harness. Synthetic values only:
 * placeholder UUIDs, `X1000NN` idents, `Test …` names.
 *
 * SPAWN ENV: `e2eEnv()` blanks the platform tokens and the instance-profile
 * flags (the `MUNINN_AUTH` family and `WIKI_ANSWER_*` included), and this spec
 * sets them back deliberately. Two muninns: the CI process count in CLAUDE.md
 * includes both.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";
import { AUTHORED_ROLES, ROLE_PAGE, ROLE_READER_CONFIG, ROLE_REL } from "./oppfolging-fixture.ts";

const PORT = e2ePort("wiki-answers-nais");
const BASE = `http://127.0.0.1:${PORT}`;
const NO_SCANNER_PORT = e2ePort("wiki-answers-nais/no-scanner");
const NO_SCANNER_BASE = `http://127.0.0.1:${NO_SCANNER_PORT}`;
const TEXAS_PORT = e2ePort("wiki-answers-nais/texas");
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-felles-svar";
/** The second wiki: `roleKeys`, `language: no`, role lanes. */
const ROLE_WIKI = "e2e-felles-oppf";
const REL = "plans/svar.mdx";
const TENANT = "example-tenant";
const MARKER = "SYNTHETIC-SECRET-0000";
const STUB_REASON = "synthetic secret marker (test stub)";
const ZONE_REFUSAL = { error: "forbidden", reason: "admin-only route" };

/** One synthetic colleague per token. */
const PEOPLE = {
  asked: { token: "tok-asked", oid: "00000000-aaaa-4000-8000-000000000001", NAVident: "X100001", name: "Test Asked" },
  other: { token: "tok-other", oid: "00000000-aaaa-4000-8000-000000000002", NAVident: "X100002", name: "Test Other" },
  browser: { token: "tok-browser", oid: "00000000-aaaa-4000-8000-000000000003", NAVident: "X100003", name: "Test Browser" },
  admin: { token: "tok-admin", oid: "00000000-aaaa-4000-8000-000000000009", NAVident: "X100009", name: "Test Admin" },
  fag: { token: "tok-fag", oid: "00000000-aaaa-4000-8000-000000000011", NAVident: "X100011", name: "Test Fag" },
  utvikler: { token: "tok-utvikler", oid: "00000000-aaaa-4000-8000-000000000012", NAVident: "X100012", name: "Test Utvikler" },
} as const;
/** Two groups, one member each; the other colleagues are in none. */
const GROUP_MEMBERS = [PEOPLE.fag.NAVident, PEOPLE.utvikler.NAVident];
const GROUPS = `fag=${PEOPLE.fag.NAVident};utvikler=${PEOPLE.utvikler.NAVident}`;
type Person = (typeof PEOPLE)[keyof typeof PEOPLE];

const PAGE = [
  "---",
  "title: Testside for svar",
  'questions_to: ["Test Asked (X100001)"]',
  "---",
  "",
  "# Testside for svar",
  "",
  '<Question id="S1" choices="Ja|Nei">',
  "",
  "Skal vi gjøre dette?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **S1** — Spørsmål om dette.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

const SCANNER = `export function scanAnswer(text) {
  return text.includes("${MARKER}") ? [{ reason: "${STUB_REASON}" }] : [];
}
`;

let texas: Server | null = null;
const servers: ChildProcess[] = [];
let sql: ReturnType<typeof postgres> | null = null;
let root = "";
let roleRoot = "";
let botsDir = "";
let scannerDir = "";

function startTexas(): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let token = "";
        try {
          token = (JSON.parse(raw) as { token?: string }).token ?? "";
        } catch {
          /* answered inactive */
        }
        const person = Object.values(PEOPLE).find((p) => p.token === token);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            person
              ? { active: true, oid: person.oid, NAVident: person.NAVident, name: person.name, exp: Math.floor(Date.now() / 1000) + 3600 }
              : { active: false },
          ),
        );
      });
    });
    srv.listen(TEXAS_PORT, "127.0.0.1", () => resolve(srv));
  });
}

function boot(port: number, scanner: string): void {
  servers.push(
    spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...e2eEnv(),
        DATABASE_URL: TEST_DB,
        DASHBOARD_PORT: String(port),
        DASHBOARD_HOST: "127.0.0.1",
        SCHEDULER_ENABLED: "false",
        MUNINN_PROFILE: "nais",
        MUNINN_AUTH: "entra",
        NAIS_TOKEN_INTROSPECTION_ENDPOINT: `http://127.0.0.1:${TEXAS_PORT}/introspect`,
        MUNINN_TENANT: TENANT,
        MUNINN_ADMIN_IDENTS: PEOPLE.admin.NAVident,
        MUNINN_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        WIKI_EXTRA: `${WIKI}=${root},${ROLE_WIKI}=${roleRoot}`,
        WIKI_READONLY_ROOTS: `${root},${roleRoot}`,
        WIKI_ANSWER_WIKIS: `${WIKI},${ROLE_WIKI}`,
        WIKI_ANSWER_SCANNER: scanner,
        WIKI_ANSWER_GROUPS: GROUPS,
        MUNINN_BOTS_DIR: botsDir,
      },
      stdio: "ignore",
    }),
  );
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function clearRows(): Promise<void> {
  const oids = Object.values(PEOPLE).map((p) => p.oid);
  await sql!`DELETE FROM wiki_answers WHERE wiki = ANY(${[WIKI, ROLE_WIKI]})`;
  await sql!`DELETE FROM user_identities WHERE oid = ANY(${oids})`;
  await sql!`DELETE FROM users WHERE id = ANY(${Object.values(PEOPLE).map((p) => `nav-${p.NAVident.toLowerCase()}`)})`;
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(90_000);
  texas = await startTexas();
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await sql.unsafe(readFileSync(path.join(REPO_ROOT, "db/migrations/082-wiki-answers.sql"), "utf8"));
  await clearRows();
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answers-nais-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  roleRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-oppfolging-nais-"));
  await mkdir(path.join(roleRoot, "plans"), { recursive: true });
  await writeFile(path.join(roleRoot, ROLE_REL), ROLE_PAGE, "utf8");
  await writeFile(path.join(roleRoot, ".wiki-reader.json"), ROLE_READER_CONFIG, "utf8");
  botsDir = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answers-nais-bots-"));
  await mkdir(path.join(botsDir, "e2e-answers-bot"));
  await writeFile(path.join(botsDir, "e2e-answers-bot", "CLAUDE.md"), "# throwaway e2e bot, no wiki\n", "utf8");
  scannerDir = await mkdtemp(path.join(tmpdir(), "muninn-e2e-answers-scanner-"));
  const scanner = path.join(scannerDir, "scanner-stub.mjs");
  await writeFile(scanner, SCANNER, "utf8");
  boot(PORT, scanner);
  boot(NO_SCANNER_PORT, "");
  await Promise.all([waitUp(BASE), waitUp(NO_SCANNER_BASE)]);
});

test.afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  texas?.close();
  if (sql) await clearRows();
  await sql?.end();
  for (const d of [root, roleRoot, botsDir, scannerDir]) if (d) await rm(d, { recursive: true, force: true });
});

const bearer = (p: Person) => ({ authorization: `Bearer ${p.token}` });

async function call(base: string, who: Person, pathAndQuery: string, body?: unknown) {
  const res = await fetch(`${base}${pathAndQuery}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...bearer(who), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json: json as Record<string, unknown> | null, text };
}

const answersQuery = `/api/wiki/answers?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}&versions=1`;
const answerBody = (over: Record<string, unknown> = {}) => ({ wiki: WIKI, relPath: REL, questionId: "S1", choice: "Ja", ...over });

/** Every object key anywhere in a JSON value. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

test.describe("role user on the pod — the zone and the store", () => {
  test("GET and POST /api/wiki/answers pass the zone; the page flags the card answerable, without export", async () => {
    const get = await call(BASE, PEOPLE.asked, answersQuery);
    expect(get.status).toBe(200);
    expect(get.json).toEqual({ answerable: true, answers: [] });
    const page = await call(BASE, PEOPLE.asked, `/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    expect(page.status).toBe(200);
    expect(page.json!.answers).toEqual({ answerable: true, canExport: false });
  });

  test("an answer is stored under the Entra identity and labelled asked; another colleague's is not asked", async () => {
    const mine = await call(BASE, PEOPLE.asked, "/api/wiki/answers", answerBody({ body: "Ja, med en merknad." }));
    expect(mine.status).toBe(201);
    const [row] = await sql!`
      SELECT author_user_id, author_oid, author_nav_ident, author_name FROM wiki_answers WHERE answer_id = ${String(mine.json!.answerId)}
    `;
    expect(row).toEqual({
      author_user_id: "nav-x100001",
      author_oid: PEOPLE.asked.oid,
      author_nav_ident: "X100001",
      author_name: "Test Asked",
    });
    // An ident-shaped string is the NAV scanner's call, not muninn's: the stub passes it.
    const other = await call(BASE, PEOPLE.other, "/api/wiki/answers", answerBody({ choice: "Nei", body: "Nei. Se sak for Z123456." }));
    expect(other.status).toBe(201);

    const get = await call(BASE, PEOPLE.other, answersQuery);
    const answers = (get.json!.answers as { authorName: string; asked: boolean | null; mine: boolean }[]).map((a) => [
      a.authorName,
      a.asked,
      a.mine,
    ]);
    expect(answers).toEqual([
      ["Test Asked", true, false],
      ["Test Other", false, true],
    ]);
  });

  test("a body the scanner flags is 422 with the scanner's reason, and nothing is stored", async () => {
    const before = (await sql!`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI}`)[0]!.n;
    const res = await call(BASE, PEOPLE.other, "/api/wiki/answers", answerBody({ body: `kopiert inn: ${MARKER}` }));
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ error: "scanner_refused", code: "scanner_refused", reasons: [STUB_REASON] });
    expect((await sql!`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI}`)[0]!.n).toBe(before);
  });

  test("the GET carries no oid and no NAV ident, under any key or as any value", async () => {
    for (const who of [PEOPLE.asked, PEOPLE.other, PEOPLE.admin]) {
      const get = await call(BASE, who, answersQuery);
      expect(get.status).toBe(200);
      const keys = allKeys(get.json);
      for (const k of ["oid", "navIdent", "author_oid", "author_nav_ident", "authorOid", "authorNavIdent", "author"]) {
        expect(keys.has(k), k).toBe(false);
      }
      for (const p of Object.values(PEOPLE)) {
        expect(get.text).not.toContain(p.oid);
        expect(get.text).not.toContain(p.NAVident);
      }
    }
  });

  test("export, confirm and redact are the zone's 403 for role user", async () => {
    const { answers } = (await call(BASE, PEOPLE.asked, answersQuery)).json as { answers: { answerId: string; version: number }[] };
    const id = answers[0]!.answerId;
    const exp = await call(BASE, PEOPLE.asked, `/api/wiki/answers/export?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    const confirm = await call(BASE, PEOPLE.asked, "/api/wiki/answers/export/confirm", { wiki: WIKI, relPath: REL, rows: [[id, 1]] });
    const redact = await call(BASE, PEOPLE.asked, "/api/wiki/answers/redact", { answerId: id });
    for (const r of [exp, confirm, redact]) {
      expect(r.status).toBe(403);
      expect(r.json).toEqual(ZONE_REFUSAL);
    }
    const [row] = await sql!`SELECT exported_at, redacted_at FROM wiki_answers WHERE answer_id = ${id}`;
    expect(row).toEqual({ exported_at: null, redacted_at: null });
  });
});

test.describe("an admin on the pod", () => {
  test("exports, confirms and redacts; the GET then says redacted", async () => {
    const exp = await call(BASE, PEOPLE.admin, `/api/wiki/answers/export?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    expect(exp.status).toBe(200);
    expect(exp.json!.block).toContain("### S1 — Test Asked (asked)");
    expect(exp.json!.block).toContain("### S1 — Test Other (not asked)");
    const rows = exp.json!.rows as [string, number][];
    const confirm = await call(BASE, PEOPLE.admin, "/api/wiki/answers/export/confirm", { wiki: WIKI, relPath: REL, rows });
    expect(confirm.status).toBe(200);
    expect(confirm.json).toEqual({ marked: 2 });

    const target = rows[0]![0];
    const redact = await call(BASE, PEOPLE.admin, "/api/wiki/answers/redact", { answerId: target });
    expect(redact.status).toBe(200);
    expect(redact.json).toMatchObject({ answerId: target, redacted: true, versions: 1, alreadyRedacted: false });
    const get = await call(BASE, PEOPLE.asked, answersQuery);
    const a = (get.json!.answers as { answerId: string; redacted: boolean; body: string; choice: string | null }[]).find(
      (x) => x.answerId === target,
    );
    expect(a).toMatchObject({ redacted: true, body: "", choice: null });
  });
});

test.describe("the pod with no scanner configured", () => {
  test("any answer with a body is 503 scanner_unavailable; a choice alone is stored", async () => {
    const before = (await sql!`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI}`)[0]!.n;
    const res = await call(NO_SCANNER_BASE, PEOPLE.browser, "/api/wiki/answers", answerBody({ body: "Hei." }));
    expect(res.status).toBe(503);
    expect(res.json!.code).toBe("scanner_unavailable");
    expect((await sql!`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI}`)[0]!.n).toBe(before);
    const choiceOnly = await call(NO_SCANNER_BASE, PEOPLE.admin, "/api/wiki/answers", answerBody({ body: "" }));
    expect(choiceOnly.status).toBe(201);
  });
});

/** Every request to this muninn carries the person's bearer token, as the
 *  sidecar forwards it; nothing else gets the header. */
async function asPerson(page: Page, who: Person): Promise<void> {
  await page.route(`${BASE}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${who.token}` } }),
  );
}

const card = (page: Page) => page.locator('.wiki-article section.question[data-question-id="S1"]');

test.describe("the card in the browser", () => {
  test("a colleague's card is answerable, shows the scanner's reason, then saves; it offers no Redact", async ({ page }) => {
    await asPerson(page, PEOPLE.browser);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    const c = card(page);
    await expect(c).toHaveAttribute("data-wiki-answerable", "true");
    const composer = c.locator("form.q-composer");
    await expect(composer).toBeVisible();
    await expect(c.locator("button.q-redact")).toHaveCount(0);

    await composer.locator("textarea.q-text").fill(`limt inn ${MARKER} ved et uhell`);
    await composer.locator("button.q-save").click();
    await expect(c.locator(".q-msg-error")).toContainText(STUB_REASON);
    // The draft survives the refusal.
    await expect(composer.locator("textarea.q-text")).toHaveValue(`limt inn ${MARKER} ved et uhell`);

    await composer.locator("textarea.q-text").fill("Et rent svar.");
    await composer.locator("button.q-save").click();
    const mine = c.locator(".q-answer", { hasText: "Et rent svar." });
    await expect(mine).toBeVisible();
    await expect(mine.locator(".q-author")).toHaveText("Test Browser");
    await expect(mine.locator(".q-asked-no")).toBeVisible();
    await expect(c.locator("button.q-redact")).toHaveCount(0);
  });

  test("an admin's card offers Redact… with an inline confirm; Cancel backs out, Redact empties the answer", async ({ page }) => {
    // Its own answer, so this test reads no other test's rows.
    const seeded = await call(BASE, PEOPLE.browser, "/api/wiki/answers", answerBody({ choice: null, body: "Et svar som skal fjernes." }));
    expect(seeded.status).toBe(201);
    const answerId = String(seeded.json!.answerId);
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await asPerson(page, PEOPLE.admin);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    const c = card(page);
    const target = c.locator(`.q-answer[data-answer-id="${answerId}"]`);
    await expect(target.locator("button.q-redact")).toHaveText("Redact…");

    await target.locator("button.q-redact").click();
    const confirm = target.locator(".q-redact-confirm");
    await expect(confirm).toBeVisible();
    await expect(target.locator("button.q-redact-no")).toBeFocused();
    await target.locator("button.q-redact-no").click();
    await expect(confirm).toHaveCount(0);
    await expect(target.locator("button.q-redact")).toBeFocused();

    await target.locator("button.q-redact").click();
    await target.locator("button.q-redact-yes").click();
    await expect(target.locator(".q-redacted")).toHaveText("redacted");
    await expect(target.locator("button.q-redact")).toHaveCount(0);
    await expect(c).not.toContainText("Et svar som skal fjernes.");
    expect(dialogs).toBe(0);
  });
});

// ── The «Oppfølging» block: role lanes on the pod (reader lenses PR 3) ──────

const roleUrl = `${BASE}/wiki?wiki=${ROLE_WIKI}&relPath=${encodeURIComponent(ROLE_REL)}`;
const lanes = (page: Page) => page.locator(".wiki-article .nm-compact > .nm-lanes > .nm-lane");
const laneRoles = (page: Page) => lanes(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.role ?? "-"));
const laneLabels = (page: Page) => lanes(page).locator(":scope > .nm-head > .nm-who").allTextContents();
const marks = (page: Page) =>
  lanes(page).evaluateAll((els) => els.map((e) => e.querySelector(":scope > .nm-head > .nm-mine-mark")?.textContent ?? ""));

async function openRolePage(page: Page, who: Person): Promise<void> {
  await asPerson(page, who);
  await page.goto(roleUrl);
  await expect(lanes(page)).toHaveCount(4);
}

test.describe("the «Oppfølging» block with two groups (acceptance 6)", () => {
  test("fag: «Venter på fag» first with «til deg», and both questions answered in the lane, one composer each", async ({ page }) => {
    await openRolePage(page, PEOPLE.fag);
    await expect.poll(() => laneRoles(page)).toEqual(["fag", "utvikler", "-", "utvikler"]);
    expect(await laneLabels(page)).toEqual(["Venter på fag", "Utvikler", "Venter på jus", "Blokkert"]);
    expect(await marks(page)).toEqual(["til deg", "", "", ""]);
    // The count line and the peeks match the lanes.
    await expect(page.locator(".wiki-article .nm-compact .nm-sum")).toHaveText(
      "2 oppgaver for utvikler · 2 spørsmål til fag · Venter på jus: 1 oppgave · 1 blokkert",
    );
    const fag = lanes(page).first();
    await expect(fag.locator(":scope > .nm-head > .nm-count")).toHaveText("2 spørsmål");
    await expect(fag.locator(":scope > .nm-head > .nm-peek")).toHaveText("S1: alternativ A eller B for brevet? · S2: hvilket brev gjelder det?");
    await expect(lanes(page).nth(1).locator(":scope > .nm-head > .nm-peek")).toHaveText("Send melding 3 til fag.");

    // One card per question on the page, both inside the fag lane; their
    // authored places keep a link.
    await expect(page.locator(".wiki-article section.question")).toHaveCount(2);
    await expect(page.locator(".wiki-article .q-moved-link")).toHaveText([
      "Spørsmål S1: svar under Oppfølging",
      "Spørsmål S2: svar under Oppfølging",
    ]);
    await fag.locator(":scope > .nm-head").click();
    for (const id of ["S1", "S2"]) {
      const c = fag.locator(`section.question[data-question-id="${id}"]`);
      await expect(c.locator("form.q-composer")).toHaveCount(1);
    }
    await expect(page.locator(".wiki-article form.q-composer")).toHaveCount(2);

    const s1 = fag.locator('section.question[data-question-id="S1"]');
    await s1.locator('form.q-composer input[type=radio][value="A"]').check();
    await s1.locator("form.q-composer textarea.q-text").fill("A, fra fag.");
    await s1.locator("form.q-composer button.q-save").click();
    const mine = s1.locator(".q-answer", { hasText: "A, fra fag." });
    await expect(mine.locator(".q-asked-yes")).toHaveText("spurt");
    // The chip carries a visually hidden «gruppe» before the key.
    await expect(mine.locator(".q-group")).toHaveText(/^gruppe\s*fag$/);

    // The one-line link reveals the card in its lane.
    await fag.locator(":scope > .nm-head").click();
    await expect(fag).not.toHaveAttribute("open", "");
    await page.locator('.wiki-article .q-moved-link[href="#nm-q-s2"]').click();
    await expect(fag).toHaveAttribute("open", "");
    await expect(fag.locator('section.question[data-question-id="S2"]')).toBeInViewport();
  });

  test("utvikler: «Utvikler» first with «deg», and an answer to fag's question carries «ikke spurt» (D31)", async ({ page }) => {
    await openRolePage(page, PEOPLE.utvikler);
    await expect.poll(() => laneRoles(page)).toEqual(["utvikler", "utvikler", "fag", "-"]);
    expect(await laneLabels(page)).toEqual(["Utvikler", "Blokkert", "Venter på fag", "Venter på jus"]);
    expect(await marks(page)).toEqual(["deg", "deg", "", ""]);
    const fag = lanes(page).nth(2);
    await fag.locator(":scope > .nm-head").click();
    const s2 = fag.locator('section.question[data-question-id="S2"]');
    // Outside the asked group, the composer is still there (D31).
    await s2.locator("form.q-composer textarea.q-text").fill("Svar fra utvikler.");
    await s2.locator("form.q-composer button.q-save").click();
    await expect(s2.locator(".q-answer", { hasText: "Svar fra utvikler." }).locator(".q-asked-no")).toHaveText("ikke spurt");
  });

  test("a colleague in no group sees the authored order and no mark, and gets no «Se som rolle»", async ({ page }) => {
    await openRolePage(page, PEOPLE.other);
    await expect.poll(() => laneRoles(page)).toEqual(AUTHORED_ROLES);
    expect(await marks(page)).toEqual(["", "", "", ""]);
    await expect(page.locator(".wiki-role-view")).toHaveCount(0);
  });

  test("an admin's «Se som rolle: fag» shows the fag view and sends no request", async ({ page }) => {
    await openRolePage(page, PEOPLE.admin);
    await expect.poll(() => laneRoles(page)).toEqual(AUTHORED_ROLES);
    const select = page.locator(".wiki-article-head .wiki-role-view select");
    await expect(select.locator("option")).toHaveText(["min visning", "fag", "utvikler"]);
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await select.selectOption("fag");
    await expect.poll(() => laneRoles(page)).toEqual(["fag", "utvikler", "-", "utvikler"]);
    expect(await marks(page)).toEqual(["til deg", "", "", ""]);
    await select.selectOption("utvikler");
    await expect.poll(() => laneRoles(page)).toEqual(["utvikler", "utvikler", "fag", "-"]);
    await select.selectOption("");
    await expect.poll(() => laneRoles(page)).toEqual(AUTHORED_ROLES);
    expect(await marks(page)).toEqual(["", "", "", ""]);
    expect(requests, "the switch is display only").toEqual([]);
    // The route answers the admin as before: no viewer role.
    const payload = await call(BASE, PEOPLE.admin, `/api/wiki/page?wiki=${ROLE_WIKI}&relPath=${encodeURIComponent(ROLE_REL)}`);
    expect((payload.json!.reader as { roles: unknown }).roles).toEqual({ keys: ["fag", "utvikler"], viewer: [], preview: true });
  });

  test("the page payload carries group keys, never a member's ident", async () => {
    const expected: [Person, string[], boolean][] = [
      [PEOPLE.fag, ["fag"], false],
      [PEOPLE.utvikler, ["utvikler"], false],
      [PEOPLE.other, [], false],
      [PEOPLE.admin, [], true],
    ];
    for (const [who, viewer, preview] of expected) {
      const res = await call(BASE, who, `/api/wiki/page?wiki=${ROLE_WIKI}&relPath=${encodeURIComponent(ROLE_REL)}`);
      expect(res.status).toBe(200);
      expect((res.json!.reader as { roles: unknown }).roles).toEqual({ keys: ["fag", "utvikler"], viewer, preview });
      for (const ident of GROUP_MEMBERS) expect(res.text, `${who.name}: ${ident}`).not.toContain(ident);
      const pages = await call(BASE, who, `/api/wiki/pages?wiki=${ROLE_WIKI}`);
      for (const ident of GROUP_MEMBERS) expect(pages.text).not.toContain(ident);
    }
  });
});
