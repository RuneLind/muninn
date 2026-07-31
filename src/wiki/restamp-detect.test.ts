import { test, expect } from "bun:test";
import {
  detectBulkRestamps,
  RESTAMP_COHORT_MIN_PAGES,
  RESTAMP_SAMPLE_CAP,
  type RestampCandidate,
} from "./restamp-detect.ts";

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(iso + "T12:00:00Z");

/** N pages RESTAMPED to `stamp`: born weeks earlier, no non-sweep commit since. This
 *  is the jarvis 2026-06-10 shape (23 pages first committed 04-09 → 05-30). */
function restamped(n: number, stamp: string, bornIso = "2026-04-09"): RestampCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    relPath: `concepts/Restamped ${i}.md`,
    created: bornIso,
    updated: stamp,
    gitCreatedMs: day(bornIso),
  }));
}

/** N pages BULK-INGESTED on `stamp`: born that day in a sweep, so they carry it as
 *  their stamp and have no non-sweep touch ever. The jarvis 2026-04-25 shape (221
 *  pages) — the false positive the naive predicate fires on forever. */
function bornInSweep(n: number, stamp: string): RestampCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    relPath: `concepts/Ingested ${i}.md`,
    created: stamp,
    updated: stamp,
    gitCreatedMs: day(stamp),
  }));
}

test("fires on a bulk-restamp cohort: stamped today, first committed weeks earlier", () => {
  const cohorts = detectBulkRestamps(restamped(23, "2026-06-10"));
  expect(cohorts).toHaveLength(1);
  expect(cohorts[0]!.day).toBe("2026-06-10");
  expect(cohorts[0]!.count).toBe(23);
  expect(cohorts[0]!.samples).toHaveLength(RESTAMP_SAMPLE_CAP);
  expect(cohorts[0]!.samples[0]).toBe("concepts/Restamped 0.md");
});

test("does NOT fire on a bulk INGEST cohort born on the day it is stamped", () => {
  // The whole point of the lead test. 221 jarvis pages legitimately look like this
  // for 2026-04-25 and a naive "shared day + no touch" predicate warns on them every
  // index build, forever.
  expect(detectBulkRestamps(bornInSweep(300, "2026-04-25"))).toEqual([]);
});

test("does not fire on a cohort committed only a day after its stamp", () => {
  // Writing in the evening and committing after midnight is ordinary, and a 1-day
  // lead would sweep those pages in.
  const nextDay = restamped(50, "2026-06-10", "2026-06-11");
  expect(detectBulkRestamps(nextDay)).toEqual([]);
});

test("a non-sweep commit on or after the stamp day corroborates it and drops the page", () => {
  // git records a real edit that day — the stamp is evidence, not a restamp.
  const corroborated = restamped(50, "2026-06-10").map((p) => ({
    ...p,
    gitTouchedMs: day("2026-06-10"),
  }));
  expect(detectBulkRestamps(corroborated)).toEqual([]);
  // An OLDER non-sweep touch does not explain the stamp, so those pages still count.
  const stale = restamped(50, "2026-06-10").map((p) => ({
    ...p,
    gitTouchedMs: day("2026-05-01"),
  }));
  expect(detectBulkRestamps(stale)[0]?.count).toBe(50);
});

test("pages git has never heard of are skipped, not counted", () => {
  // Without a creation date there is no way to tell a restamp from a birth stamp, and
  // untracked drafts would otherwise join every cohort.
  const untracked = restamped(50, "2026-06-10").map(({ gitCreatedMs: _drop, ...p }) => p);
  expect(detectBulkRestamps(untracked)).toEqual([]);
});

test("a page with no frontmatter stamp at all is skipped", () => {
  const bare: RestampCandidate[] = Array.from({ length: 50 }, (_, i) => ({
    relPath: `plans/p${i}.md`,
    gitCreatedMs: day("2026-04-09"),
  }));
  expect(detectBulkRestamps(bare)).toEqual([]);
});

test("falls back to `created` when there is no `updated` — the same stamp the sort uses", () => {
  const createdOnly = restamped(30, "2026-06-10").map(({ updated, ...p }) => ({
    ...p,
    created: updated,
  }));
  expect(detectBulkRestamps(createdOnly)[0]?.count).toBe(30);
});

test("only days at or above the threshold are reported, oldest first", () => {
  const pages = [
    ...restamped(RESTAMP_COHORT_MIN_PAGES, "2026-07-23"),
    ...restamped(RESTAMP_COHORT_MIN_PAGES - 1, "2026-05-24"),
    ...restamped(RESTAMP_COHORT_MIN_PAGES + 5, "2026-06-10"),
  ];
  expect(detectBulkRestamps(pages).map((c) => `${c.day}:${c.count}`)).toEqual([
    `2026-06-10:${RESTAMP_COHORT_MIN_PAGES + 5}`,
    `2026-07-23:${RESTAMP_COHORT_MIN_PAGES}`,
  ]);
  // The threshold is a parameter, so a smaller wiki can be probed without a rebuild.
  expect(detectBulkRestamps(pages, 1)).toHaveLength(3);
});

test("a mixed wiki reports only the restamped day, not the ingest day it shares pages with", () => {
  // The realistic shape: one wiki holding both cohorts at once.
  const cohorts = detectBulkRestamps([
    ...bornInSweep(221, "2026-04-25"),
    ...restamped(23, "2026-06-10", "2026-04-25"),
  ]);
  expect(cohorts.map((c) => c.day)).toEqual(["2026-06-10"]);
});

test("a stamp carrying a full timestamp is bucketed by its day", () => {
  const pages = restamped(30, "2026-06-10").map((p, i) => ({
    ...p,
    updated: i % 2 === 0 ? "2026-06-10" : "2026-06-10T18:45:00Z",
  }));
  expect(detectBulkRestamps(pages)).toHaveLength(1);
  expect(detectBulkRestamps(pages)[0]!.count).toBe(30);
});

test("an unparseable stamp is skipped rather than bucketed as NaN", () => {
  const junk = restamped(50, "2026-06-10").map((p) => ({ ...p, updated: "last tuesday" }));
  // `created` (2026-04-09) is not used as a fallback here — `updated` is present, it
  // is just garbage — so nothing is counted.
  expect(detectBulkRestamps(junk)).toEqual([]);
});

test("the git creation date is read in LOCAL days, so a late-evening commit isn't off by one", () => {
  // A commit at 23:30 local on the day BEFORE the stamp must stay outside the 2-day
  // lead, whatever the UTC offset does to it.
  const eve = new Date(2026, 5, 9, 23, 30).getTime(); // 9 Jun 23:30 local
  const pages = restamped(50, "2026-06-10").map((p) => ({ ...p, gitCreatedMs: eve }));
  expect(detectBulkRestamps(pages)).toEqual([]);
  // …while a commit two full days earlier is a restamp.
  const twoDays = restamped(50, "2026-06-10").map((p) => ({
    ...p,
    gitCreatedMs: eve - 2 * DAY,
  }));
  expect(detectBulkRestamps(twoDays)[0]?.count).toBe(50);
});
