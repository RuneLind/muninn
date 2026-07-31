import { test, expect } from "bun:test";
import {
  createRefreshModel,
  markFetched,
  receivePages,
  shouldApplyNow,
  shouldRefetch,
  takePending,
  WIKI_REFETCH_MIN_INTERVAL_MS,
  type WikiViewState,
} from "./wiki-refresh.ts";

// ── Throttle ──────────────────────────────────────────────────────────

test("shouldRefetch allows the very first refetch (no fetch recorded)", () => {
  const model = createRefreshModel<string>();
  // Default `lastFetchAt` is 0, so any real clock reading is far past the window.
  expect(shouldRefetch(model, Date.now())).toBe(true);
});

test("shouldRefetch blocks inside the window and allows exactly at the boundary", () => {
  const model = createRefreshModel<string>();
  markFetched(model, 100_000);
  expect(shouldRefetch(model, 100_000)).toBe(false);
  expect(shouldRefetch(model, 100_000 + WIKI_REFETCH_MIN_INTERVAL_MS - 1)).toBe(false);
  // Boundary is inclusive — exactly one interval later is allowed.
  expect(shouldRefetch(model, 100_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(true);
  expect(shouldRefetch(model, 100_000 + WIKI_REFETCH_MIN_INTERVAL_MS + 1)).toBe(true);
});

test("shouldRefetch honors an explicit interval override", () => {
  const model = createRefreshModel<string>();
  markFetched(model, 0);
  expect(shouldRefetch(model, 500, 1_000)).toBe(false);
  expect(shouldRefetch(model, 1_000, 1_000)).toBe(true);
});

test("markFetched stamps the start of the request, re-arming the throttle", () => {
  const model = createRefreshModel<string>();
  markFetched(model, 10_000);
  expect(shouldRefetch(model, 10_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(true);
  markFetched(model, 10_000 + WIKI_REFETCH_MIN_INTERVAL_MS);
  expect(shouldRefetch(model, 10_000 + WIKI_REFETCH_MIN_INTERVAL_MS)).toBe(false);
});

// ── Apply / defer decision ────────────────────────────────────────────

test("shouldApplyNow is true only on the start view", () => {
  const cases: [WikiViewState, boolean][] = [
    ["start", true],
    ["article", false],
    ["answer", false],
  ];
  for (const [view, expected] of cases) expect(shouldApplyNow(view)).toBe(expected);
});

test("receivePages applies immediately on the start view and stashes nothing", () => {
  const model = createRefreshModel<string>();
  expect(receivePages(model, "fresh", "start")).toBe("apply");
  expect(model.pending).toBeNull();
});

test("receivePages defers under an open article and stashes the payload", () => {
  const model = createRefreshModel<string>();
  expect(receivePages(model, "fresh", "article")).toBe("defer");
  expect(model.pending).toBe("fresh");
});

test("receivePages defers under an Ask/Explain answer too", () => {
  const model = createRefreshModel<string>();
  expect(receivePages(model, "fresh", "answer")).toBe("defer");
  expect(model.pending).toBe("fresh");
});

test("a newer deferred payload replaces the stale stashed one", () => {
  const model = createRefreshModel<string>();
  receivePages(model, "first", "article");
  receivePages(model, "second", "article");
  expect(model.pending).toBe("second");
  expect(takePending(model)).toBe("second");
});

test("an apply clears a previously stashed payload (it is superseded)", () => {
  const model = createRefreshModel<string>();
  receivePages(model, "stale", "article");
  expect(receivePages(model, "fresh", "start")).toBe("apply");
  expect(takePending(model)).toBeNull();
});

// ── Deferred data is applied exactly once ─────────────────────────────

test("takePending returns the stash once, then null", () => {
  const model = createRefreshModel<string>();
  receivePages(model, "fresh", "article");
  expect(takePending(model)).toBe("fresh");
  expect(takePending(model)).toBeNull();
  expect(takePending(model)).toBeNull();
});

test("takePending on a model that never deferred is a no-op null", () => {
  const model = createRefreshModel<string>();
  expect(takePending(model)).toBeNull();
});

test("full cycle: throttled refetch → defer while reading → applied once on return", () => {
  const model = createRefreshModel<{ pages: number[] }>();
  markFetched(model, 0); // boot load

  // Too soon after boot — no refetch.
  expect(shouldRefetch(model, WIKI_REFETCH_MIN_INTERVAL_MS - 1)).toBe(false);

  // Focus after the window: fetch goes out while an article is open.
  const t1 = WIKI_REFETCH_MIN_INTERVAL_MS;
  expect(shouldRefetch(model, t1)).toBe(true);
  markFetched(model, t1);
  expect(receivePages(model, { pages: [1] }, "article")).toBe("defer");

  // A second focus a window later brings a fresher set — still reading.
  const t2 = t1 + WIKI_REFETCH_MIN_INTERVAL_MS;
  expect(shouldRefetch(model, t2)).toBe(true);
  markFetched(model, t2);
  expect(receivePages(model, { pages: [1, 2] }, "article")).toBe("defer");

  // Back on the start view: the newest set is adopted, and only once.
  expect(takePending(model)).toEqual({ pages: [1, 2] });
  expect(takePending(model)).toBeNull();
});
