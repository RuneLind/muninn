/**
 * Discuss v2 PR 4, fix round 1: a thread read that started before «Start over»
 * (or before a newer read) never applies its result. The first read is held
 * open while the reader asks, the turn ends and «Start over» closes the
 * thread; the held read then lands with the thread as it was. The next ask
 * must start a new thread, and «Earlier discussions» must list the closed one.
 *
 * Own process: it installs happy-dom's globals and wires the tab's document
 * listeners once, so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { DISCUSS_ASK_BTN_ID, DISCUSS_INPUT_ID, initDiscussTab, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { DISCUSS_START_OVER_ID, discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
const realFetch = globalThis.fetch;

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
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
  await new Promise((r) => setTimeout(r, 20));
};

test("a thread read that lands after «Start over» does not bring the closed thread back: the next ask starts a new thread, and «Earlier discussions» lists the closed one", async () => {
  const T1 = crypto.randomUUID();
  const TURN1 = crypto.randomUUID();
  const enc = new TextEncoder();
  const posts: Record<string, unknown>[] = [];
  let reads = 0;
  let closes = 0;
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((r) => (releaseFirst = r));
  const q1 = { id: crypto.randomUUID(), role: "user", content: "First?", createdAt: 1, turn: null };
  const a1 = { id: crypto.randomUUID(), role: "assistant", content: "Six.", createdAt: 2, turn: null };
  const storedTurn = { id: TURN1, discussionId: T1, seq: 1, selection: null, question: "First?", answer: "Six.", endState: "done", error: null, toolCalls: [], proposedEdit: null, editAppliedAt: null, createdAt: 1 };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/wiki/discuss/thread?")) {
      const n = ++reads;
      if (n === 1) {
        // The slow first read: the thread as the server saw it while turn 1 ran.
        await firstHeld;
        return json({ userId: "kari", bot: "ivar", thread: { id: T1, name: "wiki: race", createdAt: 1 }, messages: [{ ...q1, turn: storedTurn }, a1], closed: [], closedTotal: 0, oneShot: [] });
      }
      return json({ userId: "kari", bot: "ivar", thread: null, messages: [], closed: [{ id: T1, name: "wiki: race", createdAt: 1, closedAt: 3, messages: [q1, a1], messageTotal: 2 }], closedTotal: 1, oneShot: [] });
    }
    if (url === "/api/wiki/discuss/thread/close") {
      closes++;
      return json({ closed: true });
    }
    if (url === "/api/wiki/discuss") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push(body);
      if (posts.length > 1) return json({ error: "stop here" }, 429);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`event: turn\ndata: ${JSON.stringify({ turnId: TURN1, seq: 1, discussionId: T1, userId: "kari" })}\n\n`));
          c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ answer: "Six.", proposedEdit: null })}\n\n`));
          c.enqueue(enc.encode(`event: end\ndata: {}\n\n`));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return json({}, 404);
  }) as typeof fetch;

  initDiscussTab({ wiki: () => "w", relPath: () => "plans/race.mdx", switchTab: () => {} });
  document.body.innerHTML = `<button data-conntab="discuss" hidden>Discuss</button>${discussTabBodyHtml()}`;
  setDiscussAgentEnabled(true);
  const input = document.getElementById(DISCUSS_INPUT_ID) as HTMLTextAreaElement;
  const ask = document.getElementById(DISCUSS_ASK_BTN_ID) as HTMLButtonElement;

  // q1: the first read starts (held) and the turn runs to its end.
  input.value = "First?";
  ask.click();
  await settle();
  expect(reads).toBe(1);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.discussionId).toBeUndefined();

  // «Start over»: the thread is closed and read again (the second read answers at once).
  document.getElementById(DISCUSS_START_OVER_ID)!.click();
  await settle();
  expect(closes).toBe(1);
  expect(reads).toBe(2);

  // The first read lands now, with the thread as it was before Start over.
  releaseFirst();
  await settle();

  const earlier = document.querySelector(".wiki-discuss-earlier-wrap")!;
  expect(earlier.querySelector(`[data-earlier-thread="${T1}"]`) !== null).toBe(true);
  expect(document.querySelectorAll(".wiki-discuss-turns [data-turn-key]").length).toBe(0);
  expect((document.getElementById(DISCUSS_START_OVER_ID) as HTMLButtonElement).hidden).toBe(true);

  // The next ask starts a new thread: no discussion id.
  input.value = "Second?";
  ask.click();
  await settle();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.discussionId).toBeUndefined();
  document.body.innerHTML = "";
});
