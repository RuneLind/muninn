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
  coverage: string | null;
  retrievalQuestion: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
const rows = new Map<string, Row>();
/** Reads that must FAIL, keyed by draft id — the "huginn is fine, postgres is not" case. */
const readThrows = new Map<string, string>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
mock.module("../../db/jira-drafts.ts", () => ({
  createJiraDraft: async (i: { botName: string; template: string; depth: string; notes: string; extra: string }) => {
    const id = crypto.randomUUID();
    rows.set(id, {
      draftId: id, status: "generating", template: i.template, depth: i.depth, notes: i.notes,
      extra: i.extra, markdown: null, citations: [], excludeDocIds: [], keyVerdicts: [], markdownFlags: [],
      coverage: null, retrievalQuestion: "", error: null, createdAt: Date.now(), updatedAt: Date.now(),
    });
    return id;
  },
  startJiraDraftRun: async (id: string, excludeDocIds: string[]) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { status: "generating", error: null, excludeDocIds });
  },
  saveJiraDraftCoverage: async (id: string, coverage: string) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { coverage });
  },
  saveJiraDraftRetrieval: async (id: string, citations: unknown[], coverage: string, q: string) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { citations, coverage, retrievalQuestion: q });
  },
  finishJiraDraft: async (id: string, i: { markdown: string; keyVerdicts: unknown[]; markdownFlags: unknown[] }) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { ...i, status: "ready", error: null });
  },
  failJiraDraft: async (id: string, error: string) => {
    const r = rows.get(id);
    if (r) Object.assign(r, { status: "failed", error });
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
    return rows.get(id) ?? null;
  },
}));

const {
  registerJiraRoutes,
  __setJiraOneShotForTest,
  __setJiraRetrievalForTest,
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

beforeEach(() => {
  __resetJiraFlightsForTest();
  __resetJiraKeyIndexForTest();
  rows.clear();
  readThrows.clear();
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
    expect((await res.json()).error).toBe("notes must be a string");
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
      "citations", "coverage", "draftId", "keyVerdicts", "markdown", "markdownFlags", "retrievalQuestion",
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

  test("the slot outlives the run's teardown by exactly the slack", () => {
    // Sized to exactly the budget, a slot frees itself while its holder is still
    // tearing down and a click on that boundary starts a concurrent run. The
    // previous spelling compared two BUDGETS and said nothing about the slack.
    const key = jiraFlightKey("n", "bug", "skisse", [], "");
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
    expect(rows.get(draftId)!.coverage).toBeNull();

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
    expect(rows.get(draftId)!.coverage).toBe("answer");

    const events = parseSse(await (await post(app, "/api/jira/draft", {
      template: "bug", depth: "skisse", draftId,
      excludeDocIds: ["MELOSYS-5677_Ny_flyt.md", "MELOSYS-8028_Manglende.md", "faktura.md"],
    })).text());
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.event === "done")!.data.coverage).toBe("no_hits");
    expect(rows.get(draftId)!.coverage).toBe("no_hits");
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
