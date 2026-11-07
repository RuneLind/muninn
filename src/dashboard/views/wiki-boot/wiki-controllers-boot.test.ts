/**
 * The /wiki reader's C3 controllers driven through the booted shell: the stale
 * check (`wiki-stale-controller.ts`), the effort page
 * (`wiki-effort-controller.ts`) and the ⋯ menus (`wiki-menus-controller.ts`).
 * The shell is imported and booted once in a happy-dom window over the
 * server-rendered /wiki page, with a listing that carries work threads, so the
 * rail draws the Work threads section the menus act on.
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

// ── The fixture: thread T over k, p, q (the boundaries test's shape); U ──
// alone; V and W joined by a `related:` pair, so the rail draws one group
// card, whose ⋯ offers Save as series.
const NOW = Date.now();
const H = 3_600_000;
const page = (relPath: string, focusMs: number) => ({
  relPath,
  name: relPath.replace(/\.md$/, ""),
  title: relPath.replace(/\.md$/, "").toUpperCase(),
  type: "plan",
  domain: "ai",
  tags: [],
  aliases: [],
  linkCount: 0,
  backlinkCount: 0,
  work: { sinceMs: NOW - 8 * 24 * H, state: "F", focusMs, events: [[focusMs, 3, "focus"]] },
});
const sess = (id: string, last: number) => ({ id, provider: "claude", first: last - H, last, title: `title ${id}` });
const row = (id: string, p: string, thread: string, first: number, kind = "focus") => [`claude-code:${id}`, p, thread, kind, 2, first, first + H];
const T = { key: "k.md", pages: ["p.md", "k.md", "q.md"], touched: ["ctx.md"], sessions: [sess("s2", NOW - H), sess("s1", NOW - 3 * H), sess("s3", NOW - 5 * H)] };
const U = { key: "u.md", pages: ["u.md"], touched: [], sessions: [sess("s4", NOW - 2 * H)] };
const V = { key: "v.md", pages: ["v.md"], touched: [], sessions: [sess("s5", NOW - 6 * H)] };
const W = { key: "w.md", pages: ["w.md"], touched: [], sessions: [sess("s6", NOW - 7 * H)] };
const ROWS = [
  row("s1", "k.md", "k.md", NOW - 9 * H),
  row("s1", "p.md", "k.md", NOW - 4 * H),
  row("s2", "p.md", "k.md", NOW - 2 * H),
  row("s2", "ctx.md", "k.md", NOW - 2 * H, "touch"),
  row("s3", "q.md", "k.md", NOW - 6 * H),
  row("s4", "u.md", "u.md", NOW - 3 * H),
  row("s5", "v.md", "v.md", NOW - 7 * H),
  row("s6", "w.md", "w.md", NOW - 8 * H),
];
const LISTING = {
  pages: [page("k.md", NOW - 8 * H), page("p.md", NOW - H), page("q.md", NOW - 5 * H), page("u.md", NOW - 2 * H), page("ctx.md", NOW - 2 * H), page("v.md", NOW - 6 * H), page("w.md", NOW - 7 * H)],
  scannedAt: NOW,
  workedCoverage: { matched: 7, total: 7 },
  work: {
    asOfMs: NOW,
    sinceMs: NOW - 8 * 24 * H,
    threads: [T, U, V, W],
    evidence: {
      version: 1,
      threads: { candidates: 4, shipped: 4 },
      relations: { complete: true, reasons: [], series: {}, projects: {}, related: [["w.md", "v.md"]], issues: [], ambiguousIssues: [], relatedSkipped: { skipped: 0, ambiguous: 0 } },
      contributions: { complete: true, reasons: [], cut: [], rows: ROWS },
    },
  },
};
/** The open page's stale report: two linking pages to check, no stale line. */
const STALE_REPORT = {
  page: { relPath: "p.md", title: "P" },
  hits: [],
  staleLines: 0,
  buckets: {
    counts: { toCheck: 2 },
    linking: [
      { relPath: "k.md", title: "K", bucket: "toCheck", passages: [{ line: 3, text: "P is still being built" }] },
      { relPath: "q.md", title: "Q", bucket: "toCheck", passages: [{ line: 5, text: "see P, in progress" }] },
    ],
  },
};
/** The wiki-wide summary: q.md has one stale line and three pages to check. */
const STALE_SUMMARY = { pages: [{ relPath: "q.md", title: "Q", staleLines: 1, toCheck: 3 }], totals: { staleLines: 1, toCheck: 3 } };

const fetched: { method: string; url: string }[] = [];
/** What `/api/wiki/work-map` answers; the effort tests set it. */
let workMapStatus = 200;

async function stubFetch(input: unknown, init?: { method?: string }): Promise<unknown> {
  const raw = String(input);
  fetched.push({ method: init?.method ?? "GET", url: raw });
  const url = new URL(raw, "http://localhost:3011");
  let body: unknown = {};
  let status = 200;
  if (url.pathname === "/api/wiki/pages") body = LISTING;
  else if (url.pathname === "/api/wiki/page") {
    const rel = url.searchParams.get("relPath") ?? "p.md";
    body = { meta: LISTING.pages.find((p) => p.relPath === rel) ?? LISTING.pages[1], html: `<h1>${rel}</h1><p>Body.</p>`, outgoing: [], backlinks: [], hash: "h-" + rel };
  } else if (url.pathname === "/api/wiki/stale") body = url.searchParams.get("page") ? STALE_REPORT : STALE_SUMMARY;
  else if (url.pathname === "/api/wiki/work-map") {
    status = workMapStatus;
    body = status === 200 ? { map: null } : { error: "boom" };
  }
  const R = g.Response as typeof Response;
  return new R(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
const doc = () => g.document as Document;

beforeAll(async () => {
  const { renderWikiPage } = await import("../wiki-page.ts");
  const html = (await renderWikiPage({ wikis: ["w"], selected: "w", wikiRoot: "/tmp/w" })).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  win = new GlobalWindow({
    url: "http://localhost:3011/wiki?wiki=w&relPath=p.md",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableMainFrameNavigation: true } },
  });
  win.document.write(html);
  installWindow(win);
  Object.assign(g, { __WIKI_NAME__: "w", __WIKI_ROOT__: "/tmp/w", __WIKI_FIND_SELF__: "w", __WIKI_FIND_ROWS__: "w" });
  g.fetch = stubFetch;
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

describe("the stale check (wiki-stale-controller.ts)", () => {
  test("the open page's report fills the STALE tab and its count", async () => {
    expect(fetched.map((f) => f.url)).toContain("/api/wiki/stale?page=p.md&wiki=w");
    await until(() => doc().getElementById("wikiStaleCount")?.textContent === "0 · 2", "the STALE tab's count");
    const body = doc().getElementById("staleBody")!;
    expect(body.querySelector("[data-stale-content]")!.textContent).toContain("K");
    expect(doc().getElementById("wikiStaleCount")!.parentElement!.getAttribute("title")).toContain("2 linking pages to check");
  });

  test("the wiki-wide summary puts its counts on the rail row", async () => {
    expect(fetched.map((f) => f.url)).toContain("/api/wiki/stale?wiki=w");
    await until(() => !!doc().querySelector('#wikiList [data-stale-rail="1·3"]'), "the rail badge for q.md");
    const badge = doc().querySelector('#wikiList [data-stale-rail="1·3"]')!;
    expect(badge.textContent).toBe("⚠ 1 · 3");
    expect(badge.closest("[data-relpath]")!.getAttribute("data-relpath")).toBe("q.md");
  });

  test("a section the reader folds stays folded when the tab repaints the same page (the #staleBody toggle listener)", async () => {
    const { loadStale } = await import("../components/wiki-stale-controller.ts");
    const det = () => doc().querySelector<HTMLDetailsElement>('#staleBody details[data-stale-open="bucket:toCheck"]');
    expect(det()!.open).toBe(true);
    let toggled = false;
    det()!.addEventListener("toggle", () => (toggled = true));
    // Marked, so the repainted section is told apart from this one.
    det()!.setAttribute("data-old-body", "1");
    det()!.open = false;
    await until(() => toggled, "the toggle event");
    loadStale("p.md");
    await until(() => !!det() && !det()!.hasAttribute("data-old-body"), "the tab to repaint");
    expect(det()!.open).toBe(false);
  });
});

describe("the effort page (wiki-effort-controller.ts)", () => {
  const clickEffortLink = (id: string) => {
    const a = doc().createElement("a");
    a.setAttribute("data-effort-link", id);
    a.href = "#";
    doc().body.appendChild(a);
    a.click();
    a.remove();
  };

  test("an effort link opens the effort page in the article pane and pushes its URL", () => {
    clickEffortLink("drift");
    expect(new URLSearchParams((g.location as Location).search).get("effort")).toBe("drift");
    const pane = doc().getElementById("wikiEffortPage");
    expect(!!pane).toBe(true);
    // No work map on this listing: the page says so.
    expect(doc().getElementById("articleWrap")!.textContent).toContain("work map");
    expect(doc().querySelector("#articleWrap h1")?.textContent ?? "").not.toBe("p.md");
  });

  test("a failed map GET shows Retry, and Retry fetches the open effort again", async () => {
    const { setWorkMapRunAt } = await import("../components/wiki-shell-state.ts");
    setWorkMapRunAt(NOW);
    workMapStatus = 500;
    clickEffortLink("drift");
    await until(() => !!doc().getElementById("wikiEffortRetry"), "the effort page's error pane");
    const before = fetched.filter((f) => f.url.startsWith("/api/wiki/work-map")).length;
    // Marked, so the pane Retry paints is told apart from the one it replaces.
    doc().getElementById("wikiEffortRetry")!.setAttribute("data-old-pane", "1");
    doc().getElementById("wikiEffortRetry")!.click();
    expect(fetched.filter((f) => f.url.startsWith("/api/wiki/work-map")).length).toBeGreaterThan(before);
    // Retry repaints: the loading state replaces the old pane at once, then the
    // failed GET paints a new error pane.
    expect(doc().getElementById("wikiEffortRetry") === null).toBe(true);
    await until(() => !!doc().getElementById("wikiEffortRetry"), "the error pane again");
    expect(doc().getElementById("wikiEffortRetry")!.hasAttribute("data-old-pane")).toBe(false);
    setWorkMapRunAt(null);
    workMapStatus = 200;
  });
});

describe("the ⋯ menus (wiki-menus-controller.ts)", () => {
  const opener = () => doc().querySelector<HTMLElement>('#wikiList [data-work-card-menu="thread:k.md"]')!;
  const pop = () => doc().getElementById("wikiWorkPop");
  const key = (k: string) => {
    const KE = g.KeyboardEvent as typeof KeyboardEvent;
    (doc().activeElement ?? doc().body).dispatchEvent(new KE("keydown", { key: k, bubbles: true, cancelable: true }));
  };

  test("a card's ⋯ opens the work popover on its first item; Escape closes it back to the opener", () => {
    expect(!!opener()).toBe(true);
    opener().click();
    expect(!!pop()).toBe(true);
    expect(pop()!.getAttribute("role")).toBe("menu");
    expect(opener().getAttribute("aria-expanded")).toBe("true");
    expect(pop()!.contains(doc().activeElement)).toBe(true);
    key("Escape");
    expect(pop() === null).toBe(true);
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    // Booleans, not nodes: a failing `toBe(node)` diffs two happy-dom trees and runs Bun out of memory.
    expect(doc().activeElement === opener()).toBe(true);
  });

  test("its opener pressed again closes it; a click elsewhere closes it and leaves focus where the click put it", () => {
    opener().click();
    expect(!!pop()).toBe(true);
    opener().click();
    expect(pop() === null).toBe(true);
    opener().click();
    expect(!!pop()).toBe(true);
    const elsewhere = doc().getElementById("wikiSearch") as HTMLInputElement;
    elsewhere.focus();
    elsewhere.click();
    expect(pop() === null).toBe(true);
    expect(doc().activeElement === elsewhere).toBe(true);
  });

  test("a thread row's page menu offers Make own thread; it splits the page into its own card, whose ⋯ returns it", () => {
    doc().querySelector<HTMLElement>('#wikiList .thread-row [data-series-menu="q.md"]')!.click();
    const menu = doc().getElementById("wikiSeriesMenu")!;
    expect(!!menu).toBe(true);
    const split = menu.querySelector<HTMLElement>('[data-thread-split="q.md"]')!;
    expect(split.textContent).toContain("Make own thread");
    split.click();
    expect(doc().getElementById("wikiSeriesMenu") === null).toBe(true);
    const card = doc().querySelector<HTMLElement>('#wikiList .wiki-thread-card[data-thread="thread:q.md"]')!;
    expect(!!card).toBe(true);
    // Focus lands on the split card's fold (`applyBoundaryEdit`'s per-edit table).
    expect(doc().activeElement === card.querySelector(".wiki-thread-fold")).toBe(true);
    card.querySelector<HTMLElement>("[data-work-card-menu]")!.click();
    const ret = pop()!.querySelector<HTMLElement>("[data-work-return]")!;
    expect(ret.textContent).toContain("Return to its thread");
    ret.click();
    expect(pop() === null).toBe(true);
    expect(doc().querySelector('#wikiList .wiki-thread-card[data-thread="thread:q.md"]') === null).toBe(true);
  });

  test("ArrowDown in a thread row's page menu moves focus to the next item", () => {
    doc().querySelector<HTMLElement>('#wikiList .thread-row [data-series-menu="q.md"]')!.click();
    const menu = doc().getElementById("wikiSeriesMenu")!;
    expect(doc().activeElement === menu.querySelector('[data-thread-split="q.md"]')).toBe(true);
    key("ArrowDown");
    expect(doc().activeElement === menu.querySelector("[data-series-input]")).toBe(true);
    key("Escape");
    expect(doc().getElementById("wikiSeriesMenu") === null).toBe(true);
  });

  test("Tab in the work popover closes it back to its opener", () => {
    opener().click();
    expect(pop()!.contains(doc().activeElement)).toBe(true);
    key("Tab");
    expect(pop() === null).toBe(true);
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(doc().activeElement === opener()).toBe(true);
  });

  test("a window resize closes the work popover", () => {
    opener().click();
    expect(!!pop()).toBe(true);
    (g.window as Window).dispatchEvent(new (g.Event as typeof Event)("resize"));
    expect(pop() === null).toBe(true);
    expect(opener().getAttribute("aria-expanded")).toBe("false");
  });

  test("a group card's ⋯ offers Save as series, and its item turns the popover into the confirm dialog on the key", () => {
    doc().querySelector<HTMLElement>('#wikiList [data-work-card-menu="group:anchor:v.md"]')!.click();
    pop()!.querySelector<HTMLElement>('[data-work-save-series="group:anchor:v.md"]')!.click();
    const el = pop()!;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("false");
    expect(el.getAttribute("aria-label")).toContain("as a series");
    const keyBox = el.querySelector("[data-work-series-key]");
    expect(!!keyBox).toBe(true);
    expect(doc().activeElement === keyBox).toBe(true);
    el.querySelector<HTMLElement>("[data-work-series-cancel]")!.click();
    expect(pop() === null).toBe(true);
  });
});

describe("the rail toolbar (registerRailOptions, moved into wiki-rail-controller.ts)", () => {
  test("the sort select stores the reader's choice and outranks the default from then on", async () => {
    const { readSort } = await import("../components/wiki-recents-store.ts");
    const { getSortTouched } = await import("../components/wiki-rail-controller.ts");
    const sel = doc().getElementById("wikiSort") as HTMLSelectElement;
    expect(getSortTouched()).toBe(false);
    sel.value = "title";
    sel.dispatchEvent(new (g.Event as typeof Event)("change", { bubbles: true }));
    expect(readSort("w")).toBe("title");
    expect(getSortTouched()).toBe(true);
  });

  test("group families: the box turns it on with a chip, and the chip's × turns it off", () => {
    const box = doc().getElementById("wikiGroupFamilies") as HTMLInputElement;
    const chip = () => doc().querySelector<HTMLElement>('#wikiActiveOptions [data-view-option-off="families"]');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new (g.Event as typeof Event)("change", { bubbles: true }));
    expect(box.checked).toBe(true);
    expect(!!chip()).toBe(true);
    chip()!.click();
    expect(box.checked).toBe(false);
    expect(chip() === null).toBe(true);
    // The chip is gone; focus goes to the button that holds the option.
    expect(doc().activeElement === doc().getElementById("wikiOptionsBtn")).toBe(true);
  });

  test("the Filters button opens and closes the disclosure, and aria-expanded follows it", async () => {
    const btn = doc().getElementById("wikiFiltersBtn")!;
    const details = doc().getElementById("wikiFilters") as HTMLDetailsElement;
    const was = details.open;
    btn.click();
    expect(details.open).toBe(!was);
    await until(() => btn.getAttribute("aria-expanded") === String(!was), "aria-expanded to follow");
    btn.click();
    expect(details.open).toBe(was);
    await until(() => btn.getAttribute("aria-expanded") === String(was), "aria-expanded to follow back");
  });
});
