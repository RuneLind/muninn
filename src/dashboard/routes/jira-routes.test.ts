/**
 * Acceptance for the Jira surface: the archive page and listing, the ONE write
 * route (`POST /api/jira/draft/from-thread`) and the chat card's three reads.
 *
 * What only this file can see:
 *
 *   1. **Every refusal is a plain JSON status, before anything is created.** The
 *      body shape, the unknown template id, the missing-bot 503, the wrong-bot
 *      thread and the `Full` MCP pre-flight all land before a row exists and
 *      before a message is written into someone's conversation.
 *   2. **`GET /api/jira/draft/:id` answers `generating` mid-run**, which is the
 *      property the whole fire-and-forget + poll contract rests on.
 *   3. **The single-flight slot is keyed on the THREAD**, so a second click is a
 *      409 rather than a second interleaved turn in one conversation.
 *   4. **The archive is a read.** Its query params, its 404 and its never-500
 *      contract are route-level facts.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains, like `share-routes.test.ts`) — and it MUST stay that way. `mock.module`
 * invalidates the target module for the whole process graph, and this file mocks
 * four of them, including `bots/config.ts` and `db/traces.ts`, which a large share
 * of the suite imports transitively.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

// ── Mocks, all installed BEFORE the route module is imported ─────────────────

const realTraces = await import("../../db/traces.ts");
mock.module("../../db/traces.ts", () => ({
  ...realTraces,
  saveSpan: async () => {},
  updateSpan: async () => {},
}));

/** The pinned bot. `bots/` is gitignored, so a checkout has no melosys to find. */
const FAKE_BOT = {
  name: "melosys",
  dir: "/tmp/melosys",
  persona: "p",
  connector: "copilot-sdk" as const,
  telegramAllowedUserIds: [],
  slackAllowedUserIds: [],
};
let discovered: unknown[] = [FAKE_BOT];
const realBots = await import("../../bots/config.ts");
mock.module("../../bots/config.ts", () => ({
  ...realBots,
  discoverAllBots: () => discovered,
}));

/** The MCP probe the Full pre-flight and the fence both read. */
const okServer = (name: string, tools: string[], status: "ok" | "down" = "ok") => ({
  name,
  displayName: name,
  status,
  toolCount: tools.length,
  tools: tools.map((t) => ({ name: t })),
  lastCheckedMs: Date.now(),
  critical: false,
});
const ALL_UP = [
  okServer("code", ["search_tools", "call_tool"]),
  okServer("yggdrasil", ["search", "read_source"]),
  okServer("knowledge", ["search_knowledge", "get_document"]),
  okServer("hivemind", ["ask_peer"]),
  okServer("research", ["research_knowledge"]),
];
let mcpServers: unknown[] = ALL_UP;
const realMcp = await import("../../ai/mcp-status.ts");
mock.module("../../ai/mcp-status.ts", () => ({
  ...realMcp,
  getMcpStatus: async () => mcpServers,
}));

/**
 * The thread side: `threads`, the thread's history, and the citations its
 * `research_knowledge` calls wrote.
 *
 * All three are read by `runJiraThreadDraft` after the turn. They are faked
 * rather than driven through a real DB for the same reason `jira_drafts` is —
 * this file's whole job is the ROUTE contract — but `getThreadById` keeps the
 * uuid cast-error behaviour, because the from-thread route's 404 depends on
 * catching a bad id BEFORE postgres sees it.
 */
interface ThreadRow { id: string; userId: string; botName: string; name: string; connectorId?: string }
const threads = new Map<string, ThreadRow>();
const realThreads = await import("../../db/threads.ts");
mock.module("../../db/threads.ts", () => ({
  ...realThreads,
  getThreadById: async (id: string) => {
    if (!UUID_RE.test(id)) throw new Error(`invalid input syntax for type uuid: "${id}"`);
    return threads.get(id) ?? null;
  },
}));

let threadHistory: { role: string; text: string }[] = [];
const realMessages = await import("../../db/messages.ts");
mock.module("../../db/messages.ts", () => ({
  ...realMessages,
  getRecentMessages: async () => threadHistory,
}));

let threadCitations: Record<string, unknown>[] = [];
const realCitations = await import("../../db/research-citations.ts");
mock.module("../../db/research-citations.ts", () => ({
  ...realCitations,
  getCitationsForThread: async (threadId: string) =>
    threadCitations.filter((c) => c.threadId === threadId),
}));

/**
 * In-memory `jira_drafts`.
 *
 * Ids are real UUIDs and `getJiraDraft` THROWS postgres's own cast error on
 * anything else — faithful to the column type, and the reason is not decoration:
 * the route used to reach that throw with a single-flight slot already taken, so
 * a mock that answered `null` for a non-uuid hid both the 500 and the wedged slot.
 */
interface Row {
  draftId: string;
  botName: string;
  status: string;
  template: string;
  depth: string;
  notes: string;
  extra: string;
  markdown: string | null;
  citations: unknown[];
  excludeDocIds: string[];
  keyVerdicts: unknown[];
  markdownFlags: unknown[];
  retrievalCoverage: string | null;
  retrievalQuestion: string;
  error: string | null;
  source: string;
  threadId: string | null;
  threadName: string | null;
  messageId: string | null;
  savedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
const rows = new Map<string, Row>();
/** Reads that must FAIL, keyed by draft id — the "huginn is fine, postgres is not" case. */
const readThrows = new Map<string, string>();
/** The LISTING read failing — a dead database under the page, not under one row. */
let archiveThrows: string | null = null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The REAL module, captured before the mock replaces it — the only way this file
 * can check that the fake it installs still describes the module it stands in for.
 * See the surface test at the foot of the file.
 */
const realJiraDrafts = await import("../../db/jira-drafts.ts");
/** Held as a value rather than built inside the factory, so the surface test can
 *  read its key list. */
const jiraDraftsMock = {
  createJiraDraft: async (i: {
    botName: string; template: string; depth: string; notes: string; extra: string;
    source?: string; threadId?: string;
  }) => {
    const id = crypto.randomUUID();
    rows.set(id, {
      draftId: id, botName: i.botName, status: "generating", template: i.template, depth: i.depth, notes: i.notes,
      extra: i.extra, markdown: null, citations: [], excludeDocIds: [], keyVerdicts: [], markdownFlags: [],
      retrievalCoverage: null, retrievalQuestion: "", error: null,
      source: i.source ?? "notes", threadId: i.threadId ?? null,
      // The real read LEFT-JOINs `threads`; the mock resolves the same way.
      threadName: i.threadId ? (threads.get(i.threadId)?.name ?? null) : null,
      messageId: null,
      savedAt: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return id;
  },
  /** The FIRST-DRAFT stamp, landed right after the turn — before finalize. */
  setJiraDraftMessageId: async (id: string, messageId: string) => {
    const r = rows.get(id);
    if (r) r.messageId = messageId;
  },
  saveJiraDraft: async (id: string) => {
    if (!UUID_RE.test(id)) throw new Error(`invalid input syntax for type uuid: "${id}"`);
    const r = rows.get(id);
    // Faithful to the real statement's `AND status = 'ready'`: an unfinished row
    // is not updated, and the route tells that apart from a missing one by
    // re-reading.
    if (!r || r.status !== "ready") return null;
    r.savedAt = Date.now();
    return jiraDraftView(r);
  },
  /** The archive listing. Faithful to the real reader in the four things the
   *  route depends on: the saved-only filter, newest-first, the clamp — and
   *  `capped`, which is a row PAST the limit rather than a full page. The title
   *  goes through the SHARED derivation (which bounds its own scan), or the mock
   *  labels rows the real reader would not. */
  listJiraDrafts: async (o: { savedOnly?: boolean; limit?: number } = {}) => {
    if (archiveThrows) throw new Error(archiveThrows);
    const limit = clampJiraArchiveLimit(o.limit);
    const matching = Array.from(rows.values())
      .filter((r) => (o.savedOnly ? r.savedAt !== null : true))
      .sort((a, b) => b.createdAt - a.createdAt);
    return {
      capped: matching.length > limit,
      drafts: matching.slice(0, limit).map((r) => {
        const view = jiraDraftView(r);
        return {
          draftId: r.draftId, bot: r.botName, source: r.source, template: r.template,
          depth: r.depth, status: r.status, title: jiraDraftTitle(r.markdown),
          retrievalCoverage: r.retrievalCoverage, coverage: view.coverage,
          threadId: r.threadId, threadName: r.threadName,
          savedAt: r.savedAt, createdAt: r.createdAt,
        };
      }),
    };
  },
  listJiraDraftsForThread: async (threadId: string) => {
    if (!UUID_RE.test(threadId)) throw new Error(`invalid input syntax for type uuid: "${threadId}"`);
    return Array.from(rows.values())
      .filter((r) => r.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ draftId: r.draftId, messageId: r.messageId, status: r.status }));
  },
  saveJiraDraftRetrieval: async (id: string, citations: unknown[], retrievalCoverage: string, q: string) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { citations, retrievalCoverage, retrievalQuestion: q });
  },
  finishJiraDraft: async (
    id: string,
    i: { markdown: string; keyVerdicts: unknown[]; markdownFlags: unknown[]; messageId?: string },
  ) => {
    const r = rows.get(id);
    // Faithful to the real statement's `COALESCE(?, message_id)`: an absent
    // messageId leaves the column alone rather than nulling it.
    if (r) Object.assign(r, { ...i, messageId: i.messageId ?? r.messageId, status: "ready", error: null });
  },
  failJiraDraft: async (id: string, error: string) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { status: "failed", error });
  },
  getJiraDraft: async (id: string) => {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    const forced = readThrows.get(id);
    if (forced) throw new Error(forced);
    const r = rows.get(id);
    if (!r) return null;
    return jiraDraftView(r);
  },
};
mock.module("../../db/jira-drafts.ts", () => jiraDraftsMock);

/** Row → view, shared by the read and the save (which re-reads in the real one). */
function jiraDraftView(r: Row) {
  // The view's `coverage` is DERIVED (see `effectiveCoverage`); only the SQL is
  // faked here, so the mock runs the real helper rather than a second rule that
  // could quietly disagree with the column the route actually reads.
  const excluded = new Set(r.excludeDocIds);
  const retained = (r.citations as { docId: string }[]).filter((c) => !excluded.has(c.docId)).length;
  return {
    ...r,
    // The real read LEFT-JOINs `threads` for both of these; the mock resolves
    // them the same way, and a deleted thread row leaves `threadUserId` null.
    bot: r.botName,
    threadUserId: r.threadId ? (threads.get(r.threadId)?.userId ?? null) : null,
    coverage: r.retrievalCoverage === null && r.citations.length === 0
      ? null
      : effectiveCoverage(r.retrievalCoverage as never, retained),
  };
}

const {
  registerJiraRoutes,
  __setJiraThreadTurnForTest,
  missingFullServers,
} = await import("./jira-routes.ts");
const {
  __resetJiraFlightsForTest,
  acquireJiraFlight,
  threadFlightKey,
  JIRA_SLOT_SLACK_MS,
  JIRA_TIMEOUT_MS_BY_DEPTH,
} = await import("./jira-flight.ts");
const { __resetJiraKeyIndexForTest } = await import("../../jira/verify-keys.ts");
const { clampJiraArchiveLimit, effectiveCoverage, jiraDraftTitle } = await import(
  "../../jira/wire.ts"
);
const { isJiraTurnLine } = await import("../../jira/thread-draft.ts");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const config = {
  tracingEnabled: false,
  tracingCaptureToolOutputs: false,
  claudeModel: "sonnet",
  knowledgeApiUrl: "http://huginn.test",
} as never;

/** A huginn `jira-issues` listing in which TRYGD-99 does not exist. */
const LISTING = { documents: [
  { id: "MELOSYS-5677_Ny_flyt.md", url: "https://jira.adeo.no/browse/MELOSYS-5677" },
  { id: "MELOSYS-8028_Manglende.md", url: "https://jira.adeo.no/browse/MELOSYS-8028" },
] };

function makeApp(): Hono {
  const app = new Hono();
  registerJiraRoutes(app, config);
  return app;
}

// ── Thread-path fixtures ─────────────────────────────────────────────────────

const THREAD_ID = "11111111-2222-4333-8444-555555555555";
const THREAD = {
  id: THREAD_ID,
  userId: "u1",
  botName: "melosys",
  name: "medlemskap-uttrekk",
};

const THREAD_DRAFT_BODY = [
  "## Symptom",
  "Uttrekket feiler for EØS-saker. Se MELOSYS-8150.",
  "## Akseptansekriterier",
  "- Uttrekket fullfører",
].join("\n");

/** Every draft turn this run made — the seam's own ledger. */
let threadTurns: { text: string; turnInstruction: string }[] = [];

function scriptedThreadTurn(text = THREAD_DRAFT_BODY, messageId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") {
  return (async (input: { text: string; turnInstruction: string }) => {
    threadTurns.push({ text: input.text, turnInstruction: input.turnInstruction });
    return { messageId, text };
  }) as never;
}

/** Two `research_citations` rows the conversation's own tool calls wrote. */
const THREAD_CITATIONS = [
  {
    threadId: THREAD_ID,
    collection: "jira-issues",
    docId: "MELOSYS-8150_Uttrekk.md",
    title: "MELOSYS-8150_Uttrekk_av_medlemskap",
    url: "https://jira.adeo.no/browse/MELOSYS-8150",
    relevance: 0.4,
  },
  {
    threadId: THREAD_ID,
    collection: "melosys-confluence-v3",
    docId: "Team MELOSYS/rammeavtale.md",
    title: "Rammeavtalen for hjemmekontor",
    url: "https://confluence.test/rammeavtale",
    relevance: 0.9,
  },
];

beforeEach(() => {
  __resetJiraFlightsForTest();
  __resetJiraKeyIndexForTest();
  rows.clear();
  readThrows.clear();
  archiveThrows = null;
  threads.clear();
  threadHistory = [];
  threadCitations = [];
  threadTurns = [];
  __setJiraThreadTurnForTest(scriptedThreadTurn());
  discovered = [FAKE_BOT];
  mcpServers = ALL_UP;
  // The key index reaches huginn; every test here serves the same listing.
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/collection/jira-issues/documents")) {
      return new Response(JSON.stringify(LISTING), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }) as never;
});

// ── The picker ───────────────────────────────────────────────────────────────

describe("GET /api/jira/templates", () => {
  test("lists the shipped ids in PICKER order and is no-store", async () => {
    const res = await makeApp().request("/api/jira/templates");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.bot).toBe("melosys");
    expect(body.templates.map((t: { id: string }) => t.id)).toEqual(["bug", "story", "task", "spike"]);
  });

  test("503 when the pinned bot is not discovered", async () => {
    discovered = [];
    const res = await makeApp().request("/api/jira/templates");
    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).toContain("melosys");
  });
});

// ── The `Full` pre-flight's own predicate ─────────────────────────────────────

describe("missingFullServers", () => {
  test("treats an ABSENT server as missing, not as fine", () => {
    // The probe lists every server in the bot's `.mcp.json`, so an absent name
    // means the bot is not configured with it at all — for `Full` that is the
    // same outcome as down. (The route-level 503 is asserted on the one route
    // that can reach it, `POST …/from-thread`, further down.)
    expect(missingFullServers([])).toEqual(["code", "yggdrasil"]);
    expect(missingFullServers([okServer("code", ["call_tool"])])).toEqual(["yggdrasil"]);
    expect(missingFullServers(ALL_UP as never)).toEqual([]);
  });
});

// ── Single flight ────────────────────────────────────────────────────────────

describe("the thread's single-flight slot", () => {
  test("the slot outlives the run's teardown by exactly the slack", () => {
    // Sized to exactly the budget, a slot frees itself while its holder is still
    // tearing down, and a click on that boundary starts a concurrent turn — two
    // interleaved messages in one conversation. The previous spelling compared
    // two BUDGETS and said nothing about the slack.
    const key = threadFlightKey(THREAD_ID);
    const t0 = 1_000;
    expect(acquireJiraFlight(key, "skisse", t0).ok).toBe(true);
    const budget = JIRA_TIMEOUT_MS_BY_DEPTH.skisse;
    expect(acquireJiraFlight(key, "skisse", t0 + budget).ok).toBe(false);
    expect(acquireJiraFlight(key, "skisse", t0 + budget + JIRA_SLOT_SLACK_MS - 1).ok).toBe(false);
    expect(acquireJiraFlight(key, "skisse", t0 + budget + JIRA_SLOT_SLACK_MS).ok).toBe(true);
  });

  test("the slack still covers the longest work OUTSIDE the budget", () => {
    // The slack is what the run does before and after the model turn, and the
    // only bounded item left on this path is the `jira-issues` key-index listing
    // key verification runs (≤ 15 s, `verify-keys.ts` — the notes path's 60 s
    // Haiku condense and its 8 s doc pull died with it). Under that floor the
    // slot can free itself while its holder is still verifying keys, and the
    // next click starts a second interleaved turn in the same conversation.
    expect(JIRA_SLOT_SLACK_MS).toBeGreaterThanOrEqual(15_000);
  });

  test("two threads are two slots — the key is the thread and nothing else", () => {
    const a = threadFlightKey(THREAD_ID);
    const b = threadFlightKey("22222222-3333-4444-8555-666666666666");
    expect(acquireJiraFlight(a, "skisse", 1_000).ok).toBe(true);
    expect(acquireJiraFlight(b, "skisse", 1_000).ok).toBe(true);
    expect(acquireJiraFlight(a, "skisse", 1_000).ok).toBe(false);
  });
});

// ── Status polling ───────────────────────────────────────────────────────────

describe("GET /api/jira/draft/:id — the polling contract", () => {
  test("answers `generating` mid-run, then `ready`", async () => {
    // The whole fire-and-forget contract rests on this: `from-thread` returns the
    // id and leaves, and the card reads the ROW — a run broadcasts to every open
    // tab, so a reload or a second tab is ordinary.
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "assistant", text: "Se MELOSYS-8150." }];
    let release: ((v: { messageId: string; text: string }) => void) | undefined;
    __setJiraThreadTurnForTest((() => new Promise((r) => { release = r; })) as never);

    const app = makeApp();
    const started = await (await app.request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    })).json();
    expect(started.status).toBe("generating");

    const mid = await (await app.request(`/api/jira/draft/${started.draftId}`)).json();
    expect(mid.status).toBe("generating");
    expect(mid.markdown).toBeNull();

    release!({ messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", text: THREAD_DRAFT_BODY });
    await new Promise((r) => setTimeout(r, 40));

    const after = await (await app.request(`/api/jira/draft/${started.draftId}`)).json();
    expect(after.status).toBe("ready");
    expect(String(after.markdown)).toContain("## Referanser");
    expect(after.citations).toHaveLength(2);
  });

  test("a poll target is no-store and CORS-open", async () => {
    const app = makeApp();
    const id = seedRow();
    const res = await app.request(`/api/jira/draft/${id}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("an unknown id is a 404, including a non-uuid one", async () => {
    const res = await makeApp().request("/api/jira/draft/not-a-uuid");
    expect(res.status).toBe(404);
  });

  test("a DB failure is a 500 that does not hand the caller postgres's own message", async () => {
    // This route is CORS-open, so an unexpected throw must not reflect a table
    // name, a column type and a character offset back at whoever asked.
    const app = makeApp();
    const id = seedRow();
    readThrows.set(id, 'relation "jira_drafts" does not exist at character 42');
    const res = await app.request(`/api/jira/draft/${id}`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).not.toContain("jira_drafts");
    expect(String(body.error)).not.toContain("character 42");
  });

  /**
   * Two fields the page cannot get anywhere else.
   *
   * `bot` — the «Juster i samtalen» deep link is built from it, and it used to be
   * set ONLY by the templates fetch, so a templates 503 (exactly the moment the
   * reader most wants to go back to the conversation) took the link with it. The
   * row has always known its own bot.
   *
   * `threadUserId` — `threads.user_id`, joined the same way `threadName` is. The
   * chat's `handleDeepLink` honours `user=`, and without it the link resolved to
   * whichever user that browser last used on this bot, where `selectThread` then
   * cannot find the thread.
   */
  test("the view carries the draft's bot and the thread's OWNER", async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "assistant", text: "Se MELOSYS-8150." }];
    __setJiraThreadTurnForTest(scriptedThreadTurn());
    const app = makeApp();
    const started = await (await app.request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    })).json();
    await new Promise((r) => setTimeout(r, 40));

    const view = await (await app.request(`/api/jira/draft/${started.draftId}`)).json();
    expect(view.bot).toBe("melosys");
    expect(view.threadUserId).toBe("u1");
    expect(view.threadName).toBe("medlemskap-uttrekk");
  });

  test("an ARCHIVED notes-sourced row has no thread owner, but still names its bot", async () => {
    // Nothing writes a `source = 'notes'` row any more; the archive is full of
    // them, and the view still has to answer for one.
    const id = seedRow();
    const view = await (await makeApp().request(`/api/jira/draft/${id}`)).json();
    expect(view.source).toBe("notes");
    expect(view.bot).toBe("melosys");
    expect(view.threadUserId).toBeNull();
  });
});

// ── CORS is advertised only where it is served ───────────────────────────────

describe("the preflight advertises exactly the methods that carry CORS headers", () => {
  test("`/draft/:id` advertises GET and nothing else — reading is the whole of it", async () => {
    const app = makeApp();
    const pre = await app.request("/api/jira/draft/8a1f4c2e-0000-4000-8000-000000000000", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    const allow = String(pre.headers.get("access-control-allow-methods"));
    expect(allow).toContain("GET");
    expect(allow).not.toContain("PUT");
    expect(allow).not.toContain("POST");
  });

  test("the WRITE route is never preflight-approved for POST", async () => {
    // There is no `app.options` for it, and the `/draft/:id` preflight refuses a
    // parameter that cannot be a draft id, so a browser gets no approval at all
    // before sending the cross-origin POST. Migration 070's accepted risk covers
    // reading a draft id, never writing a message into someone's conversation.
    const pre = await makeApp().request("/api/jira/draft/from-thread", { method: "OPTIONS" });
    expect(String(pre.headers.get("access-control-allow-methods"))).not.toContain("POST");
  });

  test("a preflight for a path that is not a draft id is not approved at all", async () => {
    // `/api/jira/draft/start` was a real route until PR 4 deleted it, and the
    // `:id` preflight answered a cheerful 204 for it — advertising a live
    // cross-origin endpoint at an address that no longer exists. The id shape is
    // the same `isValidUuid` gate every handler here runs, one layer earlier.
    const gone = await makeApp().request("/api/jira/draft/start", { method: "OPTIONS" });
    expect(gone.status).not.toBe(204);
    // …while a real draft id still gets its preflight.
    const real = await makeApp().request("/api/jira/draft/8a1f4c2e-0000-4000-8000-000000000000", {
      method: "OPTIONS",
    });
    expect(real.status).toBe(204);
  });
});

// ── The fake stands in for a module that still exists ────────────────────────

describe("the jira-drafts mock mirrors the real module", () => {
  test("it fakes nothing the real module does not export", () => {
    // A mock key with no counterpart is a route contract asserted against a
    // function nobody can call: PR 4 deleted `startJiraDraftRun` and
    // `updateJiraDraftMarkdown` with the notes path, and the fakes for both
    // outlived them here, silently claiming the regenerate and save-edit writers
    // were still reachable.
    const real = new Set(Object.keys(realJiraDrafts));
    const extra = Object.keys(jiraDraftsMock).filter((k) => !real.has(k));
    expect(extra).toEqual([]);
  });
});

// ── A failed row says something a stranger may read ──────────────────────────

describe("the failure written to the row is generic", () => {
  test("a turn that THREW does not land its exception on a CORS-readable row", async () => {
    threads.set(THREAD_ID, THREAD);
    __setJiraThreadTurnForTest((async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9130 (/Users/rune/source/private/muninn)");
    }) as never);
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    const { draftId } = await res.json();
    await new Promise((r) => setTimeout(r, 30));
    const row = rows.get(String(draftId))!;
    expect(row.status).toBe("failed");
    expect(row.error).not.toContain("ECONNREFUSED");
    expect(row.error).not.toContain("/Users/rune");
    expect(String(row.error).length).toBeGreaterThan(10);
  });
});

// ── The page ─────────────────────────────────────────────────────────────────

/**
 * `GET /jira` is registered from THIS module, the way `plans-routes.ts`
 * registers `/plans` beside `/api/plans/*`. It is the read-only ARCHIVE now, and
 * what only a route test can see is the WIRING: the page reads the DB itself
 * (the composer read nothing), so its query params, its 404 and its
 * never-500 contract are route-level facts.
 */
/** A settled row straight into the fake table — the archive reads rows, and
 *  driving a whole generation to produce one would test the runner instead. */
function seedRow(over: Partial<Row> & { draftId?: string } = {}): string {
  const id = over.draftId ?? crypto.randomUUID();
  rows.set(id, {
    draftId: id, botName: "melosys", status: "ready", template: "bug", depth: "skisse",
    notes: "råmateriale", extra: "", markdown: "# Arkivsak\n\ntekst", citations: [],
    excludeDocIds: [], keyVerdicts: [], markdownFlags: [], retrievalCoverage: "answer",
    retrievalQuestion: "q", error: null, source: "notes", threadId: null, threadName: null,
    messageId: null, savedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    ...over,
  } as Row);
  return id;
}

/** One saved row and one unsaved one — the whole point of the default list. */
function seedTwo(): { saved: string; unsaved: string } {
  return {
    saved: seedRow({ markdown: "# Lagret sak\n\ntekst", savedAt: Date.now() }),
    unsaved: seedRow({ markdown: "# Ulagret sak\n\ntekst", savedAt: null }),
  };
}

describe("GET /jira — the archive page", () => {
  test("serves the saved list, the nav and the client bundle", async () => {
    const { saved, unsaved } = seedTwo();
    const res = await makeApp().request("/jira");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Jira-arkiv");
    expect(html).toContain(`/jira?draft=${saved}`);
    // The default list is SAVED ONLY — an attempt nobody kept is not archive.
    expect(html).not.toContain(`/jira?draft=${unsaved}`);
    // The nav entry lives in the Tools dropdown, not the top-level row.
    expect(html).toContain('<a href="/jira" class="nav-dropdown-item active">Jira</a>');
    // The LIST ships no bundle — it has no view switch and no copy button. The
    // draft page does, inlined rather than linked (there is no asset route).
    expect(html).not.toContain("jaRaw");
    expect(await (await makeApp().request(`/jira?draft=${saved}`)).text()).toContain("jaRaw");
  });

  test("`?all=1` shows the attempts the saved list hides", async () => {
    const { saved, unsaved } = seedTwo();
    const html = await (await makeApp().request("/jira?all=1")).text();
    expect(html).toContain(`/jira?draft=${saved}`);
    expect(html).toContain(`/jira?draft=${unsaved}`);
  });

  test("`?draft=` renders that draft's markdown, server-side", async () => {
    const { saved } = seedTwo();
    const res = await makeApp().request(`/jira?draft=${saved}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // `formatWebHtml` emits `h${level+1}`, so a `# ` heading is an h2.
    expect(html).toContain("<h2>Lagret sak</h2>");
    expect(html).toContain("Kopier markdown");
  });

  test("a non-uuid and an unknown uuid are both a named 404, never a 500", async () => {
    for (const id of ["not-a-uuid", "99999999-8888-4777-8666-555555555555"]) {
      const res = await makeApp().request(`/jira?draft=${id}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Utkastet finnes ikke");
    }
  });

  test("the page does not depend on a bot being configured", async () => {
    // The archive reads rows, not bots. A no-bot install must still render.
    discovered = [];
    expect((await makeApp().request("/jira")).status).toBe(200);
  });
});

describe("GET /jira — list state and truncation", () => {
  test("every link keeps the `?limit=` the reader typed", async () => {
    const { saved } = seedTwo();
    const html = await (await makeApp().request("/jira?all=1&limit=3")).text();
    // The toggle switches `all` and keeps the rest.
    expect(html).toContain(`href="/jira?limit=3"`);
    expect(html).toContain(`href="/jira?all=1&amp;limit=3"`);
    // The row carries the list it was opened from…
    expect(html).toContain(`href="/jira?draft=${saved}&amp;all=1&amp;limit=3"`);
  });

  test("…and the draft page gets back to exactly that list", async () => {
    const { saved } = seedTwo();
    const html = await (await makeApp().request(`/jira?draft=${saved}&all=1&limit=3`)).text();
    expect(html).toContain(`href="/jira?all=1&amp;limit=3"`);
    // A draft url typed by hand keeps the plain back link.
    const plain = await (await makeApp().request(`/jira?draft=${saved}`)).text();
    expect(plain).toContain(`href="/jira"`);
    expect(plain).not.toContain("all=1");
  });

  test("a `?limit=` the reader cannot have meant pins nothing into the links", async () => {
    // `clampJiraArchiveLimit("abc")` answers with the DEFAULT, so adopting its
    // return unconditionally wrote `limit=50` into the toggle, every row and the
    // back link — the exact value `limitParam: null` exists to keep out of the
    // url. The rows are still read at the default; only the echo is dropped.
    seedRow({ markdown: "# En", savedAt: Date.now() });
    const html = await (await makeApp().request("/jira?limit=abc")).text();
    expect(html).not.toContain("limit=");
    expect(html).toContain(`href="/jira?all=1"`);
    // A limit that DID parse is still echoed.
    expect(await (await makeApp().request("/jira?limit=3")).text()).toContain(
      `href="/jira?all=1&amp;limit=3"`,
    );
  });

  test("`de nyeste N` is claimed only when a row was actually cut", async () => {
    seedRow({ markdown: "# En", savedAt: Date.now() });
    seedRow({ markdown: "# To", savedAt: Date.now() });
    // Exactly two saved rows under a limit of two: nothing was cut.
    expect(await (await makeApp().request("/jira?limit=2")).text()).not.toContain("de nyeste");
    expect(await (await makeApp().request("/jira?limit=1")).text()).toContain("de nyeste 1");
  });

  test("a dead database is a 500 with the fallback page, not a 200", async () => {
    // The page reads the DB itself now. Answering 200 to a listing that could not
    // be read tells every caller — a monitor included — that the page is fine.
    archiveThrows = "connection terminated";
    const res = await makeApp().request("/jira");
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("Jira-arkivet kunne ikke bygges");
    expect(html).toContain("connection terminated");
    expect(html).not.toContain("upåvirket");
  });
});

describe("GET /api/jira/archive", () => {
  test("saved-only by default, everything with `?all=1`", async () => {
    const app = makeApp();
    const id = seedRow({ savedAt: null });

    const before = await (await app.request("/api/jira/archive")).json();
    expect(before.savedOnly).toBe(true);
    expect(before.drafts.map((d: { draftId: string }) => d.draftId)).not.toContain(id);

    const all = await (await app.request("/api/jira/archive?all=1")).json();
    expect(all.savedOnly).toBe(false);
    const row = all.drafts.find((d: { draftId: string }) => d.draftId === id);
    expect(row).toBeDefined();
    expect(row.title).toBe("Arkivsak");
    // The listing is the binding + the labels, never the payload the wide read
    // serves: no markdown, no citations.
    expect(row.markdown).toBeUndefined();
    expect(row.citations).toBeUndefined();
  });

  test("the limit is clamped, and the response echoes what it used", async () => {
    const res = await makeApp().request("/api/jira/archive?all=1&limit=100000");
    const body = await res.json();
    expect(body.limit).toBe(200);
    expect(body.drafts.length).toBeLessThanOrEqual(200);
    expect((await (await makeApp().request("/api/jira/archive?limit=3")).json()).limit).toBe(3);
  });

  test("`capped` rides the payload, and is a row past the limit", async () => {
    seedRow({ savedAt: Date.now() });
    seedRow({ savedAt: Date.now() });
    expect((await (await makeApp().request("/api/jira/archive?limit=1")).json()).capped).toBe(true);
    expect((await (await makeApp().request("/api/jira/archive?limit=2")).json()).capped).toBe(false);
  });

  test("no CORS headers, and never cached", async () => {
    // A corpus-wide listing hands over every draft id at once — a strictly
    // bigger lever than the migration-070 accepted risk of guessing one.
    const res = await makeApp().request("/api/jira/archive");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ── The draft as a turn in the thread ────────────────────────────────────────

describe("POST /api/jira/draft/from-thread", () => {
  const post = (body: Record<string, unknown>) =>
    makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const started = async (over: Record<string, unknown> = {}) => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [
      { role: "user", text: "Vi må se på uttrekket for MELOSYS-7264." },
      { role: "assistant", text: "Det ligner MELOSYS-8150 — samme uttrekksflyt." },
    ];
    const res = await post({ threadId: THREAD_ID, template: "bug", depth: "skisse", ...over });
    const body = await res.json();
    // The run is DETACHED (the caller gets its id and leaves), so the row is
    // read only after it has settled — the `/draft/start` convention.
    await new Promise((r) => setTimeout(r, 40));
    return { res, body };
  };

  test("returns {draftId} immediately and lands a ready row the poller can read", async () => {
    const { res, body } = await started();
    expect(res.status).toBe(200);
    expect(body.status).toBe("generating");

    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    expect(view.status).toBe("ready");
    expect(view.source).toBe("thread");
    expect(view.threadId).toBe(THREAD_ID);
    expect(view.threadName).toBe("medlemskap-uttrekk");
    // The row points at the assistant message the markdown was taken from —
    // PR 5's «Juster i samtalen» link.
    expect(view.messageId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    // `notes` is NOT NULL and doubles as the banner line; nothing was condensed
    // into a search, so `retrieval_question` says the same thing.
    expect(view.notes).toBe("fra samtale: medlemskap-uttrekk");
    expect(view.retrievalQuestion).toBe("fra samtale: medlemskap-uttrekk");
  });

  test("the user line is visible and names the template + depth; the instruction rides the TURN", async () => {
    await started();
    expect(threadTurns).toHaveLength(1);
    expect(threadTurns[0]!.text).toBe("Lag Jira-sak (bug, skisse).");
    expect(threadTurns[0]!.turnInstruction).toContain("TEKNISK DYBDE: SKISSE");
    // No fenced citations block and no fenced raw material — the thread IS the
    // context, which is the whole reason this path exists.
    expect(threadTurns[0]!.turnInstruction).not.toContain("RÅMATERIALE:");
  });

  test("the hit set is seeded from the THREAD's citations, conversation-used first", async () => {
    const { body } = await started();
    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    // The confluence page scores 0.9 to the Jira issue's 0.4 — but the assistant
    // NAMED MELOSYS-8150, and a source the conversation used is better grounding
    // than one a search merely returned.
    expect(view.citations.map((c: { docId: string }) => c.docId)).toEqual([
      "MELOSYS-8150_Uttrekk.md",
      "Team MELOSYS/rammeavtale.md",
    ]);
    expect(view.retrievalCoverage).toBe("answer");
  });

  test("`## Referanser` is server-appended from the thread's own sources", async () => {
    const { body } = await started();
    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    expect(view.markdown).toContain("## Referanser");
    expect(view.markdown).toContain("[MELOSYS-8150](https://jira.adeo.no/browse/MELOSYS-8150)");
  });

  test("a key the PERSON typed in chat reads amber, not red", async () => {
    // MELOSYS-7264 appears in the user's own message and in nothing retrieved.
    // Passing the `fra samtale: …` placeholder as the raw material would have
    // called it a fabrication; the conversation's user messages are what the key
    // verification reads here.
    __setJiraThreadTurnForTest(
      scriptedThreadTurn("## Symptom\nSe MELOSYS-7264 og MELOSYS-8150."),
    );
    const { body } = await started();

    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    expect(view.keyVerdicts.find((v: { key: string }) => v.key === "MELOSYS-8150").state).toBe("verified");
    expect(view.keyVerdicts.find((v: { key: string }) => v.key === "MELOSYS-7264").state).toBe("notes");
  });

  test("the reader's steer rides the VISIBLE user line, not only the system prompt", async () => {
    await started({ extra: "kortere, og uten MELOSYS-1234" });
    // The steer is the whole lever on this path, and a lever nobody can see in
    // the thread is not one: the line is what the reader scrolls past, what makes
    // two clicks cumulative, and what every doc here claims it is.
    expect(threadTurns[0]!.text).toBe(
      "Lag Jira-sak (bug, skisse). kortere, og uten MELOSYS-1234",
    );
    // …and it is still the shape the history strip recognises, so the NEXT run
    // does not read this line back as the person's raw material.
    expect(isJiraTurnLine(threadTurns[0]!.text)).toBe(true);
  });

  test("a key the reader NAMES IN THE STEER reads amber, not red", async () => {
    // MELOSYS-4242 is in neither the retrieved set nor the conversation — only in
    // the steer the reader just typed. Handing key verification `history.userText`
    // alone called that a fabrication: the person had just written the key down.
    __setJiraThreadTurnForTest(
      scriptedThreadTurn("## Symptom\nSe MELOSYS-4242 og MELOSYS-8150."),
    );
    const { body } = await started({ extra: "ta med MELOSYS-4242" });

    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    const state = (k: string) =>
      view.keyVerdicts.find((v: { key: string }) => v.key === k).state;
    expect(state("MELOSYS-8150")).toBe("verified");
    expect(state("MELOSYS-4242")).toBe("notes");
  });

  test("a key the reader asked to LEAVE OUT reads amber too — the accepted asymmetry", async () => {
    // The steer joins the raw material WHOLESALE, so a key it names reads amber
    // whichever polarity it had — «uten MELOSYS-1234» included, when the model
    // cites it anyway. Amber's sentence stays literally true (the person wrote
    // the key down); the lexical polarity filter that used to make this red was
    // deleted because every version of it also stripped keys named POSITIVELY,
    // charging a person-typed key as fabricated. MELOSYS-8150 is retrieved, so it
    // stays verified either way.
    __setJiraThreadTurnForTest(
      scriptedThreadTurn("## Symptom\nSe MELOSYS-1234 og MELOSYS-8150."),
    );
    const { body } = await started({ extra: "kortere, og uten MELOSYS-1234" });

    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    const state = (k: string) =>
      view.keyVerdicts.find((v: { key: string }) => v.key === k).state;
    expect(state("MELOSYS-8150")).toBe("verified");
    expect(state("MELOSYS-1234")).toBe("notes");
  });

  /**
   * `readThreadHistory`'s two filters, seen from the outside.
   *
   * They decide what "the raw material" IS on this path, i.e. the amber/red axis
   * of every key verdict, and nothing else in the suite can see them: the
   * function is internal, and its result reaches the reader only as
   * `keyVerdicts`. Two things are excluded, each for its own reason — a message
   * that is not the PERSON's (a peer agent, the bot itself) is not the person's
   * claim about anything, and this feature's OWN turn lines are ours, not
   * theirs: the steer rides them, so a key one names («uten MELOSYS-1234») would
   * otherwise read amber ("you wrote it") when the person asked for the
   * opposite.
   */
  test("only the PERSON's own messages are raw material, and our turn lines are not", async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [
      { role: "user", text: "Uttrekket feiler for EØS-saker, se MELOSYS-3001." },
      // Ours: a previous 🧾 click's visible line, steer and all.
      { role: "user", text: "Lag Jira-sak (bug, skisse). uten MELOSYS-3002" },
      // Another agent talking in the thread (the hivemind autorespond path).
      { role: "peer", text: "Se også MELOSYS-3003." },
      // The bot's own reply — grounding evidence, never the person's claim.
      { role: "assistant", text: "Det ligner MELOSYS-3004 og MELOSYS-8150." },
    ];
    __setJiraThreadTurnForTest(
      scriptedThreadTurn(
        "## Symptom\nSe MELOSYS-3001, MELOSYS-3002, MELOSYS-3003, MELOSYS-3004 og MELOSYS-8150.",
      ),
    );
    const res = await post({ threadId: THREAD_ID, template: "bug", depth: "skisse" });
    const { draftId } = await res.json();
    await new Promise((r) => setTimeout(r, 40));

    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    const state = (k: string) =>
      view.keyVerdicts.find((v: { key: string }) => v.key === k).state;
    // Retrieved by the conversation ⇒ grounded.
    expect(state("MELOSYS-8150")).toBe("verified");
    // The person typed it ⇒ amber, not a fabrication charge.
    expect(state("MELOSYS-3001")).toBe("notes");
    // Ours, a peer's, the bot's ⇒ red. MELOSYS-3002 rode a PREVIOUS run's
    // steer and is stripped with our turn line — the accepted cross-run
    // asymmetry (this run's steer stays amber via the wholesale notes join;
    // a previous run's must be re-named in the new steer to stay amber).
    expect(state("MELOSYS-3002")).toBe("unknown");
    expect(state("MELOSYS-3003")).toBe("unknown");
    expect(state("MELOSYS-3004")).toBe("unknown");
  });

  test("an unknown or malformed thread id is a 404, never a 500", async () => {
    expect((await post({ threadId: "not-a-uuid", template: "bug", depth: "ingen" })).status).toBe(404);
    expect((await post({ threadId: THREAD_ID, template: "bug", depth: "ingen" })).status).toBe(404);
  });

  test("a thread belonging to another bot is a 400 naming both", async () => {
    threads.set(THREAD_ID, { ...THREAD, botName: "jarvis" });
    const res = await post({ threadId: THREAD_ID, template: "bug", depth: "ingen" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("jarvis");
    expect(body.error).toContain("melosys");
  });

  test("body-shape refusals are 400s in Norwegian, before anything is created", async () => {
    threads.set(THREAD_ID, THREAD);
    expect((await post({ template: "bug", depth: "ingen" })).status).toBe(400);
    expect((await post({ threadId: THREAD_ID, depth: "ingen" })).status).toBe(400);
    expect((await post({ threadId: THREAD_ID, template: "bug", depth: "dyp" })).status).toBe(400);
    const over = await post({
      threadId: THREAD_ID, template: "bug", depth: "ingen", extra: "x".repeat(2001),
    });
    expect(over.status).toBe(400);
    expect((await over.json()).error).toContain("Ekstra instruks");
    expect(rows.size).toBe(0);
  });

  test("an unknown template id is a 400, and a missing bot a 503", async () => {
    threads.set(THREAD_ID, THREAD);
    const bad = await post({ threadId: THREAD_ID, template: "epos", depth: "ingen" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("epos");

    discovered = [];
    expect((await post({ threadId: THREAD_ID, template: "bug", depth: "ingen" })).status).toBe(503);
  });

  test("a second click on the same thread + template + depth is a 409, not a second turn", async () => {
    threads.set(THREAD_ID, THREAD);
    // Hold the slot before the first request can release it.
    threadTurns = [];
    __setJiraThreadTurnForTest((async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", text: THREAD_DRAFT_BODY };
    }) as never);
    const first = post({ threadId: THREAD_ID, template: "bug", depth: "ingen" });
    const second = await post({ threadId: THREAD_ID, template: "bug", depth: "ingen" });
    expect(second.status).toBe(409);
    expect((await second.json()).state).toBe("running");
    await first;
  });

  test("a SECOND from-thread run at a different template/depth is still a 409", async () => {
    threads.set(THREAD_ID, THREAD);
    // Two turns in ONE thread is not a double spend, it is two interleaved
    // conversations: two user lines and two replies, in an order neither the
    // reader nor the next prompt can untangle. The slot is therefore the THREAD.
    __setJiraThreadTurnForTest((async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", text: THREAD_DRAFT_BODY };
    }) as never);
    const first = post({ threadId: THREAD_ID, template: "bug", depth: "ingen" });
    const second = await post({ threadId: THREAD_ID, template: "story", depth: "skisse", extra: "kortere" });
    expect(second.status).toBe(409);
    expect((await second.json()).state).toBe("running");
    await first;
  });

  test("a turn that produces nothing marks the row failed rather than storing an empty task", async () => {
    threads.set(THREAD_ID, THREAD);
    __setJiraThreadTurnForTest((async () => ({ text: "   " })) as never);
    const res = await post({ threadId: THREAD_ID, template: "bug", depth: "ingen" });
    const { draftId } = await res.json();
    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.status).toBe("failed");
    expect(view.markdown).toBeNull();
    expect(view.error).toContain("Modellen returnerte ingen tekst");
  });

  test("a turn that FAILED reports the transport failure, not «ingen tekst»", async () => {
    threads.set(THREAD_ID, THREAD);
    // `processChatMessage` reports a connector error internally and hands back
    // `undefined`, which the runner sees as `null`. That is a failed request, not
    // a model that answered with nothing, and the two need different sentences:
    // one says «try again», the other says «the model had nothing to say».
    __setJiraThreadTurnForTest((async () => null) as never);
    const res = await post({ threadId: THREAD_ID, template: "bug", depth: "ingen" });
    const { draftId } = await res.json();
    await new Promise((r) => setTimeout(r, 20));
    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.status).toBe("failed");
    expect(view.error).toContain("kunne ikke skrives ferdig");
    expect(view.error).not.toContain("Modellen returnerte ingen tekst");
  });

  test("`## Referanser` lists only the sources the DRAFT named", async () => {
    const { body } = await started();
    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    // The turn body names MELOSYS-8150 and nothing else. The thread prompt has no
    // citation block at all, so appending the whole depth slice put a link under
    // the task for a Confluence page the model never saw.
    expect(view.markdown).toContain("[MELOSYS-8150](https://jira.adeo.no/browse/MELOSYS-8150)");
    expect(view.markdown).not.toContain("confluence.test/rammeavtale");
    // …while the toggle column still carries the wide stored set.
    expect(view.citations).toHaveLength(2);
  });

  test("a simple-request content type is a 415 — this route writes into a conversation", async () => {
    threads.set(THREAD_ID, THREAD);
    // `text/plain` is a CORS *simple* request: no preflight, so the deliberate
    // absence of CORS headers here stops the browser reading the RESPONSE but not
    // the request from landing two messages in someone's chat.
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "ingen" }),
    });
    expect(res.status).toBe(415);
    expect(rows.size).toBe(0);
    // A charset parameter on the real content type is still fine.
    const ok = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "ingen" }),
    });
    expect(ok.status).toBe(200);
  });

  test("Full with the code servers down is a 503 here too, not a tool-less draft", async () => {
    threads.set(THREAD_ID, THREAD);
    mcpServers = [okServer("code", [], "down"), ...ALL_UP.slice(1)];
    const res = await post({ threadId: THREAD_ID, template: "bug", depth: "full" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unreachableServers).toEqual(["code"]);
    expect(body.error).toContain("Full teknisk dybde");
    expect(rows.size).toBe(0);
    // Skisse is unaffected.
    expect((await post({ threadId: THREAD_ID, template: "bug", depth: "skisse" })).status).toBe(200);
  });

  /**
   * The named acceptance: regenerating IS a second 🧾 click with a steer.
   *
   * It produces a second TURN and a second ROW, and the first draft's markdown is
   * left exactly as it was — which is what makes the archive an archive.
   */
  test("a second 🧾 with a steer is a second turn and a second row; the first is untouched", async () => {
    const firstId = (await started()).body.draftId as string;
    const first = await (await makeApp().request(`/api/jira/draft/${firstId}`)).json();
    expect(threadTurns).toHaveLength(1);
    expect(threadTurns[0]!.text).toBe("Lag Jira-sak (bug, skisse).");

    __setJiraThreadTurnForTest(
      scriptedThreadTurn("## Symptom\nKortere.", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
    );
    const secondId = (await started({ extra: "kortere, og uten MELOSYS-1234" })).body.draftId as string;

    expect(secondId).not.toBe(firstId);
    // The steer rides BOTH halves of the lever that replaced the toggles: the
    // turn instruction the model follows, and the visible user line the thread
    // (and therefore the next turn, and the reader) keeps as its record.
    expect(threadTurns).toHaveLength(2);
    expect(threadTurns[1]!.turnInstruction).toContain("kortere, og uten MELOSYS-1234");
    expect(threadTurns[1]!.text).toBe(
      "Lag Jira-sak (bug, skisse). kortere, og uten MELOSYS-1234",
    );

    const second = await (await makeApp().request(`/api/jira/draft/${secondId}`)).json();
    expect(second.status).toBe("ready");
    expect(second.markdown).toContain("Kortere.");
    expect(second.messageId).toBe("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");

    // …and the first row is byte-identical, still pointing at its own message.
    const firstAgain = await (await makeApp().request(`/api/jira/draft/${firstId}`)).json();
    expect(firstAgain.markdown).toBe(first.markdown);
    expect(firstAgain.messageId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });
});

// ── The chat card's two endpoints ────────────────────────────────────────────

/**
 * `GET /api/jira/drafts?thread=` and `POST /api/jira/draft/:id/save`.
 *
 * The properties only this file can see: the CORS posture (a thread-keyed listing
 * hands over every draft id at once, so it carries none of the migration-070
 * accepted risk), the 415 on the save (a body-less POST is a CORS *simple*
 * request that executes whatever the response headers say), and the early
 * `message_id` stamp — which is what makes a run that FAILS after its turn still
 * reachable as a card.
 */
describe("GET /api/jira/drafts?thread=", () => {
  const startOne = async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "user", text: "Vi må se på uttrekket." }];
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 40));
    return body.draftId as string;
  };

  test("serves the binding and NOTHING else — no markdown, no citations", async () => {
    const draftId = await startOne();
    const res = await makeApp().request(`/api/jira/drafts?thread=${THREAD_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drafts).toHaveLength(1);
    expect(Object.keys(body.drafts[0]).sort()).toEqual(["draftId", "messageId", "status"]);
    expect(body.drafts[0].draftId).toBe(draftId);
    expect(body.drafts[0].status).toBe("ready");
    expect(body.drafts[0].messageId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  test("is no-store and carries NO CORS headers, unlike the single-draft GET", async () => {
    await startOne();
    const res = await makeApp().request(`/api/jira/drafts?thread=${THREAD_ID}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The listing is a strictly bigger lever than guessing one id.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a missing thread is a 400 and a non-uuid a 404 — postgres never sees it", async () => {
    expect((await makeApp().request("/api/jira/drafts")).status).toBe(400);
    expect((await makeApp().request("/api/jira/drafts?thread=%20")).status).toBe(400);
    expect((await makeApp().request("/api/jira/drafts?thread=not-a-uuid")).status).toBe(404);
  });

  test("a thread with no drafts is an empty list, not a 404", async () => {
    const res = await makeApp().request("/api/jira/drafts?thread=99999999-8888-4777-8666-555555555555");
    expect(res.status).toBe(200);
    expect((await res.json()).drafts).toEqual([]);
  });
});

describe("POST /api/jira/draft/:id/save", () => {
  const startOne = async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "user", text: "Vi må se på uttrekket." }];
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 40));
    return body.draftId as string;
  };

  test("stamps savedAt and returns the whole view", async () => {
    const draftId = await startOne();
    const before = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(before.savedAt).toBeNull();

    const res = await makeApp().request(`/api/jira/draft/${draftId}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(typeof saved.savedAt).toBe("number");
    expect(saved.markdown).toContain("## Referanser");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    // It SURVIVES — that is the only reason the column exists.
    const reread = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(reread.savedAt).toBe(saved.savedAt);
  });

  test("415s anything that is not application/json — a text/plain POST is a CORS simple request", async () => {
    const draftId = await startOne();
    const bare = await makeApp().request(`/api/jira/draft/${draftId}/save`, { method: "POST" });
    expect(bare.status).toBe(415);
    const plain = await makeApp().request(`/api/jira/draft/${draftId}/save`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(415);
    // …and nothing was written.
    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.savedAt).toBeNull();
  });

  test("an UNFINISHED draft is a 409, not a 404 — the row exists, its state refuses", async () => {
    // «Lagre» renders only on a ready card, but the route is reachable directly.
    // Stamping `saved_at` on a `generating` row marks a draft kept while the
    // runner is still writing over it; on a `failed` one it keeps nothing at all.
    const draftId = await startOne();
    const row = rows.get(draftId)!;

    row.status = "generating";
    const running = await makeApp().request(`/api/jira/draft/${draftId}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(running.status).toBe(409);
    expect((await running.json()).error).toContain("ferdig");

    row.status = "failed";
    const failed = await makeApp().request(`/api/jira/draft/${draftId}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(failed.status).toBe(409);

    // …and nothing was written on either attempt.
    expect(row.savedAt).toBeNull();
  });

  test("a non-uuid is a 404 before postgres sees it; an unknown uuid is a 404 too", async () => {
    const bad = await makeApp().request("/api/jira/draft/not-a-uuid/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(404);
    const missing = await makeApp().request("/api/jira/draft/99999999-8888-4777-8666-555555555555/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });
});

/**
 * The early `message_id` stamp.
 *
 * A first draft binds its row to the bubble RIGHT AFTER the turn, before the
 * seeding, the finalize and both post-passes — all of which can fail. Stamped only
 * at finish time, a run that died in key verification left a row no card could
 * ever reach, so the reader saw the failure nowhere at all.
 */
describe("the first draft's message_id is stamped before finalize", () => {
  test("a run that FAILS after its turn still names its message — the card renders the failure", async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "user", text: "Vi må se på uttrekket." }];
    // An EMPTY reply: the turn produced a message, and everything after it fails.
    __setJiraThreadTurnForTest(scriptedThreadTurn("   ", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"));
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    const { draftId } = await res.json();
    await new Promise((r) => setTimeout(r, 40));

    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.status).toBe("failed");
    expect(view.markdown).toBeNull();
    // The binding survives the failure — this is the whole point.
    expect(view.messageId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    // …and the listing hands the card exactly that pair.
    const listing = await (await makeApp().request(`/api/jira/drafts?thread=${THREAD_ID}`)).json();
    expect(listing.drafts.at(-1)).toEqual({
      draftId,
      messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status: "failed",
    });
  });

  test("every from-thread run stamps its OWN row — a second click never re-points the first", async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "user", text: "Vi må se på uttrekket." }];
    __setJiraThreadTurnForTest(scriptedThreadTurn());
    const first = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    const { draftId } = await first.json();
    await new Promise((r) => setTimeout(r, 40));
    expect((await (await makeApp().request(`/api/jira/draft/${draftId}`)).json()).messageId).toBe(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );

    // A second 🧾 in the same thread produces a NEW message on a NEW row.
    __setJiraThreadTurnForTest(scriptedThreadTurn("## Symptom\nKortere.", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"));
    const second = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse", extra: "kortere" }),
    });
    const secondId = (await second.json()).draftId as string;
    await new Promise((r) => setTimeout(r, 40));

    // The first row still names its own turn — each row describes exactly the
    // message its markdown came from, which is what binds the card in the chat.
    const after = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(after.messageId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(
      (await (await makeApp().request(`/api/jira/draft/${secondId}`)).json()).messageId,
    ).toBe("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
  });
});
