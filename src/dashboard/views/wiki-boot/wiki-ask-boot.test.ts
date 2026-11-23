/**
 * The /wiki reader's Ask tab (`wiki-ask-controller.ts`, C4) driven through the
 * booted shell: a stored session rehydrates at boot, an Ask turn streamed over a
 * stubbed `EventSource` paints progressively into the article pane and clears
 * the shown page through `enterView("ask")`'s teardown (`leaveView`), and the follow-up bar and
 * the history list reach the controller's exports through `boot()`'s
 * delegates. The page opens in graph mode, so "the shown page is cleared" is
 * checked on graph mode too: a page opened after the answer reads as an article.
 *
 * Isolation (load-bearing, pinned by `src/test/mock-isolation.test.ts`): this
 * file installs happy-dom's globals over Bun's own for the life of the process,
 * so it runs in a `bun test` link of its own in every chain, like
 * `wiki-shell-boot.test.ts` beside it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

const g = globalThis as unknown as Record<string, unknown>;

/** Never copied over: globalThis's own identity, the two value-literals, and
 *  `console`, which stays Bun's so test output keeps working. */
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);
const saved = new Map<string, PropertyDescriptor | undefined>();

function installWindow(w: GlobalWindow): void {
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(w))) {
    if (IGNORE.has(key)) continue;
    const cur = Object.getOwnPropertyDescriptor(globalThis, key);
    if (cur && "value" in desc && cur.value === desc.value) continue;
    saved.set(key, cur);
    const next = "value" in desc && desc.value === w ? { ...desc, value: globalThis } : desc;
    Object.defineProperty(globalThis, key, { ...next, configurable: true });
  }
}

function restoreGlobals(): void {
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
  saved.clear();
  for (const k of ["__WIKI_NAME__", "__WIKI_ROOT__", "__WIKI_FIND_SELF__", "__WIKI_FIND_ROWS__", "EventSource"]) delete g[k];
}

const page = (relPath: string) => ({
  relPath,
  name: relPath.replace(/\.md$/, ""),
  title: relPath.replace(/\.md$/, "").toUpperCase(),
  type: "plan",
  domain: "ai",
  tags: [],
  aliases: [],
  linkCount: 0,
  backlinkCount: 0,
});
// A tracker on the listing: graph mode exists only there. `e.md` is typed
// `explainer` (a `.wiki-reader.json` can type a markdown page so): it opens
// through `loadExplainer`, which leaves `currentPageHash` alone, yet its rail
// row keeps the series ⋯ (`canEditSeriesPage` tests the extension).
const LISTING = { pages: [page("p.md"), page("k.md"), { ...page("e.md"), type: "explainer" }], scannedAt: Date.now(), trackers: [{ id: "jira", label: "Jira" }] };
/** The session a previous visit stored: one answered turn. */
const STORED = [{ question: "What did we decide?", answer: "We decided X.", citations: [], cited: [], html: "<p>We decided X.</p>", askedAt: Date.now() - 60_000 }];

const fetched: string[] = [];
/** The bodies of every `POST /api/wiki/series`, parsed. */
const seriesPosts: Record<string, unknown>[] = [];
/** The bodies of every `POST /api/wiki/remember`, parsed. */
const rememberPosts: Record<string, unknown>[] = [];
/** A request held until the test releases it, by `<path>?relPath=<rel>`. */
const holds = new Map<string, Promise<void>>();
function hold(key: string): () => void {
  let release!: () => void;
  holds.set(key, new Promise<void>((r) => (release = r)));
  return () => {
    holds.delete(key);
    release();
  };
}
/** Page relPaths whose `/api/wiki/page` fetch rejects, as a network failure does. */
const failingPages = new Set<string>();
/** When set, `POST /api/wiki/remember` answers 500 with this error. */
let rememberError: string | null = null;
async function stubFetch(input: unknown, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const raw = String(input);
  fetched.push(raw);
  const url = new URL(raw, "http://localhost:3011");
  const held = holds.get(`${url.pathname}?relPath=${url.searchParams.get("relPath")}`);
  if (held) await held;
  if (url.pathname === "/api/wiki/page" && failingPages.has(url.searchParams.get("relPath") ?? "")) throw new TypeError("network down");
  const R = g.Response as typeof Response;
  if (url.pathname === "/api/wiki/remember" && rememberError !== null) {
    return new R(JSON.stringify({ error: rememberError }), { status: 500, headers: { "content-type": "application/json" } });
  }
  let body: unknown = {};
  if (url.pathname === "/api/wiki/pages") body = LISTING;
  else if (url.pathname === "/api/wiki/page") {
    const rel = url.searchParams.get("relPath") ?? "p.md";
    body = { meta: LISTING.pages.find((p) => p.relPath === rel) ?? LISTING.pages[0], html: `<h1>${rel}</h1><p>Body.</p>`, outgoing: [], backlinks: [], hash: "h-" + rel };
  } else if (url.pathname === "/api/wiki/graph") body = { nodes: [], edges: [] };
  else if (url.pathname === "/api/wiki/factcheck/append") body = { written: true };
  else if (url.pathname === "/api/wiki/remember" && init?.method === "POST") {
    rememberPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    body = { saved: true, summary: "sum:" + String(rememberPosts.at(-1)!.question) };
  }
  else if (url.pathname === "/api/wiki/series" && init?.method === "POST") {
    seriesPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    body = { written: true };
  }
  return new R(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** The `EventSource` `sseClient` opens: records its URL, and the test emits
 *  the server's events into it by hand. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  readonly url: string;
  readyState = 1;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private readonly handlers = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = String(url);
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
  emit(type: string, data: unknown = {}): void {
    const ME = g.MessageEvent as typeof MessageEvent;
    for (const fn of this.handlers.get(type) ?? []) fn(new ME(type, { data: JSON.stringify(data) }));
  }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** One animation frame, so a progressive render scheduled with rAF has run. */
const frame = () => new Promise<void>((r) => (g.requestAnimationFrame as typeof requestAnimationFrame)(() => r()));

/** The history list's item for question `q`. */
const histItem = (q: string) =>
  Array.from((g.document as Document).querySelectorAll<HTMLElement>("#wikiAskHistory [data-ask-idx]")).find((el) => el.textContent === q)!;
/** Ask `q` from the Ask box and stream a whole answer to it. */
function askAndFinish(q: string): void {
  const input = (g.document as Document).getElementById("wikiAskInput") as HTMLTextAreaElement;
  input.value = q;
  (g.document as Document).getElementById("wikiAskBtn")!.click();
  const es = FakeEventSource.all.at(-1)!;
  es.emit("done", { answer: `Answer to ${q}`, cited: [] });
  es.emit("answer_html", { html: `<p>Answer to ${q}</p>`, cited: [] });
}

/** Back/Forward to `url`: the shell's popstate route. */
function popTo(url: string): void {
  (g.history as History).pushState(null, "", url);
  fetched.length = 0;
  (g.window as Window).dispatchEvent(new (g.PopStateEvent as typeof PopStateEvent)("popstate", { state: null }));
}

let win: GlobalWindow;
let handle: { dispose(): void };
const doc = () => g.document as Document;
const wrap = () => doc().getElementById("articleWrap")!;

beforeAll(async () => {
  const { renderWikiPage } = await import("../wiki-page.ts");
  const html = (await renderWikiPage({ wikis: ["w"], selected: "w", wikiRoot: "/tmp/w" })).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  win = new GlobalWindow({
    url: "http://localhost:3011/wiki?wiki=w&relPath=p.md&display=graph",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableMainFrameNavigation: true } },
  });
  win.document.write(html);
  installWindow(win);
  Object.assign(g, { __WIKI_NAME__: "w", __WIKI_ROOT__: "/tmp/w", __WIKI_FIND_SELF__: "w", __WIKI_FIND_ROWS__: "w" });
  g.fetch = stubFetch;
  g.EventSource = FakeEventSource;
  (g.localStorage as Storage).setItem("wikiAskSession:w", JSON.stringify(STORED));
  const { boot } = await import("../components/wiki-browser.ts");
  handle = boot();
  await until(() => !!doc().querySelector("#articleWrap h1"), "the article to render");
}, 30_000);

afterAll(async () => {
  handle?.dispose();
  await win?.happyDOM.abort();
  win?.close();
  restoreGlobals();
});

describe("the Ask tab (wiki-ask-controller.ts), driven through the booted shell", () => {
  test("the stored session rehydrates into the history list at boot, without showing an answer", async () => {
    const { getAskTurns } = await import("../components/wiki-ask-controller.ts");
    expect(getAskTurns().map((t) => t.question)).toEqual(["What did we decide?"]);
    const items = doc().querySelectorAll("#wikiAskHistory [data-ask-idx]");
    expect(items.length).toBe(1);
    expect(items[0]!.textContent).toBe("What did we decide?");
    expect(doc().getElementById("askAnswerBody") === null).toBe(true);
  });

  test("the page opened in graph mode, with its breadcrumb", () => {
    expect(wrap().classList.contains("wiki-graph-on")).toBe(true);
    expect(doc().getElementById("wikiGraphToggle")!.getAttribute("aria-pressed")).toBe("true");
    expect(doc().getElementById("wikiBreadcrumb")!.style.display).not.toBe("none");
  });

  test("an asked question streams into the article pane, painting progressively, and clears the shown page", async () => {
    const input = doc().getElementById("wikiAskInput") as HTMLTextAreaElement;
    input.value = "How does the queue work?";
    doc().getElementById("wikiAskBtn")!.click();
    const es = FakeEventSource.all.at(-1)!;
    expect(es.url).toBe("/api/wiki/ask?q=How%20does%20the%20queue%20work%3F&wiki=w&history=" + encodeURIComponent(JSON.stringify([{ q: "What did we decide?", a: "We decided X." }])));
    // The answer replaced the page: no breadcrumb, graph mode's class gone, the Ask tab shown.
    expect(doc().getElementById("wikiBreadcrumb")!.style.display).toBe("none");
    expect(wrap().classList.contains("wiki-graph-on")).toBe(false);
    expect(!!doc().getElementById("askAnswerBody")).toBe(true);
    expect(doc().querySelector(".wiki-conn-tab.active")?.getAttribute("data-conntab")).toBe("ask");
    expect(doc().getElementById("askBody")!.style.display).toBe("flex");
    const paints: string[] = [];
    for (const text of ["## The queue\n\n", "Jobs wait in ", "**one** queue", " per wiki.\n"]) {
      es.emit("delta", { text });
      await frame();
      paints.push(doc().getElementById("askAnswerBody")!.innerHTML);
    }
    // Every delta painted on its own frame, each paint a longer one than the last.
    expect(new Set(paints).size).toBe(4);
    expect(paints[0]).toContain("The queue");
    expect(paints[1]).toContain("Jobs wait in");
    expect(paints[1]).not.toContain("one");
    expect(paints[3]).toContain("<strong>one</strong>");
    const stored = () => JSON.parse((g.localStorage as Storage).getItem("wikiAskSession:w")!) as { question: string; html: string | null }[];
    es.emit("done", { answer: "## The queue\n\nJobs wait in **one** queue per wiki.\n", cited: [] });
    // `done` commits and stores the turn; `answer_html` stores it again with its HTML.
    expect(stored().map((t) => t.question)).toEqual(["What did we decide?", "How does the queue work?"]);
    expect(stored()[1]!.html).toBe(null);
    es.emit("answer_html", { html: "<h2>The queue</h2><p>Final.</p>", cited: [] });
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("Final.");
    expect(es.readyState).toBe(2);
    expect(stored()[1]!.html).toContain("Final.");
    expect(doc().querySelectorAll("#wikiAskHistory [data-ask-idx]").length).toBe(2);
  });

  test("a page opened from the answer reads as an article: graph mode ended with the shown page", async () => {
    const link = doc().createElement("a");
    link.setAttribute("data-relpath", "k.md");
    link.href = "#";
    doc().getElementById("askAnswerBody")!.appendChild(link);
    link.click();
    await until(() => !!doc().querySelector("#articleWrap .wiki-article h1#kmd"), "k.md to render");
    expect(wrap().classList.contains("wiki-graph-on")).toBe(false);
    expect(doc().getElementById("wikiGraphToggle")!.getAttribute("aria-pressed")).toBe("false");
    expect(new URLSearchParams((g.location as Location).search).get("display")).toBe(null);
  });

  test("a history item re-shows its stored answer through the shell's delegate", () => {
    doc().querySelector<HTMLElement>('#wikiAskHistory [data-ask-idx="0"]')!.click();
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("We decided X.");
    expect(doc().getElementById("wikiBreadcrumb")!.style.display).toBe("none");
  });

  test("Enter in the follow-up bar opens the next turn's stream, carrying both turns as history", async () => {
    const { getAskShownTurn } = await import("../components/wiki-ask-controller.ts");
    expect(getAskShownTurn()?.question).toBe("What did we decide?");
    const before = FakeEventSource.all.length;
    const input = doc().getElementById("wikiFollowupInput") as HTMLInputElement;
    input.value = "And the second one?";
    const KE = g.KeyboardEvent as typeof KeyboardEvent;
    input.dispatchEvent(new KE("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(FakeEventSource.all.length).toBe(before + 1);
    const url = new URL(FakeEventSource.all.at(-1)!.url, "http://x");
    expect(url.pathname).toBe("/api/wiki/ask");
    expect(url.searchParams.get("q")).toBe("And the second one?");
    expect((JSON.parse(url.searchParams.get("history")!) as { q: string }[]).map((h) => h.q)).toEqual(["What did we decide?", "How does the queue work?"]);
    expect(getAskShownTurn()?.question).toBe("And the second one?");
  });

  test("a history item past the first re-shows THAT turn as the shown one, the turn ↻ and escalate act on", async () => {
    const { getAskShownTurn, getAskTurns } = await import("../components/wiki-ask-controller.ts");
    FakeEventSource.all.at(-1)!.emit("done", { answer: "The second one too.", cited: [] });
    expect(getAskTurns().map((t) => t.question)).toEqual(["What did we decide?", "How does the queue work?", "And the second one?"]);
    doc().querySelector<HTMLElement>('#wikiAskHistory [data-ask-idx="1"]')!.click();
    expect(getAskShownTurn()?.question).toBe("How does the queue work?");
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("Final.");
  });

  test("an answer clears the shown page's identity: no name, and no rail row reads as open", async () => {
    const { getCurrentName } = await import("../components/wiki-shell-state.ts");
    const activeRows = () => Array.from(doc().querySelectorAll(".wiki-list-item.active")).map((r) => r.getAttribute("data-relpath")).join(",");
    // Back/Forward's route opens a page in graph mode rooted at an issue.
    popTo("/wiki?wiki=w&relPath=k.md&display=graph&issue=jira:K-1");
    await until(() => fetched.some((u) => u.includes("/api/wiki/graph?scope=issue&root=jira%3AK-1")), "the issue graph to load");
    expect(getCurrentName()).toBe("k");
    expect(activeRows()).toBe("k.md");
    doc().querySelector<HTMLElement>('#wikiAskHistory [data-ask-idx="0"]')!.click();
    expect(!!doc().getElementById("askAnswerBody")).toBe(true);
    // `setCurrentName(null)` (showAskAnswer) and `setCurrentRelPath(null)`
    // (`leaveView`, run by `enterView`): the rail's active test keys on the relPath and falls back
    // to the name, so either one left set keeps k.md's row lit.
    expect(getCurrentName()).toBe(null);
    expect(activeRows()).toBe("");
  });

  test("an accepted fact-check append reloads the checked page in place, and the graph no longer roots at the old issue", async () => {
    // k.md again in graph mode at an issue; the fact check's answer then replaces it.
    popTo("/wiki?wiki=w&relPath=k.md&display=graph&issue=jira:K-1");
    await until(() => !!doc().querySelector("#articleWrap .wiki-article h1#kmd"), "k.md to render");
    await until(() => fetched.some((u) => u.includes("/api/wiki/graph?scope=issue&root=jira%3AK-1")), "the issue graph to load");
    const before = FakeEventSource.all.length;
    const ME = g.MouseEvent as typeof MouseEvent;
    doc().getElementById("wikiFactcheckArticleBtn")!.dispatchEvent(new ME("mousedown", { bubbles: true, cancelable: true }));
    expect(FakeEventSource.all.length).toBe(before + 1);
    const es = FakeEventSource.all.at(-1)!;
    expect(new URL(es.url, "http://x").pathname).toContain("factcheck");
    es.emit("done", { answer: "## ✅ Claim\n\nHolds.\n", cited: [], baseHash: "h-k.md" });
    const btn = () => doc().getElementById("wikiFactcheckAppendBtn") as HTMLButtonElement | null;
    await until(() => !!btn() && !btn()!.disabled, "the append button to enable");
    fetched.length = 0;
    btn()!.click();
    await until(() => fetched.some((u) => u.includes("/api/wiki/factcheck/append")), "the append POST");
    // `reloadCheckedPage` → `AskTurnPort.reloadPageInPlace` → the shell refetches the page.
    await until(() => fetched.some((u) => u.startsWith("/api/wiki/page?") && u.includes("relPath=k.md")), "the page refetch");
    await until(() => !!doc().querySelector("#articleWrap .wiki-article h1#kmd"), "k.md to render again");
    // The answer cleared `graphIssue` (`leaveView`), and the in-place reload
    // does not re-read the URL: graph mode turned on here roots at the page.
    fetched.length = 0;
    doc().getElementById("wikiGraphToggle")!.click();
    await until(() => fetched.some((u) => u.includes("/api/wiki/graph")), "the graph fetch");
    expect(fetched.filter((u) => u.includes("/api/wiki/graph")).map((u) => new URL(u, "http://x").searchParams.get("scope") + ":" + new URL(u, "http://x").searchParams.get("root")).join(" ")).toBe("page:k.md");
  });

  test("after an answer, an explainer opened from the rail carries no hash: a series write on it goes out with its fresh base", async () => {
    const { getCurrentName } = await import("../components/wiki-shell-state.ts");
    // md page p.md, loaded with the hash its page response carries (`h-p.md`).
    popTo("/wiki?wiki=w&relPath=p.md");
    await until(() => !!doc().querySelector("#articleWrap .wiki-article h1#pmd"), "p.md to render");
    expect(getCurrentName()).toBe("p");
    expect(fetched.some((u) => u.startsWith("/api/wiki/page?") && u.includes("relPath=p.md"))).toBe(true);
    // An Ask answer replaces it (`enterView("ask")` → `leaveView`).
    doc().querySelector<HTMLElement>('#wikiAskHistory [data-ask-idx="0"]')!.click();
    expect(!!doc().getElementById("askAnswerBody")).toBe(true);
    expect(getCurrentName()).toBe(null);
    // The explainer from the rail: `loadExplainer` sets the relPath, not the hash.
    doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="e.md"]')!.click();
    await until(() => !!doc().querySelector("#articleWrap iframe.wiki-explainer-frame"), "the explainer frame");
    expect(getCurrentName()).toBe("e");
    // Its ⋯, then a new series key: the menu reads e.md's fresh base (`h-e.md`)
    // and compares it with `openPageAtLoad().loadedHash`. Left at p.md's hash,
    // the two differ and the write is refused as "changed since you opened it".
    seriesPosts.length = 0;
    doc().querySelector<HTMLElement>('#wikiList [data-series-menu="e.md"]')!.click();
    const menu = doc().getElementById("wikiSeriesMenu")!;
    expect(!!menu).toBe(true);
    const form = menu.querySelector<HTMLFormElement>('[data-series-form="new"]')!;
    form.querySelector<HTMLInputElement>("[data-series-input]")!.value = "fresh-key";
    form.dispatchEvent(new (g.Event as typeof Event)("submit", { bubbles: true, cancelable: true }));
    await until(() => seriesPosts.length > 0 || /changed since you opened it/.test(doc().getElementById("wikiSeriesMenu")?.textContent ?? ""), "the write or its refusal");
    expect(doc().getElementById("wikiSeriesMenu")?.textContent ?? "").not.toContain("changed since you opened it");
    expect(seriesPosts.map((b) => `${b.relPath} ${b.series} ${b.baseHash}`)).toEqual(["e.md fresh-key h-e.md"]);
  });
  test("a history item clicked while an answer streams keeps its own answer: the live turn's events update the turn, not the pane (F21)", async () => {
    const { getAskShownTurn } = await import("../components/wiki-ask-controller.ts");
    const histItem = (q: string) =>
      Array.from(doc().querySelectorAll<HTMLElement>("#wikiAskHistory [data-ask-idx]")).find((el) => el.textContent === q)!;
    const input = doc().getElementById("wikiAskInput") as HTMLTextAreaElement;
    input.value = "Live question?";
    doc().getElementById("wikiAskBtn")!.click();
    const es = FakeEventSource.all.at(-1)!;
    es.emit("delta", { text: "LIVE-ONE " });
    await frame();
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("LIVE-ONE");
    // Mid-stream, the reader opens a stored turn.
    histItem("What did we decide?").click();
    expect(getAskShownTurn()?.question).toBe("What did we decide?");
    const shownIsHistory = () => {
      expect(wrap().innerHTML).toContain("We decided X.");
      expect(wrap().innerHTML).not.toContain("LIVE");
      expect(doc().getElementById("askAnswerMeta")!.textContent).toContain("0 sources");
    };
    es.emit("sources", { citations: [{ n: 1, collection: "c", docId: "d", title: "LIVE-SRC", badge: "b", relevance: 1 }] });
    shownIsHistory();
    es.emit("delta", { text: "LIVE-TWO" });
    await frame();
    shownIsHistory();
    es.emit("done", { answer: "LIVE-ONE LIVE-TWO final", cited: [1] });
    shownIsHistory();
    es.emit("answer_html", { html: "<p>LIVE-HTML final</p>", cited: [1] });
    await frame();
    shownIsHistory();
    expect(es.readyState).toBe(2);
    // The live turn kept every event: re-opened, it shows the whole answer and its source.
    histItem("Live question?").click();
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("LIVE-HTML final");
    expect(doc().getElementById("askAnswerSources")!.textContent).toContain("LIVE-SRC");
    expect(doc().getElementById("askAnswerMeta")!.textContent).toContain("1 source");
    // Remember on the stored turn sends the stored turn's answer, the one on screen.
    histItem("What did we decide?").click();
    rememberPosts.length = 0;
    doc().getElementById("wikiRememberBtn")!.click();
    await until(() => rememberPosts.length > 0, "the remember POST");
    expect(rememberPosts.map((b) => `${b.question} | ${b.answer}`)).toEqual(["What did we decide? | We decided X."]);
  });
  test("a page response that lands after an Ask answer replaced its view paints nothing (F22)", async () => {
    const { getCurrentName } = await import("../components/wiki-shell-state.ts");
    popTo("/wiki?wiki=w&relPath=p.md");
    await until(() => !!doc().querySelector("#articleWrap .wiki-article h1#pmd"), "p.md to render");
    const release = hold("/api/wiki/page?relPath=k.md");
    doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="k.md"]')!.click();
    await until(() => fetched.some((u) => u.includes("relPath=k.md")), "the k.md fetch");
    doc().querySelector<HTMLElement>("#wikiAskHistory [data-ask-idx]")!.click();
    expect(!!doc().getElementById("askAnswerBody")).toBe(true);
    release();
    await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 30));
    expect(!!doc().getElementById("askAnswerBody")).toBe(true);
    expect(doc().querySelector("#articleWrap h1#kmd")).toBe(null);
    expect(getCurrentName()).toBe(null);
    expect(doc().getElementById("wikiBreadcrumb")!.style.display).toBe("none");
  });

  test("an explainer's page payload that lands after an Ask answer replaced it leaves the answer's panes alone (F22)", async () => {
    const release = hold("/api/wiki/page?relPath=e.md");
    doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="e.md"]')!.click();
    await until(() => !!doc().querySelector("#articleWrap iframe.wiki-explainer-frame"), "the explainer frame");
    doc().querySelector<HTMLElement>("#wikiAskHistory [data-ask-idx]")!.click();
    const conn = doc().getElementById("connBody")!.textContent;
    expect(conn).toContain("Showing an Ask answer");
    release();
    await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 30));
    expect(doc().getElementById("connBody")!.textContent).toBe(conn);
    expect(!!doc().getElementById("askAnswerBody")).toBe(true);
  });

  test("an answer streaming while a clicked page's fetch is held keeps painting until the page replaces it (fix round 1)", async () => {
    const input = doc().getElementById("wikiAskInput") as HTMLTextAreaElement;
    input.value = "Held question?";
    doc().getElementById("wikiAskBtn")!.click();
    const es = FakeEventSource.all.at(-1)!;
    es.emit("delta", { text: "HELD-ONE " });
    await frame();
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("HELD-ONE");
    const release = hold("/api/wiki/page?relPath=k.md");
    doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="k.md"]')!.click();
    await until(() => fetched.some((u) => u.includes("relPath=k.md")), "the k.md fetch");
    es.emit("delta", { text: "HELD-TWO" });
    await frame();
    expect(doc().getElementById("askAnswerBody")!.innerHTML).toContain("HELD-TWO");
    es.emit("done", { answer: "HELD-ONE HELD-TWO", cited: [] });
    await frame();
    expect((doc().getElementById("wikiRememberBtn") as HTMLButtonElement).disabled).toBe(false);
    expect((doc().getElementById("wikiFollowupBtn") as HTMLButtonElement).disabled).toBe(false);
    // The held page still lands once released.
    release();
    await until(() => !!doc().querySelector("#articleWrap h1#kmd"), "k.md to render");
  });

  test("a Remember that returns after another turn was opened lands on its own turn, not the one on screen (fix round 1 batch 2)", async () => {
    askAndFinish("Saved later?");
    askAndFinish("Opened meanwhile?");
    const bar = () => doc().getElementById("wikiRememberBar")!;
    histItem("Saved later?").click();
    const release = hold("/api/wiki/remember?relPath=null");
    rememberPosts.length = 0;
    fetched.length = 0;
    doc().getElementById("wikiRememberBtn")!.click();
    await until(() => fetched.some((u) => u.includes("/api/wiki/remember")), "the remember POST to go out");
    // Before it returns, the reader opens another turn.
    histItem("Opened meanwhile?").click();
    const shown = bar().innerHTML;
    expect(shown).toContain("Remember this");
    release();
    await until(() => rememberPosts.length > 0, "the remember POST");
    await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 30));
    expect(rememberPosts.map((b) => b.question)).toEqual(["Saved later?"]);
    expect(bar().innerHTML).toBe(shown);
    expect(bar().textContent).not.toContain("Remembered");
    expect((doc().getElementById("wikiRememberBtn") as HTMLButtonElement).disabled).toBe(false);
    // The saved turn shows it once opened again.
    histItem("Saved later?").click();
    expect(bar().textContent).toBe("✓ Remembered: sum:Saved later?");
    expect(doc().getElementById("wikiRememberBtn")).toBe(null);
  });

  test("a page fetch the reader started makes the shown explainer's late payload stale: it paints nothing (fix round 2)", async () => {
    const releaseExplainer = hold("/api/wiki/page?relPath=e.md");
    doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="e.md"]')!.click();
    await until(() => !!doc().querySelector("#articleWrap iframe.wiki-explainer-frame"), "the explainer frame");
    const conn = doc().getElementById("connBody")!.innerHTML;
    expect(conn).toContain("Loading…");
    const releasePage = hold("/api/wiki/page?relPath=k.md");
    fetched.length = 0;
    doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="k.md"]')!.click();
    await until(() => fetched.some((u) => u.includes("relPath=k.md")), "the k.md fetch");
    try {
      releaseExplainer();
      await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 30));
      expect(doc().getElementById("connBody")!.innerHTML).toBe(conn);
    } finally {
      releasePage();
    }
    await until(() => !!doc().querySelector("#articleWrap h1#kmd"), "k.md to render");
  });

  test("a page load that fails still leaves the shown view: its teardown runs (fix round 2)", async () => {
    popTo("/wiki?wiki=w&relPath=p.md");
    await until(() => !!doc().querySelector("#articleWrap .wiki-article h1#pmd"), "p.md to render");
    const pill = () => doc().getElementById("wikiExplainBtn")!;
    pill().style.display = ""; // a selection on p.md showed the Explain pill
    failingPages.add("k.md");
    try {
      doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="k.md"]')!.click();
      await until(() => /Failed to load page: network down/.test(wrap().textContent ?? ""), "the failure to paint");
    } finally {
      failingPages.delete("k.md");
    }
    expect(pill().style.display).toBe("none");
  });

  test("Remember clicked between `done` and `answer_html` stays disabled while its POST runs (fix round 2)", async () => {
    const input = doc().getElementById("wikiAskInput") as HTMLTextAreaElement;
    input.value = "Remember mid-stream?";
    doc().getElementById("wikiAskBtn")!.click();
    const es = FakeEventSource.all.at(-1)!;
    es.emit("done", { answer: "Mid answer.", cited: [] });
    const btn = () => doc().getElementById("wikiRememberBtn") as HTMLButtonElement | null;
    expect(btn()!.disabled).toBe(false);
    const release = hold("/api/wiki/remember?relPath=null");
    fetched.length = 0;
    btn()!.click();
    await until(() => fetched.some((u) => u.includes("/api/wiki/remember")), "the remember POST to go out");
    expect([btn()!.textContent, btn()!.disabled]).toEqual(["Saving…", true]);
    try {
      es.emit("answer_html", { html: "<p>Mid answer.</p>", cited: [] });
      expect([btn()!.textContent, btn()!.disabled]).toEqual(["Saving…", true]);
    } finally {
      release();
    }
    await until(() => doc().getElementById("wikiRememberBar")!.textContent === "✓ Remembered: sum:Remember mid-stream?", "the saved bar");
  });

  test("the in-flight set alone refuses a second save, even with the button enabled (fix round 2)", async () => {
    askAndFinish("Twice?");
    const release = hold("/api/wiki/remember?relPath=null");
    fetched.length = 0;
    doc().getElementById("wikiRememberBtn")!.click();
    await until(() => fetched.some((u) => u.includes("/api/wiki/remember")), "the remember POST to go out");
    const btn = doc().getElementById("wikiRememberBtn") as HTMLButtonElement;
    btn.disabled = false; // whatever enabled it, the turn is still saving
    btn.click();
    await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 20));
    release();
    await until(() => doc().getElementById("wikiRememberBar")!.textContent === "✓ Remembered: sum:Twice?", "the saved bar");
    expect(fetched.filter((u) => u.includes("/api/wiki/remember")).length).toBe(1);
  });

  test("a failed Remember shows its error and gives the button back (fix round 2)", async () => {
    askAndFinish("Fails?");
    rememberError = "boom";
    try {
      doc().getElementById("wikiRememberBtn")!.click();
      await until(() => !!doc().getElementById("wikiRememberMsg")?.textContent, "the error");
    } finally {
      rememberError = null;
    }
    const btn = doc().getElementById("wikiRememberBtn") as HTMLButtonElement;
    expect([btn.textContent, btn.disabled]).toEqual(["Remember this", false]);
    const msg = doc().getElementById("wikiRememberMsg")!;
    expect([msg.textContent, msg.className]).toEqual(["Couldn't remember that — boom", "wiki-remember-msg error"]);
  });

  test("a saved Remember survives a reload: the rehydrated turn reads «✓ Remembered» (fix round 2)", async () => {
    const { getAskTurns, rehydrateAskSession } = await import("../components/wiki-ask-controller.ts");
    askAndFinish("Kept after reload?");
    doc().getElementById("wikiRememberBtn")!.click();
    await until(() => doc().getElementById("wikiRememberBar")!.textContent === "✓ Remembered: sum:Kept after reload?", "the saved bar");
    // A reload: the session comes back from localStorage alone (the boot's rehydrate).
    getAskTurns().length = 0;
    rehydrateAskSession();
    histItem("Kept after reload?").click();
    expect(doc().getElementById("wikiRememberBar")!.textContent).toBe("✓ Remembered: sum:Kept after reload?");
    expect(doc().getElementById("wikiRememberBtn")).toBe(null);
  });
});
