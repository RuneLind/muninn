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

const PORT = e2ePort("wiki-answers-nais");
const BASE = `http://127.0.0.1:${PORT}`;
const NO_SCANNER_PORT = e2ePort("wiki-answers-nais/no-scanner");
const NO_SCANNER_BASE = `http://127.0.0.1:${NO_SCANNER_PORT}`;
const TEXAS_PORT = e2ePort("wiki-answers-nais/texas");
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-felles-svar";
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
} as const;
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
        WIKI_EXTRA: `${WIKI}=${root}`,
        WIKI_READONLY_ROOTS: root,
        WIKI_ANSWER_WIKIS: WIKI,
        WIKI_ANSWER_SCANNER: scanner,
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
  await sql!`DELETE FROM wiki_answers WHERE wiki = ${WIKI}`;
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
  for (const d of [root, botsDir, scannerDir]) if (d) await rm(d, { recursive: true, force: true });
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
