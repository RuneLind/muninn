/**
 * The answer export (answer cards PR 4) against the REAL test database and a
 * temp wiki: `GET /api/wiki/answers/export` (new, `again=1`, `orphans=1`) and
 * `POST /api/wiki/answers/export/confirm`. Admin vs user, the block byte for
 * byte, the orphan rule (O4), and the confirm's exact rows, shared timestamp,
 * retry and concurrent edit.
 *
 * Identity is injected the way the auth middleware sets it; no identity is
 * `MUNINN_AUTH=off`, which is admin. Its own `bun test` link in the `test` and
 * `test:db` chains. Synthetic fixtures only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import { getDb } from "../../db/client.ts";
import type { Config } from "../../config.ts";
import type { AuthRole } from "../../auth/role.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { EXPORT_CONFIRM_MAX_ROWS, registerWikiAnswerRoutes, type WikiAnswerExportStore } from "./wiki-answers.ts";
import {
  getLatestWikiAnswerVersion,
  insertWikiAnswerVersion,
  listLastExportedWikiAnswers,
  listLatestWikiAnswers,
  listWikiAnswerLocations,
  listWikiAnswerVersions,
  markWikiAnswersExported,
} from "../../db/wiki-answers.ts";

setupTestDb();

const WIKI = "exp";
const REL = "plans/eksport.mdx";
const PAGE = [
  "---",
  "title: Eksport",
  'questions_to: ["Yvonne Jacobs (X111111)"]',
  "---",
  "",
  '<Question id="E1" choices="A|B">',
  "",
  "**Skal blokken være på norsk?**",
  "",
  "</Question>",
  "",
  '<Question id="E2">',
  "",
  "Hvem svarer?",
  "",
  "</Question>",
  "",
  '<Question id="E3">',
  "",
  "Lukket, blokken står igjen.",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Norsk.",
  "- **E1** — Språk?",
  "- **E2** — Hvem?",
  "- **E3** — Lukket 08.10 (D1).",
  "- **E9** — Blokken er fjernet. Closed 2026-10-08 (D1).",
  "",
  "</DecisionLog>",
  "",
].join("\n");

let root = "";

function appFor(opts: { role?: AuthRole; identity?: boolean; exportStore?: WikiAnswerExportStore } = {}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.identity) {
      c.set("identity", {
        userId: "u-admin",
        displayName: "Admin Person",
        navIdent: "Z999999",
        oid: "oid-admin",
        provider: "entra",
        expiresAt: null,
      });
    }
    if (opts.role) c.set("role", opts.role);
    await next();
  });
  const config = {
    dashboardPort: 3010,
    profile: "default",
    wikiAnswers: { wikis: new Set([WIKI]), owner: "Rune Owner" },
  } as unknown as Config;
  registerWikiAnswerRoutes(
    app,
    config,
    {
      insert: insertWikiAnswerVersion,
      getLatest: getLatestWikiAnswerVersion,
      listLatest: listLatestWikiAnswers,
      listVersions: listWikiAnswerVersions,
    },
    opts.exportStore ?? {
      listLatest: listLatestWikiAnswers,
      listLastExported: listLastExportedWikiAnswers,
      listLocations: listWikiAnswerLocations,
      markExported: markWikiAnswersExported,
    },
  );
  return app;
}

// 2026-10-07 19:32 UTC = 21:32 Oslo.
const T0 = "2026-10-07T19:32:00Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

async function insert(r: {
  id: string;
  version: number;
  rel?: string;
  q: string;
  name: string;
  ident?: string | null;
  choice?: string | null;
  body: string;
  created: string;
}) {
  await getDb()`
    INSERT INTO wiki_answers (answer_id, version, wiki, rel_path, question_id, author_name, author_nav_ident, choice, body, question_hash, created_at)
    VALUES (${r.id}, ${r.version}, ${WIKI}, ${r.rel ?? REL}, ${r.q}, ${r.name}, ${r.ident ?? null}, ${r.choice ?? null}, ${r.body}, 'seed', ${r.created}::timestamptz)
  `;
}

const ids = { e1: "", e2: "", e5: "", e9: "", gone: "" };

async function seed() {
  await getDb()`DELETE FROM wiki_answers WHERE wiki = ${WIKI}`;
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) ids[k] = randomUUID();
  // E1: the person asked (ident match), edited once — v2 is what exports.
  await insert({ id: ids.e1, version: 1, q: "E1", name: "Yvonne Jacobs", ident: "X111111", choice: "A", body: "Først A.", created: at(0) });
  await insert({ id: ids.e1, version: 2, q: "E1", name: "Yvonne Jacobs", ident: "X111111", choice: "B", body: "Første linje.\nAndre — «sitat» æøå.", created: at(5) });
  // E2: someone not asked, no choice, a blank line in the body.
  await insert({ id: ids.e2, version: 1, q: "E2", name: "Ola Nordmann", ident: "Y222222", body: "Ett.\n\nTre.", created: at(1) });
  // E5: the question is gone from the page and its item is not closed: an orphan, asked null.
  await insert({ id: ids.e5, version: 1, q: "E5", name: "Kari Nordmann", body: "Til et spørsmål som er borte.", created: at(2) });
  // E9: the block is gone but the item is closed: never an orphan.
  await insert({ id: ids.e9, version: 1, q: "E9", name: "Kari Nordmann", body: "Avgjort.", created: at(3) });
  // A page that was renamed away: every answer on it is an orphan.
  await insert({ id: ids.gone, version: 1, rel: "plans/gammelt-navn.mdx", q: "E1", name: "Ola Nordmann", body: "Gammel side.", created: at(4) });
}

const getExport = async (app: Hono, extra = "") => {
  const res = await app.request(`/api/wiki/answers/export?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}${extra}`);
  return {
    status: res.status,
    body: (await res.json()) as {
      block: string;
      rows: [string, number][];
      count: number;
      orphanCount: number;
      again?: { block: string; rows: [string, number][]; count: number };
      code?: string;
    },
  };
};

const confirm = (app: Hono, rows: unknown, contentType = "application/json", page: Record<string, unknown> = { wiki: WIKI, relPath: REL }) =>
  app.request("/api/wiki/answers/export/confirm", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify({ ...page, rows }),
  });

const NO_AGAIN = { block: "", rows: [], count: 0 };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-answer-export-"));
  await Bun.write(path.join(root, REL), PAGE);
  __setWikiRegistryForTest([
    { name: WIKI, root, source: "extra" },
    { name: "cards-only", root, source: "extra" },
  ]);
  __resetWikiCacheForTest();
});

beforeEach(seed);

afterAll(async () => {
  await getDb()`DELETE FROM wiki_answers WHERE wiki = ${WIKI}`;
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(root, { recursive: true, force: true });
});

const EXPECTED_ANSWERS = [
  "### E1 — Yvonne Jacobs (asked), 07.10.2026 21:37, chose B, version 2",
  "> Første linje.",
  "> Andre — «sitat» æøå.",
  "",
  "### E2 — Ola Nordmann (not asked), 07.10.2026 21:33, version 1",
  "> Ett.",
  ">",
  "> Tre.",
  "",
  "### E5 — Kari Nordmann, 07.10.2026 21:34, version 1",
  "> Til et spørsmål som er borte.",
  "",
  "### E9 — Kari Nordmann, 07.10.2026 21:35, version 1",
  "> Avgjort.",
  "",
  "<!-- orphaned answers in exp: 2 -->",
  "",
].join("\n");

describe("who may export", () => {
  test("role user: 403 on the GET and the confirm, and nothing is marked", async () => {
    const app = appFor({ identity: true, role: "user" });
    expect((await getExport(app)).status).toBe(403);
    expect((await app.request(`/api/wiki/answers/export?wiki=${WIKI}&orphans=1`)).status).toBe(403);
    const res = await confirm(app, [[ids.e2, 1]]);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("admin_only");
    const n = (await getDb()`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI} AND exported_at IS NOT NULL`)[0]!.n;
    expect(n).toBe(0);
  });

  test("role admin and auth off: 200", async () => {
    expect((await getExport(appFor({ identity: true, role: "admin" }))).status).toBe(200);
    expect((await getExport(appFor())).status).toBe(200);
  });

  test("a wiki outside WIKI_ANSWER_WIKIS exports nothing", async () => {
    const res = await appFor().request(`/api/wiki/answers/export?wiki=cards-only&relPath=${encodeURIComponent(REL)}`);
    expect(await res.json()).toEqual({ block: "", rows: [], count: 0, orphanCount: 0, again: NO_AGAIN });
  });
});

describe("GET export", () => {
  test("the block, byte for byte after the header; the latest version per answer; marks nothing", async () => {
    const { status, body } = await getExport(appFor());
    expect(status).toBe(200);
    const [header, ...rest] = body.block.split("\n");
    expect(header).toMatch(/^<!-- answers · exp · plans\/eksport\.mdx · exported \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->$/);
    expect(rest.join("\n")).toBe(EXPECTED_ANSWERS);
    expect(body.count).toBe(4);
    expect(body.orphanCount).toBe(2);
    expect(new Set(body.rows.map(([id, v]) => `${id}:${v}`))).toEqual(
      new Set([`${ids.e1}:2`, `${ids.e2}:1`, `${ids.e5}:1`, `${ids.e9}:1`]),
    );
    const marked = (await getDb()`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI} AND exported_at IS NOT NULL`)[0]!.n;
    expect(marked).toBe(0);
  });

  test("a redacted answer is not a new answer", async () => {
    await getDb()`UPDATE wiki_answers SET redacted_at = now(), body = '', choice = NULL WHERE answer_id = ${ids.e2}`;
    const { body } = await getExport(appFor());
    expect(body.count).toBe(3);
    expect(body.block).not.toContain("### E2");
  });

  test("orphans=1 lists the renamed page and the deleted question, never the closed item", async () => {
    const res = await appFor().request(`/api/wiki/answers/export?wiki=${WIKI}&orphans=1`);
    const { orphans } = (await res.json()) as { orphans: { answerId: string; relPath: string; questionId: string; reason: string }[] };
    expect(orphans.map((o) => [o.answerId, o.relPath, o.questionId, o.reason])).toEqual([
      [ids.e5, REL, "E5", "question_gone"],
      [ids.gone, "plans/gammelt-navn.mdx", "E1", "page_gone"],
    ]);
  });
});

describe("POST confirm", () => {
  test("marks exactly the listed rows plus earlier versions, with ONE shared timestamp; a retry marks 0", async () => {
    const app = appFor();
    const { body } = await getExport(app);
    const res = await confirm(app, body.rows);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ marked: 5 }); // E1 v1+v2, E2, E5, E9
    const stamps = await getDb()`SELECT DISTINCT exported_at FROM wiki_answers WHERE wiki = ${WIKI} AND exported_at IS NOT NULL`;
    expect(stamps.length).toBe(1);
    const unmarked = await getDb()`SELECT answer_id FROM wiki_answers WHERE wiki = ${WIKI} AND exported_at IS NULL`;
    expect(unmarked.map((r) => r.answer_id)).toEqual([ids.gone]);
    expect(await (await confirm(app, body.rows)).json()).toEqual({ marked: 0 });
    // Nothing new; the renamed page's answer is still an orphan (E5 was copied, so it is not).
    const after = (await getExport(app)).body;
    expect([after.block, after.rows, after.count, after.orphanCount]).toEqual(["", [], 0, 1]);
    expect(after.again?.count).toBe(4);
  });

  test("an edit between the GET and the confirm stays unexported, and exports next time in its latest version", async () => {
    const app = appFor();
    const { body } = await getExport(app);
    await insert({ id: ids.e1, version: 3, q: "E1", name: "Yvonne Jacobs", ident: "X111111", choice: "A", body: "Ombestemt.", created: at(9) });
    expect(await (await confirm(app, body.rows)).json()).toEqual({ marked: 5 });
    const v3 = await getDb()`SELECT exported_at FROM wiki_answers WHERE answer_id = ${ids.e1} AND version = 3`;
    expect(v3[0]!.exported_at).toBeNull();
    const next = (await getExport(app)).body;
    expect(next.count).toBe(1);
    expect(next.rows).toEqual([[ids.e1, 3]]);
    expect(next.block).toContain("### E1 — Yvonne Jacobs (asked), 07.10.2026 21:41, chose A, version 3\n> Ombestemt.\n");
  });

  test("refusals: not JSON 415, bad rows 400, over the cap 400", async () => {
    const app = appFor();
    expect((await confirm(app, [[ids.e1, 2]], "text/plain")).status).toBe(415);
    for (const rows of [[], [[ids.e1]], [["not-a-uuid", 1]], [[ids.e1, 0]], [[ids.e1, 1.5]], "x"]) {
      expect(`${JSON.stringify(rows)} → ${(await confirm(app, rows)).status}`).toBe(`${JSON.stringify(rows)} → 400`);
    }
    const tooMany = Array.from({ length: EXPORT_CONFIRM_MAX_ROWS + 1 }, () => [ids.e1, 1]);
    expect((await confirm(app, tooMany)).status).toBe(400);
    const marked = (await getDb()`SELECT count(*)::int AS n FROM wiki_answers WHERE wiki = ${WIKI} AND exported_at IS NOT NULL`)[0]!.n;
    expect(marked).toBe(0);
  });
});

describe("GET export again=1", () => {
  test("returns the last batch, latest version per answer, and marks nothing", async () => {
    const app = appFor();
    const first = (await getExport(app)).body;
    await confirm(app, first.rows);
    const stamp = (await getDb()`SELECT max(exported_at) AS t FROM wiki_answers WHERE wiki = ${WIKI}`)[0]!.t as Date;
    // An edit after the copy: again still shows the version that was copied.
    await insert({ id: ids.e2, version: 2, q: "E2", name: "Ola Nordmann", ident: "Y222222", body: "Endret etterpå.", created: at(20) });
    const again = (await getExport(app, "&again=1")).body;
    expect(again.count).toBe(4);
    const [header, ...rest] = again.block.split("\n");
    expect(header).toContain(" · exported ");
    // E5 was copied, so only the renamed page's answer is still an orphan.
    expect(rest.join("\n")).toBe(EXPECTED_ANSWERS.replace("in exp: 2", "in exp: 1"));
    expect(new Set(again.rows.map(([id, v]) => `${id}:${v}`))).toEqual(
      new Set([`${ids.e1}:2`, `${ids.e2}:1`, `${ids.e5}:1`, `${ids.e9}:1`]),
    );
    expect(stamp).toBeInstanceOf(Date);
    const after = (await getDb()`SELECT max(exported_at) AS t FROM wiki_answers WHERE wiki = ${WIKI}`)[0]!.t as Date;
    expect(after.getTime()).toBe(stamp.getTime());
    expect((await getDb()`SELECT exported_at FROM wiki_answers WHERE answer_id = ${ids.e2} AND version = 2`)[0]!.exported_at).toBeNull();
  });

  test("a redacted answer in the last batch shows as redacted", async () => {
    const app = appFor();
    await confirm(app, (await getExport(app)).body.rows);
    await getDb()`UPDATE wiki_answers SET redacted_at = now(), body = '', choice = NULL WHERE answer_id = ${ids.e1}`;
    const again = (await getExport(app, "&again=1")).body;
    expect(again.block).toContain("### E1 — Yvonne Jacobs (asked), 07.10.2026 21:37, redacted, version 2\n\n### E2");
  });

  test("nothing ever exported ⇒ empty", async () => {
    expect((await getExport(appFor(), "&again=1")).body).toEqual({ block: "", rows: [], count: 0, orphanCount: 2 });
  });
});

describe("answer export fix round 1", () => {
  const countOrphans = async () => {
    const res = await appFor().request(`/api/wiki/answers/export?wiki=${WIKI}&orphans=1`);
    return ((await res.json()) as { orphans: { answerId: string; version: number }[] }).orphans;
  };

  test("a page with nothing to copy still reports the wiki's orphans", async () => {
    await getDb()`UPDATE wiki_answers SET exported_at = now() WHERE wiki = ${WIKI} AND rel_path = ${REL}`;
    const plain = (await getExport(appFor())).body;
    expect([plain.count, plain.orphanCount]).toEqual([0, 1]);
    const again = (await getExport(appFor(), "&again=1")).body;
    expect(again.orphanCount).toBe(1);
  });

  test("an orphan is an answer whose LATEST version is unexported and not redacted", async () => {
    // The renamed page's answer was copied before the rename: it reached the agent.
    await getDb()`UPDATE wiki_answers SET exported_at = now() WHERE answer_id = ${ids.gone}`;
    expect((await countOrphans()).map((o) => o.answerId)).toEqual([ids.e5]);
    // E5 redacted: nothing left to copy.
    await getDb()`UPDATE wiki_answers SET redacted_at = now(), body = '', choice = NULL WHERE answer_id = ${ids.e5}`;
    expect(await countOrphans()).toEqual([]);
    expect((await getExport(appFor())).body.orphanCount).toBe(0);
    // An edit after the copy is new again: the renamed page's answer is an orphan in version 2.
    await insert({ id: ids.gone, version: 2, rel: "plans/gammelt-navn.mdx", q: "E1", name: "Ola Nordmann", body: "Etter kopien.", created: at(30) });
    expect((await countOrphans()).map((o) => [o.answerId, o.version])).toEqual([[ids.gone, 2]]);
  });

  test("orphans=1 carries what copying an orphan by hand needs", async () => {
    await getDb()`UPDATE wiki_answers SET choice = 'A' WHERE answer_id = ${ids.gone}`;
    const orphans = (await (await appFor().request(`/api/wiki/answers/export?wiki=${WIKI}&orphans=1`)).json()) as {
      orphans: Record<string, unknown>[];
    };
    expect(orphans.orphans.find((o) => o.answerId === ids.gone)).toEqual({
      answerId: ids.gone,
      relPath: "plans/gammelt-navn.mdx",
      questionId: "E1",
      authorName: "Ola Nordmann",
      version: 1,
      createdAt: Date.parse(at(4)),
      time: "07.10.2026 21:36",
      choice: "A",
      body: "Gammel side.",
      reason: "page_gone",
    });
  });

  test("a confirm marks only rows of the page it names", async () => {
    const app = appFor();
    // The renamed page's answer, confirmed under this page: not marked.
    expect(await (await confirm(app, [[ids.gone, 1]])).json()).toEqual({ marked: 0 });
    expect((await getDb()`SELECT exported_at FROM wiki_answers WHERE answer_id = ${ids.gone}`)[0]!.exported_at).toBeNull();
    // Without a page, no confirm at all.
    const res = await confirm(app, [[ids.e2, 1]], "application/json", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "bad_request", error: "wiki and relPath required" });
    expect((await getDb()`SELECT exported_at FROM wiki_answers WHERE answer_id = ${ids.e2}`)[0]!.exported_at).toBeNull();
  });

  test("a version the answer does not have marks nothing", async () => {
    expect(await (await confirm(appFor(), [[ids.e1, 99]])).json()).toEqual({ marked: 0 });
    const n = (await getDb()`SELECT count(*)::int AS n FROM wiki_answers WHERE answer_id = ${ids.e1} AND exported_at IS NOT NULL`)[0]!.n;
    expect(n).toBe(0);
  });

  test("a version past the int4 range is a 400, not a 500", async () => {
    const res = await confirm(appFor(), [[ids.e1, 2147483648]]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_rows");
  });

  test("the plain GET carries the last batch for Copy again, from ONE orphan scan", async () => {
    let scans = 0;
    const app = appFor({
      exportStore: {
        listLatest: listLatestWikiAnswers,
        listLastExported: listLastExportedWikiAnswers,
        listLocations: (w) => (scans++, listWikiAnswerLocations(w)),
        markExported: markWikiAnswersExported,
      },
    });
    await confirm(app, [[ids.e2, 1]]);
    scans = 0;
    const { body } = await getExport(app);
    expect(scans).toBe(1);
    expect(body.count).toBe(3);
    expect(body.again?.count).toBe(1);
    expect(body.again?.rows).toEqual([[ids.e2, 1]]);
    expect(body.again?.block).toContain("### E2 — Ola Nordmann (not asked)");
    expect(body.again?.block).toEndWith(`<!-- orphaned answers in exp: ${body.orphanCount} -->\n`);
  });
});
