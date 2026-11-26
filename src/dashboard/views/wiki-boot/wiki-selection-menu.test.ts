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
 *   turn or the classic Explain stream (no agent).
 * - An action's press does not bring the bar back on the release that follows.
 * - An inline card's edit controls that need the tab show it (fix round 1
 *   batch 2): «Change the wording» opens it before filling its box, and an
 *   Apply that renders the page again (written, commit failed, or a lost answer
 *   the check finds written) opens it on the applied turn, which the render
 *   then focuses; an outcome with no render stays on the card while the card
 *   is there, else (closed or replaced while Apply ran) opens the tab on the
 *   turn (fix round 2 batch 2, R2-4).
 * - «Where else»/«History» answers (fix round 1 batch 3, F7): one with a PR row
 *   the route is refreshing (`stale: true`) is asked again, any answer is
 *   reused only within `MENTIONS_FRESH_MS`, and a page render (an Apply's)
 *   drops them; an ask while one is in flight shares it, and a late answer
 *   from before a render never drops the newer ask's.
 * - Explain where the thread cannot take the turn (F9): a second Explain
 *   while the first streams, and a selection in the article head, stream the
 *   classic `/api/wiki/explain` answer into their inline card instead of an
 *   error card (never in place of the page); «Add to Oppfølging» is still refused.
 * - A render of the same page (fix round 1 batch 4, F10) puts the open
 *   Explain card back under its passage, the same element, its turn still
 *   painting and its classic stream not aborted; at the article's top with a
 *   note when the passage is gone. Not after an Apply of its own turn, not
 *   once closed, and not on another page (its classic stream aborts). A
 *   passage the page shows twice comes back under the copy it was on; a
 *   rewritten paragraph whose words survive elsewhere sends it to the top
 *   with the note, never under that other copy (fix round 2 batch 2, R2-5).
 * - Keyboard (F11): ⇧F10 or the ContextMenu key opens the menu with focus on
 *   its first item, ↑/↓ move, Escape closes with focus off the hidden menu,
 *   and the browser's `contextmenu` that may follow the gesture is prevented;
 *   on a link it is the link's.
 * - Fix round 2 batch 1: Enter and ⇧F10 in a plain `[tabindex]` container
 *   (a Question card, a scrolling diagram box, a focused heading) are the
 *   bar's, and Escape puts focus back on it (R2-1); only a scroll that moves
 *   the selection closes the menu (R2-2); with no wiki agent, and on an
 *   explainer, Explain streams the classic answer into the card, its
 *   `answer_html` painted, a failure's status or refusal shown (R2-3).
 *   Element assertions there compare text or identity: a failing
 *   `expect(element)` prints the whole DOM, gigabytes of it.
 * - Discuss v2 PR 6 fix round 2 batch 4 (12c): a Trace card (`openTrace`,
 *   placed by `placeInlineCard`) leaves for good when another inline card
 *   replaces it, on the page or while out for a render, and its drop hook
 *   aborts its stream at once; while out for a render of its own page it is
 *   live (`inlineCardLive`), so a frame then neither aborts nor is lost.
 *
 * Own process: it installs happy-dom's globals and wires the tab's and the
 * menu's document listeners once, so it is alone in its `bun test` link.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { DISCUSS_TAB, initDiscussTab, setDiscussAgentEnabled } from "../components/wiki-discuss-tab.ts";
import { discussTabBodyHtml } from "../components/wiki-discuss-tab-view.ts";
import { LOST_APPLY_APPLIED } from "../components/wiki-discuss-state.ts";
import { MENTIONS_FRESH_MS, MOVED_UNFINDABLE, initSelectionMenu, inlineCardLive, placeInlineCard, setSelectionMenuPage, showSelectionBarForExplainer } from "../components/wiki-selection-menu.ts";
import { inlineCardHtml } from "../components/wiki-selection-menu-model.ts";
import { initKeyTrace, openTrace } from "../components/wiki-key-trace.ts";

const g = globalThis as unknown as Record<string, unknown>;
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();
const realFetch = globalThis.fetch;

const REL = "plans/ferry.mdx";
/** The page the menu's shell says is open (another one is a navigation). */
let menuRel = REL;
const posts: Record<string, unknown>[] = [];
/** The stream a POST answers with: its frames are pushed by the test. */
let push: ((event: string, data: unknown) => void) | null = null;
/** The newest POST's abort signal. */
let postSignal: AbortSignal | null = null;
/** While set, a Trace card's thread read (`?traceKey=`) waits for it; its signal is kept. */
let traceReadGate: Promise<void> | null = null;
let traceReadSignal: AbortSignal | null = null;
let close: (() => void) | null = null;
/** Every tab the shell was asked to show. */
const switched: string[] = [];
/** The pages rendered again after an Apply. */
let reloads = 0;
/** What the next Apply request is answered with. */
let applyAnswer: () => Response = () => json({ ok: true, committed: true });
/** While set, an Apply request (not a preview) waits for it: an Apply in flight. */
let applyGate: Promise<void> | null = null;
/** Answers for the preview requests that follow, before the default preview. */
const checkAnswers: (() => Response)[] = [];
const gateway = () => new Response("Bad Gateway", { status: 502 });
/** Every `GET /api/wiki/mentions` key asked, and whether its PR row is still being refreshed. */
const mentionsAsked: string[] = [];
let mentionsStale = false;
/** While set, a mentions request waits for it (an answer in flight). */
let mentionsGate: Promise<void> | null = null;
/** The next mentions request fails (500). */
let mentionsFailNext = false;
/** Every classic `/api/wiki/explain` stream the menu opened. */
const explainAsked: URL[] = [];
/** While set, an explain stream's frames are pushed by the test (`explainCtl`). */
let explainManual = false;
let explainCtl: { push: (event: string, data: unknown) => void; close: () => void; signal: AbortSignal | null } | null = null;
/** While set, an explain request is answered with this (a refusal, a failure). */
let explainAnswer: (() => Response) | null = null;
const EDIT_OLD = "The morning route adds a stop.";
const EDIT_NEW = "The morning route adds two stops.";

/** The shell's tab switch, as `switchConnTab` does it: the tab marked, its body shown. */
function showTab(tab: string): void {
  switched.push(tab);
  document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.toggle("active", tab === DISCUSS_TAB);
  document.getElementById("discussBody")!.style.display = tab === DISCUSS_TAB ? "flex" : "none";
}

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
    if (url === "/api/wiki/discuss/apply") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.preview === true && checkAnswers.length) return checkAnswers.shift()!();
      if (body.preview === true) return json({ ok: true, before: EDIT_OLD, after: EDIT_NEW, beforeCtx: "", afterCtx: "", fromLine: 9, toLine: 9, baseHash: "b1", previewHash: "p1" });
      if (applyGate) await applyGate;
      return applyAnswer();
    }
    if (url.startsWith("/api/wiki/mentions?")) {
      const key = new URL(url, "http://x").searchParams.get("key")!;
      mentionsAsked.push(key);
      const gate = mentionsGate;
      const fail = mentionsFailNext;
      mentionsFailNext = false;
      if (gate) await gate;
      if (fail) return json({ error: "boom" }, 500);
      return json({
        key, kind: "case", files: [{ relPath: REL, title: "Ferry", lines: [{ n: 9, text: NIGHT }] }], commits: [], log: [],
        prs: [{ repo: "o/r", number: 7, state: mentionsStale ? "unknown" : "merged", mergedAt: null, url: "https://github.com/o/r/pull/7", stale: mentionsStale }],
        totalLines: 1, totalFiles: 1, totalsAtLeast: false, truncated: false,
      });
    }
    if (url.startsWith("/api/wiki/explain?")) {
      const u = new URL(url, "http://x");
      explainAsked.push(u);
      if (explainAnswer) return explainAnswer();
      if (explainManual) {
        const enc = new TextEncoder();
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
        explainCtl = { push: (event, data) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => ctl.close(), signal: init?.signal ?? null };
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const frames = `event: delta\ndata: {"text":"CLASSIC "}\n\nevent: done\ndata: ${JSON.stringify({ answer: `CLASSIC for ${u.searchParams.get("sel")}` })}\n\nevent: end\ndata: {}\n\n`;
      return new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.startsWith("/api/wiki/discuss/thread?") && url.includes("traceKey=") && traceReadGate) {
      traceReadSignal = init?.signal ?? null;
      await traceReadGate;
    }
    if (url.startsWith("/api/wiki/discuss/thread?")) return json({ userId: "u1", bot: "b", thread: null, messages: [], closed: [], closedTotal: 0, oneShot: [] });
    if (url === "/api/wiki/discuss" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      postSignal = init.signal ?? null;
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
  initDiscussTab({
    wiki: () => "w",
    relPath: () => REL,
    switchTab: showTab,
    // The shell's render: the agent off, the article again (the card gone), the agent on.
    reload: () => {
      reloads++;
      setDiscussAgentEnabled(false);
      renderPage(EDIT_NEW);
    },
  });
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
function renderPage(morning = EDIT_OLD): void {
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2>${NIGHT}<br><br>${morning}<h2>Oppfølging</h2><ul><li>Check the berth list.</li></ul></div>`;
  setDiscussAgentEnabled(true);
  setSelectionMenuPage({ mentions: true, keyKinds: [{ name: "case", pattern: "MEL-\\d+" }] });
}

/** Select `text` in the article (or under `within`) and release the mouse there. */
async function selectText(text: string, within = ".wiki-article"): Promise<void> {
  const article = document.querySelector(within)!;
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
  expect(explainAsked.length).toBe(0);
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
    // No agent: Enter's default is the classic Explain stream; refused too.
    setDiscussAgentEnabled(false);
    await selectText(NIGHT);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(explainAsked.length).toBe(0);
  } finally {
    delete g.__WIKI_READONLY_WIKI__;
  }
  // Writable again, no agent: Enter runs the classic Explain.
  await selectText(NIGHT);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
  expect(explainAsked.map((u) => u.searchParams.get("sel"))).toEqual([NIGHT]);
  explainAsked.length = 0;
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

test("Enter on a link, a summary or another control is that control's: no turn, nothing prevented", async () => {
  renderPage();
  document.querySelector(".wiki-article")!.insertAdjacentHTML(
    "beforeend",
    `<p>See <a id="inLink" href="#x">the link</a>.</p><details><summary id="inSummary">More</summary>Folded.</details><span id="inTab" tabindex="0" role="slider">widget</span><span id="inKeys" tabindex="0" onkeydown="">keys</span><span id="inRole" role="button">act</span>`,
  );
  // Outside the article: the breadcrumb's «⌂» link.
  document.body.insertAdjacentHTML("afterbegin", `<div id="wikiBreadcrumb"><a id="crumbHome" href="/wiki">⌂</a></div>`);
  const before = posts.length;
  await selectText(NIGHT);
  for (const id of ["crumbHome", "inLink", "inSummary", "inTab", "inKeys", "inRole"]) {
    expect(barEl().style.display).toBe("flex");
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.getElementById(id)!.dispatchEvent(ev);
    await settle();
    expect([id, ev.defaultPrevented]).toEqual([id, false]);
    expect([id, posts.length]).toEqual([id, before]);
  }
  // On the article's own text Enter is the bar's: the instrument fires.
  const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  document.querySelector(".wiki-article")!.dispatchEvent(ev);
  await settle();
  expect(ev.defaultPrevented).toBe(true);
  expect(posts.length).toBe(before + 1);
  push!("turn", { turnId: "turn-4", seq: 4, discussionId: "thread-1" });
  push!("done", { answer: "ok", proposedEdit: null });
  close!();
  await settle();
  document.getElementById("wikiBreadcrumb")!.remove();
});

test("the read slice leaves only Copy: no bar, the browser's own right-click menu, Enter not taken", async () => {
  // happy-dom lays nothing out: the selection gets one rect at the page's corner.
  const proto = (globalThis as unknown as { Range: { prototype: { getClientRects: () => unknown } } }).Range.prototype;
  const realRects = proto.getClientRects;
  proto.getClientRects = () => [{ left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20 }];
  const rightClick = () => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    document.querySelector(".wiki-article")!.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const menuEl = () => document.getElementById("wikiSelMenu");
  try {
    renderPage();
    // As the pod's payload has it: no mentions route.
    setSelectionMenuPage({ mentions: false });
    // The full instance: the bar, and our menu on a right-click.
    await selectText(NIGHT);
    expect(barEl().style.display).toBe("flex");
    expect(rightClick()).toBe(true);
    expect(menuEl()!.style.display).toBe("block");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    document.body.classList.add("wiki-read-slice");
    const before = posts.length;
    await selectText(NIGHT);
    expect(barEl().style.display).toBe("none");
    expect(rightClick()).toBe(false);
    expect(menuEl()!.style.display).toBe("none");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.body.dispatchEvent(enter);
    await settle();
    expect(enter.defaultPrevented).toBe(false);
    expect(posts.length).toBe(before);
  } finally {
    document.body.classList.remove("wiki-read-slice");
    proto.getClientRects = realRects;
  }
});

/** «Add to Oppfølging» on the morning sentence, its turn ending with an edit
 *  the preview answers: the inline card offers Apply. The tab is not shown. */
async function followCardWithEdit(turnId: string, seq: number): Promise<Element> {
  renderPage();
  showTab("conn");
  switched.length = 0;
  // A press in the article takes focus from the tab's box.
  (document.activeElement as HTMLElement | null)?.blur?.();
  await selectText(EDIT_OLD);
  press(barEl().querySelector('[data-selact="follow"]')!);
  // The press's release, which the bar takes as its own.
  document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await settle();
  expect(posts.at(-1)).toMatchObject({ mode: "edit", selection: EDIT_OLD });
  push!("turn", { turnId, seq, discussionId: "thread-1" });
  push!("done", { answer: "Proposed.", proposedEdit: { edits: [{ old: EDIT_OLD, new: EDIT_NEW }], dropped: [], overLimit: false } });
  close!();
  await settle();
  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="follow"]')!;
  expect(card.querySelector('[data-edit-state="ready"] [data-discuss-apply]')).toBeTruthy();
  expect(document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.contains("active")).toBe(false);
  return card;
}

test("«Change the wording» on an inline card shows the tab, then fills and focuses its box", async () => {
  const card = await followCardWithEdit("turn-5", 5);
  (card.querySelector("[data-discuss-reword]") as HTMLButtonElement).click();
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(document.getElementById("discussBody")!.style.display).toBe("flex");
  const input = document.getElementById("wikiDiscussInput") as HTMLTextAreaElement;
  expect(input.value).toBe("Propose another wording for that edit, for the same passage: ");
  expect(document.activeElement).toBe(input);
});

test("Apply on an inline card with the tab closed: the tab opens on the applied turn, focused after the page renders again", async () => {
  const card = await followCardWithEdit("turn-6", 6);
  const key = card.getAttribute("data-sel-turn");
  const before = reloads;
  (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
  await settle();
  // The page was rendered again: the inline card went with it.
  expect(reloads).toBe(before + 1);
  expect(document.querySelector("#articleWrap .wiki-sel-card")).toBeNull();
  // The outcome is on the pane's turn, the tab shown and its note focused.
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.contains("active")).toBe(true);
  const done = document.querySelector(`#discussBody [data-turn-key="${key}"] [data-edit-state="applied"] .wiki-discuss-edit-done`);
  expect(done?.textContent).toBe("Applied to the page, with a log.md entry and a commit.");
  expect(document.activeElement).toBe(done);
});

test("Apply on an inline card whose commit failed: the tab shows that outcome too", async () => {
  const card = await followCardWithEdit("turn-7", 7);
  const key = card.getAttribute("data-sel-turn");
  applyAnswer = () => json({ ok: true, committed: false, uncommitted: true });
  try {
    (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
    await settle();
  } finally {
    applyAnswer = () => json({ ok: true, committed: true });
  }
  expect(switched).toEqual([DISCUSS_TAB]);
  const done = document.querySelector(`#discussBody [data-turn-key="${key}"] [data-edit-state="applied"] .wiki-discuss-edit-done`);
  expect(done?.textContent).toBe("Applied to the page, but the commit failed: the page now has changes no commit holds.");
  expect(document.activeElement).toBe(done);
});

test("Apply on an inline card whose answer was lost, the check finding it written: the tab shows that outcome", async () => {
  const card = await followCardWithEdit("turn-8", 8);
  const key = card.getAttribute("data-sel-turn");
  applyAnswer = gateway;
  checkAnswers.push(() => json({ ok: false, reason: "applied", error: "already applied" }, 409));
  try {
    (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
    await settle();
  } finally {
    applyAnswer = () => json({ ok: true, committed: true });
    checkAnswers.length = 0;
  }
  expect(switched).toEqual([DISCUSS_TAB]);
  const done = document.querySelector(`#discussBody [data-turn-key="${key}"] [data-edit-state="applied"] .wiki-discuss-edit-done`);
  expect(done?.textContent).toBe(LOST_APPLY_APPLIED);
  expect(document.activeElement).toBe(done);
});

test("a lost Apply the check cannot settle stays on the inline card; its «Check again» finding it written shows the tab", async () => {
  const card = await followCardWithEdit("turn-9", 9);
  const key = card.getAttribute("data-sel-turn");
  applyAnswer = gateway;
  checkAnswers.push(gateway, () => json({ ok: false, reason: "applied", error: "already applied" }, 409));
  try {
    (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
    await settle();
    // Nothing was rendered again: the card says so itself, the tab left closed.
    expect(card.isConnected).toBe(true);
    expect(switched).toEqual([]);
    const again = card.querySelector<HTMLButtonElement>("[data-discuss-repreview]");
    expect(again?.textContent).toBe("Check again");
    again!.click();
    await settle();
  } finally {
    applyAnswer = () => json({ ok: true, committed: true });
    checkAnswers.length = 0;
  }
  expect(switched).toEqual([DISCUSS_TAB]);
  const done = document.querySelector(`#discussBody [data-turn-key="${key}"] [data-edit-state="applied"] .wiki-discuss-edit-done`);
  expect(done?.textContent).toBe(LOST_APPLY_APPLIED);
  expect(document.activeElement).toBe(done);
});

/** A press on an action and the release that follows it (which the bar takes as its own). */
function act(el: Element): void {
  press(el);
  document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
}

/** «Where else» on the selected `MEL-12`, its card answered. */
async function whereElse(): Promise<Element> {
  await selectText("MEL-12");
  act(barEl().querySelector('[data-selact="where"]')!);
  await settle();
  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="where"]')!;
  expect(card.querySelector(`[data-sel-file="${REL}"]`)).toBeTruthy();
  return card;
}

test("«Where else» with a PR row the route is still refreshing is not kept: the next ask asks again", async () => {
  renderPage();
  mentionsAsked.length = 0;
  mentionsStale = true;
  try {
    const card = await whereElse();
    expect(card.querySelector(".wiki-sel-pr-state")!.textContent).toBe("not known yet");
    await whereElse();
  } finally {
    mentionsStale = false;
  }
  expect(mentionsAsked).toEqual(["MEL-12", "MEL-12"]);
  // Refreshed: its answer is reused, «History» on the key included.
  const card = await whereElse();
  expect(card.querySelector(".wiki-sel-pr-state")!.textContent).toBe("merged");
  await selectText("MEL-12");
  act(barEl().querySelector('[data-selact="history"]')!);
  await settle();
  expect(document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="history"]')).toBeTruthy();
  expect(mentionsAsked).toEqual(["MEL-12", "MEL-12", "MEL-12"]);
});

test("a mentions answer is reused only within its freshness window", async () => {
  renderPage();
  mentionsAsked.length = 0;
  await whereElse();
  await whereElse();
  expect(mentionsAsked).toEqual(["MEL-12"]);
  const realNow = Date.now;
  Date.now = () => realNow() + MENTIONS_FRESH_MS + 1;
  try {
    await whereElse();
  } finally {
    Date.now = realNow;
  }
  expect(mentionsAsked).toEqual(["MEL-12", "MEL-12"]);
});

test("«Where else» after an Apply renders the page again asks the route again", async () => {
  renderPage();
  mentionsAsked.length = 0;
  await whereElse();
  const card = await followCardWithEdit("turn-10", 10);
  const before = reloads;
  (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
  await settle();
  expect(reloads).toBe(before + 1);
  setDiscussAgentEnabled(true);
  await whereElse();
  expect(mentionsAsked).toEqual(["MEL-12", "MEL-12"]);
  // A plain render (navigation, an in-place reload) drops it too.
  renderPage();
  await whereElse();
  expect(mentionsAsked).toEqual(["MEL-12", "MEL-12", "MEL-12"]);
});

/** A gate a mentions request waits on, and its release. */
function hold(): () => void {
  let release!: () => void;
  mentionsGate = new Promise((r) => (release = r));
  return release;
}

test("an ask while the key's answer is in flight shares it: «Where else» then «History», one request", async () => {
  renderPage();
  mentionsAsked.length = 0;
  const release = hold();
  try {
    await selectText("MEL-12");
    act(barEl().querySelector('[data-selact="where"]')!);
    await settle();
    await selectText("MEL-12");
    act(barEl().querySelector('[data-selact="history"]')!);
    await settle();
    expect(mentionsAsked).toEqual(["MEL-12"]);
  } finally {
    mentionsGate = null;
    release();
  }
  await settle();
  expect(document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="history"] .wiki-sel-empty')?.textContent).toContain("No commit or log.md entry");
});

test("a failed answer from before a render does not drop the newer ask in flight", async () => {
  renderPage();
  mentionsAsked.length = 0;
  const releaseOld = hold();
  mentionsFailNext = true;
  await whereElseStart();
  // The page renders again while the old ask waits; a new ask goes out.
  renderPage();
  const releaseNew = hold();
  await whereElseStart();
  releaseOld();
  await settle();
  // The old one failed: the new one, still in flight, is shared by the next ask.
  await whereElseStart();
  mentionsGate = null;
  releaseNew();
  await settle();
  expect(mentionsAsked).toEqual(["MEL-12", "MEL-12"]);
  expect(document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="where"] [data-sel-file]')).toBeTruthy();
});

/** «Where else» on `MEL-12`, without waiting for its answer. */
async function whereElseStart(): Promise<void> {
  await selectText("MEL-12");
  act(barEl().querySelector('[data-selact="where"]')!);
  await flush();
}

test("Explain while the first inline Explain streams: the classic stream in its own card, no refusal; «Add to Oppfølging» is still refused", async () => {
  renderPage();
  explainAsked.length = 0;
  const before = posts.length;
  await selectText(NIGHT);
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  expect(posts.length).toBe(before + 1);
  push!("turn", { turnId: "turn-11", seq: 11, discussionId: "thread-1" });
  await settle();
  // The second selection, its Explain pressed while turn 11 streams.
  await selectText(EDIT_OLD);
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  expect(explainAsked.map((u) => u.searchParams.get("sel"))).toEqual([EDIT_OLD]);
  expect(posts.length).toBe(before + 1);
  // In a card under its paragraph, not in place of the page.
  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
  expect(card.hasAttribute("data-sel-turn")).toBe(false);
  expect(card.querySelector(".wiki-sel-card-sub")!.textContent).toContain("busy");
  expect(card.querySelector(".wiki-sel-card-body")!.textContent).toContain(`CLASSIC for ${EDIT_OLD}`);
  expect(card.querySelector(".wiki-discuss-error")).toBeNull();
  expect(card.previousSibling?.textContent).toBe(EDIT_OLD);
  // An Edit turn has no classic path: it says the discussion is busy.
  await selectText(EDIT_OLD);
  act(barEl().querySelector('[data-selact="follow"]')!);
  await settle();
  expect(document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="follow"] .wiki-discuss-error')?.textContent).toContain("still running");
  expect(explainAsked.length).toBe(1);
  push!("done", { answer: "ok", proposedEdit: null });
  close!();
  await settle();
});

test("Explain on a selection in the article head (no passage of the page): the classic stream in a card under the head", async () => {
  renderPage();
  explainAsked.length = 0;
  const before = posts.length;
  document.querySelector(".wiki-article")!.insertAdjacentHTML("beforebegin", `<div class="wiki-article-head"><h1>The ferry plan head</h1></div>`);
  await selectText("The ferry plan head", ".wiki-article-head");
  expect(barEl().style.display).toBe("flex");
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  expect(explainAsked.map((u) => u.searchParams.get("sel"))).toEqual(["The ferry plan head"]);
  expect(posts.length).toBe(before);
  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
  expect(card.querySelector(".wiki-sel-card-sub")!.textContent).toContain("outside the page's text");
  expect(card.querySelector(".wiki-sel-card-body")!.textContent).toContain("CLASSIC for The ferry plan head");
  // Right under the head, before the article.
  expect(card.previousElementSibling?.className).toBe("wiki-article-head");
  expect(card.nextElementSibling?.className).toBe("wiki-article");
});

test("the classic card's stream: a delta paints at once, an app_error shows its message, an end with no answer says so, a replaced card aborts", async () => {
  renderPage();
  document.querySelector(".wiki-article")!.insertAdjacentHTML("beforebegin", `<div class="wiki-article-head"><h1>The ferry plan head</h1></div>`);
  const explainHead = async () => {
    await selectText("The ferry plan head", ".wiki-article-head");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
  };
  const body = () => document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"] .wiki-sel-card-body')!;
  explainManual = true;
  try {
    await explainHead();
    explainCtl!.push("delta", { text: "PARTIAL so far" });
    await settle();
    expect(body().textContent).toContain("PARTIAL so far");
    // Another card replaces it: its next frame aborts the request.
    const first = explainCtl!;
    await whereElse();
    expect(first.signal?.aborted).toBe(false);
    first.push("delta", { text: " more" });
    await settle();
    expect(first.signal?.aborted).toBe(true);

    await explainHead();
    explainCtl!.push("app_error", { message: "The research bot is down." });
    await settle();
    expect(body().querySelector(".wiki-discuss-error")?.textContent).toBe("The research bot is down.");
    explainCtl!.close();

    await explainHead();
    explainCtl!.push("delta", { text: "half" });
    explainCtl!.close();
    await settle();
    expect(body().querySelector(".wiki-discuss-error")?.textContent).toBe("The explanation ended before its answer.");
  } finally {
    explainManual = false;
  }
});

/** Release the thread: the live turn ends (a stream already closed is left as it is). */
async function endTurn(): Promise<void> {
  try {
    push!("done", { answer: "ok", proposedEdit: null });
    close!();
  } catch {
    /* closed already */
  }
  await settle();
}

/** «Explain with context» on NIGHT, its turn started and painting. */
async function explainNight(turnId: string, seq: number): Promise<Element> {
  renderPage();
  await selectText(NIGHT);
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  push!("turn", { turnId, seq, discussionId: "thread-1" });
  push!("delta", { text: "BEFORE the render" });
  await settle();
  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"][data-sel-turn]')!;
  expect(card.querySelector(".wiki-discuss-answer")?.textContent).toContain("BEFORE the render");
  return card;
}

test("a render of the same page while an inline Explain streams: the same card is back under its paragraph, still painting its turn", async () => {
  try {
    const card = await explainNight("turn-20", 20);
    const key = card.getAttribute("data-sel-turn");
    // An Ask answer takes the pane (no page render): the card is out, and a
    // frame lands meanwhile, which no repaint of a card on the page can reach.
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-ask-view">An answer.</div>`;
    push!("delta", { text: " DURING" });
    await settle();
    // The page renders again (an in-place reload).
    renderPage();
    await settle();
    // The same element (a mismatch is compared by identity, not printed).
    expect(document.querySelector(`#articleWrap .wiki-sel-card[data-sel-turn="${key}"]`) === card).toBe(true);
    expect(card.previousSibling?.nodeName).toBe("BR");
    expect(card.nextSibling?.textContent).toBe(EDIT_OLD);
    expect(card.querySelector(".wiki-sel-card-moved")).toBeNull();
    // Painted when it came back, not only on the next frame.
    expect(card.querySelector(".wiki-discuss-answer")?.textContent).toContain("BEFORE the render DURING");
    push!("delta", { text: " AFTER it" });
    await settle();
    expect(card.querySelector(".wiki-discuss-answer")?.textContent).toContain("BEFORE the render DURING AFTER it");
  } finally {
    await endTurn();
  }
});

test("a render whose page no longer holds the passage: the card at the article's top, saying so", async () => {
  try {
    const card = await explainNight("turn-21", 21);
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2>${EDIT_OLD}<h2>Oppfølging</h2><ul><li>Check the berth list.</li></ul></div>`;
    setSelectionMenuPage({ mentions: true });
    await settle();
    const article = document.querySelector("#articleWrap .wiki-article")!;
    expect(article.firstElementChild === card).toBe(true);
    expect(card.querySelector(".wiki-sel-card-moved")?.textContent).toBe("The passage this answers is no longer on the page as it was.");
    // The passage back on a later render: under it again, the note gone.
    renderPage();
    await settle();
    expect(card.previousSibling?.nodeName).toBe("BR");
    expect(card.querySelector(".wiki-sel-card-moved")).toBeNull();
  } finally {
    await endTurn();
  }
});

test("the classic in-card stream survives a render of its page: not aborted, the card back under its paragraph and painting", async () => {
  try {
    await explainNight("turn-22", 22);
    explainManual = true;
    try {
      // The thread is busy: Explain on the morning sentence streams the classic answer.
      await selectText(EDIT_OLD);
      act(document.getElementById("wikiExplainBtn")!);
      await settle();
      const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]:not([data-sel-turn])')!;
      const ctl = explainCtl!;
      ctl.push("delta", { text: "CLASSIC before" });
      await settle();
      renderPage();
      // A frame between the render and the card's return paints into the same card.
      ctl.push("delta", { text: " during" });
      await settle();
      expect(ctl.signal?.aborted).toBe(false);
      expect(card.isConnected).toBe(true);
      expect(card.previousSibling?.textContent).toBe(EDIT_OLD);
      ctl.push("delta", { text: " after" });
      await settle();
      expect(card.querySelector(".wiki-sel-card-body")!.textContent).toContain("CLASSIC before during after");
      ctl.close();
    } finally {
      explainManual = false;
    }
  } finally {
    await endTurn();
  }
});

test("another page drops the open card for good and aborts its classic stream", async () => {
  try {
    await explainNight("turn-23", 23);
    explainManual = true;
    try {
      await selectText(EDIT_OLD);
      act(document.getElementById("wikiExplainBtn")!);
      await settle();
      const ctl = explainCtl!;
      menuRel = "plans/harbour.mdx";
      renderPage();
      await settle();
      expect(document.querySelector("#articleWrap .wiki-sel-card")).toBeNull();
      ctl.push("delta", { text: "late" });
      await settle();
      expect(ctl.signal?.aborted).toBe(true);
      // Back on the first page: the card stays gone.
      menuRel = REL;
      renderPage();
      await settle();
      expect(document.querySelector("#articleWrap .wiki-sel-card")).toBeNull();
    } finally {
      explainManual = false;
      menuRel = REL;
    }
  } finally {
    await endTurn();
  }
});

test("a closed card does not come back on a render", async () => {
  try {
    const card = await explainNight("turn-24", 24);
    (card.querySelector("[data-sel-card-close]") as HTMLButtonElement).click();
    renderPage();
    await settle();
    expect(document.querySelector("#articleWrap .wiki-sel-card")).toBeNull();
  } finally {
    await endTurn();
  }
});

test("Apply on an inline card: its render does not bring the card back, nor does a later render", async () => {
  const card = await followCardWithEdit("turn-25", 25);
  (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
  await settle();
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(document.querySelector("#articleWrap .wiki-sel-card")).toBeNull();
  renderPage(EDIT_NEW);
  await settle();
  expect(document.querySelector("#articleWrap .wiki-sel-card")).toBeNull();
});

test("a passage the page shows twice: the card comes back under the copy it was on", async () => {
  const twice = () => {
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2><p>First: ${NIGHT}</p><p>Second: ${NIGHT}</p><h2>Oppfølging</h2><ul><li>Check the berth list.</li></ul></div>`;
    setSelectionMenuPage({ mentions: true });
  };
  try {
    twice();
    await selectText(NIGHT, ".wiki-article p:nth-of-type(2)");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    push!("turn", { turnId: "turn-26", seq: 26, discussionId: "thread-1" });
    await settle();
    const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-turn]')!;
    expect(card.previousElementSibling?.textContent).toBe(`Second: ${NIGHT}`);
    twice();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.previousElementSibling?.textContent).toBe(`Second: ${NIGHT}`);
  } finally {
    await endTurn();
  }
});

// Fix round 2 batch 2, R2-5: the selected paragraph rewritten while its words
// survive in another one. A copy whose surroundings differ is not the passage:
// the card goes to the article's top with the note, not under that copy.
test("R2-5: the selected paragraph rewritten, the phrase still in another one: the card at the article's top with the note, not under the other copy", async () => {
  const PHRASE = "about the harbour timetable";
  const filler = (rewrite: string | null) => {
    const ps = Array.from({ length: 70 }, (_, i) => `<p>${i + 1 === 5 && rewrite !== null ? rewrite : `Filler paragraph ${i + 1} ${PHRASE} and the ferry berths.`}</p>`);
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2>${ps.join("")}<h2>Oppfølging</h2><ul><li>Check the berth list.</li></ul></div>`;
    setDiscussAgentEnabled(true);
    setSelectionMenuPage({ mentions: true });
  };
  try {
    filler(null);
    await selectText(PHRASE, ".wiki-article p:nth-of-type(5)");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    push!("turn", { turnId: "turn-44", seq: 44, discussionId: "thread-1" });
    await settle();
    const card = document.querySelector("#articleWrap .wiki-sel-card[data-sel-turn]")!;
    expect(card.previousElementSibling?.textContent).toBe(`Filler paragraph 5 ${PHRASE} and the ferry berths.`);
    // The same page again: under paragraph 5 still.
    filler(null);
    await settle();
    expect(card.previousElementSibling?.textContent).toBe(`Filler paragraph 5 ${PHRASE} and the ferry berths.`);
    expect(card.querySelector(".wiki-sel-card-moved") === null).toBe(true);
    // Paragraph 5 rewritten: the phrase is only in the others now.
    filler("Paragraph 5 now covers the bus schedule instead.");
    await settle();
    expect(card.isConnected).toBe(true);
    expect(document.querySelector("#articleWrap .wiki-article")!.firstElementChild === card).toBe(true);
    expect(card.previousElementSibling === null).toBe(true);
    expect(card.querySelector(".wiki-sel-card-moved")?.textContent).toBe("The passage this answers is no longer on the page as it was.");
  } finally {
    await endTurn();
  }
});

// R2-5's rule takes no copy from several when the card holds no context, so
// a card whose selection was no passage (the article head) gets its context
// read off the article pane: its head copy, also in the body, comes back.
test("R2-5: a classic card on a head selection the body repeats comes back under the head, not at the top with the note", async () => {
  const HEAD = "The ferry plan head";
  const render = () => {
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article-head"><h1>${HEAD}</h1></div><div class="wiki-article"><h2>Brief</h2>${HEAD} names this page.<br><br>${NIGHT}</div>`;
    setDiscussAgentEnabled(true);
    setSelectionMenuPage({ mentions: true });
  };
  explainManual = true;
  try {
    render();
    await selectText(HEAD, ".wiki-article-head");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
    expect(card.previousElementSibling?.className).toBe("wiki-article-head");
    render();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.previousElementSibling?.className).toBe("wiki-article-head");
    expect(card.querySelector(".wiki-sel-card-moved") === null).toBe(true);
    explainCtl?.close();
  } finally {
    explainManual = false;
  }
});

const key = (target: EventTarget, k: string, shiftKey = false) => {
  const ev = new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};

test("⇧F10 and the ContextMenu key: the menu with focus on its first item, ↓/↑ move, Escape closes with focus off it; the browser's menu after the gesture is prevented; on a link it is the link's", async () => {
  renderPage();
  const menuEl = () => document.getElementById("wikiSelMenu")!;
  const focusedAct = () => (document.activeElement as HTMLElement | null)?.getAttribute("data-selact") ?? null;
  for (const gesture of [["F10", true], ["ContextMenu", false]] as const) {
    await selectText(NIGHT);
    expect(key(document.body, gesture[0], gesture[1]).defaultPrevented).toBe(true);
    expect(menuEl().style.display).toBe("block");
    expect(focusedAct()).toBe("explain");
    // The browser's own context menu the gesture may still send: not over ours.
    const ctx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(ctx);
    expect(ctx.defaultPrevented).toBe(true);
    expect(focusedAct()).toBe("explain");
    expect(key(document.activeElement!, "ArrowDown").defaultPrevented).toBe(true);
    expect(focusedAct()).toBe("where");
    key(document.activeElement!, "ArrowUp");
    expect(focusedAct()).toBe("explain");
    key(document.activeElement!, "Escape");
    expect(menuEl().style.display).toBe("none");
    expect(menuEl().contains(document.activeElement)).toBe(false);
    expect(window.getSelection()!.toString()).toBe(NIGHT);
  }
  // Focus on a link in the article: ⇧F10 is the link's, nothing prevented.
  document.querySelector(".wiki-article")!.insertAdjacentHTML("beforeend", `<a href="#x" id="selLink">x</a>`);
  await selectText(NIGHT);
  const link = document.getElementById("selLink")!;
  link.focus();
  expect(key(link, "F10", true).defaultPrevented).toBe(false);
  expect(menuEl().style.display).toBe("none");
});

// ── Fix round 2 batch 1 ──────────────────────────────────────────────────

test("R2-1: Enter and ⇧F10 in a plain [tabindex] container (a Question card, a scrolling diagram box, a jumped-to heading) are the bar's; Escape puts focus back on the container", async () => {
  renderPage();
  const article = document.querySelector(".wiki-article")!;
  article.insertAdjacentHTML(
    "beforeend",
    `<section class="question" id="inQuestion" tabindex="-1"><p>QUESTION card text here.</p></section>` +
      `<div class="diagram-body" id="inBox" role="region" aria-label="Diagram" tabindex="0"><p>DIAGRAM box text here.</p></div>` +
      `<h3 id="inHeading" tabindex="-1">HEADING jumped to</h3>`,
  );
  const menuEl = () => document.getElementById("wikiSelMenu")!;
  for (const [id, text] of [["inQuestion", "QUESTION card text"], ["inBox", "DIAGRAM box text"], ["inHeading", "HEADING jumped"]] as const) {
    const box = document.getElementById(id)!;
    await selectText(text, `#${id}`);
    // A mouse selection inside it focuses it.
    box.focus();
    expect(document.activeElement === box).toBe(true);
    const before = posts.length + explainAsked.length;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    box.dispatchEvent(enter);
    await settle();
    expect([id, enter.defaultPrevented]).toEqual([id, true]);
    expect([id, posts.length + explainAsked.length]).toEqual([id, before + 1]);
    await endTurn();
    // ⇧F10 there: our menu on its first item; Escape puts focus back on the container.
    await selectText(text, `#${id}`);
    box.focus();
    expect([id, key(box, "F10", true).defaultPrevented]).toEqual([id, true]);
    expect([id, menuEl().style.display]).toEqual([id, "block"]);
    expect((document.activeElement as HTMLElement).getAttribute("data-selact")).toBe("explain");
    key(document.activeElement!, "Escape");
    expect([id, menuEl().style.display]).toEqual([id, "none"]);
    expect([id, document.activeElement === box]).toEqual([id, true]);
  }
  // The menu opened from the page itself: Escape leaves focus on the page, as before.
  (document.activeElement as HTMLElement).blur();
  await selectText(NIGHT);
  key(document.body, "F10", true);
  key(document.activeElement!, "Escape");
  expect(document.activeElement === document.body).toBe(true);
});

test("R2-2: a scroll that does not move the selection leaves the menu open; the article's, the document's or its own scroller's closes it", async () => {
  renderPage();
  document.querySelector(".wiki-article")!.insertAdjacentHTML("beforeend", `<pre id="inCode"><code>CODE line that scrolls sideways</code></pre>`);
  const menuEl = () => document.getElementById("wikiSelMenu")!;
  const scroll = (t: EventTarget) => t.dispatchEvent(new Event("scroll", { bubbles: false }));
  const openMenu = async (text = NIGHT, within?: string) => {
    await selectText(text, within);
    key(document.body, "F10", true);
    expect(menuEl().style.display).toBe("block");
  };
  await openMenu();
  // The Discuss pane following its stream, and a code block beside the selection.
  scroll(document.getElementById("discussBody")!);
  scroll(document.getElementById("inCode")!);
  await settle();
  expect(menuEl().style.display).toBe("block");
  scroll(document.getElementById("articleWrap")!);
  expect(menuEl().style.display).toBe("none");
  await openMenu();
  scroll(document);
  expect(menuEl().style.display).toBe("none");
  // A selection in the code block: its own sideways scroll moves it.
  await openMenu("CODE line", "#inCode");
  scroll(document.getElementById("inCode")!);
  expect(menuEl().style.display).toBe("none");
});

test("R2-3: no wiki agent: Explain streams the classic answer into a card under the paragraph, its answer_html rendered; no turn", async () => {
  renderPage();
  setDiscussAgentEnabled(false);
  explainAsked.length = 0;
  const before = posts.length;
  explainManual = true;
  try {
    await selectText(NIGHT);
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    expect(explainAsked.map((u) => u.searchParams.get("sel"))).toEqual([NIGHT]);
    expect(posts.length).toBe(before);
    const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
    expect(card.hasAttribute("data-sel-turn")).toBe(false);
    // Under the paragraph, the page kept; no sub line (no discussion to be outside of).
    expect(card.previousSibling?.nodeName).toBe("BR");
    expect(card.nextSibling?.textContent).toBe(EDIT_OLD);
    expect(card.querySelector(".wiki-sel-card-sub")?.textContent ?? null).toBeNull();
    const body = card.querySelector(".wiki-sel-card-body")!;
    // The route's order: deltas, done, the server's answer_html, end.
    explainCtl!.push("delta", { text: "plain **so far**" });
    await settle();
    expect(body.textContent).toContain("plain");
    explainCtl!.push("done", { answer: "plain **whole**" });
    explainCtl!.push("answer_html", { html: `<p>SERVER <strong id="srvHtml">rendered</strong> answer</p>` });
    explainCtl!.push("end", {});
    explainCtl!.close();
    await settle();
    expect(body.querySelector("#srvHtml")?.textContent).toBe("rendered");
    expect(body.textContent).toContain("SERVER rendered answer");
    expect(body.querySelector(".wiki-discuss-error")?.textContent ?? null).toBeNull();
  } finally {
    explainManual = false;
    setDiscussAgentEnabled(true);
  }
});

test("R2-3: no wiki agent, a passage the page shows twice: the classic card comes back under the copy it was on", async () => {
  const twice = () => {
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2><p>First: ${NIGHT}</p><p>Second: ${NIGHT}</p></div>`;
    setSelectionMenuPage({ mentions: true });
  };
  // Another page first: no card an earlier test holds comes back here.
  menuRel = "plans/harbour.mdx";
  renderPage();
  await settle();
  menuRel = REL;
  setDiscussAgentEnabled(false);
  explainManual = true;
  try {
    twice();
    await settle();
    expect(document.querySelector("#articleWrap .wiki-sel-card")?.textContent ?? null).toBeNull();
    await selectText(NIGHT, ".wiki-article p:nth-of-type(2)");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]:not([data-sel-turn])')!;
    expect(card.previousElementSibling?.textContent).toBe(`Second: ${NIGHT}`);
    twice();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.previousElementSibling?.textContent).toBe(`Second: ${NIGHT}`);
    explainCtl!.close();
  } finally {
    explainManual = false;
    setDiscussAgentEnabled(true);
  }
});

test("R2-3: the classic card names a failed request's status, and a refusal's own message; never «ended before its answer»", async () => {
  renderPage();
  setDiscussAgentEnabled(false);
  const body = () => document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"] .wiki-sel-card-body')!;
  try {
    for (const [answer, want] of [
      [() => new Response("Internal Server Error", { status: 500 }), "The explanation failed (500)."],
      [() => json({ error: "This wiki is read-only." }, 403), "The explanation failed: This wiki is read-only. (403)."],
    ] as const) {
      explainAnswer = answer;
      await selectText(NIGHT);
      act(document.getElementById("wikiExplainBtn")!);
      await settle();
      expect(body().querySelector(".wiki-discuss-error")?.textContent).toBe(want);
    }
  } finally {
    explainAnswer = null;
    setDiscussAgentEnabled(true);
  }
});

test("R2-3: an explainer's Explain is a card before its frame, the page kept", async () => {
  document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article-head"><h1>Explainer</h1></div><iframe class="wiki-explainer-frame"></iframe>`;
  setSelectionMenuPage({ mentions: true });
  explainAsked.length = 0;
  const before = posts.length;
  showSelectionBarForExplainer("A passage in the frame", "Frame heading");
  expect(barEl().style.display).toBe("flex");
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  expect(explainAsked.map((u) => [u.searchParams.get("sel"), u.searchParams.get("ctx")])).toEqual([["A passage in the frame", "Frame heading"]]);
  expect(posts.length).toBe(before);
  const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
  expect(card.nextElementSibling?.className).toBe("wiki-explainer-frame");
  // Straight to the classic stream: not a refused thread turn's fallback, which names why.
  expect(card.querySelector(".wiki-sel-card-sub")?.textContent ?? null).toBeNull();
  expect(card.querySelector(".wiki-sel-card-body")!.textContent).toContain("CLASSIC for A passage in the frame");
  expect(document.querySelector("#articleWrap .wiki-article-head h1")?.textContent).toBe("Explainer");
});

// Fix round 2 batch 2, R2-4: an Apply pressed on the inline card whose outcome
// renders nothing stays on the card only while the card is there to show it.
// Closed (✕) or replaced by another card while Apply ran, the outcome opens the
// Discuss tab on the turn; with the card still there, the tab stays closed.
const STALE = "The page changed since the preview: preview it again.";
const stale = () => json({ ok: false, stale: true, error: STALE }, 409);
const tabActive = () => document.querySelector(`[data-conntab="${DISCUSS_TAB}"]`)!.classList.contains("active");
const paneEdit = (key: string | null) => document.querySelector(`#discussBody [data-turn-key="${key}"] .wiki-discuss-edit`);

/** Apply pressed and held in flight; `meanwhile` runs; then the route answers `answer`. */
async function applyHeld(card: Element, answer: () => Response, meanwhile: () => Promise<void>): Promise<void> {
  let release!: () => void;
  applyGate = new Promise<void>((r) => (release = r));
  applyAnswer = answer;
  try {
    (card.querySelector("[data-discuss-apply]") as HTMLButtonElement).click();
    await settle();
    expect(card.querySelector("[data-discuss-apply]")?.textContent).toBe("Applying…");
    await meanwhile();
    release();
    await settle();
  } finally {
    applyGate = null;
    applyAnswer = () => json({ ok: true, committed: true });
    checkAnswers.length = 0;
  }
}

const closeCard = (card: Element) => async () => {
  (card.querySelector("[data-sel-card-close]") as HTMLButtonElement).click();
  expect(card.isConnected).toBe(false);
};

test("R2-4: an inline Apply refused after its card was closed: the Discuss tab shows the turn's refusal, scrolled to", async () => {
  const card = await followCardWithEdit("turn-45", 45);
  const key = card.getAttribute("data-sel-turn");
  // Which turns the pane scrolls into view.
  const proto = (globalThis as unknown as { HTMLElement: { prototype: { scrollIntoView: (...a: unknown[]) => void } } }).HTMLElement.prototype;
  const realScroll = proto.scrollIntoView;
  const scrolled: (string | null)[] = [];
  proto.scrollIntoView = function (this: Element) {
    if (this.closest("#discussBody")) scrolled.push(this.getAttribute("data-turn-key"));
  };
  try {
    await applyHeld(card, stale, closeCard(card));
  } finally {
    proto.scrollIntoView = realScroll;
  }
  expect(scrolled).toContain(key);
  expect(document.querySelectorAll("#articleWrap .wiki-sel-card").length).toBe(0);
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(tabActive()).toBe(true);
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("refused");
  expect(paneEdit(key)?.textContent).toContain(STALE);
});

test("R2-4: an inline Apply refused after another card replaced it: the Discuss tab shows the turn's refusal", async () => {
  const card = await followCardWithEdit("turn-46", 46);
  const key = card.getAttribute("data-sel-turn");
  await applyHeld(card, stale, async () => {
    await whereElse();
    expect(card.isConnected).toBe(false);
  });
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(tabActive()).toBe(true);
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("refused");
  expect(paneEdit(key)?.textContent).toContain(STALE);
});

test("R2-4: an inline Apply whose answer was lost, unsettled after its card was closed: the Discuss tab, with «Check again»", async () => {
  const card = await followCardWithEdit("turn-47", 47);
  const key = card.getAttribute("data-sel-turn");
  checkAnswers.push(gateway);
  await applyHeld(card, gateway, closeCard(card));
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(tabActive()).toBe(true);
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("failed");
  expect(document.querySelector(`#discussBody [data-turn-key="${key}"] [data-discuss-repreview]`)?.textContent).toBe("Check again");
  // Settled by the reader (Discard): later tests start inline turns again.
  (document.querySelector(`#discussBody [data-turn-key="${key}"] [data-discuss-discard]`) as HTMLButtonElement).click();
  expect(paneEdit(key) === null || paneEdit(key)?.getAttribute("data-edit-state") === "discarded").toBe(true);
});

test("R2-4: an inline Apply refused with its card still there: the card shows the refusal, the tab stays closed", async () => {
  const card = await followCardWithEdit("turn-48", 48);
  await applyHeld(card, stale, async () => {});
  expect(card.isConnected).toBe(true);
  expect(switched).toEqual([]);
  expect(tabActive()).toBe(false);
  expect(card.querySelector(".wiki-discuss-edit")?.getAttribute("data-edit-state")).toBe("refused");
  expect(card.querySelector(".wiki-discuss-edit")?.textContent).toContain(STALE);
});

// ── Class check (round 3) ───────────────────────────────────────────────
// Surface 1: where a held card goes back. The context is read off the live
// range in DOM order (`holdPassage`), so a triple-click's element-boundary
// end and DecisionLog items shown newest first come back on an unchanged page.

test("class check S1: a triple-clicked head title the body repeats comes back under the head on an unchanged page", async () => {
  const HEAD = "The ferry plan head";
  const render = () => {
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article-head"><h1>${HEAD}</h1><div class="wiki-meta">Plan · updated today</div></div><div class="wiki-article"><h2>Brief</h2>${HEAD} names this page.<br><br>${NIGHT}</div>`;
    setDiscussAgentEnabled(true);
    setSelectionMenuPage({ mentions: true });
  };
  explainManual = true;
  try {
    render();
    // Where a triple-click ends: on the next block's start, not in the title's text.
    const h1 = document.querySelector(".wiki-article-head h1")!;
    const r = document.createRange();
    r.setStart(h1.firstChild!, 0);
    r.setEnd(h1.nextElementSibling!, 0);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await settle();
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
    expect(card.previousElementSibling?.className).toBe("wiki-article-head");
    render();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.previousElementSibling?.className).toBe("wiki-article-head");
    expect(card.querySelector(".wiki-sel-card-moved")?.textContent ?? null).toBeNull();
    explainCtl?.close();
  } finally {
    explainManual = false;
  }
});

test("class check S1: a selection across two DecisionLog items shown newest first comes back in its item on an unchanged page", async () => {
  const render = () => {
    document.getElementById("articleWrap")!.innerHTML =
      `<div class="wiki-article"><h2>Brief</h2><section class="decision-log"><ul class="dl-list">` +
      `<li class="dl-item" id="d2" data-dl-order="1" data-dl-sep=" — ">D2 Keep the night route.</li>` +
      `<li class="dl-item" id="d1" data-dl-order="0" data-dl-sep=" — ">D1 Use the flat file. The berth list stays in one place.</li>` +
      `</ul></section><p>${NIGHT}</p></div>`;
    setDiscussAgentEnabled(true);
    setSelectionMenuPage({ mentions: true });
  };
  try {
    render();
    const d2 = document.getElementById("d2")!.firstChild as Text;
    const d1 = document.getElementById("d1")!.firstChild as Text;
    const r = document.createRange();
    r.setStart(d2, d2.data.indexOf("Keep the night"));
    r.setEnd(d1, d1.data.indexOf("Use the flat") + "Use the flat".length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await settle();
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    push!("turn", { turnId: "turn-60", seq: 60, discussionId: "thread-1" });
    await settle();
    const card = document.querySelector("#articleWrap .wiki-sel-card[data-sel-turn]")!;
    expect(card.parentElement?.id).toBe("d1");
    render();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.parentElement?.id).toBe("d1");
    expect(card.querySelector(".wiki-sel-card-moved")?.textContent ?? null).toBeNull();
  } finally {
    await endTurn();
  }
});

test("class check S1: a selection with no text the page can be searched for (a diagram label) says so when the page renders again", async () => {
  const render = () => {
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2><p>${NIGHT}</p><svg><text id="lbl">Berth node label</text></svg><p>The morning route adds a stop.</p></div>`;
    setDiscussAgentEnabled(false);
    setSelectionMenuPage({ mentions: true });
  };
  explainManual = true;
  try {
    render();
    await selectText("Berth node label", "#lbl");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    const card = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]')!;
    expect(card).toBeTruthy();
    render();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(document.querySelector("#articleWrap .wiki-article")!.firstElementChild === card).toBe(true);
    expect(card.querySelector(".wiki-sel-card-moved")?.textContent).toBe(MOVED_UNFINDABLE);
    explainCtl?.close();
  } finally {
    explainManual = false;
    setDiscussAgentEnabled(true);
  }
});

// Surface 2: an inline Apply's outcome is always seen. A new inline turn is
// held off while an Apply runs or its lost answer is not settled: it would
// become the current turn and hide that outcome («A newer turn follows»).

test("class check S2: Explain from another selection while an inline Apply runs is the classic card, naming the Apply; the 409 then shows on the Discuss tab", async () => {
  const card = await followCardWithEdit("turn-61", 61);
  const key = card.getAttribute("data-sel-turn");
  const before = posts.length;
  explainAsked.length = 0;
  await applyHeld(card, stale, async () => {
    await selectText(NIGHT);
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    expect(card.isConnected).toBe(false);
    // No new turn: the classic stream in its own card, saying why.
    expect(posts.length).toBe(before);
    expect(explainAsked.map((u) => u.searchParams.get("sel"))).toEqual([NIGHT]);
    const classic = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"]:not([data-sel-turn])')!;
    expect(classic.querySelector(".wiki-sel-card-sub")?.textContent).toBe("· an Apply in the page's discussion is still running, so not in it");
  });
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(tabActive()).toBe(true);
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("refused");
  expect(paneEdit(key)?.textContent).toContain(STALE);
  expect(paneEdit(key)?.textContent).not.toContain("A newer turn follows");
});

test("class check S2: «Add to Oppfølging» while an inline Apply runs is refused in its card, saying why; no turn starts", async () => {
  const card = await followCardWithEdit("turn-62", 62);
  const before = posts.length;
  await applyHeld(card, stale, async () => {
    await selectText(NIGHT);
    act(barEl().querySelector('[data-selact="follow"]')!);
    await settle();
    expect(posts.length).toBe(before);
    const err = document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="follow"] .wiki-discuss-error');
    expect(err?.textContent).toBe("This page's discussion has an Apply still running: ask when it has ended.");
  });
  expect(posts.length).toBe(before);
});

test("class check S2: a lost Apply not settled holds off a new inline turn; its «Check again» keeps working and settles it; Discard frees it", async () => {
  const card = await followCardWithEdit("turn-63", 63);
  const key = card.getAttribute("data-sel-turn");
  const before = posts.length;
  checkAnswers.push(gateway);
  await applyHeld(card, gateway, async () => {});
  expect(card.querySelector("[data-discuss-repreview]")?.textContent).toBe("Check again");
  // Explain elsewhere: the classic card, naming why; no turn takes the Apply's place.
  await selectText(NIGHT);
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  expect(posts.length).toBe(before);
  expect(document.querySelector('#articleWrap .wiki-sel-card[data-sel-card="explain"] .wiki-sel-card-sub')?.textContent).toBe("· an Apply in the page's discussion has no known outcome yet, so not in it");
  // The card was replaced: the turn is still the current one, «Check again» in the pane works.
  const again = document.querySelector<HTMLButtonElement>(`#discussBody [data-turn-key="${key}"] [data-discuss-repreview]`);
  expect(again?.textContent).toBe("Check again");
  checkAnswers.push(gateway);
  again!.click();
  await settle();
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("failed");
  expect(paneEdit(key)?.textContent).not.toContain("A newer turn follows");
  // Discard settles it by hand: a new inline turn starts again.
  (document.querySelector(`#discussBody [data-turn-key="${key}"] [data-discuss-discard]`) as HTMLButtonElement).click();
  await selectText(NIGHT);
  act(document.getElementById("wikiExplainBtn")!);
  await settle();
  expect(posts.length).toBe(before + 1);
  await endTurn();
});

test("class check S2: a pane Apply refused while the reader is on another tab leaves the tab as the reader set it", async () => {
  const card = await followCardWithEdit("turn-64", 64);
  const key = card.getAttribute("data-sel-turn");
  // The same turn in the pane: its Apply pressed there.
  showTab(DISCUSS_TAB);
  switched.length = 0;
  let release!: () => void;
  applyGate = new Promise<void>((r) => (release = r));
  applyAnswer = stale;
  const proto = (globalThis as unknown as { HTMLElement: { prototype: { scrollIntoView: (...a: unknown[]) => void } } }).HTMLElement.prototype;
  const realScroll = proto.scrollIntoView;
  const scrolled: (string | null)[] = [];
  proto.scrollIntoView = function (this: Element) {
    if (this.closest("#discussBody")) scrolled.push(this.getAttribute("data-turn-key"));
  };
  try {
    (document.querySelector(`#discussBody [data-turn-key="${key}"] [data-discuss-apply]`) as HTMLButtonElement).click();
    await settle();
    // The card is closed and the reader moves to another tab while it runs.
    (card.querySelector("[data-sel-card-close]") as HTMLButtonElement).click();
    showTab("conn");
    switched.length = 0;
    release();
    await settle();
  } finally {
    proto.scrollIntoView = realScroll;
    applyGate = null;
    applyAnswer = () => json({ ok: true, committed: true });
  }
  expect(switched).toEqual([]);
  expect(tabActive()).toBe(false);
  expect(scrolled).toEqual([]);
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("refused");
});

/** Give `el` a laid-out box, or none, for the visibility checks (happy-dom lays nothing out). */
function boxOf(el: Element, has: () => boolean): void {
  (el as unknown as { getClientRects: () => unknown[] }).getClientRects = () => (has() ? [{ width: 100, height: 20 }] : []);
}

test("class check S2: an inline Apply refused while its card is hidden with its text (graph mode) shows on the Discuss tab", async () => {
  const card = await followCardWithEdit("turn-65", 65);
  const key = card.getAttribute("data-sel-turn");
  const wrap = document.getElementById("articleWrap")!;
  try {
    boxOf(wrap, () => true);
    await applyHeld(card, stale, async () => {
      // Graph mode hides the article, and the card in it, while Apply runs.
      boxOf(card, () => false);
    });
  } finally {
    delete (wrap as unknown as Record<string, unknown>).getClientRects;
  }
  expect(card.isConnected).toBe(true);
  expect(switched).toEqual([DISCUSS_TAB]);
  expect(tabActive()).toBe(true);
  expect(paneEdit(key)?.getAttribute("data-edit-state")).toBe("refused");
});

// Surface 3: the card and the bar stay where the reader sees them.

test("class check S3: a selection ending inside a scroller: that scroller's scroll moves it (the menu closes); one beside it does not", async () => {
  renderPage();
  document.querySelector(".wiki-article")!.insertAdjacentHTML("beforeend", `<p id="lead">Lead words before the box.</p><pre id="box"><code>BOX line that scrolls sideways</code></pre><pre id="beside"><code>Another box</code></pre>`);
  const menuEl = () => document.getElementById("wikiSelMenu")!;
  const scroll = (t: EventTarget) => t.dispatchEvent(new Event("scroll", { bubbles: false }));
  const lead = document.getElementById("lead")!.firstChild as Text;
  const box = document.querySelector("#box code")!.firstChild as Text;
  const open = async (r: Range) => {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await settle();
    key(document.body, "F10", true);
    expect(menuEl().style.display).toBe("block");
  };
  // Starts before the box, ends inside it: the bar sits at that end.
  const endsIn = document.createRange();
  endsIn.setStart(lead, 0);
  endsIn.setEnd(box, 8);
  await open(endsIn);
  scroll(document.getElementById("beside")!);
  await settle();
  expect(menuEl().style.display).toBe("block");
  scroll(document.getElementById("box")!);
  expect(menuEl().style.display).toBe("none");
  // Starts inside it, ends after it.
  const startsIn = document.createRange();
  startsIn.setStart(box, 4);
  startsIn.setEnd(document.querySelector("#beside code")!.firstChild!, 3);
  await open(startsIn);
  scroll(document.getElementById("box")!);
  expect(menuEl().style.display).toBe("none");
});

test("class check S3: a card is shown exactly while its text is: an explainer's card hides with the frame in graph mode", async () => {
  const wrap = document.getElementById("articleWrap")!;
  wrap.innerHTML = `<div class="wiki-article-head"><h1>Explainer</h1></div><iframe class="wiki-explainer-frame"></iframe>`;
  setSelectionMenuPage({ mentions: true });
  const frame = wrap.querySelector(".wiki-explainer-frame")!;
  try {
    boxOf(wrap, () => true);
    // The reader's CSS: graph mode hides the frame.
    boxOf(frame, () => !wrap.classList.contains("wiki-graph-on"));
    showSelectionBarForExplainer("A passage in the frame", "Frame heading");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    const card = wrap.querySelector<HTMLElement>(".wiki-sel-card")!;
    expect(card.nextElementSibling === frame).toBe(true);
    expect(card.style.display).toBe("");
    wrap.classList.add("wiki-graph-on");
    await settle();
    expect(card.style.display).toBe("none");
    wrap.classList.remove("wiki-graph-on");
    await settle();
    expect(card.style.display).toBe("");
  } finally {
    wrap.classList.remove("wiki-graph-on");
    delete (wrap as unknown as Record<string, unknown>).getClientRects;
  }
});

test("class check S3: a card beside a head line Overview hides goes with it, and comes back with it", async () => {
  const wrap = document.getElementById("articleWrap")!;
  wrap.innerHTML = `<div class="wiki-article-head"><h1>Ferry</h1><div class="wiki-series-head">Series: the ferry plans</div></div><div class="wiki-article lens-all"><p>${NIGHT}</p></div>`;
  setDiscussAgentEnabled(true);
  setSelectionMenuPage({ mentions: true });
  const series = wrap.querySelector(".wiki-series-head")!;
  const article = wrap.querySelector(".wiki-article")!;
  try {
    boxOf(wrap, () => true);
    boxOf(series, () => !article.classList.contains("lens-overview"));
    await selectText("the ferry plans", ".wiki-series-head");
    act(barEl().querySelector('[data-selact="where"]')!);
    await settle();
    const card = wrap.querySelector<HTMLElement>(".wiki-sel-card")!;
    expect(card.previousElementSibling?.className).toBe("wiki-article-head");
    expect(card.style.display).toBe("");
    article.classList.replace("lens-all", "lens-overview");
    await settle();
    expect(card.style.display).toBe("none");
    article.classList.replace("lens-overview", "lens-all");
    await settle();
    expect(card.style.display).toBe("");
  } finally {
    delete (wrap as unknown as Record<string, unknown>).getClientRects;
  }
});

test("class check S1×S3: a card hidden with its text comes back shown after a render: under its passage when shown, at the top with the note when gone", async () => {
  const render = (night: string) => {
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-article"><h2>Brief</h2><p id="np">${night}</p><p>The morning route adds a stop.</p></div>`;
    setDiscussAgentEnabled(false);
    setSelectionMenuPage({ mentions: true });
  };
  const wrap = document.getElementById("articleWrap")!;
  explainManual = true;
  let hidden = false;
  try {
    render(NIGHT);
    boxOf(wrap, () => true);
    boxOf(document.getElementById("np")!, () => !hidden);
    await selectText(NIGHT, "#np");
    act(document.getElementById("wikiExplainBtn")!);
    await settle();
    const card = wrap.querySelector<HTMLElement>(".wiki-sel-card")!;
    expect(card.style.display).toBe("");
    // Its paragraph hidden (a lens): the card goes with it.
    hidden = true;
    wrap.querySelector(".wiki-article")!.classList.add("lens-overview");
    await settle();
    expect(card.style.display).toBe("none");
    // The page renders again with the passage shown (All): the card back under it, shown.
    hidden = false;
    render(NIGHT);
    boxOf(document.getElementById("np")!, () => !hidden);
    await settle();
    expect(card.parentElement?.classList.contains("wiki-article")).toBe(true);
    expect(card.previousElementSibling?.id).toBe("np");
    expect(card.style.display).toBe("");
    hidden = true;
    wrap.querySelector(".wiki-article")!.classList.add("lens-overview");
    await settle();
    expect(card.style.display).toBe("none");
    // The page renders without the passage: the card at the top, shown, with the note.
    render("The night route was rewritten entirely.");
    await settle();
    expect(card.isConnected).toBe(true);
    expect(wrap.querySelector(".wiki-article")!.firstElementChild === card).toBe(true);
    expect(card.style.display).toBe("");
    expect(card.querySelector(".wiki-sel-card-moved")?.textContent).toBe("The passage this answers is no longer on the page as it was.");
    explainCtl?.close();
  } finally {
    explainManual = false;
    delete (wrap as unknown as Record<string, unknown>).getClientRects;
    setDiscussAgentEnabled(true);
  }
});

test("class check S2: the page renders again while an inline Apply runs: the card comes back with the turn, and the 409 shows on it", async () => {
  const card = await followCardWithEdit("turn-66", 66);
  await applyHeld(card, stale, async () => {
    // An in-place render of the same page (not the Apply's own): the card goes back under its passage.
    renderPage();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.querySelector("[data-discuss-apply]")?.textContent).toBe("Applying…");
  });
  expect(card.isConnected).toBe(true);
  expect(switched).toEqual([]);
  expect(tabActive()).toBe(false);
  expect(card.querySelector(".wiki-discuss-edit")?.getAttribute("data-edit-state")).toBe("refused");
  expect(card.querySelector(".wiki-discuss-edit")?.textContent).toContain(STALE);
});

// ── The Trace card's place (fix round 2 batch 4, 12c) ─────────────────────

let keyTraceWired = false;
function wireKeyTrace(): void {
  if (keyTraceWired) return;
  keyTraceWired = true;
  initKeyTrace({ wiki: () => "w", relPath: () => menuRel, hrefFor: (r) => `/wiki?relPath=${r}`, mentionsOn: () => true, place: placeInlineCard, live: inlineCardLive });
}

/** A range over `text` in the article. */
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

/** A Trace card on MEL-12 under the night line (with no range: at the pane's
 *  end, as an explainer's is, and not held), its «Summarize» streaming: the
 *  card and its stream's signal. */
async function streamingTrace(at: "passage" | "none" = "passage"): Promise<{ card: HTMLElement; signal: AbortSignal }> {
  renderPage();
  wireKeyTrace();
  const card = openTrace("MEL-12", at === "passage" ? rangeOf(NIGHT) : null)!;
  await settle();
  const before = posts.length;
  (card.querySelector("[data-trace-summarize]") as HTMLButtonElement).click();
  await settle();
  expect(posts.length).toBe(before + 1);
  expect(posts.at(-1)).toMatchObject({ traceKey: "MEL-12" });
  const signal = postSignal!;
  expect(signal.aborted).toBe(false);
  expect(inlineCardLive(card)).toBe(true);
  return { card, signal };
}

const closeStream = async () => {
  try {
    close!();
  } catch {
    /* aborted already */
  }
  await settle();
};

test("12c: another inline card replaces a live Trace card, under a passage or with none: the Trace card leaves for good and its drop hook aborts its stream at once", async () => {
  for (const at of ["passage", "none"] as const) {
    try {
      await replacedTrace(at);
    } finally {
      await closeStream();
    }
  }
});

/** A streaming Trace card at `at`, replaced by another inline card. */
async function replacedTrace(at: "passage" | "none"): Promise<void> {
  const { card, signal } = await streamingTrace(at);
  expect([at, card.isConnected]).toEqual([at, true]);
  let dropped = 0;
  const next = placeInlineCard(rangeOf(EDIT_OLD), inlineCardHtml("where", "next", "<p>next</p>", null), () => dropped++)!;
  expect(next.isConnected).toBe(true);
  expect(card.isConnected).toBe(false);
  expect(inlineCardLive(card)).toBe(false);
  expect(inlineCardLive(next)).toBe(true);
  // Aborted by the drop hook, before any frame could find the card gone.
  expect(signal.aborted).toBe(true);
  expect(dropped).toBe(0);
  // The card that replaced it runs its own hook once when it goes in turn.
  (next.querySelector("[data-sel-card-close]") as HTMLButtonElement).click();
  expect(dropped).toBe(1);
  expect(inlineCardLive(next)).toBe(false);
}

test("12c: a Trace card replaced while its thread read is in flight: the drop hook aborts that read", async () => {
  let release: () => void = () => {};
  traceReadGate = new Promise<void>((r) => (release = r));
  traceReadSignal = null;
  try {
    renderPage();
    wireKeyTrace();
    const card = openTrace("MEL-12", rangeOf(NIGHT))!;
    await settle();
    const signal = traceReadSignal as AbortSignal | null;
    expect(signal?.aborted).toBe(false);
    placeInlineCard(rangeOf(EDIT_OLD), inlineCardHtml("where", "next", "<p>next</p>", null));
    expect(card.isConnected).toBe(false);
    expect(signal?.aborted).toBe(true);
  } finally {
    traceReadGate = null;
    release();
    await settle();
  }
});

test("12c: a Trace card out for a render of its page is live: a frame meanwhile neither aborts its stream nor is lost; another page drops it", async () => {
  try {
    const { card, signal } = await streamingTrace();
    // An Ask answer takes the pane: the card is out, held for the page's next render.
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-ask-view">An answer.</div>`;
    expect(card.isConnected).toBe(false);
    expect(inlineCardLive(card)).toBe(true);
    push!("delta", { text: "TRACE-WHILE-OUT" });
    await settle();
    expect(signal.aborted).toBe(false);
    renderPage();
    await settle();
    expect(card.isConnected).toBe(true);
    expect(card.querySelector(".wiki-trace-a")?.textContent).toContain("TRACE-WHILE-OUT");
    // Another page: dropped for good, its stream aborted.
    menuRel = "plans/harbour.mdx";
    renderPage();
    await settle();
    expect(inlineCardLive(card)).toBe(false);
    expect(signal.aborted).toBe(true);
  } finally {
    menuRel = REL;
    await closeStream();
  }
});

test("12c: a new inline card while the Trace card is out for a render: the held card is dropped too, its stream aborted at once", async () => {
  try {
    const { card, signal } = await streamingTrace();
    document.getElementById("articleWrap")!.innerHTML = `<div class="wiki-ask-view">An answer.</div>`;
    expect(inlineCardLive(card)).toBe(true);
    placeInlineCard(null, inlineCardHtml("where", "next", "<p>next</p>", null));
    expect(inlineCardLive(card)).toBe(false);
    expect(signal.aborted).toBe(true);
  } finally {
    await closeStream();
    renderPage();
    await settle();
  }
});
