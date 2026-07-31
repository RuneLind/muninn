import { test, expect } from "bun:test";
import {
  connectionTypeOrder,
  filterPages,
  folderCounts,
  FUTURE_DATE_SKEW_MS,
  followupCount,
  hasPlanStatus,
  hasTypedHubs,
  hubTypeList,
  mergeWikiTypes,
  pageAddedLabel,
  pageAddedMs,
  pageDateLabel,
  pageDateKind,
  pageHeaderDates,
  pageFolder,
  pageFollowups,
  pageTimeMs,
  ROOT_FOLDER,
  sanitizeColorToken,
  sortPages,
  statusCounts,
  statusFacetVisible,
  STATUS_ORDER,
  tagCounts,
  topPages,
  typeCounts,
  TYPE_LABEL,
  TYPE_ORDER,
  type WikiFilters,
  type WikiListing,
} from "./wiki-filter.ts";
// The ONLY server import here, and only as a drift guard: `STATUS_ORDER` is a
// hand-kept client copy of the store's enum (this module must stay server-dep-free
// for the browser bundle), so nothing but a test can notice the two diverging.
import { PLAN_STATUS_VALUES } from "../../../wiki/store.ts";

function page(over: Partial<WikiListing>): WikiListing {
  return {
    name: "p",
    title: "Title",
    type: "concept",
    domain: "ai",
    tags: [],
    aliases: [],
    relPath: "p.md",
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  };
}

const NO_FILTER: WikiFilters = {
  q: "",
  domain: "",
  folder: "",
  type: "",
  tag: "",
  status: "",
  followups: "",
};

const PAGES: WikiListing[] = [
  page({ name: "rag", title: "Retrieval Augmented Generation", type: "concept", domain: "ai", tags: ["search", "llm"], aliases: ["RAG"], backlinkCount: 5, created: "2026-01-01", updated: "2026-03-01" }),
  page({ name: "gym", title: "Gym routine", type: "note", domain: "life", tags: ["health"], backlinkCount: 1, created: "2026-02-01", updated: "2026-02-10" }),
  page({ name: "anthropic", title: "Anthropic", type: "entity", domain: "ai", tags: ["llm", "org"], backlinkCount: 9, created: "2026-01-15" }),
];

test("filterPages: empty filters returns all", () => {
  expect(filterPages(PAGES, NO_FILTER)).toHaveLength(3);
});

test("filterPages: domain facet", () => {
  const life = filterPages(PAGES, { ...NO_FILTER, domain: "life" });
  expect(life.map((p) => p.name)).toEqual(["gym"]);
});

test("filterPages: type facet", () => {
  const entities = filterPages(PAGES, { ...NO_FILTER, type: "entity" });
  expect(entities.map((p) => p.name)).toEqual(["anthropic"]);
});

test("filterPages: tag facet is exact-match membership", () => {
  const llm = filterPages(PAGES, { ...NO_FILTER, tag: "llm" });
  expect(llm.map((p) => p.name).sort()).toEqual(["anthropic", "rag"]);
});

test("filterPages: query matches title, name, alias, and tag (case-insensitive)", () => {
  expect(filterPages(PAGES, { ...NO_FILTER, q: "retrieval" }).map((p) => p.name)).toEqual(["rag"]);
  expect(filterPages(PAGES, { ...NO_FILTER, q: "rag" }).map((p) => p.name)).toEqual(["rag"]); // alias RAG
  expect(filterPages(PAGES, { ...NO_FILTER, q: "HEALTH" }).map((p) => p.name)).toEqual(["gym"]); // tag
  expect(filterPages(PAGES, { ...NO_FILTER, q: "zzz" })).toHaveLength(0);
});

test("filterPages: facets AND with the query", () => {
  const res = filterPages(PAGES, { ...NO_FILTER, domain: "ai", q: "llm" });
  expect(res.map((p) => p.name).sort()).toEqual(["anthropic", "rag"]);
});

test("sortPages: title A-Z", () => {
  // "Anthropic" < "Gym routine" < "Retrieval Augmented Generation"
  expect(sortPages(PAGES, "title").map((p) => p.name)).toEqual(["anthropic", "gym", "rag"]);
});

test("sortPages: backlinks descending", () => {
  expect(sortPages(PAGES, "backlinks").map((p) => p.name)).toEqual(["anthropic", "rag", "gym"]);
});

test("sortPages: updated (falls back to created) descending", () => {
  // rag updated 2026-03-01, gym updated 2026-02-10, anthropic created 2026-01-15
  expect(sortPages(PAGES, "updated").map((p) => p.name)).toEqual(["rag", "gym", "anthropic"]);
});

test("pageTimeMs: frontmatter-less pages rank by mtime", () => {
  const p = page({ mtimeMs: Date.parse("2026-07-11T09:00:00Z") });
  expect(pageTimeMs(p)).toBe(Date.parse("2026-07-11T09:00:00Z"));
  expect(pageDateLabel(p)).toBe("2026-07-11");
});

test("pageTimeMs: takes the newer of mtime and frontmatter", () => {
  // A re-checked-out file (mtime reset to the past) keeps its frontmatter date…
  const stale = page({ updated: "2026-06-01", mtimeMs: Date.parse("2026-01-01T00:00:00Z") });
  expect(pageDateLabel(stale)).toBe("2026-06-01");
  // …and a file edited after its frontmatter was last bumped ranks by mtime.
  const touched = page({ updated: "2026-06-01", mtimeMs: Date.parse("2026-07-11T09:00:00Z") });
  expect(pageDateLabel(touched)).toBe("2026-07-11");
});

test("pageDateLabel: an mtime renders as a LOCAL day, not a UTC one", () => {
  // A late-evening edit in a positive-offset timezone is already "yesterday" in
  // UTC — labeling it from toISOString() would show a date that contradicts the
  // page's position at the top of the recency sort.
  const justAfterMidnightLocal = new Date(2026, 6, 12, 0, 30); // 12 Jul 00:30 local
  expect(pageDateLabel(page({ mtimeMs: justAfterMidnightLocal.getTime() }))).toBe("2026-07-12");
});

test("pageDateLabel: a winning frontmatter date is echoed verbatim", () => {
  // Round-tripping it through Date.parse (UTC midnight) would shift the day back
  // in negative-offset timezones.
  expect(pageDateLabel(page({ updated: "2026-06-01" }))).toBe("2026-06-01");
});

test("pageTimeMs: undated page is 0 and shows no date", () => {
  expect(pageTimeMs(page({}))).toBe(0);
  expect(pageDateLabel(page({}))).toBe("");
});

// --- sweep-aware "Recently updated" ------------------------------------------
// The mtime rule has three regimes and `gitCreatedMs` is the discriminator: absent
// ⇒ git knows nothing about this page ⇒ mtime is all it has (and the pre-git
// behavior is preserved byte-for-byte, which every test above this line asserts).

test("pageTimeMs: the git touch date beats an mtime a sweep reset", () => {
  // The bug: mimir's 2026-07-31 backfill rewrote 148 plans in one commit, so every
  // one of them reported as edited that minute. `mimir-wiki-polish`'s real last
  // edit is 2026-05-04 and that is what the list must show.
  const swept = page({
    gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-05-04T11:00:00Z"),
    mtimeMs: Date.parse("2026-07-31T12:31:00Z"),
  });
  expect(pageTimeMs(swept)).toBe(Date.parse("2026-05-04T11:00:00Z"));
  expect(pageDateLabel(swept)).toBe("2026-05-04");
});

test("pageTimeMs: a page edited but NOT yet committed still sorts to the top", () => {
  // The one thing a git-only signal would regress, and the reason mtime survives at
  // all: the edit is real, git just hasn't recorded it. `gitDirty` is what makes the
  // difference between this page and the swept one above, whose mtime is identical.
  const dirty = page({
    gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-05-04T11:00:00Z"),
    mtimeMs: Date.parse("2026-07-31T12:31:00Z"),
    gitDirty: true,
  });
  expect(pageTimeMs(dirty)).toBe(Date.parse("2026-07-31T12:31:00Z"));
  expect(pageDateLabel(dirty)).toBe("2026-07-31");
  expect(pageTimeMs(dirty)).toBeGreaterThan(
    pageTimeMs(page({ ...dirty, gitDirty: undefined })),
  );
});

test("pageDateKind: only the creation-date fallback reads as 'added'", () => {
  // Feeds `pageHeaderDates`, which drops the "updated" slot entirely on this kind.
  // Calling a creation date "updated" would assert an edit the history doesn't
  // record — for 77% of jarvis's pages.
  const onlySwept = page({ gitCreatedMs: Date.parse("2026-05-04T11:00:00Z") });
  expect(pageDateKind(onlySwept)).toBe("added");
  const touched = page({ ...onlySwept, gitTouchedMs: Date.parse("2026-07-24T11:00:00Z") });
  expect(pageDateKind(touched)).toBe("updated");
  // Frontmatter and a plain mtime are both genuine update claims.
  expect(pageDateKind(page({ updated: "2026-06-01" }))).toBe("updated");
  expect(pageDateKind(page({ mtimeMs: Date.parse("2026-07-11T09:00:00Z") }))).toBe("updated");
});

test("pageHeaderDates: a normally-edited page shows both dates", () => {
  const p = page({
    gitCreatedMs: Date.parse("2026-07-29T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-07-30T11:00:00Z"),
    mtimeMs: Date.parse("2026-07-31T12:31:00Z"), // sweep mtime, ignored
  });
  expect(pageHeaderDates(p)).toEqual({ created: "2026-07-29", updated: "2026-07-30" });
});

test("pageHeaderDates: no KNOWN edit shows the creation date ALONE", () => {
  // A page whose every commit was a sweep. The header must not invent an edit — and
  // this case cannot be detected by comparing the two labels, because the creation
  // signal takes the OLDEST of its inputs while the update signal fell back to the git
  // floor, so the two legitimately differ. Real on mimir for 6 pages (driven by
  // birthtime older than the git floor); spelled with frontmatter here because it is
  // the same shape and reads clearer. Only `pageDateKind` knows.
  const p = page({
    created: "2026-01-20",
    gitCreatedMs: Date.parse("2026-05-04T11:00:00Z"),
    mtimeMs: Date.parse("2026-07-31T12:31:00Z"),
  });
  expect(pageDateLabel(p)).toBe("2026-05-04"); // the labels DO differ…
  expect(pageHeaderDates(p)).toEqual({ created: "2026-01-20" }); // …and no update is claimed
});

test("pageHeaderDates: created and edited the same day collapses to one slot", () => {
  const p = page({
    gitCreatedMs: Date.parse("2026-05-04T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-05-04T17:00:00Z"),
  });
  expect(pageHeaderDates(p)).toEqual({ created: "2026-05-04" });
});

test("pageHeaderDates: a non-git wiki still gets both from birthtime + mtime", () => {
  const p = page({
    birthtimeMs: Date.parse("2026-06-01T09:00:00Z"),
    mtimeMs: Date.parse("2026-07-11T09:00:00Z"),
  });
  expect(pageHeaderDates(p)).toEqual({ created: "2026-06-01", updated: "2026-07-11" });
});

test("pageHeaderDates: an undated page yields nothing to render", () => {
  expect(pageHeaderDates(page({}))).toEqual({});
});

test("pageTimeMs: a page with NO non-sweep touch falls back to its creation date", () => {
  // 19 of mimir's 151 plans: added in the 2026-05-04 consolidation and only ever
  // swept since. Without the fallback they'd sort as undated at the very bottom —
  // strictly worse than the mtime they'd have had before.
  const onlySwept = page({
    gitCreatedMs: Date.parse("2026-05-04T11:00:00Z"),
    mtimeMs: Date.parse("2026-07-31T12:31:00Z"),
  });
  expect(pageTimeMs(onlySwept)).toBe(Date.parse("2026-05-04T11:00:00Z"));
  expect(pageDateLabel(onlySwept)).toBe("2026-05-04");
});

test("pageTimeMs: an untracked page trusts its mtime unconditionally", () => {
  // A brand-new draft has no git history at all — no created date, so no
  // discriminator — and its mtime is the honest and only answer.
  const draft = page({ mtimeMs: Date.parse("2026-07-31T12:31:00Z"), gitDirty: true });
  expect(pageTimeMs(draft)).toBe(Date.parse("2026-07-31T12:31:00Z"));
  expect(pageDateLabel(draft)).toBe("2026-07-31");
});

test("pageTimeMs: a frontmatter `updated` newer than every git signal still wins", () => {
  // Frontmatter is authored, not derived — a page can declare a date git can't know
  // (a hand-corrected stamp, an edit whose only commit was a sweep) and it must not be
  // overruled. Dated in the PAST on purpose: the future case is the clamp's, below,
  // and a hard-coded future literal here would silently change meaning as time passes.
  const declared = page({
    updated: "2026-06-15",
    gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-05-04T11:00:00Z"),
  });
  expect(pageTimeMs(declared)).toBe(Date.parse("2026-06-15"));
  expect(pageDateLabel(declared)).toBe("2026-06-15");
});

// ---------------------------------------------------------------------------
// Future-date guard (ignore, never clamp). Dates are relative to `Date.now()` — a
// literal would flip from future to past as the calendar moves and quietly stop
// testing anything. The exact-boundary case below instead passes an explicit `now`,
// which is what pins the constant itself.
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` `offsetMs` away from now, in UTC — the spelling frontmatter uses. */
function dayOffset(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
}
const HOUR = 60 * 60 * 1000;

test("pageTimeMs: an implausibly future frontmatter date does not become the sort key", () => {
  // The hole: `consider()` accepts any positive ms, so a model-emitted `updated:
  // 2027-01-01` outranks every real signal FOREVER — no later edit can exceed it, and
  // the page squats at the top of "Recently updated". The page falls back to its git
  // evidence instead, and the label follows the key so the row shows what it sorted on.
  const future = page({
    updated: dayOffset(400 * 24 * HOUR),
    gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-05-04T11:00:00Z"),
  });
  expect(pageTimeMs(future)).toBe(Date.parse("2026-05-04T11:00:00Z"));
  expect(pageDateLabel(future)).toBe("2026-05-04");
  expect(pageDateKind(future)).toBe("updated");
  // …and it now sorts BELOW a page genuinely touched later, which is the whole point.
  const real = page({
    name: "real",
    gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
    gitTouchedMs: Date.parse("2026-07-08T11:00:00Z"),
  });
  const ranked = sortPages([page({ ...future, name: "future" }), real], "updated");
  expect(ranked.map((p) => p.name)).toEqual(["real", "future"]);
});

test("pageTimeMs: a future date within the skew allowance is still trusted", () => {
  // A plain day stamped in UTC+14 reads as ~14h ahead in UTC, and a skewed clock adds
  // more; 48h swallows both. Anything past that is not a timezone.
  // ONE `dayOffset` evaluation: three separate calls straddling UTC midnight would
  // disagree on the day and flake sub-millisecond.
  const tomorrow = dayOffset(24 * HOUR);
  const nearly = page({ updated: tomorrow });
  expect(pageTimeMs(nearly)).toBe(Date.parse(tomorrow));
  expect(pageDateLabel(nearly)).toBe(tomorrow);
  const beyond = page({ updated: dayOffset(96 * HOUR) });
  expect(pageTimeMs(beyond)).toBe(0);
  expect(pageDateLabel(beyond)).toBe("");
});

test("pageTimeMs: the trusted/ignored cut sits exactly at FUTURE_DATE_SKEW_MS", () => {
  // The +24h/+72h cases above bracket the constant loosely enough that widening it to
  // 72h would leave them all green. This pins it: a stamp exactly `FUTURE_DATE_SKEW_MS`
  // ahead is trusted (the predicate is strict `>`), one millisecond past it is not. An
  // explicit `now` makes the boundary exact instead of racing the wall clock — which is
  // the other reason the signals take a `now` at all.
  const now = Date.parse("2026-07-31T12:00:00Z");
  const at = new Date(now + FUTURE_DATE_SKEW_MS).toISOString();
  const past = new Date(now + FUTURE_DATE_SKEW_MS + 1).toISOString();
  expect(pageTimeMs(page({ updated: at }), now)).toBe(now + FUTURE_DATE_SKEW_MS);
  expect(pageTimeMs(page({ updated: past }), now)).toBe(0);
  // Same cut on the "Recently added" signal — one predicate, both signals.
  expect(pageAddedMs(page({ created: at }), now)).toBe(now + FUTURE_DATE_SKEW_MS);
  expect(pageAddedMs(page({ created: past }), now)).toBe(0);
});

test("pageTimeMs: an implausible `updated` falls back to a valid `created`, not to nothing", () => {
  // The `p.updated || p.created` chain resolved BEFORE the plausibility test, so one bad
  // `updated:` also threw away a perfectly good `created:` and dropped the page to the
  // git floor — or, with no git at all, to undated. The good stamp must survive the bad
  // one.
  const p = page({ updated: dayOffset(400 * 24 * HOUR), created: "2026-03-09" });
  expect(pageTimeMs(p)).toBe(Date.parse("2026-03-09"));
  expect(pageDateLabel(p)).toBe("2026-03-09");
  expect(pageDateKind(p)).toBe("updated");
  // …so it outranks a page with an older creation date instead of sinking below it.
  const older = page({ name: "older", created: "2026-01-02" });
  const ranked = sortPages([older, page({ ...p, name: "rescued" })], "updated");
  expect(ranked.map((q) => q.name)).toEqual(["rescued", "older"]);
});

test("pageTimeMs: an implausible `created` is not rescued by itself", () => {
  // The fallback re-tries `created` only when `updated` was the implausible one — a page
  // whose ONLY stamp is a bad `created:` still sorts as undated.
  const p = page({ created: dayOffset(400 * 24 * HOUR) });
  expect(pageTimeMs(p)).toBe(0);
  expect(pageDateLabel(p)).toBe("");
});

test("pageTimeMs: a future `updated` falls back to a valid frontmatter-less signal, not to nothing", () => {
  // An untracked page (no git) keeps its mtime rather than sorting as undated.
  const mtime = Date.parse("2026-07-11T09:00:00Z");
  const p = page({ updated: dayOffset(400 * 24 * HOUR), mtimeMs: mtime });
  expect(pageTimeMs(p)).toBe(mtime);
  expect(pageDateLabel(p)).toBe("2026-07-11");
});

test("pageAddedMs: an implausibly future frontmatter `created` is ignored too", () => {
  // Narrower hole than the update signal's — the min means a future stamp loses to any
  // real signal — but a page whose ONLY signal is the bad stamp would pin the top of
  // "Recently added" forever. Undated (0) is the honest answer there.
  const withGit = page({
    created: dayOffset(400 * 24 * HOUR),
    gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
  });
  expect(pageAddedMs(withGit)).toBe(Date.parse("2026-01-10T09:00:00Z"));
  expect(pageAddedLabel(withGit)).toBe("2026-01-10");
  const alone = page({ created: dayOffset(400 * 24 * HOUR) });
  expect(pageAddedMs(alone)).toBe(0);
  expect(pageAddedLabel(alone)).toBe("");
});

test("sortPages: updated un-collapses a sweep that flattened every mtime", () => {
  // The end-to-end shape of the regression: three plans all mtimed at the same sweep
  // instant, ordered by their real touch dates instead of alphabetically — with the
  // never-really-touched one falling back to creation and landing last.
  const sweep = Date.parse("2026-07-31T12:31:00Z");
  const plans = [
    page({ name: "stale", title: "Alpha", gitCreatedMs: Date.parse("2026-05-04T11:00:00Z") }),
    page({
      name: "mid",
      title: "Charlie",
      gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
      gitTouchedMs: Date.parse("2026-07-08T11:00:00Z"),
    }),
    page({
      name: "recent",
      title: "Bravo",
      gitCreatedMs: Date.parse("2026-01-10T09:00:00Z"),
      gitTouchedMs: Date.parse("2026-07-28T11:00:00Z"),
    }),
  ].map((p) => page({ ...p, mtimeMs: sweep }));
  expect(sortPages(plans, "updated").map((p) => p.name)).toEqual(["recent", "mid", "stale"]);
});

test("sortPages: updated ranks a frontmatter-less mimir page above older dated ones", () => {
  // The bug: mimir's blogs/plans/archive pages carry no frontmatter, so a
  // frontmatter-only sort key left them below every dated page regardless of
  // when they were actually written.
  const blog = page({
    name: "audit",
    title: "Auditing the AI shipping pipeline",
    relPath: "blogs/auditing-the-ai-shipping-pipeline.md",
    mtimeMs: Date.parse("2026-07-11T09:00:00Z"),
  });
  expect(sortPages([...PAGES, blog], "updated").map((p) => p.name)).toEqual([
    "audit",
    "rag",
    "gym",
    "anthropic",
  ]);
});

test("sortPages: equal recency falls back to title for a stable order", () => {
  const a = page({ name: "a", title: "Bravo", updated: "2026-05-01" });
  const b = page({ name: "b", title: "Alpha", updated: "2026-05-01" });
  expect(sortPages([a, b], "updated").map((p) => p.name)).toEqual(["b", "a"]);
});

test("pageAddedMs: frontmatter-less pages rank by birthtime, not mtime", () => {
  // The point of "Recently added": a sweep that edits many pages bumps every
  // mtime but leaves birthtimes alone, so new pages stay distinguishable.
  const p = page({
    mtimeMs: Date.parse("2026-07-23T09:00:00Z"),
    birthtimeMs: Date.parse("2026-07-11T09:00:00Z"),
  });
  expect(pageAddedMs(p)).toBe(Date.parse("2026-07-11T09:00:00Z"));
  expect(pageAddedLabel(p)).toBe("2026-07-11");
});

test("pageAddedMs: takes the OLDER of birthtime and frontmatter created", () => {
  // A re-checked-out wiki recreates every file — the fresh birthtime is a lie
  // the older frontmatter `created` corrects.
  const recloned = page({ created: "2026-01-01", birthtimeMs: Date.parse("2026-07-20T10:00:00Z") });
  expect(pageAddedMs(recloned)).toBe(Date.parse("2026-01-01"));
  expect(pageAddedLabel(recloned)).toBe("2026-01-01");
});

test("pageAddedMs: no signals is 0 and shows no date", () => {
  expect(pageAddedMs(page({}))).toBe(0);
  expect(pageAddedLabel(page({}))).toBe("");
});

test("pageAddedLabel: a winning frontmatter created is echoed verbatim", () => {
  expect(pageAddedLabel(page({ created: "2026-06-01" }))).toBe("2026-06-01");
});

test("pageAddedMs: the git creation date beats a birthtime a sweep reset", () => {
  // The bug this field exists for: mimir's 2026-07-31 plan-status backfill rewrote
  // 148 files via temp-file+rename, resetting every birthtime to that day. With no
  // frontmatter `created` there was nothing left to correct it, so every plan
  // reported the same creation day and the sort collapsed to title order.
  const swept = page({
    gitCreatedMs: Date.parse("2026-05-04T11:00:00Z"),
    birthtimeMs: Date.parse("2026-07-31T12:31:00Z"),
    mtimeMs: Date.parse("2026-07-31T12:31:00Z"),
  });
  expect(pageAddedMs(swept)).toBe(Date.parse("2026-05-04T11:00:00Z"));
  expect(pageAddedLabel(swept)).toBe("2026-05-04");
});

test("pageAddedMs: a truer frontmatter created still beats git's import date", () => {
  // Neither signal dominates the other, which is why it's a min and not a priority
  // order: a page hand-imported into the wiki has a git date no older than the
  // import, while its frontmatter remembers when it was actually written.
  const imported = page({
    created: "2026-01-20",
    gitCreatedMs: Date.parse("2026-05-04T11:00:00Z"),
    birthtimeMs: Date.parse("2026-07-31T12:31:00Z"),
  });
  expect(pageAddedMs(imported)).toBe(Date.parse("2026-01-20"));
  expect(pageAddedLabel(imported)).toBe("2026-01-20");
});

test("pageAddedMs: an untracked page falls back to birthtime unchanged", () => {
  // No git date (brand-new file, or a non-git wiki) ⇒ exactly the old behavior.
  const fresh = page({ birthtimeMs: Date.parse("2026-07-31T12:31:00Z") });
  expect(pageAddedMs(fresh)).toBe(Date.parse("2026-07-31T12:31:00Z"));
  expect(pageAddedLabel(fresh)).toBe("2026-07-31");
});

test("pageAddedMs: a git date alone carries a page with no other signal", () => {
  const p = page({ gitCreatedMs: Date.parse("2026-06-15T08:00:00Z") });
  expect(pageAddedMs(p)).toBe(Date.parse("2026-06-15T08:00:00Z"));
  expect(pageAddedLabel(p)).toBe("2026-06-15");
});

test("sortPages: git dates un-collapse a sweep that flattened every birthtime", () => {
  // The end-to-end shape of the mimir regression: three plans, all birthtimed and
  // mtimed at the same sweep instant, ordered correctly by their git dates instead
  // of alphabetically.
  const sweep = Date.parse("2026-07-31T12:31:00Z");
  const plans = [
    page({ name: "old", title: "Alpha", gitCreatedMs: Date.parse("2026-05-04T11:00:00Z") }),
    page({ name: "mid", title: "Charlie", gitCreatedMs: Date.parse("2026-07-08T11:00:00Z") }),
    page({ name: "new", title: "Bravo", gitCreatedMs: Date.parse("2026-07-28T11:00:00Z") }),
  ].map((p) => page({ ...p, birthtimeMs: sweep, mtimeMs: sweep }));
  expect(sortPages(plans, "created").map((p) => p.name)).toEqual(["new", "mid", "old"]);
});

test("sortPages: created orders by added date and ignores updated/mtime churn", () => {
  const withBirth = PAGES.map((p) =>
    // Everything mass-touched today; anthropic (created 2026-01-15) still ranks
    // between gym (02-01) and rag (01-01) by its creation date alone.
    page({ ...p, mtimeMs: Date.parse("2026-07-23T09:00:00Z") }),
  );
  expect(sortPages(withBirth, "created").map((p) => p.name)).toEqual(["gym", "anthropic", "rag"]);
});

test("sortPages: created sinks meta pages (index/log/CLAUDE) to the bottom", () => {
  // Every sweep rewrites these, so a fresh birthtime there is churn, not new
  // content — they must not squat on top of "Recently added".
  const log = page({ name: "log", title: "Log", relPath: "log.md", birthtimeMs: Date.parse("2026-07-23T09:00:00Z") });
  const idx = page({ name: "index", title: "Index", relPath: "plans/index.md", birthtimeMs: Date.parse("2026-07-23T09:00:00Z") });
  expect(sortPages([log, idx, ...PAGES], "created").map((p) => p.name).slice(-2)).toEqual(["index", "log"]);
});

test("sortPages: created lifts a brand-new frontmatter-less page to the top", () => {
  const fresh = page({
    name: "fresh",
    title: "Fresh page",
    birthtimeMs: Date.parse("2026-07-22T09:00:00Z"),
    mtimeMs: Date.parse("2026-07-22T09:00:00Z"),
  });
  expect(sortPages([...PAGES, fresh], "created").map((p) => p.name)[0]).toBe("fresh");
});

test("pageFolder: top-level segment, ROOT_FOLDER for wiki-root pages", () => {
  expect(pageFolder(page({ relPath: "blogs/muninn-x.md" }))).toBe("blogs");
  expect(pageFolder(page({ relPath: "archive/muninn/report.md" }))).toBe("archive");
  expect(pageFolder(page({ relPath: "index.md" }))).toBe(ROOT_FOLDER);
});

test("filterPages: folder facet, including the root sentinel", () => {
  const pages = [
    page({ name: "blog", relPath: "blogs/a.md" }),
    page({ name: "plan", relPath: "plans/b.md" }),
    page({ name: "index", relPath: "index.md" }),
  ];
  expect(filterPages(pages, { ...NO_FILTER, folder: "blogs" }).map((p) => p.name)).toEqual(["blog"]);
  expect(filterPages(pages, { ...NO_FILTER, folder: ROOT_FOLDER }).map((p) => p.name)).toEqual([
    "index",
  ]);
  expect(filterPages(pages, { ...NO_FILTER, folder: "" })).toHaveLength(3);
});

test("folderCounts: honors the domain filter", () => {
  const pages = [
    page({ relPath: "blogs/a.md", domain: "ai" }),
    page({ relPath: "blogs/b.md", domain: "ai" }),
    page({ relPath: "life/c.md", domain: "life" }),
    page({ relPath: "index.md", domain: "ai" }),
  ];
  expect(folderCounts(pages, "")).toEqual({ blogs: 2, life: 1, [ROOT_FOLDER]: 1 });
  expect(folderCounts(pages, "ai")).toEqual({ blogs: 2, [ROOT_FOLDER]: 1 });
});

test("sortPages: does not mutate input", () => {
  const before = PAGES.map((p) => p.name);
  sortPages(PAGES, "title");
  expect(PAGES.map((p) => p.name)).toEqual(before);
});

test("typeCounts: honors domain filter", () => {
  expect(typeCounts(PAGES, "")).toEqual({ concept: 1, note: 1, entity: 1 });
  expect(typeCounts(PAGES, "ai")).toEqual({ concept: 1, entity: 1 });
});

test("tagCounts: honors domain + type filters", () => {
  expect(tagCounts(PAGES, "", "")).toEqual({ search: 1, llm: 2, health: 1, org: 1 });
  expect(tagCounts(PAGES, "ai", "entity")).toEqual({ llm: 1, org: 1 });
});

// ── Plan-status facet ────────────────────────────────────────────────
// Two INDEPENDENT axes: `plan_status` (has it started / is it finished) and
// `followups` (is anything left over). A shipped plan with open follow-ups is the
// case that keeps them from being collapsed into one vocabulary.
const PLAN_PAGES: WikiListing[] = [
  page({ name: "a", type: "plan", plan_status: "shipped", followups: "open" }),
  page({ name: "b", type: "plan", plan_status: "shipped", followups: "none" }),
  page({ name: "c", type: "plan", plan_status: "in-flight" }),
  page({ name: "d", type: "plan", plan_status: "blocked", followups: "open" }),
  page({ name: "e", type: "report", plan_status: "shipped", domain: "life" }),
  page({ name: "f", type: "plan" }), // no plan_status at all — the mid-backfill page
];

test("filterPages: status facet matches the exact plan_status", () => {
  expect(filterPages(PLAN_PAGES, { ...NO_FILTER, status: "shipped" }).map((p) => p.name)).toEqual([
    "a",
    "b",
    "e",
  ]);
  expect(filterPages(PLAN_PAGES, { ...NO_FILTER, status: "blocked" }).map((p) => p.name)).toEqual([
    "d",
  ]);
  // A page with no plan_status is never matched by a status filter.
  expect(filterPages(PLAN_PAGES, { ...NO_FILTER, status: "proposed" })).toHaveLength(0);
});

test("pageFollowups: absent reads as none", () => {
  expect(pageFollowups(page({}))).toBe("none");
  expect(pageFollowups(page({ followups: "none" }))).toBe("none");
  expect(pageFollowups(page({ followups: "open" }))).toBe("open");
});

test("filterPages: follow-ups facet, with absent folded to none", () => {
  expect(filterPages(PLAN_PAGES, { ...NO_FILTER, followups: "open" }).map((p) => p.name)).toEqual([
    "a",
    "d",
  ]);
  // `none` covers both the explicit value and every page that declared nothing.
  expect(filterPages(PLAN_PAGES, { ...NO_FILTER, followups: "none" }).map((p) => p.name)).toEqual([
    "b",
    "c",
    "e",
    "f",
  ]);
});

test("filterPages: status and follow-ups are independent axes that AND together", () => {
  // The whole reason for two facets: "shipped but with loose ends" is a real query.
  const res = filterPages(PLAN_PAGES, { ...NO_FILTER, status: "shipped", followups: "open" });
  expect(res.map((p) => p.name)).toEqual(["a"]);
});

test("statusCounts: honors domain + type, skips pages without a status", () => {
  expect(statusCounts(PLAN_PAGES, "", "")).toEqual({ shipped: 3, "in-flight": 1, blocked: 1 });
  // `e` is the only life page; `f` carries no status and is counted nowhere.
  expect(statusCounts(PLAN_PAGES, "life", "")).toEqual({ shipped: 1 });
  expect(statusCounts(PLAN_PAGES, "", "plan")).toEqual({ shipped: 2, "in-flight": 1, blocked: 1 });
});

test("followupCount: open only, same domain + type scoping as statusCounts", () => {
  expect(followupCount(PLAN_PAGES, "", "")).toBe(2);
  expect(followupCount(PLAN_PAGES, "life", "")).toBe(0);
  expect(followupCount(PLAN_PAGES, "", "report")).toBe(0);
});

test("hasPlanStatus: the facet gate — one status opens it, none keeps it hidden", () => {
  expect(hasPlanStatus(PLAN_PAGES)).toBe(true);
  // A wiki without the convention (jarvis) — and mimir before the backfill.
  expect(hasPlanStatus(PAGES)).toBe(false);
  expect(hasPlanStatus([])).toBe(false);
  // An invalid value is dropped server-side, so such a page arrives status-less
  // and must NOT open the facet — presence is validity for this gate.
  expect(hasPlanStatus([page({ followups: "open" })])).toBe(false);
});

test("STATUS_ORDER has not drifted from the store's PLAN_STATUS_VALUES", () => {
  expect(STATUS_ORDER).toEqual([...PLAN_STATUS_VALUES]);
});

test("statusFacetVisible: opens on EITHER axis, so ⚑ flags are never orphaned", () => {
  expect(statusFacetVisible(PLAN_PAGES)).toBe(true);
  // A wiki using neither axis (jarvis, melosys-kode-wiki) stays exactly as before.
  expect(statusFacetVisible(PAGES)).toBe(false);
  expect(statusFacetVisible([])).toBe(false);
  // The bug this predicate fixes: follow-ups WITHOUT any plan_status. The rows
  // render ⚑ flags regardless, so the row carrying their legend + toggle must show.
  const followupsOnly = [page({ name: "x", followups: "open" }), page({ name: "y" })];
  expect(hasPlanStatus(followupsOnly)).toBe(false);
  expect(statusFacetVisible(followupsOnly)).toBe(true);
  // …but a wiki whose only declaration is `followups: none` has nothing to offer.
  expect(statusFacetVisible([page({ name: "z", followups: "none" })])).toBe(false);
});

test("STATUS_ORDER drives the chip order, with an unknown status appended", () => {
  // The chip row unions the enum order with what's present (same helper the type
  // row uses), so a value a future server adds surfaces instead of vanishing.
  const present = ["shipped", "blocked", "retired", "proposed"];
  expect(connectionTypeOrder(present, STATUS_ORDER)).toEqual([
    "proposed",
    "blocked",
    "shipped",
    "retired",
  ]);
});

test("hasTypedHubs: true with ≥2 non-note types, false for untyped/single-type wikis", () => {
  expect(hasTypedHubs(PAGES)).toBe(true); // concept + entity → 2 non-note types
  const untyped: WikiListing[] = [
    page({ name: "a", type: "note", backlinkCount: 3 }),
    page({ name: "b", type: "note", backlinkCount: 1 }),
  ];
  expect(hasTypedHubs(untyped)).toBe(false);
  // A single non-note type isn't enough of an ontology — falls back to the cross-type hub.
  const singleType: WikiListing[] = [
    page({ name: "c1", type: "concept" }),
    page({ name: "n1", type: "note" }),
  ];
  expect(hasTypedHubs(singleType)).toBe(false);
  // A wiki with custom types (mimir) counts them.
  const mimir: WikiListing[] = [
    page({ name: "s", type: "subsystem" }),
    page({ name: "p", type: "plan" }),
  ];
  expect(hasTypedHubs(mimir)).toBe(true);
});

test("mergeWikiTypes: no config yields exactly today's constants (jarvis byte-identity)", () => {
  const merged = mergeWikiTypes(null, ["concept", "entity", "source", "note"]);
  // The whole point of the byte-identity guarantee: order + labels === the constants.
  expect(merged.order).toEqual(TYPE_ORDER);
  expect(merged.labels).toEqual(TYPE_LABEL);
  // …and it's a copy, not the shared constant (client mutates the stored list).
  expect(merged.order).not.toBe(TYPE_ORDER);
  expect(merged.labels).not.toBe(TYPE_LABEL);
});

test("mergeWikiTypes: custom types append after standards, only when present, with labels", () => {
  const config = {
    typeMap: {
      projects: "subsystem",
      plans: "plan",
      archive: "report",
      flows: "concept", // standard target — no duplicate appended
      reading: "source",
    },
    typeLabels: { subsystem: "Subsystems", plan: "Plans", report: "Reports", repo: "Repos" },
  };
  // `repo` is declared (typeLabels) but no page carries it → excluded (count 0).
  const merged = mergeWikiTypes(config, ["concept", "subsystem", "plan", "report", "note"]);
  expect(merged.order).toEqual([
    ...TYPE_ORDER, // standards first, in canonical order
    "subsystem",
    "plan",
    "report",
  ]);
  expect(merged.labels.subsystem).toBe("Subsystems");
  expect(merged.labels.report).toBe("Reports");
  expect(merged.labels).not.toHaveProperty("repo"); // absent type → no label added
  expect(merged.labels.concept).toBe("Concepts"); // standard labels untouched
});

test("mergeWikiTypes: a typeMap-only custom type falls back to a title-cased label", () => {
  const config = { typeMap: { widgets: "widget" }, typeLabels: {} };
  const merged = mergeWikiTypes(config, ["widget"]);
  expect(merged.order).toEqual([...TYPE_ORDER, "widget"]);
  expect(merged.labels.widget).toBe("Widget");
});

test("hubTypeList: non-note, non-explainer types present, ordered by the merged list", () => {
  const order = [...TYPE_ORDER, "subsystem", "plan"];
  const pages: WikiListing[] = [
    page({ type: "subsystem" }),
    page({ type: "plan" }),
    page({ type: "concept" }),
    page({ type: "explainer" }), // excluded — explainers never join the link graph
    page({ type: "note" }), // excluded — the fallback type
  ];
  expect(hubTypeList(pages, order)).toEqual(["concept", "subsystem", "plan"]);
});

test("hubTypeList: a type present but missing from the order is appended (alpha)", () => {
  const pages: WikiListing[] = [page({ type: "zeta" }), page({ type: "alpha" })];
  // Neither is in TYPE_ORDER → both are extras, alpha-sorted.
  expect(hubTypeList(pages, TYPE_ORDER)).toEqual(["alpha", "zeta"]);
});

test("connectionTypeOrder: stored order first, then extras present in items (alpha)", () => {
  const order = [...TYPE_ORDER, "subsystem"];
  // `plan` is a real custom type NOT in the stored order (late/empty stored list) —
  // it must still be grouped, never dropped (the :918 regression case).
  const itemTypes = ["subsystem", "concept", "plan", "note"];
  expect(connectionTypeOrder(itemTypes, order)).toEqual([
    "concept",
    "note",
    "subsystem",
    "plan", // extra, appended so its neighbor is never dropped
  ]);
});

test("connectionTypeOrder: empty stored order still surfaces every present type", () => {
  expect(connectionTypeOrder(["plan", "concept"], [])).toEqual(["concept", "plan"]);
});

test("topPages: type predicate filters and sorts by backlinkCount desc, honors limit", () => {
  const pages: WikiListing[] = [
    page({ name: "c1", type: "concept", backlinkCount: 2 }),
    page({ name: "c2", type: "concept", backlinkCount: 8 }),
    page({ name: "n1", type: "note", backlinkCount: 99 }),
  ];
  expect(topPages(pages, (p) => p.type === "concept").map((p) => p.name)).toEqual(["c2", "c1"]);
  expect(topPages(pages, (p) => p.type === "concept", 1).map((p) => p.name)).toEqual(["c2"]);
});

test("topPages: backlinked-only predicate (untyped fallback) drops orphans", () => {
  const pages: WikiListing[] = [
    page({ name: "hub", type: "note", backlinkCount: 7 }),
    page({ name: "mid", type: "note", backlinkCount: 3 }),
    page({ name: "orphan", type: "note", backlinkCount: 0 }),
  ];
  expect(topPages(pages, (p) => p.backlinkCount > 0).map((p) => p.name)).toEqual(["hub", "mid"]);
  // Nothing linked → empty (drives the muted empty-state in hubsHtml).
  const none: WikiListing[] = [page({ name: "x", type: "note", backlinkCount: 0 })];
  expect(topPages(none, (p) => p.backlinkCount > 0)).toEqual([]);
});

test("sanitizeColorToken accepts strict hex color tokens", () => {
  for (const v of ["#abc", "#abcd", "#a1b2c3", "#a1b2c3d4", "#FFF", "  #6c63ff  "]) {
    expect(sanitizeColorToken(v)).toBe(v.trim());
  }
});

test("sanitizeColorToken accepts rgb/rgba/hsl/hsla with numeric args", () => {
  for (const v of ["rgb(108, 99, 255)", "rgba(0,0,0,0.5)", "hsl(240, 100%, 60%)", "HSLA(240, 100%, 60%, 0.4)"]) {
    expect(sanitizeColorToken(v)).toBe(v);
  }
});

test("sanitizeColorToken drops named colors, functions with non-numeric args, and non-strings", () => {
  for (const v of ["red", "blue", "transparent", "var(--accent)", "url(x)", "#12", "#12345", "rgb(a,b,c)", "#xyz"]) {
    expect(sanitizeColorToken(v)).toBeUndefined();
  }
  expect(sanitizeColorToken(undefined)).toBeUndefined();
  expect(sanitizeColorToken(["#fff"])).toBeUndefined(); // frontmatter array value
  expect(sanitizeColorToken("")).toBeUndefined();
});

test("sanitizeColorToken drops a CSS-injection attempt (style-sink breakout)", () => {
  // The load-bearing security case: a value crafted to escape the <style> sink and
  // inject arbitrary rules must never survive validation.
  for (const attack of [
    "red;} body{display:none}",
    "#fff;} html{background:url(evil)}",
    "#fff</style><script>alert(1)</script>",
    "rgb(0,0,0);} .x{color:red",
    "#fff /* comment */",
  ]) {
    expect(sanitizeColorToken(attack)).toBeUndefined();
  }
});
