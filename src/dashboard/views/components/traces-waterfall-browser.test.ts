import { test, expect, beforeAll } from "bun:test";
import vm from "node:vm";
import { helpersClientScript } from "./helpers-client.ts";
import { tracesWaterfallClientScript } from "./traces-waterfall-client.ts";

/**
 * Eval the bundled waterfall script in a vm context with a stubbed DOM. The
 * goal is to verify that:
 *  1. The IIFE bundle loads without runtime errors against the elements the
 *     traces page provides at script-injection time.
 *  2. `loadWaterfall`, `closeWaterfall`, `closeSpanDetails`, `toggleCollapse`
 *     end up reachable on globalThis (so HTML inline onclicks find them).
 *  3. Loading a trace populates `globalThis.currentWaterfallTraceId` and
 *     `globalThis.waterfallSpans` (so traces-prompt-modal.ts can read them).
 *  4. Rendering a real-shape spans payload doesn't throw — exercises the
 *     buildWaterfallState DFS, the chevron toggle HTML, and the span label
 *     fallback that depends on globals (`fmtDuration`, `esc`, …).
 */

interface VmCtx {
  loadWaterfall: (id: string) => Promise<void>;
  closeWaterfall: () => void;
  closeSpanDetails: () => void;
  currentWaterfallTraceId: string | null;
  waterfallSpans: Array<{ id: string }>;
  [k: string]: unknown;
}

let ctx: VmCtx;
let nextFetchSpans: unknown[] = [];

beforeAll(async () => {
  // Each id maps to a stub Element with classList + a synthetic addEventListener
  // that captures handlers for later invocation. innerHTML is just a string
  // so the IIFE can write into it without throwing.
  function makeEl(id: string) {
    const el = {
      id,
      classList: {
        _set: new Set<string>(),
        add(c: string) {
          this._set.add(c);
        },
        remove(c: string) {
          this._set.delete(c);
        },
        contains(c: string) {
          return this._set.has(c);
        },
      },
      innerHTML: "",
      textContent: "",
      _listeners: {} as Record<string, Array<(e: unknown) => void>>,
      addEventListener(evt: string, fn: (e: unknown) => void) {
        if (!this._listeners[evt]) this._listeners[evt] = [];
        this._listeners[evt]!.push(fn);
      },
    };
    return el;
  }
  const elements: Record<string, ReturnType<typeof makeEl>> = {
    waterfall: makeEl("waterfall"),
    waterfallContainer: makeEl("waterfallContainer"),
    waterfallTitle: makeEl("waterfallTitle"),
    spanDetails: makeEl("spanDetails"),
    spanDetailsTitle: makeEl("spanDetailsTitle"),
    spanDetailsJson: makeEl("spanDetailsJson"),
  };

  // The waterfall script attaches a top-level keydown handler on `document`,
  // so document needs its own addEventListener too.
  const documentStub = {
    _listeners: {} as Record<string, Array<(e: unknown) => void>>,
    addEventListener(evt: string, fn: (e: unknown) => void) {
      if (!this._listeners[evt]) this._listeners[evt] = [];
      this._listeners[evt]!.push(fn);
    },
    getElementById(id: string) {
      return elements[id] ?? null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
  };

  ctx = {
    window: {},
    document: documentStub,
    fetch: async () => ({ json: async () => ({ spans: nextFetchSpans }) }),
    console,
  } as unknown as VmCtx;
  vm.createContext(ctx);
  const helpers = await helpersClientScript();
  const waterfall = await tracesWaterfallClientScript();
  vm.runInContext(`${helpers}\n${waterfall}`, ctx);
});

test("IIFE exposes click-bound handlers on globalThis", () => {
  expect(typeof ctx.loadWaterfall).toBe("function");
  expect(typeof ctx.closeWaterfall).toBe("function");
  expect(typeof ctx.closeSpanDetails).toBe("function");
});

test("globalThis is seeded with currentWaterfallTraceId and waterfallSpans for prompt-modal", () => {
  expect(ctx.currentWaterfallTraceId).toBeNull();
  expect(Array.isArray(ctx.waterfallSpans)).toBe(true);
});

test("loadWaterfall populates globals from a real-shape spans payload", async () => {
  // Override fetch with a payload that exercises:
  //  - root span (no parentId) — gets the title prefix + duration
  //  - child span — triggers the DFS sort
  //  - tool span with toolName — exercises isToolSpan + chevron toggle path
  //  - synthesized child — auto-collapses the parent
  nextFetchSpans = [
    {
      id: "root",
      name: "request",
      kind: "root",
      status: "ok",
      startedAt: 1000,
      durationMs: 500,
    },
    {
      id: "tool1",
      parentId: "root",
      name: "search",
      kind: "tool",
      status: "ok",
      startedAt: 1100,
      durationMs: 200,
      attributes: { toolName: "knowledge-search_knowledge", input: '{"q":"hi"}' },
    },
    {
      id: "stage1",
      parentId: "tool1",
      name: "index.fetch",
      kind: "span",
      status: "ok",
      startedAt: 1100,
      durationMs: 50,
      attributes: { synthesized: true },
    },
  ];
  await ctx.loadWaterfall("trace-xyz");
  expect(ctx.currentWaterfallTraceId).toBe("trace-xyz");
  expect(ctx.waterfallSpans.length).toBe(3);
  // DFS order: root, tool1, stage1
  expect(ctx.waterfallSpans.map((s) => s.id)).toEqual(["root", "tool1", "stage1"]);
});

async function renderLabelFor(span: Record<string, unknown>): Promise<string> {
  // Render a single AI span (no toolName ⇒ chip is null ⇒ the aiSpanLabel path
  // runs) and pull its escaped label back out of the waterfall innerHTML.
  nextFetchSpans = [span];
  await ctx.loadWaterfall("label-trace");
  const html = (ctx.document as unknown as {
    getElementById: (id: string) => { innerHTML: string };
  }).getElementById("waterfall").innerHTML;
  const m = html.match(/waterfall-label"[^>]*>(.*?)<\/div>/s);
  return m ? m[1]! : html;
}

test("a bare 'claude' span is labeled by connector + model, not its name", async () => {
  const label = await renderLabelFor({
    id: "c1",
    name: "claude",
    kind: "claude",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { connector: "claude-sdk", model: "claude-sonnet-5" },
  });
  expect(label).toContain("claude-sdk, claude-sonnet-5");
});

test("a connector-less 'claude' span reads 'unknown', never a fabricated claude-cli", async () => {
  const label = await renderLabelFor({
    id: "c2",
    name: "claude",
    kind: "claude",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { model: "claude-sonnet-5" },
  });
  expect(label).toContain("unknown, claude-sonnet-5");
  expect(label).not.toContain("claude-cli");
});

test("a non-'claude' AI span KEEPS its name and appends connector + model", async () => {
  const label = await renderLabelFor({
    id: "cl0",
    name: "claude:claim-0",
    kind: "claude",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { connector: "claude-sdk", model: "claude-sonnet-5" },
  });
  expect(label).toContain("claude:claim-0");
  expect(label).toContain("claude-sdk, claude-sonnet-5");
});

test("a model-only non-'claude' span appends just the model — no 'unknown'", async () => {
  const label = await renderLabelFor({
    id: "ex1",
    name: "memory_extraction",
    kind: "extract",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { model: "claude-haiku-4-5" },
  });
  expect(label).toContain("memory_extraction");
  expect(label).toContain("claude-haiku-4-5");
  expect(label).not.toContain("unknown");
});

test("a router-backed span (haikuBackend, no connector) appends the friendly backend label", async () => {
  // factcheck extract / gardener cluster/map stamp the Haiku backend on
  // `haikuBackend` (never `connector`, to dodge the walk's mixed-collapse) —
  // aiSpanLabel falls back to it, rendered friendly (cli → "Claude Code").
  const label = await renderLabelFor({
    id: "ex2",
    name: "extract",
    kind: "extract",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { model: "claude-haiku-4-5", haikuBackend: "cli" },
  });
  expect(label).toContain("extract");
  expect(label).toContain("Claude Code, claude-haiku-4-5");
});

test("a span carrying ONLY haikuBackend (no model, no connector) is still an AI span labeled by its backend", async () => {
  const label = await renderLabelFor({
    id: "ex3",
    name: "cluster",
    kind: "span",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { haikuBackend: "copilot" },
  });
  expect(label).toContain("cluster");
  expect(label).toContain("Copilot SDK");
});

test("a bare backend token on connector renders friendly (anthropic → Anthropic API)", async () => {
  const label = await renderLabelFor({
    id: "ex2",
    name: "memory_extraction",
    kind: "extract",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { connector: "anthropic", model: "claude-haiku-4-5" },
  });
  expect(label).toContain("memory_extraction");
  expect(label).toContain("Anthropic API");
  expect(label).not.toContain("· anthropic,");
});

test("a real ConnectorType on connector passes through untouched (claude-sdk)", async () => {
  const label = await renderLabelFor({
    id: "ex3",
    name: "claude:claim-0",
    kind: "claude",
    status: "ok",
    startedAt: 1000,
    durationMs: 100,
    attributes: { connector: "claude-sdk", model: "claude-sonnet-5" },
  });
  expect(label).toContain("claude-sdk, claude-sonnet-5");
});

test("closeWaterfall + closeSpanDetails don't throw against the stub DOM", () => {
  ctx.closeSpanDetails();
  ctx.closeWaterfall();
});
