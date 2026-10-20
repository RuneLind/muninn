/**
 * Class check on the client's series-write tracking (PR 727, fix round 3).
 *
 * Every state the tracking can be in, one row each: what a base read started
 * in that state answers, whether a write sent from it is refused, and that the
 * in-flight set is empty again once every sequence has settled. A hung request
 * or a hung wait must end in a recoverable answer within the bound, never in a
 * read that waits forever (which left both ⋯ popovers stuck "Saving…").
 *
 * The in-flight set is module state shared with every other file in this
 * process, so each row settles its own writes before it returns.
 */

import { describe, expect, test } from "bun:test";
import * as sw from "./wiki-series-write.ts";
import type { OpenPageAtLoad, SeriesPostAnswer, SeriesPoster } from "./wiki-series-write.ts";

/** A short bound for the rows, so a hang is measured in milliseconds. */
const BOUND = 40;
/** The per-test ceiling: a row whose wait never ends fails here, by timeout. */
const CEILING = 1_500;

const OPEN = "plans/open.md";
const ok = (hash: string): SeriesPostAnswer => ({ ok: true, status: 200, body: { hash, written: true } });

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A page on disk, the hash the reader loaded it with, and a write sequence
 *  shaped like the callers': the POST moves the bytes, its answer moves the
 *  loaded hash (`adoptOwnSeriesHashes`). */
function world() {
  const w = { disk: "h0", loaded: "h0" };
  const openNow = (): OpenPageAtLoad => ({ relPath: OPEN, loadedHash: w.loaded });
  const hashOf = async () => w.disk;
  /** Track one sequence whose POST is answered by `answer` once `gate` opens. */
  const write = (answer: () => Promise<SeriesPostAnswer>) =>
    sw.trackSeriesWrite(async () => {
      const out = await sw.writeSeriesUnlessOpenChanged({
        writes: [{ relPath: OPEN, series: "k" }],
        bases: new Map([[OPEN, w.disk]]),
        open: openNow(),
        post: async () => {
          const a = await answer();
          if (a.ok) w.disk = a.body?.hash ?? w.disk;
          return a;
        },
      });
      if (out.refusal === null) for (const [, h] of out.run.hashes) w.loaded = h;
      return out;
    });
  return { w, openNow, hashOf, write };
}

/** How a sequence in flight ends, and what a read started meanwhile answers. */
const SETTLES: { name: string; answer: () => Promise<SeriesPostAnswer>; adopted: string }[] = [
  { name: "resolves ok", answer: async () => ok("h1"), adopted: "h1" },
  { name: "resolves 409", answer: async () => ({ ok: false, status: 409, body: { error: "changed" } }), adopted: "h0" },
  { name: "resolves refused", answer: async () => ({ ok: false, status: 403, body: { error: "read-only" } }), adopted: "h0" },
  { name: "network error", answer: async () => Promise.reject(new TypeError("Failed to fetch")), adopted: "h0" },
];

describe("series-write tracking: every state ends in an answer", () => {
  test("no write in flight: the read starts at once and is not stalled", async () => {
    const { openNow, hashOf } = world();
    const out = await sw.readSeriesBasesAfterWrites([OPEN], hashOf, openNow, { waitMs: BOUND });
    expect(out.stalled).toBe(false);
    expect(out.bases.get(OPEN)).toBe("h0");
    expect(sw.openPageChanged(out.open, out.bases)).toBeNull();
    expect(sw.seriesWritesInFlight()).toBe(0);
  }, CEILING);

  for (const row of SETTLES) {
    test(`a write in flight that ${row.name}: the read waits for it, blames nobody, and the set empties`, async () => {
      const { w, openNow, hashOf, write } = world();
      const gate = deferred();
      const seq = write(async () => (await gate.promise, row.answer()));
      let out: Awaited<ReturnType<typeof sw.readSeriesBasesAfterWrites>>;
      try {
        expect(sw.seriesWritesInFlight()).toBe(1);
        // A second menu opened while the first write is in flight.
        const read = sw.readSeriesBasesAfterWrites([OPEN], hashOf, openNow, { waitMs: CEILING });
        gate.resolve();
        await seq;
        out = await read;
      } finally {
        // Settle the sequence whatever failed above: the set is shared.
        gate.resolve();
        await seq;
      }
      expect(out.stalled).toBe(false);
      expect(out.open.loadedHash).toBe(row.adopted);
      expect(out.bases.get(OPEN)).toBe(w.disk);
      // The reader's own write is never reported as a change since they opened it.
      expect(sw.openPageChanged(out.open, out.bases)).toBeNull();
      expect(sw.seriesWritesInFlight()).toBe(0);
    }, CEILING);
  }

  test("a write that hangs past the bound: the read gives up as stalled, and a write from it is refused before any POST", async () => {
    const { openNow, hashOf, write } = world();
    const hang = deferred<SeriesPostAnswer>();
    const seq = write(() => hang.promise);
    // A safety release, so a wait with no bound still ends and the shared set
    // empties: the elapsed assertion is what reports the missing bound.
    const safety = setTimeout(() => hang.resolve(ok("late")), CEILING * 0.6);
    try {
      const started = Date.now();
      const out = await sw.readSeriesBasesAfterWrites([OPEN], hashOf, openNow, { waitMs: BOUND });
      expect(Date.now() - started).toBeLessThan(CEILING / 2);
      expect(out.stalled).toBe(true);
      // Fail closed even for a caller that ignores the flag: no base to send.
      expect(out.bases.size).toBe(0);
      expect(out.missing).toEqual([OPEN]);
      const posted: string[] = [];
      const r = await sw.writeSeriesUnlessOpenChanged({
        writes: [{ relPath: OPEN, series: "k" }],
        bases: out.bases,
        open: out.open,
        post: async (b) => (posted.push(b.relPath), ok("x")),
        stalled: out.stalled,
      });
      expect(r.refusal).toBe(sw.SERIES_STALLED_COPY);
      expect(posted).toEqual([]);
    } finally {
      clearTimeout(safety);
      hang.resolve(ok("late"));
      await seq;
    }
  }, CEILING);

  test("a write that settles after the wait gave up: the stalled answer stands, and the set does not keep it", async () => {
    const { openNow, hashOf, write } = world();
    const hang = deferred<SeriesPostAnswer>();
    const seq = write(() => hang.promise);
    const safety = setTimeout(() => hang.resolve(ok("h1")), CEILING * 0.6);
    const out = await sw.readSeriesBasesAfterWrites([OPEN], hashOf, openNow, { waitMs: BOUND });
    clearTimeout(safety);
    expect(out.stalled).toBe(true);
    expect(sw.seriesWritesInFlight()).toBe(1);
    hang.resolve(ok("h1"));
    await seq;
    expect(out).toMatchObject({ stalled: true, missing: [OPEN] });
    expect(out.bases.size).toBe(0);
    expect(sw.seriesWritesInFlight()).toBe(0);
    // And the next read is not held by a sequence that has already settled.
    const next = await sw.readSeriesBasesAfterWrites([OPEN], hashOf, openNow, { waitMs: BOUND });
    expect(next.stalled).toBe(false);
    expect(next.open.loadedHash).toBe("h1");
  }, CEILING);

  test("a sequence that throws leaves the set too", async () => {
    const seq = sw.trackSeriesWrite(async () => {
      throw new Error("adopt failed");
    });
    await expect(seq).rejects.toThrow("adopt failed");
    expect(sw.seriesWritesInFlight()).toBe(0);
  }, CEILING);

  test("the open-page snapshot is taken after the writes settle and BEFORE the base fetch", async () => {
    const { w, hashOf } = world();
    const calls: string[] = [];
    const out = await sw.readSeriesBasesAfterWrites(
      [OPEN],
      async (rel) => {
        calls.push("fetch");
        // The page moves while the base read is on the wire (another tab).
        w.loaded = "moved-during-fetch";
        return hashOf();
      },
      () => (calls.push("snapshot"), { relPath: OPEN, loadedHash: w.loaded }),
      { waitMs: BOUND },
    );
    expect(calls).toEqual(["snapshot", "fetch"]);
    expect(out.open.loadedHash).toBe("h0");
  }, CEILING);
});

/** A fetch that answers per `mode`, and on a hang rejects only when its
 *  signal aborts — what a browser does with `AbortSignal.timeout`. */
function fakeFetch(mode: "ok" | "error" | "bad-json" | "hang", body: unknown = { hash: "h-base" }) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f = (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    if (mode === "error") return Promise.reject(new TypeError("Failed to fetch"));
    if (mode === "hang") {
      return new Promise((_, reject) => {
        const s = init?.signal;
        if (!s) return;
        s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    }
    return Promise.resolve(new Response(mode === "bad-json" ? "<html>" : JSON.stringify(body), { status: 200 }));
  };
  return { f, seen };
}

describe("the series requests carry the bound", () => {
  test("base GET: ok answers the hash; an error, an unreadable body or a hang past the bound answers no base", async () => {
    const url = (rel: string) => `/api/wiki/page?relPath=${encodeURIComponent(rel)}`;
    for (const [mode, want] of [["ok", "h-base"], ["error", null], ["bad-json", null], ["hang", null]] as const) {
      const { f, seen } = fakeFetch(mode);
      const read = sw.seriesBaseReader(url, { fetch: f, timeoutMs: BOUND });
      const started = Date.now();
      expect(await read(OPEN)).toBe(want);
      expect(Date.now() - started).toBeLessThan(CEILING / 2);
      expect(seen[0]!.url).toBe(url(OPEN));
      expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    }
  }, CEILING);

  test("base GET hung: loadSeriesBaseMap names the page missing, so nothing is written", async () => {
    const { f } = fakeFetch("hang");
    const r = await sw.loadSeriesBaseMap([OPEN], sw.seriesBaseReader(() => "/x", { fetch: f, timeoutMs: BOUND }));
    expect(r.missing).toEqual([OPEN]);
  }, CEILING);

  test("POST: the wiki rides the body, and the answer is read as the loop reads it", async () => {
    const { f, seen } = fakeFetch("ok", { hash: "n", written: true });
    const post: SeriesPoster = sw.seriesPoster("mimir", { fetch: f, timeoutMs: BOUND });
    const a = await post({ relPath: OPEN, series: "k", baseHash: "b" });
    expect(a).toEqual({ ok: true, status: 200, body: { hash: "n", written: true } });
    expect(seen[0]!.url).toBe("/api/wiki/series");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ wiki: "mimir", relPath: OPEN, series: "k", baseHash: "b" });
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  }, CEILING);

  test("POST hung past the bound: the sequence stops there with copy that says what happened and what to do", async () => {
    const { f } = fakeFetch("hang");
    const posted: string[] = [];
    const inner = sw.seriesPoster("mimir", { fetch: f, timeoutMs: BOUND });
    const started = Date.now();
    const r = await sw.writeSeriesUnlessOpenChanged({
      writes: [{ relPath: "plans/a.md", series: "k" }, { relPath: "plans/b.md", series: "k" }],
      bases: new Map([["plans/a.md", "a"], ["plans/b.md", "b"]]),
      open: { relPath: null, loadedHash: null },
      post: (b) => (posted.push(b.relPath), inner(b)),
    });
    expect(Date.now() - started).toBeLessThan(CEILING / 2);
    expect(posted).toEqual(["plans/a.md"]);
    expect(r.run).toMatchObject({ written: 0, total: 2, failure: { status: 0, error: sw.seriesTimeoutCopy("plans/a.md") } });
    expect(sw.seriesTimeoutCopy("plans/a.md")).toBe(
      `No answer for plans/a.md after ${sw.SERIES_REQUEST_TIMEOUT_MS / 1000} s — it may have been written; reload the page to see`,
    );
  }, CEILING);

  test("one bound for the requests and the wait", () => {
    expect(sw.SERIES_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(sw.SERIES_STALLED_COPY).toBe(
      "An earlier series save has not answered yet — nothing written. Close and reopen this menu in a moment, or reload the page",
    );
  });
});

describe("the listing refresh after a write is bounded too", () => {
  test("a refresh that hangs answers the fallback within the bound; one that answers in time is passed through", async () => {
    const started = Date.now();
    expect(await sw.withinSeriesBound(new Promise<string>(() => {}), "error", BOUND)).toBe("error");
    expect(Date.now() - started).toBeLessThan(CEILING / 2);
    expect(await sw.withinSeriesBound(Promise.resolve("apply"), "error", BOUND)).toBe("apply");
  }, CEILING);
});
