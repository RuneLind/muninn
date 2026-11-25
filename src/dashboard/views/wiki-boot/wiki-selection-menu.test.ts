/**
 * Discuss v2 PR 5: the selection menu's controller against the Discuss tab's
 * own state, in a booted document.
 *
 * - «Explain with context» sends ONE turn through the pane's entry, with the
 *   passage's fields and `mode: "explore"`, without opening the pane; the
 *   inline card and the pane draw that same turn (one turn record, one turn
 *   element in the pane), and the card repaints as frames arrive.
 * - «Add to Oppfølging» sends `mode: "edit"` for its turn only: the pane's
 *   Explore/Edit toggle is left as the reader set it.
 * - On a read-only wiki, Enter (the default action, with no event the
 *   read-only guard sees) sends nothing, whether the default is the inline
 *   turn or the classic Explain (no agent).
 * - An action's press does not bring the bar back on the release that follows.
 *
 * Own process: it installs happy-dom's globals and wires the tab's and the
 * menu's document listeners once, so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { DISCUSS_TAB, initDiscussTab, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";
import { initSelectionMenu, setSelectionMenuPage } from "../components/wiki-selection-menu.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
const realFetch = globalThis.fetch;

const REL = "plans/ferry.mdx";
const posts: Record<string, unknown>[] = [];
/** The stream a POST answers with: its frames are pushed by the test. */
let push: ((event: string, data: unknown) => void) | null = null;
let close: (() => void) | null = null;
const classic: string[] = [];
/** Every tab the shell was asked to show. */
const switched: string[] = [];

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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/wiki/discuss/thread?")) return json({ userId: "u1", bot: "b", thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] });
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          push = (event, data) => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          close = () => c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return json({}, 404);
  }) as typeof fetch;
  document.body.innerHTML = `<div id="articleWrap"></div><button data-conntab="${DISCUSS_TAB}" hidden>Discuss</button>${discussTabBodyHtml()}`;
  initDiscussTab({ wiki: () => "w", relPath: () => REL, switchTab: (tab) => switched.push(tab) });
  initSelectionMenu({
    wiki: () => "w",
    relPath: () => REL,
    currentName: () => "ferry",
    pageType: () => "plan",
    graphId: "wikiGraph",
    explainClassic: (sel) => classic.push(sel),
    factcheck: () => {},
    hrefFor: (r) => `/wiki?relPath=${r}`,
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
  await new Promise((r) => setTimeout(r, 30));
};

const NIGHT = "The night route for MEL-12 is unchanged.";

/** The page renders: its article, the reader flags, the agent on. */
function renderPage(): void {
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2>${NIGHT}<br><br>The morning route adds a stop.<h2>Oppfølging</h2><ul><li>Check the berth list.</li></ul></div>`;
  setDiscussAgentEnabled(true);
  setSelectionMenuPage({ mentions: true, keyKinds: [{ name: "case", pattern: "MEL-\\d+" }] });
}

/** Select `text` in the article and release the mouse there. */
async function selectText(text: string): Promise<void> {
  const article = document.querySelector(".wiki-article")!;
  const walker = document.createTreeWalker(article, 4);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const i = (t.textContent ?? "").indexOf(text);
    if (i === -1) continue;
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + text.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await settle();
    return;
  }
  throw new Error(text);
}

const barEl = () => document.getElementById("wikiSelBar")!;
const press = (el: Element) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

test("«Explain with context»: one turn through the pane's entry, drawn by the card and the pane alike, the pane left closed", async () => {
  renderPage();
  await selectText(NIGHT);
  expect(barEl().style.display).toBe("flex");
  expect(Array.from(barEl().querySelectorAll("[data-selact]")).map((b) => b.getAttribute("data-selact"))).toEqual(["explain", "where", "history", "factcheck", "copy", "follow", "key"]);

  const btn = document.getElementById("wikiExplainBtn")!;
  press(btn);
  // The release lands on the article under the now hidden bar: no bar again.
  document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await settle();
  expect(barEl().style.display).toBe("none");
  expect(posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ wiki: "w", relPath: REL, mode: "explore", selection: NIGHT, heading: "Brief" });
  expect(String(posts[0]!.question)).toContain("Explain this passage with context");
  expect(classic).toEqual([]);
  // The pane was not opened: the shell was never asked to show the tab.
  expect(switched).toEqual([]);

  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
  expect(card).toBeTruthy();
  // Under the paragraph: after the break, before the next one.
  expect(card.previousSibling?.nodeName).toBe("BR");
  expect(card.nextSibling?.textContent).toBe("The morning route adds a stop.");

  push!("turn", { turnId: "turn-1", seq: 1, discussionId: "thread-1" });
  push!("delta", { text: "CARD-ANSWER so far" });
  await settle();
  expect(card.querySelector(".wiki-discuss-answer")?.textContent).toContain("CARD-ANSWER so far");
  push!("done", { answer: "CARD-ANSWER whole.", proposedEdit: null });
  close!();
  await settle();
  expect(card.querySelector(".wiki-discuss-answer")?.textContent).toContain("CARD-ANSWER whole.");
  // The pane holds the same turn, once.
  const turns = document.querySelectorAll("#discussBody .wiki-discuss-turn");
  expect(turns.length).toBe(1);
  expect(turns[0]!.querySelector(".wiki-discuss-answer")?.textContent).toContain("CARD-ANSWER whole.");
  // «Open in Discuss →» shows the pane on it.
  (card.querySelector("[data-sel-card-pane]") as HTMLButtonElement).click();
  expect(switched).toEqual([DISCUSS_TAB]);
});

test("«Add to Oppfølging» is an Edit turn for itself only: the pane's toggle stays Explore", async () => {
  renderPage();
  await selectText("The morning route adds a stop.");
  press(barEl().querySelector('[data-selact="follow"]')!);
  await settle();
  expect(posts.at(-1)).toMatchObject({ mode: "edit", selection: "The morning route adds a stop.", discussionId: "thread-1" });
  push!("turn", { turnId: "turn-2", seq: 2, discussionId: "thread-1" });
  push!("done", { answer: "Proposed.", proposedEdit: null });
  close!();
  await settle();
  expect(document.querySelector('[data-discuss-mode="explore"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelectorAll("#discussBody .wiki-discuss-turn").length).toBe(2);
  // The new card replaced the first.
  expect(document.querySelectorAll("#articleWrap .wiki-sel-card").length).toBe(1);
});

test("a read-only wiki: Enter on the bar sends nothing, inline or classic", async () => {
  renderPage();
  const before = posts.length;
  await selectText(NIGHT);
  g.__WIKI_READONLY_WIKI__ = true;
  try {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(posts.length).toBe(before);
    expect(barEl().style.display).toBe("none");
    // No agent: Enter's default is the classic Explain, an Ask stream; refused too.
    setDiscussAgentEnabled(false);
    await selectText(NIGHT);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(classic).toEqual([]);
  } finally {
    delete g.__WIKI_READONLY_WIKI__;
  }
  // Writable again, no agent: Enter runs the classic Explain.
  await selectText(NIGHT);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  expect(classic).toEqual([NIGHT]);
  // With the agent: Enter runs the default, an inline Explain turn.
  setDiscussAgentEnabled(true);
  await selectText(NIGHT);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  expect(posts.length).toBe(before + 1);
  expect(posts.at(-1)!.mode).toBe("explore");
  push!("turn", { turnId: "turn-3", seq: 3, discussionId: "thread-1" });
  push!("done", { answer: "ok", proposedEdit: null });
  close!();
  await settle();
});
