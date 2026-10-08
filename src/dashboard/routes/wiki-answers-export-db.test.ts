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
import { EXPORT_CONFIRM_MAX_ROWS, registerWikiAnswerRoutes } from "./wiki-answers.ts";

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

function appFor(opts: { role?: AuthRole; identity?: boolean } = {}): Hono {
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
  registerWikiAnswerRoutes(app, config);
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
  return { status: res.status, body: (await res.json()) as { block: string; rows: [string, number][]; count: number; orphanCount: number; code?: string } };
};

const confirm = (app: Hono, rows: unknown, contentType = "application/json") =>
  app.request("/api/wiki/answers/export/confirm", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify({ rows }),
  });

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
    expect(await res.json()).toEqual({ block: "", rows: [], count: 0, orphanCount: 0 });
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
    expect((await getExport(app)).body).toEqual({ block: "", rows: [], count: 0, orphanCount: 0 });
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
    expect(rest.join("\n")).toBe(EXPECTED_ANSWERS);
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
    expect((await getExport(appFor(), "&again=1")).body).toEqual({ block: "", rows: [], count: 0, orphanCount: 0 });
  });
});
