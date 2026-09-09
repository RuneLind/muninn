import { test, expect, beforeEach } from "bun:test";
import vm from "node:vm";
import { helpersClientScript } from "./helpers-client.ts";
import { tracesPromptModalScript, tracesPromptModalHtml } from "./traces-prompt-modal.ts";

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
      return { status: nextResponse.status, json: async () => nextResponse.body };
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
