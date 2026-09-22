/**
 * Acceptance 7 — the pair that keeps a NETWORK field out of a write decision
 * without letting the display half pass vacuously.
 *
 * `workedMs` comes off a memo that is absent on a cold boot and on an
 * unreachable claude-usage. `src/wiki/lint-series.ts` picks a series HEAD with
 * `seriesHead`/`newestSeriesPlan` and the gardener writes `series_label:` onto
 * whichever page that answered; `src/wiki/related.ts` orders the Related-work
 * panel with `bySeriesDateDesc`. If either read the worked date, two lint runs
 * over one corpus could propose two different heads and one Accept would write
 * different bytes.
 *
 * So: the SAME wiki, built twice — once plain, once with a worked date stamped
 * on every page that DISAGREES with its `status_date` as hard as it can — and
 *
 *   1. every lint finding and every `computeRelated` row must be byte-identical,
 *   2. the three DISPLAY surfaces must move, or (1) proves nothing.
 *
 * Driven against a REAL `buildWikiIndex` for `related.test.ts`'s reason: the
 * rules read `outgoing`/`backlinks`/`prRefs`, which the index BUILDS.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex, type WikiIndex, type WikiPageMeta } from "./store.ts";
import { lintWiki } from "./lint.ts";
import { computeRelated } from "./related.ts";
import {
  groupSeries,
  seriesMembersOf,
} from "../dashboard/views/components/wiki-groups.ts";
import type { WikiListing } from "../dashboard/views/components/wiki-filter.ts";

/** A page in one series, with a body that links and names PRs. */
function page(
  title: string,
  opts: { date: string; series: string; label?: string; plan?: boolean },
  body: string,
): string {
  return [
    "---",
    `title: ${title}`,
    `status_date: ${opts.date}`,
    // MIRRORED onto `updated`, because the two chains read different keys: the
    // IDENTITY chain (seriesDateSignal) reads status_date, while the DISPLAY
    // chain (workedDateSignal) reads the rail's own update signal. Without both
    // the display half of this file would order on nothing but the relPath.
    `updated: ${opts.date}`,
    `series: ${opts.series}`,
    ...(opts.label ? [`series_label: ${opts.label}`] : []),
    ...(opts.plan ? ["plan_status: in-flight"] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * The fixture, three members of one series plus two unrelated pages so the lint
 * has something to cluster and `related` something to cut.
 *
 * The `status_date`s run OLDEST-first down the list and the worked dates below
 * run NEWEST-first, so every identity the two chains could disagree about does.
 */
const PAGES: Array<[string, string]> = [
  [
    "plans/head.md",
    page(
      "Head",
      // The label is deliberately NOT the bare key: with `label: "Alpha"` a
      // mutation picking `sorted[0]` as the head passed every case in this file,
      // because `blogs/tail.md` spells its own key `Alpha` and `groupSeries`
      // falls a label-less head back to `seriesKeyOf(head)` — the same string.
      { date: "2026-07-02", series: "alpha", label: "Alpha campaign", plan: true },
      "Links [[mid]] and names https://github.com/RuneLind/muninn/pull/549.",
    ),
  ],
  [
    // A SECOND labelled member — lint 8.3(b), whose fix removes every label but
    // `seriesHead`'s. That is the write-deciding head choice, in one finding.
    "plans/mid.md",
    page(
      "Mid",
      { date: "2026-08-15", series: "alpha", label: "Alpha (mid)", plan: true },
      "Links [[head]] and muninn#549.",
    ),
  ],
  [
    // A CASE VARIANT of the key — lint 8.3(a), whose fix normalises every member
    // to the head's own spelling.
    "blogs/tail.md",
    page("Tail", { date: "2026-09-21", series: "Alpha" }, "About [[head]] and [[mid]]."),
  ],
  [
    // Deliberately ABSENT from WORKED below: the ordinary case (every write to
    // it was discounted as a bulk pass), so the fold interleaves a covered and
    // an uncovered member and identity has to hold across both.
    "plans/extra.md",
    page("Extra", { date: "2026-08-01", series: "alpha" }, "Also about [[head]]."),
  ],
  ["plans/other.md", page("Other", { date: "2026-09-01", series: "beta" }, "Alone.")],
  ["plans/second.md", page("Second", { date: "2026-09-02", series: "beta" }, "Also alone.")],
];

/** Worked dates, deliberately the REVERSE of the status_date order. */
const WORKED: Record<string, number> = {
  "plans/head.md": Date.parse("2026-09-21T10:00:00Z"),
  "plans/mid.md": Date.parse("2026-09-10T10:00:00Z"),
  "blogs/tail.md": Date.parse("2026-07-02T10:00:00Z"),
  "plans/other.md": Date.parse("2026-09-20T10:00:00Z"),
  "plans/second.md": Date.parse("2026-06-01T10:00:00Z"),
};

let root: string;
let plain: WikiIndex;
let worked: WikiIndex;

/** The same index with `workedMs` stamped — exactly what the store's post-pass
 *  does when a memo is warm. Rebuilt rather than mutated, so the two runs share
 *  no object. */
async function buildStamped(): Promise<WikiIndex> {
  const index = await buildWikiIndex(root);
  for (const p of index.pages) {
    const ms = WORKED[p.relPath];
    if (ms !== undefined) p.workedMs = ms;
  }
  return index;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "worked-invariant-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await mkdir(path.join(root, "blogs"), { recursive: true });
  for (const [rel, body] of PAGES) await writeFile(path.join(root, rel), body, "utf8");
  // BACKDATE every mtime. This wiki is not a git repo, so `updatedSignal` trusts
  // mtime unconditionally and takes the MAX of it and the frontmatter date — and
  // a file written a millisecond ago gives every page the same "now", which
  // collapses the display order onto the relPath and makes the two halves of
  // this file assert nothing. `e2e/settled-wiki.ts` exists for the same reason.
  const settled = new Date("2020-01-01T00:00:00Z");
  for (const [rel] of PAGES) await utimes(path.join(root, rel), settled, settled);
  plain = await buildWikiIndex(root);
  worked = await buildStamped();
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const NOW = () => Date.parse("2026-09-22T12:00:00Z");

describe("worked never decides a write", () => {
  test("every lint finding is byte-identical with workedMs present and absent", async () => {
    const a = await lintWiki(plain, { now: NOW });
    const b = await lintWiki(worked, { now: NOW });
    // JSON, not a field-by-field compare: the fix payload is what an Accept
    // writes, and a difference anywhere inside it is a difference in the bytes.
    expect(JSON.stringify(b.findings)).toBe(JSON.stringify(a.findings));
    // …and the fixture really does exercise check 8, or this passes on nothing.
    expect(a.findings.some((f) => f.check.startsWith("series-"))).toBe(true);
  });

  test("Related work is byte-identical too", () => {
    for (const [rel] of PAGES) {
      expect(JSON.stringify(computeRelated(worked, rel))).toBe(
        JSON.stringify(computeRelated(plain, rel)),
      );
    }
    // Non-vacuous: the page under test really has related rows.
    expect(computeRelated(plain, "plans/head.md").length).toBeGreaterThan(0);
  });

  test("the series HEAD and the newest plan are unmoved", () => {
    const g = (index: WikiIndex) =>
      groupSeries(index.pages as unknown as WikiListing[], undefined, NOW()).find(
        (x) => x.key === "series:alpha",
      )!;
    expect(g(worked).label).toBe(g(plain).label);
    expect(g(worked).latestRel).toBe(g(plain).latestRel);
    // …and the label really is the one the HEAD wrote, so the assertion above is
    // about the head choice rather than about a key two pages happen to share.
    expect(g(plain).label).toBe("Alpha (mid)");
  });

  // `head` is the series editor's WRITE target (`headRel`) and the page
  // `lint-series.ts` proposes a `series_label:` on, so it is asserted by name
  // rather than only through the label the group reads off it.
  test("seriesMembersOf's HEAD — the write target — is the same page either way", () => {
    const head = (index: WikiIndex) =>
      seriesMembersOf(index.pages as unknown as WikiListing[], "alpha", NOW()).head?.relPath;
    expect(head(worked)).toBe(head(plain));
    expect(head(plain)).toBe("plans/mid.md");
  });
});

describe("…and the display half DOES move", () => {
  test("the fold's member order is worked-first, covered and uncovered together", () => {
    const g = (index: WikiIndex) =>
      groupSeries(index.pages as unknown as WikiListing[], undefined, NOW())
        .find((x) => x.key === "series:alpha")!
        .members.map((m) => m.relPath);
    expect(g(plain)).toEqual([
      "blogs/tail.md",
      "plans/mid.md",
      "plans/extra.md",
      "plans/head.md",
    ]);
    // `plans/extra.md` has NO worked date and keeps its own place by its update
    // date, between two covered members — mixed coverage, not all-or-nothing.
    expect(g(worked)).toEqual([
      "plans/head.md",
      "plans/mid.md",
      "plans/extra.md",
      "blogs/tail.md",
    ]);
  });

  test("the reader strip's set is the fold's own order, so it moves with it", () => {
    const strip = (index: WikiIndex) =>
      seriesMembersOf(index.pages as unknown as WikiListing[], "alpha", NOW()).members.map(
        (m) => m.relPath,
      );
    const fold = groupSeries(worked.pages as unknown as WikiListing[], undefined, NOW())
      .find((x) => x.key === "series:alpha")!
      .members.map((m) => m.relPath);
    expect(strip(worked)).toEqual(fold);
    expect(strip(worked)).not.toEqual(strip(plain));
  });
});

describe("the store's fold", () => {
  test("stamps nothing when no memo is warm — the plain build is untouched", () => {
    expect(plain.pages.every((p: WikiPageMeta) => p.workedMs === undefined)).toBe(true);
    expect(plain.workedCoverage).toBeUndefined();
  });
});
