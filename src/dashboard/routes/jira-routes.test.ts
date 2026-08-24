/**
 * Acceptance for the Jira composer's HTTP surface and its SSE runner.
 *
 * What only this file can see:
 *
 *   1. **The pre-commit ordering.** Every body check, the unknown template id,
 *      the missing-bot 503 and the `Full` MCP pre-flight all have to land BEFORE
 *      `streamSSE` commits a 200 — otherwise they reach the reader as an
 *      `app_error` inside a successful response, where nothing distinguishes
 *      them from a model failure. Each is pinned here as a plain JSON status.
 *   2. **A regenerate issues NO second retrieval.** Asserted by counting calls on
 *      the injected retrieval seam, which is the only place that can see it.
 *   3. **The EFFECTIVE copilot session options carry the `mcp:*` exclusion.** Not
 *      an options-object assertion against a mock of our own code — the real
 *      `executePrompt` from `connectors/copilot-sdk.ts` runs, with only the SDK
 *      boundary stubbed, and the object it hands `createSession` is inspected.
 *      An options-object-only assertion passes while the fence is inert, which is
 *      exactly the failure this whole design is written against.
 *   4. **`GET /api/jira/draft/:id` answers `generating` mid-flight** and the row
 *      is complete after a client abort — the property the polling contract and
 *      the extension's fire-and-forget start both rest on.
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
mock.module("../../db/jira-drafts.ts", () => ({
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
  startJiraDraftRun: async (id: string, excludeDocIds: string[]) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { status: "generating", error: null, excludeDocIds });
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
  failJiraDraft: async (id: string, error: string, restoreExcludeDocIds?: string[]) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { status: "failed", error, ...(restoreExcludeDocIds ? { excludeDocIds: restoreExcludeDocIds } : {}) });
  },
  updateJiraDraftMarkdown: async (id: string, markdown: string, kv: unknown[], mf: unknown[]) => {
    const r = rows.get(id);
    if (!r) return false;
    Object.assign(r, { markdown, keyVerdicts: kv, markdownFlags: mf, status: "ready", error: null });
    return true;
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
}));

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
  __setJiraOneShotForTest,
  __setJiraRetrievalForTest,
  __setJiraThreadTurnForTest,
  missingFullServers,
} = await import("./jira-routes.ts");
const {
  __resetJiraFlightsForTest,
  acquireJiraFlight,
  jiraFlightKey,
  JIRA_SLOT_SLACK_MS,
  JIRA_TIMEOUT_MS_BY_DEPTH,
} = await import("./jira-sse.ts");
const { __resetJiraKeyIndexForTest } = await import("../../jira/verify-keys.ts");
const { clampJiraArchiveLimit, effectiveCoverage, jiraDraftTitle } = await import(
  "../../jira/wire.ts"
);
const { buildDepthFence } = await import("../../jira/tool-fence.ts");
const { isJiraTurnLine } = await import("../../jira/thread-draft.ts");

// ── Fixtures ─────────────────────────────────────────────────────────────────

type SseEvent = { event: string; data: Record<string, unknown> };
function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || data === undefined) continue;
    try { out.push({ event: ev, data: JSON.parse(data) }); } catch { out.push({ event: ev, data: {} }); }
  }
  return out;
}

const config = {
  tracingEnabled: false,
  tracingCaptureToolOutputs: false,
  claudeModel: "sonnet",
  knowledgeApiUrl: "http://huginn.test",
} as never;

const NOTES =
  "Refinement 2026-08-22: årsavregning av trygdeavgift feiler når saken er fakturert. " +
  "Ligner MELOSYS-5677. Vi må se på faktureringskomponenten.";

/** Retrieval seam — two jira-issues hits and one confluence page. */
function scriptedRetrieval(counter: { n: number }) {
  return (async () => {
    counter.n++;
    return {
      results: [
        { collection: "jira-issues", id: "MELOSYS-5677_Ny_flyt.md", title: "Ny flyt", url: "https://jira.adeo.no/browse/MELOSYS-5677", relevance: 0.9, viaSubQuestion: ["q"], matchedChunks: [{ content: "årsavregning" }] },
        { collection: "jira-issues", id: "MELOSYS-8028_Manglende.md", title: "Manglende innbetaling", url: "https://jira.adeo.no/browse/MELOSYS-8028", relevance: 0.8, viaSubQuestion: ["q"] },
        { collection: "melosys-confluence-v3", id: "faktura.md", title: "Fakturering", url: "https://confluence.test/faktura", relevance: 0.7, viaSubQuestion: ["q"] },
      ],
      decomposition: { subQuestions: ["q"], rationale: "", passthrough: true, haikuMs: 1 },
      subSearches: [{ subQuestion: "q", durationMs: 1, resultCount: 3, lowConfidence: false }],
      traceId: "t",
    };
  }) as never;
}
const scriptedQuestion = (async () => ({
  question: "Hvordan beregnes årsavregning av trygdeavgift ved fakturering?",
  degraded: false,
  haikuMs: 1,
})) as never;

const DRAFT_BODY = [
  "## Symptom",
  "Årsavregningen feiler. Se MELOSYS-5677 [1] og MELOSYS-8028 [2].",
  "Hypotese: samme rot som TRYGD-99.",
  "## Akseptansekriterier",
  "- Avregningen fullfører",
].join("\n");

function scriptedDraft(text = DRAFT_BODY) {
  return (async (
    _p: string, _c: unknown, _b: unknown,
    opts?: { onProgress?: (e: never) => void },
  ) => {
    opts?.onProgress?.({ type: "text_delta", text } as never);
    return { result: text, inputTokens: 100, outputTokens: 50, numTurns: 1, durationMs: 5 };
  }) as never;
}

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

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let retrievals = { n: 0 };

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
  retrievals = { n: 0 };
  __setJiraRetrievalForTest(scriptedRetrieval(retrievals), scriptedQuestion);
  __setJiraOneShotForTest(scriptedDraft());
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

// ── Pre-commit refusals ──────────────────────────────────────────────────────

describe("POST /api/jira/draft — every refusal is a plain JSON status, pre-commit", () => {
  test("a malformed body 400s before the stream", async () => {
    const res = await post(makeApp(), "/api/jira/draft", { notes: 42, template: "bug", depth: "skisse" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Råmaterialet må være en tekststreng.");
  });

  test("an unknown template 400s NAMING the id — never a silent fallback to bug", async () => {
    const res = await post(makeApp(), "/api/jira/draft", { notes: NOTES, template: "epic", depth: "skisse" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('ukjent mal "epic"');
  });

  test("an unknown depth 400s", async () => {
    const res = await post(makeApp(), "/api/jira/draft", { notes: NOTES, template: "bug", depth: "dyp" });
    expect(res.status).toBe(400);
  });

  test("the pinned bot missing is a 503, NOT a degraded wrong-corpus draft", async () => {
    discovered = [];
    let called = false;
    __setJiraOneShotForTest((async () => { called = true; return {} as never; }) as never);
    const res = await post(makeApp(), "/api/jira/draft", { notes: NOTES, template: "bug", depth: "skisse" });
    expect(res.status).toBe(503);
    expect(called).toBe(false);
  });

  test("Full with code/yggdrasil down is a 503, NOT a silent tool-less draft", async () => {
    mcpServers = [okServer("code", [], "down"), okServer("yggdrasil", [], "down"), okServer("knowledge", ["search_knowledge"])];
    let called = false;
    __setJiraOneShotForTest((async () => { called = true; return {} as never; }) as never);
    const res = await post(makeApp(), "/api/jira/draft", { notes: NOTES, template: "bug", depth: "full" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unreachableServers).toEqual(["code", "yggdrasil"]);
    expect(called).toBe(false);
  });

  test("Skisse is unaffected by the code servers being down", async () => {
    mcpServers = [okServer("code", [], "down"), okServer("yggdrasil", [], "down")];
    const res = await post(makeApp(), "/api/jira/draft", { notes: NOTES, template: "bug", depth: "skisse" });
    expect(res.status).toBe(200);
  });

  test("missingFullServers treats an ABSENT server as missing, not as fine", () => {
    expect(missingFullServers([])).toEqual(["code", "yggdrasil"]);
    expect(missingFullServers([okServer("code", ["call_tool"])])).toEqual(["yggdrasil"]);
    expect(missingFullServers(ALL_UP as never)).toEqual([]);
  });
});

// ── The happy path ───────────────────────────────────────────────────────────

describe("POST /api/jira/draft — the draft", () => {
  async function draft(body: Record<string, unknown> = {}) {
    const res = await post(makeApp(), "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse", ...body,
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    await new Promise((r) => setTimeout(r, 20));
    return events;
  }

  test("emits the draft id first, then citations, deltas, ONE done, terminal end", async () => {
    const events = await draft();
    const names = events.map((e) => e.event).filter((n) => n !== "heartbeat");
    expect(names[0]).toBe("draft");
    expect(names).toContain("citations");
    expect(names.filter((n) => n === "done")).toHaveLength(1);
    expect(names).not.toContain("app_error");
    expect(names[names.length - 1]).toBe("end");
  });

  test("the done payload carries the coverage VERDICT, not a boolean", async () => {
    const done = (await draft()).find((e) => e.event === "done")!.data;
    expect(done.coverage).toBe("answer");
    expect(Object.keys(done).sort()).toEqual([
      "citations", "coverage", "draftId", "keyVerdicts", "markdown", "markdownFlags", "retrievalCoverage", "retrievalQuestion",
    ]);
  });

  test("citations are typed rows with the OVERWRITTEN badges", async () => {
    const done = (await draft()).find((e) => e.event === "done")!.data as { citations: { badge: string; key?: string }[] };
    expect(done.citations).toHaveLength(3);
    expect(done.citations.map((c) => c.badge)).toEqual(["Jira", "Jira", "Confluence"]);
    expect(done.citations[0]!.key).toBe("MELOSYS-5677");
  });

  test("the retrieval question came from the NOTES, not from a hand-written question", async () => {
    const done = (await draft()).find((e) => e.event === "done")!.data;
    expect(done.retrievalQuestion).toContain("årsavregning");
  });

  test("`## Referanser` is server-appended as [KEY](full-url), never a bare key", async () => {
    const md = String((await draft()).find((e) => e.event === "done")!.data.markdown);
    expect(md).toContain("## Referanser");
    expect(md).toContain("- [MELOSYS-5677](https://jira.adeo.no/browse/MELOSYS-5677)");
    expect(md).toContain("- [Fakturering](https://confluence.test/faktura)");
    expect(md).not.toMatch(/^- MELOSYS-5677$/m);
  });

  test("dangling [n] markers are REPAIRED out of the body — nothing resolves them", async () => {
    // The model was given 3 sources and wrote `[1]`/`[2]` (see DRAFT_BODY).
    // `## Referanser` is unnumbered and key-deduped, so those markers point at
    // nothing in the Jira paste. Measured on a real draft: [4] [5] [6] [7].
    const md = String((await draft()).find((e) => e.event === "done")!.data.markdown);
    expect(md).not.toMatch(/\[\d+\]/);
    // The keys the markers sat behind are untouched.
    expect(md).toContain("Se MELOSYS-5677 og MELOSYS-8028.");
    expect(rows.get(String((await draft())[0]!.data.draftId))!.markdown).not.toMatch(/\[\d+\]/);
  });

  test("the key verdicts distinguish retrieved from notes-only from fabricated", async () => {
    const verdicts = (await draft()).find((e) => e.event === "done")!.data.keyVerdicts as {
      key: string; state: string; resolved?: boolean;
    }[];
    const by = new Map(verdicts.map((v) => [v.key, v]));
    expect(by.get("MELOSYS-5677")!.state).toBe("verified");
    // Never retrieved, never in the notes, absent from the corpus listing.
    expect(by.get("TRYGD-99")!.state).toBe("unknown");
    expect(by.get("TRYGD-99")!.resolved).toBe(false);
  });

  test("the row is READY with the same markdown after the stream settles", async () => {
    const events = await draft();
    const id = String(events[0]!.data.draftId);
    const row = rows.get(id)!;
    expect(row.status).toBe("ready");
    expect(row.markdown).toBe(String(events.find((e) => e.event === "done")!.data.markdown));
    // The WIDE stored set, not the depth slice.
    expect(row.citations).toHaveLength(3);
  });

  test("an empty model result is an app_error AND a failed row — never a fake task", async () => {
    __setJiraOneShotForTest(scriptedDraft("   "));
    const events = await draft();
    expect(events.map((e) => e.event)).not.toContain("done");
    const row = rows.get(String(events[0]!.data.draftId))!;
    expect(row.status).toBe("failed");
  });

  test("a connector throw lands on the row and still ends the stream", async () => {
    __setJiraOneShotForTest((async () => { throw new Error("timed out after 120000ms"); }) as never);
    const events = await draft();
    expect(String(events.find((e) => e.event === "app_error")!.data.message)).toContain("timed out");
    expect(events[events.length - 1]!.event).toBe("end");
    expect(rows.get(String(events[0]!.data.draftId))!.status).toBe("failed");
  });
});

// ── Regenerate ───────────────────────────────────────────────────────────────

describe("regenerate — reuses the stored hit set, issues NO second retrieval", () => {
  test("excludeDocIds drops the row, renumbers, and never re-retrieves", async () => {
    const app = makeApp();
    const first = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(first[0]!.data.draftId);
    expect(retrievals.n).toBe(1);

    const res = await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, excludeDocIds: ["MELOSYS-8028_Manglende.md"],
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    await new Promise((r) => setTimeout(r, 20));

    // The whole point of storing the hit set.
    expect(retrievals.n).toBe(1);

    const done = events.find((e) => e.event === "done")!.data as {
      citations: { docId: string; n: number }[]; markdown: string; draftId: string;
    };
    expect(done.draftId).toBe(draftId);
    expect(done.citations.map((c) => c.docId)).toEqual(["MELOSYS-5677_Ny_flyt.md", "faktura.md"]);
    // Renumbered — otherwise the draft cites gaps.
    expect(done.citations.map((c) => c.n)).toEqual([1, 2]);
    // The excluded doc's Referanser line is gone.
    expect(done.markdown).not.toContain("MELOSYS-8028](");
    expect(done.markdown).toContain("MELOSYS-5677](");
  });

  test("excluding EVERY source flips the verdict to no_hits — no stale `answer`", async () => {
    const app = makeApp();
    const first = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(first[0]!.data.draftId);

    const events = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
      excludeDocIds: ["MELOSYS-5677_Ny_flyt.md", "MELOSYS-8028_Manglende.md", "faktura.md"],
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const done = events.find((e) => e.event === "done")!.data;
    expect(done.coverage).toBe("no_hits");
    // No `## Referanser` at all — this is how the reader tells the two verdicts apart.
    expect(String(done.markdown)).not.toContain("## Referanser");
  });

  test("an unknown draftId is a 404, and it frees the single-flight slot", async () => {
    const app = makeApp();
    const res = await post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId: "nope" });
    expect(res.status).toBe(404);
    // Not wedged: an identical retry gets the same clean 404, not a 409.
    const again = await post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId: "nope" });
    expect(again.status).toBe(404);
  });
});

// ── Single flight ────────────────────────────────────────────────────────────

describe("single-flight is keyed on the CONTENT hash, exclusions included", () => {
  test("an identical in-flight POST gets a readable 409 with a deadline", async () => {
    const app = makeApp();
    // A draft that never resolves, so the slot stays held.
    __setJiraOneShotForTest((() => new Promise(() => {})) as never);
    void post(app, "/api/jira/draft", { notes: NOTES, template: "bug", depth: "skisse" });
    await new Promise((r) => setTimeout(r, 30));

    const res = await post(app, "/api/jira/draft", { notes: NOTES, template: "bug", depth: "skisse" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.state).toBe("running");
    expect(body.expiresAtMs).toBeGreaterThan(Date.now());
    expect(typeof body.error).toBe("string");
  });

  test("a DIFFERENT exclusion set is a different slot — the toggle-while-streaming path", async () => {
    const app = makeApp();
    const first = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(first[0]!.data.draftId);

    __setJiraOneShotForTest((() => new Promise(() => {})) as never);
    void post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId, excludeDocIds: ["faktura.md"] });
    await new Promise((r) => setTimeout(r, 30));
    // Same notes+template+depth, different exclusions ⇒ NOT a 409.
    const res = await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, excludeDocIds: ["MELOSYS-8028_Manglende.md"],
    });
    expect(res.status).toBe(200);
  });

  test("a changed `extra` on the same draft is a DIFFERENT slot", async () => {
    // `extra` reaches the prompt, so two runs with different steers are two
    // different generations. Keyed without it, the second one 409'd on "et likt
    // utkast" — about a draft that is not alike at all.
    const app = makeApp();
    const first = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(first[0]!.data.draftId);

    __setJiraOneShotForTest((() => new Promise(() => {})) as never);
    void post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId, extra: "fokuser på migrering" });
    await new Promise((r) => setTimeout(r, 30));
    const res = await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, extra: "fokuser på ytelse",
    });
    expect(res.status).toBe(200);
  });

  test("the slot outlives the run's teardown by exactly the slack", () => {
    // Sized to exactly the budget, a slot frees itself while its holder is still
    // tearing down and a click on that boundary starts a concurrent run. The
    // previous spelling compared two BUDGETS and said nothing about the slack.
    const key = jiraFlightKey({ notes: "n", template: "bug", depth: "skisse", extra: "", excludeDocIds: [], draftId: "" });
    const t0 = 1_000;
    expect(acquireJiraFlight(key, "skisse", t0).ok).toBe(true);
    const budget = JIRA_TIMEOUT_MS_BY_DEPTH.skisse;
    expect(acquireJiraFlight(key, "skisse", t0 + budget).ok).toBe(false);
    expect(acquireJiraFlight(key, "skisse", t0 + budget + JIRA_SLOT_SLACK_MS - 1).ok).toBe(false);
    expect(acquireJiraFlight(key, "skisse", t0 + budget + JIRA_SLOT_SLACK_MS).ok).toBe(true);
  });

  test("the slack covers every bounded step that runs OUTSIDE the model budget", () => {
    // Haiku condense (60 s router cap) + the Full document pull (8 s) + the
    // key-index listing (15 s) = 83 s of work the one-shot's own timeout does not
    // cover. A 60 s slack expired mid-run and a second click started a duplicate.
    expect(JIRA_SLOT_SLACK_MS).toBeGreaterThanOrEqual(83_000);
  });
});

// ── Status polling + the detached start ──────────────────────────────────────

describe("GET /api/jira/draft/:id — the polling contract", () => {
  test("answers `generating` mid-flight, then `ready`", async () => {
    const app = makeApp();
    let release: ((v: unknown) => void) | undefined;
    __setJiraOneShotForTest((() => new Promise((r) => { release = r; })) as never);

    const started = await (await post(app, "/api/jira/draft/start", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).json();
    expect(started.status).toBe("generating");

    const mid = await (await app.request(`/api/jira/draft/${started.draftId}`)).json();
    expect(mid.status).toBe("generating");
    expect(mid.markdown).toBeNull();

    release!({ result: DRAFT_BODY, inputTokens: 1, outputTokens: 1, numTurns: 1, durationMs: 1 });
    await new Promise((r) => setTimeout(r, 40));

    const after = await (await app.request(`/api/jira/draft/${started.draftId}`)).json();
    expect(after.status).toBe("ready");
    expect(String(after.markdown)).toContain("## Referanser");
    expect(after.citations).toHaveLength(3);
  });

  test("the completed row is present after a CLIENT ABORT — the work outlives the stream", async () => {
    const app = makeApp();
    const controller = new AbortController();
    const p = app.request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: NOTES, template: "bug", depth: "skisse" }),
      signal: controller.signal,
    });
    const res = await p;
    controller.abort();
    // The runner still writes the row: `clientState.gone` stops the WRITES, not
    // the work, and an aborted draft still spends its budget.
    await res.text().catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    const row = [...rows.values()][0]!;
    expect(row.status).toBe("ready");
    expect(row.markdown).toContain("## Referanser");
  });

  test("a poll target is no-store and CORS-open for the extension", async () => {
    const app = makeApp();
    const started = await (await post(app, "/api/jira/draft/start", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).json();
    await new Promise((r) => setTimeout(r, 40));
    const res = await app.request(`/api/jira/draft/${started.draftId}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const pre = await app.request("/api/jira/draft/start", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("an unknown id is a 404, including a non-uuid one", async () => {
    const res = await makeApp().request("/api/jira/draft/not-a-uuid");
    expect(res.status).toBe(404);
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

  test("a notes-sourced draft has no thread owner, but still names its bot", async () => {
    const app = makeApp();
    const started = await (await post(app, "/api/jira/draft/start", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).json();
    await new Promise((r) => setTimeout(r, 40));
    const view = await (await app.request(`/api/jira/draft/${started.draftId}`)).json();
    expect(view.bot).toBe("melosys");
    expect(view.threadUserId).toBeNull();
  });
});

// ── The reader's edit ────────────────────────────────────────────────────────

describe("PUT /api/jira/draft/:id", () => {
  async function seeded(app: Hono): Promise<string> {
    const events = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    return String(events[0]!.data.draftId);
  }

  test("re-runs BOTH post-passes against the edited text", async () => {
    const app = makeApp();
    const id = await seeded(app);
    const res = await app.request(`/api/jira/draft/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // The fabricated key is gone; a task-list checkbox has appeared.
      body: JSON.stringify({ markdown: "## Symptom\nSe MELOSYS-5677.\n- [ ] Krav" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keyVerdicts.map((v: { key: string }) => v.key)).toEqual(["MELOSYS-5677"]);
    expect(body.markdownFlags.map((f: { kind: string }) => f.kind)).toEqual(["task-list"]);
    expect(rows.get(id)!.markdown).toContain("- [ ] Krav");
  });

  test("the reader's text is stored BYTE-IDENTICAL — the [n] repair never runs here", async () => {
    const app = makeApp();
    const id = await seeded(app);
    // Every one of these was destroyed by the repair when it ran on this path:
    // `[2]` is a real citation marker the reader may have kept on purpose, `[13]`
    // is an article of a regulation the stored-set bound (24) reached, `liste[2]`
    // is an index expression and `[1](…)` is a link.
    const edited =
      "## Symptom\nSe MELOSYS-5677 [2]. Artikkel [13] i forordning 883/2004.\n" +
      "liste[2] og `args[1]`, se [1](https://x.no).";
    const res = await app.request(`/api/jira/draft/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: edited }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The client adopts what was STORED — otherwise the page shows "saved" over
    // text that differs from the row it just wrote. Here they are the same text.
    expect(body.markdown).toBe(edited);
    expect(rows.get(id)!.markdown).toBe(edited);
  });

  test("a non-string / blank / over-cap markdown is a 400", async () => {
    const app = makeApp();
    const id = await seeded(app);
    const put = (b: unknown) =>
      app.request(`/api/jira/draft/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
      });
    expect((await put({ markdown: 1 })).status).toBe(400);
    expect((await put({ markdown: "  " })).status).toBe(400);
    expect((await put({ markdown: "x".repeat(100_001) })).status).toBe(400);
  });

  test("an unknown id is a 404", async () => {
    const res = await makeApp().request("/api/jira/draft/nope", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

// ── The EFFECTIVE copilot session options ────────────────────────────────────

describe("the fence BINDS on the real connector, not just on an options object", () => {
  test("Ingen's effective copilot session options carry `mcp:*`", async () => {
    // Only the SDK boundary is stubbed. `executePrompt` — the real connector — is
    // what builds the object inspected here, so an `mcp__*` list (which matches
    // nothing on copilot) would fail this test rather than shipping inert.
    let captured: Record<string, unknown> | undefined;
    mock.module("@github/copilot-sdk", () => ({
      approveAll: () => ({}),
      CopilotClient: class {
        async start() {}
        async stop() {}
        async listModels() { return [{ id: "claude-sonnet-5" }]; }
        async createSession(opts: Record<string, unknown>) {
          captured = opts;
          return {
            on: () => () => {},
            async sendMessage() { return { content: "ok" }; },
            async destroy() {},
          };
        }
      },
    }));
    const { executePrompt } = await import("../../ai/connectors/copilot-sdk.ts");

    const fence = buildDepthFence("ingen", "copilot-sdk", ALL_UP as never);
    await executePrompt(
      "prompt",
      config,
      { ...FAKE_BOT, dir: "/tmp/nonexistent-bot", excludedTools: fence } as never,
      "system",
    ).catch(() => {});

    expect(captured).toBeDefined();
    const excluded = captured!.excludedTools as string[];
    // The SDK's own dialect: single colon, source-qualified.
    expect(excluded).toContain("mcp:*");
    expect(excluded).toContain("builtin:*");
    expect(excluded.some((t) => t.startsWith("mcp__"))).toBe(false);
  });
});

// ── The regenerate contract, in full ─────────────────────────────────────────

describe("regenerate — a draft whose RETRIEVAL never landed", () => {
  test("re-retrieves instead of being forced to no_hits forever", async () => {
    const app = makeApp();
    let calls = 0;
    __setJiraRetrievalForTest(
      (async () => {
        calls++;
        if (calls === 1) throw new Error("huginn refused the connection");
        return (await (scriptedRetrieval({ n: 0 }) as unknown as () => Promise<unknown>)()) as never;
      }) as never,
      scriptedQuestion,
    );

    const first = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(first[0]!.data.draftId);
    // Retrieval died, so the row carries the DEFAULT empty citation set — which is
    // truthy, and used to read as "the hit set is stored, reuse it".
    expect(rows.get(draftId)!.citations).toHaveLength(0);
    expect(rows.get(draftId)!.retrievalCoverage).toBeNull();

    const events = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
    })).text());
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toBe(2);
    const done = events.find((e) => e.event === "done")!.data as { citations: unknown[]; coverage: string };
    expect(done.citations).toHaveLength(3);
    expect(done.coverage).toBe("answer");
    expect(rows.get(draftId)!.citations).toHaveLength(3);
  });
});

describe("regenerate — a draft whose retrieval was UNREACHABLE", () => {
  test("re-retrieves; `unreachable` is not a landed hit set", async () => {
    const app = makeApp();
    let calls = 0;
    __setJiraRetrievalForTest(
      (async () => {
        calls++;
        if (calls === 1) {
          // huginn down: every sub-search errored, so `classifyJiraCoverage`
          // returns `unreachable` — a NON-NULL verdict over zero citations.
          return {
            results: [],
            decomposition: { subQuestions: ["q"], rationale: "", passthrough: true, haikuMs: 1 },
            subSearches: [{ subQuestion: "q", durationMs: 1, resultCount: 0, error: "ECONNREFUSED" }],
            traceId: "t",
          };
        }
        return (await (scriptedRetrieval({ n: 0 }) as unknown as () => Promise<unknown>)()) as never;
      }) as never,
      scriptedQuestion,
    );

    const first = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(first[0]!.data.draftId);
    expect(rows.get(draftId)!.retrievalCoverage).toBe("unreachable");
    expect(rows.get(draftId)!.citations).toHaveLength(0);

    // The page's only button. A stored `unreachable` used to count as "retrieval
    // landed" (the verdict is non-null), so this reused the empty hit set forever
    // — the reader was told «Prøv igjen senere» by the one control that could.
    const events = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
    })).text());
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toBe(2);
    const done = events.find((e) => e.event === "done")!.data as { citations: unknown[]; coverage: string };
    expect(done.citations).toHaveLength(3);
    expect(done.coverage).toBe("answer");
    expect(rows.get(draftId)!.retrievalCoverage).toBe("answer");
  });
});

describe("regenerate — the row is `generating` again, and the new coverage is persisted", () => {
  async function seed(app: Hono): Promise<string> {
    const events = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    return String(events[0]!.data.draftId);
  }

  test("a poll DURING a regenerate says `generating`, not `ready` with the old markdown", async () => {
    const app = makeApp();
    const draftId = await seed(app);
    expect(rows.get(draftId)!.status).toBe("ready");

    let release: ((v: unknown) => void) | undefined;
    __setJiraOneShotForTest((() => new Promise((r) => { release = r; })) as never);
    void post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, excludeDocIds: ["faktura.md"],
    });
    await new Promise((r) => setTimeout(r, 30));

    const mid = await (await app.request(`/api/jira/draft/${draftId}`)).json();
    expect(mid.status).toBe("generating");

    release!({ result: DRAFT_BODY, inputTokens: 1, outputTokens: 1, numTurns: 1, durationMs: 1 });
    await new Promise((r) => setTimeout(r, 40));
    expect((await (await app.request(`/api/jira/draft/${draftId}`)).json()).status).toBe("ready");
  });

  test("the RECOMPUTED coverage lands on the row, not just on the done payload", async () => {
    const app = makeApp();
    const draftId = await seed(app);
    expect(rows.get(draftId)!.retrievalCoverage).toBe("answer");

    const events = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
      excludeDocIds: ["MELOSYS-5677_Ny_flyt.md", "MELOSYS-8028_Manglende.md", "faktura.md"],
    })).text());
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.event === "done")!.data.coverage).toBe("no_hits");
    expect((await (await app.request(`/api/jira/draft/${draftId}`)).json()).coverage).toBe("no_hits");
    // …while the RETRIEVAL verdict — what retrieval actually found — is untouched.
    expect(rows.get(draftId)!.retrievalCoverage).toBe("answer");
  });

  test("an exclude-all regenerate does NOT latch the draft to no_hits forever", async () => {
    const app = makeApp();
    const draftId = await seed(app);

    // 1. Exclude every source: this run really is ungrounded.
    const off = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
      excludeDocIds: ["MELOSYS-5677_Ny_flyt.md", "MELOSYS-8028_Manglende.md", "faktura.md"],
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    expect(off.find((e) => e.event === "done")!.data.coverage).toBe("no_hits");

    // 2. Put them all back. The verdict must come back with them — the row stores
    //    what RETRIEVAL found, and `no_hits` was only ever true of the last run.
    const back = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, excludeDocIds: [],
    })).text());
    await new Promise((r) => setTimeout(r, 20));

    const done = back.find((e) => e.event === "done")!.data as { citations: unknown[]; coverage: string };
    expect(done.citations).toHaveLength(3);
    expect(done.coverage).toBe("answer");
    const view = await (await app.request(`/api/jira/draft/${draftId}`)).json();
    expect(view.coverage).toBe("answer");
    expect(view.retrievalCoverage).toBe("answer");
    // And no second retrieval was spent getting back there.
    expect(retrievals.n).toBe(1);
  });

  test("a FAILED regenerate restores the exclusion set the surviving markdown was written under", async () => {
    const app = makeApp();
    const draftId = await seed(app);
    // The stored markdown cites everything (exclusions []). Now an exclude-all
    // regenerate dies in the model call: the OLD text survives on the row, so the
    // row must not describe it with the NEW run's exclusion set — that pairing
    // read as `no_hits` over a task with a full `## Referanser`.
    __setJiraOneShotForTest((async () => { throw new Error("timed out after 120000ms"); }) as never);
    const events = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
      excludeDocIds: ["MELOSYS-5677_Ny_flyt.md", "MELOSYS-8028_Manglende.md", "faktura.md"],
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    expect(events[events.length - 1]!.event).toBe("end");
    const view = await (await app.request(`/api/jira/draft/${draftId}`)).json();
    expect(view.status).toBe("failed");
    expect(view.excludeDocIds).toEqual([]);
    expect(view.coverage).toBe("answer");
  });

  test("the done payload carries the RETRIEVAL verdict beside the derived one", async () => {
    const app = makeApp();
    const draftId = await seed(app);
    const off = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
      excludeDocIds: ["MELOSYS-5677_Ny_flyt.md", "MELOSYS-8028_Manglende.md", "faktura.md"],
    })).text());
    const done = off.find((e) => e.event === "done")!.data as { coverage: string; retrievalCoverage: string };
    expect(done.coverage).toBe("no_hits");
    expect(done.retrievalCoverage).toBe("answer");
  });

  test("the exclusion set is PERSISTED and rides the view", async () => {
    const app = makeApp();
    const draftId = await seed(app);
    await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, excludeDocIds: ["faktura.md"],
    })).text();
    await new Promise((r) => setTimeout(r, 20));

    const view = await (await app.request(`/api/jira/draft/${draftId}`)).json();
    expect(view.excludeDocIds).toEqual(["faktura.md"]);
    // The stored set stays WIDE — PR 2's toggle column renders every row and uses
    // `excludeDocIds` to say which are off.
    expect(view.citations).toHaveLength(3);
  });

  test("PUT re-verifies against the RETAINED set — an excluded key cannot flip back to verified", async () => {
    const app = makeApp();
    const draftId = await seed(app);
    await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId, excludeDocIds: ["MELOSYS-8028_Manglende.md"],
    })).text();
    await new Promise((r) => setTimeout(r, 20));

    const res = await app.request(`/api/jira/draft/${draftId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "## Symptom\nSe MELOSYS-5677 og MELOSYS-8028." }),
    });
    const body = await res.json();
    const by = new Map(body.keyVerdicts.map((v: { key: string; state: string }) => [v.key, v.state]));
    expect(by.get("MELOSYS-5677")).toBe("verified");
    // The reader toggled this source OFF; the draft is no longer grounded in it.
    expect(by.get("MELOSYS-8028")).not.toBe("verified");
  });
});

// ── The single-flight claim: one helper, no wedged slots, no leaked pg text ───

describe("the single-flight claim", () => {
  test("a non-uuid draftId is a 404 BEFORE any DB call, and does not wedge the slot", async () => {
    const app = makeApp();
    const res = await post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId: "not-a-uuid" });
    expect(res.status).toBe(404);
    expect(String((await res.json()).error)).toContain("ukjent utkast");

    const again = await post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId: "not-a-uuid" });
    expect(again.status).toBe(404);
  });

  test("a well-formed but UNKNOWN draftId 404s without echoing the id back", async () => {
    // `GET /api/jira/draft/:id` and `/draft/start` are CORS-open, so a page the
    // browser visits can drive this route; the reply must not reflect the
    // caller's own string back through it. Two spellings of the same 404 is one
    // spelling too many — every path answers with the non-echoing one.
    const app = makeApp();
    const unknown = "8a1f4c2e-0000-4000-8000-0000000000ff";
    for (const path of ["/api/jira/draft", "/api/jira/draft/start"]) {
      const res = await post(app, path, { template: "bug", depth: "skisse", draftId: unknown });
      expect(res.status).toBe(404);
      const body = String((await res.json()).error);
      expect(body).toBe("ukjent utkast");
      expect(body).not.toContain(unknown);
    }
  });

  test("the /start path answers the same way and leaks no slot either", async () => {
    const app = makeApp();
    expect((await post(app, "/api/jira/draft/start", { template: "bug", depth: "skisse", draftId: "nope" })).status).toBe(404);
    expect((await post(app, "/api/jira/draft/start", { template: "bug", depth: "skisse", draftId: "nope" })).status).toBe(404);
  });

  test("two DIFFERENT drafts with the same template/depth and no notes are different slots", async () => {
    const app = makeApp();
    const a = parseSse(await (await post(app, "/api/jira/draft", { notes: NOTES, template: "bug", depth: "skisse" })).text());
    await new Promise((r) => setTimeout(r, 20));
    const b = parseSse(await (await post(app, "/api/jira/draft", { notes: `${NOTES} (annen sak)`, template: "bug", depth: "skisse" })).text());
    await new Promise((r) => setTimeout(r, 20));
    const idA = String(a[0]!.data.draftId);
    const idB = String(b[0]!.data.draftId);

    __setJiraOneShotForTest((() => new Promise(() => {})) as never);
    void post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId: idA });
    await new Promise((r) => setTimeout(r, 30));
    // A regenerate of an UNRELATED draft must not collide with the one in flight.
    const res = await post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId: idB });
    expect(res.status).toBe(200);
  });

  test("a DB failure is a 500 that does not hand the caller postgres's own message", async () => {
    const app = makeApp();
    const events = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const draftId = String(events[0]!.data.draftId);
    readThrows.set(draftId, 'relation "jira_drafts" does not exist at character 42');

    const res = await post(app, "/api/jira/draft", { template: "bug", depth: "skisse", draftId });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).not.toContain("jira_drafts");
    expect(String(body.error)).not.toContain("character 42");
  });
});

// ── CORS is advertised only where it is served ───────────────────────────────

describe("the preflight advertises exactly the methods that carry CORS headers", () => {
  test("`/draft/:id` advertises GET only — PUT is a mutation nothing cross-origin needs", async () => {
    const app = makeApp();
    const pre = await app.request("/api/jira/draft/8a1f4c2e-0000-4000-8000-000000000000", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    const allow = String(pre.headers.get("access-control-allow-methods"));
    expect(allow).toContain("GET");
    expect(allow).not.toContain("PUT");
    expect(allow).not.toContain("POST");
  });

  test("`/draft/start` still advertises POST — that IS the extension's call", async () => {
    const pre = await makeApp().request("/api/jira/draft/start", { method: "OPTIONS" });
    expect(String(pre.headers.get("access-control-allow-methods"))).toContain("POST");
  });
});

// ── `## Referanser` lists what the model was GIVEN ───────────────────────────

describe("the reference list never names a source the model never saw", () => {
  test("a JIRA_BODY_MAX trim drops the tail from `## Referanser` too", async () => {
    const app = makeApp();
    const wide = Array.from({ length: 24 }, (_, i) => ({
      collection: "jira-issues",
      id: `MELOSYS-${9000 + i}_sak.md`,
      title: `MELOSYS-${9000 + i}_sak`,
      url: `https://jira.adeo.no/browse/MELOSYS-${9000 + i}`,
      relevance: 0.9 - i / 1000,
      viaSubQuestion: ["q"],
      matchedChunks: [{ content: "S".repeat(1_200) }],
    }));
    __setJiraRetrievalForTest(
      (async () => ({
        results: wide,
        decomposition: { subQuestions: ["q"], rationale: "", passthrough: false, haikuMs: 1 },
        subSearches: [{ subQuestion: "q", durationMs: 1, resultCount: wide.length, lowConfidence: false }],
        traceId: "t",
      })) as never,
      scriptedQuestion,
    );

    const events = parseSse(await (await post(app, "/api/jira/draft", {
      notes: "N".repeat(24_000), template: "bug", depth: "full",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const md = String(events.find((e) => e.event === "done")!.data.markdown);
    const refs = md.slice(md.indexOf("## Referanser")).split("\n").filter((l) => l.startsWith("- "));
    // The prompt could not hold all 24, so the reference list must not claim them.
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.length).toBeLessThan(24);
  });
});

// ── A failed row says something a stranger may read ──────────────────────────

describe("the failure written to the row is generic", () => {
  test("a connector exception does not land on a CORS-readable row verbatim", async () => {
    const app = makeApp();
    __setJiraOneShotForTest((async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9130 (/Users/rune/source/private/muninn)");
    }) as never);
    const events = parseSse(await (await post(app, "/api/jira/draft", {
      notes: NOTES, template: "bug", depth: "skisse",
    })).text());
    await new Promise((r) => setTimeout(r, 20));
    const row = rows.get(String(events[0]!.data.draftId))!;
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
    // Ours, a peer's, the bot's ⇒ red. Nobody claimed any of them.
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
});

/**
 * A thread draft is re-run by clicking 🧾 AGAIN, with a steer line.
 *
 * That is the only mechanism: another turn in the same conversation, on its own
 * row. The three composer routes — the SSE `POST /api/jira/draft`, the CORS-open
 * `POST /api/jira/draft/start` and the `PUT` — refuse a thread-sourced draft
 * outright, because the chat's card renders that row's markdown live and there is
 * no longer any UI that could have meant to touch it. TRANSITIONAL: PR 4 deletes
 * all three routes; a stale composer tab can still POST until then.
 */
describe("a thread-sourced draft is refused by the composer routes", () => {
  const REFUSAL = "Utkastet kommer fra en samtale — lag et nytt med 🧾 i chatten.";

  const startThreadDraft = async (over: Record<string, unknown> = {}) => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "assistant", text: "Se MELOSYS-8150." }];
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse", ...over }),
    });
    const draftId = (await res.json()).draftId as string;
    await new Promise((r) => setTimeout(r, 40));
    return draftId;
  };

  test("POST /api/jira/draft is a 400 — no turn runs and the markdown is untouched", async () => {
    const draftId = await startThreadDraft();
    const before = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    threadTurns = [];

    const res = await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(REFUSAL);
    // Not an SSE 200 carrying an app_error, and not a turn written into a chat.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(threadTurns).toHaveLength(0);

    const after = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(after.markdown).toBe(before.markdown);
    expect(after.status).toBe("ready");
  });

  test("POST /api/jira/draft/start refuses identically — it is the CORS-open one", async () => {
    const draftId = await startThreadDraft();
    const before = rows.size;
    threadTurns = [];

    const res = await makeApp().request("/api/jira/draft/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(REFUSAL);
    // No second row, and nothing written into the conversation.
    expect(rows.size).toBe(before);
    await new Promise((r) => setTimeout(r, 40));
    expect(threadTurns).toHaveLength(0);
  });

  test("PUT is a 400 too — a stale tab must not overwrite the text under a live card", async () => {
    const draftId = await startThreadDraft();
    const before = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();

    const res = await makeApp().request(`/api/jira/draft/${draftId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "## Symptom\nNoe helt annet." }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(REFUSAL);

    const after = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(after.markdown).toBe(before.markdown);
  });

  test("a thread row whose thread_id is NULL is refused too — the guard is the SOURCE", async () => {
    // The POST's guard used to be `source === "thread" && threadId`, the PUT's
    // `source === "thread"` alone. A row can carry the source without the id —
    // nothing enforces the pair, and a deleted/nulled `thread_id` is exactly the
    // shape that slipped past BOTH POSTs into the notes branch, where the
    // `fra samtale: <navn>` placeholder is posted as the reader's raw material.
    // That is the whole thing the refusal exists to prevent, so both guards ask
    // the same question.
    const draftId = await startThreadDraft();
    const before = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    rows.get(draftId)!.threadId = null;
    threadTurns = [];

    const res = await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(REFUSAL);
    expect(threadTurns).toHaveLength(0);

    const start = await makeApp().request("/api/jira/draft/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });
    expect(start.status).toBe(400);

    // …and the markdown a live card is rendering is untouched by either.
    await new Promise((r) => setTimeout(r, 40));
    const after = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(after.markdown).toBe(before.markdown);
    expect(after.status).toBe("ready");
  });

  test("the refusal leaks no single-flight slot — the thread is immediately usable", async () => {
    const draftId = await startThreadDraft();
    await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });

    // The claim is refused BEFORE `acquireJiraFlight`, so the thread's own key is
    // free — a refusal that wedged it would have cost the reader the slot lifetime.
    const again = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    expect(again.status).toBe(200);
    await new Promise((r) => setTimeout(r, 40));
  });

  test("a NOTES-sourced draftId is unaffected — the guard fires on thread rows only", async () => {
    const first = await post(makeApp(), "/api/jira/draft", { notes: NOTES, template: "bug", depth: "skisse" });
    const draftId = parseSse(await first.text()).find((e) => e.event === "draft")!.data.draftId as string;

    const res = await post(makeApp(), "/api/jira/draft", { template: "bug", depth: "skisse", draftId });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.at(-1)!.event).toBe("end");
    expect(events.some((e) => e.event === "done")).toBe(true);
  });

  /**
   * The named acceptance: regenerating IS a second 🧾 click with a steer.
   *
   * It produces a second TURN and a second ROW, and the first draft's markdown is
   * left exactly as it was — which is what makes the archive an archive.
   */
  test("a second 🧾 with a steer is a second turn and a second row; the first is untouched", async () => {
    const firstId = await startThreadDraft();
    const first = await (await makeApp().request(`/api/jira/draft/${firstId}`)).json();
    expect(threadTurns).toHaveLength(1);
    expect(threadTurns[0]!.text).toBe("Lag Jira-sak (bug, skisse).");

    __setJiraThreadTurnForTest(
      scriptedThreadTurn("## Symptom\nKortere.", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"),
    );
    const secondId = await startThreadDraft({ extra: "kortere, og uten MELOSYS-1234" });

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
