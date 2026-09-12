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
  formatRelativeAge,
  parseActivityWeights,
  rankActivity,
  type ActivityWeights,
} from "./wiki-activity-rank.ts";
import type { WikiListing } from "./wiki-filter.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const DAY = 86_400_000;
const ago = (days: number): number => NOW - days * DAY;

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
  /** mtime, the ONLY signal a page in a plain non-git directory has. */
  mtimeDaysAgo?: number;
  backlinkCount?: number;
  type?: string;
  plan_status?: string;
  title?: string;
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
    ...(created === undefined ? {} : { gitCreatedMs: ago(created) }),
    ...(updated === undefined ? {} : { gitTouchedMs: ago(updated) }),
    ...(over.birthtimeDaysAgo === undefined ? {} : { birthtimeMs: ago(over.birthtimeDaysAgo) }),
    ...(over.mtimeDaysAgo === undefined ? {} : { mtimeMs: ago(over.mtimeDaysAgo) }),
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
      "changed 3h ago, created 2mo ago: weight ×0.70, recency 0.97, age ×0.52, hub ×0.25 (25←), type ×1.00 → 0.09",
    );
  });
});

describe("age labels", () => {
  test("no two buckets can print the same duration", () => {
    // Each bucket promotes on its OWN rounded value. Promoting on the raw one
    // makes 29.6 days print "30d" beside a month bucket that starts at 30.0,
    // and the same seam exists at 24h/1d and 12mo/1.0y.
    expect(formatRelativeAge(23.6 * 3_600_000)).toBe("1d");
    expect(formatRelativeAge(23.4 * 3_600_000)).toBe("23h");
    expect(formatRelativeAge(29.6 * DAY)).toBe("1mo");
    expect(formatRelativeAge(29.4 * DAY)).toBe("29d");
    expect(formatRelativeAge(350 * DAY)).toBe("1.0y");
    expect(formatRelativeAge(340 * DAY)).toBe("11mo");
  });

  test("every bucket of the relative scale", () => {
    expect(formatRelativeAge(0)).toBe("now");
    expect(formatRelativeAge(30 * 60_000)).toBe("now"); // 30 min
    expect(formatRelativeAge(3 * 3_600_000)).toBe("3h");
    expect(formatRelativeAge(2 * DAY)).toBe("2d");
    expect(formatRelativeAge(46 * DAY)).toBe("2mo");
    expect(formatRelativeAge(400 * DAY)).toBe("1.1y");
    // Clock skew ahead of the anchor reads as "now", never as a negative age.
    expect(formatRelativeAge(-60_000)).toBe("now");
    expect(formatRelativeAge(Number.NaN)).toBe("");
  });

  test("the row label is the age of the signal that WON", () => {
    const [created] = rankActivity([page({ relPath: "a.md", createdDaysAgo: 2 })], wide, NOW);
    expect(formatRelativeAge(created!.ageMs)).toBe("2d");
    const [changed] = rankActivity(
      [page({ relPath: "b.md", createdDaysAgo: 46, updatedDaysAgo: 3 / 24 })],
      wide,
      NOW,
    );
    expect(changed!.kind).toBe("changed");
    expect(formatRelativeAge(changed!.ageMs)).toBe("3h");
  });
});

describe("rankActivity — the updated signal has to be a real EDIT", () => {
  /**
   * A page whose every commit was a sweep has no touch date at all, and
   * `updatedSignal` falls back to the git CREATION date with `kind: "added"`.
   * Taken as an edit that reads as "changed <the day it was created>" — and it
   * outranks the creation it is made of whenever the creation signal is older
   * still (a birthtime or a frontmatter `created:` predating the git floor).
   * Measured on the jarvis wiki: 165 pages, `concepts/Cognitive Debt.md` among
   * them at changed 0.63 over created 0.50.
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
  // A plain (non-git) directory registered through WIKI_EXTRA: mtime is the only
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
    expect(breached[0]!.reason).toContain("using 12");
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
