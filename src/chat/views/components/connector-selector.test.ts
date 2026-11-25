import { test, expect, describe } from "bun:test";
import path from "node:path";
import { connectorSelectorScript } from "./connector-selector.ts";
import { threadKindScript, threadManagerScript } from "./thread-manager.ts";

/**
 * Regression harness for the connector STAMP — the chat page's habit of writing
 * its remembered sidebar connector onto whatever thread it just opened.
 *
 * This is deliberately not a pure-helper test: the bug it guards lives in the
 * injected browser script, and it only reproduces across TWO call sites on one
 * turn (`handleDeepLink` stamps, then `sendMessage` stamps again just before the
 * seeded message is delivered). So the harness evaluates the REAL
 * `connectorSelectorScript()` together with the REAL deep-link/send block lifted
 * out of `views/page.ts`, and drives the actual sequence.
 *
 * The `onlyIfEmpty` guard cannot cover this case by construction: it only
 * protects threads that ALREADY carry a connector. A thread created with
 * "(bot default)" carries none — that is what "(bot default)" means — and a
 * thread the client hasn't loaded into `threads` at all doesn't even reach the
 * guard's loop, so it falls through to an unconditional PATCH.
 */

/** The deep-link + sendMessage block, verbatim from the chat page source. Lifted
 *  rather than copied so this test can never pass against a stale duplicate. */
async function deepLinkBlockSource(): Promise<string> {
  const file = path.join(import.meta.dir, "..", "page.ts");
  const src = await Bun.file(file).text();
  const start = src.indexOf("  // Deep-link: /chat?bot=");
  const end = src.indexOf("  // Load messages filtered by thread from DB");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("chat page markers moved — update this extraction");
  }
  return src.slice(start, end);
}

interface FetchCall { url: string; method: string; body: unknown }

interface Harness {
  fetchCalls: FetchCall[];
  patches: FetchCall[];
  run: () => Promise<void>;
  stamp: (threadId: string, connectorId: string, onlyIfEmpty?: boolean) => Promise<void>;
  /** A LATER message in the same thread — the reader's own follow-up, which goes
   *  through `sendMessage`'s stamp exactly as the seeded turn did. */
  send: (text: string) => Promise<void>;
}

/** Build a running copy of the page's connector + deep-link code over stubs. */
async function harness(opts: {
  /** Threads the client has loaded — a deep-linked thread is often NOT among them. */
  threads: { id: string; connectorId?: string | null; kind?: string }[];
  /** What the sidebar remembers (the value that would get stamped). */
  selectedConnectorId: string;
  /** Query string of the deep link. */
  search: string;
  /** Whether `GET /chat/pending/:id` has a seed to deliver. */
  pendingText?: string;
  /** The send's answer (default 202): a wiki thread's refusal is a 409 with `error`. */
  sendStatus?: number;
}): Promise<Harness & { input: () => string; notices: string[] }> {
  const fetchCalls: FetchCall[] = [];
  const notices: string[] = [];
  const el = (): Record<string, unknown> => ({
    addEventListener: () => {},
    innerHTML: "",
    value: "",
    style: {},
    appendChild: () => {},
  });
  const ctx = {
    document: { getElementById: () => el(), createElement: () => el() },
    window: { location: { search: opts.search } },
    localStorage: { getItem: () => null, setItem: () => {} },
    chatInput: { value: "", style: {} as Record<string, string> },
    chatMessages: { querySelector: () => null, appendChild: (n: { textContent?: string }) => notices.push(n.textContent ?? "") },
    threads: opts.threads.map((t) => ({ ...t })),
    connectors: [] as unknown[],
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({
        url,
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      const isSend = init?.method === "POST" && url.indexOf("/messages") > -1;
      const status = isSend ? (opts.sendStatus ?? 202) : 200;
      if (isSend && status >= 400) return { ok: false, status, json: async () => ({ error: "the discussion's last turn is still running", reason: "busy" }) };
      return {
        ok: true,
        status,
        json: async () => (url.indexOf("/chat/pending/") === 0 || url.indexOf("/chat/pending/") > -1
          ? { text: opts.pendingText || "" }
          : {}),
      };
    },
  };

  const body =
    "var document = ctx.document; var window = ctx.window;" +
    "var localStorage = ctx.localStorage; var authedFetch = ctx.fetch;" +
    "var threads = ctx.threads; var connectors = ctx.connectors;" +
    "var chatInput = ctx.chatInput; var chatMessages = ctx.chatMessages;" +
    "var selectedBot = 'jarvis'; var selectedUserId = 'u1';" +
    // PR C: handleDeepLink skips the localStorage user pin when the server owns
    // the id. This harness evaluates that function in isolation, so the variable
    // it branches on has to exist here too — null is the auth-off case these
    // cases are written against.
    "var sessionUser = null;" +
    "var activeThreadId = null; var activeConvId = null;" +
    "function renderThreadList(){} function updateInspector(){}" +
    "function escapeHtml(s){return s;} function getBotInfo(){return null;}" +
    "function getSkipExtractions(){return false;}" +
    "function scrollToBottom(){}" +
    "async function selectBot(_b, t){ activeConvId = 'C1'; activeThreadId = t || null; }" +
    threadKindScript() +
    connectorSelectorScript() +
    (await deepLinkBlockSource()) +
    "selectedConnectorId = " + JSON.stringify(opts.selectedConnectorId) + ";" +
    "return { handleDeepLink: handleDeepLink, stampConnectorOnThread: stampConnectorOnThread," +
    " sendMessage: sendMessage };";

  const made = new Function("ctx", body)(ctx) as {
    handleDeepLink: () => Promise<void>;
    stampConnectorOnThread: (id: string, cid: string, only?: boolean) => Promise<void>;
    sendMessage: () => Promise<void>;
  };
  return {
    fetchCalls,
    notices,
    input: () => ctx.chatInput.value,
    get patches() { return fetchCalls.filter((f) => f.method === "PATCH"); },
    run: () => made.handleDeepLink(),
    stamp: (id, cid, only) => made.stampConnectorOnThread(id, cid, only),
    send: async (text) => {
      ctx.chatInput.value = text;
      await made.sendMessage();
    },
  };
}

const WIKI_LINK = "?bot=jarvis&thread=T1&user=u1&src=wiki";
const PLAIN_LINK = "?bot=jarvis&thread=T1&user=u1";

describe("connector stamp suppression (&src=wiki)", () => {
  test("BASELINE: a thread missing from the client's list is stamped unconditionally", async () => {
    // `onlyIfEmpty` never even reaches its guard here — the loop that reads the
    // thread's current connector doesn't find the thread. This is the condition
    // that makes a call-site-only fix insufficient.
    const h = await harness({
      threads: [], selectedConnectorId: "sidebar-conn", search: PLAIN_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches.length).toBeGreaterThan(0);
    expect(h.patches[0]!.body).toEqual({ connectorId: "sidebar-conn" });
  });

  test("BASELINE: a loaded thread with NO connector is stamped too", async () => {
    // The second condition: `onlyIfEmpty` only protects a thread that already has
    // a connector, so "(bot default)" — which is the absence of one — is exactly
    // what it fails to protect.
    const h = await harness({
      threads: [{ id: "T1", connectorId: null }],
      selectedConnectorId: "sidebar-conn", search: PLAIN_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches.length).toBeGreaterThan(0);
  });

  test("a wiki deep link leaves a '(bot default)' thread alone — through the SEND path", async () => {
    // Both stamps run on this turn: handleDeepLink's, then sendMessage's right
    // before the seeded message is POSTed. Gating only the first would leave the
    // seeded turn stamped anyway, which is why the suppression lives inside
    // stampConnectorOnThread.
    const h = await harness({
      threads: [{ id: "T1", connectorId: null }],
      selectedConnectorId: "sidebar-conn", search: WIKI_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches).toEqual([]);
    // The seed really did go through the send path (otherwise this test would
    // pass for the trivial reason that nothing ran).
    const sent = h.fetchCalls.find((f) => f.method === "POST" && f.url.indexOf("/messages") > -1);
    expect(sent).toBeDefined();
    expect((sent!.body as { text: string }).text).toBe("seed");
  });

  test("the same holds for a thread the client hasn't loaded", async () => {
    const h = await harness({
      threads: [], selectedConnectorId: "sidebar-conn", search: WIKI_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches).toEqual([]);
  });

  test("the reader's FOLLOW-UP message in the same thread is still unstamped", async () => {
    // The regression a single released boolean shipped with: suppression covered
    // exactly the seeded turn, so the reader's SECOND message went through
    // sendMessage's stamp and picked up the sidebar preference anyway — the same
    // silent model swap, one turn later. Suppression is per THREAD and is never
    // released for the page session.
    const h = await harness({
      threads: [{ id: "T1", connectorId: null }],
      selectedConnectorId: "sidebar-conn", search: WIKI_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches).toEqual([]);
    await h.send("and what about the other case?");
    expect(h.patches).toEqual([]);
    // The follow-up really was sent (otherwise this passes for the wrong reason).
    const posts = h.fetchCalls.filter((f) => f.method === "POST" && f.url.indexOf("/messages") > -1);
    expect(posts).toHaveLength(2);
    expect((posts[1]!.body as { text: string }).text).toBe("and what about the other case?");
  });

  test("suppression is scoped to the deep-linked thread — others are unaffected", async () => {
    const h = await harness({
      threads: [], selectedConnectorId: "sidebar-conn", search: WIKI_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches).toEqual([]);
    // Another thread the user opens in the same page stamps normally.
    await h.stamp("T2", "sidebar-conn", true);
    expect(h.patches.length).toBe(1);
    expect(h.patches[0]!.url).toContain("T2");
  });

  test("an explicit dropdown pick still wins while suppressed", async () => {
    // Suppression is about a REMEMBERED default filling an empty slot, not about
    // freezing the thread: the dropdown-change path passes no `onlyIfEmpty`.
    const h = await harness({
      threads: [{ id: "T1", connectorId: null }],
      selectedConnectorId: "sidebar-conn", search: WIKI_LINK, pendingText: "seed",
    });
    await h.run();
    expect(h.patches).toEqual([]);
    await h.stamp("T1", "chosen-conn");
    expect(h.patches.length).toBe(1);
    expect(h.patches[0]!.body).toEqual({ connectorId: "chosen-conn" });
  });
});

describe("a wiki page's Discuss thread in /chat (Discuss v2 PR 4)", () => {
  test("is never stamped, with or without src=wiki, and the selector stays out of it", async () => {
    const h = await harness({
      threads: [{ id: "T1", connectorId: null, kind: "wiki" }],
      selectedConnectorId: "sidebar-conn", search: PLAIN_LINK, pendingText: "seed",
    });
    await h.run();
    await h.send("a follow-up");
    expect(h.patches).toEqual([]);
    // An explicit pick is refused on a wiki thread too: the server ignores it, and the label must not lie.
    await h.stamp("T1", "sidebar-conn", false);
    expect(h.patches).toEqual([]);
    expect(h.fetchCalls.filter((f) => f.method === "POST" && f.url.indexOf("/messages") > -1)).toHaveLength(2);
  });

  test("a refused send gives the typed text back and shows the server's reason; a chat thread's send does not", async () => {
    const wiki = await harness({ threads: [{ id: "T1", kind: "wiki" }], selectedConnectorId: "", search: PLAIN_LINK, sendStatus: 409 });
    await wiki.run();
    await wiki.send("Where else is it named?");
    expect(wiki.input()).toBe("Where else is it named?");
    expect(wiki.notices).toEqual(["the discussion's last turn is still running"]);

    const chat = await harness({ threads: [{ id: "T1" }], selectedConnectorId: "", search: PLAIN_LINK, sendStatus: 409 });
    await chat.run();
    await chat.send("hello");
    expect(chat.input()).toBe("");
    expect(chat.notices).toEqual([]);
  });
});

/**
 * Fix round 1 batch 2: a wiki thread the thread list leaves out (a closed one,
 * reached by an old link or a pop-out reloaded after «Start over»). This
 * harness runs the REAL thread manager too, so `selectBot` → `loadThreads` →
 * `selectThread` decide what /chat knows about the deep-linked thread.
 */
async function pageHarness(opts: {
  /** What `GET /chat/threads/:userId/:botName` lists. */
  list: Record<string, unknown>[];
  /** What a lookup of the deep-linked thread by id answers (null: 404). */
  byId: Record<string, unknown> | null;
  sendStatus?: number;
  sendError?: { error: string; reason: string };
}) {
  const fetchCalls: FetchCall[] = [];
  const notices: string[] = [];
  const els = new Map<string, Record<string, unknown>>();
  const mk = (): Record<string, unknown> => {
    const title = { textContent: "" };
    return {
      addEventListener: () => {}, innerHTML: "", value: "", textContent: "", style: {} as Record<string, string>,
      hidden: false, disabled: false, placeholder: "Type a message...", dataset: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      appendChild: () => {}, focus: () => {}, setAttribute: () => {}, dispatchEvent: () => {},
      querySelector: (s: string) => (s === ".chat-title" ? title : null), querySelectorAll: () => [],
    };
  };
  const byIdEl = (id: string) => {
    if (!els.has(id)) els.set(id, mk());
    return els.get(id)!;
  };
  const chatInput = mk();
  const chatHeader = mk();
  const ctx = {
    document: { getElementById: byIdEl, createElement: () => mk() },
    window: { location: { search: "?bot=jarvis&thread=T1&user=u1&src=wiki" } },
    localStorage: { getItem: () => null, setItem: () => {} },
    chatInput, chatHeader, chatSend: mk(), threadList: mk(),
    chatMessages: { querySelector: () => null, appendChild: (n: { textContent?: string }) => notices.push(n.textContent ?? "") },
    connectors: [{ id: "sidebar-conn", name: "Sidebar" }],
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method || "GET";
      fetchCalls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "GET" && url === "/chat/threads/u1/jarvis") return { ok: true, status: 200, json: async () => ({ threads: opts.list }) };
      if (method === "GET" && url === "/chat/threads/T1") {
        return opts.byId ? { ok: true, status: 200, json: async () => ({ thread: opts.byId }) } : { ok: false, status: 404, json: async () => ({ error: "Thread not found" }) };
      }
      const isSend = method === "POST" && url.indexOf("/messages") > -1;
      const status = isSend ? (opts.sendStatus ?? 202) : 200;
      if (isSend && status >= 400) return { ok: false, status, json: async () => opts.sendError ?? { error: "refused", reason: "x" } };
      return { ok: true, status, json: async () => (url.indexOf("/chat/pending/") > -1 ? { text: "" } : {}) };
    },
  };
  const body =
    "var document = ctx.document; var window = ctx.window;" +
    "var localStorage = ctx.localStorage; var authedFetch = ctx.fetch;" +
    "var threads = []; var connectors = ctx.connectors; var bots = [];" +
    "var chatInput = ctx.chatInput; var chatMessages = ctx.chatMessages; var chatHeader = ctx.chatHeader;" +
    "var chatSend = ctx.chatSend; var threadList = ctx.threadList;" +
    "var selectedBot = 'jarvis'; var selectedUserId = 'u1'; var selectedUsername = 'Kari';" +
    "var sessionUser = null; var activeThreadId = null; var activeConvId = null;" +
    "function updateInspector(){} function clearChat(){} function loadThreadMessages(){}" +
    "function escapeHtml(s){return s;} function escapeAttr(s){return s;} function timeAgo(){return '';}" +
    "function getBotInfo(){return null;} function getSkipExtractions(){return false;} function scrollToBottom(){}" +
    "async function selectBot(_b, t){ activeConvId = 'C1'; activeThreadId = null; await loadThreads(t); }" +
    threadManagerScript() +
    connectorSelectorScript() +
    (await deepLinkBlockSource()) +
    "selectedConnectorId = 'sidebar-conn';" +
    "return { handleDeepLink: handleDeepLink, sendMessage: sendMessage, isWikiThread: isWikiThread," +
    " active: function(){ return activeThreadId; } };";
  const made = new Function("ctx", body)(ctx) as {
    handleDeepLink: () => Promise<void>;
    sendMessage: () => Promise<void>;
    isWikiThread: (id: string) => boolean;
    active: () => string | null;
  };
  return {
    fetchCalls, notices, made,
    selector: () => byIdEl("connectorSelector").style as Record<string, string>,
    title: () => (chatHeader.querySelector as (s: string) => { textContent: string })(".chat-title").textContent,
    input: chatInput as { value: string; disabled: boolean; placeholder: string },
    get patches() { return fetchCalls.filter((f) => f.method === "PATCH"); },
    get sends() { return fetchCalls.filter((f) => f.method === "POST" && f.url.indexOf("/messages") > -1); },
  };
}

describe("a wiki thread the thread list leaves out, reached by link (fix round 1 batch 2)", () => {
  const MAIN = { id: "M1", name: "main", kind: "chat" };
  const wikiT1 = (closedAt?: number) => ({ id: "T1", name: "wiki: plans/a.mdx", kind: "wiki", botName: "jarvis", userId: "u1", wiki: "mimir", relPath: "plans/a.mdx", ...(closedAt ? { closedAt } : {}) });

  test("one the list omits but a lookup finds open: no selector, no stamp, a header naming it, and a 409 closed gives the text back (the Jira control: jira-entry.test.ts)", async () => {
    const h = await pageHarness({ list: [MAIN], byId: wikiT1(), sendStatus: 409, sendError: { error: "the discussion was closed with Start over", reason: "closed" } });
    await h.made.handleDeepLink();
    expect(h.made.active()).toBe("T1");
    expect(h.made.isWikiThread("T1")).toBe(true);
    expect(h.selector().display).toBe("none");
    expect(h.title()).toContain("wiki: plans/a.mdx");
    h.input.value = "Is it still open?";
    await h.made.sendMessage();
    expect(h.patches).toEqual([]);
    expect(h.sends).toHaveLength(1);
    expect(h.input.value).toBe("Is it still open?");
    expect(h.notices).toEqual(["the discussion was closed with Start over"]);
  });

  test("a closed one is read-only: the box is disabled, a send does nothing, nothing is stamped", async () => {
    const h = await pageHarness({ list: [MAIN], byId: wikiT1(5) });
    await h.made.handleDeepLink();
    expect(h.made.active()).toBe("T1");
    expect(h.made.isWikiThread("T1")).toBe(true);
    expect(h.selector().display).toBe("none");
    expect(h.title()).toContain("(closed)");
    expect(h.input.disabled).toBe(true);
    h.input.value = "typed anyway";
    await h.made.sendMessage();
    expect(h.sends).toEqual([]);
    expect(h.patches).toEqual([]);
    expect(h.input.value).toBe("typed anyway");
  });
});
