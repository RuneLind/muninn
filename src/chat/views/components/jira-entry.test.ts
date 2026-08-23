import { describe, expect, test } from "bun:test";
import { jiraEntryScript } from "./jira-entry.ts";
import {
  initialJiraEntryState,
  jiraEntryButtonHtml,
  jiraEntryCanSubmit,
  jiraEntryDraftBody,
  jiraEntryDraftLinkHtml,
  jiraEntryOutcome,
  jiraEntryPanelHtml,
  jiraEntryVisible,
  JE_POPUP_BLOCKED_MESSAGE,
} from "./jira-entry-pure.ts";

/**
 * Harness for the INJECTED half — the `connector-selector.test.ts` precedent.
 *
 * The pure module's tests cover the decisions; what only reproduces in the
 * script are the seams between them: the button appears on the feedback row the
 * page hands it, the click pre-opens a tab BEFORE the await, a refusal closes
 * that tab and writes the SERVER's sentence into the panel, and a success sends
 * the tab to `/jira?draft=<id>`. None of that is reachable from a pure test, and
 * all of it is where a browser-only bug would live.
 *
 * The DOM is stubbed rather than emulated: this file drives the real
 * `jiraEntryScript()` source, so a change to it that breaks the sequence fails
 * here even though no browser is involved.
 */

interface FetchCall {
  url: string;
  method: string;
  contentType: string | undefined;
  body: unknown;
}

interface FakeTab {
  closed: boolean;
  location: { href: string };
  close: () => void;
}

interface Harness {
  fetchCalls: FetchCall[];
  /** The markup currently standing where the picker panel is. */
  panelHtml: () => string | null;
  /** The markup appended to the feedback row (the control itself). */
  rowHtml: () => string;
  rowClasses: () => string[];
  /** Every tab `window.open` handed out, newest last. */
  tabs: FakeTab[];
  /** How many times an already-open panel was re-focused rather than rebuilt. */
  scrolledIntoView: () => number;
  attach: () => void;
  clickOpen: () => Promise<void>;
  clickSubmit: () => Promise<void>;
  clickCancel: () => Promise<void>;
  /** What a thread switch does to the panel — `loadThreadMessages`'s reset. */
  closePanel: () => Promise<void>;
  /** Answer a POST held open by `deferPost`. */
  settlePost: (status: number, body: unknown) => Promise<void>;
}

async function harness(opts: {
  selectedBot?: string;
  jiraBot?: string | null;
  activeThreadId?: string | null;
  templatesResponse?: { ok: boolean; body: unknown };
  /** One entry per `/api/jira/templates` call; the last one repeats. */
  templatesResponses?: { ok: boolean; body: unknown }[];
  postStatus?: number;
  postBody?: unknown;
  postThrows?: boolean;
  popupBlocked?: boolean;
  /** Hold the POST open until `settlePost` — the in-flight window. */
  deferPost?: boolean;
}): Promise<Harness> {
  const fetchCalls: FetchCall[] = [];
  const tabs: FakeTab[] = [];
  let templatesCalls = 0;
  let settlePostResolve: ((status: number, body: unknown) => void) | null = null;
  let panelHtml: string | null = null;
  let rowHtml = "";
  const rowClasses: string[] = [];
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};

  let scrolledIntoView = 0;
  const panelNode = {
    contains: () => false,
    scrollIntoView() {
      scrolledIntoView += 1;
    },
    remove() {
      panelHtml = null;
    },
    get outerHTML() {
      return panelHtml ?? "";
    },
    set outerHTML(v: string) {
      panelHtml = v;
    },
    querySelector: () => null,
  };

  const msgNode = {
    insertAdjacentHTML(_pos: string, html: string) {
      panelHtml = html;
    },
  };

  const wrapNode = {
    insertAdjacentHTML(_pos: string, html: string) {
      rowHtml += html;
    },
    classList: { add: (c: string) => rowClasses.push(c) },
  };

  const doc = {
    activeElement: null,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    getElementById(id: string) {
      if (id === "jePanel") return panelHtml === null ? null : panelNode;
      if (id === "jeSubmit") return { disabled: false };
      if (id === "jeMsg") return { querySelector: () => null };
      return null;
    },
  };

  const ctx = {
    document: doc,
    window: {
      open: () => {
        if (opts.popupBlocked) return null;
        const tab: FakeTab = {
          closed: false,
          location: { href: "" },
          close() {
            tab.closed = true;
          },
        };
        tabs.push(tab);
        return tab;
      },
    },
    fetch: async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      fetchCalls.push({
        url,
        method: init?.method || "GET",
        contentType: init?.headers?.["content-type"],
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      if (url === "/api/jira/templates") {
        const queued = opts.templatesResponses;
        const t = queued
          ? (queued[Math.min(templatesCalls++, queued.length - 1)] as { ok: boolean; body: unknown })
          : (opts.templatesResponse ?? {
              ok: true,
              body: { bot: "melosys", templates: [{ id: "bug", label: "Bug" }, { id: "task", label: "Oppgave" }] },
            });
        return { ok: t.ok, status: t.ok ? 200 : 503, json: async () => t.body };
      }
      if (opts.postThrows) throw new Error("nettverket falt");
      if (opts.deferPost) {
        return await new Promise((resolve) => {
          settlePostResolve = (status: number, body: unknown) =>
            resolve({ ok: status === 200, status, json: async () => body });
        });
      }
      return { ok: (opts.postStatus ?? 200) === 200, status: opts.postStatus ?? 200, json: async () => opts.postBody };
    },
    // The pure half, exactly as the page's bundle puts it on globalThis.
    pure: {
      initialJiraEntryState,
      jiraEntryButtonHtml,
      jiraEntryCanSubmit,
      jiraEntryDraftBody,
      jiraEntryDraftLinkHtml,
      jiraEntryOutcome,
      jiraEntryPanelHtml,
      jiraEntryVisible,
      JE_POPUP_BLOCKED_MESSAGE,
    },
    wrapNode,
    msgNode,
  };

  const prelude =
    "var document = ctx.document; var window = ctx.window; var fetch = ctx.fetch;" +
    "var initialJiraEntryState = ctx.pure.initialJiraEntryState;" +
    "var jiraEntryButtonHtml = ctx.pure.jiraEntryButtonHtml;" +
    "var jiraEntryCanSubmit = ctx.pure.jiraEntryCanSubmit;" +
    "var jiraEntryDraftBody = ctx.pure.jiraEntryDraftBody;" +
    "var jiraEntryDraftLinkHtml = ctx.pure.jiraEntryDraftLinkHtml;" +
    "var jiraEntryOutcome = ctx.pure.jiraEntryOutcome;" +
    "var jiraEntryPanelHtml = ctx.pure.jiraEntryPanelHtml;" +
    "var jiraEntryVisible = ctx.pure.jiraEntryVisible;" +
    "var JE_POPUP_BLOCKED_MESSAGE = ctx.pure.JE_POPUP_BLOCKED_MESSAGE;" +
    `var selectedBot = ${JSON.stringify(opts.selectedBot ?? "melosys")};` +
    `var activeThreadId = ${JSON.stringify(opts.activeThreadId === undefined ? "t-1" : opts.activeThreadId)};` +
    "function scrollToBottom(){}";

  const made = new Function(
    "ctx",
    prelude +
      jiraEntryScript() +
      `jiraBotName = ${JSON.stringify(opts.jiraBot === undefined ? "melosys" : opts.jiraBot)};` +
      "return { appendJiraEntryControl: appendJiraEntryControl, closeJiraEntry: closeJiraEntry };",
  )(ctx) as { appendJiraEntryControl: (wrap: unknown) => void; closeJiraEntry: () => void };

  const flush = async (): Promise<void> => {
    // Let the handler's own async work settle — the click handler kicks
    // `submitJiraEntry` without awaiting it (it must not block the event).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  const fire = async (type: string, target: unknown): Promise<void> => {
    for (const fn of listeners[type] ?? []) fn({ target, preventDefault() {} });
    await flush();
  };

  // `.msg-feedback` resolves to the SAME row node `appendJiraEntryControl` wrote
  // the control into — that is the container the popup-blocked link falls back to.
  const btnTarget = (sel: string, threadId?: string) => ({
    closest: (q: string): unknown =>
      q === sel ? btnTarget(sel, threadId) : q === ".msg" ? msgNode : q === ".msg-feedback" ? wrapNode : null,
    getAttribute: (n: string) =>
      n === "data-je-thread" ? (threadId ?? opts.activeThreadId ?? "t-1") : null,
  });

  return {
    fetchCalls,
    tabs,
    panelHtml: () => panelHtml,
    rowHtml: () => rowHtml,
    rowClasses: () => rowClasses,
    scrolledIntoView: () => scrolledIntoView,
    attach: () => made.appendJiraEntryControl(wrapNode),
    clickOpen: () => fire("click", btnTarget("[data-je-btn]")),
    clickSubmit: () => fire("click", btnTarget("#jeSubmit")),
    clickCancel: () => fire("click", btnTarget("#jeCancel")),
    closePanel: async () => {
      made.closeJiraEntry();
      await flush();
    },
    settlePost: async (status: number, body: unknown) => {
      settlePostResolve?.(status, body);
      await flush();
    },
  };
}

describe("the control on a finalized bot message", () => {
  test("renders on the Jira bot and un-hides the hover-only feedback row", async () => {
    const h = await harness({});
    h.attach();
    expect(h.rowHtml()).toContain("Lag Jira-sak");
    expect(h.rowHtml()).toContain('data-je-thread="t-1"');
    expect(h.rowClasses()).toContain("has-jira");
  });

  test("renders NOTHING on another bot's chat", async () => {
    const h = await harness({ selectedBot: "jarvis" });
    h.attach();
    expect(h.rowHtml()).toBe("");
    expect(h.rowClasses()).toEqual([]);
  });

  test("renders nothing when no Jira bot resolved, or no thread is selected", async () => {
    const noBot = await harness({ jiraBot: null });
    noBot.attach();
    expect(noBot.rowHtml()).toBe("");
    const noThread = await harness({ activeThreadId: null });
    noThread.attach();
    expect(noThread.rowHtml()).toBe("");
  });
});

describe("the picker", () => {
  test("opens, fetches the templates once and preselects the first", async () => {
    const h = await harness({});
    h.attach();
    await h.clickOpen();
    expect(h.fetchCalls.map((f) => f.url)).toEqual(["/api/jira/templates"]);
    expect(h.panelHtml()).toContain('value="bug" selected');
    expect(h.panelHtml()).toContain("Oppgave");
  });

  test("Avbryt removes it", async () => {
    const h = await harness({});
    h.attach();
    await h.clickOpen();
    expect(h.panelHtml()).not.toBeNull();
    await h.clickCancel();
    expect(h.panelHtml()).toBeNull();
  });
});

describe("the POST", () => {
  test("carries application/json and the validated body — the route 415s anything else", async () => {
    const h = await harness({ postStatus: 200, postBody: { draftId: "d-9", status: "generating" } });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    const post = h.fetchCalls.find((f) => f.method === "POST")!;
    expect(post.url).toBe("/api/jira/draft/from-thread");
    expect(post.contentType).toBe("application/json");
    expect(post.body).toEqual({ threadId: "t-1", template: "bug", depth: "skisse" });
  });

  test("a success sends the PRE-OPENED tab to the composer and closes the picker", async () => {
    const h = await harness({ postStatus: 200, postBody: { draftId: "d-9" } });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    expect(h.tabs).toHaveLength(1);
    expect(h.tabs[0]!.location.href).toBe("/jira?draft=d-9");
    expect(h.tabs[0]!.closed).toBe(false);
    expect(h.panelHtml()).toBeNull();
  });

  test("a 409 renders the SERVER's own sentence inline and closes the blank tab", async () => {
    const h = await harness({
      postStatus: 409,
      postBody: {
        state: "running",
        expiresAtMs: 1,
        error: "Det skrives allerede en sak fra denne samtalen — vent til den er ferdig.",
      },
    });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    expect(h.panelHtml()).toContain("Det skrives allerede en sak fra denne samtalen");
    expect(h.panelHtml()).toContain("je-msg-err");
    expect(h.tabs[0]!.closed).toBe(true);
    // The panel stays open so the reader can retry once the turn finishes.
    expect(h.panelHtml()).toContain("Lag utkast");
  });

  test("a 400 (wrong bot) and a 503 land the same way", async () => {
    const wrongBot = await harness({
      postStatus: 400,
      postBody: { error: 'Samtalen tilhører boten "jarvis", men Jira-komponisten kjører på "melosys".' },
    });
    wrongBot.attach();
    await wrongBot.clickOpen();
    await wrongBot.clickSubmit();
    expect(wrongBot.panelHtml()).toContain('tilhører boten &quot;jarvis&quot;');

    const down = await harness({ postStatus: 503, postBody: { error: "Full teknisk dybde krever kodeverktøyene…" } });
    down.attach();
    await down.clickOpen();
    await down.clickSubmit();
    expect(down.panelHtml()).toContain("Full teknisk dybde krever kodeverkt");
  });

  test("a thrown fetch is a refusal, not a silent nothing", async () => {
    const h = await harness({ postThrows: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    expect(h.panelHtml()).toContain("Fikk ikke kontakt med serveren");
    expect(h.tabs[0]!.closed).toBe(true);
  });

  test("a blocked popup keeps the started draft reachable as a link", async () => {
    const h = await harness({ popupBlocked: true, postStatus: 200, postBody: { draftId: "d-9" } });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    expect(h.panelHtml()).toContain('href="/jira?draft=d-9"');
    expect(h.panelHtml()).toContain("Åpne utkastet");
  });
});

/**
 * The POST is in flight and the panel goes away underneath it.
 *
 * Two ways that happens — the reader clicks Avbryt, or switches thread (which
 * wipes the whole message list). The turn RAN either way: a row exists, the
 * thread's single-flight slot is held, and the next attempt is a 409 about work
 * the reader was never shown. So a 200 must reach the pre-opened tab BEFORE any
 * state check, and Avbryt must not be clickable while a POST is on the wire.
 */
describe("the panel disappearing mid-POST", () => {
  test("a 200 that lands after Avbryt still sends the pre-opened tab to the draft", async () => {
    const h = await harness({ deferPost: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    // Avbryt is refused while sending (below) — this is the thread-switch shape:
    // the panel is torn down by the page, not by the reader.
    await h.closePanel();
    expect(h.panelHtml()).toBeNull();

    await h.settlePost(200, { draftId: "d-9" });
    expect(h.tabs).toHaveLength(1);
    expect(h.tabs[0]!.location.href).toBe("/jira?draft=d-9");
    expect(h.tabs[0]!.closed).toBe(false);
  });

  test("a refusal that lands after the panel is gone is dropped — the tab still closes", async () => {
    const h = await harness({ deferPost: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    await h.closePanel();
    await h.settlePost(409, { error: "Det skrives allerede en sak fra denne samtalen." });
    expect(h.tabs[0]!.closed).toBe(true);
    // Nothing was resurrected to render the refusal into.
    expect(h.panelHtml()).toBeNull();
  });

  test("Avbryt is DISABLED while sending, and a click on it is a no-op", async () => {
    const h = await harness({ deferPost: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    const html = h.panelHtml()!;
    expect(html).toContain("Starter…");
    // The disabled attribute and the reason, on the Avbryt button itself.
    expect(html).toMatch(/id="jeCancel"[^>]*disabled/);
    expect(html).toContain("Utkastet skrives — vent");

    // A delegated listener still sees the click in a stubbed DOM (and in a real
    // one, a `pointer-events` style could too) — the handler refuses it.
    await h.clickCancel();
    expect(h.panelHtml()).not.toBeNull();

    await h.settlePost(200, { draftId: "d-9" });
    expect(h.tabs[0]!.location.href).toBe("/jira?draft=d-9");
  });
});

/**
 * The draft id must survive BOTH losses at once.
 *
 * A blocked popup and a torn-down panel are each handled — the first renders a
 * link, the second lets the tab carry the reader. Together they left nothing: the
 * 200 could not navigate a tab (there is none) and could not render into a panel
 * (it is gone), so the only pointer to a draft that EXISTS — a row, a visible
 * chat turn, a held flight slot — was dropped on the floor.
 */
describe("a blocked popup with the panel already gone", () => {
  test("renders the link into the originating message's feedback row", async () => {
    const h = await harness({ popupBlocked: true, deferPost: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    await h.closePanel();
    expect(h.panelHtml()).toBeNull();

    await h.settlePost(200, { draftId: "d-9" });
    // The control's own container — un-hidden by `has-jira` already, so the link
    // is visible without a hover.
    expect(h.rowHtml()).toContain('href="/jira?draft=d-9"');
    expect(h.rowHtml()).toContain("Åpne utkastet");
    expect(h.panelHtml()).toBeNull();
  });

  test("a REFUSAL after the panel is gone still renders nothing — there is no draft", async () => {
    const h = await harness({ popupBlocked: true, deferPost: true });
    h.attach();
    const before = h.rowHtml();
    await h.clickOpen();
    await h.clickSubmit();
    await h.closePanel();
    await h.settlePost(409, { error: "Det skrives allerede en sak fra denne samtalen." });
    expect(h.rowHtml()).toBe(before);
  });
});

/**
 * A second «Lag Jira-sak» while the POST is on the wire.
 *
 * Rebuilding the panel resets `sending` (so Avbryt and the submit button come
 * back to life on a turn that is already running) and, worse, the in-flight 200
 * then matched `jiraEntryThreadId === threadId` and CLOSED the panel the reader
 * had just opened. The existing panel is the one that will receive the answer, so
 * a second open in the same thread re-focuses it instead.
 */
describe("a second open while a POST is in flight", () => {
  test("re-focuses the existing panel instead of rebuilding it", async () => {
    const h = await harness({ deferPost: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    const sending = h.panelHtml()!;
    expect(sending).toContain("Starter…");

    await h.clickOpen();
    // Not rebuilt: still the sending panel, and no second templates fetch.
    expect(h.panelHtml()).toBe(sending);
    expect(h.scrolledIntoView()).toBe(1);
    expect(h.fetchCalls.filter((f) => f.url === "/api/jira/templates")).toHaveLength(1);

    // …and the answer still lands on that one panel.
    await h.settlePost(200, { draftId: "d-9" });
    expect(h.tabs).toHaveLength(1);
    expect(h.tabs[0]!.location.href).toBe("/jira?draft=d-9");
    expect(h.panelHtml()).toBeNull();
  });

  test("a finished POST releases the guard — the next open rebuilds normally", async () => {
    const h = await harness({ deferPost: true });
    h.attach();
    await h.clickOpen();
    await h.clickSubmit();
    await h.settlePost(409, { error: "Det skrives allerede en sak fra denne samtalen." });
    expect(h.panelHtml()).toContain("Lag utkast");

    await h.clickOpen();
    expect(h.scrolledIntoView()).toBe(0);
    expect(h.panelHtml()).not.toContain("Det skrives allerede en sak");
  });
});

describe("the templates fetch", () => {
  test("a FAILURE is retried on the next open — only success is cached", async () => {
    const h = await harness({
      templatesResponses: [
        { ok: false, body: { error: "Jira-komponisten er ikke tilgjengelig." } },
        { ok: true, body: { bot: "melosys", templates: [{ id: "bug", label: "Bug" }] } },
      ],
    });
    h.attach();
    await h.clickOpen();
    expect(h.panelHtml()).toContain("Jira-komponisten er ikke tilgjengelig.");

    await h.clickCancel();
    await h.clickOpen();
    // Two fetches: the cached error used to make the picker permanently dead for
    // the life of the page, so a restarted server never came back.
    expect(h.fetchCalls.filter((f) => f.url === "/api/jira/templates")).toHaveLength(2);
    expect(h.panelHtml()).toContain('value="bug" selected');
    expect(h.panelHtml()).not.toContain("Jira-komponisten er ikke tilgjengelig.");
  });

  test("a SUCCESS is fetched once and reused across opens", async () => {
    const h = await harness({});
    h.attach();
    await h.clickOpen();
    await h.clickCancel();
    await h.clickOpen();
    expect(h.fetchCalls.filter((f) => f.url === "/api/jira/templates")).toHaveLength(1);
  });
});
