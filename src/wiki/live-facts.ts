/**
 * Live chips in the /wiki reader (living facts PR 3b, mimir
 * `plans/muninn-wiki-living-facts.mdx`): after each PR or Jira-key mention a
 * sweep has facts for, the page render inserts an empty
 * `<span class="fact-chip" data-live-fact="owner/repo#n">` that the reader
 * fills from the page payload's `facts`.
 *
 * - **The facts file** (`.wiki-facts.json` at the wiki root) is written by the
 *   plan-status-sweep (`--write-facts`). {@link readWikiFacts} reads it on a
 *   page open, re-parsing only when its stat signature changed; a malformed
 *   file or a `version` other than 1 gives no chips and one warning per change
 *   of the file.
 * - **What is marked** is what the sweep extracts (claude-skills
 *   `plan-status-sweep/scripts/sweep-lib.ts` `prRefs`, `pageKeys`), pinned by
 *   the shared fixture `reference-forms.json`: pull URLs, `owner/repo#n`, and
 *   with a `prGrammar` also `repo #n`, aliases and a bare `#n`/`PR #n`
 *   resolved through the page's `repos:` (kept only when its facts entry's
 *   title carries a key the page names). Jira keys of the wiki's tracker
 *   projects; none without `trackers`.
 * - **Never marked:** code (fences and inline), tags and their attributes,
 *   headings, wikilinks and the state homes (`stateLineRoles`' `home` units).
 *   A markdown link or a bare URL is one mention: every id in it gives one
 *   chip per distinct id after it, so nothing lands inside `[…]`, `(…)` or a URL.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { getLog } from "../logging.ts";
import { markdownCodeRegions, type ProtectedRegion } from "../format/markdown-ast.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { READER_ONLY_ATTR } from "../format/reader-lens.ts";
import { FACT_CHIP_CLASS, LIVE_FACT_ATTR, repoOfPr, type FactsKeyEntry, type FactsPrEntry, type LiveFactsPayload } from "./core/live-facts-chip.ts";
import { readOwns } from "./frontmatter-lists.ts";
import { stateLineRoles } from "./lint-state.ts";
import { WIKILINK_WITH_LABEL_RE } from "./page-text.ts";
import { noProdSet, qualifyRepo, type PrGrammar } from "./pr-grammar.ts";
import { parseFrontmatter, stripFrontmatter } from "./store.ts";
import { declaredKeys, stampedKeys, stemKeys, titleKeys } from "./trackers/jira.ts";
import type { TrackerConfig } from "./trackers/types.ts";

const log = getLog("wiki", "live-facts");

export const WIKI_FACTS_FILE = ".wiki-facts.json";

// ── The facts file ───────────────────────────────────────────────────────────

export interface WikiFacts {
  version: 1;
  prs: Record<string, FactsPrEntry>;
  keys: Record<string, FactsKeyEntry>;
}

/** A parsed facts file with its case-insensitive PR lookup (GitHub owner and
 *  repo names are case-insensitive; the page keeps its own spelling). */
export interface LoadedFacts {
  facts: WikiFacts;
  /** Lowercased id → the file's id. */
  prIds: Map<string, string>;
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function entryError(id: string, e: unknown): string | null {
  if (!/^[\w.-]+\/[\w.-]+#\d+$/.test(id)) return `prs key «${id}» is not owner/repo#n`;
  if (!e || typeof e !== "object" || Array.isArray(e)) return `prs.${id} is not an object`;
  const o = e as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.state !== "string" || !isBool(o.isDraft)) return `prs.${id}: title, state or isDraft missing`;
  if (!(o.mergedAt === null || isIso(o.mergedAt)) || !(o.inProd === null || isBool(o.inProd)) || !(o.draftTag === null || typeof o.draftTag === "string"))
    return `prs.${id}: mergedAt, inProd or draftTag malformed`;
  const fp = o.firstProd as Record<string, unknown> | null;
  if (!(fp === null || (fp && typeof fp === "object" && typeof fp.tag === "string" && isIso(fp.publishedAt)))) return `prs.${id}: firstProd malformed`;
  if (!isIso(o.checkedAt)) return `prs.${id}: checkedAt missing`;
  return null;
}

/** Parse and check a facts file, as the sweep's `parseFacts` does: a file
 *  that is not version 1 or not of this shape is an error, never a partial read. */
export function parseWikiFacts(text: string): { facts: WikiFacts } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` };
  }
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.version !== 1) return { error: "not a version 1 facts file" };
  const prs = o.prs as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown>;
  if (!prs || typeof prs !== "object" || Array.isArray(prs) || !keys || typeof keys !== "object" || Array.isArray(keys)) return { error: "prs or keys is not an object" };
  for (const [id, e] of Object.entries(prs)) {
    const err = entryError(id, e);
    if (err) return { error: err };
  }
  for (const [k, e] of Object.entries(keys)) {
    const ke = e as Record<string, unknown> | null;
    if (!ke || !Array.isArray(ke.prs) || !ke.prs.every((p) => typeof p === "string")) return { error: `keys.${k}.prs is not a list of ids` };
    if (ke.searchedAt !== undefined && !isIso(ke.searchedAt)) return { error: `keys.${k}.searchedAt malformed` };
    for (const p of ke.prs as string[]) if (!Object.hasOwn(prs, p)) return { error: `keys.${k}.prs names ${p}, which has no prs entry` };
  }
  return { facts: v as WikiFacts };
}

export function loadFacts(facts: WikiFacts): LoadedFacts {
  const prIds = new Map<string, string>();
  for (const id of Object.keys(facts.prs)) if (!prIds.has(id.toLowerCase())) prIds.set(id.toLowerCase(), id);
  return { facts, prIds };
}

/** Per root: the file's signature and the read of it (shared while in flight). */
const factsCache = new Map<string, { sig: string; loaded: Promise<LoadedFacts | null> }>();

/** For tests: forget every cached read. */
export function resetWikiFactsCache(): void {
  factsCache.clear();
}

/**
 * The wiki's facts, or null: no file, an unreadable one, a malformed one or a
 * `version` other than 1. Re-read only when the file's signature changed
 * (inode, ctime, mtime, size: a `chmod` or an mtime-keeping rewrite moves
 * ctime), so a malformed file warns once per change, never once per page
 * open. Opens that miss together share one read (single-flight per signature).
 */
export async function readWikiFacts(root: string, warn: (reason: string) => void = (reason) => log.warn("{file} at {root} gives no live chips: {reason}", { file: WIKI_FACTS_FILE, root, reason })): Promise<LoadedFacts | null> {
  const file = path.join(root, WIKI_FACTS_FILE);
  let sig: string;
  try {
    // Nanoseconds: Bun's `ctimeMs` is whole milliseconds, and two writes in one
    // millisecond are a change too.
    const st = await fs.stat(file, { bigint: true });
    sig = `${st.ino}:${st.ctimeNs}:${st.mtimeNs}:${st.size}`;
  } catch {
    factsCache.delete(root);
    return null;
  }
  const hit = factsCache.get(root);
  if (hit && hit.sig === sig) return hit.loaded;
  // Set before the first await, so an open arriving mid-read joins this one.
  const loaded = loadWikiFactsFile(file, warn);
  factsCache.set(root, { sig, loaded });
  return loaded;
}

async function loadWikiFactsFile(file: string, warn: (reason: string) => void): Promise<LoadedFacts | null> {
  try {
    const r = parseWikiFacts(await Bun.file(file).text());
    if (!("error" in r)) return loadFacts(r.facts);
    warn(r.error);
  } catch (err) {
    warn(`unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ── A page's keys ────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLIENT_KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,15}-[1-9][0-9]{0,7}$/;
const KEY_IN_PROSE = /\b([A-Z][A-Z0-9]{1,15}-\d{1,8})\b(?!-\d)/g;
const KEY_DENY = new Set(["UTF", "ISO", "SHA", "RFC", "HTTP", "HTTPS", "AES", "RSA", "TLS", "SSL", "BUC", "SED", "EU", "EF", "EØS", "ISO8601", "UTF8", "SHA256", "MD", "CVE"]);

/** The body's key pattern: muninn's tracker shape over the configured
 *  projects (case-sensitive, so `melosys-8332` is no key); without projects,
 *  the sweep's generic `ABC-12` pattern. */
function bodyKeyRe(projects: readonly string[]): { re: RegExp; notAfter?: RegExp } {
  // `notAfter` is the pattern's leading lookbehind `(?<![A-Za-z0-9_])`, tested
  // by `matchesNotAfter` (a lookbehind makes JSC try every offset: 9 ms → 0.1
  // ms on a 700 KB page).
  if (projects.length) return { re: new RegExp(`(?:${projects.map(escapeRe).join("|")})-[1-9][0-9]{0,7}(?![A-Za-z0-9_]|-[0-9])`, "g"), notAfter: /[A-Za-z0-9_]/ };
  return { re: /\b[A-Z][A-Z0-9]+-\d{2,6}\b/g };
}

/**
 * `re`'s matches as `(?<![notAfter])` + `re` would give them: a match whose
 * preceding character is in `notAfter` is dropped and the search resumes one
 * offset later, so a lookbehind's leftmost-match order is kept exactly.
 */
function matchesNotAfter(body: string, re: RegExp, notAfter: RegExp | undefined): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(body)); ) {
    if (notAfter && m.index > 0 && notAfter.test(body[m.index - 1]!)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push(m);
    if (m[0] === "") re.lastIndex++;
  }
  return out;
}

/** Every key mention in `body` with its offset, code included. */
export function bodyKeyMentions(body: string, projects: readonly string[]): { key: string; start: number; end: number }[] {
  const generic = projects.length === 0;
  const { re, notAfter } = bodyKeyRe(projects);
  return matchesNotAfter(body, re, notAfter)
    .filter((m) => !generic || !(m[0].startsWith("MEL-") || m[0].startsWith("Q-")))
    .map((m) => ({ key: m[0], start: m.index, end: m.index + m[0].length }));
}

/** The sweep's generic entry rule: an entry that is exactly key-shaped, else
 *  the uppercase keys in it minus the denylist. */
function entryKeys(entry: string): string[] {
  const v = entry.trim();
  if (/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(v)) return [v.toUpperCase()];
  return [...v.matchAll(KEY_IN_PROSE)].map((m) => m[1]!).filter((k) => !KEY_DENY.has(k.slice(0, k.indexOf("-"))));
}

const strings = (v: string | string[] | undefined) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
const fileStem = (relPath: string) => relPath.split("/").at(-1)!.replace(/\.mdx?$/i, "");

/** The wiki's jira trackers (`trackers[]` with `id: "jira"`). */
export const jiraTrackers = (trackers: readonly TrackerConfig[] | undefined): TrackerConfig[] => (trackers ?? []).filter((t) => t.id === "jira");

/**
 * The page's key set, as the sweep's `pageKeys` gives it: the frontmatter
 * (`jira:` by muninn's stamped rule; the tracker's `frontmatterKeys` by its
 * declared rule), `owns:` (lint check 14's reading), the title, the filename
 * stem and every body mention, code included. A bare `#n` belongs to the page
 * when its PR's title carries one of these.
 */
export function pageKeySet(markdown: string, relPath: string, trackers: readonly TrackerConfig[]): Set<string> {
  return pageKeySetOf(markdown, parseFrontmatter(markdown), relPath, trackers);
}

/** {@link pageKeySet} over an already-parsed frontmatter; `bodyKeys` gives
 *  the mentions of `stripFrontmatter(markdown)` when the caller has them. */
function pageKeySetOf(
  markdown: string,
  fm: Record<string, string | string[]>,
  relPath: string,
  trackers: readonly TrackerConfig[],
  bodyKeys?: (stripped: string) => { key: string }[] | undefined,
): Set<string> {
  const out = new Set<string>(readOwns(markdown).keys);
  const title = typeof fm.title === "string" ? fm.title.trim() : "";
  const stem = fileStem(relPath);
  const projects = [...new Set(trackers.flatMap((t) => t.projects))];
  if (trackers.length) {
    for (const k of stampedKeys(fm.jira)) if (CLIENT_KEY_RE.test(k)) out.add(k);
    for (const t of trackers) {
      for (const field of t.frontmatterKeys) for (const k of declaredKeys(fm[field], t)) out.add(k);
      if (title) for (const k of titleKeys(title, t)) out.add(k);
      for (const k of stemKeys(stem, t)) out.add(k);
    }
  } else {
    for (const field of ["jira", "tickets", "issue"]) for (const v of strings(fm[field])) for (const k of entryKeys(v)) out.add(k);
    for (const m of title.matchAll(/[A-Z][A-Z0-9]+-\d+/g)) out.add(m[0]);
    for (const m of stem.toUpperCase().matchAll(/MELOSYS-\d+/g)) out.add(m[0]);
  }
  const stripped = stripFrontmatter(markdown);
  for (const m of bodyKeys?.(stripped) ?? bodyKeyMentions(stripped, projects)) out.add(m.key);
  return out;
}

const numberRes = new Map<string, RegExp>();

/** Whether `title` carries `key`'s number as a whole number (`8337` is not in `83370`). */
export function titleCarriesKey(title: string, key: string): boolean {
  const n = key.slice(key.lastIndexOf("-") + 1);
  if (n === "") return false;
  let re = numberRes.get(n);
  if (!re) {
    if (numberRes.size >= 4096) numberRes.clear();
    numberRes.set(n, (re = new RegExp(`\\b${escapeRe(n)}\\b`)));
  }
  return re.test(title);
}

// ── Interval lookups ─────────────────────────────────────────────────────────

/**
 * Any set of half-open `[start, end)` intervals, sorted by start with a
 * running maximum of ends, so "does any interval contain this offset" and
 * "does any interval overlap this span" are a binary search instead of a scan.
 * Exact for overlapping and nested intervals too: an interval starting at or
 * before the probe reaches past it iff the largest end among them does.
 */
class Intervals {
  private readonly starts: number[] = [];
  private readonly maxEnds: number[] = [];
  constructor(spans: readonly (readonly [number, number])[]) {
    const sorted = [...spans].sort((a, b) => a[0] - b[0]);
    let max = -Infinity;
    for (const [a, b] of sorted) {
      max = Math.max(max, b);
      this.starts.push(a);
      this.maxEnds.push(max);
    }
  }
  /** How many intervals start before `x` (`orEqual`: at or before). */
  private countBefore(x: number, orEqual: boolean): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! < x || (orEqual && this.starts[mid] === x)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Some interval has `start <= pos < end`. */
  contains(pos: number): boolean {
    const i = this.countBefore(pos, true);
    return i > 0 && this.maxEnds[i - 1]! > pos;
  }
  /** Some interval has `start < e && end > s`. */
  overlaps(s: number, e: number): boolean {
    const i = this.countBefore(e, false);
    return i > 0 && this.maxEnds[i - 1]! > s;
  }
}

/** In sorted, pairwise disjoint spans, the one holding `[s, e]`, else undefined. */
function holdingSpan(spans: readonly (readonly [number, number])[], s: number, e: number): readonly [number, number] | undefined {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]![0] <= s) lo = mid + 1;
    else hi = mid;
  }
  // Disjoint: only the last span starting at or before `s` can hold it.
  const span = spans[lo - 1];
  return span && e <= span[1] ? span : undefined;
}

const codeIntervals = (code: readonly { start: number; end: number }[]) => new Intervals(code.map((r) => [r.start, r.end] as const));

// ── PR references ────────────────────────────────────────────────────────────

export type RefForm = "url" | "qualified" | "repo" | "alias" | "bare";
export interface PrMention {
  id: string;
  start: number;
  end: number;
  form: RefForm;
}

/**
 * The PR references in `body`, in text order: the sweep's `prRefs` forms and
 * overlap precedence (URL over `owner/repo#n` over `repo #n`/alias over bare).
 * Without a `prGrammar` only the owner-qualified forms. `home` is the page's
 * `repos:` first entry (or `source-repo:`); a bare `#n` needs it and the
 * grammar's owner, and is returned unfiltered (`assumed`: the caller checks
 * its title).
 */
export function prMentions(body: string, grammar: PrGrammar | null, home: string | null): PrMention[] {
  const out: PrMention[] = [];
  // Claimed spans, sorted and pairwise disjoint (an overlapping claim is
  // refused), so their ends are sorted too: an overlap is a binary search.
  const takenStarts: number[] = [];
  const takenEnds: number[] = [];
  // A null id claims the span and gives no mention: a repo or alias form the
  // grammar cannot qualify (no owner). The sweep's form always claims it, so
  // the bare `#n` inside it must not resolve under the home repo.
  const add = (id: string | null, start: number, len: number, form: RefForm) => {
    const end = start + len;
    let lo = 0;
    let hi = takenStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (takenStarts[mid]! < end) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && takenEnds[lo - 1]! > start) return;
    takenStarts.splice(lo, 0, start);
    takenEnds.splice(lo, 0, end);
    if (id !== null) out.push({ id, start, end, form });
  };
  for (const m of body.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) add(`${m[1]}/${m[2]}#${+m[3]!}`, m.index!, m[0].length, "url");
  for (const m of body.matchAll(/\b([A-Za-z][\w.-]*)\/([\w.-]+)\s?#(\d+)\b/g)) add(`${m[1]}/${m[2]}#${+m[3]!}`, m.index!, m[0].length, "qualified");
  if (grammar) {
    for (const m of repoFormMatches(body)) {
      const alias = Object.hasOwn(grammar.aliases, m[1]!) ? grammar.aliases[m[1]!] : undefined;
      const name = alias ?? (m[1]!.includes("-") ? m[1]! : undefined);
      const repo = name ? qualifyRepo(grammar.owner, name) : null;
      if (name) add(repo && `${repo}#${+m[2]!}`, m.index!, m[0].length, alias ? "alias" : "repo");
    }
    const homeRepo = home ? qualifyRepo(grammar.owner, home) : null;
    if (homeRepo) for (const m of matchesNotAfter(body, /#(\d{3,5})\b/g, /[\w/#-]/)) add(`${homeRepo}#${+m[1]!}`, m.index, m[0].length, "bare");
  }
  return out.sort((a, b) => a.start - b.start);
}

const NAME_CH = /[\w-]/;
const SPACE_CH = /\s/;
const REPO_FORM_AT = /(?<![\w/.-])([a-z][\w]*(?:-[\w]+)*)\s?(?:PR\s)?#(\d{2,5})\b/y;

/**
 * `body.matchAll` of the sweep's `repo #n` pattern (`REPO_FORM_AT` without
 * the sticky flag), found from each `#<digit>` instead of from every offset
 * (25 ms → ~1 ms on a 700 KB page). Exact: a match's `#` is the first `#` at
 * or after its start, and what precedes it — a name, at most one whitespace
 * and `PR` plus one more — is `[\w-]` with at most two whitespace characters,
 * so every match starting at or before that `#` starts within the backward
 * scan below; each offset there is tried in order, leftmost first.
 */
function repoFormMatches(body: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const hashes = /#\d/g;
  let from = 0;
  for (let h: RegExpExecArray | null; (hashes.lastIndex = from), (h = hashes.exec(body)); ) {
    let i = h.index - 1;
    for (let spaces = 0; i >= 0; i--) {
      const ch = body[i]!;
      if (NAME_CH.test(ch)) continue;
      if (SPACE_CH.test(ch) && spaces < 2) {
        spaces++;
        continue;
      }
      break;
    }
    let found: RegExpExecArray | null = null;
    for (let p = Math.max(from, i + 1); p < h.index && !found; p++) {
      REPO_FORM_AT.lastIndex = p;
      found = REPO_FORM_AT.exec(body);
    }
    if (found) {
      out.push(found);
      from = found.index + found[0].length;
    } else from = h.index + 1;
  }
  return out;
}

/** The page's `repos:` home for a bare `#n`: an inline list's first entry,
 *  else `source-repo:`. */
export function pageHomeRepo(fm: Record<string, string | string[]>): string | null {
  const repos = fm.repos;
  if (Array.isArray(repos) && repos[0]) return repos[0];
  const src = fm["source-repo"];
  return typeof src === "string" && src ? src : null;
}

// ── The chip pass ────────────────────────────────────────────────────────────

/** What the page render's chip pass needs (`renderWikiHtml`'s `liveFacts`). */
export interface LiveFactsInput {
  loaded: LoadedFacts;
  grammar: PrGrammar | null;
  trackers: readonly TrackerConfig[];
  relPath: string;
  /** Receives the page payload's `facts` (absent when no chip was placed). */
  collect?: (facts: LiveFactsPayload | undefined) => void;
}

export interface Mention {
  id: string;
  kind: "pr" | "key";
  start: number;
  end: number;
}

/** One chip site: the offset in the body and the ids, in text order. */
export interface ChipInsertion {
  at: number;
  ids: { id: string; kind: "pr" | "key" }[];
}

const TAG_RE = /<\/?[A-Za-z][\w.:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*>/g;
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const URL_RE = /https?:\/\/[^\s<>()[\]]+/g;

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Every PR and key mention the reader marks in `body` (the string the render
 * marks: `readerBody`'s), outside the never-marked regions, in text order.
 * `titleOf` gives a PR's facts title, for a bare `#n`'s check.
 */
export function markedMentions(
  body: string,
  markdown: string,
  relPath: string,
  grammar: PrGrammar | null,
  trackers: readonly TrackerConfig[],
  titleOf: (id: string) => string | undefined,
): Mention[] {
  return markedMentionsWithCode(body, markdown, relPath, grammar, trackers, titleOf).mentions;
}

/** {@link markedMentions}, plus the body's code regions when it computed them
 *  (so {@link chipInsertions} need not scan again). */
function markedMentionsWithCode(
  body: string,
  markdown: string,
  relPath: string,
  grammar: PrGrammar | null,
  trackers: readonly TrackerConfig[],
  titleOf: (id: string) => string | undefined,
): { mentions: Mention[]; code?: ProtectedRegion[] } {
  const fm = parseFrontmatter(markdown);
  const projects = [...new Set(trackers.flatMap((t) => t.projects))];
  const bodyKeys = projects.length ? bodyKeyMentions(body, projects) : [];
  // The key set is read only by a bare `#n`, and its answer per id is fixed.
  let keySet: string[] | undefined;
  const belongs = new Map<string, boolean>();
  const bareBelongs = (id: string): boolean => {
    let v = belongs.get(id);
    if (v === undefined) {
      const title = titleOf(id);
      keySet ??= [...pageKeySetOf(markdown, fm, relPath, trackers, (stripped) => (projects.length && stripped === body ? bodyKeys : undefined))];
      const ks = keySet;
      v = title !== undefined && ks.some((k) => titleCarriesKey(title, k));
      belongs.set(id, v);
    }
    return v;
  };
  const all: Mention[] = [];
  for (const r of prMentions(body, grammar, pageHomeRepo(fm))) {
    if (r.form === "bare" && !bareBelongs(r.id)) continue;
    all.push({ id: r.id, kind: "pr", start: r.start, end: r.end });
  }
  for (const m of bodyKeys) all.push({ id: m.key, kind: "key", start: m.start, end: m.end });
  if (all.length === 0) return { mentions: [] };

  const code = markdownCodeRegions(body);
  const inCode = codeIntervals(code);
  const blockedSpans: [number, number][] = [];
  for (const m of body.matchAll(TAG_RE)) blockedSpans.push([m.index!, m.index! + m[0].length]);
  for (const m of body.matchAll(WIKILINK_WITH_LABEL_RE)) blockedSpans.push([m.index!, m.index! + m[0].length]);
  const blocked = new Intervals(blockedSpans);
  const starts = lineStarts(body);
  const lines = body.split("\n");
  // `body` is `readerBody`'s string: its frontmatter is gone, so a leading `---` is a rule.
  const homes = new Set(stateLineRoles(body, { frontmatter: false }).home.flatMap((u) => u.lines));
  const isBlocked = (m: Mention) => {
    if (inCode.contains(m.start) || inCode.contains(m.end - 1)) return true;
    if (blocked.overlaps(m.start, m.end)) return true;
    const line = lineOf(starts, m.start);
    if (homes.has(line)) return true;
    return HEADING_RE.test(lines[line]!) && !inCode.contains(starts[line]!);
  };
  return { mentions: all.filter((m) => !isBlocked(m)).sort((a, b) => a.start - b.start || a.end - b.end), code };
}

/**
 * Where the chips go: after a mention, or after the markdown link or bare URL
 * that holds it, one chip per distinct id at each site, in text order. Only
 * ids with a facts entry (`has`) get one.
 */
export function chipInsertions(body: string, mentions: readonly Mention[], has: (m: Mention) => boolean, code?: readonly ProtectedRegion[]): ChipInsertion[] {
  if (mentions.length === 0) return [];
  const inCode = codeIntervals(code ?? markdownCodeRegions(body));
  // Each list is in text order and pairwise disjoint (one regex's matches; a
  // URL's end only trimmed), so a lookup is a binary search; links first, as
  // a URL inside a link belongs to the link.
  const links: [number, number][] = [];
  for (const m of body.matchAll(LINK_RE)) if (!inCode.contains(m.index!) && body[m.index! - 1] !== "[") links.push([m.index!, m.index! + m[0].length]);
  const urls: [number, number][] = [];
  for (const m of body.matchAll(URL_RE)) {
    const start = m.index!;
    // An earlier URL ends at or before this match starts, so only a link can hold it.
    if (holdingSpan(links, start, start + 1)) continue;
    const end = start + m[0].replace(/[.,;:!?'"*_]+$/, "").length;
    urls.push([start, end]);
  }
  const sites = new Map<number, ChipInsertion>();
  for (const m of mentions) {
    if (!has(m)) continue;
    const span = holdingSpan(links, m.start, m.end) ?? holdingSpan(urls, m.start, m.end);
    const at = span ? span[1] : m.end;
    let site = sites.get(at);
    if (!site) sites.set(at, (site = { at, ids: [] }));
    // One chip per PR: GitHub ids ignore case, so the site keeps the first spelling.
    const lower = m.id.toLowerCase();
    if (!site.ids.some((x) => x.kind === m.kind && x.id.toLowerCase() === lower)) site.ids.push({ id: m.id, kind: m.kind });
  }
  return [...sites.values()].sort((a, b) => a.at - b.at);
}

/** The empty chip span the reader fills. */
export function chipSpanHtml(id: string): string {
  return `<span class="${FACT_CHIP_CLASS}" ${LIVE_FACT_ATTR}="${escapeHtml(id)}" ${READER_ONLY_ATTR}></span>`;
}

const noLeadingZeros = (digits: string) => digits.replace(/^0+(?=\d)/, "");
const factNumbers = new WeakMap<LoadedFacts, Set<string>>();

/**
 * False when no chip can be placed: no whole digit run of `body` is the
 * number of a facts PR or key. Every form's number is a whole run (each
 * pattern's digits end at `\b`, a lookahead or a non-digit, and start after
 * `#`, `/` or `-`); a PR id carries `+run` (a run with its leading zeros
 * dropped, or rounded past 2^53, so both spellings are looked up) and a key
 * the run as written.
 */
function mayPlaceChip(body: string, loaded: LoadedFacts): boolean {
  let nums = factNumbers.get(loaded);
  if (!nums) {
    nums = new Set<string>();
    for (const id of Object.keys(loaded.facts.prs)) nums.add(noLeadingZeros(id.slice(id.lastIndexOf("#") + 1)));
    for (const k of Object.keys(loaded.facts.keys)) nums.add(noLeadingZeros(k.slice(k.lastIndexOf("-") + 1)));
    factNumbers.set(loaded, nums);
  }
  if (nums.size === 0) return false;
  for (const m of body.matchAll(/\d+/g)) if (nums.has(noLeadingZeros(m[0])) || nums.has(String(+m[0]))) return true;
  return false;
}

let chipPassFault: Error | null = null;

/** For tests: make every chip pass throw `err` (null clears it), so a route
 *  can prove a failed chip pass still opens the page. */
export function __setChipPassFaultForTest(err: Error | null): void {
  chipPassFault = err;
}

/**
 * The chip pass for one page: the insertions over `body` and the payload's
 * `facts` — the entries of the PRs and keys that got a chip, plus every PR in
 * those keys' lists. Payload undefined when no chip was placed.
 */
export function planLiveChips(
  body: string,
  markdown: string,
  input: Pick<LiveFactsInput, "loaded" | "grammar" | "trackers" | "relPath">,
): { insertions: ChipInsertion[]; facts: LiveFactsPayload | undefined } {
  if (chipPassFault) throw chipPassFault;
  if (!mayPlaceChip(body, input.loaded)) return { insertions: [], facts: undefined };
  const { facts, prIds } = input.loaded;
  const prEntry = (id: string): [string, FactsPrEntry] | undefined => {
    const fileId = prIds.get(id.toLowerCase());
    return fileId ? [fileId, facts.prs[fileId]!] : undefined;
  };
  const { mentions, code } = markedMentionsWithCode(body, markdown, input.relPath, input.grammar, input.trackers, (id) => prEntry(id)?.[1].title);
  const insertions = chipInsertions(body, mentions, (m) => (m.kind === "pr" ? prEntry(m.id) !== undefined : Object.hasOwn(facts.keys, m.id)), code);
  if (insertions.length === 0) return { insertions, facts: undefined };
  const out: LiveFactsPayload = { prs: {}, keys: {}, noProd: [] };
  for (const site of insertions)
    for (const { id, kind } of site.ids) {
      // Under the file's id, so a PR the page spells two ways (or a key's list
      // spells another way) is one entry; the client looks a chip up ignoring case.
      if (kind === "pr") {
        const [fileId, entry] = prEntry(id)!;
        out.prs[fileId] = entry;
      }
      else {
        const k = facts.keys[id]!;
        out.keys[id] = k;
        for (const p of k.prs) if (facts.prs[p]) out.prs[p] = facts.prs[p]!;
      }
    }
  const noProd = noProdSet(input.grammar);
  out.noProd = [...new Set(Object.keys(out.prs).map((id) => repoOfPr(id).toLowerCase()).filter((r) => noProd.has(r)))].sort();
  return { insertions, facts: out };
}

/** `body` with each insertion's sentinels in place; `sentinel(html)` registers
 *  one chip's HTML and returns its token. */
export function applyChipInsertions(body: string, insertions: readonly ChipInsertion[], sentinel: (html: string) => string): string {
  let out = "";
  let cursor = 0;
  for (const site of insertions) {
    out += body.slice(cursor, site.at) + site.ids.map(({ id }) => sentinel(chipSpanHtml(id))).join("");
    cursor = site.at;
  }
  return out + body.slice(cursor);
}
