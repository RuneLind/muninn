/**
 * The provenance ROUTES: the two reverse lookups, the `jira` facet counts on the
 * hot listing, the `provenance` block on the single page, and what `toListing`
 * strips.
 *
 * Two temp wikis are registered, because the reverse lookups' whole point is
 * that they iterate the REGISTRY rather than resolving one wiki: a Jira issue is
 * served by a page in the kode-wiki and discussed in a mimir plan, and a
 * per-wiki answer is the wrong answer.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import {
  registerWikiProvenanceRoutes,
  PROVENANCE_PAGES_MAX,
  PROVENANCE_REFS_MAX,
} from "./wiki-provenance.ts";
import { SESSION_ID_MAX_CHARS } from "../../wiki/session-ledger.ts";
import { registerWikiRoutes } from "./wiki-routes.ts";
import type { ProvenanceContext } from "../../wiki/provenance-service.ts";
import type { Config } from "../../config.ts";

const ID_A = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const SESSION_A = `claude-code:${ID_A}`;
const SESSION_B = "opencode:ses_7f3a9b2c1d";

let mimir = "";
let kode = "";
let app: Hono;
let pageApp: Hono;

/** A ledger that holds A and nothing else — so every assertion has one priced
 *  session and one bare chip, the two states the reader must tell apart. */
function testCtx(over: Partial<ProvenanceContext> = {}): ProvenanceContext {
  return {
    sessionLedger: {
      baseUrl: "http://127.0.0.1:8787",
      urlConfigured: true,
      fetchSessions: async (ids) => ({
        sessions: ids.map((id) =>
          id === ID_A
            ? { sessionId: id, title: "The session", provider: "claude-code", host: "mini", hosts: ["mini"], first: null, last: null, cost: 2.5, messages: 7 }
            : { sessionId: id, missing: true },
        ),
      }),
    },
    ledgerConfigured: true,
    knowledgeApiUrl: "http://localhost:8321",
    publicUrl: null,
    loadJiraIndex: async () => null,
    ...over,
  };
}

beforeAll(async () => {
  mimir = await mkdtemp(path.join(tmpdir(), "prov-mimir-"));
  kode = await mkdtemp(path.join(tmpdir(), "prov-kode-"));

  await writeFile(
    path.join(mimir, "plan.md"),
    `---\ntype: plan\ntitle: A plan\nsessions: [${SESSION_A}, ${SESSION_B}]\nsessions_backfilled: 2026-10-14\njira: [MELOSYS-8045]\nprs: [RuneLind/muninn#543]\n---\n\n# A plan\n\nBody.\n`,
  );
  await writeFile(
    path.join(mimir, "plain.md"),
    "---\ntype: plan\ntitle: Plain\n---\n\n# Plain\n\nNothing stamped.\n",
  );
  await writeFile(
    path.join(kode, "service.md"),
    `---\ntitle: A service\njira: [melosys-8045, MELOSYS-9]\nsessions: [${SESSION_B}]\n---\n\n# A service\n`,
  );

  __setWikiRegistryForTest([
    { name: "mimir", root: mimir, source: "extra" },
    { name: "kode", root: kode, source: "extra" },
  ]);
  __resetWikiCacheForTest();

  app = new Hono();
  registerWikiProvenanceRoutes(app, {} as Config, testCtx());

  pageApp = new Hono();
  registerWikiRoutes(pageApp, { knowledgeApiUrl: "http://localhost:8321", claudeUsageUrl: null, claudeUsagePublicUrl: null } as Config);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(mimir, { recursive: true, force: true });
  await rm(kode, { recursive: true, force: true });
});

describe("GET /api/wiki/provenance?jira=", () => {
  test("answers across EVERY registered wiki, with the key normalized", async () => {
    const res = await app.request("/api/wiki/provenance?jira=melosys-8045");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("MELOSYS-8045");
    expect(body.pages.map((p: { wiki: string; relPath: string }) => `${p.wiki}/${p.relPath}`).sort()).toEqual([
      "kode/service.md",
      "mimir/plan.md",
    ]);
  });

  test("the sessions across those pages are deduped and priced once", async () => {
    const body = await (await app.request("/api/wiki/provenance?jira=MELOSYS-8045")).json();
    // plan.md names A + B, service.md names B again.
    expect(body.sessions.length).toBe(2);
    expect(body.totalCost).toBe(2.5);
    expect(body.costedSessions).toBe(1);
    expect(body.ledger.reachable).toBe(true);
  });

  test("a key nothing serves is an empty page list, not a 404", async () => {
    const res = await app.request("/api/wiki/provenance?jira=NOBODY-1");
    expect(res.status).toBe(200);
    expect((await res.json()).pages).toEqual([]);
  });

  test("a non-key shape is a 400 naming the NORMALIZED key, never the raw input", async () => {
    const res = await app.request("/api/wiki/provenance?jira=bogus");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("BOGUS");
  });
});

describe("GET /api/wiki/provenance?session=", () => {
  test("finds the pages a session wrote, by either spelling", async () => {
    for (const q of [SESSION_A, ID_A]) {
      const body = await (await app.request(`/api/wiki/provenance?session=${encodeURIComponent(q)}`)).json();
      expect(body.pages.map((p: { relPath: string }) => p.relPath)).toEqual(["plan.md"]);
      expect(body.session).toBe(q);
      expect(body.totalCost).toBe(2.5);
    }
  });

  test("a session no page names still gets its own chip — an empty list would read as 'no such session'", async () => {
    const body = await (await app.request(`/api/wiki/provenance?session=${ID_A.replace("5a2", "999")}`)).json();
    expect(body.pages).toEqual([]);
    expect(body.sessions.length).toBe(1);
    expect(body.sessions[0].missing).toBe(true);
  });
});

describe("the two query params", () => {
  test("neither is a 400", async () => {
    expect((await app.request("/api/wiki/provenance")).status).toBe(400);
  });

  test("both at once is a 400 rather than a silent preference", async () => {
    const res = await app.request(`/api/wiki/provenance?jira=MELOSYS-8045&session=${ID_A}`);
    expect(res.status).toBe(400);
  });

  test("an unreachable ledger degrades the answer, never 5xxes it", async () => {
    const down = new Hono();
    registerWikiProvenanceRoutes(
      down,
      {} as Config,
      testCtx({
        sessionLedger: {
          baseUrl: "http://127.0.0.1:8787",
          urlConfigured: false,
          fetchSessions: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        },
      }),
    );
    const res = await down.request("/api/wiki/provenance?jira=MELOSYS-8045");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages.length).toBe(2);
    expect(body.ledger.reachable).toBe(false);
    // UNRESOLVED, not missing — the batch failed, so nobody asked.
    expect(body.sessions.every((s: { unresolved: boolean }) => s.unresolved)).toBe(true);
    expect(body.sessions.every((s: { missing: boolean }) => s.missing)).toBe(false);
    expect(body.totalCost).toBe(0);
  });
});

describe("the listing and the page route", () => {
  test("/api/wiki/pages carries the jira FACET counts and strips the page-only keys", async () => {
    const body = await (await pageApp.request("/api/wiki/pages?wiki=mimir")).json();
    expect(body.jira).toEqual({ "MELOSYS-8045": 1 });
    const row = body.pages.find((p: { relPath: string }) => p.relPath === "plan.md");
    // The facet field rides the hot listing; the page-body ones do not.
    expect(row.jira).toEqual(["MELOSYS-8045"]);
    expect(row.sessions).toBeUndefined();
    expect(row.prs).toBeUndefined();
    expect(row.sessionsBackfilled).toBeUndefined();
  });

  test("a wiki nothing stamped answers `{}` — which is how the client renders no facet at all", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "prov-empty-"));
    try {
      await writeFile(path.join(empty, "a.md"), "---\ntitle: A\n---\n\nbody\n");
      __setWikiRegistryForTest([
        { name: "mimir", root: mimir, source: "extra" },
        { name: "kode", root: kode, source: "extra" },
        { name: "empty", root: empty, source: "extra" },
      ]);
      __resetWikiCacheForTest();
      const body = await (await pageApp.request("/api/wiki/pages?wiki=empty")).json();
      expect(body.jira).toEqual({});
    } finally {
      __setWikiRegistryForTest([
        { name: "mimir", root: mimir, source: "extra" },
        { name: "kode", root: kode, source: "extra" },
      ]);
      __resetWikiCacheForTest();
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("/api/wiki/page carries the page-only keys on its meta AND the provenance block", async () => {
    const body = await (await pageApp.request("/api/wiki/page?wiki=mimir&relPath=plan.md")).json();
    expect(body.meta.sessions).toEqual([SESSION_A, SESSION_B]);
    expect(body.meta.prs).toEqual(["RuneLind/muninn#543"]);
    expect(body.meta.sessionsBackfilled).toBe("2026-10-14");
    expect(body.provenance.sessions.map((s: { id: string }) => s.id)).toEqual([ID_A, "ses_7f3a9b2c1d"]);
    expect(body.provenance.prs[0].url).toBe("https://github.com/RuneLind/muninn/pull/543");
    expect(body.provenance.jira[0].url).toBe("https://nav.atlassian.net/browse/MELOSYS-8045");
    expect(body.provenance.backfilled).toBe("2026-10-14");
    // No claude-usage on this host: bare chips and an honest ledger state,
    // rather than a failed page open.
    expect(body.provenance.ledger.reachable).toBe(false);
    expect(body.provenance.ledger.configured).toBe(false);
    expect(body.provenance.totalCost).toBe(0);
    expect(body.provenance.costedSessions).toBe(0);
  });

  test("an unstamped page gets NO provenance field at all", async () => {
    const body = await (await pageApp.request("/api/wiki/page?wiki=mimir&relPath=plain.md")).json();
    expect("provenance" in body).toBe(false);
  });
});

// ── Bounds, validation and scoping (fix round 1) ───────────────────────────

describe("the answer is BOUNDED — the caller picks its size", () => {
  let big = "";
  let bigApp: Hono;

  beforeAll(async () => {
    big = await mkdtemp(path.join(tmpdir(), "prov-big-"));
    // Three pages × 400 distinct session refs each. Unbounded, one GET walks the
    // whole registry and fans out into ⌈1200/200⌉ = 6 claude-usage calls.
    for (let p = 0; p < 3; p += 1) {
      const refs = Array.from({ length: 400 }, (_, i) => `claude-code:p${p}-s${String(i).padStart(4, "0")}`);
      await writeFile(
        path.join(big, `page-${p}.md`),
        `---\ntitle: Page ${p}\njira: [MELOSYS-8045]\nsessions: [${refs.join(", ")}]\n---\n\n# Page ${p}\n`,
      );
    }
    // …and more page rows than the row cap, so both halves are exercised.
    for (let p = 0; p < PROVENANCE_PAGES_MAX + 10; p += 1) {
      await writeFile(
        path.join(big, `row-${String(p).padStart(4, "0")}.md`),
        `---\ntitle: Row ${p}\njira: [MELOSYS-8045]\n---\n\n# Row ${p}\n`,
      );
    }
    __setWikiRegistryForTest([{ name: "big", root: big, source: "extra" }]);
    __resetWikiCacheForTest();
    bigApp = new Hono();
    registerWikiProvenanceRoutes(bigApp, {} as Config, testCtx());
  });

  afterAll(async () => {
    __setWikiRegistryForTest([
      { name: "mimir", root: mimir, source: "extra" },
      { name: "kode", root: kode, source: "extra" },
    ]);
    __resetWikiCacheForTest();
    await rm(big, { recursive: true, force: true });
  });

  test("page rows are capped and the answer SAYS it is a prefix", async () => {
    const body = await (await bigApp.request("/api/wiki/provenance?jira=MELOSYS-8045")).json();
    expect(body.pages.length).toBe(PROVENANCE_PAGES_MAX);
    expect(body.truncated).toBe(true);
  });

  test("session refs are capped too, so one GET cannot buy an unbounded fan-out", async () => {
    const calls: number[] = [];
    const counted = new Hono();
    registerWikiProvenanceRoutes(
      counted,
      {} as Config,
      testCtx({
        sessionLedger: {
          baseUrl: "http://127.0.0.1:8787",
          urlConfigured: true,
          fetchSessions: async (ids) => {
            calls.push(ids.length);
            return { sessions: ids.map((id) => ({ sessionId: id, missing: true })) };
          },
        },
      }),
    );
    const body = await (await counted.request("/api/wiki/provenance?jira=MELOSYS-8045")).json();
    expect(body.sessions.length).toBeLessThanOrEqual(PROVENANCE_REFS_MAX);
    // 1000 refs at the 200-id page size ⇒ 5 calls, not 6.
    expect(calls.length).toBe(5);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(PROVENANCE_REFS_MAX);
    expect(body.truncated).toBe(true);
  });
});

describe("what the 400 bodies echo", () => {
  test("an over-long jira value is truncated rather than reflected whole", async () => {
    const raw = "x".repeat(4_000);
    const res = await app.request(`/api/wiki/provenance?jira=${raw}`);
    expect(res.status).toBe(400);
    const error = (await res.json()).error as string;
    // Normalized (uppercased) and clipped: a 400 that reflects arbitrary caller
    // bytes is a payload nobody asked this route to carry.
    expect(error).toContain("XXX");
    expect(error).toContain("…");
    expect(error.length).toBeLessThan(200);
  });

  test("a session value that cannot BE an id is refused with the same shape", async () => {
    const tooLong = "y".repeat(SESSION_ID_MAX_CHARS + 1);
    const res = await app.request(`/api/wiki/provenance?session=${tooLong}`);
    expect(res.status).toBe(400);
    const error = (await res.json()).error as string;
    expect(error).toContain("is not a session id");
    expect(error.length).toBeLessThan(250);

    // Characters outside claude-usage's own alphabet are refused too — sending
    // them walks every wiki to match nothing and then asks the ledger about it.
    expect((await app.request("/api/wiki/provenance?session=" + encodeURIComponent("a b"))).status).toBe(400);
    expect((await app.request("/api/wiki/provenance?session=" + encodeURIComponent("a/b"))).status).toBe(400);
    // The prefixed spelling is still fine — the shape check reads the bare half.
    expect((await app.request(`/api/wiki/provenance?session=${encodeURIComponent(SESSION_A)}`)).status).toBe(200);
  });
});

describe("?session= prices the session ASKED ABOUT", () => {
  test("not every session that happens to share a page with it", async () => {
    // `plan.md` names A (priced 2.5 by the fixture ledger) and B. Summing both
    // answers "what did these pages cost" under a heading that says "what did
    // this session cost" — and B is priced 0 here only by luck of the fixture.
    const priced = new Hono();
    registerWikiProvenanceRoutes(
      priced,
      {} as Config,
      testCtx({
        sessionLedger: {
          baseUrl: "http://127.0.0.1:8787",
          urlConfigured: true,
          fetchSessions: async (ids) => ({
            sessions: ids.map((id) => ({
              sessionId: id,
              title: "s",
              provider: "claude-code",
              cost: id === ID_A ? 2.5 : 11,
              messages: 1,
            })),
          }),
        },
      }),
    );
    const body = await (await priced.request(`/api/wiki/provenance?session=${ID_A}`)).json();
    expect(body.totalCost).toBe(2.5);
    expect(body.costedSessions).toBe(1);
    // The page row still carries its own full list — the narrowing is the money
    // line only.
    expect(body.pages[0].sessions).toEqual([SESSION_A, SESSION_B]);
    expect(body.sessions.length).toBe(2);
  });

  test("a BARE query keeps the provider from the page's prefixed spelling", async () => {
    const body = await (await app.request(`/api/wiki/provenance?session=${ID_A}`)).json();
    const asked = body.sessions.find((s: { id: string }) => s.id === ID_A);
    // The query leads the list (a reader asked about IT), and plain first-wins
    // threw away the `claude-code:` the matched page carried — leaving the one
    // chip the answer is about as the only one with no provider glyph.
    expect(body.sessions[0].id).toBe(ID_A);
    expect(asked.provider).toBe("claude-code");
    expect(asked.ref).toBe(SESSION_A);
  });
});

describe("an unconfigured host", () => {
  test("never fetches the default claude-usage on a page open", async () => {
    // `claudeUsageUrl: null` on the page app. Before the fix the route built
    // deps pointing at `127.0.0.1:8787` and fetched it on EVERY stamped page
    // open, reporting an "unreachable" service the operator never ran — and the
    // assertion about it depended on whether a real claude-usage happened to be
    // listening on the machine running the suite.
    let calls = 0;
    const quiet = new Hono();
    registerWikiRoutes(quiet, { knowledgeApiUrl: "http://localhost:8321", claudeUsageUrl: null, claudeUsagePublicUrl: null } as Config, {
      ...testCtx({
        sessionLedger: {
          baseUrl: "http://127.0.0.1:8787",
          urlConfigured: false,
          fetchSessions: async () => {
            calls += 1;
            return { sessions: [] };
          },
        },
      }),
      ledgerConfigured: false,
    });
    const body = await (await quiet.request("/api/wiki/page?wiki=mimir&relPath=plan.md")).json();
    expect(calls).toBe(0);
    expect(body.provenance.ledger).toEqual({
      asked: false,
      reachable: false,
      partial: false,
      configured: false,
    });
    expect(body.provenance.totalCost).toBe(0);
  });
});
