/**
 * When the Your work card asks GitHub again: the real `mountStartCards` path over
 * a DOM shim, with a fake clock and hand-fired retry timers. A mount is what a
 * Hubs or Timeline click does (`switchStartTab` → `renderStart`).
 *
 * The cards' module state outlives a test (and a file, in one `bun test` process),
 * so each test leaves the slot through a null `runAt`, which drops what a card held.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WORK_MAP_VERSION } from "../../../wiki/work-map/schema.ts";
import type { WorkMapChecksBody } from "../../../wiki/work-map/gh-check.ts";
import { initStartCards, mountStartCards } from "./wiki-start-cards.ts";

const T0 = Date.parse("2026-11-02T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MAP = {
  version: WORK_MAP_VERSION,
  wiki: "w",
  runAtMs: T0 - HOUR,
  model: "m",
  coverage: { sessionsSinceMs: T0, sessionsAsOfMs: T0, touchWindowDays: 28, activePages: 1, threads: 1, logEntries: 0, digestChars: 0, warnings: [] },
  summary: "",
  needsYou: [],
  themes: [],
  efforts: [],
  loose: [],
};

const body = (over: Partial<WorkMapChecksBody> = {}): WorkMapChecksBody => ({ at: T0, checked: 3, compared: 0, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [], ...over });

let now = T0;
let fetches = 0;
let answer: () => Promise<unknown>;
let timers: (() => void)[] = [];
let runAt: number | null = MAP.runAtMs;
const card = { innerHTML: "", style: { display: "none" } };

const saved = { date: Date.now, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, document: (globalThis as { document?: unknown }).document };

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
/** One start view. */
const view = async () => {
  mountStartCards();
  await settle();
};
const fireRetry = async () => {
  now += 15_000;
  expect(timers.length).toBe(1);
  timers.shift()!();
  await settle();
};
const cell = () => /<button[^>]*data-wm-cell="github"[\s\S]*?<\/button>/.exec(card.innerHTML)?.[0] ?? "";

beforeEach(async () => {
  now = T0;
  fetches = 0;
  timers = [];
  card.innerHTML = "";
  Date.now = () => now;
  (globalThis as { document?: unknown }).document = { getElementById: (id: string) => (id === "wikiWorkCard" ? card : null) };
  globalThis.fetch = ((url: string) => {
    // The Decisions section's own GETs (wiki-work-inbox.ts): out of scope here, and not a checks fetch.
    if (url.includes("/api/wiki/decision-inbox") || url.includes("/api/wiki/decision-triage/")) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    fetches++;
    expect(url).toContain("/api/wiki/work-map/checks");
    return answer();
  }) as unknown as typeof fetch;
  globalThis.setTimeout = ((fn: () => void) => {
    timers.push(fn);
    return 1;
  }) as unknown as typeof setTimeout;
  initStartCards({
    withWiki: (u) => u,
    resolvePageName: () => null,
    workMapRunAt: () => runAt,
    fetchWorkMap: async () => ({ ok: true, status: 200, body: { map: MAP, organizable: false } }),
    pages: () => [],
    waitsCounted: () => true,
  });
  // Leave the slot, so this test's first view is a first view.
  runAt = null;
  await view();
  runAt = MAP.runAtMs;
});

afterEach(() => {
  Date.now = saved.date;
  globalThis.fetch = saved.fetch;
  globalThis.setTimeout = saved.setTimeout;
  (globalThis as { document?: unknown }).document = saved.document;
});

const ok = (b: WorkMapChecksBody) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });

describe("an answer that needs asking again", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["a row left unchecked", ok(body({ unchecked: 1, uncheckedRows: [{ page: "plans/a.mdx", pr: 1, repo: "acme/x" }] }))],
    ["a remedy", ok(body({ notChecked: { reason: "no-access", repos: ["acme/gone"] } }))],
    ["a failed fetch", () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })],
    ["a fetch that threw", () => Promise.reject(new Error("offline"))],
  ];

  test.each(cases)("%s: four tab clicks inside the minute fetch nothing, and one after it fetches once", async (_name, a) => {
    answer = a;
    await view();
    expect(fetches).toBe(1);
    for (let i = 0; i < 4; i++) {
      now += 10_000;
      await view();
    }
    expect(fetches).toBe(1);
    now = T0 + MINUTE - 1;
    await view();
    expect(fetches).toBe(1);
    now = T0 + MINUTE;
    await view();
    expect(fetches).toBe(2);
    // The bound counts from that fetch, not from the first.
    now += 59_000;
    await view();
    expect(fetches).toBe(2);
    now += 1_000;
    await view();
    expect(fetches).toBe(3);
  });

  test("a repaint with no start view does not ask", async () => {
    answer = ok(body({ unchecked: 1 }));
    await view();
    now += 2 * MINUTE;
    expect(fetches).toBe(1);
    expect(timers.length).toBe(0);
  });
});

describe("a good answer", () => {
  test("stands for its hour, however many views mount", async () => {
    answer = ok(body());
    await view();
    for (let i = 0; i < 4; i++) {
      now += 10 * MINUTE;
      await view();
    }
    expect(fetches).toBe(1);
    now = T0 + HOUR - 1;
    await view();
    expect(fetches).toBe(1);
    now = T0 + HOUR;
    await view();
    expect(fetches).toBe(2);
  });
});

describe("a `gh` that hangs over states it already has", () => {
  const hung = body({ refreshing: true, contradictions: [{ page: "plans/a.mdx", pr: 1, repo: "acme/x", rowState: "open", ghState: "MERGED", mergedAt: null }] });

  test("three more fetches, then the count reads muted and «not refreshed»", async () => {
    answer = ok(hung);
    await view();
    expect(cell()).toContain("refreshing");
    expect(cell()).toMatch(/class="wiki-wm-cell bad/);
    for (const n of [2, 3, 4]) {
      await fireRetry();
      expect(fetches).toBe(n);
    }
    expect(timers.length).toBe(0);
    expect(cell()).not.toContain("refreshing");
    expect(cell()).toContain("not refreshed");
    expect(cell()).toContain("<b>1</b>");
    expect(cell()).toMatch(/class="wiki-wm-cell muted/);
    expect(cell()).not.toMatch(/\bbad\b/);
  });

  test("the next start view after the minute asks again, and one inside it does not", async () => {
    answer = ok(hung);
    await view();
    for (let i = 0; i < 3; i++) await fireRetry();
    const lastStarted = now;
    await view();
    now = lastStarted + MINUTE - 1;
    await view();
    expect(fetches).toBe(4);
    now = lastStarted + MINUTE;
    await view();
    expect(fetches).toBe(5);
    // A new round of its own, with its three more fetches.
    expect(timers.length).toBe(1);
  });

  test("a tab click during the retries adds no fetch", async () => {
    answer = ok(hung);
    await view();
    await view();
    await fireRetry();
    await view();
    expect(fetches).toBe(2);
    expect(timers.length).toBe(1);
  });

  test("an answer that settles ends it: the plain count, and the hour's rule", async () => {
    let n = 0;
    answer = () => ok(++n === 1 ? hung : body({ contradictions: hung.contradictions }))();
    await view();
    await fireRetry();
    expect(cell()).not.toContain("not refreshed");
    expect(cell()).toMatch(/class="wiki-wm-cell bad/);
    now += 2 * MINUTE;
    await view();
    expect(fetches).toBe(2);
  });
});
