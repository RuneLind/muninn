/**
 * Discuss v2 PR 6, class check C: the Trace card's thread reads, as one
 * table over the state space (read outcome × card state × send state × read
 * ordering × failure count). Each row drives the real controller
 * (`wiki-key-trace.ts`) on a card the real selection menu places, with every
 * thread read and send held by the test (answered when the row says, the
 * abort signal ignored, so a stale answer really lands late) and the poll's
 * timers faked (`setTimeout` of 1 s or more), so ordering is forced and no
 * row waits out a real backoff.
 *
 * Invariants checked across the rows: no read older than a send, a newer
 * read or a drop applies its answer; at most one poll timer per card
 * (`fire` asserts it); no timer or read outlives its card; a permanent
 * refusal ends at once with the route's message, a transient one retries
 * under the bound, counted since the last read that worked or the last send;
 * the card ends on «Summarize», the follow-up box, or a running turn that is
 * still being read. Not covered (deferred): a held card that stops being live
 * under an Ask view and comes back on Back stays «Still running».
 *
 * Own process: it installs happy-dom's globals and wires the menu's and the
 * trace's document listeners once, so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { DISCUSS_TAB, initDiscussTab, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";
import { initSelectionMenu, inlineCardLive, placeInlineCard, setSelectionMenuPage } from "../components/wiki-selection-menu.ts";
import { inlineCardHtml } from "../components/wiki-selection-menu-model.ts";
import { initKeyTrace, openTrace } from "../components/wiki-key-trace.ts";
import { TRACE_POLL_MAX_FAILURES, TRACE_THREAD_GONE } from "../components/wiki-key-trace-model.ts";
import { DISCUSS_WAITING_MS, DISCUSS_WAITING_TEXT } from "../components/wiki-discuss-state.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
const realFetch = globalThis.fetch;
/** Bun's own timer, for the test's flushes (happy-dom's is slower per call). */
const bunSetTimeout = globalThis.setTimeout;

const REL = "plans/ferry.mdx";
const KEY = "MEL-12";
const NIGHT = "The night route for MEL-12 is unchanged.";
const OTHER_LINE = "The morning route adds a stop.";
let menuRel = REL;

// ── Fake poll timers ────────────────────────────────────────────────────────

/** Timers of 1 s or more (the poll's): held until `fire`. */
const timers = new Map<object, { cb: () => void; delay: number }>();
/** A send's «still waiting» timer ({@link DISCUSS_WAITING_MS}), held apart so the poll's invariants count poll timers only. */
const waits = new Map<object, () => void>();
/** Every delay a held timer was set with, in order. */
const delays: number[] = [];
let realSetTimeout: typeof setTimeout;
let realClearTimeout: typeof clearTimeout;

// ── Held requests ───────────────────────────────────────────────────────────

type Outcome = Response | "throw" | "abort-error";
interface HeldRead {
  signal: AbortSignal | null;
  /** Answered. */
  done: boolean;
  answer: (o: Outcome) => Promise<void>;
}
/** Every thread read (`?traceKey=`), in order; each waits for its `answer`. */
const reads: HeldRead[] = [];
/** Each thread read's URL, in order (PR 913 D3c reads its userId). */
const readUrls: URL[] = [];
/** The page's own thread read (the Discuss tab's), when a test answers it. */
let pageRead: ((url: URL) => Response) | null = null;
interface HeldPost {
  body: Record<string, unknown>;
  signal: AbortSignal | null;
  /** Answer with a refusal (or any non-stream response). */
  refuse: (status: number, body: unknown) => Promise<void>;
  /** Answer with an SSE stream the test feeds. */
  stream: () => Promise<{ push: (event: string, data: unknown) => Promise<void>; end: () => Promise<void>; error: () => Promise<void> }>;
}
const posts: HeldPost[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const flush = () => new Promise((r) => bunSetTimeout(r, 0));
const settle = async (slow = false) => {
  for (let i = 0; i < 4; i++) await flush();
  if (slow) await new Promise((r) => realSetTimeout(r, 20));
};

const MENTIONS = {
  key: KEY, kind: "case", files: [{ relPath: REL, title: "Ferry", lines: [{ n: 9, text: NIGHT }] }], commits: [], log: [], prs: [],
  totalLines: 1, totalFiles: 1, logTotalLines: 0, totalsAtLeast: false, truncated: false,
};

beforeAll(() => {
  const win = new GlobalWindow({ url: "http://localhost:3011/wiki" });
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(win))) {
    if (IGNORE.has(key)) continue;
    const cur = Object.getOwnPropertyDescriptor(globalThis, key);
    if (cur && "value" in desc && cur.value === desc.value) continue;
    saved.set(key, cur);
    const next = "value" in desc && desc.value === win ? { ...desc, value: globalThis } : desc;
    Object.defineProperty(globalThis, key, { ...next, configurable: true });
  }
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  for (const k of ["setTimeout", "clearTimeout"]) if (!saved.has(k)) saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: ((cb: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) < 1000) return realSetTimeout(cb, ms, ...rest);
      const id = {};
      if (ms === DISCUSS_WAITING_MS) {
        waits.set(id, cb);
        return id;
      }
      timers.set(id, { cb, delay: ms! });
      delays.push(ms!);
      return id;
    }) as unknown as typeof setTimeout,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    writable: true,
    value: ((id: unknown) => {
      if (id && typeof id === "object" && waits.has(id)) waits.delete(id);
      else if (id && typeof id === "object" && timers.has(id)) timers.delete(id);
      else realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout,
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/wiki/mentions?")) return json(MENTIONS);
    if (url.startsWith("/api/wiki/discuss/thread?") && !url.includes("traceKey=") && pageRead) return pageRead(new URL(url, "http://x"));
    if (url.startsWith("/api/wiki/discuss/thread?") && url.includes("traceKey=")) {
      readUrls.push(new URL(url, "http://x"));
      return new Promise<Response>((resolve, reject) => {
        const held: HeldRead = {
          signal: init?.signal ?? null,
          done: false,
          answer: async (o) => {
            held.done = true;
            if (o === "throw") reject(new TypeError("Failed to fetch"));
            else if (o === "abort-error") reject(new DOMException("The operation was aborted.", "AbortError"));
            else resolve(o);
            await settle();
          },
        };
        reads.push(held);
      });
    }
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Promise<Response>((resolve) => {
        posts.push({
          body,
          signal: init.signal ?? null,
          refuse: async (status, b) => {
            resolve(json(b, status));
            await settle();
          },
          stream: async () => {
            const enc = new TextEncoder();
            let ctl!: ReadableStreamDefaultController<Uint8Array>;
            const s = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
            resolve(new Response(s, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
            await settle();
            return {
              push: async (event, data) => {
                ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                await settle();
              },
              end: async () => {
                ctl.close();
                await settle();
              },
              error: async () => {
                ctl.error(new TypeError("network error"));
                await settle();
              },
            };
          },
        });
      });
    }
    return json({}, 404);
  }) as typeof fetch;
  document.body.innerHTML = `<div id="articleWrap"></div><button data-conntab="${DISCUSS_TAB}" hidden>Discuss</button>${discussTabBodyHtml()}`;
  initDiscussTab({ wiki: () => "w", relPath: () => menuRel, switchTab: () => {} });
  initSelectionMenu({
    wiki: () => "w",
    relPath: () => menuRel,
    currentName: () => "ferry",
    pageType: () => "plan",
    graphId: "wikiGraph",
    explainUrl: (sel, heading) => `/api/wiki/explain?${new URLSearchParams({ sel, ctx: heading }).toString()}`,
    factcheck: () => {},
    hrefFor: (r) => `/wiki?relPath=${r}`,
  });
  initKeyTrace({ wiki: () => "w", relPath: () => menuRel, hrefFor: (r) => `/wiki?relPath=${r}`, mentionsOn: () => true, place: placeInlineCard, live: inlineCardLive });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
});

beforeEach(async () => {
  menuRel = REL;
  renderPage();
  await settle(true);
  timers.clear();
  waits.clear();
  delays.length = 0;
  reads.length = 0;
  posts.length = 0;
});

function renderPage(): void {
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2>${NIGHT}<br><br>${OTHER_LINE}</div>`;
  setDiscussAgentEnabled(true);
  setSelectionMenuPage({ mentions: true, keyKinds: [{ name: "case", pattern: "MEL-\\d+" }] });
}

function rangeOf(text: string): Range {
  const walker = document.createTreeWalker(document.querySelector("#articleWrap .wiki-article")!, 4);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const i = (t.textContent ?? "").indexOf(text);
    if (i === -1) continue;
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + text.length);
    return r;
  }
  throw new Error(text);
}

// ── Thread bodies ───────────────────────────────────────────────────────────

const Q1 = "Q1: is the night route open?";
const running = () => json({ thread: { id: "th-1" }, messages: [{ id: "m1", role: "user", content: Q1, turn: { id: "t1", seq: 1, question: Q1, answer: "", endState: "running", error: null, assistantMessageId: null } }] });
const done = () =>
  json({
    thread: { id: "th-1" },
    messages: [
      { id: "m1", role: "user", content: Q1, turn: { id: "t1", seq: 1, question: Q1, answer: "A1", endState: "done", error: null, assistantMessageId: "m2" } },
      { id: "m2", role: "assistant", content: "A1: it is open.", turn: null },
    ],
  });
const gone = () => json({ userId: "u1", bot: "b", traceKey: KEY, thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] });

// ── Card helpers ────────────────────────────────────────────────────────────

const states = (card: Element) => Array.from(card.querySelectorAll(".wiki-trace-turn")).map((t) => t.getAttribute("data-trace-state"));
const answers = (card: Element) => Array.from(card.querySelectorAll(".wiki-trace-a")).map((t) => (t.textContent ?? "").trim());
const note = (card: Element) => card.querySelector(".wiki-trace-note")?.textContent ?? null;
const summarize = (card: Element) => card.querySelector<HTMLButtonElement>("[data-trace-summarize]")!;
const follow = (card: Element) => card.querySelector<HTMLFormElement>(".wiki-trace-follow")!;
/** What the reader can do now: «Summarize», the follow-up box, or wait on a running turn still being read. */
function actionable(card: Element): "summarize" | "follow" | "polling" | "stuck" {
  if (!summarize(card).hidden && !summarize(card).disabled) return "summarize";
  // «Send» is off while the box is empty (pane room PR 1); «Continue in Claude Code» is off only while busy.
  if (!follow(card).hidden && !follow(card).querySelector<HTMLButtonElement>("[data-trace-continue]")!.disabled) return "follow";
  if (states(card).includes("running") && (timers.size === 1 || reads.some((r) => !r.done && !r.signal?.aborted))) return "polling";
  return "stuck";
}
const pending = () => [...timers.values()].map((t) => t.delay);

/** Fire the one poll timer (invariant ii: never more than one). */
async function fire(): Promise<void> {
  expect(timers.size).toBe(1);
  const [id, t] = [...timers.entries()][0]!;
  timers.delete(id);
  t.cb();
  await settle();
}

/** A Trace card on MEL-12, its first thread read held (`reads[0]`). */
async function openCard(at: "passage" | "none" = "passage"): Promise<HTMLElement> {
  const card = openTrace(KEY, at === "passage" ? rangeOf(NIGHT) : null)!;
  await settle();
  expect(reads.length).toBe(1);
  return card;
}

/** A card whose first read showed a turn running on the server: polling, its timer set. */
async function runningCard(at: "passage" | "none" = "passage"): Promise<HTMLElement> {
  const card = await openCard(at);
  await reads[0]!.answer(running());
  expect(states(card)).toEqual(["running"]);
  expect(pending()).toEqual([1500]);
  return card;
}

/** The newest read, made by firing the poll timer. */
async function nextRead(): Promise<HeldRead> {
  const n = reads.length;
  await fire();
  expect(reads.length).toBe(n + 1);
  return reads.at(-1)!;
}

// ── A. Read outcome × card context ──────────────────────────────────────────

type Expect =
  | { kind: "retry" }
  | { kind: "permanent"; message: string }
  | { kind: "gone" }
  | { kind: "thread-done" }
  | { kind: "thread-running" };

const OUTCOMES: { name: string; answer: () => Outcome; expect: Expect }[] = [
  { name: "network throw", answer: () => "throw", expect: { kind: "retry" } },
  { name: "AbortError not the card's own", answer: () => "abort-error", expect: { kind: "retry" } },
  { name: "200 thread, a turn running", answer: running, expect: { kind: "thread-running" } },
  { name: "200 thread, finished", answer: done, expect: { kind: "thread-done" } },
  { name: "200 thread: null", answer: gone, expect: { kind: "gone" } },
  { name: "404 trace-off", answer: () => json({ error: "Trace is not served on an instance that authenticates", reason: "trace-off" }, 404), expect: { kind: "permanent", message: "Trace is not served on an instance that authenticates (404)." } },
  { name: "404 unknown wiki (no reason)", answer: () => json({ error: 'no wiki configured for "w"' }, 404), expect: { kind: "permanent", message: 'no wiki configured for "w" (404).' } },
  { name: "400 bad key", answer: () => json({ error: "traceKey: not a key" }, 400), expect: { kind: "permanent", message: "traceKey: not a key (400)." } },
  { name: "403 role", answer: () => json({ error: "Discuss's wiki agent is for admins" }, 403), expect: { kind: "permanent", message: "Discuss's wiki agent is for admins (403)." } },
  { name: "408", answer: () => json({ error: "timeout" }, 408), expect: { kind: "retry" } },
  { name: "409 (no reason)", answer: () => json({ error: "conflict" }, 409), expect: { kind: "permanent", message: "conflict (409)." } },
  { name: "422 unknown-user", answer: () => json({ error: 'the user "x" is not one of b\'s chat users', reason: "unknown-user" }, 422), expect: { kind: "permanent", message: 'the user "x" is not one of b\'s chat users (422).' } },
  { name: "422 no-user", answer: () => json({ error: "pick the user", reason: "no-user" }, 422), expect: { kind: "permanent", message: "pick the user (422)." } },
  { name: "429", answer: () => json({ error: "slow down" }, 429), expect: { kind: "retry" } },
  { name: "418 (another 4xx)", answer: () => json({}, 418), expect: { kind: "permanent", message: "The thread could not be read (418)." } },
  { name: "500 could not read", answer: () => json({ error: "could not read the thread" }, 500), expect: { kind: "retry" } },
  { name: "502 from a proxy", answer: () => new Response("Bad Gateway", { status: 502 }), expect: { kind: "retry" } },
  { name: "503 no-bot", answer: () => json({ error: "no bot answers on this wiki here", reason: "no-bot" }, 503), expect: { kind: "permanent", message: "no bot answers on this wiki here (503)." } },
  { name: "503 with no body", answer: () => new Response(null, { status: 503 }), expect: { kind: "retry" } },
  { name: "503 with a reason the route does not send", answer: () => json({ error: "draining", reason: "draining" }, 503), expect: { kind: "retry" } },
  { name: "200 not JSON", answer: () => new Response("<html>portal</html>", { status: 200 }), expect: { kind: "retry" } },
  { name: "200 JSON with no thread field", answer: () => json({}), expect: { kind: "retry" } },
];

for (const o of OUTCOMES) {
  test(`A1 first read (no turns) · ${o.name}`, async () => {
    const card = await openCard();
    await reads[0]!.answer(o.answer());
    const e = o.expect;
    if (e.kind === "retry") {
      expect(pending()).toEqual([1500]);
      expect(states(card)).toEqual([]);
      expect(note(card)).toBeNull();
    } else if (e.kind === "permanent") {
      expect(pending()).toEqual([]);
      expect(note(card)).toBe(e.message);
    } else if (e.kind === "gone") {
      // A key never traced: nothing is gone (L4).
      expect(pending()).toEqual([]);
      expect(note(card)).toBeNull();
    } else if (e.kind === "thread-done") {
      expect(pending()).toEqual([]);
      expect(states(card)).toEqual(["done"]);
    } else {
      expect(pending()).toEqual([1500]);
      expect(states(card)).toEqual(["running"]);
    }
    // vi: a failed first read leaves the card usable.
    expect(actionable(card)).toBe(e.kind === "thread-done" ? "follow" : e.kind === "thread-running" ? "polling" : "summarize");
  });

  test(`A2 poll of a running turn · ${o.name}`, async () => {
    const card = await runningCard();
    const r = await nextRead();
    await r.answer(o.answer());
    const e = o.expect;
    if (e.kind === "retry") {
      expect(pending()).toEqual([1500]);
      expect(states(card)).toEqual(["running"]);
      expect(actionable(card)).toBe("polling");
    } else if (e.kind === "permanent") {
      expect(pending()).toEqual([]);
      expect(states(card)).toEqual(["error"]);
      expect(answers(card).at(-1)).toBe(e.message);
      expect(note(card)).toBeNull();
      expect(actionable(card)).toBe("follow");
    } else if (e.kind === "gone") {
      expect(pending()).toEqual([]);
      expect(states(card)).toEqual([]);
      expect(note(card)).toBe(TRACE_THREAD_GONE);
      expect(actionable(card)).toBe("summarize");
    } else if (e.kind === "thread-done") {
      expect(pending()).toEqual([]);
      expect(states(card)).toEqual(["done"]);
      expect(actionable(card)).toBe("follow");
    } else {
      expect(pending()).toEqual([1500]);
      expect(actionable(card)).toBe("polling");
    }
  });
}

// ── B. Failure count ────────────────────────────────────────────────────────

const failing: (() => Outcome)[] = [() => "throw", () => json({ error: "could not read the thread" }, 500), () => new Response("Bad Gateway", { status: 502 }), () => new Response(null, { status: 503 })];

test("B1 a running turn's reads failing: 8 in a row read again with a doubling wait, the 9th ends the turn as an error", async () => {
  const card = await runningCard();
  for (let i = 0; i < TRACE_POLL_MAX_FAILURES; i++) {
    await (await nextRead()).answer(failing[i % failing.length]!());
    expect(states(card)).toEqual(["running"]);
  }
  expect(delays).toEqual([1500, 1500, 3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  await (await nextRead()).answer(new Response(null, { status: 503 }));
  expect(states(card)).toEqual(["error"]);
  expect(answers(card)).toEqual(["The thread could not be read (503): the turn's end is not known."]);
  expect(pending()).toEqual([]);
  expect(actionable(card)).toBe("follow");
});

test("B2 a read that works resets the count: 5 failures, a running read, then 8 more failures still read again", async () => {
  const card = await runningCard();
  for (let i = 0; i < 5; i++) await (await nextRead()).answer("throw");
  await (await nextRead()).answer(running());
  for (let i = 0; i < TRACE_POLL_MAX_FAILURES; i++) {
    await (await nextRead()).answer("throw");
    expect([i, states(card)]).toEqual([i, ["running"]]);
  }
  await (await nextRead()).answer("throw");
  expect(states(card)).toEqual(["error"]);
});

test("B3 a send resets the count (defect 3): 5 failed first reads, «Summarize» refused 409 busy, then 8 more failures still read again", async () => {
  const card = await openCard();
  await reads[0]!.answer("throw");
  for (let i = 0; i < 4; i++) await (await nextRead()).answer("throw");
  // Five failures: the next read is due in 24 s.
  expect(pending()).toEqual([24000]);
  summarize(card).click();
  await settle();
  expect(posts.length).toBe(1);
  // The send stops the reads before it: no timer while it runs.
  expect(pending()).toEqual([]);
  const before = reads.length;
  await posts[0]!.refuse(409, { error: "the discussion's last turn is still running", reason: "busy" });
  // The 409 goes to a read of the thread.
  expect(reads.length).toBe(before + 1);
  await reads.at(-1)!.answer("throw");
  for (let i = 1; i < TRACE_POLL_MAX_FAILURES; i++) await (await nextRead()).answer("throw");
  expect(pending().length).toBe(1);
  expect(note(card)).toBeNull();
  await (await nextRead()).answer("throw");
  expect(pending()).toEqual([]);
  expect(note(card)).toBe("The thread could not be read: the server did not answer, so the turn's end is not known.");
  expect(actionable(card)).toBe("summarize");
});

test("B4 a read a send aborted does not count: 5 failures, a read in flight, «Summarize» refused 409 busy, then 8 failures still read again", async () => {
  const card = await openCard();
  await reads[0]!.answer("throw");
  for (let i = 0; i < 4; i++) await (await nextRead()).answer("throw");
  const inFlight = await nextRead();
  summarize(card).click();
  await settle();
  await posts[0]!.refuse(409, { error: "busy", reason: "busy" });
  // The aborted read's failure lands late: neither counted nor scheduling.
  await inFlight.answer("throw");
  const chain = reads.at(-1)!;
  expect(chain).not.toBe(inFlight);
  await chain.answer("throw");
  for (let i = 1; i < TRACE_POLL_MAX_FAILURES; i++) await (await nextRead()).answer("throw");
  expect(pending().length).toBe(1);
  await (await nextRead()).answer("throw");
  expect(pending()).toEqual([]);
  expect(inFlight.signal?.aborted).toBe(true);
});

// ── C. Read ordering × send state (defect 1) ────────────────────────────────

/** The first read held; «Summarize» clicked: the stale read and the send. */
async function sendOverStaleRead(): Promise<{ card: HTMLElement; stale: HeldRead; post: HeldPost }> {
  const card = await openCard();
  const stale = reads[0]!;
  summarize(card).click();
  await settle();
  expect(posts.length).toBe(1);
  return { card, stale, post: posts[0]! };
}

const SEND_ENDS: { name: string; run: (post: HeldPost) => Promise<void>; states: string[]; answer?: string }[] = [
  {
    name: "finished",
    run: async (p) => {
      const s = await p.stream();
      await s.push("turn", { discussionId: "th-9", turnId: "t9" });
      await s.push("done", { answer: "SENT-A: the trace." });
      await s.end();
    },
    states: ["done"],
    answer: "SENT-A: the trace.",
  },
  { name: "refused 422", run: (p) => p.refuse(422, { error: "the wiki agent does not run on that connector", reason: "connector" }), states: ["error"], answer: "the wiki agent does not run on that connector (422)" },
  { name: "refused 503 no-snapshot", run: (p) => p.refuse(503, { error: "this wiki is not a git work tree", reason: "no-snapshot" }), states: ["error"], answer: "this wiki is not a git work tree (503)" },
  {
    name: "stream app_error midway",
    run: async (p) => {
      const s = await p.stream();
      await s.push("delta", { text: "partial " });
      await s.push("app_error", { message: "the connector broke" });
      await s.end();
    },
    states: ["error"],
    answer: "the connector broke",
  },
  {
    name: "stream cut midway",
    run: async (p) => {
      const s = await p.stream();
      await s.push("delta", { text: "partial " });
      await s.error();
    },
    states: ["error"],
    answer: "The turn failed: the server did not answer.",
  },
];

const STALE_ANSWERS: { name: string; answer: () => Outcome }[] = [
  { name: "thread: null", answer: gone },
  { name: "an older thread snapshot", answer: running },
  { name: "a transient failure", answer: () => "throw" },
  { name: "a permanent refusal", answer: () => json({ error: "no bot answers on this wiki here", reason: "no-bot" }, 503) },
];

for (const end of SEND_ENDS) {
  for (const sa of STALE_ANSWERS) {
    test(`C1 a read started before the send lands after it · send ${end.name} · stale ${sa.name}`, async () => {
      const { card, stale, post } = await sendOverStaleRead();
      await end.run(post);
      await stale.answer(sa.answer());
      expect(states(card)).toEqual(end.states);
      expect(answers(card).at(-1)).toContain(end.answer!);
      expect(note(card)).toBeNull();
      expect(pending()).toEqual([]);
      expect(reads.length).toBe(1);
      expect(actionable(card)).toBe("follow");
      expect(stale.signal?.aborted).toBe(true);
    });
  }
}

for (const sa of STALE_ANSWERS) {
  test(`C2 a read started before the send lands while it streams · stale ${sa.name}`, async () => {
    const { card, stale, post } = await sendOverStaleRead();
    const s = await post.stream();
    await s.push("delta", { text: "STREAMING " });
    await stale.answer(sa.answer());
    expect(states(card)).toEqual(["running"]);
    expect(answers(card).at(-1)).toContain("STREAMING");
    expect(pending()).toEqual([]);
    await s.push("done", { answer: "STREAMED." });
    await s.end();
    expect(states(card)).toEqual(["done"]);
    expect(note(card)).toBeNull();
    expect(pending()).toEqual([]);
    expect(stale.signal?.aborted).toBe(true);
  });
}

test("C3 a send refused 409 busy: the stale read is superseded, the read after the send applies", async () => {
  const { card, stale, post } = await sendOverStaleRead();
  await post.refuse(409, { error: "busy", reason: "busy" });
  expect(reads.length).toBe(2);
  await stale.answer(gone());
  expect(note(card)).toBeNull();
  await reads[1]!.answer(running());
  expect(states(card)).toEqual(["running"]);
  expect(pending()).toEqual([1500]);
  await (await nextRead()).answer(done());
  expect(states(card)).toEqual(["done"]);
  expect(actionable(card)).toBe("follow");
  expect(stale.signal?.aborted).toBe(true);
});

test("C4 a send while a retry is pending: the timer is cleared, no read runs during the send", async () => {
  const card = await openCard();
  await reads[0]!.answer(json({ error: "could not read the thread" }, 500));
  expect(pending()).toEqual([1500]);
  summarize(card).click();
  await settle();
  expect(pending()).toEqual([]);
  const s = await posts[0]!.stream();
  await s.push("done", { answer: "SENT." });
  await s.end();
  expect(reads.length).toBe(1);
  expect(pending()).toEqual([]);
  expect(states(card)).toEqual(["done"]);
});

test("C5 the gone note goes with a send (L5), and a gone thread on a card with turns shows it", async () => {
  const card = await runningCard();
  await (await nextRead()).answer(gone());
  expect(note(card)).toBe(TRACE_THREAD_GONE);
  summarize(card).click();
  await settle();
  expect(note(card)).toBeNull();
  expect(posts[0]!.body.discussionId).toBeUndefined();
});

test("C6 a refusal note goes with a send", async () => {
  const card = await openCard();
  await reads[0]!.answer(json({ error: "no bot answers on this wiki here", reason: "no-bot" }, 503));
  expect(note(card)).toBe("no bot answers on this wiki here (503).");
  summarize(card).click();
  await settle();
  expect(note(card)).toBeNull();
});

// ── D. Card state ───────────────────────────────────────────────────────────

test("D1 closed while its next read is due: the timer is cleared (dropTrace), nothing is read", async () => {
  const card = await runningCard();
  card.querySelector<HTMLButtonElement>("[data-sel-card-close]")!.click();
  await settle();
  expect(inlineCardLive(card)).toBe(false);
  expect(pending()).toEqual([]);
  expect(reads.length).toBe(1);
});

test("D2 closed while a read is in flight: the read is aborted and its answer applies nothing", async () => {
  const card = await runningCard();
  const r = await nextRead();
  card.querySelector<HTMLButtonElement>("[data-sel-card-close]")!.click();
  await settle();
  expect(r.signal?.aborted).toBe(true);
  await r.answer(done());
  expect(states(card)).toEqual(["running"]);
  expect(pending()).toEqual([]);
});

for (const at of ["passage", "none"] as const) {
  test(`D3 replaced by another card while its next read is due (${at}): the timer is cleared`, async () => {
    await runningCard(at);
    placeInlineCard(rangeOf(OTHER_LINE), inlineCardHtml("where", "next", "<p>next</p>", null));
    await settle();
    expect(pending()).toEqual([]);
    expect(reads.length).toBe(1);
  });
}

test("D4 held, out for a render of its page: its reads go on and their answer is there when it comes back", async () => {
  const card = await runningCard();
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-ask-view">An answer.</div>`;
  expect(inlineCardLive(card)).toBe(true);
  await (await nextRead()).answer(done());
  renderPage();
  await settle(true);
  expect(card.isConnected).toBe(true);
  expect(states(card)).toEqual(["done"]);
  expect(actionable(card)).toBe("follow");
});

test("D5 no range, taken off the page by a render not yet swept: its due read is never made (L6)", async () => {
  const card = await runningCard("none");
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-ask-view">An answer.</div>`;
  expect(inlineCardLive(card)).toBe(false);
  await fire();
  expect(reads.length).toBe(1);
  expect(pending()).toEqual([]);
});

test("D6 held, its page left, before the render's sweep: its due read is never made (L6)", async () => {
  const card = await runningCard();
  menuRel = "plans/harbour.mdx";
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article">Harbour.</div>`;
  expect(inlineCardLive(card)).toBe(false);
  await fire();
  expect(reads.length).toBe(1);
});

test("D7 no range, a render takes it off the page: the render drops it, its timer cleared", async () => {
  const card = await runningCard("none");
  renderPage();
  await settle(true);
  expect(card.isConnected).toBe(false);
  expect(pending()).toEqual([]);
});

test("D8 no range, a render takes it off the page while a read is in flight: the read is aborted", async () => {
  await runningCard("none");
  const r = await nextRead();
  renderPage();
  await settle(true);
  expect(r.signal?.aborted).toBe(true);
  await r.answer(running());
  expect(pending()).toEqual([]);
});

test("D9 no range, taken off the page by a render not yet swept while a read is in flight: its answer sets no timer", async () => {
  const card = await runningCard("none");
  const r = await nextRead();
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-ask-view">An answer.</div>`;
  expect(inlineCardLive(card)).toBe(false);
  await r.answer(running());
  expect(pending()).toEqual([]);
  expect(reads.length).toBe(2);
});

// ── PR 913 fix round 2 batch 1 (D3) ─────────────────────────────────────────

test("D3 a follow-up on a trace thread read for one user carries that user's id, though another user was picked since", async () => {
  localStorage.setItem("muninn-discuss-bot-w", "b");
  localStorage.setItem("muninn-discuss-user-b", "popp");
  try {
    const card = await openCard();
    await reads[0]!.answer(
      json({
        userId: "popp",
        bot: "b",
        traceKey: KEY,
        thread: { id: "th-popp" },
        messages: [
          { id: "m1", role: "user", content: Q1, turn: { id: "t1", seq: 1, question: Q1, answer: "A1", endState: "done", error: null, assistantMessageId: "m2" } },
          { id: "m2", role: "assistant", content: "A1: it is open.", turn: null },
        ],
      }),
    );
    expect(actionable(card)).toBe("follow");
    // «as Rune» picked on a page meanwhile.
    localStorage.setItem("muninn-discuss-user-b", "rune");
    const input = card.querySelector<HTMLInputElement>(".wiki-trace-input")!;
    input.value = "And on Sundays?";
    follow(card).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(posts.length).toBe(1);
    expect(posts[0]!.body.discussionId).toBe("th-popp");
    expect(posts[0]!.body.userId).toBe("popp");
  } finally {
    localStorage.clear();
  }
});

test("D3b a follow-up after «Summarize» started the thread carries the turn's user, though another user was picked since", async () => {
  localStorage.setItem("muninn-discuss-bot-w", "b");
  localStorage.setItem("muninn-discuss-user-b", "popp");
  try {
    const card = await openCard();
    await reads[0]!.answer(gone());
    summarize(card).click();
    await settle();
    const s = await posts[0]!.stream();
    await s.push("turn", { turnId: "t1", seq: 1, discussionId: "th-popp", userId: "popp" });
    await s.push("done", { answer: "SUMMARY." });
    await s.end();
    localStorage.setItem("muninn-discuss-user-b", "rune");
    card.querySelector<HTMLInputElement>(".wiki-trace-input")!.value = "And on Sundays?";
    follow(card).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(posts.length).toBe(2);
    expect(posts[1]!.body).toMatchObject({ discussionId: "th-popp", userId: "popp" });
  } finally {
    localStorage.clear();
  }
});

test("D3c a running turn's poll reads the thread for the user it was read for, though another user was picked since", async () => {
  localStorage.setItem("muninn-discuss-bot-w", "b");
  localStorage.setItem("muninn-discuss-user-b", "popp");
  try {
    await openCard();
    await reads[0]!.answer(json({ userId: "popp", thread: { id: "th-1" }, messages: [{ id: "m1", role: "user", content: Q1, turn: { id: "t1", seq: 1, question: Q1, answer: "", endState: "running", error: null, assistantMessageId: null } }] }));
    localStorage.setItem("muninn-discuss-user-b", "rune");
    await fire();
    expect(reads.length).toBe(2);
    expect(readUrls.at(-1)!.searchParams.get("userId")).toBe("popp");
  } finally {
    localStorage.clear();
  }
});

test("R3 a pick in the Discuss tab resets a Trace card of the same bot: its old thread dropped, read again for the picked user", async () => {
  localStorage.setItem("muninn-discuss-bot-w", "b");
  localStorage.setItem("muninn-discuss-user-b", "popp");
  const users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }];
  pageRead = (u) => {
    const userId = u.searchParams.get("userId") ?? "popp";
    return json({ userId, userName: users.find((x) => x.id === userId)!.name, userChoosable: true, users, bot: "b", thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] });
  };
  try {
    const card = await openCard();
    await reads[0]!.answer(json({ userId: "popp", bot: "b", thread: { id: "th-popp" }, messages: [{ id: "m1", role: "user", content: Q1, turn: { id: "t1", seq: 1, question: Q1, answer: "A1", endState: "done", error: null, assistantMessageId: null } }, { id: "m2", role: "assistant", content: "A1.", turn: null }] }));
    expect(states(card)).toEqual(["done"]);
    (document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`) as HTMLButtonElement).click();
    await settle(true);
    (document.querySelector("#discussBody [data-discuss-as]") as HTMLButtonElement).click();
    document.querySelector<HTMLSelectElement>("#discussBody .wiki-discuss-user-select")!.value = "rune";
    (document.querySelector("#discussBody [data-discuss-pick-user]") as HTMLButtonElement).click();
    await settle(true);
    expect(states(card)).toEqual([]);
    expect(reads.length).toBe(2);
    expect(readUrls.at(-1)!.searchParams.get("userId")).toBe("rune");
  } finally {
    pageRead = null;
    localStorage.clear();
  }
});

test("R3 a Trace turn of the bot still running holds off a pick: the «as» button is off", async () => {
  localStorage.setItem("muninn-discuss-bot-w", "b");
  const users = [{ id: "popp", name: "Popp" }, { id: "rune", name: "Rune" }];
  pageRead = () => json({ userId: "popp", userName: "Popp", userChoosable: true, users, bot: "b", thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] });
  try {
    const card = await openCard();
    await reads[0]!.answer(gone());
    summarize(card).click();
    await settle();
    const s = await posts[0]!.stream(); // the Trace turn runs
    (document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`) as HTMLButtonElement).click();
    await settle(true);
    expect(document.querySelector<HTMLButtonElement>("#discussBody [data-discuss-as]")!.disabled).toBe(true);
    await s.push("done", { answer: "ok" });
    await s.end();
  } finally {
    pageRead = null;
    localStorage.clear();
  }
});

test("R1/R2 a Trace card keeps the user its read or turn returned when none is kept, and sends that user with no thread", async () => {
  localStorage.setItem("muninn-discuss-bot-w", "b");
  try {
    // A read of a listed user with no thread: kept (R1).
    let card = await openCard();
    await reads[0]!.answer(json({ userId: "popp", bot: "b", users: [{ id: "popp", name: "Popp" }], thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] }));
    expect(localStorage.getItem("muninn-discuss-user-b")).toBe("popp");
    // Another window keeps Rune; «Summarize» (no thread yet) is still as Popp, the card's user (R2).
    localStorage.setItem("muninn-discuss-user-b", "rune");
    summarize(card).click();
    await settle();
    expect(posts[0]!.body.userId).toBe("popp");
    await posts[0]!.refuse(500, { error: "x" });

    // Nothing kept, a read of an unlisted user: not kept; the turn event's user is (R2).
    localStorage.removeItem("muninn-discuss-user-b");
    reads.length = 0;
    posts.length = 0;
    renderPage();
    card = await openCard();
    await reads[0]!.answer(gone());
    expect(localStorage.getItem("muninn-discuss-user-b")).toBe(null);
    summarize(card).click();
    await settle();
    const s = await posts[0]!.stream();
    await s.push("turn", { turnId: "t1", seq: 1, discussionId: "th-popp", userId: "popp" });
    expect(localStorage.getItem("muninn-discuss-user-b")).toBe("popp");
    await s.push("done", { answer: "ok" });
    await s.end();
  } finally {
    localStorage.clear();
  }
});

// ── Part of the shared-stream PR: a send the browser holds back ─────────────

const waitingLine = (card: Element) => card.querySelector("[data-discuss-waiting]")?.textContent ?? null;
const statusLine = (card: Element) => card.querySelector(".wiki-trace-turn .wiki-discuss-status")?.textContent?.trim() ?? null;

test("W1 a send with no response headers after 5 s says it is still waiting; the headers clear it", async () => {
  const card = await openCard();
  await reads[0]!.answer(gone());
  summarize(card).click();
  await settle();
  expect(posts.length).toBe(1);
  // Before any frame the turn is starting, not reading mentions.
  expect(statusLine(card)).toBe("Starting the turn…");
  expect(waitingLine(card)).toBeNull();
  expect(waits.size).toBe(1);
  for (const cb of waits.values()) cb();
  await settle();
  expect(waitingLine(card)).toBe(DISCUSS_WAITING_TEXT);
  const s = await posts[0]!.stream();
  expect(waitingLine(card)).toBeNull();
  expect(waits.size).toBe(0);
  await s.push("status", { phase: "mentions" });
  expect(statusLine(card)).toBe("Reading the key's mentions…");
  await s.push("done", { answer: "A." });
  await s.end();
  expect(states(card)).toEqual(["done"]);
});

test("W2 a send that fails clears the waiting line", async () => {
  const card = await openCard();
  await reads[0]!.answer(gone());
  summarize(card).click();
  await settle();
  for (const cb of waits.values()) cb();
  await settle();
  expect(waitingLine(card)).toBe(DISCUSS_WAITING_TEXT);
  await posts[0]!.refuse(500, { error: "boom" });
  expect(waitingLine(card)).toBeNull();
  expect(states(card)).toEqual(["error"]);
});

test("W3 a send answered inside 5 s never shows the waiting line", async () => {
  const card2 = await openCard();
  await reads[0]!.answer(gone());
  summarize(card2).click();
  await settle();
  expect(waits.size).toBe(1);
  await posts[0]!.refuse(500, { error: "boom" });
  // The timer was cleared before it fired.
  expect(waits.size).toBe(0);
  expect(waitingLine(card2)).toBeNull();
});
