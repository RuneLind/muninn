/**
 * `POST /api/wiki/decision-inbox/close` (P3b of mimir plans/muninn-wiki-decision-triage.mdx)
 * against the REAL test database and a temp git wiki: the preview writes nothing,
 * a close writes the page, log.md and a commit and the card leaves the inbox, and
 * every refusal (stale hash, no log, no ruling, uncommitted edits, scope, guards).
 * Its own `bun test` link in the `test` and `test:db` chains.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { getDb } from "../../db/client.ts";
import type { Config } from "../../config.ts";
import { parseBlocks } from "../../format/markdown-ast.ts";
import { parseQuestionPage } from "../../format/question.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest, stripFrontmatter } from "../../wiki/store.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { todayOslo } from "../../utils/date-hash.ts";
import { registerWikiAnswerRoutes } from "./wiki-answers.ts";
import { insertWikiAnswerVersion, listWikiAnswerHistory } from "../../db/wiki-answers.ts";
import { realGit } from "../../wiki/decision-triage/git.ts";
import { closeRulingFor, registerWikiDecisionInboxRoute, type DecisionCloseGuards, type DecisionInboxBody } from "./wiki-decision-inbox.ts";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";

setupTestDb();

const WIKI = "close-route-wiki";
const OUTSIDE = "close-route-outside";
const OWNER = "Test Owner (T000001)";
const REL = "plans/close-cards.mdx";
const NO_LOG = "plans/close-no-log.mdx";

const q = (id: string, text: string) => `<Question id="${id}" choices="A|B">\n\n${text}\n\n</Question>\n`;
const PAGE = [
  "---\ntitle: Close cards\n---\n",
  q("O1", "Ruled by a decision?"),
  q("O2", "Answered by choice, no item?"),
  q("O5", "Answered in text?"),
  q("O7", "Ruling word only?"),
  "<DecisionLog>\n\n- **O1** — Ruled by a decision. See the card.\n- **O5** — Answered in text. See the card.\n- **O7** — Decided in the meeting.\n- **D1** — Answer A on card O1. Rune Lind, 05.11.2026.\n\n</DecisionLog>\n",
].join("\n");
const NO_LOG_PAGE = `---\ntitle: No log\n---\n\n${q("O1", "No log here?")}`;

let root = "";
let app: Hono;
let guardRefusal: Response | null = null;
const NOW = Date.parse("2026-11-07T12:00:00+01:00");
// A ruling is signed with its answer row's `wiki_answers.created_at` (`closeRulingFor`);
// `backdate` shifts every row by one constant onto NOW's day, keeping their order.
const SIGNED = todayOslo(NOW).split("-").reverse().join(".");
let dbStart: Date;
const backdate = () =>
  getDb()`UPDATE wiki_answers SET created_at = created_at - (${dbStart}::timestamptz - to_timestamp(${NOW / 1000})) WHERE created_at >= ${dbStart}`;
const insertAnswer = async (input: Parameters<typeof insertWikiAnswerVersion>[0]) => {
  await insertWikiAnswerVersion(input);
  await backdate();
};

const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });

async function resetPages(): Promise<void> {
  await Bun.write(path.join(root, REL), PAGE);
  await Bun.write(path.join(root, NO_LOG), NO_LOG_PAGE);
  git("add", "-A");
  try {
    git("commit", "-q", "-m", "fixture");
  } catch {
    /* nothing changed */
  }
  __resetWikiCacheForTest();
}

const close = (body: Record<string, unknown>) =>
  app.request("/api/wiki/decision-inbox/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: WIKI, relPath: REL, ...body }) });

const answer = async (questionId: string, choice: string | null, body: string, relPath = REL) => {
  const res = await app.request("/api/wiki/answers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: WIKI, relPath, questionId, choice, body }) });
  expect(res.status).toBe(201);
  await backdate();
};

async function preview(questionId: string, relPath = REL): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await close({ questionId, relPath, preview: true });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const stateOf = async (id: string) => parseQuestionPage(parseBlocks(stripFrontmatter(await Bun.file(path.join(root, REL)).text()))).states.get(id);

beforeAll(async () => {
  root = await testTempDir(path.join(tmpdir(), "muninn-close-"));
  [{ now: dbStart }] = (await getDb()`SELECT now()`) as unknown as [{ now: Date }];
  // backdate's guard tells shifted rows from new ones only while the shift is positive.
  if (dbStart.getTime() <= NOW) throw new Error(`database clock ${dbStart.toISOString()} is not after NOW; backdate would re-shift rows`);
  git("init", "-q", "-b", "main");
  // The route's commit (`commitWikiChange`) spawns git with no author env: a CI runner has no identity.
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.invalid");
  await resetPages();
  __setWikiRegistryForTest([
    { name: WIKI, root, source: "extra" },
    { name: OUTSIDE, root, source: "extra" },
  ]);
  const config = {
    dashboardPort: 3010,
    profile: "default",
    workMapWikis: [WIKI],
    wikiAnswers: { wikis: new Set([WIKI, OUTSIDE]), owner: OWNER, groups: new Map() },
  } as unknown as Config;
  const guards: DecisionCloseGuards = { readonlyRefusal: () => guardRefusal, egressRefusal: () => null };
  app = new Hono();
  registerWikiAnswerRoutes(app, config);
  registerWikiDecisionInboxRoute(
    app,
    config,
    () => ({
      registry: () => [
        { name: WIKI, root, source: "extra" },
        { name: OUTSIDE, root, source: "extra" },
      ],
      workMapWikis: () => [WIKI],
      answerConfig: () => config.wikiAnswers!,
      answers: listWikiAnswerHistory,
      git: realGit,
      now: () => NOW,
    }),
    guards,
  );
});

beforeEach(async () => {
  guardRefusal = null;
  git("reset", "-q", "--hard");
  await resetPages();
});

afterAll(() => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
});

describe("POST /api/wiki/decision-inbox/close", () => {
  test("a preview answers the lines and the hash, and writes nothing", async () => {
    await answer("O2", "B", "");
    const { status, body } = await preview("O2");
    expect(status).toBe(200);
    expect(body.decision).toBe("D2");
    expect(body.lines).toEqual(["- **O2** — See the card. Closed 2026-11-07 (D2).", `- **D2** — Answer B on card O2. Test Owner, ${SIGNED}.`]);
    expect(typeof body.baseHash).toBe("string");
    expect(await Bun.file(path.join(root, REL)).text()).toBe(PAGE);
  });

  test("a close writes the page, log.md and a commit, and the card leaves the inbox", async () => {
    await answer("O2", "B", "");
    const { body: p } = await preview("O2");
    const res = await close({ questionId: "O2", baseHash: p.baseHash, rulingHash: p.rulingHash });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decision: "D2", committed: true });
    expect(await stateOf("O2")).toEqual({ kind: "decided", decision: "D2" });
    expect(await Bun.file(path.join(root, "log.md")).text()).toContain("O2 closed (D2) from the decision inbox");
    expect(git("log", "-1", "--format=%s")).toBe(`[decision-inbox] close O2 (D2): ${REL}\n`);
    expect(git("status", "--porcelain")).toBe("");
    const inbox = (await (await app.request(`/api/wiki/decision-inbox?wiki=${WIKI}`)).json()) as DecisionInboxBody;
    expect(inbox.cards.map((c) => c.id)).not.toContain("O2");
  });

  test("a hint naming a decision closes on it, with no new decision", async () => {
    const { body: p } = await preview("O1");
    expect(p.lines).toEqual(["- **O1** — Ruled by a decision. See the card. Closed 2026-11-07 (D1)."]);
    expect((await close({ questionId: "O1", baseHash: p.baseHash, rulingHash: p.rulingHash })).status).toBe(200);
    expect(await stateOf("O1")).toEqual({ kind: "decided", decision: "D1" });
  });

  test("a text answer is written whole, not the inbox's cut body", async () => {
    const long = `Go with the second, ${"because it holds ".repeat(40)}end`;
    await answer("O5", null, long);
    const { body: p } = await preview("O5");
    expect((p.lines as string[])[1]).toContain(`${long}. Test Owner, ${SIGNED}.`);
  });

  test("a not-sure answer and a bare ruling word rule on nothing: refused", async () => {
    await answer("O2", "not-sure", "No idea.");
    for (const id of ["O2", "O7"]) {
      const { status, body } = await preview(id);
      expect(status).toBe(409);
      expect(body.error).toContain("open it on the page");
    }
  });

  test("a page with no DecisionLog is refused (D23)", async () => {
    await answer("O1", "A", "", NO_LOG);
    const { status, body } = await preview("O1", NO_LOG);
    expect(status).toBe(409);
    expect(body.code).toBe("no-log");
  });

  test("a page that changed since the preview is 409 stale and keeps the change", async () => {
    await answer("O2", "B", "");
    const { body: p } = await preview("O2");
    const edited = PAGE.replace("Ruling word only?", "Ruling word only, edited?");
    await Bun.write(path.join(root, REL), edited);
    git("commit", "-q", "-am", "edit");
    const res = await close({ questionId: "O2", baseHash: p.baseHash, rulingHash: p.rulingHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stale: true });
    expect(await Bun.file(path.join(root, REL)).text()).toBe(edited);
  });

  test("backdate shifts each row once: earlier rows stay on NOW's day after later inserts", async () => {
    for (const name of ["First", "Second", "Third"]) {
      await insertAnswer({ answerId: crypto.randomUUID(), version: 1, wiki: WIKI, relPath: REL, questionId: "O2", author: { userId: null, oid: null, navIdent: null, name }, choice: "A", body: "", questionHash: "h" });
    }
    const rows = (await getDb()`SELECT created_at FROM wiki_answers`) as unknown as { created_at: Date }[];
    expect(rows.map((r) => todayOslo(r.created_at.getTime()))).toEqual([todayOslo(NOW), todayOslo(NOW), todayOslo(NOW)]);
  });

  test("an answer that changed since the preview is 409 and writes nothing", async () => {
    await answer("O2", "A", "");
    const { body: p } = await preview("O2");
    expect(p.lines).toContain(`- **D2** — Answer A on card O2. Test Owner, ${SIGNED}.`);
    await insertAnswer({ answerId: crypto.randomUUID(), version: 1, wiki: WIKI, relPath: REL, questionId: "O2", author: { userId: null, oid: null, navIdent: null, name: "Someone Else" }, choice: "B", body: "", questionHash: "h" });
    const res = await close({ questionId: "O2", baseHash: p.baseHash, rulingHash: p.rulingHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ changed: true });
    expect(await Bun.file(path.join(root, REL)).text()).toBe(PAGE);
  });

  test("the preview warns of an answer to older wording and of an author who answered otherwise", async () => {
    const other = (name: string, choice: string, questionHash: string) =>
      insertAnswer({ answerId: crypto.randomUUID(), version: 1, wiki: WIKI, relPath: REL, questionId: "O2", author: { userId: null, oid: null, navIdent: null, name }, choice, body: "", questionHash });
    await other("Someone Else", "A", "an-older-wording");
    await Bun.sleep(10);
    await other("Third Person", "B", "an-older-wording");
    const { status, body } = await preview("O2");
    expect(status).toBe(200);
    expect(body.lines).toContain(`- **D2** — Answer B on card O2. Third Person, ${SIGNED}.`);
    expect(body.warnings).toEqual(["Third Person answered an older wording of the card.", "Someone Else answered A."]);
  });

  test("a warning that appears after the preview (another author not sure) is 409 too", async () => {
    await answer("O2", "A", "");
    const { body: p } = await preview("O2");
    expect(p.warnings).toEqual([]);
    await insertAnswer({ answerId: crypto.randomUUID(), version: 1, wiki: WIKI, relPath: REL, questionId: "O2", author: { userId: null, oid: null, navIdent: null, name: "Someone Else" }, choice: "not-sure", body: "", questionHash: "h" });
    const res = await close({ questionId: "O2", baseHash: p.baseHash, rulingHash: p.rulingHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ changed: true });
  });

  test("a page with uncommitted edits is 409 dirty and stays as it was", async () => {
    await answer("O2", "B", "");
    const dirty = `${PAGE}\nA hand edit.\n`;
    await Bun.write(path.join(root, REL), dirty);
    __resetWikiCacheForTest();
    const { body: p } = await preview("O2");
    const res = await close({ questionId: "O2", baseHash: p.baseHash, rulingHash: p.rulingHash });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ dirty: true });
    expect(await Bun.file(path.join(root, REL)).text()).toBe(dirty);
  });

  test("a missing baseHash is 400, a wiki outside the scope 404, a guard's refusal passes through", async () => {
    expect((await close({ questionId: "O2" })).status).toBe(400);
    expect((await close({ questionId: "O2", wiki: OUTSIDE, preview: true })).status).toBe(404);
    guardRefusal = new Response(JSON.stringify({ error: "readonly" }), { status: 403 });
    expect((await close({ questionId: "O2", preview: true })).status).toBe(403);
    const form = await app.request("/api/wiki/decision-inbox/close", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(form.status).toBe(415);
  });

  test("a close with no rulingHash is 400, not a 409", async () => {
    await answer("O2", "B", "");
    const { body: p } = await preview("O2");
    const res = await close({ questionId: "O2", baseHash: p.baseHash });
    expect(res.status).toBe(400);
  });

  test("a warning whose text changes while the count stays is 409", async () => {
    const id = crypto.randomUUID();
    const someone = { userId: null, oid: null, navIdent: null, name: "Someone Else" };
    await insertAnswer({ answerId: id, version: 1, wiki: WIKI, relPath: REL, questionId: "O2", author: someone, choice: "B", body: "", questionHash: "h" });
    await Bun.sleep(10);
    await answer("O2", "A", "");
    const { body: p } = await preview("O2");
    expect(p.warnings).toEqual(["Someone Else answered B."]);
    await insertAnswer({ answerId: id, version: 2, wiki: WIKI, relPath: REL, questionId: "O2", author: someone, choice: "not-sure", body: "", questionHash: "h" });
    const res = await close({ questionId: "O2", baseHash: p.baseHash, rulingHash: p.rulingHash });
    expect(res.status).toBe(409);
  });
});

describe("closeRulingFor's warnings", () => {
  let n = 0;
  const v = (name: string, choice: string | null, body: string, over: Partial<WikiAnswerVersion> = {}): WikiAnswerVersion => ({
    answerId: over.answerId ?? `a${++n}`, version: 1, wiki: WIKI, relPath: REL, questionId: "O5", author: { userId: null, oid: null, navIdent: null, name }, choice, body,
    questionHash: "older", createdAt: ++n * 1000, redactedAt: null, ...over,
  } as WikiAnswerVersion);

  test("text against text: a different text warns, the same text does not; not sure says so; a redacted or superseded answer is silent", () => {
    const owner = "Test Owner";
    const versions = [
      v("Other Text", null, "Use the first."),
      v("Same Text", null, "Use the second."),
      v("Unsure", "not-sure", ""),
      v("Redacted", "B", "", { answerId: "red", redactedAt: 1 } as Partial<WikiAnswerVersion>),
      v("Changed Mind", "B", "", { answerId: "cm" }),
      v("Changed Mind", null, "Use the second.", { answerId: "cm", version: 2 }),
      v(owner, null, "Use the second."),
    ];
    const r = closeRulingFor(PAGE, "O5", versions, REL)!;
    expect(r.ruling).toMatchObject({ kind: "answer", choice: null, body: "Use the second.", author: owner });
    expect(r.warnings.filter((w) => !w.includes("older wording"))).toEqual(["Other Text answered in text.", "Unsure is not sure."]);
  });
});
