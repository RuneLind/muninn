/**
 * The Activity ranking's rules, enumerated rather than sampled: each case names
 * the ONE property it pins and builds its fixture in-process, so a change to the
 * formula fails the case whose property it broke.
 *
 * Dates are built as OFFSETS from a fixed `NOW`, never from a real clock — the
 * whole score is a function of age, so a test reading `Date.now()` would be a
 * test of the machine it runs on.
 */
import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_GLYPH,
  ACTIVITY_MIN_SCORE,
  ACTIVITY_ROWS_MAX,
  ACTIVITY_ROWS_MIN,
  DEFAULT_ACTIVITY_WEIGHTS,
  formatRailAge,
  parseActivityWeights,
  RAIL_AGE_MAX_DAYS,
  rankActivity,
  WORKED_GATE_MIN_COVERAGE,
  workedGateFor,
  type ActivityRow,
  type ActivityWeights,
  type WorkedGate,
} from "./wiki-activity-rank.ts";
import { localDay, type WikiListing } from "./wiki-filter.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const DAY = 86_400_000;
const ago = (days: number): number => NOW - days * DAY;

/**
 * Run `body` with the process on `tz`.
 *
 * The two properties this file has to pin — that a bare authored day is echoed
 * verbatim, and that the calendar branch names the stamp's LOCAL day — are both
 * invisible in UTC: `localDay(ms)` and `new Date(ms).toISOString().slice(0, 10)`
 * are the same string there, so every mutation of that choice passes on a CI
 * runner. Bun honours a `process.env.TZ` written at runtime (measured: the next
 * `new Date(ms).getDate()` moves), and the zone is restored from `Intl` rather
 * than by deleting the variable — a `delete` leaves the process on the zone last
 * assigned (measured), which would leak into every later case in this process.
 */
function inTimeZone(tz: string, body: () => void): void {
  const original = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = tz;
  try {
    body();
  } finally {
    process.env.TZ = original;
  }
}

/**
 * A page whose two date signals are stated DIRECTLY, via the fields
 * `pageAddedMs`/`pageTimeMs` actually read for a git-tracked page.
 *
 * `gitCreatedMs` is the creation signal (`pageAddedMs` takes the oldest of
 * frontmatter/git/birthtime, and this fixture supplies only git), and
 * `gitTouchedMs` the update signal. `gitDirty` is deliberately unset, so mtime
 * is not consulted — the state every committed page is in.
 */
function page(over: {
  relPath: string;
  createdDaysAgo?: number;
  /** `null` means NO touch signal at all — the swept-only page, whose update
   *  date can only be the creation floor. Absent (the default) mirrors the
   *  creation commit, which is what a page committed once really looks like. */
  updatedDaysAgo?: number | null;
  /** File birthtime, which `pageAddedMs` takes the OLDEST of — the field that
   *  makes a creation date older than the git floor, and so the field that
   *  opens the sweep-floor gap below. */
  birthtimeDaysAgo?: number;
  /** mtime — the only date left when a page has no git history, no
   *  birthtime (a filesystem that reports none) and no frontmatter `created:`. */
  mtimeDaysAgo?: number;
  backlinkCount?: number;
  type?: string;
  plan_status?: string;
  title?: string;
  /** Frontmatter `created:` — the one signal whose LABEL is the authored string
   *  rather than a derived local day, so it is the only way to build the page
   *  whose date the rail may not re-derive. */
  createdFm?: string;
  /** `workedMs` — the day a session wrote the page. ABSENT is the state most of
   *  a wiki is in and the one the worked term must ABSTAIN on, so it is left
   *  unset by default rather than defaulted to anything. A NEGATIVE value is a
   *  stamp in the FUTURE, which is how the guard is driven. */
  workedDaysAgo?: number;
}): WikiListing {
  const created = over.createdDaysAgo;
  const updated = over.updatedDaysAgo === null ? undefined : (over.updatedDaysAgo ?? over.createdDaysAgo);
  return {
    name: over.relPath.slice(over.relPath.lastIndexOf("/") + 1).replace(/\.mdx?$/, ""),
    title: over.title ?? over.relPath,
    type: (over.type ?? "note") as WikiListing["type"],
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: over.relPath,
    linkCount: 0,
    backlinkCount: over.backlinkCount ?? 0,
    ...(over.plan_status ? { plan_status: over.plan_status } : {}),
    ...(over.createdFm === undefined ? {} : { created: over.createdFm }),
    ...(created === undefined ? {} : { gitCreatedMs: ago(created) }),
    ...(updated === undefined ? {} : { gitTouchedMs: ago(updated) }),
    ...(over.birthtimeDaysAgo === undefined ? {} : { birthtimeMs: ago(over.birthtimeDaysAgo) }),
    ...(over.mtimeDaysAgo === undefined ? {} : { mtimeMs: ago(over.mtimeDaysAgo) }),
    ...(over.workedDaysAgo === undefined ? {} : { workedMs: ago(over.workedDaysAgo) }),
  } as WikiListing;
}

/** Rank with room for every fixture, so a case about ORDER is never also a case
 *  about truncation. */
const wide: ActivityWeights = { ...DEFAULT_ACTIVITY_WEIGHTS, rows: ACTIVITY_ROWS_MAX };

const relOrder = (pages: WikiListing[], w: ActivityWeights = wide): string[] =>
  rankActivity(pages, w, NOW).map((r) => r.page.relPath);

describe("rankActivity — which signal wins", () => {
  test("a fresh creation beats a change of the same age", () => {
    const created = page({ relPath: "a-created.md", createdDaysAgo: 2 });
    const changed = page({ relPath: "b-changed.md", createdDaysAgo: 40, updatedDaysAgo: 2 });
    const rows = rankActivity([changed, created], wide, NOW);
    expect(rows.map((r) => r.page.relPath)).toEqual(["a-created.md", "b-changed.md"]);
    expect(rows[0]!.kind).toBe("new");
    expect(rows[1]!.kind).toBe("changed");
  });

  // The pair differs in its two ages and in nothing else, so only the "more than
  // a day after creation" rule can decide between them. Both are in-flight
  // plans, and both are YOUNG on purpose: the kind is whichever signal scores
  // higher, so the threshold is observable only where a change WOULD outscore
  // the creation — which for a boosted page it does as soon as it counts at all.
  const planEditedAt = (createdDaysAgo: number, updatedDaysAgo: number): WikiListing =>
    page({
      relPath: "x.md",
      createdDaysAgo,
      updatedDaysAgo,
      type: "plan",
      plan_status: "in-flight",
    });

  test("an edit within a day of creation is not a CHANGE — the page reads as new", () => {
    const rows = rankActivity([planEditedAt(0.2, 0.1)], wide, NOW);
    expect(rows[0]!.kind).toBe("new");
    expect(rows[0]!.why).toStartWith("created ");
  });

  test("an edit more than a day after creation is a CHANGE", () => {
    const rows = rankActivity([planEditedAt(3, 1)], wide, NOW);
    expect(rows[0]!.kind).toBe("changed");
    expect(rows[0]!.why).toStartWith("changed ");
  });
});

describe("rankActivity — the three change discounts", () => {
  // One pair per factor, identical in every other respect, so the case can only
  // pass because of the factor it names.
  test("age penalty: a change to a young page beats the same change to an old one", () => {
    const young = page({ relPath: "young.md", createdDaysAgo: 5, updatedDaysAgo: 0.5 });
    const old = page({ relPath: "old.md", createdDaysAgo: 400, updatedDaysAgo: 0.5 });
    expect(relOrder([old, young])).toEqual(["young.md", "old.md"]);
  });

  test("hub penalty: a change to a peripheral page beats the same change to a hub", () => {
    const leaf = page({ relPath: "leaf.md", createdDaysAgo: 40, updatedDaysAgo: 0.5 });
    const hub = page({ relPath: "hub.md", createdDaysAgo: 40, updatedDaysAgo: 0.5, backlinkCount: 25 });
    expect(relOrder([hub, leaf])).toEqual(["leaf.md", "hub.md"]);
  });

  test("plan boost: an in-flight plan beats an ordinary page changed the same way", () => {
    const note = page({ relPath: "note.md", createdDaysAgo: 40, updatedDaysAgo: 0.5 });
    const plan = page({
      relPath: "plan.md",
      createdDaysAgo: 40,
      updatedDaysAgo: 0.5,
      type: "plan",
      plan_status: "in-flight",
    });
    expect(relOrder([note, plan])).toEqual(["plan.md", "note.md"]);
  });

  test("an in-flight plan outranks a shipped plan changed the same way", () => {
    // The titles are chosen so the TIEBREAK would order them the other way: with
    // equal boosts "Aaa" wins, so this case can only pass on the boost.
    const shipped = page({
      relPath: "shipped.md",
      title: "Aaa shipped",
      createdDaysAgo: 40,
      updatedDaysAgo: 0.5,
      type: "plan",
      plan_status: "shipped",
    });
    const inFlight = page({
      relPath: "in-flight.md",
      title: "Zzz in flight",
      createdDaysAgo: 40,
      updatedDaysAgo: 0.5,
      type: "plan",
      plan_status: "in-flight",
    });
    expect(relOrder([shipped, inFlight])).toEqual(["in-flight.md", "shipped.md"]);
  });

  test("the brief's shape: a change to a young plan beats a change to an old, linked hub", () => {
    const plan = page({
      relPath: "plans/new-thing.md",
      createdDaysAgo: 6,
      updatedDaysAgo: 0.1,
      type: "plan",
      plan_status: "in-flight",
    });
    const hub = page({
      relPath: "flows/how-we-build.md",
      createdDaysAgo: 400,
      updatedDaysAgo: 0.1,
      backlinkCount: 6,
    });
    expect(relOrder([hub, plan])).toEqual(["plans/new-thing.md", "flows/how-we-build.md"]);
  });
});

describe("rankActivity — what never reaches the section", () => {
  test("bookkeeping pages are excluded whatever their dates say", () => {
    const pages = [
      page({ relPath: "index.md", createdDaysAgo: 0 }),
      page({ relPath: "log.md", createdDaysAgo: 0 }),
      page({ relPath: "plans/CLAUDE.md", createdDaysAgo: 0 }),
      page({ relPath: "real.md", createdDaysAgo: 0 }),
    ];
    expect(relOrder(pages)).toEqual(["real.md"]);
  });

  test("a page with no date signal at all never appears, even where the floor would admit it", () => {
    const undated = page({ relPath: "undated.md" });
    // The ordinary call proves nothing: an undated page reads as epoch-0-old and
    // the floor drops it either way. So rank it in a world where epoch 0 is 11
    // days back and creations take a year to halve — there an undated page's
    // "age" clears the floor comfortably, and only the rule that a missing
    // creation signal is not a young page can still drop it.
    const nearEpoch = 11 * 86_400_000;
    const slow: ActivityWeights = { ...wide, halfLifeNewDays: 365, halfLifeChangedDays: 365 };
    expect(Math.pow(0.5, nearEpoch / 86_400_000 / slow.halfLifeNewDays)).toBeGreaterThan(0.02);
    expect(rankActivity([undated], slow, nearEpoch)).toEqual([]);
  });

  test("a page whose signals have decayed below the floor is dropped", () => {
    // The floor's own boundary, at the default weights: a creation reaches
    // ACTIVITY_MIN_SCORE at 28.2 days.
    expect(relOrder([page({ relPath: "just-in.md", createdDaysAgo: 28 })])).toEqual(["just-in.md"]);
    expect(relOrder([page({ relPath: "just-out.md", createdDaysAgo: 29 })])).toEqual([]);
  });

  test("a dormant wiki renders NO Activity at all — the whole point of the floor", () => {
    // Every page created two years ago and last touched two years ago. The
    // scores are tiny but non-zero, so without the floor this fills the section
    // with rows whose glyph says "created 2.0y ago".
    const dormant = Array.from({ length: 20 }, (_, i) =>
      page({ relPath: `p-${i}.md`, createdDaysAgo: 730, updatedDaysAgo: 700 }),
    );
    expect(rankActivity(dormant, wide, NOW)).toEqual([]);
  });
});

describe("rankActivity — ordering and truncation", () => {
  test("ties break on the displayed title, so the order is total", () => {
    const b = page({ relPath: "b.md", createdDaysAgo: 1, title: "Beta" });
    const a = page({ relPath: "a.md", createdDaysAgo: 1, title: "Alpha" });
    expect(relOrder([b, a])).toEqual(["a.md", "b.md"]);
    // Same input in the other order answers the same — the sort is not
    // input-order-dependent at a tie.
    expect(relOrder([a, b])).toEqual(["a.md", "b.md"]);
  });

  test("the list is truncated to `rows`", () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      page({ relPath: `p-${i}.md`, createdDaysAgo: i * 0.1 }),
    );
    expect(rankActivity(pages, { ...DEFAULT_ACTIVITY_WEIGHTS, rows: 3 }, NOW)).toHaveLength(3);
    expect(rankActivity(pages, { ...DEFAULT_ACTIVITY_WEIGHTS, rows: 1 }, NOW)).toHaveLength(1);
  });
});

describe("rankActivity — the `why` sentence", () => {
  test("a creation names its age and its score", () => {
    const rows = rankActivity([page({ relPath: "x.md", createdDaysAgo: 2 })], wide, NOW);
    expect(rows[0]!.why).toBe("created 2d ago → 0.76");
  });

  test("a change names every factor that produced its score", () => {
    const rows = rankActivity(
      [page({ relPath: "x.md", createdDaysAgo: 46, updatedDaysAgo: 3 / 24, backlinkCount: 25 })],
      wide,
      NOW,
    );
    expect(rows[0]!.why).toBe(
      "changed 3h ago, created 46d ago: weight ×0.70, recency 0.97, age ×0.52, hub ×0.25 (25←), type ×1.00 → 0.09",
    );
  });
});

describe("age labels", () => {
  /** The rail calls it with a STAMP, so every case here states an age in days and
   *  lets the helper subtract — `NOW` is fixed, so the two are interchangeable. */
  const age = (days: number, dayLabel?: string): string =>
    formatRailAge(NOW - days * DAY, NOW, dayLabel);
  /** The local day of a stamp this many days back — what the helper falls back to
   *  past the relative window when the caller hands it no authored label. Derived
   *  through the same `localDay` rather than hardcoded, or the case would fail on
   *  every machine outside one timezone; the cases that are ABOUT that choice
   *  assert against the UTC spelling too, so none of them can go vacuous. */
  const localDayAgo = (days: number): string => localDay(new Date(NOW - days * DAY));

  test("no two buckets can print the same duration", () => {
    // Each bucket promotes on its OWN rounded value. Promoting on the raw one
    // makes 23.6h print "24h" beside a day bucket that starts at 24.
    expect(age(23.6 / 24)).toBe("1d");
    expect(age(23.4 / 24)).toBe("23h");
  });

  test("every bucket of the scale", () => {
    expect(age(0)).toBe("now");
    expect(age(59 / 1440)).toBe("now"); // 59 min
    expect(age(60 / 1440)).toBe("1h"); // 60 min exactly promotes
    expect(age(3 / 24)).toBe("3h");
    expect(age(2)).toBe("2d");
    expect(age(46)).toBe("46d");
    // Clock skew ahead of the anchor reads as "now", never as a negative age.
    expect(age(-1)).toBe("now");
    expect(formatRailAge(Number.NaN, NOW)).toBe("");
    // A page with NO date signal at all arrives as a stamp of 0 and renders
    // nothing, exactly as `pageDateLabel` does for it.
    expect(formatRailAge(0, NOW)).toBe("");
    // A non-finite ANCHOR is as unusable as a non-finite stamp: there is no age
    // to count and no day to name, so the cell is empty rather than `NaNd`.
    expect(formatRailAge(NOW - 2 * DAY, Number.NaN)).toBe("");
  });

  test(`the day scale stops at ${RAIL_AGE_MAX_DAYS} days and the date takes over`, () => {
    expect(age(RAIL_AGE_MAX_DAYS)).toBe(`${RAIL_AGE_MAX_DAYS}d`);
    // Promotion is on the ROUNDED day count here too, so the seam is at 99.5.
    expect(age(99.4)).toBe("99d");
    expect(age(99.6)).toBe(localDayAgo(99.6));
    expect(age(400)).toBe(localDayAgo(400));
  });

  test("past the day scale an authored day label WINS over the local day", () => {
    // `pageAddedLabel` echoes a frontmatter `created:` verbatim, and a bare
    // `2026-01-15` parses as UTC midnight — so west of UTC the helper's own
    // `localDay(ms)` is the 14th while the header says the 15th. The label wins,
    // or one page carries two different dates on two surfaces.
    expect(age(400, "2020-01-15")).toBe("2020-01-15");
    // A blank label is not a date and must not blank the cell.
    expect(age(400, "")).toBe(localDayAgo(400));
    // Inside the relative window the label is irrelevant — the age is the answer.
    expect(age(2, "2020-01-15")).toBe("2d");
  });

  test("only a BARE day label wins — a label carrying a TIME has a real instant", () => {
    // `store.ts` passes any STRING `created:` through and `addedSignal` echoes
    // whatever `Date.parse` accepted, so a timestamp label would land verbatim in
    // a `flex-shrink: 0` cell — 19 glyphs. A bare day is the only label with no
    // instant of its own, so it is the only one the helper may prefer. (No live
    // page carries a timestamp today; this is the guard's own case.)
    for (const tz of ["America/Los_Angeles", "Europe/Oslo"]) {
      inTimeZone(tz, () => {
        const stamped = "2026-03-30T14:20:00";
        expect(formatRailAge(Date.parse(stamped), NOW, stamped)).toBe("2026-03-30");
        // A bare day, whose UTC midnight renders as the PREVIOUS day west of UTC
        // — the authored spelling is the only right answer for it.
        expect(formatRailAge(Date.parse("2026-02-25"), NOW, "2026-02-25")).toBe("2026-02-25");
        // Whitespace is not a date and must not blank the cell.
        expect(age(400, "   ")).toBe(localDayAgo(400));
      });
    }
  });

  test("the calendar day is the LOCAL day of the stamp, never its UTC day", () => {
    // Every other fixture here is mid-day UTC, where `localDay(ms)` and
    // `new Date(ms).toISOString().slice(0, 10)` are the same string in every zone
    // anyone runs this in — so the choice was unpinned. These stamps sit half an
    // hour from LOCAL midnight, on each side of it: 00:30 in a zone AHEAD of UTC
    // is the previous UTC day, 23:30 in a zone BEHIND it is the next.
    for (const [tz, hour] of [
      ["Europe/Oslo", 0],
      ["America/Los_Angeles", 23],
    ] as const) {
      inTimeZone(tz, () => {
        const back = new Date(NOW - 400 * DAY);
        // Built from LOCAL getters, so the instant really is 00:30 / 23:30 in
        // `tz` whatever zone the runner itself is on.
        const stamp = new Date(back.getFullYear(), back.getMonth(), back.getDate(), hour, 30);
        const day = localDay(stamp);
        // The case only says something where the two spellings disagree.
        expect(new Date(stamp).toISOString().slice(0, 10)).not.toBe(day);
        expect(formatRailAge(stamp.getTime(), NOW)).toBe(day);
      });
    }
  });

  test("the row label is the age of the signal that WON", () => {
    const [created] = rankActivity([page({ relPath: "a.md", createdDaysAgo: 2 })], wide, NOW);
    expect(formatRailAge(NOW - created!.ageMs, NOW)).toBe("2d");
    const [changed] = rankActivity(
      [page({ relPath: "b.md", createdDaysAgo: 46, updatedDaysAgo: 3 / 24 })],
      wide,
      NOW,
    );
    expect(changed!.kind).toBe("changed");
    expect(formatRailAge(NOW - changed!.ageMs, NOW)).toBe("3h");
  });

  test("the `why` sentence says `on <day>` past the day scale, never `ago`", () => {
    // A page created 200 days ago and edited yesterday: the creation phrase is
    // past the window, the change phrase is not.
    const [row] = rankActivity(
      [page({ relPath: "old.md", createdDaysAgo: 200, updatedDaysAgo: 1 })],
      wide,
      NOW,
    );
    expect(row!.why).toContain(`created on ${localDayAgo(200)}`);
    expect(row!.why).toContain("changed 1d ago");
  });

  test("the `why` sentence names the AUTHORED day, exactly as the cell does", () => {
    // The page: frontmatter `created: 2026-02-25` (the oldest creation signal, so
    // `addedSignal` echoes it verbatim) plus a git touch two days ago, which makes
    // it a `changed` row whose creation phrase is past the relative window.
    // Under a zone west of UTC the bare day's UTC midnight is the 24th, so the
    // cell (which prefers the label) and the `why` (which re-derived the local
    // day) named two different days for one page.
    inTimeZone("America/Los_Angeles", () => {
      const authored = "2026-02-25";
      const p = page({ relPath: "authored.md", createdDaysAgo: 150, updatedDaysAgo: 2, createdFm: authored });
      const [row] = rankActivity([p], wide, NOW);
      expect(row!.kind).toBe("changed");
      // The trap is live in this zone — otherwise the assertion below is vacuous.
      expect(localDay(new Date(Date.parse(authored)))).toBe("2026-02-24");
      expect(row!.why).toContain(`created on ${authored}`);
      expect(row!.why).not.toContain("2026-02-24");
      // …and it is the same day the cell shows, from the same label.
      expect(formatRailAge(Date.parse(authored), NOW, authored)).toBe(authored);
    });
  });
});

describe("rankActivity — the updated signal has to be a real EDIT", () => {
  /**
   * A page whose every commit was a sweep has no touch date at all, and
   * `updatedSignal` falls back to the git CREATION date with `kind: "added"`.
   * Taken as an edit that reads as "changed <the day it was created>" — and it
   * outranks the creation it is made of whenever the creation signal is older
   * still (a birthtime or a frontmatter `created:` predating the git floor).
   * On the live jarvis wiki (2026-09-12) 534 pages have this shape, all over 50
   * days old and so under the floor today; this fixture builds the RECENT floor
   * (a re-clone or an import) where the phantom would rank.
   */
  const sweptOnly = page({
    relPath: "concepts/swept.md",
    createdDaysAgo: 5, // the git floor — no gitTouchedMs, so this is the update signal
    updatedDaysAgo: null,
    birthtimeDaysAgo: 20, // older, so pageAddedMs answers 20d and the gap opens
  });

  test("a page whose date is the creation FLOOR is new, never changed", () => {
    const rows = rankActivity([sweptOnly], wide, NOW);
    expect(rows[0]!.kind).toBe("new");
    expect(rows[0]!.why).toStartWith("created ");
  });

  test("a real touch on the same shape IS a change", () => {
    // One field apart: a genuine non-sweep commit, which gives the signal
    // kind `updated`.
    const touched = page({
      relPath: "concepts/touched.md",
      createdDaysAgo: 5,
      updatedDaysAgo: 0.5,
      birthtimeDaysAgo: 20,
    });
    expect(rankActivity([touched], wide, NOW)[0]!.kind).toBe("changed");
  });
});

describe("rankActivity — a page with no CREATION signal", () => {
  // No git history, no birthtime, no frontmatter `created:` — mtime is the only
  // date the store has, and `pageAddedMs` answers 0. The page really was edited
  // an hour ago; nothing is known about when it was made.
  const mtimeOnly = page({ relPath: "notes/only-mtime.md", mtimeDaysAgo: 1 / 24 });

  test("is a CHANGE, with its unknown age unpenalised", () => {
    const rows = rankActivity([mtimeOnly], wide, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("changed");
    // age ×1.00 — an unknown age is not evidence of an old page.
    expect(rows[0]!.why).toContain("age ×1.00");
    expect(rows[0]!.why).toContain("created ?");
  });

  test("…and a page with NEITHER signal is still dropped", () => {
    expect(rankActivity([page({ relPath: "nothing.md" })], wide, NOW)).toEqual([]);
  });
});

describe("rankActivity — the `why` sentence is the score's own derivation", () => {
  test("the listed factors multiply to the stated score", () => {
    const rows = rankActivity(
      [page({ relPath: "x.md", createdDaysAgo: 46, updatedDaysAgo: 3 / 24, backlinkCount: 25 })],
      wide,
      NOW,
    );
    const why = rows[0]!.why;
    // Every `<name> <n>` / `<name> ×<n>` factor in the sentence, multiplied.
    // The list opens after the `: ` and continues after each `, `.
    const factors = [...why.matchAll(/[:,] [a-z]+ ×?(\d+\.\d\d)/g)].map((m) => Number(m[1]));
    expect(factors.length).toBeGreaterThanOrEqual(5); // weight · recency · age · hub · type
    const product = factors.reduce((a, b) => a * b, 1);
    const stated = Number(why.slice(why.lastIndexOf("→ ") + 2));
    expect(product).toBeCloseTo(stated, 2);
  });

  test("an age that formats as `now` reads as `just now`, with no dangling `ago`", () => {
    const rows = rankActivity([page({ relPath: "x.md", createdDaysAgo: 0 })], wide, NOW);
    expect(rows[0]!.why).toBe("created just now → 1.00");
  });
});

describe("rankActivity — the type boost's other two tiers", () => {
  test("a blog outranks an ordinary page changed the same way", () => {
    const note = page({ relPath: "note.md", title: "Aaa note", createdDaysAgo: 40, updatedDaysAgo: 0.5 });
    const blog = page({
      relPath: "blog.md",
      title: "Zzz blog",
      type: "blog",
      createdDaysAgo: 40,
      updatedDaysAgo: 0.5,
    });
    // Titles chosen so the tiebreak would order these the other way.
    expect(relOrder([note, blog])).toEqual(["blog.md", "note.md"]);
  });

  test("a PROPOSED plan gets the same high tier as an in-flight one", () => {
    const mk = (rel: string, status: string, title: string) =>
      page({ relPath: rel, title, type: "plan", plan_status: status, createdDaysAgo: 40, updatedDaysAgo: 0.5 });
    const proposed = rankActivity([mk("p.md", "proposed", "P")], wide, NOW)[0]!;
    const inFlight = rankActivity([mk("i.md", "in-flight", "P")], wide, NOW)[0]!;
    const shipped = rankActivity([mk("s.md", "shipped", "P")], wide, NOW)[0]!;
    expect(proposed.score).toBeCloseTo(inFlight.score, 10);
    expect(proposed.score).toBeGreaterThan(shipped.score);
  });
});

describe("parseActivityWeights", () => {
  test("absent ⇒ the defaults, silently", () => {
    expect(parseActivityWeights(undefined)).toEqual({
      weights: DEFAULT_ACTIVITY_WEIGHTS,
      warnings: [],
    });
    expect(parseActivityWeights(null).weights).toEqual(DEFAULT_ACTIVITY_WEIGHTS);
  });

  test("a non-object ⇒ the defaults plus one warning", () => {
    for (const raw of ["6", 6, [], true]) {
      const out = parseActivityWeights(raw);
      expect(out.weights).toEqual(DEFAULT_ACTIVITY_WEIGHTS);
      expect(out.warnings).toHaveLength(1);
    }
  });

  test("a partial block merges over the defaults", () => {
    const { weights, warnings } = parseActivityWeights({ hubPenalty: 0, rows: 4 });
    expect(warnings).toEqual([]);
    expect(weights).toEqual({ ...DEFAULT_ACTIVITY_WEIGHTS, hubPenalty: 0, rows: 4 });
  });

  test("each key's bad value is dropped ALONE — its neighbours in the block survive", () => {
    const bad: Array<[string, unknown]> = [
      ["agePenalty", "60"],
      ["hubPenalty", 101],
      ["planBoost", -1],
      ["changedWeight", Number.NaN],
      ["workedWeight", 101],
      ["halfLifeNewDays", 0],
      ["halfLifeChangedDays", 400],
      ["rows", "4"],
    ];
    for (const [key, value] of bad) {
      // `halfLifeNewDays` is the neighbour in every case, because no entry of
      // `bad` names it twice — a block is `{<the bad key>, halfLifeNewDays: 9}`.
      const neighbour = key === "halfLifeNewDays" ? "halfLifeChangedDays" : "halfLifeNewDays";
      const { weights, warnings } = parseActivityWeights({ [key]: value, [neighbour]: 9 });
      expect(warnings.some((w) => w.key === `activity.${key}`)).toBe(true);
      // The bad key falls back to its default …
      expect(weights[key as keyof ActivityWeights]).toBe(
        DEFAULT_ACTIVITY_WEIGHTS[key as keyof ActivityWeights],
      );
      // … and its neighbour in the same block is untouched.
      expect(weights[neighbour]).toBe(9);
    }
  });

  test("rows is CLAMPED, not dropped, and rounded", () => {
    // The literal, not the constant: a revert of the raise has to fail a case in
    // `bun run test`, and every assertion below spelled through the constant
    // would follow it down to 12.
    expect(ACTIVITY_ROWS_MAX).toBe(20);
    expect(parseActivityWeights({ rows: 20 }).weights.rows).toBe(20);
    expect(parseActivityWeights({ rows: 20 }).warnings).toEqual([]);
    expect(parseActivityWeights({ rows: 0 }).weights.rows).toBe(ACTIVITY_ROWS_MIN);
    expect(parseActivityWeights({ rows: 99 }).weights.rows).toBe(ACTIVITY_ROWS_MAX);
    expect(parseActivityWeights({ rows: 4.4 }).weights.rows).toBe(4);
    expect(parseActivityWeights({ rows: 99 }).warnings).toHaveLength(1);
    expect(parseActivityWeights({ rows: 4 }).warnings).toEqual([]);
  });

  test("an in-range non-integer is ROUNDED, and says so — only a real breach is `outside`", () => {
    const rounded = parseActivityWeights({ rows: 6.4 }).warnings;
    expect(rounded).toHaveLength(1);
    expect(rounded[0]!.reason).toBe("rounded to 6");
    const breached = parseActivityWeights({ rows: 99 }).warnings;
    expect(breached[0]!.reason).toContain("outside");
    // The literal again — `using ${ACTIVITY_ROWS_MAX}` asserted the code against
    // itself and passed at any ceiling.
    expect(breached[0]!.reason).toContain("using 20");
  });

  test("every warning names its key separately, so a log sink can group by cause", () => {
    const { warnings } = parseActivityWeights({ hubPenalty: "lots", nope: 1 });
    expect(warnings).toEqual([
      { key: "activity.hubPenalty", reason: "is not a finite number — ignoring it" },
      { key: "activity.nope", reason: "is not a known weight — ignoring it" },
    ]);
    expect(parseActivityWeights("nope").warnings).toEqual([
      { key: "activity", reason: "is not an object — ignoring it" },
    ]);
  });

  test("an unknown key warns rather than passing silently", () => {
    const { weights, warnings } = parseActivityWeights({ hubPenalty: 0, hubPenatly: 90 });
    expect(weights.hubPenalty).toBe(0);
    expect(warnings).toEqual([
      { key: "activity.hubPenatly", reason: "is not a known weight — ignoring it" },
    ]);
  });

  test("the parsed weights really drive the ranking", () => {
    // hubPenalty 0 turns the hub discount off, which flips the pair the default
    // weights order the other way.
    const leaf = page({ relPath: "leaf.md", createdDaysAgo: 40, updatedDaysAgo: 0.5, title: "Zzz leaf" });
    const hub = page({
      relPath: "hub.md",
      createdDaysAgo: 40,
      updatedDaysAgo: 0.5,
      backlinkCount: 25,
      title: "Aaa hub",
    });
    expect(relOrder([hub, leaf])).toEqual(["leaf.md", "hub.md"]);
    const off = parseActivityWeights({ hubPenalty: 0, rows: 12 }).weights;
    expect(relOrder([hub, leaf], off)).toEqual(["hub.md", "leaf.md"]);
  });
});

/** A gate in either state, with the counts a test is not asserting about left
 *  at whatever the flag implies. `rankActivity` reads only `open`. */
const gate = (open: boolean): WorkedGate => ({
  open,
  candidates: open ? 1 : 0,
  covered: open ? 1 : 0,
  coverage: open ? 1 : 0,
});
const OPEN = gate(true);
const CLOSED = gate(false);

describe("rankActivity — the WORKED term", () => {
  /** An ordinary changed page: old enough that the age discount bites, recently
   *  touched, no backlinks and no type boost. Everything below varies exactly
   *  one thing about it. */
  const changed = (over: { relPath: string; workedDaysAgo?: number; title?: string }) =>
    page({ createdDaysAgo: 40, updatedDaysAgo: 2, ...over });

  test("a worked date NEWER than the change takes the row and relabels it", () => {
    const [row] = rankActivity([changed({ relPath: "a.md", workedDaysAgo: 0.25 })], wide, NOW, OPEN);
    expect(row!.kind).toBe("worked");
    // The age is the WORKED stamp's, not the change's — the row's date cell
    // reads `now - ageMs`, so a mismatch here shows a day nothing happened on.
    expect(row!.ageMs).toBe(0.25 * DAY);
  });

  test("a worked date OLDER than the change leaves the row exactly as it was", () => {
    const p = changed({ relPath: "a.md", workedDaysAgo: 30 });
    expect(rankActivity([p], wide, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
  });

  test("an EQUAL worked score does not displace the winner — the rule is a strict `>`", () => {
    // Same day as the change, and `workedWeight` defaults to `changedWeight` on
    // the same half-life, so the two terms come out identical to the last bit.
    const p = changed({ relPath: "a.md", workedDaysAgo: 2 });
    const [open] = rankActivity([p], wide, NOW, OPEN);
    const [closed] = rankActivity([p], wide, NOW, CLOSED);
    expect(open!.score).toBe(closed!.score);
    expect(open!.kind).toBe("changed");
    expect(open!.why).toBe(closed!.why);
  });

  test("⚠ an UNCOVERED page gets NO worked score — it does not fall back to the update signal", () => {
    // The trap this whole feature turns on: `workedSignal`/`pageDateSignal(…,
    // "worked")` fall back to the UPDATE signal, so a term reading the page
    // through either would score every uncovered page a second copy of its
    // change term — the term would look like it works and the gate would be
    // measuring nothing.
    //
    // Driven with the worked knob turned up far past the change knob, which is
    // what makes a fallback VISIBLE: under a fallback this page's score would
    // jump by 100/10, and it must not move at all.
    const loud: ActivityWeights = { ...wide, changedWeight: 10, workedWeight: 100 };
    const uncovered = changed({ relPath: "a.md" });
    expect(uncovered.workedMs).toBeUndefined();
    expect(rankActivity([uncovered], loud, NOW, OPEN)).toEqual(
      rankActivity([uncovered], loud, NOW, CLOSED),
    );
  });

  test("the term does not run at all without an OPEN gate", () => {
    const p = changed({ relPath: "a.md", workedDaysAgo: 0.25 });
    // The three spellings of "closed": no gate at all (every pre-existing
    // caller), an explicit closed one, and a wiki that zeroed the knob.
    const off: ActivityWeights = { ...wide, workedWeight: 0 };
    expect(rankActivity([p], wide, NOW)).toEqual(rankActivity([p], wide, NOW, CLOSED));
    expect(rankActivity([p], wide, NOW, null)).toEqual(rankActivity([p], wide, NOW, CLOSED));
    expect(rankActivity([p], off, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
  });

  test("the `why` sentence is the worked score's own derivation", () => {
    const p = page({
      relPath: "p.md",
      createdDaysAgo: 30,
      updatedDaysAgo: 20,
      workedDaysAgo: 1,
      backlinkCount: 5,
      type: "plan",
      plan_status: "in-flight",
    });
    const [row] = rankActivity([p], wide, NOW, OPEN);
    expect(row!.kind).toBe("worked");
    expect(row!.why).toBe(
      "worked 1d ago, created 30d ago: " +
        "weight ×0.70, recency 0.79, age ×0.63, hub ×0.63 (5←), type ×1.60 → 0.35",
    );
    // …and it really multiplies out to the score printed at the end of it:
    // 0.70 × 2^-(1/3) × 1/(1+0.6) × 1/(1+0.6) × 1.6.
    expect(0.7 * Math.pow(0.5, 1 / 3) * 0.625 * 0.625 * 1.6).toBeCloseTo(row!.score, 12);
  });

  test("a worked stamp in the FUTURE is ignored, like every other date signal", () => {
    // A ledger stamp comes from whatever clock wrote the transcript. Past the
    // 48h skew window it is not a date, and clamping it to now would invent a
    // write that never happened.
    const p = changed({ relPath: "a.md", workedDaysAgo: -7 });
    expect(rankActivity([p], wide, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
    // Inside the window it is skew, and it counts.
    const skewed = changed({ relPath: "b.md", workedDaysAgo: -1 });
    expect(rankActivity([skewed], wide, NOW, OPEN)[0]!.kind).toBe("worked");
  });

  test("an open gate can lift a page the floor drops today — which is the point", () => {
    // Created and last touched long enough ago that both terms are far under
    // `ACTIVITY_MIN_SCORE`; a session wrote it this morning.
    const stale = page({ relPath: "old.md", createdDaysAgo: 400, updatedDaysAgo: 300, workedDaysAgo: 0.5 });
    expect(rankActivity([stale], wide, NOW, CLOSED)).toEqual([]);
    const [row] = rankActivity([stale], wide, NOW, OPEN);
    expect(row!.kind).toBe("worked");
    expect(row!.score).toBeGreaterThanOrEqual(ACTIVITY_MIN_SCORE);
  });

  test("the glyph map covers every kind and spells three different marks", () => {
    // The row renders `ACTIVITY_GLYPH[kind]`, so a missing entry is a blank slot
    // rather than a type error at the call site.
    expect(Object.keys(ACTIVITY_GLYPH).sort()).toEqual(["changed", "new", "worked"]);
    expect(new Set(Object.values(ACTIVITY_GLYPH)).size).toBe(3);
  });
});

describe("workedGateFor", () => {
  /** A page that clears the floor on its CHANGE term alone, so it is a candidate
   *  whatever the worked term does. */
  const candidate = (relPath: string, workedDaysAgo?: number) =>
    page({ relPath, createdDaysAgo: 40, updatedDaysAgo: 1, ...(workedDaysAgo === undefined ? {} : { workedDaysAgo }) });

  test("coverage is measured over the CANDIDATE set, not the listing", () => {
    // Ten pages, two of them candidates — and the eight below the floor are
    // covered while the two candidates are not. Over the listing that reads 80%;
    // over the rows the section would show it is 0%, which is the honest number.
    const sunk = Array.from({ length: 8 }, (_, i) =>
      page({ relPath: `sunk-${i}.md`, createdDaysAgo: 500, updatedDaysAgo: 400, workedDaysAgo: 1 }),
    );
    const g = workedGateFor([...sunk, candidate("a.md"), candidate("b.md")], wide, NOW);
    expect(g).toEqual({ open: false, candidates: 2, covered: 0, coverage: 0 });
  });

  test("a page that only clears the floor WITH the term is not a candidate", () => {
    // Non-circularity: pass 1 runs with the term forced OFF, so the very pages
    // the term would admit cannot pad the denominator that decides whether it
    // may run.
    const lifted = page({ relPath: "old.md", createdDaysAgo: 400, updatedDaysAgo: 300, workedDaysAgo: 0.5 });
    expect(workedGateFor([lifted], wide, NOW)).toEqual({
      open: false,
      candidates: 0,
      covered: 0,
      coverage: 0,
    });
    // …and it really is a page the open term would rank.
    expect(rankActivity([lifted], wide, NOW, OPEN)).toHaveLength(1);
  });

  test("zero candidates is coverage 0, not 0/0", () => {
    const dormant = page({ relPath: "a.md", createdDaysAgo: 900, updatedDaysAgo: 800, workedDaysAgo: 1 });
    const g = workedGateFor([dormant], wide, NOW);
    expect(g.coverage).toBe(0);
    expect(g.open).toBe(false);
  });

  test("bookkeeping pages are excluded, exactly as the ranking excludes them", () => {
    const meta = page({ relPath: "log.md", createdDaysAgo: 40, updatedDaysAgo: 1 });
    const g = workedGateFor([meta, candidate("a.md", 1)], wide, NOW);
    expect(g).toEqual({ open: true, candidates: 1, covered: 1, coverage: 1 });
  });

  test("the threshold is a floor, not a strict majority", () => {
    const set = (covered: number, total: number) =>
      Array.from({ length: total }, (_, i) =>
        candidate(`p-${i}.md`, i < covered ? 1 : undefined),
      );
    // The literal, not the constant: a change to the threshold has to fail a
    // case rather than follow itself.
    expect(WORKED_GATE_MIN_COVERAGE).toBe(0.6);
    expect(workedGateFor(set(6, 10), wide, NOW)).toMatchObject({ coverage: 0.6, open: true });
    expect(workedGateFor(set(5, 10), wide, NOW)).toMatchObject({ coverage: 0.5, open: false });
  });

  test("a wiki that zeroed the knob keeps the gate shut however covered it is", () => {
    const off: ActivityWeights = { ...wide, workedWeight: 0 };
    const g = workedGateFor([candidate("a.md", 1), candidate("b.md", 1)], off, NOW);
    // The coverage is still reported honestly — only the verdict is no.
    expect(g).toEqual({ open: false, candidates: 2, covered: 2, coverage: 1 });
  });

  test("it is pure: same answer twice, and the pages are untouched", () => {
    const pages = [candidate("a.md", 1), candidate("b.md")];
    const snapshot = JSON.stringify(pages);
    expect(workedGateFor(pages, wide, NOW)).toEqual(workedGateFor(pages, wide, NOW));
    expect(JSON.stringify(pages)).toBe(snapshot);
  });
});

describe("a CLOSED gate is the pre-worked ranking, byte for byte", () => {
  /** Six pages spanning every branch the ranking has — a creation, three kinds
   *  of change (plain, type-boosted plan, hub-discounted), a blog, and one page
   *  far under the floor — each carrying a worked stamp that WOULD move it. */
  const FIXTURE: WikiListing[] = [
    page({ relPath: "notes/new.md", title: "A new note", createdDaysAgo: 1, workedDaysAgo: 5 }),
    page({ relPath: "notes/changed.md", title: "B changed note", createdDaysAgo: 40, updatedDaysAgo: 1, workedDaysAgo: 0.25 }),
    page({ relPath: "plans/live.md", title: "C live plan", createdDaysAgo: 20, updatedDaysAgo: 2, type: "plan", plan_status: "in-flight", workedDaysAgo: 9 }),
    page({ relPath: "concepts/hub.md", title: "D hub", createdDaysAgo: 30, updatedDaysAgo: 1, backlinkCount: 12 }),
    page({ relPath: "blogs/post.md", title: "E blog", createdDaysAgo: 60, updatedDaysAgo: 3, type: "blog", workedDaysAgo: 1 }),
    page({ relPath: "notes/dormant.md", title: "F dormant", createdDaysAgo: 400, updatedDaysAgo: 300, workedDaysAgo: 0.5 }),
  ];

  /**
   * What `origin/main`'s `rankActivity` answers for `FIXTURE` — generated by
   * running THAT module (`git show origin/main:…/wiki-activity-rank.ts`) over
   * these pages, not by copying this one's output.
   *
   * A row count would not have caught the failure this pins: the `age`/`hub`/
   * `boost` factors moved out of the change branch to be shared with the worked
   * term, and a transcription slip there changes a `why` string and a score
   * while leaving the section exactly six rows long.
   */
  const BEFORE: Array<Pick<ActivityRow, "kind" | "score" | "why" | "ageMs"> & { relPath: string }> = [
    { relPath: "notes/new.md", kind: "new", score: 0.8705505632961241, why: "created 1d ago → 0.87", ageMs: 86400000 },
    {
      relPath: "plans/live.md",
      kind: "changed",
      score: 0.5039684199579492,
      why: "changed 2d ago, created 20d ago: weight ×0.70, recency 0.63, age ×0.71, hub ×1.00 (0←), type ×1.60 → 0.50",
      ageMs: 172800000,
    },
    {
      relPath: "notes/changed.md",
      kind: "changed",
      score: 0.30866131566048327,
      why: "changed 1d ago, created 40d ago: weight ×0.70, recency 0.79, age ×0.56, hub ×1.00 (0←), type ×1.00 → 0.31",
      ageMs: 86400000,
    },
    {
      relPath: "blogs/post.md",
      kind: "changed",
      score: 0.17500000000000002,
      why: "changed 3d ago, created 60d ago: weight ×0.70, recency 0.50, age ×0.45, hub ×1.00 (0←), type ×1.10 → 0.18",
      ageMs: 259200000,
    },
    {
      relPath: "concepts/hub.md",
      kind: "changed",
      score: 0.1423131066057556,
      why: "changed 1d ago, created 30d ago: weight ×0.70, recency 0.79, age ×0.63, hub ×0.41 (12←), type ×1.00 → 0.14",
      ageMs: 86400000,
    },
  ];

  const shape = (w: ActivityWeights, g?: WorkedGate | null) =>
    rankActivity(FIXTURE, w, NOW, g).map((r) => ({
      relPath: r.page.relPath,
      kind: r.kind,
      score: r.score,
      why: r.why,
      ageMs: r.ageMs,
    }));

  test("no gate, a closed gate and a zeroed knob all answer what main answered", () => {
    expect(shape(wide)).toEqual(BEFORE);
    expect(shape(wide, CLOSED)).toEqual(BEFORE);
    expect(shape({ ...wide, workedWeight: 0 }, OPEN)).toEqual(BEFORE);
  });

  test("…and an OPEN gate moves it — so the case above is not passing by accident", () => {
    const g = workedGateFor(FIXTURE, wide, NOW);
    expect(g).toEqual({ open: true, candidates: 5, covered: 4, coverage: 0.8 });
    const after = shape(wide, g);
    // Three rows relabel to `worked`, one of them (`dormant`) admitted by the
    // term from under the floor, and the order changes with them.
    expect(after.map((r) => r.relPath)).toEqual([
      "notes/new.md",
      "plans/live.md",
      "notes/changed.md",
      "blogs/post.md",
      "concepts/hub.md",
      "notes/dormant.md",
    ]);
    expect(after.filter((r) => r.kind === "worked").map((r) => r.relPath)).toEqual([
      "notes/changed.md",
      "blogs/post.md",
      "notes/dormant.md",
    ]);
  });
});
