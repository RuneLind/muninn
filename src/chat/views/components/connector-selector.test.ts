import { test, expect, describe } from "bun:test";
import path from "node:path";
import { connectorSelectorScript } from "./connector-selector.ts";

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
  threads: { id: string; connectorId?: string | null }[];
  /** What the sidebar remembers (the value that would get stamped). */
  selectedConnectorId: string;
  /** Query string of the deep link. */
  search: string;
  /** Whether `GET /chat/pending/:id` has a seed to deliver. */
  pendingText?: string;
}): Promise<Harness> {
  const fetchCalls: FetchCall[] = [];
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
    chatMessages: { querySelector: () => null },
    threads: opts.threads.map((t) => ({ ...t })),
    connectors: [] as unknown[],
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({
        url,
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return {
        ok: true,
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
    "async function selectBot(_b, t){ activeConvId = 'C1'; activeThreadId = t || null; }" +
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
