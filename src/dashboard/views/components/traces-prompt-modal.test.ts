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
  expect(body()).toContain("server error");
  expect(label()).toBe("");

  nextResponse = { status: 200, body: { systemPrompt: "s", userPrompt: "u", pass: "claude" } };
  await ctx.openPromptModal();
  expect(fetched).toHaveLength(2);
  expect(body()).toContain("u");
});

/**
 * A 5xx and a miss are different answers and must not read alike.
 *
 * "Expired or not captured" is a statement about the ARCHIVE — nothing here, do
 * not come back. A 500 says the opposite: the row may well exist and the server
 * could not say. Told the first thing, a reader stops looking; the only trace of
 * the truth was a `console.warn` nobody has open.
 */
test("a 5xx says the SERVER failed, not that the snapshot is gone", async () => {
  nextResponse = { status: 503, body: { error: "upstream down" } };
  await ctx.openPromptModal();
  expect(body()).toContain("server error");
  expect(body()).toContain("retry");
  // Not the archive's wording: that is the sentence this case exists to avoid.
  expect(body()).not.toContain("expired or not captured");
});

test("a 404 keeps the archive's wording — the snapshot really is not there", async () => {
  nextResponse = { status: 404, body: { error: "Prompt snapshot not found" } };
  await ctx.openPromptModal();
  expect(body()).toContain("expired or not captured");
  expect(body()).not.toContain("server error");
});

test("a 403 is not stored as a prompt either, and is not called a server error", async () => {
  nextResponse = { status: 403, body: { error: "forbidden" } };
  await ctx.openPromptModal();
  expect(body()).toContain("expired or not captured");
  expect(body()).not.toContain("server error");
  nextResponse = { status: 200, body: { systemPrompt: "s", userPrompt: "u", pass: "claude" } };
  await ctx.openPromptModal();
  expect(fetched).toHaveLength(2);
});

/**
 * Closing the modal drops the active key.
 *
 * `activePromptKey` means "the prompt on screen", and it outlived the modal:
 * after a close it still named the dismissed prompt, so `switchPromptTab` and
 * `jumpToSection` would repaint it into a panel the reader had dismissed —
 * possibly for a trace they have since navigated away from.
 *
 * **Not reachable by pointer today** (verified in a real browser): both entry
 * points are buttons inside `.prompt-modal-backdrop`, which is `display: none`
 * while hidden, so Playwright cannot click them either. This pins the STATE, so
 * the next affordance on those two functions inherits a cleared key rather than
 * the last trace's — and it is driven the way the closed modal's own code would
 * reach it, by calling the function.
 */
test("closing the modal forgets which prompt was open", async () => {
  await ctx.openPromptModal();
  expect(body()).toContain("user text");

  (ctx as unknown as { closePromptModal: (e?: unknown) => void }).closePromptModal();
  const el = (ctx.document as { getElementById: (id: string) => { innerHTML: string } }).getElementById("promptContent");
  el.innerHTML = "";

  (ctx as unknown as { switchPromptTab: (t: string) => void }).switchPromptTab("system");
  expect(el.innerHTML).toBe("");
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

// Per-turn context moved from the system prompt to a <context> block in the user
// turn (PR #637). The modal must find it there, and still render older snapshots.
const CONTEXT_BLOCK = [
  "<context>",
  "Your memories about this user:\n- Prefers TypeScript [lang]",
  "User's active goals:\n- Learn Rust",
  "User's scheduled tasks:\n- Morning briefing (briefing, 08:00)",
  "Recent proactive messages sent to user (last 24h):\n- [09:00] watcher: inbox digest",
  "</context>",
].join("\n\n");
const NEW_USER_PROMPT =
  "<conversation_history>\n[user/Rune] earlier\n[assistant] reply\n</conversation_history>\n\n" +
  CONTEXT_BLOCK + "\n\nwhat is next?";
const OLD_SYSTEM_PROMPT =
  "persona text\n\nYour memories about this user:\n- Prefers TypeScript [lang]\n\nUser's active goals:\n- Learn Rust";

type Section = { key: string; content?: string };
const parseUser = (t: string) => (ctx as unknown as { parseUserSections: (t: string) => Section[] }).parseUserSections(t);

test("the user turn's <context> block parses into its own sections, between history and the current message", () => {
  const sections = parseUser(NEW_USER_PROMPT);
  expect(sections.map((s) => s.key)).toEqual(["history", "personal-memories", "goals", "tasks", "alerts", "current"]);
  expect(sections.find((s) => s.key === "goals")!.content).toBe("User's active goals:\n- Learn Rust");
});

test("Current Message is only the text after </context>", () => {
  const current = parseUser(NEW_USER_PROMPT).find((s) => s.key === "current")!;
  expect(current.content).toBe("what is next?");
});

test("a <context> block with no history before it still parses", () => {
  const keys = parseUser(CONTEXT_BLOCK + "\n\nhi").map((s) => s.key);
  expect(keys).toEqual(["personal-memories", "goals", "tasks", "alerts", "current"]);
});

test("the user tab renders the context sections as sections, not inside Current Message", async () => {
  nextResponse.body = { systemPrompt: "persona", userPrompt: NEW_USER_PROMPT, pass: "", kind: "chat" };
  await ctx.openPromptModal();
  const html = body();
  expect(html).toContain('data-section="goals"');
  const current = html.slice(html.indexOf('class="current-message"'));
  expect(current).toContain("what is next?");
  expect(current).not.toContain("Learn Rust");
});

/** Opens a snapshot with a prompt_build span, then clicks the stat pill for `section`. */
async function clickPill(snapshot: Record<string, unknown>, section: string): Promise<"system" | "user" | "none"> {
  ctx.waterfallSpans = [{ name: "prompt_build", attributes: { messagesCount: 2, memoriesCount: 1, goalsCount: 1, scheduledTasksCount: 1, alertsCount: 1 } }];
  const doc = ctx.document as { getElementById: (id: string) => ReturnType<typeof makeEl> };
  const handlers: Record<string, () => void> = {};
  const stats = doc.getElementById("promptStats");
  // The stub has no DOM: hand back one fake pill per clickable pill tag, with every data-* attribute.
  stats.querySelectorAll = (() =>
    [...stats.innerHTML.matchAll(/<div class="prompt-stat-pill clickable"([^>]*)>/g)].map((m) => {
      const dataset = Object.fromEntries([...m[1]!.matchAll(/data-(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
      return { dataset, addEventListener: (_e: string, fn: () => void) => { handlers[dataset.section!] = fn; } };
    })) as never;
  nextResponse.body = snapshot;
  await ctx.openPromptModal();
  ctx.setTimeout = () => 0; // the scroll-into-view step is not under test
  handlers[section]!();
  const sys = doc.getElementById("tabSystem").classList.contains("active");
  const user = doc.getElementById("tabUser").classList.contains("active");
  return sys && !user ? "system" : user && !sys ? "user" : "none";
}

test("stat pills jump to the user tab when the section is in the user turn's <context>", async () => {
  const snap = { systemPrompt: "persona", userPrompt: NEW_USER_PROMPT, pass: "", kind: "chat" };
  for (const key of ["personal-memories", "goals", "tasks", "alerts"]) expect(await clickPill(snap, key)).toBe("user");
});

test("an OLD snapshot with the blocks in the system prompt still renders them there, and its pills go there", async () => {
  const sys = (ctx as unknown as { parseSystemSections: (t: string) => Section[] }).parseSystemSections(OLD_SYSTEM_PROMPT);
  expect(sys.map((s) => s.key)).toEqual(["persona", "personal-memories", "goals"]);
  const snap = { systemPrompt: OLD_SYSTEM_PROMPT, userPrompt: "<conversation_history>\n[user/Rune] hi\n</conversation_history>\n\nnow", pass: "", kind: "chat" };
  expect(await clickPill(snap, "goals")).toBe("system");
});
