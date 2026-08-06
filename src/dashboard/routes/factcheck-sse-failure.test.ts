/**
 * Acceptance for the fact-check claim FAILURE path — the two things the server
 * used to throw away when a claim died:
 *
 *   1. **which** failure it was. Every connector's timeout says `timed out after
 *      <n>ms`, and the route hardcoded `outcome: "timeout"` for a timeout AND a
 *      crash alike, under one undistinguished "Verification timed out or failed"
 *      block. The client has rendered ⏱️/⚠️ apart all along (and the empty-result
 *      branch already reached ⚠️), so the fix is server-side only: a crash must
 *      stop arriving under the timeout label with a budget nothing measured.
 *   2. **the tool spans**. `attachToolSpans` runs on the success path only, so the
 *      one claim you most want to inspect on `/traces` was the one with zero
 *      children (reference trace 994e1b3e — `claude:claim-1`, 0 children, siblings
 *      5–6). The catch now rebuilds them from the progress events it saw.
 *
 * Driven through the REAL `streamFactcheckSSE` (a Hono app, an actual SSE
 * response, the actual `Tracer`), with exactly two seams faked: the injected
 * `oneShot` (the new `FactcheckSseOptions` test seam — shortening
 * `FACTCHECK_CLAIM_TIMEOUT_MS` would force nothing, since the budget is enforced
 * INSIDE each connector) and the Phase-1 extraction Haiku.
 *
 * Assertions are on the SPAN ROWS reaching `db/traces.saveSpan`, deliberately not
 * on the waterfall UI: `addChildSpan` writes the schema-default `ok` status and
 * `span-label.ts` renders no `unterminated` chip, so a UI-shaped assertion would
 * test nothing that exists.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains, like `data-routes-bot-scope.test.ts` and `src/profile/`) — and it MUST
 * stay that way. `mock.module` invalidates the target module for the whole process
 * graph, and `db/traces.ts` + `ai/haiku-direct.ts` are transitively imported by a
 * large share of the suite. Spreading the real modules below does NOT prevent that;
 * process isolation is the only thing that does.
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

interface RecordedSpan {
  id: string;
  parentId: string | null;
  name: string;
  attributes?: Record<string, unknown>;
}

const spans: RecordedSpan[] = [];

const realTraces = await import("../../db/traces.ts");
mock.module("../../db/traces.ts", () => ({
  ...realTraces,
  saveSpan: async (p: RecordedSpan) => {
    spans.push({ id: p.id, parentId: p.parentId ?? null, name: p.name, attributes: p.attributes });
  },
  updateSpan: async () => {},
}));

const realHaiku = await import("../../ai/haiku-direct.ts");
mock.module("../../ai/haiku-direct.ts", () => ({
  ...realHaiku,
  // Phase 1: one claim, so the run takes the single-claim path (no compose).
  callHaikuWithFallback: async () => ({
    result: JSON.stringify({ claims: [{ title: "The sky is blue", quote: "the sky is blue" }] }),
    inputTokens: 10,
    outputTokens: 5,
    numTurns: 1,
    model: "claude-haiku-4-5",
    backend: "cli",
  }),
}));

const { streamFactcheckSSE } = await import("./factcheck-sse.ts");
const { FACTCHECK_CLAIM_TIMEOUT_MS } = await import("./factcheck-sse.ts");

type SseEvent = { event: string; data: Record<string, unknown> };

/** Parse the raw SSE body into `{event, data}` pairs (heartbeats have no client
 *  listener and none fire inside these sub-second runs). */
function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (!ev || data === undefined) continue;
    try {
      out.push({ event: ev, data: JSON.parse(data) });
    } catch {
      out.push({ event: ev, data: {} });
    }
  }
  return out;
}

const config = {
  tracingEnabled: true,
  tracingCaptureToolOutputs: false,
  claudeModel: "sonnet",
} as never;

const botConfig = { name: "testbot", dir: "/tmp/testbot", connector: "claude-sdk" } as never;

/**
 * A fake `executeOneShot` that plays a scripted tool sequence through the route's
 * own `onProgress` and then rejects: two starts and ONE end, so the unpaired start
 * ("WebSearch") is the tool still in flight when the claim died.
 */
function scriptedFailure(message: string) {
  return async (
    _prompt: string,
    _config: unknown,
    _bot: unknown,
    opts?: { onProgress?: (e: never) => void },
  ): Promise<never> => {
    const emit = (e: unknown) => opts?.onProgress?.(e as never);
    emit({ type: "tool_start", id: "t1", name: "WebFetch", displayName: "WebFetch", input: '{"url":"https://example.com"}' });
    await new Promise((r) => setTimeout(r, 12));
    emit({ type: "tool_end", id: "t1", name: "WebFetch", displayName: "WebFetch", outputSize: 42 });
    emit({ type: "tool_start", id: "t2", name: "WebSearch", displayName: "WebSearch", input: '{"query":"sky colour"}' });
    await new Promise((r) => setTimeout(r, 12));
    throw new Error(message);
  };
}

async function runFactcheckWith(message: string): Promise<{ events: SseEvent[]; spans: RecordedSpan[] }> {
  spans.length = 0;
  const app = new Hono();
  app.get("/fc", (c) =>
    streamFactcheckSSE(c, {
      config,
      botConfig,
      body: "The sky is blue. Water is wet.",
      meta: { title: "Sky", tags: [], type: "concept" },
      wikiName: "testwiki",
      mode: "article",
      baseHash: "deadbeef",
      oneShot: scriptedFailure(message) as never,
    }),
  );
  const res = await app.request("/fc");
  const events = parseSse(await res.text());
  // Span writes are fire-and-forget promises; let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 20));
  return { events, spans: [...spans] };
}

const TIMEOUT_MESSAGE = "Claude Agent SDK timed out after 90000ms";
const ERROR_MESSAGE = "OpenAI-compat API error 500: upstream exploded";
/**
 * A CLI crash passed through verbatim by `ai/executor.ts`
 * (`Claude exited with code <n>: <stderr>`), where the stderr an upstream wrote
 * happens to carry a timeout phrase and a budget of its own. The process died;
 * the per-claim budget did not expire.
 */
const CRASH_MESSAGE =
  "Claude exited with code 1: node:internal/errors: FetchError: request to " +
  "https://api.example.com/v1 failed, upstream timed out after 30000ms\n" +
  "    at ClientRequest.<anonymous> (/app/node_modules/node-fetch/index.js:1491:11)";

let timeoutRun: Awaited<ReturnType<typeof runFactcheckWith>>;
let errorRun: Awaited<ReturnType<typeof runFactcheckWith>>;
let crashRun: Awaited<ReturnType<typeof runFactcheckWith>>;

beforeEach(async () => {
  if (!timeoutRun) timeoutRun = await runFactcheckWith(TIMEOUT_MESSAGE);
  if (!errorRun) errorRun = await runFactcheckWith(ERROR_MESSAGE);
  if (!crashRun) crashRun = await runFactcheckWith(CRASH_MESSAGE);
});

const claimResult = (r: { events: SseEvent[] }) =>
  r.events.find((e) => e.event === "claim_result")!.data;

describe("failed claim — cause-specific outcome + block", () => {
  test("a connector timeout yields outcome 'timeout' and names the budget in seconds", () => {
    const cr = claimResult(timeoutRun);
    expect(cr.outcome).toBe("timeout");
    // The figure must be the one the MESSAGE named, not the current constant — a
    // constant bump must not make an older or foreign caller's reason lie. Pinned
    // against the constant so the two can never quietly become the same number.
    expect(cr.markdown).toContain("Verification timed out after 90s — the claim was not checked.");
    expect(String(cr.markdown)).not.toContain(`${Math.round(FACTCHECK_CLAIM_TIMEOUT_MS / 1000)}s`);
  });

  test("a non-timeout connector error yields outcome 'error' and quotes the reason", () => {
    const cr = claimResult(errorRun);
    expect(cr.outcome).toBe("error");
    expect(cr.markdown).toContain("Verification failed: OpenAI-compat API error 500: upstream exploded.");
  });

  test("a CLI crash whose stderr says 'timed out after' is an error, not a ⏱️ timeout", () => {
    const cr = claimResult(crashRun);
    expect(cr.outcome).toBe("error");
    expect(String(cr.markdown)).toContain("Verification failed:");
    // The crashed claim must never claim a budget: neither the upstream's 30s nor
    // this route's own constant is a budget that expired here.
    expect(String(cr.markdown)).not.toContain("timed out after 30s");
    expect(String(cr.markdown)).not.toContain(`${Math.round(FACTCHECK_CLAIM_TIMEOUT_MS / 1000)}s`);
  });

  test("the two blocks are distinguishable, and both keep the ❓ verdict vocabulary", () => {
    const a = String(claimResult(timeoutRun).markdown);
    const b = String(claimResult(errorRun).markdown);
    expect(a).not.toBe(b);
    // The verdict emoji is a PARSED contract (verdictOf / correctableClaims);
    // only the reason prose changed.
    expect(a.startsWith("### ❓ Claim 1/1 — The sky is blue")).toBe(true);
    expect(b.startsWith("### ❓ Claim 1/1 — The sky is blue")).toBe(true);
    expect(claimResult(timeoutRun).verdict).toBe("❓");
    expect(claimResult(errorRun).verdict).toBe("❓");
  });

  test("the run still completes cleanly (done + end), never an app_error", () => {
    const names = timeoutRun.events.map((e) => e.event);
    expect(names).toContain("done");
    expect(names[names.length - 1]).toBe("end");
    expect(names).not.toContain("app_error");
    // A synthetic block is excluded from the real-claim count.
    expect(timeoutRun.events.find((e) => e.event === "done")!.data.claimCount).toBe(0);
  });
});

describe("failed claim — rebuilt tool child spans", () => {
  const claimChildren = (r: { spans: RecordedSpan[] }) => {
    const claim = r.spans.find((s) => s.name === "claude:claim-0");
    expect(claim).toBeDefined();
    return r.spans.filter((s) => s.parentId === claim!.id);
  };

  test("the timed-out claim's span carries BOTH tool children, including the unterminated one", () => {
    const kids = claimChildren(timeoutRun);
    expect(kids.map((s) => s.name).sort()).toEqual(["WebFetch", "WebSearch"]);
  });

  test("the still-in-flight tool is flagged unterminated; the completed one is not", () => {
    const kids = claimChildren(timeoutRun);
    const hung = kids.find((s) => s.name === "WebSearch")!;
    const done = kids.find((s) => s.name === "WebFetch")!;
    expect(hung.attributes?.unterminated).toBe(true);
    expect(done.attributes?.unterminated).toBeUndefined();
    // Rebuilt spans keep the same attribute shape attachToolSpans writes on the
    // success path (toolId / toolName / input), so the tool-detail panel reads them.
    expect(hung.attributes?.toolId).toBe("t2");
    expect(hung.attributes?.toolName).toBe("WebSearch");
    expect(hung.attributes?.input).toBe('{"query":"sky colour"}');
  });

  test("the non-timeout failure path attaches its tool spans too", () => {
    expect(claimChildren(errorRun).map((s) => s.name).sort()).toEqual(["WebFetch", "WebSearch"]);
  });
});
