/**
 * `GET`/`POST /api/wiki/answers` against the REAL test database and a temp
 * wiki: the author rule (D9), append-only edits, the author-only edit (no admin
 * passthrough), every refusal the route owns, and the page flags
 * `/api/wiki/page` carries on a wiki that takes answers.
 *
 * Identity is injected the way the auth middleware sets it (`c.set("identity")`
 * / `c.set("role")`); no identity is `MUNINN_AUTH=off`. Its own `bun test` link
 * in the `test` and `test:db` chains.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { getDb } from "../../db/client.ts";
import type { Config, WikiAnswerConfig } from "../../config.ts";
import type { Identity } from "../../auth/introspect.ts";
import type { AuthRole } from "../../auth/role.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest } from "../../wiki/readonly.ts";
import { registerWikiAnswerRoutes, WIKI_ANSWER_BODY_LIMIT, type WikiAnswerStore } from "./wiki-answers.ts";
import {
  getLatestWikiAnswerVersion,
  insertWikiAnswerVersion,
  listLatestWikiAnswers,
  listWikiAnswerVersions,
} from "../../db/wiki-answers.ts";
import { registerWikiReadRoutes } from "./wiki-routes.ts";
import { QUESTION_ANSWER_MAX, QUESTION_NOT_SURE } from "../../format/question.ts";
import { __resetAnswerScannerForTest } from "../../wiki/answer-scanner.ts";
import { sha256 } from "../../gardener/util.ts";

setupTestDb();

const REL = "plans/questions.mdx";
const PAGE = [
  "---",
  "title: Questions",
  "type: plan",
  "---",
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
  '<Question id="O3">',
  "",
  "Reopened?",
  "",
  "</Question>",
  "",
  '<Question id="O5">',
  "",
  "Asked twice?",
  "",
  "</Question>",
  "",
  '<Question id="O5">',
  "",
  "Asked twice, again?",
  "",
  "</Question>",
  "",
  '<Question id="O6" choices="not-sure|later">',
  "",
  "A page that spells the fixed value itself.",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **D99** — The page's language.",
  "- **O1** — Export block language?",
  "- **O2** — Decided? Closed 2026-10-08 (D99).",
  "- **O3** — Reopened? Lukket 08.10 (D99). Gjenåpnet 09.10.",
  "- **O5** — Twice?",
  "- **O6** — Spelled?",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// Who a question is for, three ways: the page's questions_to: (with an ident),
// a to= naming a person by name only, and a to= whose ident disagrees with a
// matching name.
const ASKED_REL = "plans/asked.mdx";
const ASKED_PAGE = [
  "---",
  "title: Asked",
  'questions_to: ["Yvonne Jacobs (X111111)"]',
  "---",
  "",
  '<Question id="A1">',
  "",
  "For the page's person?",
  "",
  "</Question>",
  "",
  '<Question id="A2" to="OLA  nordmann">',
  "",
  "For Ola by name?",
  "",
  "</Question>",
  "",
  '<Question id="A3" to="Yvonne Jacobs (Z999999)">',
  "",
  "Same name, another ident?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **A1** — Page person.",
  "- **A2** — Ola.",
  "- **A3** — Other ident.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// The owner written the way WIKI_ANSWER_OWNER takes it: a name and an ident.
const OWNER_REL = "plans/owner.mdx";
const OWNER_PAGE = [
  "---",
  "title: Owner",
  'questions_to: ["Rune Lind (Z555555)"]',
  "---",
  "",
  '<Question id="B1">',
  "",
  "For the page's person, who is the owner?",
  "",
  "</Question>",
  "",
  '<Question id="B2" to="R. Lind (Z555555)">',
  "",
  "For the owner under another spelling of the name?",
  "",
  "</Question>",
  "",
].join("\n");

const OWNER = "Rune Owner";
let root = "";

const yvonne: Identity = {
  userId: "u-yvonne",
  displayName: "Yvonne Jacobs",
  navIdent: "X111111",
  oid: "oid-yvonne",
  provider: "entra",
  expiresAt: null,
};
const ola: Identity = { ...yvonne, userId: "u-ola", displayName: "Ola Nordmann", navIdent: "Y222222", oid: "oid-ola" };

function appFor(
  opts: {
    identity?: Identity;
    role?: AuthRole;
    answers?: WikiAnswerConfig;
    store?: WikiAnswerStore;
    profile?: "default" | "nais";
  } = {},
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.identity) c.set("identity", opts.identity);
    if (opts.role) c.set("role", opts.role);
    await next();
  });
  const config = {
    dashboardPort: 3010,
    profile: opts.profile ?? "default",
    wikiAnswers: opts.answers ?? { wikis: new Set(["answers"]), owner: OWNER },
  } as unknown as Config;
  registerWikiReadRoutes(app, config);
  registerWikiAnswerRoutes(app, config, opts.store);
  return app;
}

const post = (app: Hono, body: Record<string, unknown>, contentType = "application/json") =>
  app.request("/api/wiki/answers", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });

const answer = (over: Record<string, unknown> = {}) => ({
  wiki: "answers",
  relPath: REL,
  questionId: "O1",
  choice: "B",
  body: "The page's language.",
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getAnswers = async (app: Hono, extra = ""): Promise<any> => {
  const res = await app.request(`/api/wiki/answers?wiki=answers&relPath=${encodeURIComponent(REL)}${extra}`);
  expect(res.status).toBe(200);
  return res.json();
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-answers-"));
  await Bun.write(path.join(root, REL), PAGE);
  await Bun.write(path.join(root, ASKED_REL), ASKED_PAGE);
  await Bun.write(path.join(root, OWNER_REL), OWNER_PAGE);
  __setWikiRegistryForTest([
    { name: "answers", root, source: "extra" },
    { name: "cards-only", root, source: "extra" },
    // A registered wiki whose directory is gone: the 503 "wiki directory not found".
    { name: "gone", root: path.join(root, "no-such-dir"), source: "extra" },
  ]);
  __resetWikiCacheForTest();
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(root, { recursive: true, force: true });
});

describe("the author (D9)", () => {
  test("auth off: the author is WIKI_ANSWER_OWNER, whatever the body names", async () => {
    const app = appFor();
    const res = await post(app, answer({ authorName: "Mallory", author: { name: "Mallory" }, authorUserId: "u-mallory" }));
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.authorName).toBe(OWNER);
    const rows = await getDb()`SELECT * FROM wiki_answers WHERE answer_id = ${saved.answerId}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.author_name).toBe(OWNER);
    expect(rows[0]!.author_user_id).toBeNull();
    expect(rows[0]!.author_oid).toBeNull();
  });

  test("auth off with no owner: the write is refused and nothing is stored", async () => {
    const before = (await getDb()`SELECT count(*)::int AS n FROM wiki_answers`)[0]!.n;
    const res = await post(appFor({ answers: { wikis: new Set(["answers"]), owner: null } }), answer());
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("owner_unset");
    expect((await getDb()`SELECT count(*)::int AS n FROM wiki_answers`)[0]!.n).toBe(before);
  });

  test("an identity: the session's user, name, oid and ident — never the body's", async () => {
    const res = await post(appFor({ identity: yvonne, role: "user" }), answer({ authorName: "Mallory" }));
    expect(res.status).toBe(201);
    const { answerId } = await res.json();
    const row = (await getDb()`SELECT * FROM wiki_answers WHERE answer_id = ${answerId}`)[0]!;
    expect([row.author_user_id, row.author_name, row.author_oid, row.author_nav_ident]).toEqual([
      "u-yvonne",
      "Yvonne Jacobs",
      "oid-yvonne",
      "X111111",
    ]);
  });

  test("the question hash is the parsed body plus choices, not the raw source", async () => {
    const res = await post(appFor(), answer());
    const { answerId } = await res.json();
    const row = (await getDb()`SELECT question_hash FROM wiki_answers WHERE answer_id = ${answerId}`)[0]!;
    expect(row.question_hash).toBe(sha256("**Keep the export block in Norwegian?**\n\nchoices: A|B"));
  });
});

describe("edits are append-only, and only the author's", () => {
  test("an edit adds version 2 under the same answer; GET shows one answer", async () => {
    const app = appFor({ identity: yvonne, role: "user" });
    const first = await (await post(app, answer({ questionId: "O3", choice: null, body: "v1" }))).json();
    const res = await post(app, answer({ questionId: "O3", choice: null, body: "v2", answerId: first.answerId, baseVersion: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(2);
    const rows = await getDb()`SELECT version, body FROM wiki_answers WHERE answer_id = ${first.answerId} ORDER BY version`;
    expect(rows.map((r) => [r.version, r.body])).toEqual([
      [1, "v1"],
      [2, "v2"],
    ]);
    const { answers } = await getAnswers(app);
    const mine = answers.filter((a: { answerId: string }) => a.answerId === first.answerId);
    expect(mine.length).toBe(1);
    expect([mine[0].version, mine[0].versionCount, mine[0].body, mine[0].mine]).toEqual([2, 2, "v2", true]);
  });

  test("a stranger's edit is refused — an admin's included — and adds no row", async () => {
    const first = await (await post(appFor({ identity: yvonne, role: "user" }), answer())).json();
    for (const app of [appFor({ identity: ola, role: "user" }), appFor({ identity: ola, role: "admin" })]) {
      const res = await post(app, answer({ answerId: first.answerId, baseVersion: 1, body: "hijack" }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("not_author");
    }
    expect((await getDb()`SELECT count(*)::int AS n FROM wiki_answers WHERE answer_id = ${first.answerId}`)[0]!.n).toBe(1);
  });

  test("two edits racing for version 2: one lands, the other is a 409, not a 500", async () => {
    const first = await (await post(appFor(), answer({ body: "v1" }))).json();
    // Both requests read version 1 before either inserts: the reads wait for each other.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const store: WikiAnswerStore = {
      insert: insertWikiAnswerVersion,
      listLatest: listLatestWikiAnswers,
      listVersions: listWikiAnswerVersions,
      getLatest: async (id) => {
        const latest = await getLatestWikiAnswerVersion(id);
        if (++arrived === 2) release();
        await bothRead;
        return latest;
      },
    };
    const app = appFor({ store });
    const [a, b] = await Promise.all([
      post(app, answer({ body: "edit A", answerId: first.answerId, baseVersion: 1 })),
      post(app, answer({ body: "edit B", answerId: first.answerId, baseVersion: 1 })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect((await lost.json()).code).toBe("version_conflict");
    const rows = await getDb()`SELECT version FROM wiki_answers WHERE answer_id = ${first.answerId} ORDER BY version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  test("auth off: any edit is the owner's", async () => {
    const app = appFor();
    const first = await (await post(app, answer())).json();
    const res = await post(app, answer({ answerId: first.answerId, baseVersion: 1, body: "edited" }));
    expect(res.status).toBe(200);
  });

  test("an answerId from another question, or none at all, is unknown", async () => {
    const app = appFor();
    const first = await (await post(app, answer())).json();
    for (const answerId of [first.answerId.replace(/.$/, first.answerId.endsWith("0") ? "1" : "0"), "not-a-uuid"]) {
      const res = await post(app, answer({ answerId, baseVersion: 1 }));
      expect(res.status).toBe(404);
    }
    const res = await post(app, answer({ questionId: "O3", choice: null, answerId: first.answerId, baseVersion: 1 }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("unknown_answer");
  });

  test("an edit of a redacted answer is refused", async () => {
    const app = appFor();
    const first = await (await post(app, answer())).json();
    await getDb()`UPDATE wiki_answers SET redacted_at = now(), body = '', choice = NULL WHERE answer_id = ${first.answerId}`;
    const res = await post(app, answer({ answerId: first.answerId, baseVersion: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("answer_redacted");
  });

  test("an edit whose answer the retention sweep deletes after the route read it is 404 unknown_answer, not a 409", async () => {
    const first = await (await post(appFor(), answer({ body: "v1" }))).json();
    // The sweep lands between the route's read of the latest version and its insert.
    const store: WikiAnswerStore = {
      insert: insertWikiAnswerVersion,
      listLatest: listLatestWikiAnswers,
      listVersions: listWikiAnswerVersions,
      getLatest: async (id) => {
        const latest = await getLatestWikiAnswerVersion(id);
        await getDb()`DELETE FROM wiki_answers WHERE answer_id = ${id}`;
        return latest;
      },
    };
    const res = await post(appFor({ store }), answer({ body: "edited", answerId: first.answerId, baseVersion: 1 }));
    expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 404, code: "unknown_answer" });
    expect((await getDb()`SELECT count(*)::int AS n FROM wiki_answers WHERE answer_id = ${first.answerId}`)[0]!.n).toBe(0);
  });
});

describe("refusals", () => {
  const refused = async (body: Record<string, unknown>, status: number, code: string, app = appFor()) => {
    const res = await post(app, answer(body));
    expect(`${res.status} ${(await res.json()).code}`).toBe(`${status} ${code}`);
  };

  test("an unknown page, an unknown question, a duplicated id", async () => {
    await refused({ relPath: "plans/nope.mdx" }, 404, "no_page");
    await refused({ wiki: "no-such-wiki" }, 404, "no_page");
    await refused({ questionId: "O9" }, 404, "unknown_question");
    await refused({ questionId: "O5", choice: null }, 409, "duplicate_question");
  });

  test("a closed question is refused; a reopened one takes answers", async () => {
    await refused({ questionId: "O2", choice: null }, 409, "question_closed");
    const res = await post(appFor(), answer({ questionId: "O3", choice: null }));
    expect(res.status).toBe(201);
  });

  test("a choice outside the parsed set is refused; the not-sure value is always accepted", async () => {
    await refused({ choice: "C" }, 400, "bad_choice");
    await refused({ choice: "" }, 400, "bad_choice");
    await refused({ questionId: "O3", choice: "A" }, 400, "bad_choice");
    expect((await post(appFor(), answer({ choice: QUESTION_NOT_SURE }))).status).toBe(201);
    // A page that declares the value itself: one stored value, accepted.
    expect((await post(appFor(), answer({ questionId: "O6", choice: QUESTION_NOT_SURE }))).status).toBe(201);
  });

  test("a body over 8000 characters, and an empty answer", async () => {
    await refused({ body: "x".repeat(8001) }, 400, "body_too_long");
    expect((await post(appFor(), answer({ body: "😀".repeat(8000) }))).status).toBe(201);
    await refused({ body: "   ", choice: null }, 400, "empty_answer");
  });

  test("a wiki not in WIKI_ANSWER_WIKIS refuses the write", async () => {
    await refused({ wiki: "cards-only" }, 403, "not_answerable");
  });

  test("a non-JSON POST is a 415 before anything else", async () => {
    const res = await post(appFor(), answer(), "text/plain");
    expect(res.status).toBe(415);
  });
});

describe("GET /api/wiki/answers", () => {
  test("never carries the author's oid or ident; mine is per viewer", async () => {
    await post(appFor({ identity: yvonne, role: "user" }), answer({ body: "from yvonne" }));
    const asOla = await getAnswers(appFor({ identity: ola, role: "user" }));
    const text = JSON.stringify(asOla);
    expect(text).not.toContain("oid-yvonne");
    expect(text).not.toContain("X111111");
    const row = asOla.answers.find((a: { body: string }) => a.body === "from yvonne");
    expect(row.mine).toBe(false);
    expect(row.authorName).toBe("Yvonne Jacobs");
    const asYvonne = await getAnswers(appFor({ identity: yvonne, role: "user" }));
    expect(asYvonne.answers.find((a: { body: string }) => a.body === "from yvonne").mine).toBe(true);
  });

  test("versions=1 adds earlier versions to the author and an admin, not to anyone else", async () => {
    const asYvonne = appFor({ identity: yvonne, role: "user" });
    const first = await (await post(asYvonne, answer({ questionId: "O3", choice: null, body: "first" }))).json();
    await post(asYvonne, answer({ questionId: "O3", choice: null, body: "second", answerId: first.answerId, baseVersion: 1 }));
    const pick = (data: { answers: { answerId: string }[] }) =>
      data.answers.find((a) => a.answerId === first.answerId) as { earlier?: { version: number; body: string }[] };

    expect(pick(await getAnswers(asYvonne, "&versions=1")).earlier?.map((v) => [v.version, v.body])).toEqual([[1, "first"]]);
    expect(pick(await getAnswers(appFor({ identity: ola, role: "admin" }), "&versions=1")).earlier?.length).toBe(1);
    expect(pick(await getAnswers(appFor({ identity: ola, role: "user" }), "&versions=1")).earlier).toBeUndefined();
    // Without the flag nobody gets them.
    expect(pick(await getAnswers(asYvonne)).earlier).toBeUndefined();
  });

  test("exported follows the LATEST version", async () => {
    const app = appFor();
    const first = await (await post(app, answer({ body: "to export" }))).json();
    await getDb()`UPDATE wiki_answers SET exported_at = now() WHERE answer_id = ${first.answerId}`;
    const exported = (await getAnswers(app)).answers.find((a: { answerId: string }) => a.answerId === first.answerId);
    expect(exported.exported).toBe(true);
    await post(app, answer({ body: "edited after", answerId: first.answerId, baseVersion: 1 }));
    const edited = (await getAnswers(app)).answers.find((a: { answerId: string }) => a.answerId === first.answerId);
    expect([edited.exported, edited.versionCount]).toEqual([false, 2]);
  });

  test("a redacted answer shows as redacted, with no body and no choice", async () => {
    const app = appFor();
    const first = await (await post(app, answer({ body: "secret" }))).json();
    await getDb()`UPDATE wiki_answers SET redacted_at = now() WHERE answer_id = ${first.answerId}`;
    const row = (await getAnswers(app)).answers.find((a: { answerId: string }) => a.answerId === first.answerId);
    expect([row.redacted, row.body, row.choice]).toEqual([true, "", null]);
  });

  test("a wiki not in WIKI_ANSWER_WIKIS answers an empty list", async () => {
    await post(appFor(), answer());
    const res = await appFor().request(`/api/wiki/answers?wiki=cards-only&relPath=${encodeURIComponent(REL)}`);
    expect(await res.json()).toEqual({ answerable: false, answers: [] });
  });
});

describe("/api/wiki/page on a wiki that takes answers", () => {
  const page = async (app: Hono, wiki: string) => {
    const res = await app.request(`/api/wiki/page?wiki=${wiki}&relPath=${encodeURIComponent(REL)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { html: string; answers?: { answerable: boolean; canExport: boolean } };
  };

  test("answerable cards, the page flags, and the owner as the default For", async () => {
    const data = await page(appFor(), "answers");
    expect(data.answers).toEqual({ answerable: true, canExport: true });
    expect(data.html).toContain('data-wiki-answerable="true"');
    expect(data.html).toContain('data-question-to-source="owner"');
    expect(data.html).toContain(`data-question-to="${OWNER}"`);
    expect(data.html).toContain(`<span class="q-for-label">For</span> ${OWNER}`);
  });

  test("canExport is admin only", async () => {
    expect((await page(appFor({ identity: yvonne, role: "admin" }), "answers")).answers?.canExport).toBe(true);
  });

  test("role user gets no answers flag: the zones refuse it the answer routes (default profile)", async () => {
    const data = await page(appFor({ identity: yvonne, role: "user" }), "answers");
    expect(data.answers).toBeUndefined();
    // The card itself still renders, read-only for this viewer.
    expect(data.html).toContain("section class=\"question");
  });

  test("on nais role user gets the answers flag (PR 5 opens the answer routes there), without canExport", async () => {
    __setReadonlyWikiRootsForTest([root]);
    __resetWikiCacheForTest();
    try {
      expect((await page(appFor({ identity: yvonne, role: "user", profile: "nais" }), "answers")).answers).toEqual({
        answerable: true,
        canExport: false,
      });
      expect((await page(appFor({ identity: yvonne, role: "admin", profile: "nais" }), "answers")).answers?.canExport).toBe(true);
    } finally {
      __setReadonlyWikiRootsForTest();
      __resetWikiCacheForTest();
    }
  });

  test("a wiki not in WIKI_ANSWER_WIKIS: read-only cards, no flags, no owner", async () => {
    const data = await page(appFor(), "cards-only");
    expect(data.answers).toBeUndefined();
    expect(data.html).toContain('data-wiki-answerable="false"');
    expect(data.html).not.toContain('data-question-to-source="owner"');
    expect(data.html).not.toContain(OWNER);
  });
});

describe("fix round 1", () => {
  const code = async (res: Response) => `${res.status} ${(await res.json()).code}`;

  test("an edit must name the version it was made from; a missing or malformed baseVersion is a 400", async () => {
    const app = appFor();
    const first = await (await post(app, answer({ body: "v1" }))).json();
    for (const baseVersion of [undefined, "1", 0, -1, 1.5, null]) {
      const res = await post(app, answer({ body: "edit", answerId: first.answerId, baseVersion }));
      expect(await code(res)).toBe("400 bad_base_version");
    }
    const rows = await getDb()`SELECT version FROM wiki_answers WHERE answer_id = ${first.answerId}`;
    expect(rows.length).toBe(1);
  });

  test("an edit made from a stale version is a 409, and adds no row", async () => {
    const app = appFor();
    const first = await (await post(app, answer({ body: "v1" }))).json();
    const second = await post(app, answer({ body: "v2", answerId: first.answerId, baseVersion: 1 }));
    expect(second.status).toBe(200);
    const saved = await second.json();
    expect(saved.version).toBe(2);
    // A second tab still holding version 1.
    const stale = await post(app, answer({ body: "from the stale tab", answerId: first.answerId, baseVersion: 1 }));
    expect(await code(stale)).toBe("409 version_conflict");
    // A base AHEAD of the stored answer is no better.
    const ahead = await post(app, answer({ body: "from the future", answerId: first.answerId, baseVersion: 7 }));
    expect(await code(ahead)).toBe("409 version_conflict");
    // The response's version chains the next edit.
    const third = await post(app, answer({ body: "v3", answerId: first.answerId, baseVersion: saved.version }));
    expect((await third.json()).version).toBe(3);
    const rows = await getDb()`SELECT version, body FROM wiki_answers WHERE answer_id = ${first.answerId} ORDER BY version`;
    expect(rows.map((r) => [r.version, r.body])).toEqual([
      [1, "v1"],
      [2, "v2"],
      [3, "v3"],
    ]);
  });

  test("ten concurrent edits all made from version 1: exactly one lands", async () => {
    const app = appFor();
    const first = await (await post(app, answer({ body: "v1" }))).json();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post(app, answer({ body: `edit ${i}`, answerId: first.answerId, baseVersion: 1 }))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    const rows = await getDb()`SELECT version FROM wiki_answers WHERE answer_id = ${first.answerId} ORDER BY version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  test("a NUL or a lone surrogate in body or choice is a 400 before anything is stored", async () => {
    const before = (await getDb()`SELECT count(*)::int AS n FROM wiki_answers`)[0]!.n;
    for (const bad of ["a\u0000b", "a\udc00b", "a\ud800", "\ud83db"]) {
      expect(await code(await post(appFor(), answer({ body: bad })))).toBe("400 bad_text");
      expect(await code(await post(appFor(), answer({ choice: bad })))).toBe("400 bad_text");
    }
    // Refused before the length check: an over-long body carrying a NUL names the NUL.
    expect(await code(await post(appFor(), answer({ body: "x".repeat(9000) + "\u0000" })))).toBe("400 bad_text");
    expect((await getDb()`SELECT count(*)::int AS n FROM wiki_answers`)[0]!.n).toBe(before);
    // A well-formed astral character is fine.
    expect((await post(appFor(), answer({ body: "ok 😀" }))).status).toBe(201);
  });

  test("bad_choice names each allowed value once, on a page that spells not-sure itself", async () => {
    const res = await post(appFor(), answer({ questionId: "O6", choice: "x" }));
    expect(res.status).toBe(400);
    const { code: c, error } = await res.json();
    expect(c).toBe("bad_choice");
    expect(error.match(/not-sure/g)).toHaveLength(1);
    expect(error).toContain("later");
  });

  test("a question with no choices takes no choice at all, not-sure included", async () => {
    expect(await code(await post(appFor(), answer({ questionId: "O3", choice: QUESTION_NOT_SURE })))).toBe("400 bad_choice");
    expect((await post(appFor(), answer({ questionId: "O3", choice: null, body: "free text" }))).status).toBe(201);
  });

  test("a duplicated id renders read-only beside answerable cards", async () => {
    const res = await appFor().request(`/api/wiki/page?wiki=answers&relPath=${encodeURIComponent(REL)}`);
    const { html } = (await res.json()) as { html: string };
    const flag = (id: string) => [...html.matchAll(new RegExp(`data-question-id="${id}"[^>]*data-wiki-answerable="(\\w+)"`, "g"))].map((m) => m[1]);
    expect(flag("O1")).toEqual(["true"]);
    expect(flag("O5")).toEqual(["false", "false"]);
  });

  test("a registered wiki whose directory is gone has its own code, not no_page", async () => {
    expect(await code(await post(appFor(), answer({ wiki: "gone" })))).toBe("503 wiki_unavailable");
    const get = await appFor().request(`/api/wiki/answers?wiki=gone&relPath=${encodeURIComponent(REL)}`);
    expect(await code(get)).toBe("503 wiki_unavailable");
  });
});

describe("asked / not asked (D2, the O2 v1 rule)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const askedOf = async (app: Hono, rel: string, body: string): Promise<any> => {
    const res = await app.request(`/api/wiki/answers?wiki=answers&relPath=${encodeURIComponent(rel)}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { answers: { body: string; asked: boolean | null }[] }).answers.find((a) => a.body === body)?.asked;
  };
  const say = (app: Hono, rel: string, questionId: string, body: string) =>
    post(app, { wiki: "answers", relPath: rel, questionId, body });

  test("the ident decides when both sides carry one; the name only when one side lacks it", async () => {
    const asYvonne = appFor({ identity: yvonne, role: "user" });
    const asOla = appFor({ identity: ola, role: "user" });
    expect((await say(asYvonne, ASKED_REL, "A1", "yvonne on A1")).status).toBe(201);
    expect((await say(asOla, ASKED_REL, "A1", "ola on A1")).status).toBe(201);
    expect((await say(asOla, ASKED_REL, "A2", "ola on A2")).status).toBe(201);
    expect((await say(asYvonne, ASKED_REL, "A3", "yvonne on A3")).status).toBe(201);
    const viewer = appFor({ identity: ola, role: "admin" });
    expect(await askedOf(viewer, ASKED_REL, "yvonne on A1")).toBe(true);
    expect(await askedOf(viewer, ASKED_REL, "ola on A1")).toBe(false);
    // to="OLA  nordmann" names no ident: case-folded, whitespace-collapsed name.
    expect(await askedOf(viewer, ASKED_REL, "ola on A2")).toBe(true);
    // Same display name, different ident: the ident wins.
    expect(await askedOf(viewer, ASKED_REL, "yvonne on A3")).toBe(false);
  });

  test("auth off: the owner is asked where the question falls back to the owner, and not where it names someone else", async () => {
    const app = appFor();
    await say(app, REL, "O3", "owner on O3");
    await say(app, ASKED_REL, "A1", "owner on A1");
    expect(await askedOf(app, REL, "owner on O3")).toBe(true);
    expect(await askedOf(app, ASKED_REL, "owner on A1")).toBe(false);
  });

  test("a question that names nobody is null, not 'not asked'", async () => {
    const noOwner = { wikis: new Set(["answers"]), owner: null };
    const asYvonne = appFor({ identity: yvonne, role: "user", answers: noOwner });
    expect((await say(asYvonne, REL, "O3", "yvonne on O3")).status).toBe(201);
    expect(await askedOf(asYvonne, REL, "yvonne on O3")).toBeNull();
  });

  test("the GET still never carries an ident, asked included", async () => {
    await say(appFor({ identity: yvonne, role: "user" }), ASKED_REL, "A1", "ident check");
    const res = await appFor({ identity: ola, role: "user" }).request(`/api/wiki/answers?wiki=answers&relPath=${encodeURIComponent(ASKED_REL)}`);
    const text = await res.text();
    expect(text).not.toContain("X111111");
    expect(text).toContain('"asked":true');
  });
});

describe("answer cards fix round 1: WIKI_ANSWER_OWNER in the target format", () => {
  test("the owner's name is stored without the ident, and the ident decides asked", async () => {
    const app = appFor({ answers: { wikis: new Set(["answers"]), owner: "Rune Lind (Z555555)" } });
    const saved = await (await post(app, { wiki: "answers", relPath: OWNER_REL, questionId: "B1", body: "owner on B1" })).json();
    expect(saved.authorName).toBe("Rune Lind");
    const row = (await getDb()`SELECT author_name, author_nav_ident FROM wiki_answers WHERE answer_id = ${saved.answerId}`)[0]!;
    expect([row.author_name, row.author_nav_ident]).toEqual(["Rune Lind", "Z555555"]);
    await post(app, { wiki: "answers", relPath: OWNER_REL, questionId: "B2", body: "owner on B2" });
    const res = await app.request(`/api/wiki/answers?wiki=answers&relPath=${encodeURIComponent(OWNER_REL)}`);
    const { answers } = (await res.json()) as { answers: { body: string; asked: boolean | null; authorName: string }[] };
    expect(answers.find((a) => a.body === "owner on B1")?.asked).toBe(true);
    // Another spelling of the name, the same ident: asked.
    expect(answers.find((a) => a.body === "owner on B2")?.asked).toBe(true);
    expect(JSON.stringify(answers)).not.toContain("Z555555");
  });
});

describe("answer cards fix round 2: the page payload carries no owner ident", () => {
  test("/api/wiki/page with WIKI_ANSWER_OWNER in the target format names the owner and never the ident", async () => {
    const app = appFor({ answers: { wikis: new Set(["answers"]), owner: "Rune Lind (Z555555)" } });
    const res = await app.request(`/api/wiki/page?wiki=answers&relPath=${encodeURIComponent(REL)}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = JSON.parse(text) as { html: string; answers?: Record<string, unknown> };
    expect(data.answers).toEqual({ answerable: true, canExport: true });
    expect(data.html).toContain("Rune Lind");
    expect(text).not.toContain("Z555555");
  });
});

describe("answer cards PR 5: the scanner hook (D16)", () => {
  const MARKER = "SYNTHETIC-SECRET-0000";
  let dir = "";
  const mod = async (name: string, source: string) => {
    const file = path.join(dir, name);
    await Bun.write(file, source);
    return file;
  };
  const cfg = (scanner: string | null) => ({ wikis: new Set(["answers"]), owner: OWNER, scanner });
  const onNais = async <T>(fn: () => Promise<T>): Promise<T> => {
    __setReadonlyWikiRootsForTest([root]);
    __resetWikiCacheForTest();
    try {
      return await fn();
    } finally {
      __setReadonlyWikiRootsForTest();
      __resetWikiCacheForTest();
    }
  };
  const count = async () => (await getDb()`SELECT count(*)::int AS n FROM wiki_answers`)[0]!.n as number;
  let refuses = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "muninn-answer-scanners-"));
    refuses = await mod(
      "refuses.ts",
      `export function scanAnswer(text) { return text.includes("${MARKER}") ? [{ reason: "synthetic marker found" }, { reason: "second reason" }] : []; }`,
    );
  });
  afterAll(async () => {
    __resetAnswerScannerForTest();
    await rm(dir, { recursive: true, force: true });
  });

  test("nais with WIKI_ANSWER_SCANNER unset: a body is 503 scanner_unavailable and nothing is stored", async () => {
    await onNais(async () => {
      const before = await count();
      const res = await post(appFor({ identity: yvonne, role: "user", profile: "nais", answers: cfg(null) }), answer());
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("scanner_unavailable");
      expect(await count()).toBe(before);
    });
  });

  test("nais with the scanner unset: a choice-only answer has no text to scan and is stored", async () => {
    await onNais(async () => {
      const res = await post(appFor({ identity: yvonne, role: "user", profile: "nais", answers: cfg(null) }), answer({ body: "" }));
      expect(res.status).toBe(201);
    });
  });

  test("a clean body is stored; a flagged one is 422 with the scanner's own reasons, and nothing is stored", async () => {
    await onNais(async () => {
      const app = appFor({ identity: yvonne, role: "user", profile: "nais", answers: cfg(refuses) });
      expect((await post(app, answer({ body: "nothing to see" }))).status).toBe(201);
      const before = await count();
      const res = await post(app, answer({ body: `line one\ncontains ${MARKER} here` }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "scanner_refused",
        code: "scanner_refused",
        reasons: ["synthetic marker found", "second reason"],
      });
      expect(await count()).toBe(before);
    });
  });

  test("an edit is scanned too", async () => {
    const app = appFor({ answers: cfg(refuses) });
    const first = await (await post(app, answer({ body: "fine" }))).json();
    const res = await post(app, answer({ body: MARKER, answerId: first.answerId, baseVersion: 1 }));
    expect(res.status).toBe(422);
    const rows = await getDb()`SELECT version FROM wiki_answers WHERE answer_id = ${first.answerId}`;
    expect(rows.length).toBe(1);
  });

  test("an async scanner is awaited", async () => {
    const file = await mod("async.ts", `export async function scanAnswer(t) { await Bun.sleep(5); return t.includes("${MARKER}") ? [{ reason: "async" }] : []; }`);
    const res = await post(appFor({ answers: cfg(file) }), answer({ body: MARKER }));
    expect(res.status).toBe(422);
    expect((await res.json()).reasons).toEqual(["async"]);
  });

  test("fails closed: no export, a throw, a non-array, a malformed finding, a relative path, a missing file → 503", async () => {
    const cases = [
      await mod("noexport.ts", "export const other = 1;"),
      await mod("throws.ts", "export function scanAnswer() { throw new Error('synthetic failure'); }"),
      await mod("notarray.ts", "export function scanAnswer() { return 'clean'; }"),
      await mod("badshape.ts", "export function scanAnswer() { return [{ why: 'x' }]; }"),
      "relative/scanner.ts",
      path.join(dir, "missing.ts"),
    ];
    for (const scanner of cases) {
      for (const profile of ["default", "nais"] as const) {
        await onNais(async () => {
          const res = await post(appFor({ identity: yvonne, role: "user", profile, answers: cfg(scanner) }), answer());
          expect(`${profile} ${scanner} → ${res.status} ${(await res.json()).code}`).toBe(
            `${profile} ${scanner} → 503 scanner_unavailable`,
          );
        });
      }
    }
  });

  test("default profile with the scanner unset: stored unscanned, as before", async () => {
    const res = await post(appFor({ answers: cfg(null) }), answer({ body: `${MARKER} is fine here` }));
    expect(res.status).toBe(201);
  });

  // Fix round 1: the scan runs after every refusal that does not depend on the
  // text, so a flagged body never hides why the edit is refused anyway.
  test("a stranger's flagged edit is 403 not_author, not 422", async () => {
    const mine = await (await post(appFor({ identity: yvonne, role: "user", answers: cfg(refuses) }), answer({ body: "clean" }))).json();
    const res = await post(
      appFor({ identity: ola, role: "user", answers: cfg(refuses) }),
      answer({ body: MARKER, answerId: mine.answerId, baseVersion: 1 }),
    );
    expect(`${res.status} ${(await res.json()).code}`).toBe("403 not_author");
  });

  test("a flagged edit of an unknown answer is 404 unknown_answer, not 422", async () => {
    const res = await post(
      appFor({ answers: cfg(refuses) }),
      answer({ body: MARKER, answerId: "00000000-0000-4000-8000-000000000123", baseVersion: 1 }),
    );
    expect(`${res.status} ${(await res.json()).code}`).toBe("404 unknown_answer");
  });

  test("a flagged edit of a redacted answer is 409 answer_redacted, not 422", async () => {
    const app = appFor({ answers: cfg(refuses) });
    const first = await (await post(app, answer({ body: "clean" }))).json();
    await app.request("/api/wiki/answers/redact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answerId: first.answerId }),
    });
    const res = await post(app, answer({ body: MARKER, answerId: first.answerId, baseVersion: 1 }));
    expect(`${res.status} ${(await res.json()).code}`).toBe("409 answer_redacted");
  });

  test("nais with the scanner unset: a stranger's edit is 403 not_author, not 503", async () => {
    await onNais(async () => {
      const mine = await post(appFor({ identity: yvonne, role: "user", profile: "nais", answers: cfg(null) }), answer({ body: "" }));
      expect(mine.status).toBe(201);
      const { answerId } = await mine.json();
      const res = await post(
        appFor({ identity: ola, role: "user", profile: "nais", answers: cfg(null) }),
        answer({ body: "an edit with text", answerId, baseVersion: 1 }),
      );
      expect(`${res.status} ${(await res.json()).code}`).toBe("403 not_author");
    });
  });

  test("a 422 carries at most 20 reasons, each at most 300 characters, and counts the rest", async () => {
    const many = await mod(
      "many.ts",
      "export function scanAnswer() { return Array.from({ length: 100 }, (_, i) => ({ reason: String(i).padEnd(1000, 'y') })); }",
    );
    const res = await post(appFor({ answers: cfg(many) }), answer({ body: "anything" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reasons.length).toBe(20);
    expect(body.reasons.every((r: string) => [...r].length <= 300)).toBe(true);
    expect(body.moreReasons).toBe(80);
  });
});

describe("answer cards PR 5 fix round 1: ids, sizes and blank bodies", () => {
  const redact = (app: Hono, body: unknown) =>
    app.request("/api/wiki/answers/redact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("a redact naming the id in uppercase answers with the stored lowercase id", async () => {
    const first = await (await post(appFor(), answer())).json();
    const res = await redact(appFor(), { answerId: first.answerId.toUpperCase() });
    expect(res.status).toBe(200);
    expect((await res.json()).answerId).toBe(first.answerId);
  });

  const over = WIKI_ANSWER_BODY_LIMIT + 1;
  const pad = (bytes: number) => "x".repeat(bytes);
  test("an answer POST over the limit is 413 before it is parsed", async () => {
    expect((await post(appFor(), answer({ body: pad(over) }))).status).toBe(413);
  });

  test("a redact over the limit is 413 before it is parsed", async () => {
    expect((await redact(appFor(), JSON.stringify({ answerId: "x", pad: pad(over) }))).status).toBe(413);
  });

  test("an export confirm over the limit is 413 before it is parsed", async () => {
    const confirm = await appFor().request("/api/wiki/answers/export/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: "answers", relPath: REL, rows: [], pad: pad(over) }),
    });
    expect(confirm.status).toBe(413);
  });

  /** JSON as an ASCII-only encoder writes it (Python's `json.dumps` default):
   *  every non-ASCII code unit as `\uXXXX`, so an astral character is 12 bytes. */
  const asciiJson = (v: unknown) =>
    JSON.stringify(v).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const postRaw = (app: Hono, raw: string) =>
    app.request("/api/wiki/answers", { method: "POST", headers: { "content-type": "application/json" }, body: raw });

  test("the largest answer validation accepts, sent ASCII-escaped, is stored rather than 413", async () => {
    const raw = asciiJson(answer({ body: "\u{1F600}".repeat(QUESTION_ANSWER_MAX) }));
    expect(raw.length).toBeGreaterThan(QUESTION_ANSWER_MAX * 12);
    expect(raw).not.toMatch(/[^\x00-\x7f]/);
    const res = await postRaw(appFor(), raw);
    expect(res.status).toBe(201);
    expect((await res.json()).body).toBe("\u{1F600}".repeat(QUESTION_ANSWER_MAX));
  });

  test("a POST of exactly the limit is read; one byte more is 413", async () => {
    const base = JSON.stringify(answer({ pad: "" }));
    const exact = JSON.stringify(answer({ pad: pad(WIKI_ANSWER_BODY_LIMIT - base.length) }));
    expect(exact.length).toBe(WIKI_ANSWER_BODY_LIMIT);
    expect((await postRaw(appFor(), exact)).status).toBe(201);
    const plusOne = JSON.stringify(answer({ pad: pad(WIKI_ANSWER_BODY_LIMIT - base.length + 1) }));
    expect(plusOne.length).toBe(WIKI_ANSWER_BODY_LIMIT + 1);
    expect((await postRaw(appFor(), plusOne)).status).toBe(413);
  });

  test("a whitespace-only body with a choice is stored as an empty body", async () => {
    const res = await post(appFor(), answer({ body: "   \n\t ", choice: "A" }));
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.body).toBe("");
    const [row] = await getDb()`SELECT body FROM wiki_answers WHERE answer_id = ${saved.answerId}`;
    expect(row!.body).toBe("");
  });
});

describe("answer cards PR 5: redact (D15)", () => {
  const redact = (app: Hono, body: unknown, contentType = "application/json") =>
    app.request("/api/wiki/answers/redact", {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify(body),
    });

  test("an admin redacts every version: body and choice emptied, the GET and the log say redacted", async () => {
    const app = appFor({ identity: yvonne, role: "user" });
    const first = await (await post(app, answer({ body: "v1 text" }))).json();
    await post(app, answer({ body: "v2 text", answerId: first.answerId, baseVersion: 1 }));
    const res = await redact(appFor({ identity: ola, role: "admin" }), { answerId: first.answerId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answerId: first.answerId, redacted: true, versions: 2, alreadyRedacted: false });
    const rows = await getDb()`SELECT body, choice, redacted_at FROM wiki_answers WHERE answer_id = ${first.answerId}`;
    expect(rows.map((r) => [r.body, r.choice, r.redacted_at !== null])).toEqual([
      ["", null, true],
      ["", null, true],
    ]);
    const data = await getAnswers(appFor({ identity: yvonne, role: "user" }), "&versions=1");
    const a = data.answers.find((x: { answerId: string }) => x.answerId === first.answerId);
    expect(a).toMatchObject({ redacted: true, body: "", choice: null });
    expect(a.earlier.every((v: { redacted: boolean; body: string }) => v.redacted && v.body === "")).toBe(true);
  });

  test("idempotent: a second redact is 200 with alreadyRedacted", async () => {
    const first = await (await post(appFor(), answer())).json();
    expect((await redact(appFor(), { answerId: first.answerId })).status).toBe(200);
    const again = await redact(appFor(), { answerId: first.answerId });
    expect(again.status).toBe(200);
    expect((await again.json()).alreadyRedacted).toBe(true);
  });

  test("an edit of a redacted answer is 409 answer_redacted", async () => {
    const app = appFor();
    const first = await (await post(app, answer())).json();
    await redact(app, { answerId: first.answerId });
    const res = await post(app, answer({ body: "again", answerId: first.answerId, baseVersion: 1 }));
    expect(`${res.status} ${(await res.json()).code}`).toBe("409 answer_redacted");
  });

  test("refusals: role user 403, unknown 404, a bad id 400, text/plain 415", async () => {
    const first = await (await post(appFor(), answer())).json();
    const user = await redact(appFor({ identity: yvonne, role: "user" }), { answerId: first.answerId });
    expect(`${user.status} ${(await user.json()).code}`).toBe("403 admin_only");
    const unknown = await redact(appFor(), { answerId: "00000000-0000-4000-8000-000000000000" });
    expect(`${unknown.status} ${(await unknown.json()).code}`).toBe("404 unknown_answer");
    for (const answerId of [undefined, 1, "not-a-uuid"]) {
      expect((await redact(appFor(), { answerId })).status).toBe(400);
    }
    expect((await redact(appFor(), { answerId: first.answerId }, "text/plain")).status).toBe(415);
    const row = (await getDb()`SELECT redacted_at FROM wiki_answers WHERE answer_id = ${first.answerId}`)[0]!;
    expect(row.redacted_at).toBeNull();
  });

  test("does not depend on WIKI_ANSWER_WIKIS: cleanup works after the wiki leaves the list", async () => {
    const first = await (await post(appFor(), answer())).json();
    const off = appFor({ answers: { wikis: new Set(), owner: OWNER } });
    expect((await redact(off, { answerId: first.answerId })).status).toBe(200);
  });
});
