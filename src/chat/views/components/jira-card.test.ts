import { describe, expect, test } from "bun:test";
import { jiraCardScript } from "./jira-card.ts";
import {
  jiraCardArchiveUrl,
  jiraCardBadges,
  jiraCardHtml,
  jiraCardNoticeHtml,
  jiraCardPollExpired,
  jiraCardSaveFailedMessage,
  jiraCardShouldPoll,
  jiraCardSignature,
} from "./jira-card-pure.ts";
import { jiraEntryVisible } from "./jira-entry-pure.ts";
import { chatStyles } from "./chat-styles.ts";
import { SHARED_STYLES } from "../../../dashboard/views/shared-styles.ts";
import { renderChatPage } from "../page.ts";

/**
 * Harness for the INJECTED half — the `jira-entry.test.ts` precedent.
 *
 * The pure module covers the decisions; what only reproduces in the script is the
 * BINDING: the listing is asked for on the thread, every listed row is read ONCE
 * whatever its status, the card lands under the bubble the row names, a
 * `generating` row keeps polling and updates in place, the poller gives up at the
 * cap, and a thread switch tears every timer down.
 *
 * The DOM and the clock are stubbed rather than emulated: this file drives the
 * real `jiraCardScript()` source, so a change to it that breaks the sequence
 * fails here even though no browser is involved.
 *
 * Synthetic ids throughout — muninn is a public repo.
 */

interface Harness {
  fetchUrls: () => string[];
  fetchCalls: () => { url: string; method: string; contentType?: string; body?: string }[];
  /** The card markup currently standing under a bubble, by "<messageId>|<draftId>". */
  cards: () => Record<string, string>;
  notice: () => string | null;
  /** Placeholder notes the 🧾 click left, by draft id. */
  draftingNotes: () => string[];
  refresh: () => Promise<void>;
  seed: (draftId: string, threadId?: string | null) => Promise<void>;
  reset: () => void;
  /** Move the page's live `activeThreadId` — a thread switch, as the page does it. */
  setThread: (threadId: string | null) => void;
  /** Answer every listing held open by `holdListing`. */
  releaseListings: () => Promise<void>;
  /** Fire every pending timer once, then let the microtasks settle. */
  tick: () => Promise<void>;
  clickCopy: (draftId: string) => Promise<void>;
  clickSave: (draftId: string) => Promise<void>;
  copied: () => string[];
  /** Add a bot bubble to the message list, as attachFeedbackControls stamps it. */
  addBubble: (messageId: string) => void;
  pendingTimers: () => number;
  setNow: (ms: number) => void;
}

type DraftResponse = { status: number; body: unknown };

function harness(opts: {
  thread?: string | null;
  selectedBot?: string;
  jiraBot?: string | null;
  bubbles?: string[];
  drafting?: string[];
  /** `GET /api/jira/drafts?thread=` answers, one per call; the last repeats. */
  listings?: { draftId: string; messageId: string | null; status: string }[][];
  /** `GET /api/jira/draft/:id` answers, one queue per draft id; the last repeats. */
  drafts?: Record<string, DraftResponse[]>;
  saveResponse?: DraftResponse;
  listingStatus?: number;
  /** Hold every `GET /api/jira/drafts?thread=` open until `releaseListings()`. */
  holdListing?: boolean;
}): Harness {
  const fetchCalls: { url: string; method: string; contentType?: string; body?: string }[] = [];
  const cards: Record<string, string> = {};
  const copied: string[] = [];
  const bubbles = new Set(opts.bubbles ?? []);
  const draftingNotes = new Set(opts.drafting ?? []);
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const draftCalls: Record<string, number> = {};
  let listingCalls = 0;
  let notice: string | null = null;
  const heldListings: (() => void)[] = [];
  let now = 1_000_000;
  let timerSeq = 0;
  const timers = new Map<number, () => void>();

  const cardKeyFor = (messageId: string, draftId: string) => `${messageId}|${draftId}`;

  /** One standing card node. `__msg` is what `contains` is answered from. */
  function cardNode(messageId: string, draftId: string) {
    const key = cardKeyFor(messageId, draftId);
    return {
      __msg: messageId,
      remove() {
        delete cards[key];
      },
      set outerHTML(v: string) {
        cards[key] = v;
      },
    };
  }

  function bubbleNode(messageId: string) {
    return {
      contains(node: { __msg?: string } | null) {
        return !!node && node.__msg === messageId;
      },
      querySelector(q: string) {
        const m = /data-jira-card="([^"]+)"/.exec(q);
        if (!m) return null;
        if (cards[cardKeyFor(messageId, m[1]!)] === undefined) return null;
        return cardNode(messageId, m[1]!);
      },
      insertAdjacentHTML(_pos: string, html: string) {
        const m = /data-jira-card="([^"]+)"/.exec(html);
        if (m) cards[cardKeyFor(messageId, m[1]!)] = html;
      },
    };
  }

  const chatMessages = {
    querySelector(q: string) {
      const m = /data-message-id="([^"]+)"/.exec(q);
      if (!m) return null;
      return bubbles.has(m[1]!) ? bubbleNode(m[1]!) : null;
    },
    insertAdjacentHTML(_pos: string, html: string) {
      notice = html;
    },
  };

  const doc = {
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    getElementById(id: string) {
      if (id !== "jiraCardNotice" || notice === null) return null;
      return {
        remove() {
          notice = null;
        },
        set outerHTML(v: string) {
          notice = v;
        },
      };
    },
    querySelector(q: string) {
      const m = /data-je-drafting="([^"]+)"/.exec(q);
      if (!m || !draftingNotes.has(m[1]!)) return null;
      const id = m[1]!;
      return {
        remove() {
          draftingNotes.delete(id);
        },
      };
    },
    // Cards for one draft ACROSS every bubble — how a card left under the old
    // bubble by a regenerate is found and removed.
    querySelectorAll(q: string) {
      const m = /data-jira-card="([^"]+)"/.exec(q);
      if (!m) return [];
      const draftId = m[1]!;
      return Object.keys(cards)
        .filter((k) => k.endsWith(`|${draftId}`))
        .map((k) => cardNode(k.slice(0, k.length - draftId.length - 1), draftId));
    },
  };

  const ctx = {
    document: doc,
    chatMessages,
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    },
    now: () => now,
    setTimeout: (fn: () => void) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    fetch: async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      fetchCalls.push({
        url,
        method: init?.method || "GET",
        contentType: init?.headers?.["content-type"],
        body: init?.body,
      });
      if (url.startsWith("/api/jira/drafts?")) {
        const status = opts.listingStatus ?? 200;
        const queue = opts.listings ?? [[]];
        const drafts = queue[Math.min(listingCalls++, queue.length - 1)] ?? [];
        const answer = { ok: status === 200, status, json: async () => ({ drafts }) };
        if (opts.holdListing) return await new Promise((r) => heldListings.push(() => r(answer)));
        return answer;
      }
      if (url.endsWith("/save")) {
        const r = opts.saveResponse ?? { status: 200, body: {} };
        return { ok: r.status === 200, status: r.status, json: async () => r.body };
      }
      const id = decodeURIComponent(url.replace("/api/jira/draft/", ""));
      const queue = opts.drafts?.[id] ?? [{ status: 404, body: { error: "ukjent utkast" } }];
      const n = (draftCalls[id] = (draftCalls[id] ?? 0) + 1);
      const r = queue[Math.min(n - 1, queue.length - 1)]!;
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    },
    pure: {
      jiraCardArchiveUrl,
      jiraCardBadges,
      jiraCardHtml,
      jiraCardNoticeHtml,
      jiraCardPollExpired,
      jiraCardSaveFailedMessage,
      jiraCardShouldPoll,
      jiraCardSignature,
      jiraEntryVisible,
    },
  };

  const prelude =
    "var document = ctx.document; var chatMessages = ctx.chatMessages; var fetch = ctx.fetch;" +
    "var navigator = ctx.navigator;" +
    "var setTimeout = ctx.setTimeout; var clearTimeout = ctx.clearTimeout;" +
    "var Date = { now: ctx.now };" +
    "var jiraCardArchiveUrl = ctx.pure.jiraCardArchiveUrl;" +
    "var jiraCardBadges = ctx.pure.jiraCardBadges;" +
    "var jiraCardHtml = ctx.pure.jiraCardHtml;" +
    "var jiraCardNoticeHtml = ctx.pure.jiraCardNoticeHtml;" +
    "var jiraCardPollExpired = ctx.pure.jiraCardPollExpired;" +
    "var jiraCardSaveFailedMessage = ctx.pure.jiraCardSaveFailedMessage;" +
    "var jiraCardShouldPoll = ctx.pure.jiraCardShouldPoll;" +
    "var jiraCardSignature = ctx.pure.jiraCardSignature;" +
    "var jiraEntryVisible = ctx.pure.jiraEntryVisible;" +
    // Declared by streaming-ui.ts in the page — the card layer reuses it rather
    // than shipping a second escaper into the same IIFE scope.
    "function cssAttrValue(v) { return String(v).replace(/[\"\\\\]/g, '\\\\$&'); }" +
    // The renderer the page bundles. The card passes markdown through it; the
    // identity stub keeps this file about the binding, not about web-format.
    "function formatWebHtml(s) { return '<p>' + s + '</p>'; }" +
    "function sanitizeHtml(h) { return h; }" +
    `var selectedBot = ${JSON.stringify(opts.selectedBot ?? "melosys")};` +
    `var jiraBotName = ${JSON.stringify(opts.jiraBot === undefined ? "melosys" : opts.jiraBot)};` +
    `var activeThreadId = ${JSON.stringify(opts.thread === undefined ? "t-1" : opts.thread)};`;

  const made = new Function(
    "ctx",
    prelude +
      jiraCardScript() +
      "return { refreshJiraCards: refreshJiraCards, seedJiraCard: seedJiraCard," +
      " resetJiraCards: resetJiraCards, attachJiraCard: attachJiraCard," +
      " setThread: function(t) { activeThreadId = t; } };",
  )(ctx) as {
    refreshJiraCards: () => Promise<void>;
    seedJiraCard: (id: string, threadId?: string | null) => void;
    resetJiraCards: () => void;
    attachJiraCard: (messageId: string, draftId: string, view: unknown) => boolean;
    setThread: (threadId: string | null) => void;
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  const fire = async (type: string, target: unknown): Promise<void> => {
    for (const fn of listeners[type] ?? []) fn({ target, preventDefault() {} });
    await flush();
  };

  const clickTarget = (attr: string, draftId: string) => ({
    closest: (q: string): unknown => (q === `[${attr}]` ? clickTarget(attr, draftId) : null),
    getAttribute: (n: string) => (n === attr ? draftId : null),
  });

  return {
    fetchUrls: () => fetchCalls.map((f) => f.url),
    fetchCalls: () => fetchCalls,
    cards: () => cards,
    notice: () => notice,
    draftingNotes: () => Array.from(draftingNotes),
    copied: () => copied,
    pendingTimers: () => timers.size,
    setNow: (ms: number) => {
      now = ms;
    },
    addBubble: (messageId: string) => {
      bubbles.add(messageId);
    },
    refresh: async () => {
      void made.refreshJiraCards();
      await flush();
    },
    seed: async (draftId: string, threadId?: string | null) => {
      // The thread the 🧾 click was submitted from — `submitJiraEntry`'s local.
      made.seedJiraCard(draftId, threadId === undefined ? (opts.thread === undefined ? "t-1" : opts.thread) : threadId);
      await flush();
    },
    reset: () => made.resetJiraCards(),
    setThread: (threadId: string | null) => made.setThread(threadId),
    releaseListings: async () => {
      const held = heldListings.splice(0, heldListings.length);
      for (const r of held) r();
      await flush();
    },
    tick: async () => {
      const pending = Array.from(timers.entries());
      timers.clear();
      for (const [, fn] of pending) fn();
      await flush();
    },
    clickCopy: (draftId) => fire("click", clickTarget("data-jc-copy", draftId)),
    clickSave: (draftId) => fire("click", clickTarget("data-jc-save", draftId)),
  };
}

const readyView = (over: Record<string, unknown> = {}) => ({
  draftId: "d-1",
  status: "ready",
  template: "bug",
  depth: "skisse",
  markdown: "## Problem\nNoe er galt.",
  keyVerdicts: [{ key: "ABC-123", state: "verified" }],
  markdownFlags: [],
  savedAt: null,
  error: null,
  messageId: "m-1",
  ...over,
});

describe("the listing", () => {
  test("is asked for on the active thread, with no content in the request", async () => {
    const h = harness({ listings: [[]] });
    await h.refresh();
    expect(h.fetchUrls()).toEqual(["/api/jira/drafts?thread=t-1"]);
  });

  test("is NOT asked for on another bot's chat — the route would refuse that thread", async () => {
    const h = harness({ selectedBot: "jarvis" });
    await h.refresh();
    expect(h.fetchUrls()).toEqual([]);
  });

  test("is NOT asked for without a thread", async () => {
    const h = harness({ thread: null });
    await h.refresh();
    expect(h.fetchUrls()).toEqual([]);
  });

  test("a thread switch while one is in flight does NOT lock the new thread out", async () => {
    // The single-flight guard is «one listing per THREAD», not one per page: a
    // switch during an in-flight listing left the flag standing, and the new
    // thread's load, its switch and its every `response_meta` all returned
    // early — the cards of the conversation the reader is actually reading
    // never appeared at all until the next reload.
    const h = harness({ holdListing: true, listings: [[]] });
    await h.refresh();
    expect(h.fetchUrls()).toEqual(["/api/jira/drafts?thread=t-1"]);

    h.setThread("t-2");
    await h.refresh();
    expect(h.fetchUrls()).toContain("/api/jira/drafts?thread=t-2");
    await h.releaseListings();
  });
});

/**
 * CAPPED fix #1 — the READ is unconditional.
 *
 * The listing carries `{messageId, draftId, status}` and nothing else, so a
 * settled row still has to be read once to get its markdown. Gating that read on
 * in-flight-ness is what left a FINISHED draft with nothing to render after a
 * reload.
 */
describe("every listed row is read once on adopt", () => {
  test("a SETTLED row is read and rendered — not skipped for being finished", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
    });
    await h.refresh();
    expect(h.fetchUrls()).toContain("/api/jira/draft/d-1");
    expect(h.cards()["m-1|d-1"]).toContain('data-jira-card="d-1"');
    expect(h.cards()["m-1|d-1"]).toContain("Noe er galt");
    // Settled and on screen: nothing left to poll.
    expect(h.pendingTimers()).toBe(0);
  });

  test("a settled row already on screen is NOT re-read on the next listing", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
    });
    await h.refresh();
    await h.refresh();
    expect(h.fetchUrls().filter((u) => u === "/api/jira/draft/d-1")).toHaveLength(1);
  });

  test("a settled row whose bubble has NOT arrived yet is attached once it has — and read only ONCE", async () => {
    // The ordinary race: the row goes `ready` while its bubble is still coming
    // over the WebSocket. Keying the skip on status alone stranded it forever.
    //
    // But an OFFSCREEN record is settled and already read, and the listing is
    // re-asked on every `response_meta`: re-reading it each time buys nothing —
    // the answer cannot have changed — while a re-RENDER buys everything,
    // because the bubble it is waiting for may have arrived since.
    const h = harness({
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
    });
    await h.refresh();
    expect(h.cards()["m-1|d-1"]).toBeUndefined();
    await h.refresh();
    await h.refresh();
    expect(h.fetchUrls().filter((u) => u === "/api/jira/draft/d-1")).toHaveLength(1);

    h.addBubble("m-1");
    await h.refresh();
    expect(h.cards()["m-1|d-1"]).toContain('data-jira-card="d-1"');
    expect(h.fetchUrls().filter((u) => u === "/api/jira/draft/d-1")).toHaveLength(1);
  });

  test("a failed UNMAPPED row is read once, not on every listing pass", async () => {
    // Terminal and never attachable: `unmapped` is the other orphan kind, and
    // the listing re-asks on every response_meta for the life of the tab.
    const h = harness({
      listings: [[{ draftId: "d-1", messageId: null, status: "failed" }]],
      drafts: { "d-1": [{ status: 200, body: { ...readyView(), status: "failed", messageId: null, markdown: null, error: "Noe gikk galt." } }] },
    });
    await h.refresh();
    await h.refresh();
    await h.refresh();
    expect(h.fetchUrls().filter((u) => u === "/api/jira/draft/d-1")).toHaveLength(1);
    expect(h.notice()).toContain("d-1");
    expect(h.pendingTimers()).toBe(0);
  });

  test("a 404 on the read clears the drafting note and the notice row", async () => {
    const h = harness({
      drafting: ["d-1"],
      listings: [[{ draftId: "d-1", messageId: null, status: "generating" }]],
      drafts: { "d-1": [{ status: 404, body: { error: "ukjent utkast" } }] },
    });
    await h.refresh();
    expect(h.draftingNotes()).not.toContain("d-1");
    expect(h.notice() ?? "").not.toContain("d-1");
    expect(h.pendingTimers()).toBe(0);
  });

  test("a row re-pointed at a NEW bubble is re-read — the skip is keyed on the messageId too", async () => {
    // A regenerate is another turn: `finishJiraDraft` re-points `message_id` at
    // the new reply while the status stays `ready`. Keyed on the status alone,
    // the listing agreed with itself that there was nothing to do, and the card
    // stood under the OLD bubble holding the OLD text.
    const h = harness({
      bubbles: ["m-1", "m-2"],
      listings: [
        [{ draftId: "d-1", messageId: "m-1", status: "ready" }],
        [{ draftId: "d-1", messageId: "m-2", status: "ready" }],
      ],
      drafts: {
        "d-1": [
          { status: 200, body: readyView() },
          { status: 200, body: readyView({ messageId: "m-2", markdown: "## Problem\nNoe annet." }) },
        ],
      },
    });
    await h.refresh();
    expect(Object.keys(h.cards())).toEqual(["m-1|d-1"]);

    await h.refresh();
    // ONE card, under the NEW bubble — never one under each.
    expect(Object.keys(h.cards())).toEqual(["m-2|d-1"]);
    expect(h.cards()["m-2|d-1"]).toContain("Noe annet");
  });
});

describe("the poll loop", () => {
  test("a generating row polls, then updates the card IN PLACE when it lands", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "generating" }]],
      drafts: {
        "d-1": [
          { status: 200, body: readyView({ status: "generating", markdown: null }) },
          { status: 200, body: readyView() },
        ],
      },
    });
    await h.refresh();
    expect(h.cards()["m-1|d-1"]).toContain("Skriver utkastet");
    expect(h.pendingTimers()).toBe(1);

    await h.tick();
    // ONE card, replaced — never two stacked under the same bubble.
    expect(Object.keys(h.cards())).toEqual(["m-1|d-1"]);
    expect(h.cards()["m-1|d-1"]).toContain("Noe er galt");
    expect(h.pendingTimers()).toBe(0);
  });

  test("gives up at the cap and SAYS so rather than polling forever", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "generating" }]],
      drafts: { "d-1": [{ status: 200, body: readyView({ status: "generating", markdown: null }) }] },
    });
    await h.refresh();
    expect(h.pendingTimers()).toBe(1);

    h.setNow(1_000_000 + 13 * 60_000 + 1);
    await h.tick();
    expect(h.pendingTimers()).toBe(0);
    expect(h.cards()["m-1|d-1"]).toContain("ble ikke ferdig");
  });

  test("a 404 stops the loop — the row is gone", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "generating" }]],
      drafts: { "d-1": [{ status: 404, body: { error: "ukjent utkast" } }] },
    });
    await h.refresh();
    expect(h.pendingTimers()).toBe(0);
    expect(h.cards()).toEqual({});
  });

  test("a non-404 refusal keeps the loop alive — the server blinked, the draft did not die", async () => {
    // Stopping on a 500 was silent: the reader saw «Skriver utkastet …» forever
    // and the give-up line never rendered, because nothing was left to reach it.
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "generating" }]],
      drafts: {
        "d-1": [
          { status: 200, body: readyView({ status: "generating", markdown: null }) },
          { status: 500, body: { error: "boom" } },
        ],
      },
    });
    await h.refresh();
    await h.tick();
    expect(h.pendingTimers()).toBe(1);

    h.setNow(1_000_000 + 13 * 60_000 + 1);
    await h.tick();
    expect(h.cards()["m-1|d-1"]).toContain("ble ikke ferdig");
  });

  test("a thread switch tears every timer down — no interval outlives its thread", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "generating" }]],
      drafts: { "d-1": [{ status: 200, body: readyView({ status: "generating", markdown: null }) }] },
    });
    await h.refresh();
    expect(h.pendingTimers()).toBe(1);
    h.reset();
    expect(h.pendingTimers()).toBe(0);
  });
});

describe("the clicking tab's seed", () => {
  test("starts the loop on the id the 200 returned, before any listing has it", async () => {
    const h = harness({
      bubbles: ["m-1"],
      drafts: {
        "d-1": [
          { status: 200, body: readyView({ status: "generating", markdown: null, messageId: null }) },
          { status: 200, body: readyView() },
        ],
      },
    });
    await h.seed("d-1");
    // No listing was needed to get here.
    expect(h.fetchUrls()).toEqual(["/api/jira/draft/d-1"]);
    await h.tick();
    expect(h.cards()["m-1|d-1"]).toContain("Noe er galt");
  });

  test("the «skrives i samtalen …» note is cleared when the card lands", async () => {
    const h = harness({
      bubbles: ["m-1"],
      drafting: ["d-1"],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
    });
    expect(h.draftingNotes()).toEqual(["d-1"]);
    await h.seed("d-1");
    expect(h.draftingNotes()).toEqual([]);
  });

  test("the note is ALSO cleared when no card can ever land — a failed, unmapped draft", async () => {
    // The note says «Utkastet skrives i samtalen …». Only `attachJiraCard`
    // cleared it, so a run that produced no bubble left that sentence standing
    // for the life of the page about a draft nothing was writing any more.
    const h = harness({
      drafting: ["d-1"],
      drafts: {
        "d-1": [{ status: 200, body: readyView({ status: "failed", markdown: null, messageId: null }) }],
      },
    });
    await h.seed("d-1");
    expect(h.draftingNotes()).toEqual([]);
    // …and the pointer is not lost: the thread-level notice names the archive.
    expect(h.notice()).toContain("/jira?draft=d-1");
  });

  test("is a NO-OP once the reader has switched thread — it must not reset the cards they are now reading", async () => {
    // The POST is fire-and-forget and answers 60–600 s later. Reading the
    // page's LIVE `activeThreadId` there made a late 200 tear down the record
    // set of whatever thread the reader had moved on to.
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-9", messageId: "m-1", status: "ready" }]],
      drafts: { "d-9": [{ status: 200, body: readyView({ draftId: "d-9" }) }] },
    });
    await h.refresh();
    expect(Object.keys(h.cards())).toEqual(["m-1|d-9"]);
    const before = h.fetchUrls().length;

    h.setThread("t-2");
    await h.seed("d-1", "t-1");
    expect(h.fetchUrls()).not.toContain("/api/jira/draft/d-1");
    expect(h.fetchUrls().length).toBe(before);
  });
});

describe("rows a card cannot reach", () => {
  test("a FAILED row with no message gets the thread-level notice, not silence", async () => {
    const h = harness({
      listings: [[{ draftId: "d-1", messageId: null, status: "failed" }]],
      drafts: { "d-1": [{ status: 200, body: readyView({ status: "failed", markdown: null, messageId: null }) }] },
    });
    await h.refresh();
    expect(h.notice()).toContain("ingen melding ble skrevet");
    expect(h.notice()).toContain("/jira?draft=d-1");
    // …and NOTHING is left polling it. `failed` is terminal whether or not a
    // message was ever stamped: without that, a failed unmapped row was re-read
    // every 2.5 s for thirteen minutes, and again on every thread load.
    expect(h.pendingTimers()).toBe(0);
  });

  test("a row naming a bubble outside the replayed window says THAT instead", async () => {
    const h = harness({
      listings: [[{ draftId: "d-1", messageId: "m-old", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView({ messageId: "m-old" }) }] },
    });
    await h.refresh();
    expect(h.notice()).toContain("utenfor historikken");
  });

  test("a still-RUNNING row with no message yet is NOT announced — the stamp is simply not there", async () => {
    const h = harness({
      listings: [[{ draftId: "d-1", messageId: null, status: "generating" }]],
      drafts: { "d-1": [{ status: 200, body: readyView({ status: "generating", markdown: null, messageId: null }) }] },
    });
    await h.refresh();
    expect(h.notice()).toBeNull();
  });
});

describe("the card's controls", () => {
  test("Kopier copies the RAW markdown, not the rendered body", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
    });
    await h.refresh();
    await h.clickCopy("d-1");
    expect(h.copied()).toEqual(["## Problem\nNoe er galt."]);
    expect(h.cards()["m-1|d-1"]).toContain("Markdown kopiert.");
  });

  test("Lagre POSTs application/json with {} — a body-less POST is a CORS simple request", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
      saveResponse: { status: 200, body: readyView({ savedAt: 1_700_000_000_000 }) },
    });
    await h.refresh();
    await h.clickSave("d-1");
    const post = h.fetchCalls().find((f) => f.method === "POST")!;
    expect(post.url).toBe("/api/jira/draft/d-1/save");
    expect(post.contentType).toBe("application/json");
    expect(post.body).toBe("{}");
    // The row's own `savedAt` is adopted — never drawn optimistically.
    expect(h.cards()["m-1|d-1"]).toContain("jira-card-saved");
  });

  test("a refused save renders the SERVER's sentence and leaves the button alive", async () => {
    const h = harness({
      bubbles: ["m-1"],
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
      saveResponse: { status: 404, body: { error: "ukjent utkast" } },
    });
    await h.refresh();
    await h.clickSave("d-1");
    expect(h.cards()["m-1|d-1"]).toContain("ukjent utkast");
    expect(h.cards()["m-1|d-1"]).toContain('data-jc-save="d-1"');
  });
});

/**
 * What only the PAGE can answer: the card layer is injected into one script
 * scope beside `streaming-ui.ts`, and its CSS into one stylesheet beside the
 * dashboard's tokens. Both are string concatenation, so nothing else notices a
 * second copy of a helper or a token that was never defined.
 */
describe("the page the card is injected into", () => {
  test("does not ship a second attribute escaper into the one script scope", () => {
    const src = jiraCardScript();
    // `cssAttrValue` is declared by streaming-ui.ts in the SAME IIFE and does
    // exactly this. Two spellings of one rule is one that can drift.
    expect(src).not.toContain("function jiraCardAttrValue");
    expect(src).toContain("cssAttrValue(");
  });

  test("the amber badge uses a token that EXISTS — `--status-warn` is nobody's", () => {
    const block = /\.jira-card-badge-warn\s*\{([^}]*)\}/.exec(chatStyles())?.[1] ?? "";
    expect(block).toContain("--status-warning");
    expect(block).not.toMatch(/--status-warn\b/);
    expect(SHARED_STYLES).toContain("--status-warning:");
  });

  test("clearChat() resets the cards — a bot or user switch replaces the DOM too", async () => {
    // `loadThreadMessages` was the only reset. Switching BOT or USER also wipes
    // the message list (`selectBot` → `clearChat`), leaving records pointing at
    // nodes that no longer exist and timers polling a thread nobody is reading.
    const page = await renderChatPage();
    const body = /function clearChat\(\) \{[\s\S]*?\n  \}/.exec(page)?.[0] ?? "";
    expect(body).toContain("resetJiraCards()");
  });
});
