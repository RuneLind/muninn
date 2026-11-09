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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// No static import of anything under `src/`: `wiki-page.ts` shares 68 of
// wiki-browser.ts's 151 modules, and a module already in the cache is not
// re-evaluated inside the counting window below (pinned by `preloaded`).

type Boot = typeof import("../components/wiki-browser.ts")["boot"];

const g = globalThis as unknown as Record<string, unknown>;

/** True iff `key` (a `require.cache` path) is an app module: under the repo's
 *  `src/`, outside the `src/test/` preload, and not this file. Decided on the
 *  absolute path relative to the repo root, so a checkout under any `.../src/...` path
 *  neither counts `node_modules` nor goes blind. A key outside the repo is
 *  relative as `../...` (or absolute across Windows drives) and so never
 *  starts with `src/`. */
function isAppModule(key: string, repoRoot: string, selfPath: string): boolean {
  // Builtins and bare specifiers (`node:fs`, `bun:test`, `ws`) are cache keys
  // too; path.relative would resolve them against the cwd.
  if (key === selfPath || !path.isAbsolute(key)) return false;
  const rel = path.relative(repoRoot, key).split(path.sep).join("/");
  return rel.startsWith("src/") && !rel.startsWith("src/test/");
}

const lowerFirst = (n: string) => n[0]!.toLowerCase() + n.slice(1);

/** Bare `setX(arg)` → `x = arg`, the argument found by matching parens. */
function setCallsToAssignments(s: string): string {
  const re = /(?<![.\w$])set(?!Timeout\(|Interval\()([A-Z]\w*)\(/g;
  let out = "";
  let from = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    let depth = 1;
    let j = re.lastIndex;
    for (; j < s.length && depth; j++) depth += s[j] === "(" ? 1 : s[j] === ")" ? -1 : 0;
    out += s.slice(from, m.index) + lowerFirst(m[1]!) + " = " + setCallsToAssignments(s.slice(re.lastIndex, j - 1));
    from = re.lastIndex = j;
  }
  return out + s.slice(from);
}

/** A handler's identity in the listener pin: a hash of its source after the
 *  rewrites a verbatim move into a controller makes (`deps.x`→`x`, a bare
 *  zero-arg call `x()`→`x` and `getX()`→`x`, a bare `setX(v)`→`x = v`, whitespace),
 *  so a move keeps it; any other token change (a `!`, an operator, a name) does not. */
function handlerFingerprint(source: string): string {
  const norm = setCallsToAssignments(
    source.replace(/\bdeps\./g, "").replace(/(?<![.\w$])(\w+)\(\)/g, (_m, n: string) => (/^get[A-Z]/.test(n) ? lowerFirst(n.slice(3)) : n)),
  ).replace(/\s/g, "");
  return Bun.hash(norm).toString(36).slice(0, 5);
}

/** The nearest folder above this file holding a `package.json`. */
function findRepoRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`no package.json above ${from}`);
  }
}

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
/** Every `addEventListener` call `boot()` made, on any target, in order: the
 *  target (`window`, `document`, `#id`, else the tag name), the type, the phase
 *  (`capture` from a boolean or an options object's `capture`), the other
 *  options (`once`, `passive`, a `signal`; listed only when set) and the handler. */
const listened: { target: string; type: string; source: string; capture: boolean; opts: string[] }[] = [];
/** The `document` ones among them. */
let registered: { type: string; source: string; capture: boolean }[] = [];
/** Every `setInterval` call `boot()` made: the id it returned and the tick. */
const intervals: { id: unknown; source: string }[] = [];
const fetched: string[] = [];

const LISTING = {
  pages: [
    { name: "alpha", title: "Alpha", type: "concept", domain: "ai", tags: [], aliases: [], relPath: "concepts/alpha.md" },
    { name: "beta", title: "Beta", type: "concept", domain: "ai", tags: [], aliases: [], relPath: "concepts/beta.md" },
    { name: "gamma", title: "Gamma", type: "entity", domain: "ai", tags: [], aliases: [], relPath: "entities/gamma.md" },
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
  else if (url.pathname === "/api/wiki/index-coverage") body = { totalMd: 3, indexed: 2, missing: ["entities/gamma.md"] };
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

/** The prototype on `node`'s chain that owns `addEventListener`. */
function findAddOwner(node: object): Record<string, unknown> {
  let p = Object.getPrototypeOf(node) as Record<string, unknown>;
  while (!Object.prototype.hasOwnProperty.call(p, "addEventListener")) p = Object.getPrototypeOf(p);
  return p;
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
  const repoRoot = findRepoRoot(import.meta.dir);
  preloaded = [...cachedBefore].filter((k) => isAppModule(k, repoRoot, import.meta.path));
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
  const doc = g.document as Document;
  // The prototype that owns the document's `addEventListener` (happy-dom's base
  // EventTarget, shared by every node; `g.EventTarget` is a per-window subclass
  // it does not reach); the window's is globalThis's (`window` maps to
  // globalThis), so it is wrapped too. Both originals are taken before either is
  // replaced: no call records twice.
  const proto = findAddOwner(doc);
  expect(findAddOwner(doc.body)).toBe(proto);
  const realProtoAdd = proto.addEventListener as (...a: unknown[]) => void;
  const hadOwnWinAdd = Object.prototype.hasOwnProperty.call(g, "addEventListener");
  const realWinAdd = g.addEventListener as (...a: unknown[]) => void;
  const record = (t: unknown, type: string, fn: unknown, opts: unknown) => {
    const o = (typeof opts === "object" && opts ? opts : {}) as { capture?: boolean; once?: boolean; passive?: boolean; signal?: unknown };
    const capture = typeof opts === "boolean" ? opts : !!o.capture;
    const flags = [o.once && "once", o.passive !== undefined && `passive=${o.passive}`, o.signal !== undefined && "signal"];
    const el = t as Element;
    const target = t === globalThis ? "window" : t === doc ? "document" : el.id ? `#${el.id}` : String(el.tagName ?? t).toLowerCase();
    listened.push({ target, type, source: String(fn), capture, opts: flags.filter((f): f is string => !!f) });
  };
  proto.addEventListener = function (this: unknown, type: string, fn: unknown, opts?: unknown) {
    record(this, type, fn, opts);
    return realProtoAdd.call(this, type, fn, opts);
  };
  g.addEventListener = function (type: string, fn: unknown, opts?: unknown) {
    record(globalThis, type, fn, opts);
    return realWinAdd.call(globalThis, type, fn, opts);
  };
  const realSetInterval = g.setInterval as (...a: unknown[]) => unknown;
  g.setInterval = (fn: unknown, ...rest: unknown[]) => {
    const id = realSetInterval(fn, ...rest);
    intervals.push({ id, source: String(fn) });
    return id;
  };
  try {
    handle = boot();
  } finally {
    proto.addEventListener = realProtoAdd;
    if (hadOwnWinAdd) g.addEventListener = realWinAdd;
    else delete g.addEventListener;
    g.setInterval = realSetInterval;
  }
  registered = listened.filter((l) => l.target === "document");
  await until(() => !!doc.querySelector("#articleWrap #alphaBody"), "the article to render");
}, 30_000);

afterAll(async () => {
  handle?.dispose();
  await win?.happyDOM.abort();
  win?.close();
  restoreGlobals();
});

describe("wiki-browser.ts — import and boot", () => {
  // Covers app modules under the repo's `src/` only; `node_modules` is
  // deliberately out of scope (happy-dom is loaded before the window opens).
  test("every app module under src/ is evaluated inside the counting window", () => {
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

describe("findRepoRoot — the root the preload check is decided against", () => {
  // A wrong root makes `isAppModule` answer false for every key, so `preloaded`
  // would be empty however many app modules were loaded first: the check above
  // would pass blind. This pins the root, and that it sees app modules at all.
  test("is muninn's checkout root, and an app module loaded by boot counts under it", () => {
    const root = findRepoRoot(import.meta.dir);
    expect((JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name: string }).name).toBe("muninn");
    expect(existsSync(path.join(root, "scripts", "test-chain.ts"))).toBe(true);
    const shell = loadedInWindow.find((k) => k.endsWith("/components/wiki-browser.ts"))!;
    expect(isAppModule(shell, root, import.meta.path)).toBe(true);
    expect(loadedInWindow.filter((k) => isAppModule(k, root, import.meta.path)).length).toBeGreaterThan(100);
  });
});

describe("isAppModule — which require.cache keys count as preloaded app modules", () => {
  const SELF = "/repo/src/dashboard/views/wiki-boot/wiki-shell-boot.test.ts";
  const cases: [string, string, string, boolean][] = [
    ["a: repo root without /src/, app module", "/repo", "/repo/src/dashboard/x.ts", true],
    ["b: the src/test/ preload", "/repo", "/repo/src/test/preload.ts", false],
    ["c: node_modules", "/repo", "/repo/node_modules/happy-dom/lib/x.js", false],
    ["d: outside the repo", "/repo", "/opt/other/src/x.ts", false],
    ["e: root under /src/, node_modules (old false red)", "/home/src/muninn", "/home/src/muninn/node_modules/happy-dom/x.js", false],
    ["f: root under /src/, app module", "/home/src/muninn", "/home/src/muninn/src/dashboard/x.ts", true],
    ["g: root under /src/test/, app module (old blind case)", "/x/src/test/muninn", "/x/src/test/muninn/src/dashboard/x.ts", true],
    ["h: this test file", "/repo", SELF, false],
    ["i: sibling repo sharing the root as a string prefix", "/home/muninn", "/home/muninn-old/src/x.ts", false],
    // Non-absolute keys (`node:fs`, `ws`): path.relative resolves them against
    // the cwd, so with root = cwd a relative key lands under `src/` from any cwd.
    ["j: a relative key, root = cwd", process.cwd(), "src/dashboard/x.ts", false],
    ["k: a builtin key, root = cwd", process.cwd(), "node:fs", false],
  ];
  for (const [name, root, k, want] of cases) {
    test(name, () => expect(isAppModule(k, root, SELF)).toBe(want));
  }
});

describe("handlerFingerprint — survives a move, tells handlers apart", () => {
  const before =
    "(e) => {\n  if (deps.filters.tag && deps.allPages().length) deps.setRailOpen(!deps.getRailOpen());\n  openFolds = toggleFolded(deps.WIKI(), e.key);\n  deps.render(e);\n}";
  test("the C2–C4 port rewrites leave it unchanged", () => {
    const moved = "(e) => {\n  if (filters.tag && allPages().length) railOpen = !railOpen;\n  openFolds = toggleFolded(WIKI, e.key);\n  render(e);\n}";
    expect(handlerFingerprint(moved)).toBe(handlerFingerprint(before));
  });
  test("a different handler gets a different one", () => {
    expect(handlerFingerprint(before.replace("render", "paint"))).not.toBe(handlerFingerprint(before));
  });
  test("a negation or operator flip gets a different one", () => {
    const h = "(e) => {\n  if (!open && e.key !== \"Escape\") close();\n}";
    for (const flipped of [h.replace("!open", "open"), h.replace("!==", "=="), h.replace("!==", "!=")]) {
      expect(flipped).not.toBe(h);
      expect(handlerFingerprint(flipped)).not.toBe(handlerFingerprint(h));
    }
  });
});

describe("wiki-browser.ts — listener order", () => {
  test("every listener boot() registers, in registration order, is pinned", () => {
    // The order is load-bearing (`keydown` handlers read `defaultPrevented`, the
    // click delegates' selector sets rely on who runs first), and moving code out
    // of the shell into controllers (mimir plan muninn-wiki-browser-split) must
    // keep it: each entry is target, type, phase, any once/passive/signal option
    // and the handler's fingerprint (so a swap inside a run of one label fails).
    // Order captured from the pre-move code at 832e0b9b (base 00eeaa2f); a change
    // here is a reordering to justify, never to re-snapshot. Editing a handler's
    // body changes its fingerprint only: update that one entry. Fingerprints hash
    // Bun's re-printed `String(fn)`, pinned by CI's BUN_VERSION: on a Bun bump, re-snapshot
    // them only after the label-only check below passes (target/type/options unchanged).
    const label = (l: (typeof listened)[number]) =>
      [l.target, l.type, ...(l.capture ? ["capture"] : []), ...l.opts, handlerFingerprint(l.source)].join(" ");
    const PINNED = [
      "document input 2lr9x", "document toggle capture 1hmo1", "document click capture xplwj",
      "document selectionchange 2rr9w", "document pointerdown capture 1kth3", "document pointerup capture g28bu",
      "document pointercancel capture g28bu", "document contextmenu capture g28bu",
      "document pointermove capture 1qtti", "document click 23ej6", "document keydown hlssx", "document keydown yo4j6",
      "document change e5k9f", "document mouseover 1s9vt", "document focusin 1s9vt", "document mouseout 3fqd2",
      "document focusout 78yv1", "document keydown capture 3m8dl", "window resize 9x9xn",
      "#wikiRailResizer pointerdown s1ktq", "#wikiRailResizer pointermove 2zrwk", "#wikiRailResizer pointerup 2ipmi",
      "#wikiRailResizer pointercancel 2ipmi", "#wikiRailResizer lostpointercapture 2ipmi",
      "#wikiRailResizer dblclick 2ix69", "#wikiRailResizer keydown 1hhyy", "document click 1wxv0",
      "document keydown 3uqix", "#staleBody toggle capture 2a2m2", "document keydown 3nsjp",
      "window scroll capture p45k6", "window resize 2km4o", "document click 1bnhl", "document submit 3msp4",
      "document mouseover 1czfm", "document mouseout 2u68x", "document focusin 3ui45", "document change 1cb94",
      "document keydown capture 2pgt9", "document keydown 2gxm7", "document keydown 1hysz", "body click 20r2i",
      "document click 33ul7", "document keydown 1mf3n", "document keydown 2p96v", "window scroll capture 17plc",
      "window resize 24jk9", "#wikiList click jjzww", "#wikiSearch input 2darq", "#domainChips click 7wyxo",
      "#wikiFolder change 1ytiq", "#typeChips click 1oh5g", "#statusChips click 348ix", "#projectChips click 17olm",
      "#jiraChips click 2ea4q", "#tagChips click 2hy5a", "#wikiSort change 5y9t3", "#wikiGroupFamilies change 35ij3",
      "#wikiGroupEfforts change x5cu4", "#wikiShowRetired change vdddp", "#wikiFiltersBtn click 38n1w",
      "#wikiFilters toggle 1cx2k", "#wikiOptionsBtn click 80q4g", "document pointerdown 3edk0",
      "document focusin 3l9rj", "document keydown capture 1c2w7", "#wikiActiveOptions click 19s7n",
      "#wikiSelect change 3le4p", "window hashchange kobbe", "window popstate 24ens", "#wikiAskBtn click 7m320",
      "#wikiAskInput keydown 36h0q", "#wikiAskHistory click 13b99", "document click 1vfg7", "document keydown 2zmrp",
      "document click 1ha77", "document change 1typa", "document input smycp", "document keydown 2bnv5",
      "document change kqu5p", "document toggle capture 2ac08", "document keydown 35n5s", "#articleWrap mouseup 2roml",
      "document selectionchange 33rjq", "document keydown crscu", "document mousedown m9lmg", "window message 30vgu",
      "window storage 3sulz", "#wikiList keydown agmpg", "document keydown 3m3iv", "document click 1asqt",
      "window focus 8kg09", "document visibilitychange 29s0r",
    ];
    // The labels alone first, so a failure says whether the order moved or only a fingerprint did.
    const withoutFingerprint = (s: string) => s.slice(0, s.lastIndexOf(" "));
    expect(listened.map(label).map(withoutFingerprint)).toEqual(PINNED.map(withoutFingerprint));
    expect(listened.map(label)).toEqual(PINNED);
  });

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

describe("the left pane (wiki-rail-controller.ts), driven through the booted shell", () => {
  const doc = () => g.document as Document;
  const rows = () => Array.from(doc().querySelectorAll<HTMLElement>("#wikiList .wiki-list-item")).map((r) => r.getAttribute("data-relpath"));
  const ALL = ["concepts/alpha.md", "concepts/beta.md", "entities/gamma.md"];

  test("the modules the shell imports are evaluated inside the import-effect window", () => {
    for (const m of [
      "/components/wiki-rail-controller.ts",
      "/components/wiki-shell-state.ts",
      "/components/wiki-work-map-cache.ts",
      "/components/wiki-stale-controller.ts",
      "/components/wiki-effort-controller.ts",
      "/components/wiki-menus-controller.ts",
      "/components/wiki-ask-controller.ts",
      "/components/wiki-article-controller.ts",
      "/components/wiki-series-controller.ts",
    ]) {
      expect(loadedInWindow.some((k) => k.endsWith(m))).toBe(true);
    }
  });

  test("typing in the filter re-renders the list to the matching rows, and clearing restores it", async () => {
    await until(() => rows().length === 3, "the rail to list the three pages");
    expect([...rows()].sort()).toEqual(ALL);
    const box = doc().getElementById("wikiSearch") as HTMLInputElement;
    const Ev = g.Event as typeof Event;
    box.value = "gamm";
    box.dispatchEvent(new Ev("input", { bubbles: true }));
    expect(rows()).toEqual(["entities/gamma.md"]);
    box.value = "";
    box.dispatchEvent(new Ev("input", { bubbles: true }));
    expect([...rows()].sort()).toEqual(ALL);
  });

  test("a type chip narrows the list and marks itself active; All types restores it", () => {
    const chip = (t: string) => doc().querySelector<HTMLElement>(`#typeChips [data-type="${t}"]`)!;
    chip("entity").click();
    expect(rows()).toEqual(["entities/gamma.md"]);
    expect(chip("entity").classList.contains("active")).toBe(true);
    chip("").click();
    expect([...rows()].sort()).toEqual(ALL);
    expect(chip("").classList.contains("active")).toBe(true);
  });

  test("the ★ pins a page in place: the row's button flips, the list is not redrawn", () => {
    const row = doc().querySelector<HTMLElement>('#wikiList .wiki-list-item[data-relpath="concepts/beta.md"]')!;
    const star = row.querySelector<HTMLElement>("[data-pin]")!;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    star.click();
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.isConnected).toBe(true);
    expect(JSON.stringify((g.localStorage as Storage).getItem("muninn.wiki.pins.v1:w"))).toContain("concepts/beta.md");
    star.click();
    expect(star.getAttribute("aria-pressed")).toBe("false");
  });

  test("the coverage footer shows the index line, and its link opens the start view", async () => {
    const foot = doc().getElementById("wikiCoverageFoot")!;
    await until(() => foot.style.display === "" && !!doc().getElementById("wikiCoverageLink"), "the coverage footer");
    expect(foot.textContent).toBe("3 pages · indexed 2 · 1 missing");
    expect(fetched).toContain("/api/wiki/index-coverage?wiki=w");
    doc().getElementById("wikiCoverageLink")!.click();
    expect(new URLSearchParams((g.location as Location).search).get("page")).toBeNull();
    expect(doc().querySelector("#articleWrap #alphaBody")).toBeNull();
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

