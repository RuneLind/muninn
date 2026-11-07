/**
 * The /wiki reader shell (`wiki-browser.ts`) driven for real: imported, then
 * booted once inside a happy-dom window over the server-rendered /wiki page.
 *
 * Isolation (load-bearing, pinned by `src/test/mock-isolation.test.ts`): this
 * file installs happy-dom's globals over Bun's own — `Event`, `EventTarget`,
 * `URL`, `fetch`, `setTimeout`, `Response` and ~500 more — for the life of the
 * process. It therefore runs in a `bun test` link of its own in every chain
 * (`&& bun test src/dashboard/views/wiki-boot/wiki-shell-boot.test.ts`), and its
 * directory sits outside every directory link.
 *
 * Why happy-dom's `GlobalWindow` and not `Window`: a plain `Window` leaves its
 * own `Object`/`Array`/`Promise` builtins undefined under Bun, and copying those
 * over globalThis crashes the process. `GlobalWindow` carries globalThis's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
// No static import of anything under `src/`: `wiki-page.ts` shares 68 of
// wiki-browser.ts's 151 modules, and a module already in the cache is not
// re-evaluated inside the counting window below (pinned by `preloaded`).

type Boot = typeof import("../components/wiki-browser.ts")["boot"];

const g = globalThis as unknown as Record<string, unknown>;

/** Never copied over: globalThis's own identity, the two value-literals, and
 *  `console`, which stays Bun's so test output keeps working. */
const IGNORE = new Set(["constructor", "undefined", "NaN", "global", "globalThis", "console"]);

/** The descriptor each overridden key had before (undefined = it was absent). */
const saved = new Map<string, PropertyDescriptor | undefined>();

let importEffects: { listeners: number; timeouts: number; intervals: number; fetches: number; microtasks: number };
/** App modules (under `src/`, outside the `src/test/` preload) already loaded
 *  when the counting window opened; each one escapes the import check. */
let preloaded: string[];
/** Modules first loaded inside the counting window. */
let loadedInWindow: string[];
let boot: Boot;
let win: GlobalWindow;
let handle: { dispose(): void };
/** Every `document.addEventListener` call `boot()` made, in order, with its
 *  phase (`capture` from a boolean or an options object's `capture`). */
const registered: { type: string; source: string; capture: boolean }[] = [];
/** Every `setInterval` call `boot()` made: the id it returned and the tick. */
const intervals: { id: unknown; source: string }[] = [];
const fetched: string[] = [];

const LISTING = {
  pages: [
    { name: "alpha", title: "Alpha", type: "concept", domain: "ai", tags: [], aliases: [], relPath: "concepts/alpha.md" },
    { name: "beta", title: "Beta", type: "concept", domain: "ai", tags: [], aliases: [], relPath: "concepts/beta.md" },
  ],
  scannedAt: 1_700_000_000_000,
};

/** Install the window registrator-style: every own property whose value differs
 *  from globalThis's is defined over it, the old descriptor kept for restore. A
 *  property whose value IS the window (`window`, `self`, `top`, `parent`) maps
 *  to globalThis, so `window.x` and bare `x` name the same binding. */
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

/** A stub `/api/wiki/*` that answers the listing and one page; `{}` otherwise.
 *  The `Response` is happy-dom's — the one the page code sees after install. */
async function stubFetch(input: unknown): Promise<unknown> {
  const raw = String(input);
  fetched.push(raw);
  const url = new URL(raw, "http://localhost:3011");
  let body: unknown = {};
  if (url.pathname === "/api/wiki/pages") body = LISTING;
  else if (url.pathname === "/api/wiki/page") {
    body = {
      meta: LISTING.pages[0],
      html: "<h1>Alpha</h1><p id='alphaBody'>The quick brown fox jumps over the lazy dog.</p>",
      outgoing: [LISTING.pages[1]],
      backlinks: [],
    };
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

function key(k: string): void {
  const doc = g.document as Document;
  const KE = g.KeyboardEvent as typeof KeyboardEvent;
  doc.body.dispatchEvent(new KE("keydown", { key: k, bubbles: true, cancelable: true }));
}

beforeAll(async () => {
  // (1) Import with no DOM at all: no listener, timer, microtask or fetch.
  expect(typeof g.document).toBe("undefined");
  expect(typeof g.location).toBe("undefined");
  const cachedBefore = new Set(Object.keys(require.cache));
  preloaded = [...cachedBefore].filter((k) => k.includes("/src/") && !k.includes("/src/test/") && k !== import.meta.path);
  const counts = { listeners: 0, timeouts: 0, intervals: 0, fetches: 0, microtasks: 0 };
  const real = {
    addEventListener: g.addEventListener,
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    fetch: g.fetch,
    queueMicrotask: g.queueMicrotask,
  };
  g.addEventListener = () => void counts.listeners++;
  g.setTimeout = () => (counts.timeouts++, 0);
  g.setInterval = () => (counts.intervals++, 0);
  g.fetch = () => (counts.fetches++, Promise.reject(new Error("fetch at import")));
  g.queueMicrotask = () => void counts.microtasks++;
  try {
    boot = (await import("../components/wiki-browser.ts")).boot;
  } finally {
    Object.assign(g, real);
  }
  importEffects = counts;
  loadedInWindow = Object.keys(require.cache).filter((k) => !cachedBefore.has(k));

  // (2) The real page, its inline scripts dropped: happy-dom does not run the
  // injection script, so the `__WIKI_*__` globals are set by hand below.
  const { renderWikiPage } = await import("../wiki-page.ts");
  const html = (await renderWikiPage({ wikis: ["w"], selected: "w", wikiRoot: "/tmp/w" })).replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/g,
    "",
  );
  win = new GlobalWindow({
    url: "http://localhost:3011/wiki?wiki=w&page=alpha",
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigation: { disableMainFrameNavigation: true },
    },
  });
  win.document.write(html);
  installWindow(win);

  // (3) Globals, fetch stub, one boot, the article open.
  Object.assign(g, { __WIKI_NAME__: "w", __WIKI_ROOT__: "/tmp/w", __WIKI_FIND_SELF__: "w", __WIKI_FIND_ROWS__: "w" });
  g.fetch = stubFetch;
  const doc = g.document as Document & { addEventListener: Document["addEventListener"] };
  const realAdd = doc.addEventListener;
  // An own property shadowing the prototype method, for the boot call only.
  doc.addEventListener = function (this: Document, type: string, fn: unknown, opts?: unknown) {
    const capture = typeof opts === "boolean" ? opts : !!(opts as { capture?: boolean } | undefined)?.capture;
    registered.push({ type, source: String(fn), capture });
    return (realAdd as (...a: unknown[]) => void).call(this, type, fn, opts);
  } as Document["addEventListener"];
  const realSetInterval = g.setInterval as (...a: unknown[]) => unknown;
  g.setInterval = (fn: unknown, ...rest: unknown[]) => {
    const id = realSetInterval(fn, ...rest);
    intervals.push({ id, source: String(fn) });
    return id;
  };
  try {
    handle = boot();
  } finally {
    delete (doc as unknown as Record<string, unknown>).addEventListener;
    g.setInterval = realSetInterval;
  }
  await until(() => !!doc.querySelector("#articleWrap #alphaBody"), "the article to render");
}, 30_000);

afterAll(async () => {
  handle?.dispose();
  await win?.happyDOM.abort();
  win?.close();
  restoreGlobals();
});

describe("wiki-browser.ts — import and boot", () => {
  test("the whole import graph is evaluated inside the counting window", () => {
    expect(preloaded).toEqual([]);
    expect(loadedInWindow.some((k) => k.endsWith("/components/wiki-browser.ts"))).toBe(true);
  });

  test("importing the module adds no listener, timer, microtask or fetch", () => {
    expect(importEffects).toEqual({ listeners: 0, timeouts: 0, intervals: 0, fetches: 0, microtasks: 0 });
  });

  test("boot() wires the page: the listing and the deep-linked article are fetched", () => {
    expect(fetched).toContain("/api/wiki/pages?wiki=w");
    expect(fetched).toContain("/api/wiki/page?name=alpha&wiki=w");
    expect(registered.length).toBeGreaterThan(40);
  });

  test("a second boot() throws rather than wiring a second listener set", () => {
    expect(() => boot()).toThrow("boot() called twice");
  });
});

describe("wiki-browser.ts — listener order", () => {
  test("the shell's click delegate is registered before initChatOptions' (dialog click-away reads a detached target)", () => {
    // Replaces the `indexOf` grep that `wiki-chat-target.test.ts` held: this is
    // the order the listeners were REGISTERED in at runtime. The shell's
    // delegate synchronously detaches the integrate panel on its Cancel
    // (`cancelFactcheckIntegrate`); the dialog's click-away, which reads
    // `document.contains(target)`, must run after it.
    const clicks = registered.filter((r) => r.type === "click");
    const shell = clicks.findIndex((r) => r.source.includes("#wikiFcIntCancel"));
    const dialog = clicks.findIndex((r) => r.source.includes("#wikiChatEscOptBtn"));
    expect(shell).toBeGreaterThan(-1);
    expect(dialog).toBeGreaterThan(-1);
    expect(shell).toBeLessThan(dialog);
    // Order decides dispatch only within one phase: a capture-phase listener on
    // `document` runs before any bubble-phase one, whatever was registered first.
    expect(clicks[shell]!.capture).toBe(false);
    expect(clicks[dialog]!.capture).toBe(false);
  });

  test("Escape with two surfaces open closes the top one only, then the next", async () => {
    const doc = g.document as Document;
    const pane = doc.getElementById("wikiOptions")!;
    const explain = doc.getElementById("wikiExplainBtn") as HTMLElement;
    expect(explain).toBeTruthy();

    // Surface 1: the ✨ Explain button, revealed by a real selection + mouseup.
    const text = doc.getElementById("alphaBody")!.firstChild!;
    const range = doc.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 15);
    const sel = (g.getSelection as () => Selection)();
    sel.removeAllRanges();
    sel.addRange(range);
    const ME = g.MouseEvent as typeof MouseEvent;
    doc.getElementById("articleWrap")!.dispatchEvent(new ME("mouseup", { bubbles: true }));
    await until(() => explain.style.display === "", "the Explain button to show");

    // Surface 2: the View options pane.
    (doc.getElementById("wikiOptionsBtn") as HTMLElement).click();
    expect(pane.hidden).toBe(false);

    // The pane's capture-phase Escape closes it and stops the event, so the
    // bubble-phase Explain dismissal never sees it.
    key("Escape");
    expect(pane.hidden).toBe(true);
    expect(explain.style.display).toBe("");

    // The next Escape reaches the bubble listeners: the Explain button goes.
    key("Escape");
    expect(explain.style.display).toBe("none");
  });
});

describe("wiki-browser.ts — dispose", () => {
  // Runs last: it stops the timers the tests above may rely on. Observed before
  // afterAll's `happyDOM.abort()`, which clears every timer on its own.
  test("dispose() clears every interval boot() registered", () => {
    // The two known timers, so a renamed callback is noticed here rather than
    // the set below silently shrinking.
    expect(intervals.find((i) => i.source.includes("maybeRefetchPages"))).toBeTruthy();
    expect(intervals.find((i) => i.source.includes("repaintMirrorStatus"))).toBeTruthy();
    // clearTimeout and clearInterval share one id pool (HTML timers), so either clears an interval.
    const cleared: unknown[] = [];
    const realClearInterval = g.clearInterval as (id: unknown) => void;
    const realClearTimeout = g.clearTimeout as (id: unknown) => void;
    g.clearInterval = (id: unknown) => (cleared.push(id), realClearInterval(id));
    g.clearTimeout = (id: unknown) => (cleared.push(id), realClearTimeout(id));
    try {
      handle.dispose();
    } finally {
      g.clearInterval = realClearInterval;
      g.clearTimeout = realClearTimeout;
    }
    expect(intervals.filter((i) => !cleared.includes(i.id)).map((i) => i.source)).toEqual([]);
  });
});
