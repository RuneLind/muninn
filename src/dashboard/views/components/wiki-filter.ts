/**
 * Pure, side-effect-free helpers for the /wiki reader page. Split out from
 * `wiki-browser.ts` (which has DOM side effects at module load) so these can be
 * unit-tested directly. Mirrors the listing shape sent by
 * `src/dashboard/routes/wiki-routes.ts`.
 */

/**
 * A wiki page's type. Independent client-safe copy of the store's alias (this file
 * has no DOM/server deps so it stays unit-testable). Widened to `string` because a
 * wiki's `.wiki-reader.json` can introduce custom type strings beyond the built-in
 * five — the reader's default ontology lives in `TYPE_ORDER` / `TYPE_LABEL` below.
 */
export type WikiPageType = string;

export interface WikiListing {
  name: string;
  title: string;
  type: WikiPageType;
  domain: "ai" | "life";
  tags: string[];
  aliases: string[];
  created?: string;
  updated?: string;
  url?: string;
  /** Short prose summary — explainers (sniffed from `<meta description>`) and
   *  native blog `.mdx` pages (frontmatter `description`). Rendered as the article
   *  subtitle for `type: blog` pages; feeds the Similar query for explainers only. */
  description?: string;
  /** Validated CSS color token (`#hex` / `rgb()` / `hsl()`) from a blog page's
   *  frontmatter `accent`. Server-sanitized (see `sanitizeColorToken`) — anything
   *  that isn't a strict color token is dropped before it reaches this field, so
   *  it is safe to inject into a `<style>` sink. Only carried by `type: blog` pages
   *  that declared it. */
  accent?: string;
  /** Dark-theme counterpart of `accent` (frontmatter `accentDark`), same
   *  sanitization. Absent ⇒ the light `accent` is used in both themes. */
  accentDark?: string;
  relPath: string;
  /** File mtime (epoch ms) — the recency signal for frontmatter-less wikis. */
  mtimeMs?: number;
  /** File birthtime (epoch ms) — a WEAK "Recently added" signal: `git mv`, a
   *  re-clone, and any sweep writing via temp-file+rename all reset it. Absent when
   *  the filesystem doesn't track it. */
  birthtimeMs?: number;
  /** Creation time from git (epoch ms) — the commit that first introduced the page,
   *  rename-aware. The DURABLE "Recently added" signal (see `src/wiki/git-dates.ts`).
   *  Absent for a non-git or untracked page — which also makes its PRESENCE the
   *  "git knows this page" test `updatedSignal` gates the mtime rule on. */
  gitCreatedMs?: number;
  /** Last-update time from git (epoch ms) — the newest NON-SWEEP commit to touch the
   *  page, rename-aware. The DURABLE "Recently updated" signal: a mass edit moves
   *  every mtime but contributes no touch date at all. Absent for a non-git or
   *  untracked page, and for a page whose every commit was a sweep. */
  gitTouchedMs?: number;
  /** True when git reports the file dirty (modified / untracked). The one condition
   *  under which `mtimeMs` still carries information rather than being a checkout or
   *  sweep artifact. Absent (never `false`) otherwise. */
  gitDirty?: boolean;
  /**
   * Plan lifecycle state, from the frontmatter key `plan_status` — NOT the bare
   * `status`, which melosys-kode-wiki already uses for an unrelated vocabulary.
   * Server-validated against the enum in `src/wiki/store.ts`
   * (`proposed`/`ready`/`in-flight`/`blocked`/`shipped`/`superseded`/`abandoned`),
   * so an unrecognized value never reaches this field.
   * Client-side copy of the store's union, kept a plain `string` for the same
   * reason `WikiPageType` is: this file must stay server-dep-free.
   *
   * **"Absent" below means absent from the JSON payload**, which is what any
   * client of `/api/wiki/pages` sees. In-process the four fields are spread off
   * `WikiPageMeta` and so exist as own properties holding `undefined` on a page
   * that declares none of them; `JSON.stringify` elides those, so the distinction
   * matters only to a key-ITERATING consumer (`Object.keys`/`in`/spread), of which
   * there are none today. Read the values, not the key set.
   */
  plan_status?: string;
  /** When `plan_status` was last affirmed (`YYYY-MM-DD`). Server-validated to that
   *  exact shape AND to being a real calendar day (`2026-02-31` is rejected);
   *  anything looser arrives absent. */
  status_date?: string;
  /** `"open"` | `"none"` — whether the plan has open follow-ups. Absent ⇒ treat as
   *  `none` (both an undeclared field and a rejected value arrive absent). */
  followups?: string;
  /** One line of free prose qualifying the status. Unvalidated by nature; absent
   *  when empty or undeclared. Arrives **unescaped** — the first renderer of this
   *  field owns escaping it at its own sink. */
  status_note?: string;
  linkCount: number;
  backlinkCount: number;
}

export interface WikiFilters {
  q: string;
  domain: string;
  /** Top-level folder, `ROOT_FOLDER` for wiki-root pages, "" for all. */
  folder: string;
  type: string;
  tag: string;
  /** Exact `plan_status` value, "" for all. Independent of `followups` below —
   *  status answers "has it started / is it finished", follow-ups answers "is
   *  anything left over", and a page can be `shipped` with open follow-ups. */
  status: string;
  /** `"open"` (the ⚑ toggle) or "" for all. Compared against the page's
   *  `followups` with an ABSENT value read as `"none"`, per the field contract. */
  followups: string;
}

/**
 * Strict CSS color-token validator for the user-controlled `accent` / `accentDark`
 * frontmatter fields. These are injected into a `<style>` sink (the per-page accent
 * block in the reader), so the ONLY accepted shapes are a `#rgb` / `#rgba` / `#rrggbb`
 * / `#rrggbbaa` hex literal, or a `rgb()/rgba()/hsl()/hsla()` call whose argument list
 * contains only digits, dots, commas, percent signs, and whitespace. Anything else —
 * a named color, a `var(...)`, or an injection attempt like `red;} body{display:none`
 * — returns `undefined` and is dropped. Shared by the server (parse-time sanitize in
 * `src/wiki/store.ts`) and the client (defense-in-depth re-check before injection), so
 * there is exactly one regex. Lives here because this module is pure (no DOM/server
 * deps) and already imported by both sides.
 */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s]+\)$/i;
export function sanitizeColorToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (HEX_COLOR_RE.test(v) || FUNC_COLOR_RE.test(v)) return v;
  return undefined;
}

/** Filter sentinel for pages sitting at the wiki root — no real folder can
 *  collide with it, so it doubles as a selectable value in the folder picker. */
export const ROOT_FOLDER = "/";

export type WikiSortMode = "updated" | "created" | "backlinks" | "title";

/** The built-in type order + labels — the no-`.wiki-reader.json` defaults. A wiki's
 *  merged type list (see `mergeWikiTypes`) always starts with these, so a wiki with
 *  no config renders byte-identically to before. */
export const TYPE_ORDER: string[] = [
  "concept",
  "entity",
  "source",
  "analysis",
  "explainer",
  "note",
];
export const TYPE_LABEL: Record<string, string> = {
  concept: "Concepts",
  entity: "Entities",
  source: "Sources",
  analysis: "Analyses",
  explainer: "Explainers",
  note: "Notes",
};

/**
 * Chip order for the plan-status facet — a client-side copy of the store's
 * `PLAN_STATUS_VALUES` (`src/wiki/store.ts`), kept here for the same reason
 * `TYPE_ORDER` is: this module must stay free of server deps. The server
 * validates against its own list and DROPS anything else, so a value reaching a
 * `WikiListing` is always one of these; the chip row still unions in whatever is
 * actually present (`connectionTypeOrder`) so a future enum member added
 * server-side surfaces instead of vanishing.
 */
export const STATUS_ORDER: string[] = [
  "proposed",
  "ready",
  "in-flight",
  "blocked",
  "shipped",
  "superseded",
  "abandoned",
];

/** The ordered type list + labels the client renders chips/stats/hubs/connections
 *  from — the built-in defaults merged with a wiki's `.wiki-reader.json` customs. */
export interface WikiTypeList {
  order: string[];
  labels: Record<string, string>;
}

/** Capitalize a raw type slug for a fallback label ("subsystem" → "Subsystem"). */
function titleCaseType(t: string): string {
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Merge the built-in ontology (`TYPE_ORDER`/`TYPE_LABEL`) with a wiki's optional
 * `.wiki-reader.json` config into the ordered type list + labels sent to the
 * client. Standard types always come first in their canonical order — so a wiki
 * with no config yields exactly today's constants. Custom types the config
 * introduces (its `typeLabels` keys + `typeMap` values that aren't already
 * standard) are appended, but only when at least one page actually carries them
 * (`presentTypes`); a custom type's label is its `typeLabels` entry, else a
 * title-cased slug. Declaration order is preserved (typeLabels first, then typeMap).
 */
export function mergeWikiTypes(
  config: { typeMap: Record<string, string>; typeLabels: Record<string, string> } | null | undefined,
  presentTypes: Iterable<string>,
): WikiTypeList {
  const order = [...TYPE_ORDER];
  const labels: Record<string, string> = { ...TYPE_LABEL };
  if (!config) return { order, labels };
  const present = new Set(presentTypes);
  const seen = new Set(order);
  const candidates = [...Object.keys(config.typeLabels), ...Object.values(config.typeMap)];
  for (const t of candidates) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (!present.has(t)) continue;
    order.push(t);
    labels[t] = config.typeLabels[t] || titleCaseType(t);
  }
  return { order, labels };
}

/** Distinct non-note page types present in `pages` (the ontology's "content" types). */
function contentTypes(pages: WikiListing[]): Set<string> {
  const s = new Set<string>();
  for (const p of pages) if (p.type !== "note") s.add(p.type);
  return s;
}

/** The per-type hub sections to render on the start view: non-note, non-explainer
 *  types present in `pages`, ordered by `order` (extras alpha-sorted after). Explainers
 *  never join the link graph, so a "by connections" hub of them is always degenerate. */
export function hubTypeList(pages: WikiListing[], order: string[]): string[] {
  const present = contentTypes(pages);
  present.delete("explainer");
  const known = order.filter((t) => t !== "note" && t !== "explainer" && present.has(t));
  const extras = [...present].filter((t) => !order.includes(t)).sort();
  return [...known, ...extras];
}

/** Grouping order for a connections panel: the stored `order` first (types actually
 *  present), then any extra types present in the items but missing from `order`
 *  (alpha). Belt-and-suspenders so a custom-typed neighbor is NEVER dropped even if
 *  the stored list is late/empty — the pre-fix bug excluded such items entirely. */
export function connectionTypeOrder(itemTypes: Iterable<string>, order: string[]): string[] {
  const present = new Set(itemTypes);
  const known = order.filter((t) => present.has(t));
  const extras = [...present].filter((t) => !order.includes(t)).sort();
  return [...known, ...extras];
}

/** The wiki-root-relative top-level folder a page lives in (`ROOT_FOLDER` when it
 *  sits directly in the wiki root). Nested pages report their FIRST segment, so
 *  mimir's `archive/muninn/x.md` is filed under `archive`. */
export function pageFolder(p: WikiListing): string {
  const rel = (p.relPath || "").replace(/\\/g, "/");
  const slash = rel.indexOf("/");
  return slash === -1 ? ROOT_FOLDER : rel.slice(0, slash);
}

/**
 * How far past "now" a FRONTMATTER date may sit and still be trusted as a sort key.
 *
 * 48 hours. The stamps are plain days (`updated: 2026-06-10`) parsed as UTC midnight
 * while "now" is a wall-clock instant, so a page stamped with the author's local day
 * legitimately reads as up to ~14 h in the future in UTC+14 — and a wiki committed
 * from a machine with a skewed clock adds more. 48 h swallows both without admitting
 * the failure this guards: a model-emitted `updated: 2027-01-01`, which nothing can
 * ever exceed and which would therefore pin its page to the top of "Recently updated"
 * permanently. Only frontmatter is clamped — git commit stamps and mtime are machine
 * timestamps of events that actually happened.
 */
export const FUTURE_DATE_SKEW_MS = 48 * 60 * 60 * 1000;

/**
 * True when a parsed frontmatter date is too far ahead of `now` to be a real date.
 * Applied to the frontmatter branch of BOTH recency signals, which then falls back
 * to whatever git/filesystem evidence the page has — so the label stays the date the
 * page actually sorted on.
 *
 * Exported because the wiki LINTER (`src/wiki/lint.ts`) reports the same condition
 * per page: the sort drops a bad stamp silently by design, so without a lint case a
 * single `updated: 2027-01-01` is invisible to an operator. One predicate, one
 * constant, two consumers — the server importing this pure module is the established
 * shape (`src/wiki/store.ts` already imports `sanitizeColorToken` from here).
 */
export function isImplausibleFutureDate(ms: number, now: number): boolean {
  return ms > now + FUTURE_DATE_SKEW_MS;
}

/**
 * The authored stamp `updatedSignal` sorts on: frontmatter `updated`, falling back to
 * `created` when `updated` is absent — **or when it is present but implausible**.
 *
 * That second clause is the whole reason this isn't a bare `p.updated || p.created`.
 * Resolving the chain first and testing plausibility second meant an implausible
 * `updated:` also discarded a perfectly valid `created:`, dropping the page to its git
 * floor (or to undated on a page with no git evidence) — punishing the good stamp for
 * the bad one's sake. An UNPARSEABLE `updated:` deliberately does NOT fall through
 * (that was the pre-guard behavior and this is not the PR that changes it; the linter's
 * `stale-updated` check is what surfaces it).
 */
function authoredUpdatedDate(
  p: WikiListing,
  now: number,
): { ms: number; label: string } | null {
  const primary = p.updated || p.created || "";
  const parsed = primary ? Date.parse(primary) : NaN;
  if (!Number.isFinite(parsed)) return null;
  if (!isImplausibleFutureDate(parsed, now)) return { ms: parsed, label: primary };
  // The resolved candidate is implausible. When it was `updated`, `created` has not had
  // its turn yet.
  if (primary !== p.updated || !p.created) return null;
  const created = Date.parse(p.created);
  if (!Number.isFinite(created) || isImplausibleFutureDate(created, now)) return null;
  return { ms: created, label: p.created };
}

/**
 * The winning "Recently updated" signal for a page: its epoch ms and the label that
 * explains it. **Newest of every TRUSTWORTHY signal wins** — the mirror image of
 * `addedSignal`'s min, for the mirror-image reason: corruption moves a creation date
 * forward and so the oldest claim survives, while an update date is genuinely a "most
 * recent" question and the work is in deciding which signals get to answer it.
 *
 * mtime is the contested one. In a git-managed wiki a clean file's mtime is a
 * checkout or sweep artifact — mimir's 2026-07-31 backfill made all 148 plans report
 * as edited that minute, which is true of the sweep and useless about the pages. But
 * mtime cannot simply be dropped: a page edited RIGHT NOW has no new commit, and its
 * mtime is the only evidence it has. So mtime is trusted exactly when git says the
 * file is DIRTY — which is precisely the case where history doesn't know yet.
 *
 * Three regimes, and the discriminator is `gitCreatedMs`:
 *
 *  - **No git at all** (non-repo wiki, walk failed/timed out): no page carries
 *    `gitCreatedMs`, and this degrades to max(mtime, frontmatter) — byte-identical
 *    to the pre-sweep-awareness behavior.
 *  - **Git-tracked page:** frontmatter, the non-sweep touch date, and mtime-if-dirty
 *    compete; `gitCreatedMs` joins as a FLOOR so a page whose every commit was a
 *    sweep (19 of mimir's 151 plans) falls back to its creation date rather than
 *    sorting as undated. The floor can never win over a real touch — creation
 *    precedes every touch by construction.
 *  - **Untracked page** (a draft never committed): no `gitCreatedMs`, so mtime is
 *    trusted unconditionally and the page sorts to the top, where it belongs.
 *
 * Sort key and label come from ONE function so the list always shows the date it
 * actually sorted on. A frontmatter date is echoed verbatim (it was authored as a
 * plain day; re-deriving it from the parsed UTC instant would shift it in
 * negative-offset timezones), while git dates and mtime are wall-clock instants and
 * so render as LOCAL days — `toISOString()` would label a 00:30 edit in UTC+2 as the
 * previous day, the same drift `computeWikiFreshness` avoids for `log.md`.
 *
 * The frontmatter branch is the one signal that is AUTHORED rather than observed, so
 * it is also the one that can claim a date that hasn't happened: a model-emitted
 * `updated: 2027-01-01` outranks every real signal forever, which no amount of
 * sweep-discounting can undo. A stamp more than `FUTURE_DATE_SKEW_MS` ahead of now is
 * therefore ignored outright — not clamped to now, which would invent a "last edited
 * today" the page never earned — and the page falls back to `created` if that is sound
 * (`authoredUpdatedDate`), else to its git/mtime evidence. Valid past dates are
 * untouched, so no existing ordering moves.
 *
 * `now` is a parameter rather than a `Date.now()` read inside the body because this
 * function runs INSIDE a sort comparator: at the 48h boundary a clock read per call
 * makes the comparator impure, so `sortPages` captures one instant for the whole pass.
 * Label-only call sites (`pageDateLabel` on a rendered row) take the default.
 */
function updatedSignal(
  p: WikiListing,
  now: number = Date.now(),
): { ms: number; label: string; kind: WikiDateKind } {
  const authored = authoredUpdatedDate(p, now);
  let best = { ms: 0, label: "", kind: "updated" as WikiDateKind };
  // Strictly greater, so the FIRST signal considered wins a tie — frontmatter, which
  // is the authored spelling and the one worth showing.
  const consider = (ms: number, label: string, kind: WikiDateKind = "updated") => {
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (ms > best.ms) best = { ms, label, kind };
  };
  const day = (ms: number) => localDay(new Date(ms));
  if (authored) consider(authored.ms, authored.label);
  if (p.gitCreatedMs) {
    if (p.gitTouchedMs) consider(p.gitTouchedMs, day(p.gitTouchedMs));
    if (p.gitDirty && p.mtimeMs) consider(p.mtimeMs, day(p.mtimeMs));
    // The floor, and the ONE branch that isn't an update: this page has never been
    // touched outside a sweep, so the honest word for its date is "added".
    consider(p.gitCreatedMs, day(p.gitCreatedMs), "added");
  } else if (p.mtimeMs) {
    consider(p.mtimeMs, day(p.mtimeMs));
  }
  return best;
}

/**
 * Which question a page's recency date actually answers. `"added"` only for the
 * creation-date fallback — a page whose every commit was a sweep, so nothing is known
 * about when it was last *edited*. That is 19 of mimir's 151 plans but **734 of
 * jarvis's 952 pages (77%)**, which are bulk-ingested and never edited again: at that
 * scale a header reading "updated <creation date>" is a claim the data does not
 * support. Consumed by `pageHeaderDates`, which omits the "updated" slot outright on
 * this kind rather than relabelling it.
 */
export type WikiDateKind = "updated" | "added";

/** The word that honestly describes `pageDateLabel(p)` for this page. See
 *  `WikiDateKind`. */
export function pageDateKind(p: WikiListing, now?: number): WikiDateKind {
  return updatedSignal(p, now).kind;
}

/**
 * BOTH dates for the article header — what the reader actually wants to know about a
 * page it is looking at, as opposed to a list row, which shows the single date it was
 * SORTED on and must keep doing so.
 *
 * One slot whose word flips between "added" and "updated" was the first attempt, and
 * it is too subtle to read: a page showing `updated 2026-05-04` gives no hint whether
 * it was also written that day, and a page showing `added` looks like a typo unless
 * you already know the rule. Two labelled slots say the whole thing.
 *
 * The rules, in order:
 *  - **No KNOWN edit** (`kind === "added"` — every commit that ever touched the page
 *    was a sweep) ⇒ the creation date ALONE. Deliberately NOT derived by comparing the
 *    two labels, because the creation signal takes the OLDEST of its three inputs while
 *    the update signal fell back to the git floor — so the two legitimately differ and a
 *    label comparison would render "updated <git floor>" for a page git records no edit
 *    for. Measured on mimir: 6 pages, driven by `birthtimeMs` older than `gitCreatedMs`
 *    (`blogs/2026-07-16-agent-maturity-assessment.html` — added 07-16, floor 07-17); a
 *    truer frontmatter `created` is the same shape by a different field. Only `kind` knows.
 *  - **Created and last edited on the same day** ⇒ the creation date alone, since
 *    "created X · updated X" is noise.
 *  - Otherwise both, and either one alone when the other has no signal.
 */
export function pageHeaderDates(p: WikiListing): { created?: string; updated?: string } {
  // One clock read for all three signal reads on this page (they must agree).
  const now = Date.now();
  const created = pageAddedLabel(p, now);
  const updated = pageDateLabel(p, now);
  if (pageDateKind(p, now) === "added") return created ? { created } : {};
  if (!created) return updated ? { updated } : {};
  return created === updated ? { created } : { created, updated };
}

/**
 * Recency of a page in epoch ms — the sort key behind "Recently updated". 0 when a
 * page has no usable signal at all. See `updatedSignal` for which signals count and
 * why mtime is conditional.
 *
 * `now` is optional: `sortPages` passes ONE instant captured for the whole pass so the
 * comparator is pure across the 48h future-date boundary; everything else takes the
 * default.
 */
export function pageTimeMs(p: WikiListing, now?: number): number {
  return updatedSignal(p, now).ms;
}

/**
 * `YYYY-MM-DD` for `pageTimeMs` — what the list shows next to a page when it is
 * sorted by recency, so the visible date always explains the ordering. Derived from
 * the same `updatedSignal` as the sort key, so the two cannot drift apart.
 */
export function pageDateLabel(p: WikiListing, now?: number): string {
  return updatedSignal(p, now).label;
}

/**
 * The winning "Recently added" signal for a page: its epoch ms and the label that
 * explains it.
 *
 * **Oldest of every available signal wins** — frontmatter `created`, the git
 * creation date, the file birthtime. This is the mirror image of `pageTimeMs`'s max,
 * and the asymmetry is principled: every way a creation date gets corrupted moves it
 * FORWARD (a re-clone, a `git mv`, a sweep writing via temp-file+rename, a `created:`
 * stamped after the fact), so the oldest surviving claim is the most trustworthy one.
 *
 * Ordering the three by trustworthiness would be the wrong model — `git mv` resets
 * birthtime but git remembers the rename, while a page hand-imported from another
 * repo has a truer `created:` than git's import date. Neither dominates; the min
 * picks whichever one still remembers.
 *
 * Sort key and label come from ONE function so they can never disagree — the list
 * shows the date it actually sorted on. A frontmatter date is echoed verbatim (it was
 * authored as a plain day; re-deriving it from the parsed UTC instant would shift it
 * in negative-offset timezones), while git/birthtime are wall-clock instants and so
 * render as LOCAL days — the same split `pageDateLabel` makes for mtime.
 *
 * The same future-date clamp as `updatedSignal` applies to the frontmatter branch,
 * for a NARROWER but real hole: taking the min means a future `created:` loses to any
 * git date or birthtime the page has, so it only bites a page whose sole signal is the
 * bad stamp — which then sorts to the top of "Recently added" forever. Ignoring it
 * drops such a page to undated (ms 0), which is the honest answer.
 *
 * `now` is a parameter for the same reason `updatedSignal`'s is — this runs inside the
 * "Recently added" comparator, and one clock read per pass keeps it pure at the 48h
 * boundary.
 */
function addedSignal(p: WikiListing, now: number = Date.now()): { ms: number; label: string } {
  const parsedFm = p.created ? Date.parse(p.created) : NaN;
  const fmMs = isImplausibleFutureDate(parsedFm, now) ? NaN : parsedFm;
  let best = { ms: 0, label: "" };
  const consider = (ms: number, label: string) => {
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (best.ms === 0 || ms < best.ms) best = { ms, label };
  };
  if (Number.isFinite(fmMs)) consider(fmMs, p.created!);
  const git = p.gitCreatedMs || 0;
  if (git) consider(git, localDay(new Date(git)));
  const bt = p.birthtimeMs || 0;
  if (bt) consider(bt, localDay(new Date(bt)));
  return best;
}

/**
 * Creation time of a page in epoch ms — the sort key behind "Recently added". The
 * oldest of frontmatter `created`, the git creation date, and the file birthtime;
 * 0 when a page has none of them. See `addedSignal`.
 *
 * Unlike "Recently updated", a mass edit sweep bumping every mtime leaves this
 * ordering untouched — which is the point. A sweep that rewrites files via
 * temp-file+rename bumps every BIRTHTIME too (mimir's 2026-07-31 plan-status
 * backfill did exactly that to 148 files, collapsing the sort into one day), which
 * is why the git date is in the mix.
 */
export function pageAddedMs(p: WikiListing, now?: number): number {
  return addedSignal(p, now).ms;
}

/** Meta/bookkeeping pages (index.md, log.md, CLAUDE.md — any folder). Rewritten
 *  by every sweep, so their birthtime is churn, not content creation: they sink
 *  to the bottom of "Recently added" instead of squatting on top. */
function isMetaPage(p: WikiListing): boolean {
  const stem = (p.relPath || "").replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "");
  return stem === "index" || stem === "log" || stem === "CLAUDE";
}

/**
 * `YYYY-MM-DD` for `pageAddedMs` — shown next to a page when sorted by
 * "Recently added", so the visible date explains the ordering. Derived from the same
 * `addedSignal` as the sort key, so the two cannot drift apart.
 */
export function pageAddedLabel(p: WikiListing, now?: number): string {
  return addedSignal(p, now).label;
}

/** `YYYY-MM-DD` in the viewer's timezone (no UTC shift). */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A page's follow-up state, with the contract's absent-⇒-`none` fold applied
 *  once. An invalid frontmatter value is dropped server-side, so anything other
 *  than `open`/`none` here means "the field never arrived". */
export function pageFollowups(p: WikiListing): string {
  return p.followups || "none";
}

/** Filter pages by the current domain/folder/type/tag/status/follow-ups facets and
 *  the free-text query. Query matches title, canonical name, any alias, or any tag
 *  (all case-insensitive). */
export function filterPages(pages: WikiListing[], filters: WikiFilters): WikiListing[] {
  const q = filters.q.toLowerCase();
  return pages.filter((p) => {
    if (filters.domain && p.domain !== filters.domain) return false;
    if (filters.folder && pageFolder(p) !== filters.folder) return false;
    if (filters.type && p.type !== filters.type) return false;
    if (filters.tag && p.tags.indexOf(filters.tag) === -1) return false;
    if (filters.status && p.plan_status !== filters.status) return false;
    if (filters.followups && pageFollowups(p) !== filters.followups) return false;
    if (!q) return true;
    if (p.title.toLowerCase().indexOf(q) !== -1) return true;
    if (p.name.toLowerCase().indexOf(q) !== -1) return true;
    for (const a of p.aliases) {
      if (a.toLowerCase().indexOf(q) !== -1) return true;
    }
    for (const t of p.tags) {
      if (t.toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  });
}

/** Sort a copy of `pages` by the given mode without mutating the input. Recency
 *  ties (two pages stamped the same day by frontmatter alone) fall back to title
 *  so the order is stable rather than scan-order.
 *
 *  `now` is captured ONCE for the whole pass and threaded into every recency read:
 *  the future-date guard compares against it, so a per-call `Date.now()` would make
 *  the comparator impure for a page sitting exactly at the 48h boundary (a > b and
 *  b > a both true within one sort). Server-side only, so there is no client-clock
 *  concern — this is purely about comparator consistency. */
export function sortPages(pages: WikiListing[], mode: WikiSortMode): WikiListing[] {
  const copy = pages.slice();
  const now = Date.now();
  if (mode === "title") {
    copy.sort((a, b) => a.title.localeCompare(b.title));
  } else if (mode === "backlinks") {
    copy.sort((a, b) => b.backlinkCount - a.backlinkCount);
  } else if (mode === "created") {
    copy.sort(
      (a, b) =>
        Number(isMetaPage(a)) - Number(isMetaPage(b)) ||
        pageAddedMs(b, now) - pageAddedMs(a, now) ||
        a.title.localeCompare(b.title),
    );
  } else {
    copy.sort(
      (a, b) => pageTimeMs(b, now) - pageTimeMs(a, now) || a.title.localeCompare(b.title),
    );
  }
  return copy;
}

/** Count pages per top-level folder, honoring the active domain filter (used for
 *  the folder picker). Keyed by `pageFolder`, so wiki-root pages land under
 *  `ROOT_FOLDER`. */
export function folderCounts(pages: WikiListing[], domain: string): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    const f = pageFolder(p);
    counts[f] = (counts[f] || 0) + 1;
  });
  return counts;
}

/** Count pages per type, honoring the active domain filter (used for the type chip row). */
export function typeCounts(pages: WikiListing[], domain: string): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    counts[p.type] = (counts[p.type] || 0) + 1;
  });
  return counts;
}

/** True when the wiki has ≥2 distinct non-note types — enough of an ontology to
 *  warrant per-type "Top … by connections" hub sections (jarvis: concept/entity/…;
 *  mimir: subsystem/plan/report/…). Wikis that are all `note` (plain markdown, no
 *  frontmatter `type`, no config) fall back to a single cross-type hub instead. */
export function hasTypedHubs(pages: WikiListing[]): boolean {
  return contentTypes(pages).size >= 2;
}

/** Top `limit` pages matching `predicate`, most-linked-to first. Drives the hub
 *  sections: per-type for typed wikis, `backlinkCount > 0` for the untyped fallback. */
export function topPages(
  pages: WikiListing[],
  predicate: (p: WikiListing) => boolean,
  limit = 12,
): WikiListing[] {
  return sortPages(pages.filter(predicate), "backlinks").slice(0, limit);
}

/**
 * Whether this wiki uses the plan-status convention at all — the gate for the
 * whole Status facet (chip row + follow-ups toggle). True as soon as ONE page
 * carries a `plan_status`.
 *
 * Presence is equivalent to validity here: `parsePlanFields` (`src/wiki/store.ts`)
 * drops any value failing the enum before it can reach the payload, so a page that
 * declared a garbage status arrives with the field absent and does NOT open the
 * facet. That is what keeps the row hidden on wikis without the convention (jarvis,
 * melosys-kode-wiki) and on mimir mid-backfill.
 */
export function hasPlanStatus(pages: WikiListing[]): boolean {
  return pages.some((p) => !!p.plan_status);
}

/**
 * Whether to render the Status facet row at all — the WHOLE-WIKI gate, one level
 * above `hasPlanStatus`.
 *
 * `status` and `followups` are independent axes, so a wiki can carry
 * `followups: open` pages and no `plan_status` at all. `hasPlanStatus` alone left
 * that wiki showing ⚑ flags on its rows with no legend and no way to filter by
 * them — the flags are correct, the missing toggle was the bug. So the facet opens
 * on EITHER axis being in use.
 *
 * Deliberately unscoped (whole wiki, not the active domain/type): this decides
 * whether the row exists for this wiki, while `renderStatusChips` separately hides
 * an empty row for the current scope.
 */
export function statusFacetVisible(pages: WikiListing[]): boolean {
  return hasPlanStatus(pages) || followupCount(pages, "", "") > 0;
}

/**
 * Count pages per `plan_status`, honoring the active domain + type filters — the
 * same facets `tagCounts` honors, since the Status row sits beside the tag row
 * below the type row in the Filters disclosure and each row counts within the
 * selection the rows above it have already made. Deliberately NOT filtered by
 * `followups`: the two are independent axes, so cross-filtering the counts would
 * make the ⚑ toggle silently rewrite the status numbers.
 */
export function statusCounts(
  pages: WikiListing[],
  domain: string,
  type: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    if (type && p.type !== type) return;
    if (!p.plan_status) return;
    counts[p.plan_status] = (counts[p.plan_status] || 0) + 1;
  });
  return counts;
}

/** How many pages have OPEN follow-ups — the ⚑ toggle's count. Same domain + type
 *  scoping as `statusCounts`, and likewise independent of the status facet. */
export function followupCount(pages: WikiListing[], domain: string, type: string): number {
  let n = 0;
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    if (type && p.type !== type) return;
    if (pageFollowups(p) === "open") n++;
  });
  return n;
}

/** Count pages per tag, honoring the active domain + type filters (used for the tag chip row). */
export function tagCounts(
  pages: WikiListing[],
  domain: string,
  type: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  pages.forEach((p) => {
    if (domain && p.domain !== domain) return;
    if (type && p.type !== type) return;
    p.tags.forEach((t) => {
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  return counts;
}
