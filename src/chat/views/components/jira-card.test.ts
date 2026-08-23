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
  seed: (draftId: string) => Promise<void>;
  reset: () => void;
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
  let now = 1_000_000;
  let timerSeq = 0;
  const timers = new Map<number, () => void>();

  const cardKeyFor = (messageId: string, draftId: string) => `${messageId}|${draftId}`;

  function bubbleNode(messageId: string) {
    return {
      querySelector(q: string) {
        const m = /data-jira-card="([^"]+)"/.exec(q);
        if (!m) return null;
        const key = cardKeyFor(messageId, m[1]!);
        if (cards[key] === undefined) return null;
        return {
          set outerHTML(v: string) {
            cards[key] = v;
          },
        };
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
        return { ok: status === 200, status, json: async () => ({ drafts }) };
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
      " resetJiraCards: resetJiraCards, attachJiraCard: attachJiraCard };",
  )(ctx) as {
    refreshJiraCards: () => Promise<void>;
    seedJiraCard: (id: string) => void;
    resetJiraCards: () => void;
    attachJiraCard: (messageId: string, draftId: string, view: unknown) => boolean;
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
    seed: async (draftId: string) => {
      made.seedJiraCard(draftId);
      await flush();
    },
    reset: () => made.resetJiraCards(),
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

  test("a settled row whose bubble has NOT arrived yet is re-read once it has", async () => {
    // The ordinary race: the row goes `ready` while its bubble is still coming
    // over the WebSocket. Keying the skip on status alone stranded it forever.
    const h = harness({
      listings: [[{ draftId: "d-1", messageId: "m-1", status: "ready" }]],
      drafts: { "d-1": [{ status: 200, body: readyView() }] },
    });
    await h.refresh();
    expect(h.cards()["m-1|d-1"]).toBeUndefined();
    h.addBubble("m-1");
    await h.refresh();
    expect(h.cards()["m-1|d-1"]).toContain('data-jira-card="d-1"');
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
