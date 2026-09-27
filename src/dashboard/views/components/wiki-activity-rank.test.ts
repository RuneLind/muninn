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
  ACTIVITY_ROWS_MAX,
  ACTIVITY_ROWS_MIN,
  DEFAULT_ACTIVITY_WEIGHTS,
  formatRailAge,
  parseActivityWeights,
  RAIL_AGE_MAX_DAYS,
  rankActivity,
  workedGateFor,
  type ActivityWeights,
  type WorkedGate,
} from "./wiki-activity-rank.ts";
import { isUsableWorkedMs, localDay, workedSignal, type WikiListing } from "./wiki-filter.ts";

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
  /** `workedMs` — the day a session last wrote the page (claude-usage's ledger). */
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
      ["halfLifeNewDays", 0],
      ["halfLifeChangedDays", 400],
      ["rows", "4"],
      ["workedGate", 101],
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

/** A gate verdict by hand, for cases about what an open or closed gate DOES
 *  rather than about how one is measured. */
const OPEN: WorkedGate = { open: true, candidates: 1, covered: 1, coverage: 1, asOfMs: NOW };
const CLOSED: WorkedGate = { open: false, candidates: 1, covered: 0, coverage: 0, asOfMs: NOW };

describe("rankActivity — worked-on substitution", () => {
  test("a worked date OLDER than the update stamp demotes the page", () => {
    // The sweep shape: git says 12h ago, the last session wrote it 5 days ago.
    const swept = page({ relPath: "a-swept.md", createdDaysAgo: 40, updatedDaysAgo: 0.5, workedDaysAgo: 5 });
    const real = page({ relPath: "b-real.md", createdDaysAgo: 40, updatedDaysAgo: 2 });
    expect(rankActivity([swept, real], wide, NOW, CLOSED).map((r) => r.page.relPath)).toEqual([
      "a-swept.md",
      "b-real.md",
    ]);
    const rows = rankActivity([swept, real], wide, NOW, OPEN);
    expect(rows.map((r) => r.page.relPath)).toEqual(["b-real.md", "a-swept.md"]);
    const demoted = rows[1]!;
    expect(demoted.kind).toBe("changed");
    expect(demoted.worked).toBe(true);
    expect(demoted.why).toStartWith("worked on 5d ago, created 40d ago: ");
    expect(demoted.ageMs).toBe(5 * DAY);
  });

  test("a worked date NEWER than the update stamp promotes the page", () => {
    const stale = page({ relPath: "a-stale.md", createdDaysAgo: 40, updatedDaysAgo: 6, workedDaysAgo: 0.5 });
    const real = page({ relPath: "b-real.md", createdDaysAgo: 40, updatedDaysAgo: 2 });
    expect(relOrder([stale, real])).toEqual(["b-real.md", "a-stale.md"]);
    expect(rankActivity([stale, real], wide, NOW, OPEN).map((r) => r.page.relPath)).toEqual([
      "a-stale.md",
      "b-real.md",
    ]);
  });

  test("a worked change is not discounted for the page's age", () => {
    // The live mimir shape (2026-09-26): a 21-day-old shipped plan worked 6h
    // ago, 2 backlinks, against a page created 4 days ago. With the age penalty
    // the plan scored 0.49 against the creation's 0.57 and fell out of Activity.
    const plan = page({
      relPath: "plans/review.mdx",
      createdDaysAgo: 21,
      updatedDaysAgo: 0.25,
      workedDaysAgo: 0.25,
      backlinkCount: 2,
      type: "plan",
      plan_status: "shipped",
    });
    const created = page({ relPath: "blogs/new.mdx", createdDaysAgo: 4, type: "blog" });
    const rows = rankActivity([plan, created], wide, NOW, OPEN);
    expect(rows.map((r) => r.page.relPath)).toEqual(["plans/review.mdx", "blogs/new.mdx"]);
    expect(rows[0]!.why).toContain("age ×1.00 (worked)");
    // The same page on git dates alone keeps the penalty.
    expect(rankActivity([plan], wide, NOW, CLOSED)[0]!.why).toContain("age ×0.70,");
  });

  test("the session's own commit, seconds after the worked stamp, is no demotion", () => {
    // Git touch 2 s after the ledger write: the commit that closed the session.
    const p = page({ relPath: "p.md", createdDaysAgo: 40, workedDaysAgo: 0.5 });
    p.gitTouchedMs = p.workedMs! + 2_000;
    const row = rankActivity([p], wide, NOW, OPEN)[0]!;
    expect(row.worked).toBe(true);
    expect(row.why).toContain("age ×1.00 (worked)");
  });

  test("a demotion keeps the age penalty — the waiver never lifts a set-aside page", () => {
    // Update a full day past the worked stamp: the penalty is whole again.
    const p = page({ relPath: "p.md", createdDaysAgo: 40, updatedDaysAgo: 4, workedDaysAgo: 5 });
    const row = rankActivity([p], wide, NOW, OPEN)[0]!;
    expect(row.worked).toBe(true);
    expect(row.why).not.toContain("(worked)");
    expect(row.score).toBeLessThan(rankActivity([p], wide, NOW, CLOSED)[0]!.score);
  });

  test("the waiver tapers with the commit's lag — no cliff at a day", () => {
    const lagged = (hours: number): WikiListing => {
      const p = page({ relPath: "p.md", createdDaysAgo: 100, workedDaysAgo: 2 });
      p.gitTouchedMs = p.workedMs! + hours * 3_600_000;
      return p;
    };
    const score = (hours: number): number => rankActivity([lagged(hours)], wide, NOW, OPEN)[0]!.score;
    // Measured on the pre-taper cutoff: 23h scored 0.550, 25h 0.180.
    expect(Math.abs(score(23) - score(25))).toBeLessThan(0.05);
    // Monotone: a later commit keeps more of the penalty.
    expect(score(1)).toBeGreaterThan(score(12));
    expect(score(12)).toBeGreaterThan(score(23));
  });

  test("a commit newer than the ledger's answer keeps the waiver", () => {
    // Ledger write 5 min ago, commit 4 min ago, ledger answered 1 min ago: the
    // update sits inside WORKED_INGEST_SLACK_MS, so the change decays on the git
    // stamp — but that stamp is the session's own commit, not an old-page touch.
    const p = page({ relPath: "plans/p.mdx", createdDaysAgo: 100, type: "plan", plan_status: "shipped" });
    p.workedMs = NOW - 5 * 60_000;
    p.gitTouchedMs = NOW - 4 * 60_000;
    const gate: WorkedGate = { ...OPEN, asOfMs: NOW - 60_000 };
    const row = rankActivity([p], wide, NOW, gate)[0]!;
    expect(row.worked).toBeUndefined();
    expect(row.why).toContain("age ×1.00 (worked)");
    expect(row.score).toBeGreaterThan(0.7);
  });

  test("no `(worked)` label when the age penalty is off", () => {
    const p = page({ relPath: "p.md", createdDaysAgo: 40, workedDaysAgo: 0.5 });
    p.gitTouchedMs = p.workedMs! + 2_000;
    const row = rankActivity([p], { ...wide, agePenalty: 0 }, NOW, OPEN)[0]!;
    expect(row.why).toContain("age ×1.00,");
  });

  test("an `added`-floor page gains a change term: a ledger write is a known edit", () => {
    // No touch date: the update signal is the git floor, kind `added`, so today
    // the page has no change term and its 30-day-old creation is under the floor.
    const floor = page({ relPath: "concepts/floor.md", createdDaysAgo: 30, updatedDaysAgo: null, workedDaysAgo: 0.5 });
    expect(rankActivity([floor], wide, NOW, CLOSED)).toEqual([]);
    const rows = rankActivity([floor], wide, NOW, OPEN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("changed");
    expect(rows[0]!.worked).toBe(true);
    expect(rows[0]!.why).toStartWith("worked on 12h ago, ");
  });

  test("a worked date within a day of creation mints no change — the creating session", () => {
    // The live mimir shape: a session wrote the page on day 1 and a sweep bumped
    // git yesterday. The change term disappears and the row reads as new.
    const p = page({ relPath: "plans/p.mdx", createdDaysAgo: 5, updatedDaysAgo: 1, workedDaysAgo: 4.9 });
    expect(rankActivity([p], wide, NOW, CLOSED)[0]!.kind).toBe("changed");
    const row = rankActivity([p], wide, NOW, OPEN)[0]!;
    expect(row.kind).toBe("new");
    expect(row.worked).toBeUndefined();
    expect(row.why).toStartWith("created 5d ago");
  });

  test("an uncovered page ranks exactly as it did", () => {
    const uncovered = page({ relPath: "u.md", createdDaysAgo: 40, updatedDaysAgo: 0.5 });
    expect(rankActivity([uncovered], wide, NOW, OPEN)).toEqual(rankActivity([uncovered], wide, NOW, CLOSED));
    expect("worked" in rankActivity([uncovered], wide, NOW, OPEN)[0]!).toBe(false);
  });

  test("an implausibly FUTURE worked stamp is ignored, like every other date signal", () => {
    const p = page({ relPath: "f.md", createdDaysAgo: 40, updatedDaysAgo: 4, workedDaysAgo: -5 });
    expect(rankActivity([p], wide, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
  });
});

/**
 * Pinned against output of the implementation BEFORE the gate existed (45f8bff7):
 * this fixture run through that file's `rankActivity` at default weights, rows 20,
 * serialised. Every page but three carries a `workedMs`, so a closed gate that
 * leaked the field anywhere — a score, a `why`, a key — fails here.
 */
describe("rankActivity — a closed gate is the pre-gate ranking, byte for byte", () => {
  const specs: Parameters<typeof page>[0][] = [
    { relPath: "new/fresh.md", createdDaysAgo: 0.5, workedDaysAgo: 0.5 },
    { relPath: "new/older.md", createdDaysAgo: 9 },
    { relPath: "changed/leaf.md", createdDaysAgo: 40, updatedDaysAgo: 0.5, workedDaysAgo: 6 },
    { relPath: "changed/hub.md", createdDaysAgo: 40, updatedDaysAgo: 1, backlinkCount: 25, workedDaysAgo: 0.25 },
    { relPath: "changed/old.md", createdDaysAgo: 80, updatedDaysAgo: 2 },
    { relPath: "plans/live.mdx", createdDaysAgo: 20, updatedDaysAgo: 3, type: "plan", plan_status: "in-flight", workedDaysAgo: 12 },
    { relPath: "plans/done.mdx", createdDaysAgo: 20, updatedDaysAgo: 3, type: "plan", plan_status: "shipped" },
    { relPath: "blogs/post.mdx", createdDaysAgo: 15, updatedDaysAgo: 2, type: "blog", workedDaysAgo: 2 },
    { relPath: "concepts/swept.md", createdDaysAgo: 5, updatedDaysAgo: null, birthtimeDaysAgo: 20, workedDaysAgo: 1 },
    { relPath: "concepts/floor-old.md", createdDaysAgo: 30, updatedDaysAgo: null, workedDaysAgo: 0.5 },
    { relPath: "notes/only-mtime.md", mtimeDaysAgo: 1 / 24, workedDaysAgo: 3 },
    { relPath: "notes/authored.md", createdDaysAgo: 12, updatedDaysAgo: 1.5, createdFm: "2026-08-20" },
    { relPath: "notes/future-worked.md", createdDaysAgo: 30, updatedDaysAgo: 4, workedDaysAgo: -5 },
    { relPath: "notes/same-session.md", createdDaysAgo: 6, updatedDaysAgo: 0.5, workedDaysAgo: 5.8 },
    { relPath: "notes/dormant.md", createdDaysAgo: 60, updatedDaysAgo: 30, workedDaysAgo: 0.5 },
    { relPath: "log.md", createdDaysAgo: 90, updatedDaysAgo: 0.01, workedDaysAgo: 0.01 },
    { relPath: "nothing.md" },
  ];
  const BASELINE = [
    { relPath: "new/fresh.md", kind: "new", score: 0.9330329915368074, why: "created 12h ago → 0.93", ageMs: 43200000 },
    { relPath: "notes/only-mtime.md", kind: "changed", score: 0.6932934032267783, why: "changed 1h ago, created ?: weight ×0.70, recency 0.99, age ×1.00, hub ×1.00 (0←), type ×1.00 → 0.69", ageMs: 3600000 },
    { relPath: "notes/same-session.md", kind: "changed", score: 0.556811698837712, why: "changed 12h ago, created 6d ago: weight ×0.70, recency 0.89, age ×0.89, hub ×1.00 (0←), type ×1.00 → 0.56", ageMs: 43200000 },
    { relPath: "plans/live.mdx", kind: "changed", score: 0.4, why: "changed 3d ago, created 20d ago: weight ×0.70, recency 0.50, age ×0.71, hub ×1.00 (0←), type ×1.60 → 0.40", ageMs: 259200000 },
    { relPath: "blogs/post.mdx", kind: "changed", score: 0.37313046477655853, why: "changed 2d ago, created 15d ago: weight ×0.70, recency 0.63, age ×0.77, hub ×1.00 (0←), type ×1.10 → 0.37", ageMs: 172800000 },
    { relPath: "changed/leaf.md", kind: "changed", score: 0.34646061261013195, why: "changed 12h ago, created 40d ago: weight ×0.70, recency 0.89, age ×0.56, hub ×1.00 (0←), type ×1.00 → 0.35", ageMs: 43200000 },
    { relPath: "notes/authored.md", kind: "changed", score: 0.3367175148507369, why: "changed 2d ago, created 24d ago: weight ×0.70, recency 0.71, age ×0.68, hub ×1.00 (0←), type ×1.00 → 0.34", ageMs: 129600000 },
    { relPath: "plans/done.mdx", kind: "changed", score: 0.325, why: "changed 3d ago, created 20d ago: weight ×0.70, recency 0.50, age ×0.71, hub ×1.00 (0←), type ×1.30 → 0.33", ageMs: 259200000 },
    { relPath: "new/older.md", kind: "new", score: 0.2871745887492587, why: "created 9d ago → 0.29", ageMs: 777600000 },
    { relPath: "notes/future-worked.md", kind: "changed", score: 0.17362199005902185, why: "changed 4d ago, created 30d ago: weight ×0.70, recency 0.40, age ×0.63, hub ×1.00 (0←), type ×1.00 → 0.17", ageMs: 345600000 },
    { relPath: "changed/old.md", kind: "changed", score: 0.16960475671661757, why: "changed 2d ago, created 80d ago: weight ×0.70, recency 0.63, age ×0.38, hub ×1.00 (0←), type ×1.00 → 0.17", ageMs: 172800000 },
    { relPath: "changed/hub.md", kind: "changed", score: 0.07716532891512082, why: "changed 1d ago, created 40d ago: weight ×0.70, recency 0.79, age ×0.56, hub ×0.25 (25←), type ×1.00 → 0.08", ageMs: 86400000 },
    { relPath: "concepts/swept.md", kind: "new", score: 0.0625, why: "created 20d ago → 0.06", ageMs: 1728000000 },
  ];
  // JSON, not `toEqual`: `toEqual` ignores a key whose value is undefined, and
  // key order is part of "byte for byte".
  const serialise = (rows: ReturnType<typeof rankActivity>): string =>
    JSON.stringify(rows.map(({ page: p, ...r }) => ({ relPath: p.relPath, ...r })));
  const pages = specs.map(page);

  test("no gate, a null gate, and a closed gate all reproduce the baseline", () => {
    for (const gate of [undefined, null, CLOSED]) {
      const rows = rankActivity(pages, wide, NOW, gate);
      expect(serialise(rows)).toBe(JSON.stringify(BASELINE));
      // `JSON.stringify` drops a `worked: undefined` key; `in` does not.
      expect(rows.every((r) => !("worked" in r))).toBe(true);
    }
  });

  test("…and so does this fixture's own gate at 100, which it cannot meet", () => {
    const w = { ...wide, workedGate: 100 };
    const gate = workedGateFor(pages, w, NOW);
    expect(gate.open).toBe(false);
    expect(serialise(rankActivity(pages, w, NOW, gate))).toBe(JSON.stringify(BASELINE));
  });

  test("the same fixture with the gate OPEN does move — the pair cannot pass vacuously", () => {
    expect(serialise(rankActivity(pages, wide, NOW, OPEN))).not.toBe(JSON.stringify(BASELINE));
  });
});

describe("workedGateFor — the coverage gate", () => {
  /** `n` changed candidates, the first `covered` of them with a worked date. */
  const listing = (n: number, covered: number): WikiListing[] =>
    Array.from({ length: n }, (_, i) =>
      page({
        relPath: `p${i}.md`,
        createdDaysAgo: 40,
        updatedDaysAgo: 1,
        ...(i < covered ? { workedDaysAgo: 2 } : {}),
      }),
    );
  const at = (workedGate: number, n: number, covered: number): WorkedGate =>
    workedGateFor(listing(n, covered), { ...wide, workedGate }, NOW);

  test("the default is 60", () => {
    expect(DEFAULT_ACTIVITY_WEIGHTS.workedGate).toBe(60);
  });

  test("the boundary is inclusive and exact: 3 of 5 is 60%", () => {
    expect(at(60, 5, 3)).toEqual({ open: true, candidates: 5, covered: 3, coverage: 0.6 });
    expect(at(61, 5, 3).open).toBe(false);
    expect(at(60, 5, 2).open).toBe(false);
  });

  test("an .html candidate is not in the denominator — the ledger never covers one", () => {
    const pages = [...listing(2, 1), page({ relPath: "x.html", createdDaysAgo: 40, updatedDaysAgo: 1 })];
    expect(workedGateFor(pages, wide, NOW)).toMatchObject({ candidates: 2, covered: 1, coverage: 0.5 });
  });

  test("an .mdx candidate IS in the denominator, covered or not", () => {
    const pages = [
      ...listing(2, 1),
      page({ relPath: "plans/x.mdx", createdDaysAgo: 40, updatedDaysAgo: 1, workedDaysAgo: 2 }),
      page({ relPath: "plans/y.mdx", createdDaysAgo: 40, updatedDaysAgo: 1 }),
    ];
    expect(workedGateFor(pages, wide, NOW)).toMatchObject({ candidates: 4, covered: 2 });
  });

  test("an `added`-floor page whose only worked date is its arrival is not covered", () => {
    // The rank will not substitute it (see the `added`-floor block), so the gate
    // must not count it toward opening.
    const createdFm = new Date(ago(21)).toISOString().slice(0, 10);
    const moved = page({ relPath: "moved.md", createdFm, createdDaysAgo: 3, updatedDaysAgo: null, workedDaysAgo: 3 });
    expect(workedGateFor([moved, ...listing(1, 1)], wide, NOW)).toMatchObject({ candidates: 2, covered: 1 });
  });

  test("the ledger's answer time rides out, clamped to now; a future one is refused", () => {
    expect(workedGateFor(listing(2, 1), wide, NOW, ago(1)).asOfMs).toBe(ago(1));
    expect(workedGateFor(listing(2, 1), wide, NOW, NOW + 60_000).asOfMs).toBe(NOW);
    expect(workedGateFor(listing(2, 1), wide, NOW, NOW + 30 * DAY).asOfMs).toBeUndefined();
    expect(workedGateFor(listing(2, 1), wide, NOW).asOfMs).toBeUndefined();
  });

  test("0 opens wherever anything could substitute; 100 needs every candidate covered", () => {
    expect(at(0, 5, 0).open).toBe(true);
    expect(at(0, 0, 0).open).toBe(true);
    expect(at(100, 5, 4).open).toBe(false);
    expect(at(100, 5, 5).open).toBe(true);
  });

  test("no candidates is coverage 0, closed at any gate above 0", () => {
    expect(at(1, 0, 0)).toEqual({ open: false, candidates: 0, covered: 0, coverage: 0 });
  });

  test("monotone across the whole range", () => {
    for (const [n, covered] of [[5, 3], [7, 2], [3, 3], [4, 0]] as const) {
      let wasOpen = true;
      for (let g = 0; g <= 100; g++) {
        const open = at(g, n, covered).open;
        // Once shut, a higher gate never re-opens.
        if (!wasOpen) expect(open).toBe(false);
        wasOpen = open;
      }
    }
  });

  test("the denominator is the RANKED candidates — not meta pages, not rows under the floor", () => {
    const pages = [
      ...listing(2, 1),
      page({ relPath: "log.md", createdDaysAgo: 40, updatedDaysAgo: 0.1 }),
      page({ relPath: "dormant.md", createdDaysAgo: 200, updatedDaysAgo: 100, workedDaysAgo: 100 }),
    ];
    expect(workedGateFor(pages, wide, NOW)).toMatchObject({ candidates: 2, covered: 1 });
  });

  test("candidates are counted with substitution OFF", () => {
    // Under the floor today; substitution would lift it in. It must not count
    // itself into the denominator that decides whether it gets lifted.
    const floor = page({ relPath: "floor.md", createdDaysAgo: 30, updatedDaysAgo: null, workedDaysAgo: 0.5 });
    expect(workedGateFor([...listing(2, 0), floor], wide, NOW)).toMatchObject({ candidates: 2, covered: 0 });
  });

  test("reads `workedMs` itself — an uncovered page does not count as covered", () => {
    // `workedSignal` falls back to the update signal; read through it, this
    // listing would measure 100%.
    expect(at(60, 4, 0).covered).toBe(0);
  });

  test("measured over the full listing, the verdict holds on any filtered subset", () => {
    // The facet the reader picked holds one covered page of three (33%), under
    // the gate on its own; the wiki as a whole is at 75%.
    const facet = listing(3, 1).map((p) => ({ ...p, relPath: "facet/" + p.relPath }));
    const rest = listing(9, 8);
    // The ledger answered now, so the 2-day worked dates may demote.
    const gate = workedGateFor([...facet, ...rest], wide, NOW, NOW);
    expect(gate.open).toBe(true);
    expect(workedGateFor(facet, wide, NOW).open).toBe(false);
    const rows = rankActivity(facet, wide, NOW, gate);
    expect(rows.filter((r) => r.worked).map((r) => r.page.relPath)).toEqual(["facet/p0.md"]);
  });
});

describe("parseActivityWeights — workedGate", () => {
  test("an in-range value is kept, both ends included", () => {
    for (const v of [0, 45, 100]) {
      expect(parseActivityWeights({ workedGate: v })).toEqual({
        weights: { ...DEFAULT_ACTIVITY_WEIGHTS, workedGate: v },
        warnings: [],
      });
    }
  });

  test("out of range or the wrong type ⇒ the default, with its sibling knobs' warnings", () => {
    expect(parseActivityWeights({ workedGate: 101 })).toEqual({
      weights: DEFAULT_ACTIVITY_WEIGHTS,
      warnings: [{ key: "activity.workedGate", reason: "is outside 0–100 — ignoring it" }],
    });
    expect(parseActivityWeights({ workedGate: -1 }).weights.workedGate).toBe(60);
    // A fraction is refused, not rounded: the gate compares integers.
    expect(parseActivityWeights({ workedGate: 64.4 })).toEqual({
      weights: DEFAULT_ACTIVITY_WEIGHTS,
      warnings: [{ key: "activity.workedGate", reason: "is not a whole number — ignoring it" }],
    });
    expect(parseActivityWeights({ workedGate: "60" })).toEqual({
      weights: DEFAULT_ACTIVITY_WEIGHTS,
      warnings: [{ key: "activity.workedGate", reason: "is not a finite number — ignoring it" }],
    });
  });
});

describe("rankActivity — demotion is bounded by when the ledger answered", () => {
  // The sweep shape: git after the last session. An update the ledger had
  // time to see is a bulk pass or a writer it cannot see, and the page demotes;
  // an update newer than the ledger's answer cannot be judged by it.
  const swept = (updatedDaysAgo: number) =>
    page({ relPath: "s.md", createdDaysAgo: 40, updatedDaysAgo, workedDaysAgo: 5 });
  const gateAsOf = (asOfMs: number | undefined): WorkedGate => ({ ...OPEN, asOfMs });
  const MIN = 60_000;

  test("an update the ledger had time to see is set aside, however recent", () => {
    for (const updatedDaysAgo of [0.01, 0.5, 4]) {
      const row = rankActivity([swept(updatedDaysAgo)], wide, NOW, OPEN)[0]!;
      expect(row.why).toStartWith("worked on 5d ago, ");
      expect(row.score).toBeLessThan(rankActivity([swept(updatedDaysAgo)], wide, NOW, CLOSED)[0]!.score);
    }
  });

  test("an update within the ingest slack of the ledger's answer is NOT set aside", () => {
    // Edited 2 minutes ago; the ledger answered now, before it could hold the edit.
    const fresh = swept((2 * MIN) / DAY);
    expect(rankActivity([fresh], wide, NOW, OPEN)).toEqual(rankActivity([fresh], wide, NOW, CLOSED));
    // The boundary: exactly the slack before the answer is set aside, a ms later is not.
    const edge = (msBeforeAnswer: number) =>
      rankActivity([swept(msBeforeAnswer / DAY)], wide, NOW, OPEN)[0]!.why.startsWith("worked on");
    expect(edge(10 * MIN)).toBe(true);
    expect(edge(10 * MIN - 1)).toBe(false);
  });

  test("a worked date EQUAL to a fresh update still substitutes — it is not older", () => {
    const twoMin = (2 * MIN) / DAY;
    const tied = page({ relPath: "t.md", createdDaysAgo: 40, updatedDaysAgo: twoMin, workedDaysAgo: twoMin });
    const row = rankActivity([tied], wide, NOW, OPEN)[0]!;
    expect(row.worked).toBe(true);
    expect(row.why).toStartWith("worked just now, ");
  });

  test("an update after an OLDER answer is not set aside either", () => {
    // Updated 12h ago; the ledger last answered a day ago.
    expect(rankActivity([swept(0.5)], wide, NOW, gateAsOf(ago(1)))).toEqual(
      rankActivity([swept(0.5)], wide, NOW, CLOSED),
    );
  });

  test("no answer time ⇒ nothing demotes, but a newer worked date still promotes", () => {
    expect(rankActivity([swept(0.5)], wide, NOW, gateAsOf(undefined))).toEqual(
      rankActivity([swept(0.5)], wide, NOW, CLOSED),
    );
    const stale = page({ relPath: "p.md", createdDaysAgo: 40, updatedDaysAgo: 6, workedDaysAgo: 0.5 });
    expect(rankActivity([stale], wide, NOW, gateAsOf(undefined))[0]!.why).toStartWith("worked on 12h ago, ");
  });
});

describe("rankActivity — an `added`-floor page and the session that brought it", () => {
  // Moved into place 3 days ago (git's floor, no `--follow`) with an older
  // authored `created:`; the only session write is the one that moved it.
  const createdFm = new Date(ago(21)).toISOString().slice(0, 10);
  const moved = (workedDaysAgo: number): WikiListing =>
    page({ relPath: "archive/moved.md", createdFm, createdDaysAgo: 3, updatedDaysAgo: null, workedDaysAgo });

  test("a worked date at the floor mints no change — the arrival is not an edit", () => {
    expect(rankActivity([moved(3)], wide, NOW, OPEN)).toEqual(rankActivity([moved(3)], wide, NOW, CLOSED));
    expect(rankActivity([moved(3)], wide, NOW, OPEN)[0]!.kind).toBe("new");
  });

  test("a worked date under a day past the floor mints no change either", () => {
    expect(rankActivity([moved(2.5)], wide, NOW, OPEN)).toEqual(rankActivity([moved(2.5)], wide, NOW, CLOSED));
  });

  test("a worked date more than a day past the floor still promotes", () => {
    const row = rankActivity([moved(1)], wide, NOW, OPEN)[0]!;
    expect(row.kind).toBe("changed");
    expect(row.worked).toBe(true);
  });
});

describe("rankActivity — the discarded update is named", () => {
  test("a demoted change says which update it set aside", () => {
    const p = page({ relPath: "a.md", createdDaysAgo: 40, updatedDaysAgo: 0.5, workedDaysAgo: 5 });
    expect(rankActivity([p], wide, NOW, OPEN)[0]!.why).toEndWith("; update 12h ago: no session write on record, or a bulk pass");
  });

  test("…and so does a change the substitution turned into a creation", () => {
    const p = page({ relPath: "plans/p.mdx", createdDaysAgo: 5, updatedDaysAgo: 1, workedDaysAgo: 4.9 });
    expect(rankActivity([p], wide, NOW, OPEN)[0]!.why).toMatch(
      /^created 5d ago → [0-9.]+; update 1d ago: no session write on record, or a bulk pass$/,
    );
  });

  test("an update whose loss changes nothing is not mentioned", () => {
    // The update is within a day of creation, so it was never a change: the row
    // is the same `new` row with or without the substitution.
    const p = page({ relPath: "q.md", createdDaysAgo: 5, updatedDaysAgo: 4.5, workedDaysAgo: 4.9 });
    expect(rankActivity([p], wide, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
  });

  test("a promotion discards nothing and says nothing", () => {
    const p = page({ relPath: "p.md", createdDaysAgo: 40, updatedDaysAgo: 6, workedDaysAgo: 0.5 });
    expect(rankActivity([p], wide, NOW, OPEN)[0]!.why).not.toContain("no session write on record");
  });

  test("an update under a day after the worked stamp is not named", () => {
    // Edited 12h ago, committed 3h ago: the git touch postdates the ledger's
    // stamp, but it is that session's own commit. The row still moves.
    const p = page({ relPath: "a.md", createdDaysAgo: 40, updatedDaysAgo: 0.125, workedDaysAgo: 0.5 });
    const row = rankActivity([p], wide, NOW, OPEN)[0]!;
    expect(row.score).not.toBe(rankActivity([p], wide, NOW, CLOSED)[0]!.score);
    // Wording-neutral, so it held against the clause's earlier text too.
    expect(row.why).not.toContain("no session");
  });

  test("an update set aside a day or more back is still not named when the row did not move", () => {
    // Both ways the row is `new` on its 3-day creation: the update (2.5d) lands
    // within a day of it, and the worked stamp (5d) predates it.
    const p = page({ relPath: "a.md", createdDaysAgo: 3, updatedDaysAgo: 2.5, workedDaysAgo: 5 });
    expect(rankActivity([p], wide, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
  });

});

describe("rankActivity — a worked date past the relative window", () => {
  test("reads `worked on <day>`, not `worked on on <day>`", () => {
    const p = page({ relPath: "old.md", createdDaysAgo: 400, updatedDaysAgo: 0.5, workedDaysAgo: 120 });
    const why = rankActivity([p], { ...wide, halfLifeChangedDays: 365 }, NOW, OPEN)[0]!.why;
    expect(why).toMatch(/^worked on \d{4}-\d{2}-\d{2}, /);
  });
});

describe("rankActivity — a worked stamp the ranking may not use", () => {
  test("the shared predicate: a positive instant the future guard accepts", () => {
    expect(isUsableWorkedMs(ago(1), NOW)).toBe(true);
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, ago(-5), "1", undefined]) {
      expect(isUsableWorkedMs(ms, NOW)).toBe(false);
    }
    // …and it is `workedSignal`'s rung: a negative stamp falls back to the update.
    const p = { ...page({ relPath: "n.md", createdDaysAgo: 40, updatedDaysAgo: 2 }), workedMs: -5 };
    expect(workedSignal(p, NOW).kind).toBe("updated");
  });

  test("zero or negative is ignored, in the gate and in the rank", () => {
    for (const workedMs of [0, -5]) {
      const p = { ...page({ relPath: "z.md", createdDaysAgo: 40, updatedDaysAgo: 0.5 }), workedMs };
      expect(workedGateFor([p], wide, NOW).covered).toBe(0);
      expect(rankActivity([p], wide, NOW, OPEN)).toEqual(rankActivity([p], wide, NOW, CLOSED));
    }
  });
});
