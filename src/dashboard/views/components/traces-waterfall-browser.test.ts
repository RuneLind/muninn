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

/**
 * `/traces#<traceId>` opens a waterfall; `#<traceId>/prompt/<pass>` opens the
 * prompt modal on that pass on top of it — the link shape a /summaries doc-panel
 * control will offer while a capture's trace is still alive (that control is a
 * later PR; nothing links here yet).
 *
 * The parse lives in the bundle rather than in the page's inline script so it
 * can be driven here: a `#` fragment is not URL-decoded by the browser, the
 * pass itself contains a `:` (`claude:select`), and both halves are easy to get
 * wrong invisibly — a mis-parse leaves the modal shut with no error anywhere.
 */
const parseHash = (hash: string) =>
  (ctx as unknown as { parseTraceHash: (h: string) => unknown }).parseTraceHash(hash);

test("a bare trace hash asks for no prompt", () => {
  expect(parseHash("#11111111-2222-3333-4444-555555555555")).toEqual({ traceId: "11111111-2222-3333-4444-555555555555", prompt: false });
});

test("an empty hash yields no trace", () => {
  expect(parseHash("")).toBeNull();
  expect(parseHash("#")).toBeNull();
});

test("#<id>/prompt asks for the DEFAULT pass", () => {
  expect(parseHash("#11111111-2222-3333-4444-555555555555/prompt")).toEqual({ traceId: "11111111-2222-3333-4444-555555555555", prompt: true });
});

test("#<id>/prompt/<pass> carries the url-decoded pass", () => {
  expect(parseHash("#11111111-2222-3333-4444-555555555555/prompt/claude%3Aselect")).toEqual({
    traceId: "11111111-2222-3333-4444-555555555555",
    prompt: true,
    pass: "claude:select",
  });
});

test("an undecodable pass still opens the trace on the default pass", () => {
  // decodeURIComponent throws on a lone `%`; a bad link must not take the
  // waterfall down with it.
  expect(parseHash("#11111111-2222-3333-4444-555555555555/prompt/%")).toEqual({ traceId: "11111111-2222-3333-4444-555555555555", prompt: true });
});

test("a trailing slash after prompt is the default pass, not an empty one", () => {
  expect(parseHash("#11111111-2222-3333-4444-555555555555/prompt/")).toEqual({ traceId: "11111111-2222-3333-4444-555555555555", prompt: true });
});

/**
 * The trace id is a UUID, and the parse says so.
 *
 * It is interpolated into a fetch url and into a `querySelector` attribute
 * selector, and a fragment is not url-decoded by the browser — so a junk id
 * reaches both verbatim. `#<id>?x=1/prompt/claude` builds
 * `/api/prompts/<id>?x=1?pass=claude` (a second `?`, i.e. a request nobody
 * wrote), and `#a"]x/prompt` throws inside `querySelector` and takes the whole
 * deep-link handler with it. Every id this page links to is a `traces.trace_id`
 * UUID, so anything else is a malformed link and the right answer is to ignore
 * the fragment and render the ordinary list.
 */
const VALID_ID = "11111111-2222-3333-4444-555555555555";

test("a query string smuggled into the id is rejected, not passed to the fetch", () => {
  expect(parseHash("#" + VALID_ID + "?x=1/prompt/claude")).toBeNull();
});

test("an id carrying selector syntax is rejected", () => {
  expect(parseHash('#a"]x/prompt')).toBeNull();
  expect(parseHash('#' + VALID_ID + '"]/prompt')).toBeNull();
});

test("a short non-UUID id is rejected", () => {
  expect(parseHash("#abc-123")).toBeNull();
  expect(parseHash("#abc-123/prompt")).toBeNull();
});

test("an uppercase UUID is still a UUID", () => {
  expect(parseHash("#" + VALID_ID.toUpperCase())).toEqual({
    traceId: VALID_ID.toUpperCase(),
    prompt: false,
  });
});

/**
 * The page's own deep-link handler, lifted out of `traces-page.ts` and run.
 *
 * It lives in an inline `<script>` with no bundle, so the only honest way to
 * test it is to evaluate the real text (the `connector-selector.test.ts`
 * precedent). What it has to get right is the BACK button: `hashchange` fires
 * on every fragment change, and going back from `#<id>/prompt/<pass>` to
 * `#<id>` used to take the non-prompt branch, which did nothing at all — so the
 * modal the fragment no longer asks for stayed open over the waterfall.
 */
import { renderTracesPage } from "../traces-page.ts";

interface HashCtx {
  openTraceFromHash: () => void;
  location: { hash: string };
  [k: string]: unknown;
}

async function hashHandlerCtx(): Promise<{ ctx: HashCtx; calls: string[] }> {
  const page = await renderTracesPage();
  const match = page.match(/function openTraceFromHash\(\) \{[\s\S]*?\n {4}\}/);
  if (!match) throw new Error("openTraceFromHash not found in the rendered page");
  const calls: string[] = [];
  const c = {
    location: { hash: "" },
    parseTraceHash: (h: string) => (globalThis as unknown as {
      __parse: (h: string) => unknown;
    }).__parse(h),
    loadWaterfall: (id: string) => { calls.push("load:" + id); return Promise.resolve(); },
    openPromptModal: (pass?: string) => { calls.push("open:" + (pass ?? "")); },
    closePromptModal: () => { calls.push("close"); },
    document: { querySelector: () => null },
    Promise,
    console,
  } as unknown as HashCtx;
  vm.createContext(c);
  vm.runInContext(match[0], c);
  return { ctx: c, calls };
}

// The real parser, reachable from the vm context above.
(globalThis as unknown as { __parse: (h: string) => unknown }).__parse = (h) =>
  (ctx as unknown as { parseTraceHash: (h: string) => unknown }).parseTraceHash(h);

test("the page's hash handler opens the modal for #<id>/prompt/<pass>", async () => {
  const { ctx: c, calls } = await hashHandlerCtx();
  c.location.hash = "#" + VALID_ID + "/prompt/claude%3Aselect";
  c.openTraceFromHash();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(["load:" + VALID_ID, "open:claude:select"]);
});

test("going BACK to the bare trace hash closes the modal", async () => {
  const { ctx: c, calls } = await hashHandlerCtx();
  c.location.hash = "#" + VALID_ID + "/prompt";
  c.openTraceFromHash();
  await Promise.resolve();
  await Promise.resolve();
  calls.length = 0;

  // Back: the fragment no longer asks for a prompt, so the modal must go.
  c.location.hash = "#" + VALID_ID;
  c.openTraceFromHash();
  expect(calls).toEqual(["load:" + VALID_ID, "close"]);
});

test("a junk fragment closes the modal too, rather than stranding it", async () => {
  const { ctx: c, calls } = await hashHandlerCtx();
  c.location.hash = "#" + VALID_ID + "/prompt";
  c.openTraceFromHash();
  await Promise.resolve();
  await Promise.resolve();
  calls.length = 0;

  // A malformed id parses to null — the fragment asks for nothing, and the
  // modal is not what "nothing" looks like.
  c.location.hash = "#not-a-uuid";
  c.openTraceFromHash();
  expect(calls).toEqual(["close"]);
});
