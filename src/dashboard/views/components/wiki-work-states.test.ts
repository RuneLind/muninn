/**
 * The state table of plan `muninn-wiki-work-threads` («Page states and the
 * Worked-on key», D22), row by row and per winning term. Every page's `work`
 * comes from `computeWorkFocus` over a synthetic session set, never written by
 * hand, so a case is a statement about what the server ships and what the
 * client does with it. Behaviour outside these rows is a bug (D22).
 *
 * Columns asserted per case: the state, the sort instant, the shown instant,
 * the touched mark, the Activity score's winning term (kind + `worked`) and
 * the row age (`ageMs` from the winning term).
 */
import { describe, expect, test } from "bun:test";
import { computeWorkFocus, type WorkPageInput, type WorkSession, type WorkSessionFile } from "../../../wiki/work-focus.ts";
import {
  ACTIVITY_ROWS_MAX,
  DEFAULT_ACTIVITY_WEIGHTS,
  rankActivity,
  type ActivityRow,
  type ActivityWeights,
  type WorkedGate,
} from "./wiki-activity-rank.ts";
import {
  localDay,
  pageAddedMs,
  pageHeaderDates,
  workedAxisSource,
  workedChip,
  workedShownSignal,
  workedSignal,
  workedSortMs,
  type WikiListing,
} from "./wiki-filter.ts";

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 15, 8, 0);
const SINCE = NOW - 8 * DAY;
const ago = (h: number) => NOW - h * H;

const OPEN: WorkedGate = { open: true, candidates: 1, covered: 1, coverage: 1 };
const SHUT: WorkedGate = { open: false, candidates: 10, covered: 1, coverage: 0.1 };
const wide: ActivityWeights = { ...DEFAULT_ACTIVITY_WEIGHTS, rows: ACTIVITY_ROWS_MAX };

/** One page's dates as the listing carries them, and its work-focus input. */
interface Fixture {
  rel: string;
  /** Git creation (hours ago); absent ⇒ no git history. */
  createdH?: number;
  /** Newest non-sweep git touch (hours ago). */
  touchedH?: number;
  /** Birthtime (hours ago), for a page with no git history. */
  birthH?: number;
  /** mtime (hours ago) — trusted only on a page with no git history. */
  mtimeH?: number;
  /** The ledger's newest write before the window (hours ago). */
  preH?: number;
  /** `preGitMs`: the newest non-sweep commit at or before the window. */
  preGitH?: number;
  /** One session's write: edits, hours ago, and whether its prompt names the
   *  page. Absent ⇒ the session writes only another page (state N here). */
  write?: { edits: number; h: number; named?: boolean };
  /** A second, later session that only touches the page (hours ago). */
  laterTouchH?: number;
}

function session(id: string, fx: Fixture, extra: WorkSessionFile[] = []): WorkSession {
  const own: WorkSessionFile[] = fx.write
    ? [{ p: fx.rel, edits: fx.write.edits, firstMs: ago(fx.write.h) - 60_000, lastMs: ago(fx.write.h) }]
    : [];
  const files = [...own, ...extra];
  return {
    id,
    provider: "claude",
    title: `session ${id}`,
    first: Math.min(...files.map((x) => x.firstMs)),
    last: Math.max(...files.map((x) => x.lastMs)),
    bulk: false,
    text: { from: "prompt", paths: fx.write?.named ? [fx.rel] : [], links: [], files: [] },
    files,
  };
}

/** The page as the listing ships it: dates + `work` from `computeWorkFocus`. */
function build(fx: Fixture): WikiListing {
  // A busier page in the same session keeps an un-named, small write a TOUCH
  // (the ≥3-edit / half-of-busiest rule needs a page to compare against).
  const at = fx.write?.h ?? 10;
  const busy: WorkSessionFile = { p: "other/busy.md", edits: 100, firstMs: ago(at) - 60_000, lastMs: ago(at) };
  const input: WorkPageInput = {
    relPath: fx.rel,
    backlinks: 0,
    ...(fx.createdH === undefined ? {} : { gitCreatedMs: ago(fx.createdH) }),
    ...(fx.birthH === undefined ? {} : { birthtimeMs: ago(fx.birthH) }),
    ...(fx.preGitH === undefined ? {} : { preGitMs: ago(fx.preGitH) }),
  };
  const later: WorkSession[] =
    fx.laterTouchH === undefined
      ? []
      : [
          session("s2", { rel: fx.rel, write: { edits: 1, h: fx.laterTouchH } }, [
            { p: "other/busy.md", edits: 100, firstMs: ago(fx.laterTouchH) - 60_000, lastMs: ago(fx.laterTouchH) },
          ]),
        ];
  const r = computeWorkFocus({
    sessions: [session("s1", fx, [busy]), ...later],
    pre: fx.preH === undefined ? new Map() : new Map([[fx.rel, ago(fx.preH)]]),
    sinceMs: SINCE,
    asOfMs: NOW,
    pages: [input, { relPath: "other/busy.md", backlinks: 0 }],
    identity: { roots: ["/w/kode"], names: ["kode"] },
    otherRoots: [],
  });
  const work = r.pages.get(fx.rel);
  return {
    name: fx.rel.replace(/^.*\//, "").replace(/\.md$/, ""),
    title: fx.rel,
    type: "note",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: fx.rel,
    linkCount: 0,
    backlinkCount: 0,
    ...(fx.write ? { workedMs: ago(fx.write.h) } : fx.preH === undefined ? {} : { workedMs: ago(fx.preH) }),
    ...(fx.createdH === undefined ? {} : { gitCreatedMs: ago(fx.createdH) }),
    ...(fx.touchedH === undefined ? {} : { gitTouchedMs: ago(fx.touchedH) }),
    ...(fx.birthH === undefined ? {} : { birthtimeMs: ago(fx.birthH) }),
    ...(fx.mtimeH === undefined ? {} : { mtimeMs: ago(fx.mtimeH) }),
    ...(work ? { work } : {}),
  } as WikiListing;
}

const rowOf = (p: WikiListing, gate: WorkedGate): ActivityRow => {
  const rows = rankActivity([p], { ...wide }, NOW, gate);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

/** A ranked row without its `page` (the page object differs by its `work`). */
const scored = (rows: ActivityRow[]) => rows.map(({ page: _page, ...rest }) => rest);

const chipCls = (p: WikiListing): string => workedChip(workedAxisSource(p, NOW, workedShownSignal(p, NOW)), "").cls;

type Term = "creation" | "work" | "late";
interface Case {
  name: string;
  fx: Fixture;
  state: "F" | "T" | "T0";
  /** The sort instant, in hours ago (or `created`: the page's creation). */
  sortH: number | "created";
  /** The shown instant, in hours ago. */
  shownH: number;
  touched: boolean;
  term: Term;
  /** The row age's source, in hours ago. */
  ageH: number;
}

const CASES: Case[] = [
  // ── F: a focus event in the window ──────────────────────────────────────
  {
    name: "F — creation wins: a page a session created two hours ago",
    fx: { rel: "f/created.md", createdH: 2, touchedH: 2, write: { edits: 1, h: 2, named: true } },
    state: "F", sortH: 2, shownH: 2, touched: false, term: "creation", ageH: 2,
  },
  {
    name: "F — work wins: an old page a session worked on three hours ago",
    fx: { rel: "f/worked.md", createdH: 40 * 24, touchedH: 3, preGitH: 30 * 24, write: { edits: 20, h: 3, named: true } },
    state: "F", sortH: 3, shownH: 3, touched: false, term: "work", ageH: 3,
  },
  {
    name: "F — work wins, with a touch after the focus: the age runs from the newest FOCUS event",
    fx: {
      rel: "f/worked-then-touched.md",
      createdH: 40 * 24,
      touchedH: 30 * 24,
      preGitH: 30 * 24,
      write: { edits: 20, h: 10, named: true },
      laterTouchH: 2,
    },
    state: "F", sortH: 10, shownH: 10, touched: false, term: "work", ageH: 10,
  },
  {
    name: "F — late change wins: a hand edit landing four days after a small session",
    fx: { rel: "f/late.md", createdH: 60 * 24, touchedH: 24, preGitH: 50 * 24, write: { edits: 1, h: 6 * 24, named: true } },
    state: "F", sortH: 6 * 24, shownH: 6 * 24, touched: false, term: "late", ageH: 24,
  },
  // ── T: only touches, with a pre-touch position ───────────────────────────
  {
    name: "T — creation wins: a nine-day-old page touched once (position from git)",
    fx: { rel: "t/created.md", createdH: 9 * 24, touchedH: 9 * 24, preGitH: 9 * 24, write: { edits: 1, h: 5 } },
    state: "T", sortH: 9 * 24, shownH: 5, touched: true, term: "creation", ageH: 9 * 24,
  },
  {
    name: "T — work wins: an old page touched with many edits (position from the ledger)",
    fx: { rel: "t/worked.md", createdH: 100 * 24, touchedH: 100 * 24, preH: 20 * 24, write: { edits: 40, h: 1 } },
    state: "T", sortH: 20 * 24, shownH: 1, touched: true, term: "work", ageH: 1,
  },
  {
    name: "T — late change wins: an old page touched five days ago, edited yesterday",
    fx: { rel: "t/late.md", createdH: 100 * 24, touchedH: 24, preGitH: 90 * 24, write: { edits: 1, h: 5 * 24 } },
    // The shown instant is today's chain: the update is newer than the touch.
    state: "T", sortH: 90 * 24, shownH: 5 * 24, touched: true, term: "late", ageH: 24,
  },
  // ── T0: as T, with no pre-touch position ────────────────────────────────
  {
    name: "T0 — creation wins: a page someone else committed two days ago, touched since",
    fx: { rel: "t0/created.md", createdH: 48, touchedH: 48, write: { edits: 1, h: 24 } },
    state: "T0", sortH: "created", shownH: 24, touched: true, term: "creation", ageH: 48,
  },
  {
    name: "T0 — work wins: an untracked old page touched with many edits",
    fx: { rel: "t0/worked.md", birthH: 100 * 24, mtimeH: 100 * 24, write: { edits: 40, h: 1 } },
    state: "T0", sortH: "created", shownH: 1, touched: true, term: "work", ageH: 1,
  },
  {
    name: "T0 — late change wins: an untracked old page touched five days ago, saved yesterday",
    fx: { rel: "t0/late.md", birthH: 100 * 24, mtimeH: 24, write: { edits: 1, h: 5 * 24 } },
    state: "T0", sortH: "created", shownH: 5 * 24, touched: true, term: "late", ageH: 24,
  },
];

describe("the state table (D22) — F, T and T0 per winning term", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const p = build(c.fx);
      expect(p.work?.state).toBe(c.state);
      // Sort instant.
      expect(workedSortMs(p, NOW)).toBe(c.sortH === "created" ? pageAddedMs(p, NOW) : ago(c.sortH));
      // Shown instant and its mark.
      const shown = workedShownSignal(p, NOW);
      expect(shown.ms).toBe(ago(c.shownH));
      expect(!!shown.touched).toBe(c.touched);
      expect(chipCls(p).includes("touched")).toBe(c.touched);
      // Activity: the winning term and the row age it runs from.
      const row = rowOf(p, OPEN);
      expect(row.kind).toBe(c.term === "creation" ? "new" : "changed");
      expect(!!row.worked).toBe(c.term === "work");
      expect(row.ageMs).toBe(NOW - ago(c.ageH));
      if (c.term === "late") expect(row.why).toMatch(/^changed /);
      if (c.term === "work") expect(row.why).toMatch(/→ work \d/);
    });
  }
});

describe("the state table (D22) — N and C", () => {
  test("N — no events: today's chain and today's score, byte for byte", () => {
    // A T-shaped page (position, touch) is the strongest test: shipped with any
    // usable event it would sort on its position and carry a touched mark.
    const p = build({ rel: "n/page.md", createdH: 40 * 24, touchedH: 30, preH: 30 * 24, write: { edits: 1, h: 5 } });
    expect(p.work?.state).toBe("T");
    const bare = { ...p };
    delete (bare as { work?: unknown }).work;
    // The same page shipping a `work` with no event the client can use: empty,
    // and every event malformed. Both must be state N, i.e. today's path.
    const shapes: Array<[string, unknown[]]> = [
      ["empty", []],
      ["all invalid", [[ago(5), 1, "review"], [Number.NaN, 2, "touch"], [ago(5), -1, "touch"], [ago(5)]]],
    ];
    const header = (x: WikiListing) => pageHeaderDates(x, NOW, { ledger: true });
    for (const [name, events] of shapes) {
      const n = { ...p, work: { ...p.work!, events } } as WikiListing;
      expect(workedSortMs(n, NOW), name).toBe(workedSortMs(bare, NOW));
      expect(workedShownSignal(n, NOW), name).toEqual(workedShownSignal(bare, NOW));
      expect(chipCls(n), name).toBe(chipCls(bare));
      expect(header(n), name).toEqual(header(bare));
      expect(scored(rankActivity([n], wide, NOW, OPEN)), name).toEqual(scored(rankActivity([bare], wide, NOW, OPEN)));
    }
    // …and the comparison can fail: with its events the page differs on each.
    expect(workedSortMs(p, NOW)).not.toBe(workedSortMs(bare, NOW));
    expect(chipCls(p)).not.toBe(chipCls(bare));
  });

  test("T with no ledger row: the header claims no 'no session' (D5) and carries the touched mark", () => {
    // A bash-only touch: session events, but no `workedMs` summary row.
    const p = build({ rel: "t/bash-only.md", createdH: 40 * 24, touchedH: 40 * 24, preGitH: 40 * 24, write: { edits: 1, h: 5 } });
    delete (p as { workedMs?: number }).workedMs;
    expect(p.work?.state).toBe("T");
    const h = pageHeaderDates(p, NOW, { ledger: true });
    expect(h.noSession).toBeUndefined();
    expect(h.touched).toEqual({ ms: ago(5), label: localDay(new Date(ago(5))), pass: false });
    const bare = { ...p };
    delete (bare as { work?: unknown }).work;
    expect(pageHeaderDates(bare, NOW, { ledger: true }).noSession).toBe(true);
  });

  test("T with no ledger row: the Worked-on listing chip carries its touch, never 'no session write recorded'", () => {
    const p = build({ rel: "t/bash-only.md", createdH: 40 * 24, touchedH: 40 * 24, preGitH: 40 * 24, write: { edits: 1, h: 5 } });
    delete (p as { workedMs?: number }).workedMs;
    const chip = workedChip(workedAxisSource(p, NOW, workedShownSignal(p, NOW)), "d", "updated");
    expect(chip.cls).toBe(" touched");
    expect(chip.title).not.toContain("no session write recorded");
    // Without its events the same page is the plain fallback, claim and all.
    const bare = { ...p };
    delete (bare as { work?: unknown }).work;
    expect(workedChip(workedAxisSource(bare, NOW, workedShownSignal(bare, NOW)), "d", "updated").cls).toBe(" fallback");
  });

  test("C — a closed gate: today's score, while the worked key still moves per F/T/T0", () => {
    for (const c of CASES) {
      const p = build(c.fx);
      const bare = { ...p };
      delete (bare as { work?: unknown }).work;
      expect(scored(rankActivity([p], wide, NOW, SHUT)), c.name).toEqual(scored(rankActivity([bare], wide, NOW, SHUT)));
      expect(workedSortMs(p, NOW), c.name).toBe(c.sortH === "created" ? pageAddedMs(p, NOW) : ago(c.sortH));
    }
  });
});
