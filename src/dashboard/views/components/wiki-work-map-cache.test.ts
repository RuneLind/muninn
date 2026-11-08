/**
 * The DOM-free work-map cache the rail reads directly (`wiki-work-map-cache.ts`):
 * one GET per run time, the failed-run latch, the repaint callback, the memo's
 * identity on the listing array, and `adoptIfNewer` as the cache's other write.
 * The module's state lives for the process: each case reads what it compares
 * against at its own start, so it passes alone (`-t`) as well as in order.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { adoptIfNewer, effortHrefFor, getRailMapFailedAt, getWorkMapCache, railEffortsIndex } from "./wiki-work-map-cache.ts";
import { getWorkMapRunAt, setWorkMapRunAt } from "./wiki-shell-state.ts";
import type { WikiFilters, WikiListing } from "./wiki-filter.ts";
import type { WorkMapGetBody } from "./wiki-work-card.ts";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  setWorkMapRunAt(null);
});

const mapAt = (runAtMs: number) =>
  ({
    version: 1, wiki: "w", runAtMs, model: "m",
    coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
    summary: "", needsYou: [], themes: [], loose: [],
    efforts: [{ id: "a", name: "A", aliases: [], oneLine: "", state: "active", pages: [{ id: "plans/a.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] }],
  }) as unknown as NonNullable<WorkMapGetBody["map"]>;
const PAGES = [{ relPath: "plans/a.mdx", name: "a", title: "A", type: "plan" }] as unknown as WikiListing[];
const withWiki = (u: string) => u + "?wiki=w";

let gets: string[] = [];
function serve(answer: () => Response): void {
  gets = [];
  globalThis.fetch = (async (input: unknown) => {
    gets.push(String(input));
    return answer();
  }) as unknown as typeof fetch;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("wiki-work-map-cache", () => {
  test("effortHrefFor carries the facets an article URL carries", () => {
    const filters = { project: "muninn", jira: "DEMO-1" } as unknown as WikiFilters;
    const href = effortHrefFor("w", filters, "drift");
    expect(href).toContain("effort=drift");
    expect(href).toContain("project=muninn");
    expect(href).toContain("jira=DEMO-1");
  });

  test("no listing run time: no index and no GET", () => {
    serve(() => new Response("{}"));
    setWorkMapRunAt(null);
    expect(railEffortsIndex(1, PAGES, withWiki, () => {})).toBeNull();
    expect(gets).toEqual([]);
  });

  test("one GET per run time, a repaint when it lands, then the index memoized on the listing array", async () => {
    serve(() => new Response(JSON.stringify({ map: mapAt(10) }), { status: 200 }));
    setWorkMapRunAt(10);
    let repaints = 0;
    const repaint = () => repaints++;
    expect(railEffortsIndex(1, PAGES, withWiki, repaint)).toBeNull();
    expect(railEffortsIndex(1, PAGES, withWiki, repaint)).toBeNull();
    expect(gets).toEqual(["/api/wiki/work-map?wiki=w"]);
    await settle();
    await settle();
    expect(repaints).toBe(1);
    expect(getWorkMapCache()?.runAt).toBe(10);
    const first = railEffortsIndex(1, PAGES, withWiki, repaint)!;
    expect(first.get("plans/a.mdx")?.id).toBe("a");
    expect(railEffortsIndex(1, PAGES, withWiki, repaint)).toBe(first);
    expect(railEffortsIndex(1, [...PAGES], withWiki, repaint)).not.toBe(first);
    expect(gets.length).toBe(1);
  });

  test("a failed GET latches its run time, repaints once, and is not retried for that run", async () => {
    const cachedBefore = getWorkMapCache();
    serve(() => new Response("{}", { status: 500 }));
    setWorkMapRunAt(20);
    let repaints = 0;
    expect(railEffortsIndex(1, PAGES, withWiki, () => repaints++)).toBeNull();
    await settle();
    await settle();
    expect(repaints).toBe(1);
    expect(getRailMapFailedAt()).toBe(20);
    expect(railEffortsIndex(1, PAGES, withWiki, () => repaints++)).toBeNull();
    expect(gets.length).toBe(1);
    expect(getWorkMapCache()).toBe(cachedBefore);
  });

  test("adoptIfNewer takes only a newer run, as both the run time and the cache", () => {
    const cachedBefore = getWorkMapCache();
    setWorkMapRunAt(200);
    expect(adoptIfNewer({ map: mapAt(200) } as WorkMapGetBody)).toBe(false);
    expect(adoptIfNewer({ map: mapAt(150) } as WorkMapGetBody)).toBe(false);
    expect(getWorkMapRunAt()).toBe(200);
    expect(getWorkMapCache()).toBe(cachedBefore);
    expect(adoptIfNewer({ map: mapAt(300) } as WorkMapGetBody)).toBe(true);
    expect(getWorkMapRunAt()).toBe(300);
    expect(getWorkMapCache()?.runAt).toBe(300);
    setWorkMapRunAt(null);
    expect(adoptIfNewer({ map: mapAt(40) } as WorkMapGetBody)).toBe(false);
  });
});
