/**
 * Acceptance for the single-claim re-verify endpoint (`GET /api/wiki/factcheck/claim`).
 *
 * Three things are covered here that nothing else can see:
 *
 *   1. **the SSE contract on failure** — a retry that times out, crashes, or comes
 *      back empty emits `app_error` and NO `claim_result`. That absence is the
 *      whole point: a `claim_result` would splice a fresh synthetic ❓ over the
 *      claim the reader clicked ↻ on, rewriting the reason text of a claim nobody
 *      re-verified. A status-only assertion proves none of it (every path is a 200).
 *   2. **the `Sources:` linkification** — a raw retried block goes straight into
 *      the persisted answer, and `web-format.ts` has no bare-URL autolinker, so the
 *      block must arrive already linkified or the URLs render as plain text there,
 *      in `answer_html`, and in any later ➕/integrate write.
 *   3. **the per-page single-flight** — a second GET while one retry holds the page
 *      gets a 409 carrying the holder's DEADLINE (the client's "try again in…" copy
 *      needs it), and an expired holder counts as free.
 *
 * Driven through the REAL `streamFactcheckRetrySSE` (a Hono app, an actual SSE
 * response, the actual `Tracer`) with exactly one seam faked: the injected
 * `oneShot`. The 409 is driven through the REAL route.
 *
 * RUNS IN ITS OWN `bun test` PROCESS (its own `&&` link in the `test`/`test:unit`
 * chains, like `factcheck-sse-failure.test.ts`) — and it MUST stay that way.
 * `mock.module` invalidates the target module for the whole process graph, and
 * `db/traces.ts` is transitively imported by a large share of the suite.
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

const {
  streamFactcheckRetrySSE,
  acquireClaimRetry,
  claimRetryKey,
  retryTimeoutReason,
  __resetClaimRetryFlightsForTest,
  FACTCHECK_RETRY_TIMEOUT_MS,
  CLAIM_INDEX_MAX,
} = await import("./factcheck-retry-sse.ts");
const { registerWikiRoutes } = await import("./wiki-routes.ts");
const { __resetWikiRegistryForTest, __setWikiRegistryForTest } = await import(
  "../../wiki/registry-memo.ts"
);
const { __resetWikiCacheForTest } = await import("../../wiki/store.ts");

type SseEvent = { event: string; data: Record<string, unknown> };

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

/** A fake `executeOneShot` that plays a scripted tool sequence and then resolves. */
function scriptedSuccess(result: string) {
  return async (
    _prompt: string,
    _config: unknown,
    _bot: unknown,
    opts?: { onProgress?: (e: never) => void },
  ) => {
    const emit = (e: unknown) => opts?.onProgress?.(e as never);
    emit({ type: "tool_start", id: "t1", name: "WebFetch", displayName: "WebFetch", input: '{"url":"https://nature.com/x"}' });
    emit({ type: "tool_end", id: "t1", name: "WebFetch", displayName: "WebFetch", outputSize: 12 });
    return {
      result,
      inputTokens: 20,
      outputTokens: 9,
      numTurns: 1,
      model: "claude-sonnet-5",
      durationMs: 5,
      // The connector hands the finished calls back on the success path; the
      // progress events above are only the LIVE channel (and the failure-path
      // fallback).
      toolCalls: [
        {
          id: "t1",
          name: "WebFetch",
          displayName: "WebFetch",
          durationMs: 4,
          startOffsetMs: 0,
          input: '{"url":"https://nature.com/x"}',
        },
      ],
    };
  };
}

/** A fake that plays two tool starts and ONE end, then rejects — the unpaired
 *  start is the tool still in flight when the retry died. */
function scriptedFailure(message: string) {
  return async (
    _prompt: string,
    _config: unknown,
    _bot: unknown,
    opts?: { onProgress?: (e: never) => void },
  ): Promise<never> => {
    const emit = (e: unknown) => opts?.onProgress?.(e as never);
    emit({ type: "tool_start", id: "t1", name: "WebFetch", displayName: "WebFetch", input: '{"url":"https://example.com"}' });
    emit({ type: "tool_end", id: "t1", name: "WebFetch", displayName: "WebFetch", outputSize: 42 });
    emit({ type: "tool_start", id: "t2", name: "WebSearch", displayName: "WebSearch", input: '{"query":"sky"}' });
    throw new Error(message);
  };
}

async function runRetry(
  oneShot: unknown,
  over: Record<string, unknown> = {},
): Promise<{ events: SseEvent[]; spans: RecordedSpan[] }> {
  spans.length = 0;
  const app = new Hono();
  app.get("/fc", (c) =>
    streamFactcheckRetrySSE(c, {
      config,
      botConfig,
      claim: { index: 3, total: 8, title: "The sky is blue", quote: "the sky is blue" },
      meta: { title: "Sky" },
      wikiName: "testwiki",
      mode: "article",
      oneShot: oneShot as never,
      ...over,
    } as never),
  );
  const res = await app.request("/fc");
  const events = parseSse(await res.text());
  // Span writes are fire-and-forget promises; let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 20));
  return { events, spans: [...spans] };
}

const VERDICT_BLOCK = [
  "### ✅ Claim 3/8 — The sky is blue",
  "",
  "Rayleigh scattering makes the daytime sky appear blue.",
  "",
  "Confidence: 92/100",
  "",
  "Sources: https://www.nature.com/articles/x, [who.int](https://www.who.int/a_(b))",
].join("\n");

describe("claim retry — the success path", () => {
  let run: Awaited<ReturnType<typeof runRetry>>;
  beforeEach(async () => {
    if (!run) run = await runRetry(scriptedSuccess(VERDICT_BLOCK));
  });

  test("emits exactly one claim_result, then done, then the terminal end", () => {
    const names = run.events.map((e) => e.event).filter((n) => n !== "heartbeat");
    expect(names.filter((n) => n === "claim_result")).toHaveLength(1);
    expect(names).not.toContain("app_error");
    expect(names.indexOf("done")).toBeGreaterThan(names.indexOf("claim_result"));
    expect(names[names.length - 1]).toBe("end");
  });

  test("the claim_result carries the ORIGINAL 1-based index, verdict and confidence", () => {
    const cr = run.events.find((e) => e.event === "claim_result")!.data;
    expect(cr.index).toBe(3);
    expect(cr.verdict).toBe("✅");
    expect(cr.outcome).toBe("verified");
    expect(cr.confidence).toBe(92);
  });

  test("the returned block's Sources: line comes back already linkified", () => {
    const md = String(run.events.find((e) => e.event === "claim_result")!.data.markdown);
    // The bare URL was wrapped host-first…
    expect(md).toContain("[nature.com](https://www.nature.com/articles/x)");
    // …and the existing markdown link's literal parens are percent-encoded, so the
    // shared web-format parser doesn't stop the href at the first `)`.
    expect(md).toContain("[who.int](https://www.who.int/a_%28b%29)");
    expect(md).not.toContain("Sources: https://");
  });

  test("tool progress is forwarded as `tool` events stamped with the claim index", () => {
    const tools = run.events.filter((e) => e.event === "tool");
    expect(tools.map((t) => t.data.state)).toEqual(["start", "end"]);
    expect(tools[0]!.data.claimIndex).toBe(3);
    expect(tools[0]!.data.name).toBe("WebFetch");
  });

  test("the run is traced under a 1-BASED `claude:claim-retry-<n>` span with tool children", () => {
    const span = run.spans.find((s) => s.name === "claude:claim-retry-3");
    expect(span).toBeDefined();
    // 1-based to match the `Claim n/m` heading contract the client retries against
    // — the in-run fan-out's `claude:claim-<i>` labels are 0-based on purpose.
    expect(run.spans.some((s) => s.name === "claude:claim-retry-2")).toBe(false);
    expect(run.spans.filter((s) => s.parentId === span!.id).map((s) => s.name)).toEqual(["WebFetch"]);
    expect(run.spans.some((s) => s.name === "factcheck-retry")).toBe(true);
  });
});

describe("claim retry — a failed retry changes nothing", () => {
  test("a connector timeout emits app_error and NO claim_result", async () => {
    const run = await runRetry(scriptedFailure("Claude Agent SDK timed out after 180000ms"));
    const names = run.events.map((e) => e.event);
    expect(names).not.toContain("claim_result");
    expect(names).toContain("app_error");
    expect(names[names.length - 1]).toBe("end");
    const msg = String(run.events.find((e) => e.event === "app_error")!.data.message);
    // The figure is the one the MESSAGE named, never a constant standing in for it.
    expect(msg).toContain("timed out after 180s");
    expect(msg).toContain("not re-verified");
  });

  test("a crash is reported as a failure, not as a timeout with a budget nothing set", async () => {
    const run = await runRetry(
      scriptedFailure("Claude exited with code 1: upstream timed out after 30000ms"),
    );
    const msg = String(run.events.find((e) => e.event === "app_error")!.data.message);
    expect(msg).toContain("Verification failed:");
    expect(msg).not.toContain("timed out after 30s");
    expect(run.events.map((e) => e.event)).not.toContain("claim_result");
  });

  test("an EMPTY result is a failed retry, not an unverifiable claim", async () => {
    const run = await runRetry(scriptedSuccess("   "));
    const names = run.events.map((e) => e.event);
    expect(names).not.toContain("claim_result");
    expect(String(run.events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "no verdict",
    );
  });

  test("the failed run's span still gets its tool children, including the unterminated one", async () => {
    const run = await runRetry(scriptedFailure("Claude Agent SDK timed out after 180000ms"));
    const span = run.spans.find((s) => s.name === "claude:claim-retry-3")!;
    const kids = run.spans.filter((s) => s.parentId === span.id);
    expect(kids.map((s) => s.name).sort()).toEqual(["WebFetch", "WebSearch"]);
    expect(kids.find((s) => s.name === "WebSearch")!.attributes?.unterminated).toBe(true);
  });

  test("a preflight error is an app_error with no model call and no claim_result", async () => {
    let called = false;
    const run = await runRetry(
      async () => {
        called = true;
        return {} as never;
      },
      { preflightError: "wiki directory not found" },
    );
    expect(called).toBe(false);
    expect(run.events.map((e) => e.event)).not.toContain("claim_result");
    expect(run.events.find((e) => e.event === "app_error")!.data.message).toBe(
      "wiki directory not found",
    );
  });

  test("a bot-less wiki is refused by the scaffold, not reported as a connector fault", async () => {
    const run = await runRetry(scriptedSuccess(VERDICT_BLOCK), { botConfig: null });
    expect(String(run.events.find((e) => e.event === "app_error")!.data.message)).toContain(
      "No bots configured",
    );
  });
});

describe("retryTimeoutReason", () => {
  test("names the budget the MESSAGE carried", () => {
    expect(retryTimeoutReason({ ms: 180_000 })).toContain("after 180s");
  });

  test("a message that named no plausible budget gets figure-free prose", () => {
    // Deliberately NOT the fan-out's 110s constant: this call ran against
    // FACTCHECK_RETRY_TIMEOUT_MS, so borrowing that helper's fallback would lie.
    const prose = retryTimeoutReason({ ms: null });
    expect(prose).not.toMatch(/\d+s/);
    expect(prose).toContain("not re-verified");
  });
});

describe("per-page single-flight registry", () => {
  beforeEach(() => __resetClaimRetryFlightsForTest());

  test("the second acquire for the same page is refused with the holder's deadline", () => {
    const key = claimRetryKey("mimir", "plans/x.mdx");
    const first = acquireClaimRetry(key, 1_000);
    expect(first.ok).toBe(true);
    const second = acquireClaimRetry(key, 2_000);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.expiresAtMs).toBe(1_000 + FACTCHECK_RETRY_TIMEOUT_MS);
  });

  test("another page (and another wiki holding the same relPath) is unaffected", () => {
    acquireClaimRetry(claimRetryKey("mimir", "plans/x.mdx"), 1_000);
    expect(acquireClaimRetry(claimRetryKey("mimir", "plans/y.mdx"), 1_000).ok).toBe(true);
    expect(acquireClaimRetry(claimRetryKey("jarvis", "plans/x.mdx"), 1_000).ok).toBe(true);
  });

  test("an EXPIRED holder counts as free — a wedged slot heals without a sweeper", () => {
    const key = claimRetryKey("mimir", "plans/x.mdx");
    acquireClaimRetry(key, 1_000);
    const atExpiry = 1_000 + FACTCHECK_RETRY_TIMEOUT_MS;
    expect(acquireClaimRetry(key, atExpiry - 1).ok).toBe(false);
    expect(acquireClaimRetry(key, atExpiry).ok).toBe(true);
  });

  test("release is identity-checked — a late release can't free a NEWER holder", () => {
    const key = claimRetryKey("mimir", "plans/x.mdx");
    const stale = acquireClaimRetry(key, 1_000);
    if (!stale.ok) throw new Error("unreachable");
    // The stale run's entry expires and the slot is re-taken by a new run…
    const fresh = acquireClaimRetry(key, 1_000 + FACTCHECK_RETRY_TIMEOUT_MS);
    expect(fresh.ok).toBe(true);
    // …and only THEN does the stale run's `finally` fire.
    stale.release();
    expect(acquireClaimRetry(key, 1_000 + FACTCHECK_RETRY_TIMEOUT_MS).ok).toBe(false);
  });

  test("the SSE run releases its slot on EVERY terminal path (success and failure)", async () => {
    const key = claimRetryKey("testwiki", "Sky.md");
    for (const oneShot of [scriptedSuccess(VERDICT_BLOCK), scriptedFailure("boom")]) {
      __resetClaimRetryFlightsForTest();
      const acquired = acquireClaimRetry(key);
      if (!acquired.ok) throw new Error("unreachable");
      await runRetry(oneShot, { onSettled: acquired.release });
      // Free again ⇒ the scaffold's `finally` ran the release.
      expect(acquireClaimRetry(key).ok).toBe(true);
    }
  });
});

/**
 * The REAL route. Pinning the standalone wiki's synthesis bot to the checked-in
 * `jarvis` (claude-sdk) keeps the web-tools preflight deterministic in CI and on a
 * dev machine alike. Nothing here spends a model call: the 409 and every 400
 * return before the stream is opened.
 */
describe("GET /api/wiki/factcheck/claim — route guards", () => {
  let root: string;
  let app: Hono;
  const PAGE = "A Concept";
  const OK_QS = `wiki=retrywiki&page=${encodeURIComponent(PAGE)}&mode=article&index=2&total=5&title=Some%20claim`;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-fcretry-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\n---\n\nBody.");
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __setWikiRegistryForTest([{ name: "retrywiki", root, source: "extra", synthesisBot: "jarvis" }]);
    __resetClaimRetryFlightsForTest();
    app = new Hono();
    registerWikiRoutes(app, config);
  });

  afterEach(async () => {
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetClaimRetryFlightsForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("a second request while one is in flight 409s with {state, expiresAtMs}", async () => {
    // Hold the page exactly as an in-flight retry would.
    const held = acquireClaimRetry(claimRetryKey("retrywiki", "A Concept.md"));
    expect(held.ok).toBe(true);
    const res = await app.request(`/api/wiki/factcheck/claim?${OK_QS}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state: string; expiresAtMs: number };
    expect(body.state).toBe("running");
    expect(body.expiresAtMs).toBeGreaterThan(Date.now());
  });

  test("missing page / title 400 before anything is claimed", async () => {
    expect((await app.request("/api/wiki/factcheck/claim?wiki=retrywiki&mode=article")).status).toBe(400);
    const noTitle = await app.request(
      `/api/wiki/factcheck/claim?wiki=retrywiki&mode=article&page=${encodeURIComponent(PAGE)}&index=1&total=1`,
    );
    expect(noTitle.status).toBe(400);
  });

  test("index/total must be small positive integers with index ≤ total", async () => {
    const bad = [
      "index=0&total=5",
      "index=2&total=1",
      "index=1.5&total=5",
      "index=abc&total=5",
      `index=1&total=${CLAIM_INDEX_MAX + 1}`,
    ];
    for (const qs of bad) {
      const res = await app.request(
        `/api/wiki/factcheck/claim?wiki=retrywiki&mode=article&page=${encodeURIComponent(PAGE)}&title=x&${qs}`,
      );
      expect(res.status).toBe(400);
    }
  });

  test("sel mode requires a selection", async () => {
    const res = await app.request(
      `/api/wiki/factcheck/claim?wiki=retrywiki&mode=sel&page=${encodeURIComponent(PAGE)}&title=x&index=1&total=1`,
    );
    expect(res.status).toBe(400);
  });

  test("a failed preflight claims NO slot — an unknown page can't wedge the wiki", async () => {
    const res = await app.request(
      "/api/wiki/factcheck/claim?wiki=retrywiki&mode=article&page=Nope&title=x&index=1&total=1",
    );
    expect(res.status).toBe(200); // app_error on the committed stream
    expect(acquireClaimRetry(claimRetryKey("retrywiki", "Nope")).ok).toBe(true);
  });
});
