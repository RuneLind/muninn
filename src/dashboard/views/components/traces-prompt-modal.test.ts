import { test, expect, beforeEach } from "bun:test";
import vm from "node:vm";
import { helpersClientScript } from "./helpers-client.ts";
import { tracesPromptModalScript, tracesPromptModalHtml, tracesPromptModalStyles } from "./traces-prompt-modal.ts";

/**
 * The prompt modal, evaluated the way the page evaluates it.
 *
 * A capture trace now carries MORE THAN ONE prompt — a YouTube dense-scan
 * capture stores a `claude:select` pass and a `claude` pass under one trace id
 * — so a modal that says only "Prompt Snapshot" leaves the reader unable to
 * tell which of them is on screen. These cases pin the two halves of that: the
 * fetch carries the pass it was opened on, and the header names it.
 *
 * A `vm` rather than a string assertion: the label is computed in the browser
 * from what the route returned, so a `toContain` on the script source would
 * pass on a function that is never called.
 */
interface ModalCtx {
  openPromptModal: (pass?: string) => Promise<void>;
  passLabelText: (pass: string | undefined) => string;
  currentWaterfallTraceId: string | null;
  waterfallSpans: unknown[];
  [k: string]: unknown;
}

let ctx: ModalCtx;
let fetched: string[];
let nextResponse: { status: number; body: unknown };
/** Overridable per test, so a case can hold a response open and interleave two
 *  opens. Reset in `beforeEach` to answer from `nextResponse`. */
let fetchHandler: (url: string) => Promise<FakeResponse>;

interface FakeResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

/** The shape `fetch` really returns, `ok` included — the modal gates on it. */
function fakeResponse(status: number, body: unknown): FakeResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function makeEl(id: string) {
  return {
    id,
    textContent: "",
    innerHTML: "",
    classList: {
      _set: new Set<string>(),
      add(c: string) { this._set.add(c); },
      remove(c: string) { this._set.delete(c); },
      contains(c: string) { return this._set.has(c); },
      toggle(c: string, on?: boolean) { if (on) this._set.add(c); else this._set.delete(c); },
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
  };
}

beforeEach(async () => {
  fetched = [];
  nextResponse = {
    status: 200,
    body: { systemPrompt: "system text", userPrompt: "user text", pass: "claude", kind: "capture" },
  };
  fetchHandler = async () => fakeResponse(nextResponse.status, nextResponse.body);
  const elements: Record<string, ReturnType<typeof makeEl>> = {};
  const documentStub = {
    getElementById(id: string) {
      if (!elements[id]) elements[id] = makeEl(id);
      return elements[id]!;
    },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  ctx = {
    window: {},
    document: documentStub,
    console,
    fetch: async (url: string) => {
      fetched.push(url);
      return fetchHandler(url);
    },
    currentWaterfallTraceId: "trace-abc",
    waterfallSpans: [],
  } as unknown as ModalCtx;
  vm.createContext(ctx);
  vm.runInContext(`${await helpersClientScript()}\n${tracesPromptModalScript()}`, ctx);
});

test("the modal markup carries a slot for the pass label", () => {
  expect(tracesPromptModalHtml()).toContain('id="promptPassLabel"');
});

test("opening with no pass fetches the default and names the pass the route answered", async () => {
  await ctx.openPromptModal();
  expect(fetched).toEqual(["/api/prompts/trace-abc"]);
  expect((ctx.document as { getElementById: (id: string) => { textContent: string } }).getElementById("promptPassLabel").textContent)
    .toBe("pass: claude");
});

test("opening on a pass fetches THAT pass, url-encoded", async () => {
  nextResponse.body = { systemPrompt: "sheets", userPrompt: "frames", pass: "claude:select", kind: "capture" };
  await ctx.openPromptModal("claude:select");
  expect(fetched).toEqual(["/api/prompts/trace-abc?pass=claude%3Aselect"]);
  expect((ctx.document as { getElementById: (id: string) => { textContent: string } }).getElementById("promptPassLabel").textContent)
    .toBe("pass: claude:select");
});

test("a chat snapshot is named 'chat', not an empty pass", async () => {
  nextResponse.body = { systemPrompt: "persona", userPrompt: "hi", pass: "", kind: "chat" };
  await ctx.openPromptModal();
  expect((ctx.document as { getElementById: (id: string) => { textContent: string } }).getElementById("promptPassLabel").textContent)
    .toBe("chat");
});

test("the cache is keyed on traceId AND pass — a second pass is not served the first one's body", async () => {
  await ctx.openPromptModal();
  nextResponse.body = { systemPrompt: "sheets", userPrompt: "frames", pass: "claude:select", kind: "capture" };
  await ctx.openPromptModal("claude:select");
  expect(fetched).toEqual(["/api/prompts/trace-abc", "/api/prompts/trace-abc?pass=claude%3Aselect"]);
  expect((ctx.document as { getElementById: (id: string) => { textContent: string } }).getElementById("promptPassLabel").textContent)
    .toBe("pass: claude:select");
  // Re-opening the first one is served from the cache, not re-fetched.
  await ctx.openPromptModal();
  expect(fetched).toHaveLength(2);
});

test("a missing snapshot clears the pass label instead of leaving the last one up", async () => {
  const label = () =>
    (ctx.document as { getElementById: (id: string) => { textContent: string } }).getElementById("promptPassLabel").textContent;
  await ctx.openPromptModal();
  // Non-vacuous: the label is up before the miss, so the "" below is a CLEAR.
  expect(label()).toBe("pass: claude");
  nextResponse = { status: 404, body: {} };
  ctx.currentWaterfallTraceId = "trace-none";
  await ctx.openPromptModal("claude");
  expect((ctx.document as { getElementById: (id: string) => { textContent: string } }).getElementById("promptPassLabel").textContent)
    .toBe("");
});

/**
 * What the cache is allowed to remember, and what it must not.
 *
 * The modal keeps one entry per (trace, pass) for the life of the page. Three
 * things went wrong with that: a slow answer to a superseded open painted over
 * the newer one, a 404 was remembered forever, and a 500 or 403 was stored as
 * if it were a prompt.
 */
const label = () =>
  (ctx.document as { getElementById: (id: string) => { textContent: string } })
    .getElementById("promptPassLabel").textContent;
const body = () =>
  (ctx.document as { getElementById: (id: string) => { innerHTML: string } })
    .getElementById("promptContent").innerHTML;

test("a superseded open never paints over the one that replaced it", async () => {
  // Two opens in flight; the SECOND answers first. This is the ordinary shape
  // of a reader clicking the selection pass while the summary pass is loading.
  const gates: Array<(r: FakeResponse) => void> = [];
  fetchHandler = () => new Promise<FakeResponse>((resolve) => { gates.push(resolve); });

  const first = ctx.openPromptModal();
  const second = ctx.openPromptModal("claude:select");
  expect(gates).toHaveLength(2);

  gates[1]!(fakeResponse(200, { systemPrompt: "sheets", userPrompt: "frames", pass: "claude:select" }));
  await second;
  expect(label()).toBe("pass: claude:select");

  gates[0]!(fakeResponse(200, { systemPrompt: "system text", userPrompt: "user text", pass: "claude" }));
  await first;
  // The stale answer is cached (its own key), but the modal still shows the
  // pass the reader last asked for.
  expect(label()).toBe("pass: claude:select");
  expect(body()).toContain("frames");
});

test("a 404 is retried on the next open — a capture's snapshot lands after the model call", async () => {
  nextResponse = { status: 404, body: { error: "Prompt snapshot not found" } };
  await ctx.openPromptModal();
  expect(body()).toContain("not available");
  expect(fetched).toHaveLength(1);

  nextResponse = { status: 200, body: { systemPrompt: "s", userPrompt: "u", pass: "claude" } };
  await ctx.openPromptModal();
  expect(fetched).toHaveLength(2);
  expect(label()).toBe("pass: claude");
});

test("a 500 is not stored as a prompt, and is retried", async () => {
  nextResponse = { status: 500, body: { error: "Failed to fetch prompt snapshot" } };
  await ctx.openPromptModal();
  // The error object must not reach the renderer as a body.
  expect(body()).toContain("not available");
  expect(label()).toBe("");

  nextResponse = { status: 200, body: { systemPrompt: "s", userPrompt: "u", pass: "claude" } };
  await ctx.openPromptModal();
  expect(fetched).toHaveLength(2);
  expect(body()).toContain("u");
});

test("a 403 is not stored as a prompt either", async () => {
  nextResponse = { status: 403, body: { error: "forbidden" } };
  await ctx.openPromptModal();
  expect(body()).toContain("not available");
  nextResponse = { status: 200, body: { systemPrompt: "s", userPrompt: "u", pass: "claude" } };
  await ctx.openPromptModal();
  expect(fetched).toHaveLength(2);
});

test("switching tabs after a PASS-scoped open renders that pass's body", async () => {
  // The tab switch reads the active KEY, not the bare trace id: keyed on the
  // trace alone it renders whichever pass happened to be cached first — or
  // nothing at all, since a pass-scoped entry is not stored under that key.
  nextResponse = {
    status: 200,
    body: { systemPrompt: "SELECTION SYSTEM PROMPT", userPrompt: "SELECTION USER PROMPT", pass: "claude:select" },
  };
  await ctx.openPromptModal("claude:select");
  expect(body()).toContain("SELECTION USER PROMPT");

  (ctx as unknown as { switchPromptTab: (t: string) => void }).switchPromptTab("system");
  expect(body()).toContain("SELECTION SYSTEM PROMPT");
  expect(body()).not.toContain("SELECTION USER PROMPT");
});

test("the pass label is a token that clears 4.5:1 on the modal's panel", () => {
  // Measured against --bg-panel in both themes: --text-faint is 2.50:1 (dark) /
  // 2.62:1 (light) and --text-dim 3.24 / 3.74; --text-muted is 5.26 / 4.94.
  // The label is 11px, i.e. the size where a low ratio is least readable.
  const block = tracesPromptModalStyles().match(/\.prompt-pass-label\s*\{[^}]*\}/)?.[0] ?? "";
  expect(block).not.toBe("");
  expect(block).toContain("var(--text-muted)");
  expect(block).not.toContain("var(--text-faint)");
});
