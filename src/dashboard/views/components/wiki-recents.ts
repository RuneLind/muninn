/**
 * The /wiki page rail's recall aids, DOM-free so the whole rule is unit-testable:
 * the **Recently opened** and **Pinned** sections, the ★ pin state, and the
 * **Jira-key jump**. The localStorage half is `wiki-recents-store.ts`; the paint
 * is `renderList` in `wiki-browser.ts`.
 *
 * Why: the rail is a flat listing of every page, and most re-finds are of a page
 * the reader opened this week — on the melosys wiki they are also addressed by
 * Jira key, which the substring search matches in title order rather than in
 * "the issue first, then what talks about it" order.
 *
 * **One function decides the whole rail.** `buildRail` returns the ordered list
 * of headers and rows, so section placement, de-duplication and the row count
 * are one enumerable rule rather than three branches inside a render loop. The
 * count `renderList` shows is derived from what that list actually renders
 * (`shown`), so no arrangement here can make "N / total" a claim about rows that
 * are not on screen.
 */

import { displayTitleOf, isMetaPage, type WikiFilters, type WikiListing } from "./wiki-filter.ts";
import { findPageByRelPath, normalizeRel } from "./wiki-nav.ts";

/** localStorage key prefixes; the wiki's canonical name (`""` for the default
 *  wiki) is appended, so two wikis in one browser never share a list. Versioned
 *  so a future change of the stored shape can start clean. */
export const RECENTS_KEY_PREFIX = "muninn.wiki.recents.v1:";
export const PINS_KEY_PREFIX = "muninn.wiki.pins.v1:";

/** How many recents are kept. Six is the prototype's number and about what fits
 *  above the fold of a 300px rail without pushing the listing off screen. */
export const RECENTS_MAX = 6;
/** Pins are the reader's own choice, so the cap is only a bound on the stored
 *  string — but it is enforced on READ as well as on write, so a hand-edited or
 *  corrupted key cannot make the rail unusable. Read and write share the number
 *  so a list AT the cap survives a round trip; the entries themselves do not
 *  round-trip unchanged, since a read normalizes them. */
export const PINS_MAX = 50;
/** How many jump rows render. The header still reports the true total, so a key
 *  with 30 references says so rather than silently showing 8. */
export const JUMP_MAX = 8;

export function recentsKey(wiki: string): string {
  return RECENTS_KEY_PREFIX + wiki;
}
export function pinsKey(wiki: string): string {
  return PINS_KEY_PREFIX + wiki;
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
 * has.** Case and separators reach these lists from directions the index does
 * not control (a `?relPath=` deep link, an Atlas node key, an older build's
 * key), and the comparisons downstream — this dedupe, `pushRecent`,
 * `togglePin` — are plain `===`. Leaving normalization to each of them was the
 * bug, five times over: it was fixed in the two READ halves and left raw in the
 * writers, so clicking a star labelled "Unpin this page" appended a SECOND
 * entry for one page, which then rendered twice under a count that said
 * otherwise. Normalizing on the way in makes every one of those comparisons
 * exact by construction instead of correct by inspection.
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

/** Put `relPath` at the front, dropping any earlier occurrence, capped at
 *  `RECENTS_MAX`. A blank relPath leaves the list untouched: a page load that
 *  failed, or a response carrying no relPath, must not push an entry that can
 *  never resolve. Never mutates the input. */
export function pushRecent(list: string[], relPath: string): string[] {
  const v = normalizeRel((relPath || "").trim());
  if (!v) return list.slice();
  return [v, ...list.filter((p) => normalizeRel(p) !== v)].slice(0, RECENTS_MAX);
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

export type RailSection = "jump" | "pinned" | "recent" | "all" | "meta";

export type RailEntry =
  | { kind: "header"; section: RailSection; label: string; clear?: true }
  | { kind: "row"; section: RailSection; page: WikiListing; pinned: boolean };

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
  /** Stored relPaths, most recent / most recently pinned first. */
  recents: string[];
  pins: string[];
  /** Recency sort modes only: `sortPages` has sunk the bookkeeping pages
   *  (index/log/CLAUDE) to the tail, so the remainder's trailing meta rows get
   *  a `Bookkeeping` header. Without it the date column jumps back to today at
   *  the bottom of a descending list and reads as a broken sort. */
  metaTail?: boolean;
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
 * 5 claimed "exactly one pin comparison" while `togglePin`, `pushRecent` and
 * `parseRelPathList` each still carried their own raw one — so the duplicate
 * survived, with a worse label: the star now READ "Unpin this page" and still
 * appended a second entry. What actually closes it is normalizing at the
 * STORAGE BOUNDARY (`parseRelPathList` on the way in, both writers on the way
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
 * hiding them: `buildRail` resolves both lists from the FILTERED pages, so under
 * `type=plan` the Pinned section is exactly the plans the reader pinned, and a
 * pin from another type does not resolve. The first cut hid the sections on any
 * facet, on the theory that a recent row from another domain contradicts the
 * filter — but that row was never on screen, and what the reader actually lost
 * was their pins the moment they picked a type. A query is different: a search
 * is "find this", and the Jira-key jump owns that head of the rail.
 */
export function railSectionsVisible(filters: WikiFilters): boolean {
  return !filters.q.trim();
}

/** Is the rail showing the WHOLE wiki (no query, no facet)? Gates the recents
 *  clear affordance: `clearRecents` empties the store, and under a facet the
 *  section on screen is only a subset of it. This is the old
 *  `railSectionsVisible` rule, kept for the one place it is still right. */
export function railFacetsInert(filters: WikiFilters): boolean {
  return (
    !filters.q.trim() &&
    !filters.domain &&
    !filters.folder &&
    !filters.type &&
    !filters.tag &&
    !filters.status &&
    !filters.followups
  );
}

/** Resolve stored relPaths against a listing, in the STORED order, dropping what
 *  no longer resolves and what `seen` already accounts for.
 *
 *  `seen` is the caller's running set of pages already rendered, keyed on the
 *  normalized relPath and SHARED across the pin and recent passes — which is
 *  what makes a page held by BOTH lists (under either spelling) render once,
 *  under `Pinned`.
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
 * they never copy it. The first cut left the listing complete and let a pinned
 * or recent page render twice, which was wrong in five measured ways at once:
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
 *  - **No query, nothing stored** — also exactly as today. A fresh browser must
 *    not grow furniture it has nothing to put in.
 *  - **No query, something stored** — `Pinned`, then `Recently opened`, then
 *    `Other pages`: the listing MINUS what the two sections lifted out of it. A
 *    page that is both pinned and recent renders under Pinned only; it stays in
 *    the recents storage, so unpinning returns it to its place in that list.
 *    When the sections lift every page, there is no remainder and no third
 *    header. A facet NARROWS both sections (they resolve from the filtered
 *    list); the clear affordance on `Recently opened` exists only with every
 *    facet inert, because `clearRecents` empties the STORE and under a facet
 *    the section is a subset of it — a clear there would destroy rows the
 *    reader never saw.
 *  - **`metaTail`** (recency sorts) — the remainder's sunk bookkeeping pages
 *    render last under a `Bookkeeping` header, so their fresh dates at the
 *    bottom of a descending list are explained rather than read as a bug.
 *  - **A key that resolves** — the jump block first, then `Other matches` with
 *    the ordinary results minus the jump's rows.
 *  - **A key that resolves to nothing** — the next candidate gets its turn
 *    (`parseJiraKeyCandidates`); when none resolves, no jump block, no header,
 *    ordinary results. That fallback is what makes the permissive parse free.
 *
 * Sections and the jump are mutually exclusive by construction: the jump needs a
 * query and the sections need an empty one.
 */
export function buildRail(input: RailInput): RailModel {
  const { filtered, facetOnly, filters, recents, pins, metaTail } = input;
  const entries: RailEntry[] = [];
  const isPinned = (p: WikiListing): boolean => isPinnedRelPath(pins, p.relPath);

  /** Every page already rendered above, so the remainder can drop it. */
  const claimed = new Set<string>();
  const claim = (p: WikiListing): void => void claimed.add(normalizeRel(p.relPath));

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

  if (railSectionsVisible(filters)) {
    const pinned = resolve(pins, filtered, claimed);
    // Pinned wins the overlap because `claimed` is SHARED: a page the pin pass
    // already rendered is skipped here, whatever spelling either list holds it
    // under. There used to be a `!isPinned` filter on this line as well, and
    // having two mechanisms for one outcome meant NEITHER was pinned — a review
    // survey found that unsharing the set and dropping the filter each survived
    // the whole suite, while doing both together failed.
    const recent = resolve(recents, filtered, claimed);
    if (pinned.length) {
      entries.push({ kind: "header", section: "pinned", label: "Pinned" });
      for (const p of pinned) {
        entries.push({ kind: "row", section: "pinned", page: p, pinned: true });
      }
    }
    if (recent.length) {
      entries.push({
        kind: "header",
        section: "recent",
        label: "Recently opened",
        ...(railFacetsInert(filters) ? { clear: true as const } : {}),
      });
      for (const p of recent) {
        entries.push({ kind: "row", section: "recent", page: p, pinned: false });
      }
    }
  }

  const remainder = claimed.size ? filtered.filter((p) => !claimed.has(normalizeRel(p.relPath))) : filtered;
  const rest = metaTail ? remainder.filter((p) => !isMetaPage(p)) : remainder;
  const meta = metaTail ? remainder.filter((p) => isMetaPage(p)) : [];
  if (claimed.size && rest.length) {
    entries.push({ kind: "header", section: "all", label: jump ? "Other matches" : "Other pages" });
  }
  for (const p of rest) {
    entries.push({ kind: "row", section: "all", page: p, pinned: isPinned(p) });
  }
  if (meta.length) {
    entries.push({ kind: "header", section: "meta", label: "Bookkeeping" });
    for (const p of meta) {
      entries.push({ kind: "row", section: "meta", page: p, pinned: isPinned(p) });
    }
  }

  const distinct = new Set<string>();
  for (const e of entries) if (e.kind === "row") distinct.add(normalizeRel(e.page.relPath));
  return { entries, shown: distinct.size };
}
