/**
 * The /wiki reader's Ask tab (`wiki-ask-controller.ts`, C4) driven through the
 * booted shell: a stored session rehydrates at boot, an Ask turn streamed over a
 * stubbed `EventSource` paints progressively into the article pane and clears
 * the shown page through `AskTurnPort.clearShownPage`, and the follow-up bar and
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
// A tracker on the listing: graph mode exists only there.
const LISTING = { pages: [page("p.md"), page("k.md")], scannedAt: Date.now(), trackers: [{ id: "jira", label: "Jira" }] };
/** The session a previous visit stored: one answered turn. */
const STORED = [{ question: "What did we decide?", answer: "We decided X.", citations: [], cited: [], html: "<p>We decided X.</p>", askedAt: Date.now() - 60_000 }];

const fetched: string[] = [];
async function stubFetch(input: unknown): Promise<unknown> {
  const raw = String(input);
  fetched.push(raw);
  const url = new URL(raw, "http://localhost:3011");
  let body: unknown = {};
  if (url.pathname === "/api/wiki/pages") body = LISTING;
  else if (url.pathname === "/api/wiki/page") {
    const rel = url.searchParams.get("relPath") ?? "p.md";
    body = { meta: LISTING.pages.find((p) => p.relPath === rel) ?? LISTING.pages[0], html: `<h1>${rel}</h1><p>Body.</p>`, outgoing: [], backlinks: [], hash: "h-" + rel };
  } else if (url.pathname === "/api/wiki/graph") body = { nodes: [], edges: [] };
  else if (url.pathname === "/api/wiki/factcheck/append") body = { written: true };
  const R = g.Response as typeof Response;
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
    // (clearShownPage): the rail's active test keys on the relPath and falls back
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
    // The answer cleared `graphIssue` (clearShownPage), and the in-place reload
    // does not re-read the URL: graph mode turned on here roots at the page.
    fetched.length = 0;
    doc().getElementById("wikiGraphToggle")!.click();
    await until(() => fetched.some((u) => u.includes("/api/wiki/graph")), "the graph fetch");
    expect(fetched.filter((u) => u.includes("/api/wiki/graph")).map((u) => new URL(u, "http://x").searchParams.get("scope") + ":" + new URL(u, "http://x").searchParams.get("root")).join(" ")).toBe("page:k.md");
  });
});
