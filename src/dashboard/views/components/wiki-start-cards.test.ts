import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  applyReindexUi,
  initStartCards,
  loadDigest,
  loadIndexCoverage,
  mountStartCards,
  startReindex,
  REINDEX_SETTLED_TTL_MS,
} from "./wiki-start-cards.ts";

/**
 * The repo has no browser test env (no jsdom/happy-dom), so — like the sibling
 * `wiki-factcheck-reader.test.ts` / `code-tabs.test.ts` — the DOM here is a
 * minimal hand-rolled shim and the real render path is left to the reader's
 * headless smoke.
 *
 * The shim registers every id these cards address (`wikiWhatsNew`,
 * `wikiIndexCard` and the four controls) as INDEPENDENT elements rather than
 * parsing the markup written into the cards. That is the one place it diverges
 * from a real document, and it is the divergence that makes the reindex slot
 * assertable: on the live page the status div lives inside the Index card and is
 * re-painted by `applyReindexUi` after every card render, which is behaviourally
 * what "a standalone slot that survives the card's innerHTML write" models.
 *
 * What is locked here is the wiring this extraction moved: that the injected
 * `withWiki` reaches every fetch, that the injected `resolvePageName` is what
 * turns a missing relPath into an in-reader link, that `mountStartCards` still
 * fires both lazy loads, that a failed digest keeps the last good one, and that
 * the reindex POST → poll → settle cycle still paints its rows and re-enables
 * the button.
 *
 * The module state is per-file and cached by design, so the mount test is the one
 * that gets the virgin state and every later test asks for a refresh (which
 * bypasses the once-only guards), exactly as the card's ↻ buttons do. No test
 * READS state a previous one left behind, though — the reindex cases seed their
 * own through the public cycle, so each passes run alone under `-t`.
 */

// ── Minimal DOM ───────────────────────────────────────────────────────────────

interface ShimEl {
  id: string;
  innerHTML: string;
  style: { display: string };
  disabled: boolean;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
}

const registry = new Map<string, ShimEl>();

function makeEl(id: string): ShimEl {
  const classes = new Set<string>();
  return {
    id,
    innerHTML: "",
    style: { display: "none" },
    disabled: false,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

/** The ids the shell's `renderStart` markup puts on the page, plus the controls
 *  the cards render inside them. */
const START_IDS = [
  "wikiWhatsNew",
  "wikiWhatsNewRefresh",
  "wikiIndexCard",
  "wikiIndexRefresh",
  "wikiIndexReindex",
  "wikiIndexReindexStatus",
];

function el(id: string): ShimEl {
  const found = registry.get(id);
  if (!found) throw new Error("no such shim element: " + id);
  return found;
}

// ── Fake fetch + fake timers ──────────────────────────────────────────────────

/** Every request the cards made, in order — the URL assertions read this. */
let calls: { url: string; method: string }[] = [];
/** URL substring → JSON body. First match wins. */
let routes: [string, unknown][] = [];

function respond(url: string, init?: { method?: string }): Promise<{ json(): Promise<unknown> }> {
  calls.push({ url, method: init?.method || "GET" });
  const hit = routes.find(([frag]) => url.includes(frag));
  if (!hit) return Promise.reject(new Error("unrouted: " + url));
  return Promise.resolve({ json: () => Promise.resolve(hit[1]) });
}

/** Pending `window.setTimeout` callbacks, fired by hand — the reindex poller's
 *  3 s cadence is a contract, not something a test should wait out. */
let pendingTimers: { id: number; fn: () => void }[] = [];
let nextTimerId = 1_000_000_001;

function flushTimers(): void {
  const due = pendingTimers;
  pendingTimers = [];
  due.forEach((t) => t.fn());
}

/** Let the cards' promise chains settle (fake fetch resolves immediately, so a
 *  handful of microtask turns is enough). */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const savedGlobals: Record<string, unknown> = {};

beforeEach(() => {
  registry.clear();
  START_IDS.forEach((id) => registry.set(id, makeEl(id)));
  calls = [];
  routes = [];
  pendingTimers = [];
  const g = globalThis as unknown as Record<string, unknown>;
  savedGlobals.document = g.document;
  savedGlobals.window = g.window;
  savedGlobals.fetch = g.fetch;
  g.document = { getElementById: (id: string) => registry.get(id) || null };
  g.window = {
    setTimeout: (fn: () => void) => {
      const id = nextTimerId++;
      pendingTimers.push({ id, fn });
      return id;
    },
  };
  g.fetch = respond;
  initStartCards({
    withWiki: (url: string) => url + (url.indexOf("?") === -1 ? "?" : "&") + "wiki=probe",
    resolvePageName: (relPath: string) =>
      relPath === "concepts/embeddings.md" ? "Embeddings" : null,
  });
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = savedGlobals.document;
  g.window = savedGlobals.window;
  g.fetch = savedGlobals.fetch;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const digestOk = {
  digest: {
    bullets: "- one\n- two",
    html: "<ul><li>one</li></ul>",
    generatedAt: 0,
    logMtimeMs: 0,
    entryCount: 2,
    fromDate: "2026-08-10",
    toDate: "2026-08-17",
  },
};

const coverageOk = {
  collections: ["wiki"],
  totalMd: 42,
  indexed: 40,
  missing: ["concepts/embeddings.md", "notes/untracked.md"],
  excludedByRule: [],
  ghosts: ["gone.md"],
  htmlPages: 3,
  generatedAt: 0,
  dirtyCount: 0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("wiki-start-cards", () => {
  test("mountStartCards lazily loads BOTH cards into the shell's start ids", async () => {
    routes = [
      ["/api/wiki/digest", digestOk],
      ["/api/wiki/index-coverage", coverageOk],
    ];
    mountStartCards();
    await settle();

    // Injected withWiki reached both fetches — the cards never build a URL alone.
    expect(calls.map((c) => c.url)).toEqual([
      "/api/wiki/digest?wiki=probe",
      "/api/wiki/index-coverage?wiki=probe",
    ]);

    const wn = el("wikiWhatsNew");
    expect(wn.style.display).toBe("");
    expect(wn.innerHTML).toContain("wiki-wn-head");
    expect(wn.innerHTML).toContain("2026-08-10 – 2026-08-17");
    expect(wn.innerHTML).toContain('id="wikiWhatsNewRefresh"');
    expect(wn.innerHTML).toContain("<ul><li>one</li></ul>");

    const ix = el("wikiIndexCard");
    expect(ix.style.display).toBe("");
    expect(ix.innerHTML).toContain("wiki-ix-summary");
    expect(ix.innerHTML).toContain("<b>40</b> of <b>42</b> pages indexed");
    expect(ix.innerHTML).toContain("<b>2</b> missing");
    expect(ix.innerHTML).toContain("<b>1</b> ghost");
    expect(ix.innerHTML).toContain("3 explainers (not indexed)");
    expect(ix.innerHTML).toContain('id="wikiIndexReindex"');
    expect(ix.innerHTML).toContain('id="wikiIndexReindexStatus"');
    // No dirty badge on a clean subtree.
    expect(ix.innerHTML).not.toContain("wiki-ix-dirty");
  });

  test("the injected resolvePageName is what makes a missing page clickable", async () => {
    routes = [["/api/wiki/index-coverage", coverageOk]];
    loadIndexCoverage(true);
    await settle();

    const ix = el("wikiIndexCard").innerHTML;
    // Resolvable relPath → in-reader link carrying the page NAME.
    expect(ix).toContain('<span class="wiki-ix-link" data-page="Embeddings">concepts/embeddings.md</span>');
    // Unresolvable → plain code, no link.
    expect(ix).toContain("<code>notes/untracked.md</code>");
    // Ghosts are never linkable (there is no file to open).
    expect(ix).toContain("<code>gone.md</code>");
    expect(calls[calls.length - 1]!.url).toBe("/api/wiki/index-coverage?refresh=1&wiki=probe");
  });

  test("a failed digest refresh keeps the last good digest and offers a retry", async () => {
    routes = [["/api/wiki/digest", { digest: null, error: "connector busy" }]];
    loadDigest(true);
    await settle();

    const wn = el("wikiWhatsNew");
    expect(wn.innerHTML).toContain("wiki-wn-error");
    expect(wn.innerHTML).toContain('id="wikiWhatsNewRetry"');
    expect(wn.innerHTML).toContain("connector busy");
    // The previously cached digest is still above the error, not blanked.
    expect(wn.innerHTML).toContain("wiki-wn-head");
    expect(wn.style.display).toBe("");
  });

  test("a degraded coverage response renders the quiet unavailable card", async () => {
    routes = [
      [
        "/api/wiki/index-coverage",
        { ...coverageOk, totalMd: null, indexed: null, missing: null, ghosts: null, htmlPages: 2 },
      ],
    ];
    loadIndexCoverage(true);
    await settle();

    const ix = el("wikiIndexCard").innerHTML;
    expect(ix).toContain("wiki-ix-unavailable");
    expect(ix).toContain("Index status unavailable.");
    expect(ix).toContain("2 explainers (not indexed)");
    // The head (and so the manual reindex trigger) survives the degrade.
    expect(ix).toContain('id="wikiIndexReindex"');
  });

  test("startReindex POSTs, paints rows, polls, then settles and refetches coverage", async () => {
    routes = [
      ["/api/wiki/reindex-status", { collections: [{ name: "wiki", status: "succeeded" }] }],
      ["/api/wiki/reindex", { collections: [{ name: "wiki", state: "started" }] }],
      ["/api/wiki/index-coverage", coverageOk],
    ];

    startReindex();
    expect(el("wikiIndexReindexStatus").innerHTML).toContain("Starting reindex…");
    await settle();

    expect(calls[0]).toEqual({ url: "/api/wiki/reindex?wiki=probe", method: "POST" });
    const running = el("wikiIndexReindexStatus").innerHTML;
    expect(running).toContain('class="wiki-ix-reindex-row running"');
    expect(running).toContain("rebuild started");
    expect(el("wikiIndexReindex").disabled).toBe(true);
    expect(pendingTimers.length).toBe(1); // poll scheduled, not yet fired

    flushTimers();
    await settle();

    expect(calls.map((c) => c.url)).toEqual([
      "/api/wiki/reindex?wiki=probe",
      "/api/wiki/reindex-status?wiki=probe",
      "/api/wiki/index-coverage?refresh=1&wiki=probe",
    ]);
    const settled = el("wikiIndexReindexStatus").innerHTML;
    expect(settled).toContain('class="wiki-ix-reindex-row ok"');
    expect(settled).toContain("rebuilt");
    expect(el("wikiIndexReindex").disabled).toBe(false);
    expect(pendingTimers.length).toBe(0); // poll cycle stopped
  });

  test("applyReindexUi re-paints the persisted status after a card re-render, and drops it once stale", async () => {
    // Seed the module's reindex state through the SAME public cycle a user
    // drives — no leaning on the previous test's leftovers, so this case passes
    // run alone (`-t applyReindexUi`) as well as in file order. `Date.now` is
    // pinned for the same reason: `REINDEX_SETTLED_TTL_MS` is measured against
    // the settle stamp, and a wall clock would make the assertions below depend
    // on how long the suite happened to take.
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      routes = [
        ["/api/wiki/reindex-status", { collections: [{ name: "wiki", status: "succeeded" }] }],
        ["/api/wiki/reindex", { collections: [{ name: "wiki", state: "started" }] }],
        ["/api/wiki/index-coverage", coverageOk],
      ];
      startReindex();
      await settle();
      flushTimers();
      await settle();
      expect(el("wikiIndexReindexStatus").innerHTML).toContain("rebuilt");

      // A card re-render (tab switch) replaces the card body, blanking the slot;
      // the status lives in module state and must come back.
      el("wikiIndexReindexStatus").innerHTML = "";
      applyReindexUi();
      expect(el("wikiIndexReindexStatus").innerHTML).toContain("rebuilt");
      expect(el("wikiIndexReindex").disabled).toBe(false);

      // Past the TTL, a later render clears the settled rows instead of
      // repainting an old "rebuilt" forever.
      now += REINDEX_SETTLED_TTL_MS + 1;
      applyReindexUi();
      expect(el("wikiIndexReindexStatus").innerHTML).toBe("");
    } finally {
      Date.now = realNow;
    }
  });

  test("a no-collections wiki hides the Index card entirely", async () => {
    routes = [["/api/wiki/index-coverage", { error: "no collections" }]];
    loadIndexCoverage(true);
    await settle();
    expect(el("wikiIndexCard").innerHTML).toBe("");
    expect(el("wikiIndexCard").style.display).toBe("none");
  });
});
