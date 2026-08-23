import { describe, expect, test } from "bun:test";
import { jiraEntryScript } from "./jira-entry.ts";
import {
  initialJiraEntryState,
  jiraEntryButtonHtml,
  jiraEntryCanSubmit,
  jiraEntryDraftBody,
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
  attach: () => void;
  clickOpen: () => Promise<void>;
  clickSubmit: () => Promise<void>;
  clickCancel: () => Promise<void>;
}

async function harness(opts: {
  selectedBot?: string;
  jiraBot?: string | null;
  activeThreadId?: string | null;
  templatesResponse?: { ok: boolean; body: unknown };
  postStatus?: number;
  postBody?: unknown;
  postThrows?: boolean;
  popupBlocked?: boolean;
}): Promise<Harness> {
  const fetchCalls: FetchCall[] = [];
  const tabs: FakeTab[] = [];
  let panelHtml: string | null = null;
  let rowHtml = "";
  const rowClasses: string[] = [];
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};

  const panelNode = {
    contains: () => false,
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
        const t = opts.templatesResponse ?? {
          ok: true,
          body: { bot: "melosys", templates: [{ id: "bug", label: "Bug" }, { id: "task", label: "Oppgave" }] },
        };
        return { ok: t.ok, status: t.ok ? 200 : 503, json: async () => t.body };
      }
      if (opts.postThrows) throw new Error("nettverket falt");
      return { ok: (opts.postStatus ?? 200) === 200, status: opts.postStatus ?? 200, json: async () => opts.postBody };
    },
    // The pure half, exactly as the page's bundle puts it on globalThis.
    pure: {
      initialJiraEntryState,
      jiraEntryButtonHtml,
      jiraEntryCanSubmit,
      jiraEntryDraftBody,
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
      "return { appendJiraEntryControl: appendJiraEntryControl };",
  )(ctx) as { appendJiraEntryControl: (wrap: unknown) => void };

  const fire = async (type: string, target: unknown): Promise<void> => {
    for (const fn of listeners[type] ?? []) fn({ target, preventDefault() {} });
    // Let the handler's own async work settle — the click handler kicks
    // `submitJiraEntry` without awaiting it (it must not block the event).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  const btnTarget = (sel: string) => ({
    closest: (q: string) => (q === sel ? btnTarget(sel) : q === ".msg" ? msgNode : null),
    getAttribute: (n: string) => (n === "data-je-thread" ? (opts.activeThreadId ?? "t-1") : null),
  });

  return {
    fetchCalls,
    tabs,
    panelHtml: () => panelHtml,
    rowHtml: () => rowHtml,
    rowClasses: () => rowClasses,
    attach: () => made.appendJiraEntryControl(wrapNode),
    clickOpen: () => fire("click", btnTarget("#jeOpen")),
    clickSubmit: () => fire("click", btnTarget("#jeSubmit")),
    clickCancel: () => fire("click", btnTarget("#jeCancel")),
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
