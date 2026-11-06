/**
 * `GET /api/wiki/decision-inbox` against the REAL test database and two temp
 * git wikis: every lane, the added commit and the age order, the scope's 404,
 * and an answer through the real `POST /api/wiki/answers` moving a card from
 * «ask you» to «close?». Its own `bun test` link in the `test` and `test:db` chains.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import type { Config } from "../../config.ts";
import { QUESTION_NOT_SURE } from "../../format/question.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { registerWikiAnswerRoutes } from "./wiki-answers.ts";
import { registerWikiDecisionInboxRoute, type DecisionInboxBody } from "./wiki-decision-inbox.ts";

setupTestDb();

const KODE = "melosys-kode-wiki";
const OTHER = "inbox-route-other";
const OUTSIDE = "inbox-route-outside";
const OWNER = "Test Owner (T000001)";
const REL = "plans/inbox-route-cards.mdx";
const OTHER_REL = "plans/inbox-route-other.mdx";

const q = (id: string, attrs: string, text: string) => `<Question id="${id}"${attrs}>\n\n${text}\n\n</Question>\n`;
const PAGE = [
  "---\ntitle: Inbox cards\n---\n",
  q("O1", ' choices="A|B"', "**Ask me?**\n\n**Recommendation:** A"),
  q("O2", ' choices="A|B"', "Answered by choice?"),
  q("O3", ' to="Someone Else (X999999)"', "For someone else?"),
  q("O4", ' choices="A|B"', "Answered not sure?"),
  q("O5", "", "Answered in text only?"),
  q("O6", ' to="Test Owner (T000001)|Someone Else (X999999)"', "For both?"),
  q("O7", "", "Ruled on the page?"),
  "<DecisionLog>\n\n- **O7** — Decided in the meeting.\n\n</DecisionLog>\n",
].join("\n");
/** Added after the commit, in a waiting lane: no commit, so the lane's since dates it. */
const LATE = `\n<NextMoves>\n\n<Lane kind="waiting" since="2026-09-15">\n\n- O8 needs a pick\n\n</Lane>\n\n</NextMoves>\n\n${q("O8", ' choices="A|B"', "Added later?")}`;
const OTHER_PAGE = `---\ntitle: Other\n---\n\n${q("O1", ' choices="A|B"', "**Default?**\n\n**Recommendation:** B")}`;

let kodeRoot = "";
let otherRoot = "";
let app: Hono;

function commitAll(root: string, iso: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env });
}

const post = (body: Record<string, unknown>) =>
  app.request("/api/wiki/answers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wiki: KODE, relPath: REL, ...body }) });

async function inbox(wiki: string): Promise<DecisionInboxBody> {
  const res = await app.request(`/api/wiki/decision-inbox?wiki=${wiki}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DecisionInboxBody;
}

const laneOf = (body: DecisionInboxBody) => Object.fromEntries(body.cards.map((c) => [c.id, c.lane]));

beforeAll(async () => {
  kodeRoot = await testTempDir(path.join(tmpdir(), "muninn-inbox-kode-"));
  otherRoot = await testTempDir(path.join(tmpdir(), "muninn-inbox-other-"));
  await Bun.write(path.join(kodeRoot, REL), PAGE);
  commitAll(kodeRoot, "2026-10-01T10:00:00+02:00");
  await Bun.write(path.join(kodeRoot, REL), PAGE + LATE);
  await Bun.write(path.join(otherRoot, OTHER_REL), OTHER_PAGE);
  commitAll(otherRoot, "2026-10-02T10:00:00+02:00");
  __setWikiRegistryForTest([
    { name: KODE, root: kodeRoot, source: "extra" },
    { name: OTHER, root: otherRoot, source: "extra" },
    { name: OUTSIDE, root: otherRoot, source: "extra" },
  ]);
  __resetWikiCacheForTest();
  const config = {
    dashboardPort: 3010,
    profile: "default",
    workMapWikis: [KODE, OTHER],
    wikiAnswers: { wikis: new Set([KODE, OTHER, OUTSIDE]), owner: OWNER, groups: new Map() },
  } as unknown as Config;
  app = new Hono();
  registerWikiAnswerRoutes(app, config);
  registerWikiDecisionInboxRoute(app, config);
});

/** `setupTestDb` truncates before every test, so each test answers its own cards. */
async function answerFixtures(): Promise<void> {
  for (const [questionId, choice, body] of [["O2", "A", ""], ["O4", QUESTION_NOT_SURE, "Not yet."], ["O5", null, "Go with the second."]] as const) {
    expect((await post({ questionId, choice, body })).status).toBe(201);
  }
}

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
});

describe("GET /api/wiki/decision-inbox", () => {
  test("every lane: answered and ruled close, someone else's pass, the rest ask on melosys-kode-wiki", async () => {
    await answerFixtures();
    const body = await inbox(KODE);
    expect(body.wiki).toBe(KODE);
    expect(laneOf(body)).toEqual({ O1: "ask", O2: "close", O3: "pass", O4: "ask", O5: "close", O6: "ask", O7: "close", O8: "ask" });
    const o7 = body.cards.find((c) => c.id === "O7")!;
    expect(o7.hint).toEqual({ decision: null, decisionText: null, namedBy: null, word: "Decided", ownItem: "Decided in the meeting." });
    const o5 = body.cards.find((c) => c.id === "O5")!;
    expect(o5.answers.map((a) => [a.author, a.choice, a.body])).toEqual([["Test Owner", null, "Go with the second."]]);
    const o1 = body.cards.find((c) => c.id === "O1")!;
    expect(o1.recommendation).toBe("A");
    expect(o1.title).toBe("Inbox cards");
    expect(body.cards.find((c) => c.id === "O6")!.targets).toEqual(["Test Owner (T000001)", "Someone Else (X999999)"]);
  });

  test("the added commit dates a card; one with no commit takes its lane's since and sorts first", async () => {
    const body = await inbox(KODE);
    expect(body.cards[0]!.id).toBe("O8");
    expect(body.cards[0]!.added).toBeNull();
    expect(body.cards[0]!.laneSince).toBe("2026-09-15");
    expect(Date.parse(body.cards.find((c) => c.id === "O1")!.added!)).toBe(Date.parse("2026-10-01T08:00:00Z"));
  });

  test("another covered wiki's own cards go to «take the default»", async () => {
    const body = await inbox(OTHER);
    expect(body.cards.map((c) => [c.id, c.lane, c.recommendation])).toEqual([["O1", "default", "B"]]);
  });

  test("a wiki outside the triage scope is 404 with the reason; no wiki is 400", async () => {
    const res = await app.request(`/api/wiki/decision-inbox?wiki=${OUTSIDE}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("not in WORK_MAP_WIKIS");
    expect((await app.request("/api/wiki/decision-inbox")).status).toBe(400);
  });

  test("a card the owner already answered not sure says so, where an inbox answer would only 409", async () => {
    await answerFixtures();
    const body = await inbox(KODE);
    expect(body.cards.find((c) => c.id === "O4")!.ownerAnswered).toBe(true);
    expect(body.cards.find((c) => c.id === "O6")!.ownerAnswered).toBe(false);
  });

  test("a wiki whose every page is unreadable is a 500, not an empty inbox", async () => {
    const file = path.join(otherRoot, OTHER_REL);
    // The index is built while the page reads; the page then stops reading, as a
    // permission change or an unmounted share does under a cached index.
    await inbox(OTHER);
    execFileSync("chmod", ["000", file]);
    try {
      const res = await app.request(`/api/wiki/decision-inbox?wiki=${OTHER}`);
      expect(res.status).toBe(500);
    } finally {
      execFileSync("chmod", ["644", file]);
      __resetWikiCacheForTest();
    }
  });

  test("an answer moves a card from «ask you» to «close?»", async () => {
    expect(laneOf(await inbox(KODE)).O1).toBe("ask");
    expect((await post({ questionId: "O1", choice: "A", body: "" })).status).toBe(201);
    expect(laneOf(await inbox(KODE)).O1).toBe("close");
  });
});
