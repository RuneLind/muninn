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

import { displayTitleOf, type WikiFilters, type WikiListing } from "./wiki-filter.ts";

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
 *  precisely so a stored list round-trips unchanged. */
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
    if (!v || out.indexOf(v) !== -1) continue;
    out.push(v);
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
  const v = (relPath || "").trim();
  if (!v) return list.slice();
  return [v, ...list.filter((p) => p !== v)].slice(0, RECENTS_MAX);
}

/** Add `relPath` to the front of the pin list, or remove it if already there.
 *  A blank relPath is a no-op. At the cap, a new pin displaces the OLDEST —
 *  losing the pin the reader just made would read as a broken control. */
export function togglePin(list: string[], relPath: string): string[] {
  const v = (relPath || "").trim();
  if (!v) return list.slice();
  if (list.indexOf(v) !== -1) return list.filter((p) => p !== v);
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
const PREFIXED_RE = /(?:^|[^a-zA-Z0-9])([a-zA-Z][a-zA-Z0-9]{1,9})-(\d{3,6})(?![0-9])/;
/** A bare `7588`: EXACTLY four digits, bounded by non-alphanumerics. Four is the
 *  shape of the keys on this wiki; three would fire on ordinary numbers and five
 *  would fire on the middle of a longer one. */
const BARE_RE = /(?:^|[^a-zA-Z0-9])(\d{4})(?![0-9])/;

/**
 * The key a query names, or `null`.
 *
 * A PREFIXED match wins over a bare one wherever both appear, regardless of
 * order: `2026-08-27 MELOSYS-7588` names the issue, not the year. That is the
 * one ordering rule, and it is why the two regexes are tried in sequence rather
 * than as one alternation.
 *
 * The parse is deliberately permissive — `2026-09-01` alone does parse as the
 * number 2026 — because a parse that resolves to no page renders NOTHING (see
 * `jiraKeyJump`). The cost of a false key is zero; the cost of a strict parse
 * that misses `fikset i 7588` is a feature that only works when pasted alone.
 */
export function parseJiraKey(query: string): ParsedJiraKey | null {
  const q = (query || "").trim();
  if (!q) return null;
  const prefixed = PREFIXED_RE.exec(q);
  if (prefixed) {
    const key = (prefixed[1] + "-" + prefixed[2]).toLowerCase();
    return { key, num: prefixed[2]!, display: key.toUpperCase() };
  }
  const bare = BARE_RE.exec(q);
  if (bare) return { key: null, num: bare[1]!, display: bare[1]! };
  return null;
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

/** The last path segment without its extension — `sources/jira/MELOSYS-7588.md`
 *  → `MELOSYS-7588`. */
function relPathStem(relPath: string): string {
  const seg = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? seg.slice(0, dot) : seg;
}

/**
 * Resolve a key against a page listing.
 *
 * **Own page** — the page whose ADDRESS is the issue: its filename stem or its
 * canonical name IS the key. On the nav wiki that is `sources/jira/<KEY>.md`;
 * the rule is written against the address rather than against that folder so a
 * wiki filing issues elsewhere still works.
 *
 * The address, and deliberately NOT "the title opens with the key": on this wiki
 * the archive pages are titled `MELOSYS-7588 — Opprydding av avrunding`, so a
 * title-opener rule promoted every session note about the issue to an issue
 * page — measured by the enumeration in `wiki-recents.test.ts`, which is why the
 * fixture there keeps one. A page named after the issue in prose is a reference,
 * and reads correctly as one.
 *
 * **Reference** — any other page whose tags, title, aliases or relPath mention
 * the key. A bare number matches a `<prefix>-<num>` tag from ANY project and the
 * number as a standalone digit run in text, so `7588` finds `melosys-7588`
 * without the reader having to type the project.
 *
 * Input order is preserved inside each group (callers pass the rail's current
 * sort), and an own page never appears again among the references.
 */
export function jiraKeyJump(pages: WikiListing[], parsed: ParsedJiraKey): JiraKeyJump {
  // A bare number matches a tag from any project; a prefixed key matches itself.
  const tokenRe = parsed.key ? null : new RegExp(`^[a-z][a-z0-9]{1,9}-${parsed.num}$`);
  const isKeyToken = (token: string): boolean => {
    const t = token.toLowerCase();
    return parsed.key ? t === parsed.key : tokenRe!.test(t);
  };
  // A bare number must not match inside a longer number (`75880`, `17588`);
  // written without a lookbehind, which Safari only learned in 16.4.
  const mentionRe = parsed.key ? null : new RegExp(`(^|[^0-9])${parsed.num}([^0-9]|$)`);
  const mentions = (text: string): boolean => {
    const t = (text || "").toLowerCase();
    return parsed.key ? t.indexOf(parsed.key) !== -1 : mentionRe!.test(t);
  };

  const own: WikiListing[] = [];
  const refs: WikiListing[] = [];
  for (const p of pages) {
    if (isKeyToken(relPathStem(p.relPath)) || isKeyToken(p.name)) {
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

export type RailSection = "jump" | "pinned" | "recent" | "all";

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
}

export interface RailModel {
  entries: RailEntry[];
  /** DISTINCT pages among the rows — what the "N / total" count reports. A page
   *  rendered in both a section and the listing below counts once. */
  shown: number;
}

/**
 * Are the recall sections allowed on screen? Only with the search box empty AND
 * every facet inert — **including domain**, which `activeFilterCount` in
 * `wiki-browser.ts` deliberately excludes from its badge.
 *
 * The two differ on purpose: that badge answers "is a filter hidden inside the
 * collapsed disclosure", and domain lives in the always-visible head. This
 * answers "is the rail showing the whole wiki", and under `domain=life` a
 * Recently-opened row from the ai domain is a row the active filter says should
 * not be there.
 */
export function railSectionsVisible(filters: WikiFilters): boolean {
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
 *  no longer resolves. Deliberately does not report the misses: an entry is
 *  unresolvable both when its page was deleted and when the listing has not
 *  arrived yet, and pruning storage on the second would erase the reader's pins
 *  on every slow load. */
function resolve(relPaths: string[], byRelPath: Map<string, WikiListing>): WikiListing[] {
  const out: WikiListing[] = [];
  for (const rel of relPaths) {
    const p = byRelPath.get(rel);
    if (p) out.push(p);
  }
  return out;
}

/**
 * The whole rail, in render order.
 *
 * The states, enumerated:
 *
 *  - **No key, sections hidden** (a query, or any active facet) — the rows
 *    exactly as today, with no headers at all.
 *  - **No key, sections visible, nothing stored** — also exactly as today. A
 *    fresh browser must not grow furniture it has nothing to put in.
 *  - **No key, sections visible, something stored** — `Pinned`, then
 *    `Recently opened` (with its clear affordance), then `All pages`. A page
 *    that is BOTH pinned and recent renders under Pinned only; it stays in the
 *    recents storage, so unpinning returns it to its place in that list.
 *    Sections do NOT remove anything from the listing below: they are shortcuts
 *    to rows dozens of positions down, and hiding those rows would make a
 *    complete-looking listing incomplete.
 *  - **A key that resolves** — the jump block first, then `Other matches` with
 *    the ordinary results MINUS the jump's rows. This one DOES de-duplicate:
 *    the jump renders exactly when the query matches those pages, so the
 *    duplicate would be the adjacent row, and the block would read as a repeat
 *    of the list rather than as an answer.
 *  - **A key that resolves to nothing** — no jump block, no header, ordinary
 *    results. This is what makes the permissive key parse free.
 *
 * Sections and the jump are mutually exclusive by construction: the jump needs a
 * query and the sections need an empty one.
 */
export function buildRail(input: RailInput): RailModel {
  const { filtered, facetOnly, filters, recents, pins } = input;
  const entries: RailEntry[] = [];
  const pinSet = new Set(pins);
  const byRelPath = new Map<string, WikiListing>();
  for (const p of filtered) byRelPath.set(p.relPath, p);

  const parsed = parseJiraKey(filters.q);
  const jump = parsed ? jiraKeyJump(facetOnly, parsed) : null;
  const jumpRows = jump && jump.rows.length ? jump.rows : [];

  if (jump && jumpRows.length) {
    entries.push({ kind: "header", section: "jump", label: jumpHeaderLabel(jump) });
    for (const p of jumpRows) {
      entries.push({ kind: "row", section: "jump", page: p, pinned: pinSet.has(p.relPath) });
    }
  }

  if (railSectionsVisible(filters)) {
    const pinned = resolve(pins, byRelPath);
    // Pinned wins the overlap, so a pinned page is not two adjacent rows.
    const recent = resolve(recents, byRelPath).filter((p) => !pinSet.has(p.relPath));
    if (pinned.length) {
      entries.push({ kind: "header", section: "pinned", label: "Pinned" });
      for (const p of pinned) entries.push({ kind: "row", section: "pinned", page: p, pinned: true });
    }
    if (recent.length) {
      entries.push({ kind: "header", section: "recent", label: "Recently opened", clear: true });
      for (const p of recent) {
        entries.push({ kind: "row", section: "recent", page: p, pinned: false });
      }
    }
    if (pinned.length || recent.length) {
      entries.push({ kind: "header", section: "all", label: "All pages" });
    }
  }

  const jumpSeen = new Set(jumpRows.map((p) => p.relPath));
  const rest = jumpRows.length ? filtered.filter((p) => !jumpSeen.has(p.relPath)) : filtered;
  if (jumpRows.length && rest.length) {
    entries.push({ kind: "header", section: "all", label: "Other matches" });
  }
  for (const p of rest) {
    entries.push({ kind: "row", section: "all", page: p, pinned: pinSet.has(p.relPath) });
  }

  const distinct = new Set<string>();
  for (const e of entries) if (e.kind === "row") distinct.add(e.page.relPath);
  return { entries, shown: distinct.size };
}
