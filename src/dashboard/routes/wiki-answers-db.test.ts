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
import { registerWikiAnswerRoutes, type WikiAnswerStore } from "./wiki-answers.ts";
import {
  getLatestWikiAnswerVersion,
  insertWikiAnswerVersion,
  listLatestWikiAnswers,
  listWikiAnswerVersions,
} from "../../db/wiki-answers.ts";
import { registerWikiReadRoutes } from "./wiki-routes.ts";
import { QUESTION_NOT_SURE } from "../../format/question.ts";
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
  opts: { identity?: Identity; role?: AuthRole; answers?: WikiAnswerConfig; store?: WikiAnswerStore } = {},
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.identity) c.set("identity", opts.identity);
    if (opts.role) c.set("role", opts.role);
    await next();
  });
  const config = {
    dashboardPort: 3010,
    profile: "default",
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
  __setWikiRegistryForTest([
    { name: "answers", root, source: "extra" },
    { name: "cards-only", root, source: "extra" },
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
    const res = await post(app, answer({ questionId: "O3", choice: null, body: "v2", answerId: first.answerId }));
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
      const res = await post(app, answer({ answerId: first.answerId, body: "hijack" }));
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
      post(app, answer({ body: "edit A", answerId: first.answerId })),
      post(app, answer({ body: "edit B", answerId: first.answerId })),
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
    const res = await post(app, answer({ answerId: first.answerId, body: "edited" }));
    expect(res.status).toBe(200);
  });

  test("an answerId from another question, or none at all, is unknown", async () => {
    const app = appFor();
    const first = await (await post(app, answer())).json();
    for (const answerId of [first.answerId.replace(/.$/, first.answerId.endsWith("0") ? "1" : "0"), "not-a-uuid"]) {
      const res = await post(app, answer({ answerId }));
      expect(res.status).toBe(404);
    }
    const res = await post(app, answer({ questionId: "O3", choice: null, answerId: first.answerId }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("unknown_answer");
  });

  test("an edit of a redacted answer is refused", async () => {
    const app = appFor();
    const first = await (await post(app, answer())).json();
    await getDb()`UPDATE wiki_answers SET redacted_at = now(), body = '', choice = NULL WHERE answer_id = ${first.answerId}`;
    const res = await post(app, answer({ answerId: first.answerId }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("answer_redacted");
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
    await post(asYvonne, answer({ questionId: "O3", choice: null, body: "second", answerId: first.answerId }));
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
    await post(app, answer({ body: "edited after", answerId: first.answerId }));
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
    return (await res.json()) as { html: string; answers?: { answerable: boolean; canExport: boolean; owner: string | null } };
  };

  test("answerable cards, the page flags, and the owner as the default For", async () => {
    const data = await page(appFor(), "answers");
    expect(data.answers).toEqual({ answerable: true, canExport: true, owner: OWNER });
    expect(data.html).toContain('data-wiki-answerable="true"');
    expect(data.html).toContain('data-question-to-source="owner"');
    expect(data.html).toContain(`data-question-to="${OWNER}"`);
    expect(data.html).toContain(`<span class="q-for-label">For</span> ${OWNER}`);
  });

  test("canExport is admin only", async () => {
    expect((await page(appFor({ identity: yvonne, role: "user" }), "answers")).answers?.canExport).toBe(false);
    expect((await page(appFor({ identity: yvonne, role: "admin" }), "answers")).answers?.canExport).toBe(true);
  });

  test("a wiki not in WIKI_ANSWER_WIKIS: read-only cards, no flags, no owner", async () => {
    const data = await page(appFor(), "cards-only");
    expect(data.answers).toBeUndefined();
    expect(data.html).toContain('data-wiki-answerable="false"');
    expect(data.html).not.toContain('data-question-to-source="owner"');
    expect(data.html).not.toContain(OWNER);
  });
});
