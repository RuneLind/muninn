/**
 * FAMILIES and MONTHS — the rail's second grouping layer, behind the head's
 * `group families` toggle. Pure and dependency-free (the `wiki-filter.ts`
 * discipline): the rule is a function of the listing's `relPath`s, the pairing
 * the store already made, and the wiki's own project names.
 *
 * ⚠️ **This module must never import `src/wiki/store.ts`.** It is bundled into
 * the browser through `wiki-browser.ts`, and a `store.ts` import pulls `node:os`
 * in through `lockfile.ts`: the build fails and the memoized bundle accessor then
 * serves `/wiki` no client script at all. `wiki-filter.ts` says the same thing
 * about itself, for the same measured reason.
 *
 * Why a NAME heuristic. A slate of work is written as one stem prefix
 * (`alpha-beta-one`, `alpha-beta-two`, …) and the rail lists every piece of it
 * as a peer row, so ten rows of finished work sit between the two pages the
 * reader is actually moving between. The exact signal is which sessions wrote
 * which pages (layer 3 of the plan), which the listing does not carry yet; a
 * name prefix is what the listing has today, and the toggle is off by default,
 * so a weak family costs one click and never a lost page.
 *
 * `buildRail` (`wiki-recents.ts`) ARRANGES these groups; it does not compute
 * them — the same split `activity` already has, so the rail stays one enumerable
 * arrangement rule and the grouping stays testable without a rail.
 */

import {
  STATUS_ORDER,
  isMetaPage,
  pageDateSignal,
  pageStemOf,
  type WikiListing,
  type WikiSortMode,
} from "./wiki-filter.ts";
import { normalizeRel } from "./wiki-nav.ts";

/** How many PARENT rows a prefix needs before it is a family. Two pages are a
 *  coincidence of naming; three are a slate. */
export const FAMILY_MIN = 3;
/**
 * The most members a family may hold — and the one rule that separates a slate
 * from a FOLDER. A subsystem prefix (`alpha-wiki-*`, 16 pages on the wiki this
 * was measured against) is not one piece of work, and folding it reproduces the
 * folder select one level down while hiding every page the reader came for.
 *
 * Judged on the prefix's TOTAL member count — parents plus the superseded
 * children counted with them — so a slate does not start folding because some
 * of it was retired.
 */
export const FAMILY_MAX = 12;

/**
 * The folder facet whose rows fold by MONTH instead of by family. An archive is
 * a time series: its pages are named for the day they were written and almost
 * never share a stem prefix, so the family rule finds nothing and the month is
 * the grouping that means something.
 *
 * A folder name rather than a wiki-declared field, deliberately: the reader
 * ontology (`.wiki-reader.json`) has no "this folder is a time series" concept
 * and inventing one for a single boolean is a schema change no wiki asked for.
 * A wiki with no `archive/` folder simply never reaches this branch.
 */
export const MONTH_FOLDER = "archive";

/**
 * The toggle's own key in the folds store (`muninn.wiki.folds.v1:<wiki>`), a
 * third spelling in that flat namespace beside a parent's relPath and the
 * `section:` sentinel — which is exactly what the store's key-space note said
 * PR 2 would add, so nothing about the store, the toggle or the parse changes.
 *
 * Presence means ON: grouping is OFF by default, and the stored list is the
 * exceptions, the same settlement every other fold key makes.
 */
export const GROUP_FAMILIES_TOGGLE_KEY = "toggle:families";

/**
 * The second spelling a GROUP key can take in the folds store: `closed:<key>`.
 *
 * The store holds the reader's exceptions, and a group has two possible
 * defaults — closed for every family and every month but one, open for the
 * newest month that renders. One key cannot carry both without changing meaning
 * when the default moves, which is exactly what the first cut did: the newest
 * month's key meant CLOSED, so the day a new month landed (or a facet filtered
 * the newest away) the reader's deliberate close silently became an open.
 *
 * So each spelling means ONE thing forever: `month:2026-09` is OPEN,
 * `closed:month:2026-09` is CLOSED, and a key of the spelling that does not
 * match the group's current default is ignored rather than reinterpreted. The
 * `closed:` form is only ever WRITTEN for the group that defaults open — the
 * painter puts that spelling in its `data-fold-key`, so the one generic toggle
 * handler flips the right key with no branch of its own.
 */
export const CLOSED_FOLD_PREFIX = "closed:";

/** The CLOSED spelling of a group's fold key. */
export function closedFoldKey(key: string): string {
  return CLOSED_FOLD_PREFIX + key;
}

/** The word a page carrying no `plan_status` counts under in a family roll-up.
 *  Not "other" (which reads as another status) and not "unknown" (which reads as
 *  a failure): the page simply never declared one, which is true of most pages
 *  on most wikis. */
export const NO_STATUS_WORD = "unmarked";

export type RailGroupKind = "family" | "month";

/**
 * One group the rail may fold. Built here, arranged by `buildRail`.
 */
export interface RailGroup {
  kind: RailGroupKind;
  /**
   * The fold key, in the folds store's flat namespace: `family:<folder>/<prefix>`
   * or `month:<YYYY-MM>`.
   *
   * The FOLDER rides the family key although the plan wrote `family:<prefix>`:
   * families are scoped to one folder, so two folders can hold a family of the
   * same prefix at once (they do on the wiki this was measured against), and a
   * bare-prefix key would make one reader's click open both.
   */
  key: string;
  /** What the group's row says: `alpha-beta-*`, or the month as `YYYY-MM`. */
  label: string;
  /** The rows this group folds, in the order the caller's sort gave them. */
  members: WikiListing[];
  /**
   * Rule-4 children (`pairedBy: "superseded"`) whose SUCCESSOR is a member of
   * this family. They render inside the family body, under that successor — one
   * indent further in, which is where the store's one-level-deep invariant puts
   * them — and count toward the roll-up and toward the cap. Always empty for a
   * month.
   *
   * The successor decides membership, not the child's own name: a retired page
   * whose successor sits in another folder (or in another family) is a piece of
   * THAT work, and counting it here would put one page in two slates while it
   * renders in neither's body.
   */
  supersededChildren: WikiListing[];
}

/** The fold key for a family in one folder. */
export function familyFoldKey(folder: string, prefix: string): string {
  return "family:" + (folder ? folder + "/" : "") + prefix;
}

/** The fold key for one `YYYY-MM`. */
export function monthFoldKey(month: string): string {
  return "month:" + month;
}

/**
 * The group that defaults to OPEN in one render: the newest month among the
 * groups that actually RENDER, or `null` when none of them is a month.
 *
 * Computed over the rendered set, after the Activity/Pinned lift, and that is
 * the whole fix: choosing the newest month up front meant that on a real
 * archive — where every page of the newest month is also the freshest thing on
 * the wiki, so Activity lifts all of it — the group carrying the default was
 * not on screen and NO month was open (measured under "Recently added").
 *
 * Families never default open: a slate is one piece of work among many, while
 * an archive is read from the near end.
 */
export function defaultOpenGroupKey(rendered: readonly RailGroup[]): string | null {
  let best: string | null = null;
  for (const g of rendered) {
    if (g.kind !== "month") continue;
    if (best === null || g.label.localeCompare(best) > 0) best = g.label;
  }
  return best === null ? null : monthFoldKey(best);
}

/** The directory part of a relPath — the family scope. `""` for a page sitting
 *  in the wiki root. Note this is the FULL directory (`archive/project`), not
 *  `pageFolder`'s first segment, which is the facet's unit rather than the
 *  naming scope. */
function folderOf(relPath: string): string {
  const rel = (relPath || "").replace(/\\/g, "/");
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "" : rel.slice(0, slash).toLowerCase();
}

/** A markdown page — the only kind that can be a family member. An `.html` page
 *  is an attachment or an explainer; neither is a piece of the slate. */
function isMarkdown(relPath: string): boolean {
  return /\.mdx?$/i.test(relPath || "");
}

/**
 * The fix-round report shape, `<YYYY-MM-DD>-<n>-fix-rounds-<prs>`: never a
 * family and never a family member. These pages audit a PR rather than carrying
 * a piece of the work, and pairing them with the plan they audit is layer 3's
 * job (the `prs:` intersection), not a name prefix's — they all share a date
 * prefix with every other archive page written that month, which is a family the
 * rule would otherwise invent.
 */
const FIX_ROUNDS_RE = /^\d{4}-\d{2}-\d{2}-.+-fix-rounds(?:-|$)/i;

/**
 * The leading `YYYY-MM-DD` an archive page carries in its filename.
 *
 * The month and the day are VALIDATED, because an invalid one is not a date:
 * `2026-13-02-topic` is a name that happens to start with digits, and reading a
 * month `13` off it files the page under a bucket no other page can join. It
 * falls back to the date the rail is sorting on instead.
 *
 * The tail is `-` OR END, so `archive/2026-09-02.md` — a page whose whole name
 * is the day — still buckets by its filename rather than by its stamp.
 */
const DATED_NAME_RE = /^(\d{4})-(0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:-|$)/;

/**
 * A prefix that is nothing but a date (`2026-07`, `2026-07-15`) is never a
 * family candidate. A month is what `groupMonths` owns, and letting the family
 * rule mint one too was wrong in three measured ways on the live wiki: the same
 * label formed TWICE (two subfolders of one month), a 13-page month went over
 * the cap and BANNED a genuine 3-page slate nested under it, and the rail said
 * "these pages were written in July", which is the one thing a date sort already
 * says on every row.
 *
 * Deliberately permissive about the numbers (unlike `DATED_NAME_RE`, which has
 * to pick a real bucket): "this prefix is not a family" is the safe direction,
 * so `9999-99` is excluded too.
 */
const DATE_PREFIX_RE = /^\d{4}-\d{2}(?:-\d{2})?$/;

/** Every dash-separated prefix of `stem` with at least `minSegments` segments,
 *  the whole stem included — a page named exactly `alpha-beta` shares the prefix
 *  `alpha-beta` with its siblings, and leaving it out would count a slate one
 *  member short. Shortest first.
 *
 *  An EMPTY segment ends the walk: `a--b` and `-x` are the only shapes that
 *  produce one, and the prefixes they used to mint (`a-`, `-x`) are not names —
 *  they rendered as malformed labels (`a--*`) over families whose own members
 *  could not carry them. Everything BEFORE the empty segment is still a real
 *  prefix of the stem, so `a-b--c` keeps `a-b`. */
function prefixesOf(stem: string, minSegments: number): string[] {
  const parts = stem.split("-");
  const out: string[] = [];
  for (let n = minSegments; n <= parts.length; n++) {
    if (parts.slice(0, n).some((s) => s === "")) break;
    out.push(parts.slice(0, n).join("-"));
  }
  return out;
}

/** Is `outer` a strictly shorter dash-prefix of `inner`? */
function isPrefixOf(outer: string, inner: string): boolean {
  return inner.length > outer.length && inner.startsWith(outer + "-");
}

function projectNameSet(projects: Record<string, number> | readonly string[]): Set<string> {
  const names = Array.isArray(projects) ? projects : Object.keys(projects);
  const out = new Set<string>();
  for (const n of names) {
    const v = String(n || "").trim().toLowerCase();
    if (v) out.add(v);
  }
  return out;
}

/**
 * The families among `pages`, one folder at a time.
 *
 * **The rule.** A family is the SHORTEST dash-separated stem prefix of two or
 * more segments that three or more and at most twelve pages in the same folder
 * share, excluding a prefix equal to a project name, with no nesting in either
 * direction:
 *
 *  - **Two or more segments**, because a one-segment prefix is a project name by
 *    construction on a wiki that files work by project (`alpha-*` is most of the
 *    folder), and folding it reproduces the folder select.
 *  - **Not a project name**, for the same reason one level up: `alpha-tools-*`
 *    may be a real project with 38 pages, and segment count alone cannot tell it
 *    from `alpha-search-*`, a real slate of 8. The project list is the wiki's own
 *    (`/api/wiki/pages` `projects`), so a wiki that declares none loses only this
 *    exclusion.
 *  - **Not a bare DATE** (`2026-07`, `2026-07-15`): a month is what `groupMonths`
 *    owns. See `DATE_PREFIX_RE` for the three things that went wrong without it.
 *  - **Three or more PARENT rows**, judged on parents alone: two pages plus a
 *    retired one is not a slate, it is a page and its predecessor, which the
 *    attachment layer already folds.
 *  - **At most twelve members in TOTAL**, parents plus the rule-4 children
 *    counted with them, so a slate does not start folding because part of it was
 *    superseded — and so the cap means the same number however the work was
 *    filed.
 *  - **No nesting**: once `alpha-beta` qualifies, `alpha-beta-north` is not a
 *    second family; and no family forms under a prefix that is itself a family
 *    CANDIDATE (two or more segments, not a project name) and exceeded the cap,
 *    so a 3-member `alpha-wiki-ask` does not fold under the 16-member
 *    `alpha-wiki` while a 10-member `alpha-tools-live` still forms under the
 *    over-cap PROJECT name `alpha-tools`, which is never a candidate.
 *
 * **Formed over parent rows only** — `.md`/`.mdx` pages that are nobody's child.
 * Every child renders under its own parent (the store's rule); only a rule-4
 * child whose SUCCESSOR is a member counts toward that family's roll-up and cap,
 * and an `.html` page never counts at all. Meta pages (`index`, `log`, `CLAUDE`)
 * are out: they are per-folder plumbing and the rail sinks them under
 * `Bookkeeping`.
 *
 * Member order is the input order, so the caller's sort decides what the family
 * opens into and where the rail puts it.
 *
 * **Labels are disambiguated last**, across every folder at once: see the pass
 * at the bottom of this function.
 */
export function groupFamilies(
  pages: readonly WikiListing[],
  projects: Record<string, number> | readonly string[],
): RailGroup[] {
  const projectNames = projectNameSet(projects);
  /** folder → the rows that may FORM a family (parents) and the rule-4 children
   *  that COUNT with one of them. */
  const byFolder = new Map<string, { parents: WikiListing[]; children: WikiListing[] }>();
  for (const p of pages) {
    // The meta test is a BELT-AND-BRACES mirror of the rail's own `Bookkeeping`
    // section, and it is unobservable today: every meta stem (`index`, `log`,
    // `CLAUDE`) is one segment, so it mints no two-segment prefix and carries
    // none either. That is a fact about `isMetaStem` in another module, not
    // about this rule, which is why the guard stays rather than being tested.
    if (!isMarkdown(p.relPath) || isMetaPage(p)) continue;
    const stem = pageStemOf(p.relPath);
    if (FIX_ROUNDS_RE.test(stem)) continue;
    const isSuperseded = p.pairedBy === "superseded";
    // A child of any OTHER rule is not counted at all: it is an attachment of
    // its parent, not a piece of the slate.
    if (p.parent && !isSuperseded) continue;
    const folder = folderOf(p.relPath);
    let bucket = byFolder.get(folder);
    if (!bucket) byFolder.set(folder, (bucket = { parents: [], children: [] }));
    if (p.parent) bucket.children.push(p);
    else bucket.parents.push(p);
  }

  const groups: Array<RailGroup & { folder: string; prefix: string }> = [];
  for (const [folder, bucket] of byFolder) {
    /** normalized relPath → the PARENT row at it, so a rule-4 child can be
     *  resolved to its successor. Only this folder's parents: a successor
     *  somewhere else is outside every family here, by the rule below. */
    const parentByRel = new Map<string, WikiListing>();
    for (const p of bucket.parents) parentByRel.set(normalizeRel(p.relPath), p);
    /** prefix → how many PARENT rows carry it (the formation threshold). */
    const parentCount = new Map<string, number>();
    /** prefix → how many members carry it in total (the cap, and the ban). */
    const totalCount = new Map<string, number>();
    const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
    for (const p of bucket.parents) {
      for (const prefix of prefixesOf(pageStemOf(p.relPath).toLowerCase(), 2)) {
        bump(totalCount, prefix);
        bump(parentCount, prefix);
      }
    }
    // ⚠️ A rule-4 child counts under its SUCCESSOR's prefixes, never its own.
    // Membership is "my successor is in this family" (see `supersededChildren`),
    // so counting the child's own name would let it push a prefix over the cap
    // that it is not a member of — and leave the prefix it IS a member of one
    // short. A child whose successor is not a parent here counts nowhere.
    for (const c of bucket.children) {
      const successor = parentByRel.get(normalizeRel(c.parent ?? ""));
      if (!successor) continue;
      for (const prefix of prefixesOf(pageStemOf(successor.relPath).toLowerCase(), 2)) {
        bump(totalCount, prefix);
      }
    }
    /** A prefix the rule would ever consider — the test the over-cap BAN is
     *  judged with too, which is why it is its own predicate: `alpha-tools` is
     *  over the cap and bans nothing, because a project name is never a family
     *  candidate in the first place. A pure DATE prefix is excluded the same way
     *  and for the same reason — it is the month grouping's unit, not a slate. */
    const isCandidate = (prefix: string): boolean =>
      !projectNames.has(prefix) && !DATE_PREFIX_RE.test(prefix);
    const overCapAncestor = (prefix: string): boolean => {
      for (const ancestor of prefixesOf(prefix, 2)) {
        if (ancestor === prefix) continue;
        if (isCandidate(ancestor) && (totalCount.get(ancestor) ?? 0) > FAMILY_MAX) return true;
      }
      return false;
    };
    // Shortest first, so "the shortest prefix wins" is the walk order rather
    // than a comparison; the lexical tie-break makes the outcome independent of
    // the input order for two prefixes of the same length.
    const candidates = [...parentCount.keys()]
      .filter(isCandidate)
      .sort((a, b) => a.split("-").length - b.split("-").length || a.localeCompare(b));
    const taken: string[] = [];
    for (const prefix of candidates) {
      if ((parentCount.get(prefix) ?? 0) < FAMILY_MIN) continue;
      if ((totalCount.get(prefix) ?? 0) > FAMILY_MAX) continue;
      if (taken.some((t) => isPrefixOf(t, prefix))) continue;
      if (overCapAncestor(prefix)) continue;
      taken.push(prefix);
    }
    for (const prefix of taken) {
      const carries = (p: WikiListing): boolean => {
        const stem = pageStemOf(p.relPath).toLowerCase();
        return stem === prefix || stem.startsWith(prefix + "-");
      };
      const members = bucket.parents.filter(carries);
      const memberKeys = new Set(members.map((m) => normalizeRel(m.relPath)));
      groups.push({
        kind: "family",
        folder,
        prefix,
        key: familyFoldKey(folder, prefix),
        label: prefix + "-*",
        members,
        // Membership by SUCCESSOR: the child belongs to the slate its successor
        // belongs to, wherever its own name points.
        supersededChildren: bucket.children.filter((c) =>
          memberKeys.has(normalizeRel(c.parent ?? "")),
        ),
      });
    }
  }
  // ⚠️ The LABEL is only unique per folder, and the rail renders every folder at
  // once on the whole-wiki view. Two `beta-flow-*` rows with identical labels,
  // identical `title=` and identical `aria-label` are two controls a reader — or
  // a screen reader — cannot tell apart, so an ambiguous prefix takes its folder
  // with it, exactly as the store's display titles disambiguate a duplicate page
  // name. A unique prefix is unchanged: most wikis never hit this.
  const prefixUses = new Map<string, number>();
  for (const g of groups) prefixUses.set(g.prefix, (prefixUses.get(g.prefix) ?? 0) + 1);
  return groups.map(({ folder, prefix, ...g }) => ({
    ...g,
    label:
      (prefixUses.get(prefix) ?? 0) > 1
        ? // The wiki ROOT has no folder name, so its `""` gives `/beta-flow-*` —
          // which is what the folder facet calls the root (`ROOT_FOLDER`) anyway.
          folder + "/" + prefix + "-*"
        : prefix + "-*",
  }));
}

/**
 * The months among `pages` — the archive folder's grouping under a date sort.
 *
 * The key is `YYYY-MM` from the FILENAME's date prefix where there is one, and
 * from the date the rail is sorting on where there is not. The filename first
 * because that is the date the page is ABOUT: an archive page is named for the
 * day the work happened, while its `updated` stamp moves every time someone
 * fixes a typo in it, and a month grouping that reshuffles on an edit is not a
 * grouping the reader can navigate by.
 *
 * A page with neither is left out of every month and renders as an ordinary
 * row — an "undated" bucket would be a group whose only rule is that the rail
 * knows nothing about its members.
 *
 * Which month starts OPEN is not decided here: it is the newest month that
 * really RENDERS, which only the rail knows (see `defaultOpenGroupKey`).
 */
export function groupMonths(
  pages: readonly WikiListing[],
  which: "added" | "updated",
  now?: number,
): RailGroup[] {
  const order: string[] = [];
  const members = new Map<string, WikiListing[]>();
  for (const p of pages) {
    // A child renders under its parent, wherever that parent lands; a meta page
    // sinks to `Bookkeeping`. Neither is a row a month may claim.
    if (p.parent || isMetaPage(p)) continue;
    const named = DATED_NAME_RE.exec(pageStemOf(p.relPath));
    let month = named ? named[1] + "-" + named[2] : "";
    if (!month) {
      const signal = pageDateSignal(p, which, now);
      if (!signal?.label) continue;
      const m = /^(\d{4})-(\d{2})/.exec(signal.label);
      if (!m) continue;
      month = m[1] + "-" + m[2];
    }
    const arr = members.get(month);
    if (arr) arr.push(p);
    else {
      members.set(month, [p]);
      order.push(month);
    }
  }
  // NEWEST MONTH FIRST, by the KEY — a month's place in the list is a fact about
  // the month, not about the rows inside it. The rail's ordinary rule (a group
  // sits where its first remaining member sorts) puts the months in the order of
  // their newest EDITED page, which on a real archive is neither chronological
  // nor explicable: measured on the wiki this was built against, five months
  // came out 08 · 05 · 07 · 09 · 06, because an old page edited last week pulls
  // its whole month to the top. `orderPagesForGroups` is what makes this order
  // the rendered one.
  order.sort((a, b) => b.localeCompare(a));
  return order.map((month) => ({
    kind: "month" as const,
    key: monthFoldKey(month),
    label: month,
    members: members.get(month)!,
    supersededChildren: [],
  }));
}

/**
 * Re-order `pages` so the rail's own placement rule reproduces `groups`' order:
 * every member of the first group, then of the second, and so on, with the rows
 * inside each group left in the order the caller's sort gave them and the
 * ungrouped rows last.
 *
 * **For MONTHS, and deliberately not for families.** A family interleaves with
 * single pages by age (the plan's rule, and the useful one: a slate is news or
 * it is not), so it must take its position from its members. A month is a time
 * series whose order is its own; see `groupMonths`.
 */
export function orderPagesForGroups(
  pages: readonly WikiListing[],
  groups: readonly RailGroup[],
): WikiListing[] {
  // Keyed on the normalized relPath, not on object identity: the groups and the
  // page list are built from one array today, and a rule that silently degrades
  // to "everything ungrouped" the day they are not is not one worth relying on.
  const rank = new Map<string, number>();
  groups.forEach((g, i) => {
    for (const m of g.members) {
      const key = normalizeRel(m.relPath);
      if (!rank.has(key)) rank.set(key, i);
    }
  });
  const last = groups.length;
  return pages
    .map((p, i) => ({ p, i, rank: rank.get(normalizeRel(p.relPath)) ?? last }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((e) => e.p);
}

/**
 * The groups for one render: months in the archive folder under a date sort,
 * families everywhere else.
 *
 * The two never nest. A month inside a family (or the other way round) is a
 * second level of fold, and the rail renders one — a group inside a closed group
 * is rows nothing on screen can open, which is the failure the attachment layer's
 * one-level-deep invariant exists to prevent.
 */
export function railGroups(
  pages: readonly WikiListing[],
  opts: {
    folder: string;
    sort: WikiSortMode;
    projects: Record<string, number> | readonly string[];
    now?: number;
  },
): RailGroup[] {
  const dateSort = opts.sort === "updated" || opts.sort === "created";
  // Lower-cased on both sides, like `folderOf` and every other relPath
  // comparison in the rail: a facet value of `Archive` is the same folder.
  if ((opts.folder || "").toLowerCase() === MONTH_FOLDER && dateSort) {
    return groupMonths(pages, opts.sort === "created" ? "added" : "updated", opts.now);
  }
  return groupFamilies(pages, opts.projects);
}

/**
 * Is this render's grouping the MONTH one? The question `orderPagesForGroups`
 * answers for — months decide their own order and the rows are re-sorted to
 * match, families take their position from their members.
 *
 * Exported so the caller asks the grouping rather than sniffing
 * `groups[0]?.kind`, which silently stops applying the day a family can precede
 * a month in the array.
 */
export function isMonthGrouping(groups: readonly RailGroup[]): boolean {
  return groups.some((g) => g.kind === "month");
}

/**
 * What a group's row SAYS about what it holds.
 *
 * A family carries a status ROLL-UP — `9 shipped · 1 superseded` — because the
 * question a folded slate raises is "is this finished?", and a bare count
 * answers it with a number the reader then has to open the fold to read. The
 * counts are `plan_status` verbatim, in the facet's own order, with the pages
 * declaring none last — unknown words, that neutral one included, after the
 * known statuses in their own alphabetical order. Superseded children count
 * wherever the rail happens to draw them; `buildRail` decides which of them this
 * render is a census OF (only the LIFT takes one out).
 *
 * A month carries the count, because every page in it says the same thing about
 * itself — that it happened that month.
 *
 * The COMPACT form is the counts alone, in the same order and with the same
 * separator, for the chip's container-query swap (`wiki-rail-width.ts`): the
 * words are moved to the hover at narrow rails, never dropped.
 */
export function groupRollup(
  kind: RailGroupKind,
  members: readonly WikiListing[],
  supersededChildren: readonly WikiListing[] = [],
): { label: string; compact: string; wide: boolean } {
  if (kind === "month") {
    const n = members.length;
    return { label: n + " page" + (n === 1 ? "" : "s"), compact: String(n), wide: false };
  }
  const counts = new Map<string, number>();
  for (const p of [...members, ...supersededChildren]) {
    const status = p.plan_status || NO_STATUS_WORD;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const order = [...counts.keys()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    // Unknown words (the neutral one, and any status a future server adds) sort
    // after the known ones, in their own alphabetical order.
    return (ia === -1 ? STATUS_ORDER.length : ia) - (ib === -1 ? STATUS_ORDER.length : ib) ||
      a.localeCompare(b);
  });
  return {
    label: order.map((s) => counts.get(s) + " " + s).join(" · "),
    compact: order.map((s) => String(counts.get(s))).join(" · "),
    wide: order.length > 1,
  };
}
