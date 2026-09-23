/**
 * The /wiki page rail's recall aids, DOM-free so the whole rule is unit-testable:
 * the **Activity** and **Pinned** sections, the ★ pin state, and the **Jira-key
 * jump**. The localStorage half is `wiki-recents-store.ts`; the ranking behind
 * Activity is `wiki-activity-rank.ts` (the caller hands the result in); the paint
 * is `renderList` in `wiki-browser.ts`.
 *
 * Why: the rail is a flat listing of every page. Activity lifts what changed,
 * a star keeps what the reader chose, and on the melosys wiki pages are also
 * addressed by Jira key, which the substring search matches in title order
 * rather than in "the issue first, then what talks about it" order.
 *
 * **`Recently opened` is gone** (PR 2 of the rail-tuning slate). Activity answers
 * "what happened here" from the wiki's own dates, and a star answers "keep this"
 * deliberately; an automatic list of the last six pages sat folded between them
 * saying neither. The one thing left of it is the prefix below, which the store's
 * one-time purge needs to drop the dead keys.
 *
 * **One function decides the whole rail.** `buildRail` returns the ordered list
 * of headers and rows, so section placement, de-duplication and the row count
 * are one enumerable rule rather than three branches inside a render loop. The
 * count `renderList` shows is derived from what that list actually renders
 * (`shown`), so no arrangement here can make "N / total" a claim about rows that
 * are not on screen.
 */

import { displayTitleOf, isMetaPage, type WikiFilters, type WikiListing } from "./wiki-filter.ts";
import type { ActivityRow } from "./wiki-activity-rank.ts";
import {
  CLOSED_FOLD_PREFIX,
  closedFoldKey,
  defaultOpenGroupKey,
  type RailGroup,
  type RailGroupKind,
} from "./wiki-groups.ts";
import { findPageByRelPath, normalizeRel } from "./wiki-nav.ts";

/** localStorage key prefixes; the wiki's canonical name (`""` for the default
 *  wiki) is appended, so two wikis in one browser never share a list. Versioned
 *  so a future change of the stored shape can start clean.
 *
 *  `RECENTS_KEY_PREFIX` outlives the feature it named: it is the ONE constant the
 *  store's `purgeRecentsKeys` matches on, so the keys a reader already carries
 *  are dropped rather than left behind forever. Nothing reads those keys — the
 *  parse, the writer and `recentsKey()` went with the section. */
export const RECENTS_KEY_PREFIX = "muninn.wiki.recents.v1:";
export const PINS_KEY_PREFIX = "muninn.wiki.pins.v1:";
/** Which groups this reader has OPENED, per wiki. Default is CLOSED, so the
 *  stored list is the exceptions — which is also why a reader who has never
 *  touched the rail carries no key at all. */
export const FOLDS_KEY_PREFIX = "muninn.wiki.folds.v1:";

/** Pins are the reader's own choice, so the cap is only a bound on the stored
 *  string — but it is enforced on READ as well as on write, so a hand-edited or
 *  corrupted key cannot make the rail unusable. Read and write share the number
 *  so a list AT the cap survives a round trip; the entries themselves do not
 *  round-trip unchanged, since a read normalizes them. */
export const PINS_MAX = 50;
/** How many jump rows render. The header still reports the true total, so a key
 *  with 30 references says so rather than silently showing 8. */
export const JUMP_MAX = 8;
/** How many of a series' Activity-ranked pages a CLOSED series row shows under
 *  it in Activity. The rest sit behind the `+N more` row. */
export const SERIES_PEEK_MAX = 3;

export function pinsKey(wiki: string): string {
  return PINS_KEY_PREFIX + wiki;
}

/**
 * How many fold keys are stored. A bound on the stored string, nothing else —
 * the same settlement `PINS_MAX` makes, enforced on read as well as on write so
 * a hand-edited key cannot make the rail unusable.
 */
export const FOLDS_MAX = 200;

export function foldsKey(wiki: string): string {
  return FOLDS_KEY_PREFIX + wiki;
}

/**
 * The fold key space, deliberately ONE flat string namespace rather than two
 * stores: a page group is keyed by the parent's normalized relPath, a SECTION by
 * a `section:` sentinel. PR 2's family keys join it as a third spelling with no
 * change to the store, the toggle or the parse — which is why the keys go
 * through `normalizeRel` on the way in (as pins do): the sentinels are already
 * lowercase and separator-free, so one normalization serves both kinds and every
 * comparison downstream is exact by construction.
 */
export const SECTION_META_FOLD_KEY = "section:meta";

/**
 * A key in that namespace, normalized: a parent page's relPath, a `section:` or
 * `toggle:` sentinel, or a group's own `family:…` / `month:…` / `closed:…` key.
 *
 * ONE function for all of them on purpose — the page half and the group half
 * were byte-identical twins, and two spellings of one normalization is how the
 * two halves of a comparison come to disagree (the `isPinnedRelPath` story, one
 * layer down). Every comparison downstream is a plain `===` and must be exact by
 * construction.
 */
export function normalizeFoldKey(key: string): string {
  return normalizeRel((key || "").trim());
}

/** Is this group open? Everything not stored is CLOSED — the default the whole
 *  feature is built around, since a rail of open groups is the flat list again. */
export function isFoldOpen(open: readonly string[], key: string): boolean {
  const want = normalizeRel(key);
  return open.some((k) => normalizeRel(k) === want);
}

/**
 * Is this a MODE key rather than one of the fold exceptions `FOLDS_MAX` bounds?
 * Today exactly one: `toggle:families`.
 *
 * A mode says how the whole rail is arranged; a fold key says which single group
 * this reader opened. Capping them together meant the sentinel was evicted after
 * ~200 fold opens and the feature turned itself off with no way to tell that
 * from the reader never having enabled it.
 */
export function isModeFoldKey(key: string): boolean {
  return normalizeFoldKey(key).startsWith("toggle:");
}

/** Flip one group and return the new list. A blank key is a no-op.
 *
 *  ⚠️ **The flip is computed from the RENDERED state, not from the presence of
 *  the spelling handed in.** A group key has two spellings (`month:X` = open,
 *  `closed:month:X` = closed) and the painter offers whichever one flips the
 *  default it is drawing under — so the key also SAYS what that default is: the
 *  `closed:` spelling is only ever offered by the row that defaults open. Both
 *  spellings can already be in the store, because a group moves in and out of
 *  that role as its neighbours arrive and leave. Toggling on presence alone was
 *  then a DEAD CLICK: the entry was removed while `groupFoldState` went on
 *  reading the other spelling, so the row did not move and the second click did
 *  the work. Both spellings are therefore dropped first, and only the exception
 *  to the default is written back — which is also why a plain page or section
 *  key behaves exactly as it always did (its default is closed, so "open" writes
 *  the key and "closed" is its absence).
 *
 *  Mode keys are EXEMPT from the cap and hoisted to the front, which is what
 *  keeps them exempt on the way back IN too: `readFolds` caps at `FOLDS_MAX` as
 *  well, so a sentinel left at the tail would simply fall off on the next boot. */
export function toggleFold(open: string[], key: string): string[] {
  const raw = normalizeFoldKey(key);
  if (!raw) return open.slice();
  const defaultsOpen = raw.startsWith(CLOSED_FOLD_PREFIX);
  const base = defaultsOpen ? raw.slice(CLOSED_FOLD_PREFIX.length) : raw;
  if (!base) return open.slice();
  const closed = closedFoldKey(base);
  const stored = groupFoldState(open, base);
  const openNow = stored ? stored === "open" : defaultsOpen;
  const rest = open.filter((k) => {
    const v = normalizeFoldKey(k);
    return v !== base && v !== closed;
  });
  const wantOpen = !openNow;
  const next = wantOpen === defaultsOpen ? rest : [wantOpen ? base : closed, ...rest];
  const modes = next.filter((k) => isModeFoldKey(k));
  const folds = next.filter((k) => !isModeFoldKey(k)).slice(0, FOLDS_MAX);
  return [...modes, ...folds];
}

/**
 * What the store SAYS about one group, in the two-spelling key space
 * (`wiki-groups.ts`'s `CLOSED_FOLD_PREFIX`): `"open"`, `"closed"`, or
 * `undefined` when the reader has never touched it and the default decides.
 *
 * **The most recent click wins**, which is what the walk order buys: `toggleFold`
 * PREPENDS, so the first of the two spellings found is the one the reader wrote
 * last. A click no longer LEAVES both in the store (it drops both spellings and
 * writes one), but a store this browser already carries can hold both, and
 * "whichever was clicked last" is the only reading of that pair a reader would
 * recognise.
 */
export function groupFoldState(
  open: readonly string[],
  key: string,
): "open" | "closed" | undefined {
  const want = normalizeFoldKey(key);
  const closed = CLOSED_FOLD_PREFIX + want;
  for (const k of open) {
    const v = normalizeFoldKey(k);
    if (v === want) return "open";
    if (v === closed) return "closed";
  }
  return undefined;
}

/**
 * What a CHILD row says on hover: why it folds, and under which page. The rail
 * has no other place to state a relation the file names do not carry — two of
 * the four rules (an embed, a `superseded_by:`) are invisible from the listing.
 */
export function pairedByWhy(pairedBy: string, parentTitle: string): string {
  const under = ` under "${parentTitle}"`;
  switch (pairedBy) {
    case "stem":
      return `Attached${under} — same name, same folder`;
    case "suffix":
      return `Attached${under} — a prototype of it`;
    case "link":
      return `Attached${under} — embedded in the page`;
    case "superseded":
      return `Superseded by "${parentTitle}"`;
    default:
      return `Attached${under}`;
  }
}

/**
 * The two numbers both chip labels are built from — the rows the chip stands
 * for, split by kind. A child lifted into Activity or Pinned has already been
 * taken out of the list this is given.
 */
export function foldChipKinds(children: readonly WikiListing[]): {
  attached: number;
  superseded: number;
} {
  let attached = 0;
  let superseded = 0;
  for (const c of children) {
    if (c.pairedBy === "superseded") superseded++;
    else attached++;
  }
  return { attached, superseded };
}

/**
 * What a group's chip SAYS — `3 attached`, `1 superseded`, or both joined with
 * ` · ` when a page carries attachments and a retired sibling at once.
 */
export function foldChipLabel(children: readonly WikiListing[]): string {
  const { attached, superseded } = foldChipKinds(children);
  const parts: string[] = [];
  if (attached) parts.push(attached + " attached");
  if (superseded) parts.push(superseded + " superseded");
  return parts.join(" · ");
}

/**
 * The same chip, COMPACT: the counts alone (`3 · 1`, or `4` when one kind), in
 * the same order and with the same separator as the full label above. It is what
 * the row renders when the space left beside the title cannot hold the words —
 * the words then ride the chip's `title=`/`aria-label`, which carry the full
 * label either way, so nothing is lost but the reading distance. The digits are
 * the part that must never clip: `10 attached · 1…` and `1 attached · 10…` are
 * the same string where it matters.
 */
export function foldChipCompactLabel(children: readonly WikiListing[]): string {
  const { attached, superseded } = foldChipKinds(children);
  const parts: string[] = [];
  if (attached) parts.push(String(attached));
  if (superseded) parts.push(String(superseded));
  return parts.join(" · ");
}

/**
 * The chip's WORD-size class — which container breakpoint decides when its
 * words yield to the counts (`wiki-page.ts`, the three `@container railmid`
 * rules; budgets in `wiki-rail-width.ts`). Judged on the LABEL both painters
 * build (a page chip's `N attached`, a family roll-up's `N shipped`), so the two
 * cannot classify the same words differently. Three classes because the full
 * label's width is a fact about the label: measured, `99 attached` is 85.5px
 * of chip, `99 superseded` 100.3px and `99 attached · 99 superseded` 170.6px,
 * and one threshold sized for the widest takes the words off every short chip
 * at the default rail. #557 budgeted the one-kind class from `1 attached`
 * alone, so a superseded-only chip painted clipped (`10 supersede…`) at the
 * 260px rail. A one-kind label is LONG when its word is `superseded` (91.7px at
 * one digit) or its count has three digits (`120 attached` 90.0, `999 attached`
 * 92.3 — past the short budget of 88, within the long one of 103).
 */
export function foldChipLabelClass(label: string): "" | "is-long" | "is-wide" {
  if (label.includes(" · ")) return "is-wide";
  const m = /^(\d+) (\S+)$/.exec(label);
  if (!m) return "";
  return m[2] === "superseded" || m[1]!.length >= 3 ? "is-long" : "";
}

/**
 * The chip's DIGIT-size class — how much of the row the COMPACT form is
 * guaranteed, i.e. the `.wiki-list-mid` floor that makes the row wrap before the
 * counts can overflow onto the status pill. Judged on the compact label alone:
 * one count of up to three digits (`999`, 44.8px) is narrow; two counts of up
 * to two digits (`99 · 99`, 60.9px) is the default the floor was sized for;
 * anything wider (`120 · 100` at 70.2px, `999 · 999` at 74.5px, a four-digit
 * single count — `9999` is 51.5px, past the narrow budget — or a family
 * roll-up of three or four statuses) is wide. Four digits go WIDE rather than
 * widening the narrow budget: the 6px that would cover `9999` cost the 260px
 * rail three chip rows on one line (measured 6 wrapped against 3), for a
 * count no page has. The narrow bucket is what keeps a `3 attached` row
 * with a pill and a ⚑ on one line at the default rail; the wide one is what
 * stops a three-digit chip overflowing its box by 3–9px at rails 260–270.
 * On a family or month row neither class can fire: a group row's mid is the
 * rail minus 46.4px, 213.6px at the narrowest, above every floor here.
 */
export function foldChipCountsClass(compact: string): "" | "counts-narrow" | "counts-wide" {
  if (!compact) return "";
  const counts = compact.split(" · ");
  if (counts.length === 1) return counts[0]!.length <= 3 ? "counts-narrow" : "counts-wide";
  if (counts.length === 2 && counts.every((c) => c.length <= 2)) return "";
  return "counts-wide";
}

/**
 * Read a stored list of relPaths back. Everything that is not a JSON array of
 * strings is `[]` — an absent key, an old format, a hand-edited string, `null`,
 * an object. Non-string and blank entries are dropped, duplicates collapse to
 * their FIRST occurrence (the list is ordered, and the first position is the one
 * that was chosen), and the result is capped.
 *
 * A relPath is stored, never a `name`: a wiki with same-stem pages resolves a
 * name to whichever page registered first, so a name-keyed recent would open the
 * wrong page — the exact failure `data-relpath` exists to prevent.
 *
 * ⚠️ **Entries are NORMALIZED here, which is the one boundary relPath identity
 * has.** Case and separators reach this list from directions the index does
 * not control (a `?relPath=` deep link, an Atlas node key, an older build's
 * key), and the comparisons downstream — this dedupe, `togglePin` — are plain
 * `===`. Leaving normalization to each of them was the bug, five times over: it
 * was fixed in the READ half and left raw in the writer, so clicking a star
 * labelled "Unpin this page" appended a SECOND entry for one page, which then
 * rendered twice under a count that said otherwise. Normalizing on the way in
 * makes every one of those comparisons exact by construction instead of correct
 * by inspection.
 */
export function parseRelPathList(raw: string | null | undefined, max: number): string[] {
  if (raw == null || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const v = entry.trim();
    const rel = normalizeRel(v);
    if (!rel || out.indexOf(rel) !== -1) continue;
    out.push(rel);
    if (out.length >= max) break;
  }
  return out;
}

/** The stored form. Always an array, so `parseRelPathList` round-trips it. */
export function serializeRelPathList(list: string[]): string {
  return JSON.stringify(list);
}

/** Add `relPath` to the front of the pin list, or remove it if already there.
 *  A blank relPath is a no-op. At the cap, a new pin displaces the OLDEST —
 *  losing the pin the reader just made would read as a broken control. */
export function togglePin(list: string[], relPath: string): string[] {
  const v = normalizeRel((relPath || "").trim());
  if (!v) return list.slice();
  if (isPinnedRelPath(list, v)) return list.filter((p) => normalizeRel(p) !== v);
  return [v, ...list].slice(0, PINS_MAX);
}

// ── Jira-key jump ─────────────────────────────────────────────────────

/** A key the reader's query named. `key` is set only when the query carried a
 *  project prefix; a bare number knows the issue NUMBER and nothing else, which
 *  is why the two are matched by different predicates below. */
export interface ParsedJiraKey {
  /** `melosys-7588`, lowercased — or `null` for a bare number. */
  key: string | null;
  /** The issue number, digits only. */
  num: string;
  /** What the jump header shows: the key uppercased, or the bare number. */
  display: string;
}

/** `MELOSYS-7588` anywhere in the query. The prefix must start with a letter and
 *  be at least two characters, so a Flyway version (`V155`) is not a Jira key;
 *  the number is 3–6 digits, which covers a project from its first issue to well
 *  past this one. A preceding character, if any, must be a non-alphanumeric, so
 *  the key is a token in the query rather than the tail of an identifier. */
const PREFIXED_RE = /(?:^|[^a-zA-Z0-9])([a-zA-Z][a-zA-Z0-9]{1,9})-(\d{3,6})(?![0-9])/g;
/** A bare `7588`: EXACTLY four digits, bounded by non-alphanumerics. Four is the
 *  shape of the keys on this wiki; three would fire on ordinary numbers and five
 *  would fire on the middle of a longer one. */
const BARE_RE = /(?:^|[^a-zA-Z0-9])(\d{4})(?![0-9])/g;

/**
 * A bare four-digit run in this range is read as a YEAR, never as an issue
 * number. Measured on the real mimir corpus (485 pages): `2026-08-27` is how a
 * reader finds an archive page there — the convention is
 * `archive/<yyyy-mm-dd>-<topic>.mdx` — and as a bare key `2026` resolved to
 * **121 of 485 pages**, pushing the query's one real match below eight unrelated
 * ones under an "Other matches" header. Requiring a `<prefix>-<number>` token
 * is not enough on its own: `retro-2026`, `q1-2026` and `plan-2024` are ordinary
 * tag shapes that match it exactly. Narrowing the prefix to letters was tried
 * and dropped — it pinned nothing the year range does not already close, and a
 * real Jira project key may carry digits.
 *
 * Only the BARE form is affected. `MELOSYS-2026` still parses and still
 * resolves — a reader who means issue 2026 names the project, which is also the
 * only way anyone could tell the two apart.
 */
const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

/**
 * EVERY key a query could be naming, best-shaped first: the prefixed tokens in
 * the order they appear, then the bare four-digit runs. `buildRail` walks this
 * list and takes the first that RESOLVES to a page.
 *
 * That fallback is the whole point, and its absence was a shipped defect: with
 * "the leftmost prefixed match wins, full stop", `V155-2026 MELOSYS-7588` and
 * `ISO-8601 og MELOSYS-7588` both answered about the noise token and showed the
 * reader nothing at all about the key they typed. The module's own defence — a
 * permissive parse is free because a key that resolves to nothing renders
 * nothing — is only true if the next candidate then gets its turn.
 *
 * ⚠️ Residual, deliberately not solved: two key-shaped tokens that BOTH name
 * real pages are genuinely ambiguous (`ISO-8601` is indistinguishable from a
 * Jira key by shape alone), and the leftmost wins. The ordinary results are
 * untouched either way — the jump only ever re-orders and labels.
 */
export function parseJiraKeyCandidates(query: string): ParsedJiraKey[] {
  const q = (query || "").trim();
  if (!q) return [];
  const out: ParsedJiraKey[] = [];
  const seen = new Set<string>();
  const add = (c: ParsedJiraKey): void => {
    const id = c.key ?? c.num;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(c);
  };
  for (const m of q.matchAll(PREFIXED_RE)) {
    const key = (m[1] + "-" + m[2]).toLowerCase();
    add({ key, num: m[2]!, display: key.toUpperCase() });
  }
  for (const m of q.matchAll(BARE_RE)) {
    const n = Number(m[1]);
    if (n >= YEAR_MIN && n <= YEAR_MAX) continue; // a year, not an issue
    add({ key: null, num: m[1]!, display: m[1]! });
  }
  return out;
}

/**
 * The single best-shaped key a query names, or `null` — the first candidate,
 * ignoring whether it resolves. Kept as the parse's own unit, because "what does
 * this string look like" and "which of those is on this wiki" are two questions
 * and only the second needs a page listing.
 *
 * A PREFIXED candidate outranks a bare one wherever both appear, regardless of
 * order: `2026-08-27 MELOSYS-7588` names the issue, not the year.
 */
export function parseJiraKey(query: string): ParsedJiraKey | null {
  return parseJiraKeyCandidates(query)[0] ?? null;
}

/** The pages a key names: the issue's OWN page first, then everything that
 *  mentions it. `total` counts both before the `JUMP_MAX` cut. */
export interface JiraKeyJump {
  parsed: ParsedJiraKey;
  own: WikiListing[];
  refs: WikiListing[];
  /** own + refs, in that order, capped at `JUMP_MAX`. */
  rows: WikiListing[];
  /** own + refs before the cap. */
  total: number;
}

/**
 * Resolve a key against a page listing.
 *
 * **Own page** — the page whose ADDRESS is the issue: its canonical `name`, which
 * `WikiPageMeta` defines as the filename stem (`src/wiki/store.ts`). On the nav
 * wiki that is `sources/jira/<KEY>.md`; the rule is written against the address
 * rather than against that folder so a wiki filing issues elsewhere still works.
 *
 * The address, and deliberately NOT "the title opens with the key": on this wiki
 * the archive pages are titled `MELOSYS-7588 — Opprydding av avrunding`, so a
 * title-opener rule promoted every session note about the issue to an issue
 * page — measured by the enumeration in `wiki-recents.test.ts`, which keeps one.
 *
 * **Reference** — any other page whose tags, title, aliases or relPath name the
 * key. Both query forms are matched with the SAME boundary rule, and both
 * require a whole `<prefix>-<number>` token:
 *
 *  - a prefixed query matches its own key, bounded so `MELOSYS-75880` (a
 *    different issue) is not reported as referencing `MELOSYS-7588`. The bare
 *    branch had that boundary from the start and the prefixed branch was a plain
 *    `indexOf`, so the MORE specific query was the one that lied.
 *  - a bare query matches the number itself, digit-bounded — `Sak 7588 løst` is
 *    how a person writes a reference in prose. Requiring a `<prefix>-<number>`
 *    token here was tried for one round and reverted: it narrowed recall, no
 *    test pinned it, and the case it was reached for (a `2026` query resolving
 *    to 121 of 485 pages on mimir) is closed at the CANDIDATE stage by the year
 *    range above — which had to close it anyway, since `retro-2026` is an
 *    ordinary tag and satisfies the token rule exactly.
 *
 * Input order is preserved inside each group (callers pass the rail's current
 * sort), and an own page never appears again among the references.
 */
export function jiraKeyJump(pages: WikiListing[], parsed: ParsedJiraKey): JiraKeyJump {
  // A bare number matches a key token from any project; a prefixed key matches
  // itself. `isKeyToken` is the WHOLE-token test (a tag, a page name).
  // The bare form accepts the number ALONE as a whole token too, so a page at
  // `sources/jira/7588.md` is the issue's own page rather than a reference to
  // itself — `isKeyToken` and `mentions` describe the same key shape.
  const tokenRe = parsed.key ? null : new RegExp(`^([a-z][a-z0-9]{1,9}-)?${parsed.num}$`);
  const isKeyToken = (token: string): boolean => {
    const t = (token || "").toLowerCase();
    return parsed.key ? t === parsed.key : tokenRe!.test(t);
  };
  // …and this is the same token, found INSIDE prose. Digit-bounded on the right
  // so a longer issue number cannot match; written without a lookbehind, which
  // Safari only learned in 16.4.
  const inTextRe = parsed.key
    ? new RegExp(`(^|[^0-9])${parsed.key}([^0-9]|$)`)
    : new RegExp(`(^|[^0-9])${parsed.num}([^0-9]|$)`);
  const mentions = (text: string): boolean => inTextRe.test((text || "").toLowerCase());

  const own: WikiListing[] = [];
  const refs: WikiListing[] = [];
  for (const p of pages) {
    if (isKeyToken(p.name)) {
      own.push(p);
      continue;
    }
    if (
      p.tags.some(isKeyToken) ||
      mentions(displayTitleOf(p)) ||
      mentions(p.title) ||
      p.aliases.some(mentions) ||
      mentions(p.relPath)
    ) {
      refs.push(p);
    }
  }
  return { parsed, own, refs, rows: [...own, ...refs].slice(0, JUMP_MAX), total: own.length + refs.length };
}

/** The jump's one-line header. States: with and without an own page, one or many
 *  references, none at all, and a total past the cap. */
export function jumpHeaderLabel(jump: JiraKeyJump): string {
  const parts: string[] = [];
  if (jump.own.length === 1) parts.push("issue page");
  else if (jump.own.length > 1) parts.push(jump.own.length + " issue pages");
  if (jump.refs.length) {
    parts.push(jump.refs.length + " referencing page" + (jump.refs.length === 1 ? "" : "s"));
  }
  let label = jump.parsed.display + " · " + (parts.join(" + ") || "no pages");
  if (jump.total > jump.rows.length) label += " (showing " + jump.rows.length + ")";
  return label;
}

// ── The rail ──────────────────────────────────────────────────────────

export type RailSection = "jump" | "activity" | "pinned" | "series" | "all" | "meta";

export type RailEntry =
  | {
      kind: "header";
      section: RailSection;
      label: string;
      /** Set on a FOLDABLE header (today: `Bookkeeping`). The painter renders the
       *  count and the toggle from these; `foldKey` is what a click flips. */
      foldKey?: string;
      folded?: boolean;
      /** Set when the section is open because the reader is ON a page inside it.
       *  The painter renders a control that does not pretend to toggle. */
      forcedOpen?: boolean;
      /** How many rows the header stands for — rendered whether or not they are
       *  on screen, so a collapsed section still says how much it holds. */
      count?: number;
    }
  | {
      kind: "row";
      section: RailSection;
      page: WikiListing;
      pinned: boolean;
      /** Set on Activity rows only: which signal put the page there, how old
       *  that signal is, and the sentence explaining the placement. The painter
       *  draws the glyph, the date cell and the row's `title=` from it. */
      activity?: Pick<ActivityRow, "kind" | "why" | "ageMs" | "worked">;
      /**
       * Set on a PARENT row: the children this row stands for — the ones not
       * emitted anywhere else in this render, which is exactly what the chip
       * counts. Absent on a page with no attachments, and on a parent whose
       * every child was lifted into another section.
       */
      children?: WikiListing[];
      /** Set on a parent row: true when its group is CLOSED, so `children` are
       *  not emitted. The chip says how many are hidden either way. */
      folded?: boolean;
      /** Set on a parent row whose group is open because the OPEN PAGE is inside
       *  it. Its chip is not a toggle — flipping the stored key changes nothing
       *  on screen — so the painter renders it inert rather than dead. */
      forcedOpen?: boolean;
      /** Set on a CHILD row: the page it folds under and why. The painter draws
       *  the hover sentence from it; the row is otherwise an ordinary row, pin
       *  and Activity glyph included. */
      child?: { parent: WikiListing; pairedBy: string };
      /** Set on a child row emitted OUTSIDE its parent's group (Activity ranked
       *  it, or the reader pinned it). It keeps the hover sentence and loses the
       *  indent: a row indented under whatever happens to be above it reads as
       *  that row's child, which is a relation the rail would be inventing. */
      lifted?: boolean;
      /** Set on a row drawn inside an open FAMILY, MONTH or SERIES group: the
       *  group's label, for the painter's indent and the row's hover. A member
       *  lifted into Activity or Pinned does not carry it — it is not in the
       *  group's body there, exactly as a lifted attachment child loses its
       *  indent. */
      member?: { label: string; kind: RailGroupKind };
      /**
       * Set on the NEWEST PLAN of a series, wherever that page renders. The
       * painter draws a `▸` glyph INSIDE the title (never a seventh row
       * element — see `wiki-rail-width.ts`) and says why on hover.
       *
       * Carried on the ROW rather than derived by the painter because the
       * decision is the group's (`RailGroup.latestRel`, computed over every
       * member in the whole listing), and a painter re-deriving it from the
       * rows on screen would move the glyph whenever a facet hid the real one.
       */
      latest?: true;
    }
  | {
      /**
       * A GHOST row: a series member that really is on screen, one section up —
       * the reader pinned it, so it renders under `Pinned` and the series shows
       * a dim, non-clickable placeholder saying so.
       *
       * It exists because the two halves of the rule pull opposite ways: Pinned
       * outranks Series (the ★ is the reader's explicit choice), while the
       * series chip is a census OF the series and must go on counting the page.
       * A silent hole in the fold would make the chip disagree with the rows —
       * the one failure this module is written around — and a second real row
       * would break the one-row-per-page invariant. So the census counts it, the
       * body names it, and `shown` does not.
       */
      kind: "ghost";
      section: RailSection;
      page: WikiListing;
      /** Where the page really is. One value today; a value rather than a
       *  boolean so a second lift reads as a new case rather than as this one.
       *  Activity is not one: it moves the whole series, never one member. */
      reason: "pinned";
    }
  | {
      /**
       * A FAMILY or MONTH row — the one entry that is not a page. It carries no
       * `relPath` and is not counted by `shown`, because nothing about it is a
       * page the reader could open; it is a fold control with a roll-up on it.
       */
      kind: "group";
      section: RailSection;
      group: RailGroup;
      /** The group's IDENTITY in the fold namespace, normalized — what the row
       *  is addressed by (`data-group`), never what a click writes. */
      foldKey: string;
      /**
       * The key a click FLIPS. The group's own key for every group but the one
       * that defaults open, which offers the `closed:` spelling instead so the
       * one generic toggle handler writes a key that means CLOSED forever
       * (`CLOSED_FOLD_PREFIX`).
       */
      toggleKey: string;
      /** The members this row stands for: the ones not emitted anywhere else in
       *  this render, which is what the roll-up counts. */
      members: WikiListing[];
      /** The rule-4 children counted with them (families and series) — on screen
       *  under their own successor, or hidden with it, but members of the slate
       *  either way. */
      superseded: WikiListing[];
      /** SERIES only: the members the reader PINNED, drawn as ghost rows inside
       *  this fold and as real rows under `Pinned`. Counted by the roll-up,
       *  never by `shown`. Absent (never `[]`) when none. */
      ghosts?: WikiListing[];
      /**
       * SERIES only, and only when a facet is hiding part of the series: how
       * many members this row stands for against how many the series holds in
       * the whole listing. The row says `N of M shown`, so a reader under
       * `folder=plans` is told the other pages exist rather than shown a fold
       * that quietly lost them.
       */
      census?: { shown: number; total: number };
      /** True when the group is CLOSED, so its members are not emitted. */
      folded: boolean;
      /** Set when the group is open because the reader is ON a page inside it.
       *  The painter renders a control that does not pretend to toggle. */
      forcedOpen?: boolean;
    }
  | {
      /**
       * The `+N more` row under a CLOSED series in Activity, after its peek rows.
       * A second control for the same fold — a click flips `toggleKey` exactly
       * as the series row does — and, like a group row, not a page: `shown`
       * does not count it.
       */
      kind: "more";
      section: RailSection;
      foldKey: string;
      toggleKey: string;
      /** The members the closed series holds that no peek row shows. */
      hidden: number;
    };

export interface RailInput {
  /** The pages the current facets AND query select, already sorted — today's
   *  rail, unchanged. */
  filtered: WikiListing[];
  /** The pages the current facets select IGNORING the free-text query, same
   *  sort. Only the key jump reads it: the query IS the key, so filtering by it
   *  first would hide every page that references the issue without naming it in
   *  a field the substring search covers. */
  facetOnly: WikiListing[];
  filters: WikiFilters;
  /** Stored relPaths, most recently pinned first. */
  pins: string[];
  /**
   * The Activity ranking over the FILTERED pages, already truncated to the
   * wiki's row count (`rankActivity`). Ranked by the caller rather than here so
   * this module stays free of the scoring rule and of the clock it needs — and
   * because ranking the filtered set is what makes a facet NARROW the section
   * exactly as it narrows Pinned.
   */
  activity?: ActivityRow[];
  /** Recency sort modes only: `sortPages` has sunk the bookkeeping pages
   *  (index/log/CLAUDE) to the tail, so the remainder's trailing meta rows get
   *  a `Bookkeeping` header. Without it the date column jumps back to today at
   *  the bottom of a descending list and reads as a broken sort. */
  metaTail?: boolean;
  /**
   * The fold keys this reader has OPENED (`wiki-recents-store.ts`). Everything
   * else is closed — including every group on a browser that has never stored
   * anything, which is the default the feature is built around.
   */
  openFolds?: readonly string[];
  /**
   * The FAMILY and MONTH groups for this render (`wiki-groups.ts`), or nothing
   * when the reader has the `group families` toggle off. Computed by the caller
   * for the reason `activity` is: this module arranges the rail and owns no
   * grouping rule of its own, and a grouping is testable without one.
   *
   * A group is ignored under a query — a search flattens everything — and a
   * member Activity ranked or the reader pinned leaves its group for that
   * render, the same lift the attachment layer makes.
   */
  groups?: readonly RailGroup[];
  /**
   * The SERIES groups for this render (`groupSeries`), which the caller computes
   * whether or not `group families` is on: a series is an authored key, not a
   * name heuristic, so it is not behind that toggle.
   *
   * They are handed in SEPARATELY from `groups` because the two differ in every
   * way the rail cares about: a series claims its members BEFORE the family and
   * month rules are even computed (the caller does that subtraction — see
   * `withoutSeriesMembers`), Activity never lifts a member out of it (a ranked
   * member moves the WHOLE series into Activity instead), and otherwise it
   * renders as its own block above the remainder rather than at its first
   * member's position.
   *
   * A query flattens them like everything else.
   */
  seriesGroups?: readonly RailGroup[];
  /**
   * The page the reader currently has OPEN, if any. The group HOLDING it is
   * expanded whatever the store says — a reader is never on a page the rail
   * hides, and a collapsed group carrying the `.active` row reads as the rail
   * losing the page. It is not persisted: leaving the page re-collapses it.
   *
   * "Holding it" is judged after the lift. A page Activity ranked or the reader
   * pinned is drawn one section up, so its family is not hiding it and renders
   * on the reader's own stored state instead.
   */
  openRelPath?: string;
}

export interface RailModel {
  entries: RailEntry[];
  /** DISTINCT pages among the rows — what the "N / total" count reports. A page
   *  rendered in both a section and the listing below counts once. */
  shown: number;
}

/**
 * Is this page pinned? THE pin comparison — exported because there were two, and
 * they disagreed: `buildRail` resolved pins through `findPageByRelPath`
 * (case- and separator-insensitive, for the reason that function's own doc
 * gives) while the rail's DOM painter used a raw `indexOf`. Measured live, a
 * pins key holding `CONCEPTS/FILLER-56.MD` rendered the page under `Pinned`
 * while its ★ read "Pin this page"; clicking it appended a SECOND entry for the
 * same page, which then rendered twice under a `#wikiCount` that said otherwise
 * — the "every page appears exactly ONCE" invariant, broken by the two halves
 * answering differently.
 *
 * ⚠️ **This closes the READ halves only, and saying otherwise was wrong.** Round
 * 5 claimed "exactly one pin comparison" while `togglePin` and
 * `parseRelPathList` each still carried their own raw one — so the duplicate
 * survived, with a worse label: the star now READ "Unpin this page" and still
 * appended a second entry. What actually closes it is normalizing at the
 * STORAGE BOUNDARY (`parseRelPathList` on the way in, the writer on the way
 * out), which makes every comparison downstream exact by construction. This
 * function is the comparison for the two sides that hold a page rather than a
 * stored string: `buildRail` and the DOM painter.
 */
export function isPinnedRelPath(pins: readonly string[], relPath: string): boolean {
  const want = normalizeRel(relPath);
  return pins.some((p) => normalizeRel(p) === want);
}

/**
 * Are the recall sections allowed on screen? Only with the search box empty.
 *
 * A facet (domain/folder/type/tag/status/follow-ups) NARROWS them rather than
 * hiding them: `buildRail` resolves Pinned from the FILTERED pages, so under
 * `type=plan` the section is exactly the plans the reader pinned, and a pin from
 * another type does not resolve. The first cut hid the sections on any facet, on
 * the theory that a row from another domain contradicts the filter — but that
 * row was never on screen, and what the reader actually lost was their pins the
 * moment they picked a type. A query is different: a search is "find this", and
 * the Jira-key jump owns that head of the rail.
 */
export function railSectionsVisible(filters: WikiFilters): boolean {
  return !filters.q.trim();
}

/** Resolve stored relPaths against a listing, in the STORED order, dropping what
 *  no longer resolves and what `seen` already accounts for.
 *
 *  `seen` is the caller's running set of pages already rendered, keyed on the
 *  normalized relPath — which is what makes a page Activity already lifted (under
 *  either spelling) render once, up there rather than twice.
 *
 *  Through `findPageByRelPath`, which normalizes case and separators on BOTH
 *  sides — the reader's one relPath lookup, and not an optimisation: a stored
 *  relPath comes back from a `?relPath=` deep link and an Atlas node key
 *  lowercases before it becomes a graph id, so a raw `===` drops a pin that is
 *  in fact still there, with no way to tell it from a deleted page.
 *
 *  Deliberately does not report the misses: an entry is unresolvable both when
 *  its page was deleted and when the listing has not arrived yet, and pruning
 *  storage on the second would erase the reader's pins on every slow load. */
function resolve(relPaths: string[], pages: WikiListing[], seen: Set<string>): WikiListing[] {
  const out: WikiListing[] = [];
  for (const rel of relPaths) {
    const p = findPageByRelPath(pages, rel);
    // Deduped by the PAGE, not by the stored string. Storage is normalized at
    // its own boundary, but this is `buildRail`'s invariant — "every page
    // appears exactly ONCE" — and it must not depend on an upstream that a key
    // written by an older build can violate.
    if (!p || seen.has(normalizeRel(p.relPath))) continue;
    seen.add(normalizeRel(p.relPath));
    out.push(p);
  }
  return out;
}

/**
 * The whole rail, in render order.
 *
 * **The invariant: every page appears exactly ONCE.** Sections MOVE a row up,
 * they never copy it. The first cut left the listing complete and let a lifted
 * page render twice, which was wrong in five measured ways at once:
 * `.wiki-list-item[data-relpath=…]` stopped naming one element (a strict-mode
 * violation for four existing e2e specs), the open page got TWO `.active`
 * highlights, `#wikiCount` disagreed with the rows on screen, `e2e/wiki-refresh`
 * went red counting rows, and the rail grew a row on every article view. The
 * "it is a shortcut to a row dozens of positions down" argument does not survive
 * any of that: the reader gets the row at the top, with a header saying why.
 *
 * The states, enumerated:
 *
 *  - **A query, no key** — the rows exactly as today, with no headers at all.
 *  - **No query, nothing stored** — `Activity` alone (the wiki's own news needs
 *    nothing stored), and on an undated wiki not even that. A fresh browser must
 *    not grow furniture it has nothing to put in.
 *  - **No query, something pinned** — `Activity`, `Pinned`, then `Other pages`:
 *    the listing MINUS what the two sections lifted out of it. **Claim order is
 *    the precedence**, and Activity claims FIRST: a page that is both new and
 *    pinned renders under Activity, because the reader's question at the top of
 *    the rail is "what happened", and a row repeated under Pinned would break the
 *    one-row-per-page invariant above. A page Activity lifted keeps its ★ and its
 *    pin, so a week later it is back under `Pinned`. When the sections lift every
 *    page, there is no remainder and no third header. A facet NARROWS both (they
 *    resolve from the filtered list) rather than hiding them.
 *  - **`metaTail`** (recency sorts, no query) — the remainder's sunk
 *    bookkeeping pages render last under a `Bookkeeping` header, so their
 *    fresh dates at the bottom of a descending list are explained rather than
 *    read as a bug. Only when there IS a list above them — lifted rows count,
 *    so a meta-only remainder under Pinned still gets the header; a rail that
 *    is meta pages ALONE, or any query, renders plain rows.
 *  - **A key that resolves** — the jump block first, then `Other matches` with
 *    the ordinary results minus the jump's rows.
 *  - **A key that resolves to nothing** — the next candidate gets its turn
 *    (`parseJiraKeyCandidates`); when none resolves, no jump block, no header,
 *    ordinary results. That fallback is what makes the permissive parse free.
 *
 * Sections and the jump are mutually exclusive by construction: the jump needs a
 * query and the sections need an empty one.
 *
 * **GROUPS (attachments) obey the same invariant, which is what makes them
 * safe.** A page the store paired (`parent`/`children`) renders under its parent
 * — or, in a closed group, not at all — and never twice:
 *
 *  - **Activity ranks PAGES, not groups.** A child Activity lifts is emitted
 *    there as itself, carrying its `child` info, and leaves its parent's chip
 *    count. A parent Activity lifts takes its open group with it, so a group is
 *    never split across two sections.
 *  - **A closed group emits no child rows**, so `shown` — and with it
 *    `#wikiCount` — goes DOWN, and the chip says by how much. A count that
 *    disagreed with the rows on screen is the failure this whole module is
 *    written around.
 *  - **A query flattens everything.** No groups, no chips, no hidden rows.
 *  - **The open page's group is forced open**, whatever the store holds.
 *  - **A child whose PARENT the facets filtered away is an ordinary row.**
 *    Folding it under a page that is not on screen would delete it from the rail.
 *
 * **FAMILIES and MONTHS (`groups`) are the same invariant one layer up**, and
 * the caller computes them (`wiki-groups.ts`) exactly as it ranks Activity:
 *
 *  - a group row is NOT a page: it carries no relPath, `shown` does not count
 *    it, and a closed group emits none of its members — so `#wikiCount` goes
 *    down and the roll-up says what is behind it;
 *  - **a member Activity ranked or the reader pinned leaves the group** for
 *    that render, and the roll-up drops it: it is on screen, one section up;
 *  - a member that is itself a PARENT keeps its own attachment group inside the
 *    family body, one indent further in;
 *  - the group takes the position of its first remaining member, so the reader's
 *    own sort places it;
 *  - **the open page's group is forced open** — including when the reader is on
 *    an attachment child of a member — but only while that page is still one of
 *    the members this group DRAWS: lifted into Activity or Pinned it is already
 *    on screen, and forcing the group open would hide the reader's own stored
 *    state behind a disabled chip for nothing;
 *  - **one group may default to OPEN**: the newest month among the groups that
 *    render (`defaultOpenGroupKey`), chosen after the lift for the same reason,
 *    and expressed with the `closed:` key spelling so neither key's meaning can
 *    move when the default does;
 *  - and a query flattens groups exactly as it flattens attachments.
 *
 * **SERIES (`seriesGroups`) are placed by Activity, never split by it.** A
 * member Activity ranked (or a member's attachment child) puts the WHOLE series
 * at that Activity slot; closed, it shows up to `SERIES_PEEK_MAX` ranked
 * members and a `+N more` row. A series nothing ranked renders in the `Series`
 * block above the remainder. A pinned member Activity did not rank itself
 * (unranked, or ranked only through its child) renders under `Pinned` and as a
 * ghost in the open series.
 */
export function buildRail(input: RailInput): RailModel {
  const { filtered, facetOnly, filters, pins, metaTail, activity } = input;
  const entries: RailEntry[] = [];
  const isPinned = (p: WikiListing): boolean => isPinnedRelPath(pins, p.relPath);

  /** Every page already rendered above, so the remainder can drop it. */
  const claimed = new Set<string>();
  const claim = (p: WikiListing): void => void claimed.add(normalizeRel(p.relPath));

  // ── Groups ────────────────────────────────────────────────────────────
  // A query FLATTENS everything (the Jira jump's rule, extended): a search is
  // "find this", and a hit hidden inside a closed group is a result the reader
  // asked for and cannot see. Groups are for browsing.
  const grouped = railSectionsVisible(filters);
  const byRel = new Map<string, WikiListing>();
  for (const p of filtered) byRel.set(normalizeRel(p.relPath), p);
  /** parent key → the children of that parent PRESENT in this filtered set. */
  const childrenOf = new Map<string, WikiListing[]>();
  /** child key → its parent page. A child whose parent the facets filtered away
   *  is NOT in here: it renders as an ordinary row rather than vanishing with a
   *  group that is not on screen. */
  const parentOf = new Map<string, WikiListing>();
  if (grouped) {
    /** Every page here that names a parent PRESENT here — the test for "is this
     *  page itself a child", which is how a group two levels deep is refused. */
    const isChild = new Set<string>();
    for (const p of filtered) {
      if (!p.parent) continue;
      const parent = byRel.get(normalizeRel(p.parent));
      if (!parent || parent === p) continue;
      isChild.add(normalizeRel(p.relPath));
    }
    for (const p of filtered) {
      if (!p.parent) continue;
      const parent = byRel.get(normalizeRel(p.parent));
      if (!parent || parent === p) continue;
      // ⚠️ A parent that is ITSELF a child pairs nothing here. One level deep is
      // the STORE's invariant, not a guarantee about the payload this function is
      // handed — and a two-level chain (or a cycle: `a.parent=b`, `b.parent=a`)
      // put every page of it inside a group whose own row was inside another
      // group, so neither was emitted and both vanished from the rail with no
      // count to show for them. Dropping the pairing leaves ordinary rows, which
      // is the one degrade that cannot lose a page.
      if (isChild.has(normalizeRel(parent.relPath))) continue;
      const key = normalizeRel(parent.relPath);
      const arr = childrenOf.get(key);
      if (arr) arr.push(p);
      else childrenOf.set(key, [p]);
      parentOf.set(normalizeRel(p.relPath), parent);
    }
  }
  // ── Families and months ───────────────────────────────────────────────
  // The second grouping layer, and it obeys the same invariant: a group MOVES
  // its members into its own block, it never copies them, and a member the
  // Activity ranking or the reader's pin took is not in the block at all.
  /** page key → the series/family/month group it belongs to in this render. */
  const groupOf = new Map<string, RailGroup>();
  /** group key → its members PRESENT in this filtered set, in the sort's order. */
  const groupMembers = new Map<string, WikiListing[]>();
  const seriesList = grouped ? (input.seriesGroups ?? []) : [];
  const registerGroups = (gs: readonly RailGroup[]): void => {
    for (const g of gs) {
      const key = normalizeFoldKey(g.key);
      const present: WikiListing[] = [];
      for (const m of g.members) {
        const mk = normalizeRel(m.relPath);
        // ⚠️ A page that is an attachment CHILD here is not a group member,
        // whatever the grouping said: it renders under its parent, and claiming
        // it for a family as well would put one page in two blocks.
        if (!byRel.has(mk) || parentOf.has(mk) || groupOf.has(mk)) continue;
        groupOf.set(mk, g);
        present.push(m);
      }
      if (present.length) groupMembers.set(key, present);
    }
  };
  if (grouped) {
    // ⚠️ SERIES FIRST, and that order is the precedence rule. A page carrying a
    // `series:` key is in that series and nowhere else — the caller has already
    // taken those pages out of the set the family and month rules were computed
    // over, so a family that lost a member below `FAMILY_MIN` never formed at
    // all; this skip is what holds the line for a family the caller DID hand in
    // (a stale groups array, a caller that forgot the subtraction) rather than
    // the mechanism.
    registerGroups(seriesList);
    registerGroups(input.groups ?? []);
  }
  /** Is this page claimed by a SERIES in this render? The remainder skips it:
   *  the series block above has already accounted for it, open or closed. */
  const inSeries = (p: WikiListing): boolean =>
    groupOf.get(normalizeRel(p.relPath))?.kind === "series";
  /** The newest plan of each series, keyed on relPath — the rows that earn the
   *  `▸`, wherever they render (a pinned one keeps it under `Pinned`). */
  const latestRels = new Set<string>();
  for (const g of seriesList) if (g.latestRel) latestRels.add(normalizeRel(g.latestRel));

  const open = input.openFolds ?? [];
  // The open page forces ITS group open — the group it is in when it is a child,
  // its own when it is a parent, and `Bookkeeping` when it is a meta page.
  const forced = new Set<string>();
  if (grouped && input.openRelPath) {
    const openKey = normalizeRel(input.openRelPath);
    const openPage = byRel.get(openKey);
    const openParent = parentOf.get(openKey);
    if (openParent) forced.add(normalizeRel(openParent.relPath));
    if (childrenOf.has(openKey)) forced.add(openKey);
    if (openPage && isMetaPage(openPage)) forced.add(SECTION_META_FOLD_KEY);
    // NB the FAMILY or MONTH holding the open page is NOT forced here: whether
    // it should be depends on the lift, which has not happened yet. See
    // `forcedGroupKey` below.
  }
  const isOpen = (key: string): boolean => forced.has(key) || isFoldOpen(open, key);

  /**
   * The children LIFTED out of their groups by this render — the ones Activity
   * ranked or the reader pinned, which are emitted as rows of their own wherever
   * that section puts them.
   *
   * ⚠️ Filled BEFORE the first row is emitted, and that is the whole point. The
   * chip stands for "the rows this group is hiding", so it has to be counted
   * against the FINAL placement of every child — and `claimed` only knows about
   * the rows drawn SO FAR. Activity emits in rank order, so a parent ranked above
   * its own child was drawn while that child was still unclaimed: the chip said
   * `2 attached` and the render then drew one of the two, one row further down.
   */
  const lifted = new Set<string>();

  /**
   * EVERY page the recall sections took for this render — Activity's rows and
   * the resolved pins, members and children alike. `lifted` above is the subset
   * the attachment chips need (children only); this is the set the family/month
   * census and the forced-open rule are computed from.
   *
   * ⚠️ Not `claimed`: a census is a fact about the SLATE, so it may only be a
   * function of the lift — "what has been painted so far" is a fact about the
   * sort. That is the rule this set STATES; it is not what closed the
   * sort-dependent roll-up. The measured bug (one slate reading `3 shipped`
   * with its successor above the family and `3 shipped · 1 superseded` below)
   * was a child belonging to the wrong family, and it is closed by SUCCESSOR
   * membership in `groupFamilies` — a rule-4 child belongs to the slate its
   * successor belongs to, so a stray retired page never reaches this census at
   * all. With that in place `claimed` and `sectionLifted` cannot disagree HERE
   * (a page in `claimed` but not `sectionLifted` was painted by an earlier
   * group or the remainder, and neither can hold this family's member or the
   * successor of its rule-4 child), so the choice is one of intent, not of
   * behaviour.
   */
  const sectionLifted = new Set<string>();

  /** Emit one row, claiming the page. A PARENT row takes its unclaimed, unlifted
   *  children with it — under it when the group is open, into the chip's count
   *  when it is closed — so a group is never split across two sections. */
  const emitRow = (
    page: WikiListing,
    section: RailSection,
    extra: {
      activity?: Pick<ActivityRow, "kind" | "why" | "ageMs" | "worked">;
      /** True only on the recursive call below, i.e. the row really is drawn
       *  inside its parent's group. A row emitted anywhere else is `lifted`. */
      underParent?: boolean;
      /** Set only by the family/month block below, i.e. the row really is drawn
       *  inside that group's body. A member lifted into Activity or Pinned is
       *  emitted without it, and so without the indent. */
      inGroup?: RailGroup;
    } = {},
  ): void => {
    const key = normalizeRel(page.relPath);
    const parent = parentOf.get(key);
    const mine = (childrenOf.get(key) ?? []).filter(
      (c) => !claimed.has(normalizeRel(c.relPath)) && !lifted.has(normalizeRel(c.relPath)),
    );
    const folded = mine.length > 0 ? !isOpen(key) : undefined;
    claim(page);
    entries.push({
      kind: "row",
      section,
      page,
      pinned: isPinned(page),
      ...(extra.activity ? { activity: extra.activity } : {}),
      // `forcedOpen` rides the row so the painter can render a chip that does not
      // pretend to toggle: this group is open because the reader is ON a page
      // inside it, and a click can only write a stored key with no visible effect.
      ...(mine.length ? { children: mine, folded, ...(forced.has(key) ? { forcedOpen: true } : {}) } : {}),
      ...(parent
        ? {
            child: { parent, pairedBy: page.pairedBy ?? "" },
            ...(extra.underParent ? {} : { lifted: true }),
          }
        : {}),
      ...(extra.inGroup
        ? { member: { label: extra.inGroup.label, kind: extra.inGroup.kind } }
        : {}),
      ...(latestRels.has(key) ? { latest: true as const } : {}),
    });
    if (mine.length && !folded) {
      // A child of a group MEMBER stays inside its own parent's group and
      // inherits the membership, so the painter can indent it one level further
      // rather than drawing it at the family's own depth — where it would read
      // as a sibling of the page it belongs to.
      for (const c of mine) emitRow(c, section, { underParent: true, inGroup: extra.inGroup });
    }
  };

  // The first candidate key that names a page on this wiki wins; a candidate
  // resolving to nothing costs nothing and yields to the next.
  let jump: JiraKeyJump | null = null;
  for (const candidate of parseJiraKeyCandidates(filters.q)) {
    const resolved = jiraKeyJump(facetOnly, candidate);
    if (resolved.total > 0) {
      jump = resolved;
      break;
    }
  }

  if (jump) {
    entries.push({ kind: "header", section: "jump", label: jumpHeaderLabel(jump) });
    for (const p of jump.rows) {
      entries.push({ kind: "row", section: "jump", page: p, pinned: isPinned(p) });
      claim(p);
    }
  }

  // ── Activity and Pinned: what they take ───────────────────────────────
  // ⚠️ Activity claims BEFORE the pin list, so a page it lifts is skipped by
  // Pinned and the remainder alike. Moving this block below it silently changes
  // which section a new pinned page renders under, and nothing but this
  // ordering decides it.
  //
  // Collected here and EMITTED further down, after the groups' open state is
  // known: a series Activity ranked renders at its Activity slot, and whether
  // that row is open depends on the lift both sections make.
  /** One Activity slot: a page, or a series one of its pages earned. */
  type ActivityItem = { row: ActivityRow } | { seriesKey: string };
  const activityItems: ActivityItem[] = [];
  const activityRows: ActivityRow[] = [];
  /**
   * The series Activity ranked, by fold key: the series and the members that put
   * it there, in rank order. A member's attachment child ranks FOR its parent —
   * the child renders under that parent, never as a loose Activity row.
   */
  const activitySeries = new Map<string, { group: RailGroup; ranked: WikiListing[] }>();
  /** page key → the Activity row that ranked it, for the date cell of a series
   *  member drawn in Activity. */
  const activityOf = new Map<string, ActivityRow>();
  /** Series members Activity ranked THEMSELVES — not only through a child. Only
   *  these outrank a pin: a ★ on a page whose diagram changed stays a ★. */
  const selfRanked = new Set<string>();
  /** The series member a page ranks FOR: itself, or the member it is attached
   *  to. Null for a page no series holds. */
  const seriesHolderOf = (p: WikiListing): { group: RailGroup; holder: WikiListing } | null => {
    const key = normalizeRel(p.relPath);
    const own = groupOf.get(key);
    if (own?.kind === "series") return { group: own, holder: p };
    const parent = parentOf.get(key);
    const viaParent = parent ? groupOf.get(normalizeRel(parent.relPath)) : undefined;
    if (parent && viaParent?.kind === "series") return { group: viaParent, holder: parent };
    return null;
  };
  let pinned: WikiListing[] = [];
  if (grouped) {
    // Deduped by PAGE, like `resolve` and for the same reason: the
    // one-row-per-page invariant must not depend on the caller's input being
    // duplicate-free.
    const seen = new Set<string>();
    for (const row of activity ?? []) {
      const rel = normalizeRel(row.page.relPath);
      if (claimed.has(rel) || seen.has(rel)) continue;
      seen.add(rel);
      // ⚠️ A SERIES MEMBER MOVES THE WHOLE SERIES, and this is the one place it
      // is decided — the deliberate difference from a family, where "Activity
      // ranks PAGES, not groups" lifts a member out. A series is the work the
      // reader returns to: lifting its newest page alone renders the series
      // without the member the whole row is about, and leaving it in a block
      // below Activity hid the reader's newest work under week-old rows
      // (measured on melosys-kode-wiki: a 15h member below an 8d Activity top).
      // So the series takes the slot of its best-ranked member. Pinned is the
      // other way round (the ★ is explicit), and that lift leaves a ghost row.
      const held = seriesHolderOf(row.page);
      if (held) {
        const foldKey = normalizeFoldKey(held.group.key);
        let entry = activitySeries.get(foldKey);
        if (!entry) {
          entry = { group: held.group, ranked: [] };
          activitySeries.set(foldKey, entry);
          activityItems.push({ seriesKey: foldKey });
        }
        const holderKey = normalizeRel(held.holder.relPath);
        if (!entry.ranked.some((m) => normalizeRel(m.relPath) === holderKey)) entry.ranked.push(held.holder);
        // The holder's date cell is the best signal that ranked it — its own, or
        // its child's when only the child ranked. First seen is best: rank order.
        if (!activityOf.has(holderKey)) activityOf.set(holderKey, row);
        if (held.holder === row.page) selfRanked.add(holderKey);
        continue;
      }
      activityRows.push(row);
      activityItems.push({ row });
    }
    // Activity wins the overlap because the SEEN set is shared: a page it already
    // took is skipped here, whatever spelling the pin list holds it under. There
    // used to be a `!isPinned` filter on this line as well, and having two
    // mechanisms for one outcome meant NEITHER was pinned — a review survey found
    // that unsharing the set and dropping the filter each survived the whole
    // suite, while doing both together failed.
    //
    // A series member Activity ranked ITSELF counts as taken too: it renders in
    // its series' Activity row, so a pin on it must not draw it a second time.
    // One ranked only through its attachment child does not — its pin resolves,
    // and the series row names it as a ghost like any pinned member.
    //
    // Resolved BEFORE the Activity rows are emitted (against a COPY of `claimed`,
    // since nothing is drawn yet) for the two-pass reason above: both sections'
    // placements have to be known before the first chip is counted.
    const pinSeen = new Set(claimed);
    for (const row of activityRows) pinSeen.add(normalizeRel(row.page.relPath));
    for (const key of selfRanked) pinSeen.add(key);
    pinned = resolve(pins, filtered, pinSeen);
    for (const p of [...activityRows.map((r) => r.page), ...pinned]) {
      const key = normalizeRel(p.relPath);
      sectionLifted.add(key);
      if (parentOf.has(key)) lifted.add(key);
    }
  }
  /** The ranked members a CLOSED series row in Activity shows under it — never
   *  one a pin lifted to `Pinned`, which is on screen there already. */
  const peekOf = (foldKey: string): WikiListing[] =>
    (activitySeries.get(foldKey)?.ranked ?? [])
      .filter((m) => !sectionLifted.has(normalizeRel(m.relPath)))
      .slice(0, SERIES_PEEK_MAX);

  // ── The groups' open state, decided AFTER the lift ────────────────────
  // ⚠️ Computed HERE, above every emit, because the series rows emit in Activity
  // AND in their own block, and both need the same open-state rule the family
  // and month rows use. It depends only on `sectionLifted` (filled by Activity
  // and Pinned above) and on `groupMembers`, never on the remainder.
  /** The members of one group that the recall sections did not take. */
  const unlifted = (g: RailGroup): WikiListing[] =>
    (groupMembers.get(normalizeFoldKey(g.key)) ?? []).filter(
      (m) => !sectionLifted.has(normalizeRel(m.relPath)),
    );
  /** The FAMILY and MONTH groups this render really DRAWS — the ones with a
   *  member left. The default-open rule below is a function of this set rather
   *  than of the grouping, because a group nothing draws cannot carry a default.
   *
   *  Series are deliberately out: only a month can default open, and a series
   *  draws on a different test anyway (it renders on a ghost row alone). */
  const renderedGroups = (input.groups ?? []).filter((g) => unlifted(g).length > 0);
  const defaultOpenKey = defaultOpenGroupKey(renderedGroups);
  /**
   * The group forced open by the reader being ON a page inside it — and only
   * while that page (or, for an attachment child, its successor) is still one of
   * the members this group is going to DRAW. With the page lifted into Activity
   * or Pinned it is already on screen one section up, so forcing the group open
   * hid the reader's own stored state behind a disabled chip for nothing.
   *
   * ⚠️ NEITHER of them may be lifted, and the open page's OWN lift is the half
   * that is easy to miss: when the open page is an attachment CHILD, the holder
   * is its successor, which is an ordinary unlifted member — so pinning the
   * child the reader is looking at put it in Pinned AND forced its successor's
   * family open behind a dead control.
   *
   * A series in Activity is not forced open for a member its closed row PEEKS
   * either: that member is on screen with the series closed.
   */
  let forcedGroupKey: string | null = null;
  if (grouped && input.openRelPath) {
    const openKey = normalizeRel(input.openRelPath);
    const openParent = parentOf.get(openKey);
    const holderKey = groupOf.has(openKey)
      ? openKey
      : openParent && groupOf.has(normalizeRel(openParent.relPath))
        ? normalizeRel(openParent.relPath)
        : null;
    if (holderKey && !sectionLifted.has(openKey) && !sectionLifted.has(holderKey)) {
      const foldKey = normalizeFoldKey(groupOf.get(holderKey)!.key);
      const peeked = peekOf(foldKey).some((m) => normalizeRel(m.relPath) === holderKey);
      if (!peeked) forcedGroupKey = foldKey;
    }
  }
  /** A GROUP's open state: forced, else whichever spelling the reader wrote
   *  last, else this render's default (the newest month that draws). A series
   *  reads exactly the same rule — it just never carries the default. */
  const isGroupExpanded = (key: string): boolean => {
    if (forcedGroupKey === key) return true;
    const stored = groupFoldState(open, key);
    if (stored) return stored === "open";
    return key === defaultOpenKey;
  };

  /**
   * Emit one SERIES: its row, then its body. Returns false when nothing of it is
   * on screen. Shared by the series Activity ranked (drawn at its Activity slot)
   * and the rest (drawn in their own block below).
   *
   * An OPEN series draws every member, newest first, then its ghosts. A CLOSED
   * series in Activity draws the members Activity ranked (up to
   * `SERIES_PEEK_MAX`, in rank order) and a `+N more` row for the rest — the
   * newest work is on screen without opening anything, and the row above says
   * which piece of work it belongs to.
   */
  const emitSeries = (g: RailGroup, section: RailSection, beforeRow?: () => void): boolean => {
    const foldKey = normalizeFoldKey(g.key);
    const present = groupMembers.get(foldKey) ?? [];
    const members = unlifted(g);
    // The members the reader PINNED: on screen under `Pinned`, and named here as
    // ghost rows so the fold does not silently lose them.
    const ghosts = present.filter((m) => sectionLifted.has(normalizeRel(m.relPath)));
    // ⚠️ EVERY rule-4 child in the filtered set counts — unlike a FAMILY's
    // census below, where the lift really does take a page out of the slate for
    // that render. A series' census says which of its members this render holds,
    // not which ones are painted (a CLOSED fold paints none of them and still
    // says `4 of 4`), and the three placements a retired child can take are all
    // inside it: under its successor in the body, under that successor where
    // Activity or a pin lifted the successor one section up, and as its own row
    // where the reader pinned the child. Dropping the lifted-PARENT case made a
    // series with one pinned member holding one retired child read
    // `1 of 2 shown` with nothing hidden, and cost the roll-up its
    // `1 superseded`.
    const superseded = g.supersededChildren;
    // A series with neither a member nor a ghost present is not on screen at
    // all — a facet took every page of it — and a header standing for nothing
    // is furniture.
    if (!members.length && !ghosts.length) return false;
    beforeRow?.();
    const shown = members.length + ghosts.length + superseded.length;
    const expanded = isGroupExpanded(foldKey);
    entries.push({
      kind: "group",
      section,
      group: g,
      foldKey,
      // A series never defaults open, so it never offers the `closed:` spelling:
      // its own key is what a click writes, and its absence means closed forever.
      toggleKey: foldKey,
      members,
      superseded,
      ...(ghosts.length ? { ghosts } : {}),
      // Only when the facets are really hiding part of the series: `3 of 3` is a
      // number that reports nothing and reads as a warning. `total` is optional
      // on `RailGroup` because a family and a month carry none; `?? shown` is
      // that absence read as "nothing is hidden", not a guard — a series always
      // sets it.
      ...(shown < (g.total ?? shown) ? { census: { shown, total: g.total! } } : {}),
      folded: !expanded,
      ...(forcedGroupKey === foldKey ? { forcedOpen: true } : {}),
    });
    const memberRow = (m: WikiListing): void => {
      const act = activityOf.get(normalizeRel(m.relPath));
      emitRow(m, section, {
        inGroup: g,
        ...(act ? { activity: { kind: act.kind, why: act.why, ageMs: act.ageMs, ...(act.worked ? { worked: true } : {}) } } : {}),
      });
    };
    if (expanded) {
      for (const m of members) memberRow(m);
      // Ghosts last: they are a footnote about pages that are already on screen,
      // not content, and interleaving them into the date order would cost the
      // member rows their own.
      for (const p of ghosts) entries.push({ kind: "ghost", section, page: p, reason: "pinned" });
      return true;
    }
    const peek = peekOf(foldKey);
    if (!peek.length) return true;
    for (const m of peek) memberRow(m);
    const hidden = members.length - peek.length;
    if (hidden > 0) entries.push({ kind: "more", section, foldKey, toggleKey: foldKey, hidden });
    return true;
  };

  if (grouped) {
    if (activityItems.length) {
      entries.push({ kind: "header", section: "activity", label: "Activity" });
      for (const item of activityItems) {
        if ("seriesKey" in item) {
          emitSeries(activitySeries.get(item.seriesKey)!.group, "activity");
          continue;
        }
        const row = item.row;
        // ⚠️ Re-tested against `claimed` HERE, not only at collection time: a
        // PARENT emitted earlier in this same section takes its open group's
        // children with it. Every child Activity ranked is `lifted`, so this is a
        // belt-and-braces re-test of the one-row invariant rather than the
        // mechanism — the mechanism is the lift.
        if (claimed.has(normalizeRel(row.page.relPath))) continue;
        emitRow(row.page, "activity", {
          activity: { kind: row.kind, why: row.why, ageMs: row.ageMs, ...(row.worked ? { worked: true } : {}) },
        });
      }
    }
    if (pinned.length) {
      entries.push({ kind: "header", section: "pinned", label: "Pinned" });
      for (const p of pinned) {
        // A pinned CHILD is lifted here exactly as Activity lifts one — the ★ is
        // the reader's own choice, and a row they asked to keep at hand must not
        // sit inside a closed group. No `claimed` re-test: `resolve` above both
        // skipped what an earlier section took AND claimed what it returned, so
        // testing it here would skip every pinned row (measured — it did).
        emitRow(p, "pinned");
      }
    }
  }

  // ── Series ────────────────────────────────────────────────────────────
  // Their own block, above the remainder: a series is the piece of work the
  // reader came back to, and interleaving it with the listing by date would put
  // it wherever its newest page happens to sort on whichever sort is selected.
  // A series Activity ranked is already drawn at its Activity slot, so this
  // block holds the series nothing recent touched — older context.
  // Within the block the groups keep the order they were HANDED IN — which the
  // caller sets with `orderSeriesGroups`, not `groupSeries` (whose own output is
  // first appearance in the caller's sorted list). The rail owns no ordering
  // rule of its own; see that function for what each sort mode means here.
  let seriesEmitted = activitySeries.size > 0;
  let seriesHeader = false;
  for (const g of seriesList) {
    if (activitySeries.has(normalizeFoldKey(g.key))) continue;
    const drawn = emitSeries(g, "series", () => {
      if (seriesHeader) return;
      entries.push({ kind: "header", section: "series", label: "Series" });
      seriesHeader = true;
    });
    if (drawn) seriesEmitted = true;
  }

  const remainder = filtered.filter((p) => {
    const key = normalizeRel(p.relPath);
    // A series member is accounted for by the block above whether that fold is
    // open or closed, so it never falls through to the listing — the rule the
    // family loop gets for free by emitting its groups from inside this list.
    return !claimed.has(key) && !parentOf.has(key) && !inSeries(p);
  });
  // The Bookkeeping split is a recency-list affordance and nothing else: under
  // a query the rows are exactly as today (a result list grows no furniture),
  // and a header explains a TAIL — it needs rows ABOVE it, lifted (Activity /
  // Pinned), in a series block, or in the remainder. With nothing above, the
  // meta pages are the whole list and render plain. `remainder.some(non-meta)`
  // alone was wrong here: with every non-meta row lifted, the meta-only
  // remainder fell through to the `Other pages` header instead — labelled, and
  // wrongly. `seriesEmitted` joins `claimed` because a CLOSED series draws a row
  // and claims no page, so the count alone would report an empty rail above.
  const above = claimed.size > 0 || seriesEmitted;
  const split = !!metaTail && grouped && (above || remainder.some((p) => !isMetaPage(p)));
  const rest = split ? remainder.filter((p) => !isMetaPage(p)) : remainder;
  const meta = split ? remainder.filter((p) => isMetaPage(p)) : [];
  if (above && rest.length) {
    entries.push({ kind: "header", section: "all", label: jump ? "Other matches" : "Other pages" });
  }


  // No `claimed` re-test: `remainder` is computed from `claimed` a few lines up
  // and nothing between them emits, and a page in it has no parent here, so no
  // earlier group could have taken it.
  //
  // A FAMILY or MONTH takes the position of its first remaining member, so the
  // sort the reader chose is what places it: under a date sort that is the
  // newest member (which is the family's age), under Title A–Z the member whose
  // title sorts first, and under Most linked the most-linked one. A group is
  // emitted once, at that position; its other members are skipped when the loop
  // reaches them.
  const groupsEmitted = new Set<string>();
  for (const p of rest) {
    const g = groupOf.get(normalizeRel(p.relPath));
    if (!g) {
      emitRow(p, "all");
      continue;
    }
    const foldKey = normalizeFoldKey(g.key);
    if (groupsEmitted.has(foldKey)) continue;
    groupsEmitted.add(foldKey);
    // The members this row stands for: the ones no recall section lifted. `p` is
    // one of them (it is in `rest`, so nothing took it), so this is never empty.
    const members = unlifted(g);
    // The rule-4 children counted with them — a CENSUS of the slate, so a child
    // rendered under its own successor inside this body still counts and only
    // the LIFT removes one. A child is out when the reader is looking at it (or
    // at its successor) one section up, and in every other case in. `groupFamilies`
    // has already decided WHICH children are this slate's (by successor, never by
    // the child's own name — the half that closed the sort-dependent roll-up);
    // reading `sectionLifted` rather than `claimed` states the census rule, and
    // at this point the two cannot disagree.
    const superseded = g.supersededChildren.filter(
      (c) =>
        !sectionLifted.has(normalizeRel(c.relPath)) &&
        !sectionLifted.has(normalizeRel(c.parent ?? "")),
    );
    const expanded = isGroupExpanded(foldKey);
    entries.push({
      kind: "group",
      section: "all",
      group: g,
      foldKey,
      // The `closed:` spelling is offered ONLY by the group that defaults open,
      // and only then — so that key is written for nothing else and can never be
      // read back as a statement about a group whose default has moved.
      toggleKey: foldKey === defaultOpenKey ? closedFoldKey(foldKey) : foldKey,
      members,
      superseded,
      folded: !expanded,
      ...(forcedGroupKey === foldKey ? { forcedOpen: true } : {}),
    });
    if (expanded) for (const m of members) emitRow(m, "all", { inGroup: g });
  }
  if (meta.length) {
    // Bookkeeping starts COLLAPSED — it is the one section whose whole point is
    // that nobody is looking for it. The header stays and carries its count, so
    // the rows are one click away and the list below the fold is not a mystery.
    const metaFolded = !isOpen(SECTION_META_FOLD_KEY);
    entries.push({
      kind: "header",
      section: "meta",
      label: "Bookkeeping",
      foldKey: SECTION_META_FOLD_KEY,
      folded: metaFolded,
      // Forced open by the reader being ON a bookkeeping page — the same dead
      // toggle a forced-open GROUP has, and the painter answers it the same way.
      ...(forced.has(SECTION_META_FOLD_KEY) ? { forcedOpen: true } : {}),
      // Every row the fold reveals, counted from the same list the loop below
      // emits — a meta page is never a PARENT (`pairAttachments`), so there is no
      // group inside this section whose own children could go uncounted.
      count: meta.length,
    });
    if (!metaFolded) {
      for (const p of meta) {
        if (claimed.has(normalizeRel(p.relPath))) continue;
        emitRow(p, "meta");
      }
    }
  }

  const distinct = new Set<string>();
  for (const e of entries) if (e.kind === "row") distinct.add(normalizeRel(e.page.relPath));
  return { entries, shown: distinct.size };
}
