import { test, expect } from "bun:test";
import {
  createRefreshModel,
  markApplied,
  pagesFingerprint,
  receivePages,
  shouldApplyNow,
  shouldRefetch,
  startFetch,
  takePending,
  viewStateOf,
  WIKI_REFETCH_MIN_INTERVAL_MS,
  WIKI_REFETCH_TICK_MS,
  type PagesRefreshModel,
  type WikiPagesResponse,
  type WikiViewState,
} from "./wiki-refresh.ts";
import type { WikiListing } from "./wiki-filter.ts";

function page(name: string): WikiListing {
  return {
    name,
    title: name,
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "concepts/" + name + ".md",
    linkCount: 0,
    backlinkCount: 0,
  };
}

function payload(names: string[], over: Partial<WikiPagesResponse> = {}): WikiPagesResponse {
  return { pages: names.map(page), scannedAt: 1_000, ...over };
}

/** Receive with the sequence bookkeeping done for you — the common shape in these
 *  tests, where only ONE request is in flight at a time. */
function receive(
  model: PagesRefreshModel,
  data: WikiPagesResponse,
  view: WikiViewState,
  fingerprint = JSON.stringify(data),
) {
  const seq = startFetch(model, model.lastFetchAt + WIKI_REFETCH_MIN_INTERVAL_MS);
  return receivePages(model, { data, view, seq, fingerprint });
}

/** Adopt what the caller was told to adopt — the client's `markApplied` call. */
function apply(model: PagesRefreshModel, data: WikiPagesResponse, fingerprint = JSON.stringify(data)) {
  markApplied(model, { data, fingerprint });
}

// ── Constants ─────────────────────────────────────────────────────────

test("the throttle floor is pinned at 30s and the idle tick at 5min", () => {
  // Pinned literally: every throttle test below derives its clock from the
  // constant, so a mutation to 1s would otherwise ship green.
  expect(WIKI_REFETCH_MIN_INTERVAL_MS).toBe(30_000);
  expect(WIKI_REFETCH_TICK_MS).toBe(300_000);
  // The heartbeat must be slower than the floor, or every tick would fire.
  expect(WIKI_REFETCH_TICK_MS).toBeGreaterThan(WIKI_REFETCH_MIN_INTERVAL_MS);
});

// ── Throttle ──────────────────────────────────────────────────────────

test("shouldRefetch allows the very first refetch (no fetch recorded)", () => {
  const model = createRefreshModel();
  // Default `lastFetchAt` is 0, so any real clock reading is far past the window.
  expect(shouldRefetch(model, Date.now())).toBe(true);
});

test("shouldRefetch blocks inside the window and allows exactly at the boundary", () => {
  const model = createRefreshModel();
  startFetch(model, 100_000);
  expect(shouldRefetch(model, 100_000)).toBe(false);
  expect(shouldRefetch(model, 100_000 + WIKI_REFETCH_MIN_INTERVAL_MS - 1)).toBe(false);
  // Boundary is inclusive — exactly one interval later is allowed.
  expect(shouldRefetch(model, 100_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(true);
  expect(shouldRefetch(model, 100_000 + WIKI_REFETCH_MIN_INTERVAL_MS + 1)).toBe(true);
});

test("startFetch stamps the start of the request and hands out rising sequence numbers", () => {
  const model = createRefreshModel();
  expect(startFetch(model, 10_000)).toBe(1);
  expect(shouldRefetch(model, 10_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(true);
  expect(startFetch(model, 10_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(2);
  expect(shouldRefetch(model, 10_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(false);
});

// ── View state ────────────────────────────────────────────────────────

test("viewStateOf: an open page is an article, whatever else is in the DOM", () => {
  expect(viewStateOf("some-page", false, false)).toBe("article");
  // A stale Ask body left in the DOM must not outrank the open page.
  expect(viewStateOf("some-page", false, true)).toBe("article");
});

test("viewStateOf: an in-flight navigation counts as an article before the name lands", () => {
  // The bug this closes: `currentName` is only assigned from the page response, so
  // the whole round-trip would otherwise read as "start" and re-sort mid-click.
  expect(viewStateOf(null, true, false)).toBe("article");
  expect(viewStateOf(null, true, true)).toBe("article");
});

test("viewStateOf: an Ask/Explain answer beats start, and nothing open is start", () => {
  expect(viewStateOf(null, false, true)).toBe("answer");
  expect(viewStateOf(null, false, false)).toBe("start");
});

test("shouldApplyNow is true only on the start view", () => {
  const cases: [WikiViewState, boolean][] = [
    ["start", true],
    ["article", false],
    ["answer", false],
  ];
  for (const [view, expected] of cases) expect(shouldApplyNow(view)).toBe(expected);
});

// ── Apply / defer decision ────────────────────────────────────────────

test("receivePages applies immediately on the start view and stashes nothing", () => {
  const model = createRefreshModel();
  expect(receive(model, payload(["a"]), "start")).toBe("apply");
  expect(model.pending).toBeNull();
});

test("receivePages defers under an open article and stashes the payload", () => {
  const model = createRefreshModel();
  expect(receive(model, payload(["a"]), "article")).toBe("defer");
  expect(model.pending!.data.pages).toHaveLength(1);
});

test("receivePages defers under an Ask/Explain answer too", () => {
  const model = createRefreshModel();
  expect(receive(model, payload(["a"]), "answer")).toBe("defer");
  expect(model.pending).not.toBeNull();
});

test("a newer deferred payload replaces the stale stashed one", () => {
  const model = createRefreshModel();
  receive(model, payload(["a"]), "article");
  receive(model, payload(["a", "b"]), "article");
  expect(takePending(model)!.data.pages).toHaveLength(2);
});

test("an apply clears a previously stashed payload (it is superseded)", () => {
  const model = createRefreshModel();
  receive(model, payload(["a"]), "article");
  expect(receive(model, payload(["a", "b"]), "start")).toBe("apply");
  expect(takePending(model)).toBeNull();
});

// ── Deferred data is applied exactly once ─────────────────────────────

test("takePending returns the stash once, then null", () => {
  const model = createRefreshModel();
  receive(model, payload(["a"]), "article");
  expect(takePending(model)).not.toBeNull();
  expect(takePending(model)).toBeNull();
  expect(takePending(model)).toBeNull();
});

test("takePending on a model that never deferred is a no-op null", () => {
  expect(takePending(createRefreshModel())).toBeNull();
});

// ── Ordering guard (request generations) ──────────────────────────────

test("a response older than one already folded in is dropped", () => {
  const model = createRefreshModel();
  const slow = startFetch(model, 0); // e.g. the boot load
  const fast = startFetch(model, WIKI_REFETCH_MIN_INTERVAL_MS); // a focus refetch

  const fresh = payload(["a", "b"]);
  expect(
    receivePages(model, { data: fresh, view: "start", seq: fast, fingerprint: "fresh" }),
  ).toBe("apply");
  apply(model, fresh, "fresh");

  // The slow one lands afterwards carrying the OLD page set — it must not revert.
  expect(
    receivePages(model, { data: payload(["a"]), view: "start", seq: slow, fingerprint: "stale" }),
  ).toBe("stale");
  expect(model.appliedCount).toBe(2);
  expect(model.appliedKey).toBe("fresh");
});

test("a stale response cannot clobber a stash either", () => {
  const model = createRefreshModel();
  const slow = startFetch(model, 0);
  const fast = startFetch(model, WIKI_REFETCH_MIN_INTERVAL_MS);
  receivePages(model, { data: payload(["a", "b"]), view: "article", seq: fast, fingerprint: "f2" });
  expect(
    receivePages(model, { data: payload(["a"]), view: "article", seq: slow, fingerprint: "f1" }),
  ).toBe("stale");
  expect(takePending(model)!.data.pages).toHaveLength(2);
});

test("responses arriving in issue order are all folded in", () => {
  const model = createRefreshModel();
  const first = startFetch(model, 0);
  const second = startFetch(model, WIKI_REFETCH_MIN_INTERVAL_MS);
  expect(
    receivePages(model, { data: payload(["a"]), view: "start", seq: first, fingerprint: "f1" }),
  ).toBe("apply");
  apply(model, payload(["a"]), "f1");
  expect(
    receivePages(model, { data: payload(["a", "b"]), view: "start", seq: second, fingerprint: "f2" }),
  ).toBe("apply");
});

// ── Zero-page wipe guard ──────────────────────────────────────────────

test("boot may render an empty wiki, a refetch may not wipe a populated one", () => {
  const model = createRefreshModel();
  // Nothing applied yet — an empty set is a legitimately empty wiki.
  expect(receive(model, payload([]), "start")).toBe("apply");
  apply(model, payload(["a", "b", "c"]), "real");
  // A transient mid-checkout scan comes back with zero pages: drop it.
  expect(receive(model, payload([]), "start")).toBe("empty");
  expect(model.appliedCount).toBe(3);
  expect(model.pending).toBeNull();
});

test("an error payload with no pages is dropped even before anything is applied", () => {
  const model = createRefreshModel();
  expect(receive(model, payload([], { error: "wiki directory not found" }), "start")).toBe("empty");
});

test("an error payload that still carries pages is adopted (degraded, not empty)", () => {
  const model = createRefreshModel();
  expect(receive(model, payload(["a"], { error: "partial" }), "start")).toBe("apply");
});

// ── Skip-if-unchanged ─────────────────────────────────────────────────

test("pagesFingerprint neutralises scannedAt and nothing else", () => {
  const a = '{"pages":[{"name":"x"}],"scannedAt":1717000000000}';
  const b = '{"pages":[{"name":"x"}],"scannedAt":1717000999999}';
  const c = '{"pages":[{"name":"y"}],"scannedAt":1717000000000}';
  expect(pagesFingerprint(a)).toBe(pagesFingerprint(b));
  expect(pagesFingerprint(a)).not.toBe(pagesFingerprint(c));
  // A null scan instant is left alone (already stable).
  expect(pagesFingerprint('{"scannedAt":null}')).toBe('{"scannedAt":null}');
});

test("a payload identical to the one on screen is skipped entirely", () => {
  const model = createRefreshModel();
  const data = payload(["a", "b"]);
  apply(model, data, "same");
  const seq = startFetch(model, WIKI_REFETCH_MIN_INTERVAL_MS);
  expect(receivePages(model, { data, view: "start", seq, fingerprint: "same" })).toBe("unchanged");
});

test("an unchanged response retires an older stash (the screen is already right)", () => {
  const model = createRefreshModel();
  const shown = payload(["a", "b"]);
  apply(model, shown, "same");
  receive(model, payload(["a"]), "article", "older"); // deferred
  expect(model.pending).not.toBeNull();
  const seq = startFetch(model, model.lastFetchAt + WIKI_REFETCH_MIN_INTERVAL_MS);
  expect(receivePages(model, { data: shown, view: "article", seq, fingerprint: "same" })).toBe(
    "unchanged",
  );
  expect(model.pending).toBeNull();
});

test("a changed payload is NOT skipped", () => {
  const model = createRefreshModel();
  apply(model, payload(["a"]), "one");
  expect(receive(model, payload(["a", "b"]), "start", "two")).toBe("apply");
});

// ── Boot-success tracking ─────────────────────────────────────────────

test("bootRendered flips only once something has actually been rendered", () => {
  const model = createRefreshModel();
  expect(model.bootRendered).toBe(false);
  // A response arriving does NOT count — only the caller's markApplied does, which
  // is what makes the first successful adopt after a FAILED boot run the full boot
  // render path instead of half-healing beside the error pane.
  receive(model, payload(["a"]), "start");
  expect(model.bootRendered).toBe(false);
  apply(model, payload(["a"]), "f");
  expect(model.bootRendered).toBe(true);
});

// ── Full cycle ────────────────────────────────────────────────────────

test("full cycle: throttled refetch → defer while reading → applied once on return", () => {
  const model = createRefreshModel();
  const bootSeq = startFetch(model, 0); // boot load
  receivePages(model, { data: payload(["a"]), view: "start", seq: bootSeq, fingerprint: "f1" });
  apply(model, payload(["a"]), "f1");

  // Too soon after boot — no refetch.
  expect(shouldRefetch(model, WIKI_REFETCH_MIN_INTERVAL_MS - 1)).toBe(false);

  // Focus after the window: fetch goes out while an article is open.
  const t1 = WIKI_REFETCH_MIN_INTERVAL_MS;
  expect(shouldRefetch(model, t1)).toBe(true);
  const s1 = startFetch(model, t1);
  expect(
    receivePages(model, { data: payload(["a", "b"]), view: "article", seq: s1, fingerprint: "f2" }),
  ).toBe("defer");

  // A second focus a window later brings a fresher set — still reading.
  const t2 = t1 + WIKI_REFETCH_MIN_INTERVAL_MS;
  expect(shouldRefetch(model, t2)).toBe(true);
  const s2 = startFetch(model, t2);
  expect(
    receivePages(model, {
      data: payload(["a", "b", "c"]),
      view: "article",
      seq: s2,
      fingerprint: "f3",
    }),
  ).toBe("defer");

  // Back on the start view: the newest set is adopted, and only once.
  const pending = takePending(model)!;
  expect(pending.data.pages).toHaveLength(3);
  markApplied(model, pending);
  expect(model.appliedKey).toBe("f3");
  expect(takePending(model)).toBeNull();
});
