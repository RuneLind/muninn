/**
 * The /wiki reader's C5 controllers driven through the booted shell: the
 * article tools and the right pane (`wiki-article-controller.ts`) and the
 * series editor (`wiki-series-controller.ts`). The shell is imported and booted
 * once in a happy-dom window over the server-rendered /wiki page, opened on a
 * page with neighbours, Related work rows, an issue row and a series, so every
 * port member these tests lean on is read through the real `articleDeps()` and
 * `seriesDeps()`.
 *
 * Isolation (load-bearing, pinned by `src/test/mock-isolation.test.ts`): this
 * file installs happy-dom's globals over Bun's own for the life of the process,
 * so it runs in a `bun test` link of its own in every chain, like
 * `wiki-shell-boot.test.ts` beside it. That file owns the import-effect window
 * and the listener-order pin; this one only drives behaviour.
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
  for (const k of ["__WIKI_NAME__", "__WIKI_ROOT__", "__WIKI_FIND_SELF__", "__WIKI_FIND_ROWS__"]) delete g[k];
}

// ── The fixture: a.md (open) and b.md form the series `trip`; c.md links to a.md ──
const NOW = Date.now();
const DAY = 86_400_000;
const page = (relPath: string, title: string, extra: Record<string, unknown> = {}) => ({
  relPath,
  name: relPath.replace(/\.md$/, ""),
  title,
  type: "concept",
  domain: "ai",
  tags: [],
  aliases: [],
  linkCount: 1,
  backlinkCount: 1,
  updated: new Date(NOW - DAY).toISOString().slice(0, 10),
  ...extra,
});
/** What the listing and the page route serve now; the series write changes them. */
const pages: Record<string, ReturnType<typeof page>> = {
  "a.md": page("a.md", "Alpha", { series: "trip" }),
  "b.md": page("b.md", "Beta", { series: "trip" }),
  "c.md": page("c.md", "Gamma"),
};
/** Each page's raw-bytes hash; a series write moves the written page's. */
const hashes: Record<string, string> = { "a.md": "h-a", "b.md": "h-b", "c.md": "h-c" };
const listing = () => ({
  pages: Object.values(pages),
  scannedAt: NOW,
  jira: { "DEMO-1": 1 },
  trackers: [{ id: "jira", label: "Jira" }],
  // The wiki's own type label, so the Connections heading proves `typeLabel()`.
  types: { order: ["concept"], labels: { concept: "Ideas" } },
});
const ISSUE = { tracker: "jira", key: "DEMO-1", url: "", field: "jira", relations: ["mention"], pageCount: 1, planPages: [] };

const fetched: { method: string; url: string; body?: string }[] = [];

async function stubFetch(input: unknown, init?: { method?: string; body?: string }): Promise<unknown> {
  const raw = String(input);
  const method = init?.method ?? "GET";
  fetched.push({ method, url: raw, body: init?.body });
  const url = new URL(raw, "http://localhost:3011");
  let body: unknown = {};
  if (url.pathname === "/api/wiki/pages") body = listing();
  else if (url.pathname === "/api/wiki/page") {
    const rel = url.searchParams.get("relPath") ?? "a.md";
    const meta = pages[rel] ?? pages["a.md"]!;
    body = {
      meta,
      html: `<h1>${meta.title}</h1><p>Body.</p>`,
      outgoing: rel === "a.md" ? [pages["b.md"]] : [],
      backlinks: rel === "a.md" ? [pages["c.md"]] : [],
      related: rel === "a.md" ? [{ ...pages["b.md"]!, why: "links to", strength: 2 }, { ...pages["c.md"]!, why: "linked from", strength: 1 }] : [],
      issueRows: rel === "a.md" ? [ISSUE] : undefined,
      issueStampable: true,
      hash: hashes[rel],
    };
  } else if (url.pathname === "/api/wiki/series" && method === "POST") {
    const write = JSON.parse(init!.body!) as { relPath: string; series: string | null };
    const p = pages[write.relPath]!;
    if (write.series === null) delete (p as { series?: string }).series;
    else (p as { series?: string }).series = write.series;
    hashes[write.relPath] = hashes[write.relPath] + "+";
    body = { hash: hashes[write.relPath], written: true };
  }
  const R = g.Response as typeof Response;
  return new R(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => (g.setTimeout as typeof setTimeout)(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let win: GlobalWindow;
let handle: { dispose(): void };
let orderKey: string;
const doc = () => g.document as Document;
const connBody = () => doc().getElementById("connBody")!;
const seriesMenu = () => doc().getElementById("wikiSeriesMenu");
const key = (k: string) => {
  const KE = g.KeyboardEvent as typeof KeyboardEvent;
  (doc().activeElement ?? doc().body).dispatchEvent(new KE("keydown", { key: k, bubbles: true, cancelable: true }));
};

beforeAll(async () => {
  const { renderWikiPage } = await import("../wiki-page.ts");
  const html = (await renderWikiPage({ wikis: ["w"], selected: "w", wikiRoot: "/tmp/w" })).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  win = new GlobalWindow({
    url: "http://localhost:3011/wiki?wiki=w&relPath=a.md",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableMainFrameNavigation: true } },
  });
  win.document.write(html);
  installWindow(win);
  Object.assign(g, { __WIKI_NAME__: "w", __WIKI_ROOT__: "/tmp/w", __WIKI_FIND_SELF__: "w", __WIKI_FIND_ROWS__: "w" });
  g.fetch = stubFetch;
  // The order this reader picked on an earlier visit: `initArticle` reads it in boot().
  orderKey = (await import("../components/wiki-recents.ts")).relatedOrderKey("w");
  (g.localStorage as Storage).setItem(orderKey, "newest");
  const { boot } = await import("../components/wiki-browser.ts");
  handle = boot();
  await until(() => !!doc().querySelector("#articleWrap h1") && !!connBody().querySelector(".wiki-related"), "the article and its Connections");
}, 30_000);

afterAll(async () => {
  handle?.dispose();
  await win?.happyDOM.abort();
  win?.close();
  restoreGlobals();
});

describe("the right pane (wiki-article-controller.ts)", () => {
  test("opening a page paints Connections and its issue row through the port", () => {
    const titles = Array.from(connBody().querySelectorAll(".wiki-conn-title")).map((t) => t.textContent ?? "");
    expect(titles.some((t) => t.startsWith("Linked from (1)"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Links to (1)"))).toBe(true);
    // The tracker's label comes from the listing, read through `trackerLabels()`.
    expect(connBody().querySelector("#wikiConnIssues .wiki-conn-title")!.textContent).toBe("Jira (0)");
    expect(!!connBody().querySelector('[data-issue-row="DEMO-1"]')).toBe(true);
    expect(connBody().querySelector(".wiki-rel-count")!.textContent).toBe("Related work (2)");
    // The type heading is the wiki's label, read through `typeLabel()`.
    expect(connBody().querySelector(".wiki-conn-group")!.textContent).toBe("Ideas");
  });

  test("the rail tabs switch between Connections and Ask", () => {
    const tab = (t: string) => doc().querySelector<HTMLElement>(`.wiki-conn-tab[data-conntab="${t}"]`)!;
    tab("ask").click();
    expect(connBody().style.display).toBe("none");
    expect(doc().getElementById("askBody")!.style.display).toBe("flex");
    expect(tab("ask").classList.contains("active")).toBe(true);
    tab("conn").click();
    expect(connBody().style.display).toBe("");
    expect(doc().getElementById("askBody")!.style.display).toBe("none");
    expect(tab("conn").classList.contains("active")).toBe(true);
  });

  test("Related work opens in the order boot read, and a pick is stored and repainted", () => {
    const btn = (o: string) => connBody().querySelector<HTMLElement>(`[data-rel-order="${o}"]`)!;
    expect(btn("newest").getAttribute("aria-pressed")).toBe("true");
    btn("strongest").click();
    expect((g.localStorage as Storage).getItem(orderKey)).toBe("strongest");
    expect(btn("strongest").getAttribute("aria-pressed")).toBe("true");
    expect(btn("newest").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the series editor (wiki-series-controller.ts)", () => {
  const editBtn = () => doc().querySelector<HTMLElement>('#articleWrap [data-series-edit="a.md"]');

  test("Escape closes the menu the header's edit series opened", () => {
    expect(!!editBtn()).toBe(true);
    editBtn()!.click();
    expect(!!seriesMenu()).toBe(true);
    key("Escape");
    expect(seriesMenu() === null).toBe(true);
  });

  test("Remove from series writes through the poster boot built, then repaints the head from the refetched listing", async () => {
    editBtn()!.click();
    const remove = seriesMenu()!.querySelector<HTMLElement>('[data-series-cmd="remove"]')!;
    expect(!!remove).toBe(true);
    const listingsBefore = fetched.filter((f) => f.url.startsWith("/api/wiki/pages")).length;
    remove.click();
    await until(() => seriesMenu() === null, "the menu to close after the write");
    const post = fetched.find((f) => f.method === "POST" && f.url === "/api/wiki/series")!;
    // `initSeries` built the poster for this wiki; the base is the open page's load-time hash.
    expect(JSON.parse(post.body!)).toEqual({ wiki: "w", relPath: "a.md", series: null, baseHash: "h-a" });
    expect(fetched.filter((f) => f.url.startsWith("/api/wiki/pages?refresh=1")).length).toBeGreaterThan(0);
    expect(fetched.filter((f) => f.url.startsWith("/api/wiki/pages")).length).toBeGreaterThan(listingsBefore);
    // The page left the series: `repaintSeriesHead` dropped the strip and its opener.
    expect(doc().querySelector("#articleWrap .wiki-series-head") === null).toBe(true);
    expect(editBtn() === null).toBe(true);
  });
});

describe("the outgoing titles (clearOutgoingTitles)", () => {
  test("the open page's titles are held, and leaving for the start view clears them", async () => {
    const { getCurrentOutgoingTitles } = await import("../components/wiki-article-controller.ts");
    expect(getCurrentOutgoingTitles()).toEqual(["Beta"]);
    // The wiki crumb goes back to the overview, which hides the breadcrumb.
    doc().querySelector<HTMLElement>("#wikiBreadcrumb a")!.click();
    await until(() => doc().querySelector("#articleWrap h1")?.textContent !== "Alpha", "the start view");
    expect(getCurrentOutgoingTitles()).toEqual([]);
  });
});
