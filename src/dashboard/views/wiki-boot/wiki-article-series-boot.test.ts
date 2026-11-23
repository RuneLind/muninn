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
  // An explainer: its breadcrumb renders from the listing BEFORE its page
  // fetch, the window the outgoing-titles case below needs.
  "d.html": page("d.html", "Delta", { name: "d", type: "explainer" }),
  // A markdown page the wiki types `explainer`: it opens through `loadExplainer`
  // yet takes series writes (`canEditSeriesPage` tests the extension).
  "e.md": page("e.md", "Epsilon", { type: "explainer", series: "solo" }),
};
/** Each page's raw-bytes hash; a series write moves the written page's. */
const hashes: Record<string, string> = { "a.md": "h-a", "b.md": "h-b", "c.md": "h-c", "d.html": "h-d", "e.md": "h-e" };
/** Set while a case expects no series write at all: a write sent anyway is
 *  answered 409 and changes nothing, so that case's failure stays its own. */
let refuseSeriesWrites = false;
/** A page whose first `/api/wiki/page` answer waits until the test releases
 *  it; later reads of it (a series base read) answer at once. */
let heldPage: { rel: string; gate: Promise<void>; release: () => void; taken?: boolean } | null = null;
function holdPage(rel: string): void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  heldPage = { rel, gate, release };
}
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
    // Read before any hold, as the server reads the file before it answers.
    const hashAtRead = hashes[rel];
    if (heldPage?.rel === rel && !heldPage.taken) {
      heldPage.taken = true;
      await heldPage.gate;
    }
    const meta = pages[rel] ?? pages["a.md"]!;
    body = {
      meta,
      html: `<h1>${meta.title}</h1><p>Body.</p>`,
      outgoing: rel === "a.md" ? [pages["b.md"]] : [],
      backlinks: rel === "a.md" ? [pages["c.md"]] : [],
      related: rel === "a.md" ? [{ ...pages["b.md"]!, why: "links to", strength: 2 }, { ...pages["c.md"]!, why: "linked from", strength: 1 }] : [],
      issueRows: rel === "a.md" ? [ISSUE] : undefined,
      issueStampable: true,
      hash: hashAtRead,
    };
  } else if (url.pathname === "/api/wiki/series" && method === "POST" && refuseSeriesWrites) {
    const R = g.Response as typeof Response;
    return new R(JSON.stringify({ error: "refused by the test" }), { status: 409, headers: { "content-type": "application/json" } });
  } else if (url.pathname === "/api/wiki/series" && method === "POST") {
    const write = JSON.parse(init!.body!) as { relPath: string; series: string | null; seriesLabel?: string | null };
    const p = pages[write.relPath]! as { series?: string; seriesLabel?: string };
    if (write.series === null) delete p.series;
    else p.series = write.series;
    if (write.seriesLabel) p.seriesLabel = write.seriesLabel;
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

  const seriesPosts = () => fetched.filter((f) => f.method === "POST" && f.url === "/api/wiki/series");
  const menuNote = () => seriesMenu()?.querySelector(".wiki-series-menu-msg")?.textContent ?? "";

  test("the open page changed on disk after it loaded: Remove is refused at the click and nothing is written", async () => {
    // Preconditions: no write yet, and the page still answers its load-time hash.
    expect(seriesPosts().length).toBe(0);
    expect(hashes["a.md"]).toBe("h-a");
    // Somebody else edits a.md: the menu's fresh base read now differs from the
    // hash `openPageAtLoad()` reports for the page as loaded.
    hashes["a.md"] = "h-a-edited";
    refuseSeriesWrites = true;
    try {
      editBtn()!.click();
      seriesMenu()!.querySelector<HTMLElement>('[data-series-cmd="remove"]')!.click();
      await until(() => menuNote().includes("changed since you opened it"), "the refusal note");
      expect(menuNote()).toBe("a.md changed since you opened it — reload it; nothing written");
      expect(seriesPosts().length).toBe(0);
      key("Escape");
      expect(seriesMenu() === null).toBe(true);
    } finally {
      // On failure too: the cases below need a.md unedited and the menu closed.
      hashes["a.md"] = "h-a";
      refuseSeriesWrites = false;
      if (seriesMenu()) key("Escape");
    }
  });

  test("Rename writes through the poster boot built, with the open page's base unchanged since load", async () => {
    // Counted from here, so a write the case above let through is not this one's.
    const before = seriesPosts().length;
    editBtn()!.click();
    const form = seriesMenu()!.querySelector<HTMLFormElement>('[data-series-form="label"]')!;
    form.querySelector<HTMLInputElement>("[data-series-input]")!.value = "Trip";
    const SE = g.SubmitEvent as typeof SubmitEvent;
    form.dispatchEvent(new SE("submit", { bubbles: true, cancelable: true }));
    await until(() => seriesPosts().length === before + 1 && seriesMenu() === null, "the rename to write and close the menu");
    // `initSeries` built the poster for this wiki; the fresh base equals the load-time hash.
    expect(JSON.parse(seriesPosts()[before]!.body!)).toEqual({ wiki: "w", relPath: "a.md", series: "trip", seriesLabel: "Trip", baseHash: "h-a" });
  });

  test("a second write from the same page goes through: its own first write's answer became the load-time hash", async () => {
    // The rename moved a.md to "h-a+" on disk. Only `adoptOwnSeriesHashes` makes
    // the open page's load-time hash follow, or this verb is refused like the first.
    expect(hashes["a.md"]).toBe("h-a+");
    const before = seriesPosts().length;
    editBtn()!.click();
    const remove = seriesMenu()!.querySelector<HTMLElement>('[data-series-cmd="remove"]')!;
    expect(!!remove).toBe(true);
    const listingsBefore = fetched.filter((f) => f.url.startsWith("/api/wiki/pages")).length;
    remove.click();
    await until(() => seriesPosts().length === before + 1 || menuNote().includes("changed since"), "the remove to answer");
    expect(menuNote()).toBe("");
    await until(() => seriesMenu() === null, "the menu to close after the write");
    expect(JSON.parse(seriesPosts()[before]!.body!)).toEqual({ wiki: "w", relPath: "a.md", series: null, baseHash: "h-a+" });
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

  test("opening a page clears the previous page's titles at breadcrumb render, before its own connections land", async () => {
    const { getCurrentOutgoingTitles } = await import("../components/wiki-article-controller.ts");
    // Back on a.md (its titles are ["Beta"] again), from the start view the case above left.
    doc().querySelector<HTMLElement>('#wikiList [data-relpath="a.md"]')!.click();
    await until(() => getCurrentOutgoingTitles().join() === "Beta", "a.md's connections");
    // An explainer renders its breadcrumb from the listing and only then fetches
    // its page, held here: nothing but `renderBreadcrumb` can clear the titles.
    holdPage("d.html");
    doc().querySelector<HTMLElement>('#wikiList [data-relpath="d.html"]')!.click();
    await until(() => (doc().getElementById("wikiBreadcrumb")?.textContent ?? "").includes("Delta"), "d.html's breadcrumb");
    expect(fetched.some((f) => f.url.includes("/api/wiki/page?relPath=d.html"))).toBe(true);
    expect(connBody().textContent).toBe("Loading…");
    expect(getCurrentOutgoingTitles()).toEqual([]);
    heldPage!.release();
    heldPage = null;
    await until(() => connBody().textContent !== "Loading…", "d.html's connections");
    expect(getCurrentOutgoingTitles()).toEqual([]);
  });
});

describe("an explainer-typed markdown page (loadExplainer)", () => {
  const seriesPosts = () => fetched.filter((f) => f.method === "POST" && f.url === "/api/wiki/series");
  const menuNote = () => seriesMenu()?.querySelector(".wiki-series-menu-msg")?.textContent ?? "";
  const edit = () => doc().querySelector<HTMLElement>('#articleWrap [data-series-edit="e.md"]');
  /** A markdown page first: its load leaves its hash as the open page's. */
  async function openAlpha(): Promise<void> {
    doc().querySelector<HTMLElement>('#wikiList [data-relpath="a.md"]')!.click();
    await until(() => doc().querySelector("#articleWrap h1")?.textContent === "Alpha", "a.md");
    await until(() => !!connBody().querySelector(".wiki-related"), "a.md's connections");
  }

  test("its payload's hash becomes the load-time hash: an edit on disk after it loaded is refused", async () => {
    await openAlpha();
    doc().querySelector<HTMLElement>('#wikiList [data-relpath="e.md"]')!.click();
    await until(() => !!edit(), "e.md's series head");
    await until(() => fetched.some((f) => f.url.includes("/api/wiki/page?relPath=e.md")) && connBody().textContent !== "Loading…", "e.md's page payload");
    const before = seriesPosts().length;
    hashes["e.md"] = "h-e-edited";
    refuseSeriesWrites = true;
    try {
      edit()!.click();
      seriesMenu()!.querySelector<HTMLElement>('[data-series-cmd="remove"]')!.click();
      await until(() => seriesPosts().length > before || menuNote().includes("changed since"), "the refusal");
      expect(menuNote()).toBe("e.md changed since you opened it — reload it; nothing written");
      expect(seriesPosts().length).toBe(before);
    } finally {
      hashes["e.md"] = "h-e";
      refuseSeriesWrites = false;
      if (seriesMenu()) key("Escape");
    }
  });

  test("before its payload lands, the previous page's hash does not stand for it, and the late payload does not undo the reader's own write", async () => {
    await openAlpha();
    // The series head renders from the listing; the page payload is held, so
    // only the clear at the switch keeps a.md's hash from being compared.
    holdPage("e.md");
    const SE = g.SubmitEvent as typeof SubmitEvent;
    try {
      doc().querySelector<HTMLElement>('#wikiList [data-relpath="e.md"]')!.click();
      await until(() => !!edit(), "e.md's series head");
      expect(connBody().textContent).toBe("Loading…");
      const before = seriesPosts().length;
      edit()!.click();
      const form = seriesMenu()!.querySelector<HTMLFormElement>('[data-series-form="label"]')!;
      form.querySelector<HTMLInputElement>("[data-series-input]")!.value = "Solo";
      form.dispatchEvent(new SE("submit", { bubbles: true, cancelable: true }));
      await until(() => seriesPosts().length === before + 1 || menuNote().includes("changed since"), "the rename to answer");
      expect(menuNote()).toBe("");
      expect(JSON.parse(seriesPosts()[before]!.body!)).toEqual({ wiki: "w", relPath: "e.md", series: "solo", seriesLabel: "Solo", baseHash: "h-e" });
      await until(() => seriesMenu() === null, "the menu to close after the write");
      // The held payload carries the hash read BEFORE that write; it lands now
      // and must not replace the one the write answered.
      heldPage!.release();
      await until(() => connBody().textContent !== "Loading…", "e.md's late payload");
      edit()!.click();
      seriesMenu()!.querySelector<HTMLElement>('[data-series-cmd="remove"]')!.click();
      await until(() => seriesPosts().length === before + 2 || menuNote().includes("changed since"), "the remove to answer");
      expect(menuNote()).toBe("");
      expect(JSON.parse(seriesPosts()[before + 1]!.body!)).toEqual({ wiki: "w", relPath: "e.md", series: null, baseHash: "h-e+" });
    } finally {
      heldPage?.release();
      heldPage = null;
      if (seriesMenu()) key("Escape");
      // The fixture as the file starts it, for a case added after this one;
      // reset before the wait, so a wait that times out cannot skip it.
      Object.assign(pages["e.md"]!, { series: "solo" });
      delete (pages["e.md"] as { seriesLabel?: string }).seriesLabel;
      hashes["e.md"] = "h-e";
      await until(() => connBody().textContent !== "Loading…", "e.md's payload to settle");
    }
  });
});
