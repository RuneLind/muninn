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
  createdAt: number;
  updatedAt: number;
}
const rows = new Map<string, Row>();
/** Reads that must FAIL, keyed by draft id — the "huginn is fine, postgres is not" case. */
const readThrows = new Map<string, string>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
mock.module("../../db/jira-drafts.ts", () => ({
  createJiraDraft: async (i: {
    botName: string; template: string; depth: string; notes: string; extra: string;
    source?: string; threadId?: string;
  }) => {
    const id = crypto.randomUUID();
    rows.set(id, {
      draftId: id, status: "generating", template: i.template, depth: i.depth, notes: i.notes,
      extra: i.extra, markdown: null, citations: [], excludeDocIds: [], keyVerdicts: [], markdownFlags: [],
      retrievalCoverage: null, retrievalQuestion: "", error: null,
      source: i.source ?? "notes", threadId: i.threadId ?? null,
      // The real read LEFT-JOINs `threads`; the mock resolves the same way.
      threadName: i.threadId ? (threads.get(i.threadId)?.name ?? null) : null,
      messageId: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return id;
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
    // The view's `coverage` is DERIVED (see `effectiveCoverage`); only the SQL is
    // faked here, so the mock runs the real helper rather than a second rule that
    // could quietly disagree with the column the route actually reads.
    const excluded = new Set(r.excludeDocIds);
    const retained = (r.citations as { docId: string }[]).filter((c) => !excluded.has(c.docId)).length;
    return {
      ...r,
      coverage: r.retrievalCoverage === null && r.citations.length === 0
        ? null
        : effectiveCoverage(r.retrievalCoverage as never, retained),
    };
  },
}));

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
const { effectiveCoverage } = await import("../../jira/wire.ts");
const { buildDepthFence } = await import("../../jira/tool-fence.ts");

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
 * registers `/plans` beside `/api/plans/*`. The assertion that matters is that
 * the route exists and serves the shell the bundle mounts into — a page whose
 * three column ids drifted would render blank with no error anywhere.
 */
describe("GET /jira", () => {
  test("serves the composer shell, the nav and the client bundle", async () => {
    const res = await makeApp().request("/jira");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const id of ["jcRoot", "jcLeft", "jcMid", "jcRight"]) {
      expect(html).toContain(`id="${id}"`);
    }
    // The nav entry lives in the Tools dropdown, not the top-level row.
    expect(html).toContain('<a href="/jira" class="nav-dropdown-item active">Jira</a>');
    // The bundle is inlined, not linked — there is no static asset route.
    expect(html).toContain("/api/jira/templates");
  });

  test("the page does not depend on a bot being configured", async () => {
    // The picker resolves client-side against `/api/jira/templates`, which
    // answers the 503. A no-bot install must still render a page that SAYS so
    // rather than 500ing on the way in.
    discovered = [];
    const res = await makeApp().request("/jira");
    expect(res.status).toBe(200);
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
    const { body } = await started();
    threads.set(THREAD_ID, THREAD);
    // MELOSYS-7264 appears in the user's own message and in nothing retrieved.
    // Passing the `fra samtale: …` placeholder as the notes would have called it
    // a fabrication; the conversation's user messages are the raw material here.
    const res = await makeApp().request(`/api/jira/draft/${body.draftId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "## Symptom\nSe MELOSYS-7264 og MELOSYS-8150." }),
    });
    expect(res.status).toBe(200);
    // (The PUT path re-verifies against the retained set; the generated draft's
    // own verdicts are asserted through the turn text below.)
    const view = await (await makeApp().request(`/api/jira/draft/${body.draftId}`)).json();
    expect(view.keyVerdicts.find((v: { key: string }) => v.key === "MELOSYS-8150").state).toBe("verified");
    // …and the PUT reads the SAME raw material the generation did. Handing it the
    // stored `fra samtale: …` placeholder instead flipped every amber row red the
    // moment the reader saved — an edit that never touched the key.
    expect(view.keyVerdicts.find((v: { key: string }) => v.key === "MELOSYS-7264").state).toBe("notes");
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

describe("regenerate on a thread-sourced draft", () => {
  const startThreadDraft = async () => {
    threads.set(THREAD_ID, THREAD);
    threadCitations = THREAD_CITATIONS;
    threadHistory = [{ role: "assistant", text: "Se MELOSYS-8150." }];
    const res = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "bug", depth: "skisse" }),
    });
    const draftId = (await res.json()).draftId as string;
    await new Promise((r) => setTimeout(r, 40));
    return draftId;
  };

  test("runs ANOTHER TURN in the thread — never the one-shot over stored hits", async () => {
    const draftId = await startThreadDraft();
    threadTurns = [];
    const before = retrievals.n;
    __setJiraThreadTurnForTest(scriptedThreadTurn("## Symptom\nKortere.", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"));

    const res = await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftId,
        template: "bug",
        depth: "skisse",
        excludeDocIds: ["Team MELOSYS/rammeavtale.md"],
      }),
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.at(-1)!.event).toBe("end");

    // A turn ran, and it named the exclusion as prose the next prompt can read.
    expect(threadTurns).toHaveLength(1);
    expect(threadTurns[0]!.text).toContain("Lag Jira-sak på nytt (bug, skisse).");
    expect(threadTurns[0]!.text).toContain("Rammeavtalen for hjemmekontor");
    // And no retrieval was spent: this path has none.
    expect(retrievals.n).toBe(before);

    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.markdown).toContain("Kortere.");
    // The row is RE-POINTED at the new turn's message.
    expect(view.messageId).toBe("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    // The excluded source is gone from this run's citations, but the stored hit
    // set still carries it so the reader can switch it back on.
    expect(view.excludeDocIds).toEqual(["Team MELOSYS/rammeavtale.md"]);
    expect(view.citations.map((c: { docId: string }) => c.docId)).toContain("Team MELOSYS/rammeavtale.md");
    expect(view.markdown).not.toContain("confluence.test/rammeavtale");
  });

  test("a regenerate through /draft/start reuses THAT row — it never orphans a second one", async () => {
    const draftId = await startThreadDraft();
    const before = rows.size;
    threadTurns = [];
    __setJiraThreadTurnForTest(scriptedThreadTurn("## Symptom\nKortere.", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"));

    // The page's own regenerate goes over `/draft/start` (fire-and-forget, then
    // poll). Without `existingDraftId` on the thread branch the route created a
    // SECOND, `notes`-sourced row with empty notes and handed the caller ITS id,
    // while the turn ran against the thread row — so the poller sat on a row
    // nothing would ever finish, to the 13-minute cap.
    const res = await makeApp().request("/api/jira/draft/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).draftId).toBe(draftId);
    expect(rows.size).toBe(before);

    await new Promise((r) => setTimeout(r, 60));
    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.status).toBe("ready");
    expect(view.markdown).toContain("Kortere.");
    expect(threadTurns).toHaveLength(1);
  });

  test("emits NO `citations` frame — the client would adopt the narrow set", async () => {
    const draftId = await startThreadDraft();
    __setJiraThreadTurnForTest(scriptedThreadTurn("## Symptom\nKortere. Se MELOSYS-8150."));

    const events = parseSse(await (await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftId, template: "bug", depth: "skisse",
        excludeDocIds: ["Team MELOSYS/rammeavtale.md"],
      }),
    })).text());

    // Rule 1 of the page (src/dashboard/CLAUDE.md): the middle column renders the
    // WIDE stored set. The notes path emits no `citations` on a regenerate for
    // exactly this reason; this path emitted the RETAINED, renumbered set, and
    // the client overwrites `state.citations` with any non-empty array — so the
    // row the reader had just switched off vanished from the toggle column and
    // could never be switched back on.
    expect(events.map((e) => e.event)).not.toContain("citations");
    // The wide set is still on the row, which is what the poll and the GET carry.
    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.citations).toHaveLength(2);
  });

  test("a from-thread POST during a regenerate of the same thread is a 409", async () => {
    const draftId = await startThreadDraft();
    let release: ((v: unknown) => void) | undefined;
    __setJiraThreadTurnForTest((() => new Promise((r) => { release = r; })) as never);

    // The regenerate claims the slot…
    const regen = makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    });
    await new Promise((r) => setTimeout(r, 20));

    // …and a fresh from-thread run in the SAME thread must not start a second,
    // interleaved turn. Measured before the fix: two user lines 17 ms apart.
    const clash = await makeApp().request("/api/jira/draft/from-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: THREAD_ID, template: "story", depth: "ingen" }),
    });
    expect(clash.status).toBe(409);

    release!({ messageId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", text: "## Symptom\nx" });
    await (await regen).text();
  });

  test("the regenerate's own user line is not raw material, and a peer's message never was", async () => {
    const draftId = await startThreadDraft();
    // The regenerate ran and excluded MELOSYS-8150, so its visible user line NAMES
    // the key — and a `peer` turn named another. Neither is the person's raw
    // material: one is this feature's own instruction to leave the source out, the
    // other is a different agent talking.
    await (await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftId, template: "bug", depth: "skisse",
        excludeDocIds: ["MELOSYS-8150_Uttrekk.md"],
      }),
    })).text();
    threadHistory = [
      { role: "user", text: "Uttrekket feiler for EØS-saker." },
      { role: "user", text: "Lag Jira-sak på nytt (bug, skisse). Ikke bruk disse kildene denne gangen: MELOSYS-8150." },
      { role: "peer", text: "Se også MELOSYS-9001." },
      { role: "assistant", text: "Ok." },
    ];

    const res = await makeApp().request(`/api/jira/draft/${draftId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "## Symptom\nSe MELOSYS-8150 og MELOSYS-9001." }),
    });
    expect(res.status).toBe(200);
    const { keyVerdicts } = await res.json();
    const state = (k: string) => keyVerdicts.find((v: { key: string }) => v.key === k).state;
    // Both are RED: excluded and never claimed by the person.
    expect(state("MELOSYS-8150")).toBe("unknown");
    expect(state("MELOSYS-9001")).toBe("unknown");
  });

  test("the row goes back to `generating` before the turn — a row left `ready` stops the poller", async () => {
    const draftId = await startThreadDraft();
    let statusDuringTurn: string | undefined;
    __setJiraThreadTurnForTest((async () => {
      statusDuringTurn = (await (await makeApp().request(`/api/jira/draft/${draftId}`)).json()).status;
      return { messageId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", text: "## Symptom\nx" };
    }) as never);

    // The SSE body has to be CONSUMED for the runner to reach its terminal path.
    await (await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse" }),
    })).text();
    expect(statusDuringTurn).toBe("generating");
  });

  test("a failed regenerate restores the exclusion set the surviving markdown was written under", async () => {
    const draftId = await startThreadDraft();
    __setJiraThreadTurnForTest((async () => {
      throw new Error("connector timed out after 120000ms");
    }) as never);

    await (await makeApp().request("/api/jira/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId, template: "bug", depth: "skisse", excludeDocIds: ["MELOSYS-8150_Uttrekk.md"] }),
    })).text();
    const view = await (await makeApp().request(`/api/jira/draft/${draftId}`)).json();
    expect(view.status).toBe("failed");
    expect(view.excludeDocIds).toEqual([]);
    // The generic sentence, never the connector's own text — this is read back
    // through a CORS-open GET.
    expect(view.error).not.toContain("120000ms");
  });
});
