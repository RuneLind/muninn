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
import { inProtectedRegion, markdownCodeRegions } from "../format/markdown-ast.ts";
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
function bodyKeyRe(projects: readonly string[]): RegExp {
  if (projects.length) return new RegExp(`(?<![A-Za-z0-9_])(?:${projects.map(escapeRe).join("|")})-[1-9][0-9]{0,7}(?![A-Za-z0-9_]|-[0-9])`, "g");
  return /\b[A-Z][A-Z0-9]+-\d{2,6}\b/g;
}

/** Every key mention in `body` with its offset, code included. */
export function bodyKeyMentions(body: string, projects: readonly string[]): { key: string; start: number; end: number }[] {
  const generic = projects.length === 0;
  return [...body.matchAll(bodyKeyRe(projects))]
    .filter((m) => !generic || !(m[0].startsWith("MEL-") || m[0].startsWith("Q-")))
    .map((m) => ({ key: m[0], start: m.index!, end: m.index! + m[0].length }));
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
  const fm = parseFrontmatter(markdown);
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
  for (const m of bodyKeyMentions(stripFrontmatter(markdown), projects)) out.add(m.key);
  return out;
}

/** Whether `title` carries `key`'s number as a whole number (`8337` is not in `83370`). */
export function titleCarriesKey(title: string, key: string): boolean {
  const n = key.slice(key.lastIndexOf("-") + 1);
  return n !== "" && new RegExp(`\\b${escapeRe(n)}\\b`).test(title);
}

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
  const taken: [number, number][] = [];
  const add = (id: string, start: number, len: number, form: RefForm) => {
    if (taken.some(([a, b]) => start < b && start + len > a)) return;
    taken.push([start, start + len]);
    out.push({ id, start, end: start + len, form });
  };
  for (const m of body.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) add(`${m[1]}/${m[2]}#${+m[3]!}`, m.index!, m[0].length, "url");
  for (const m of body.matchAll(/\b([A-Za-z][\w.-]*)\/([\w.-]+)\s?#(\d+)\b/g)) add(`${m[1]}/${m[2]}#${+m[3]!}`, m.index!, m[0].length, "qualified");
  if (grammar) {
    for (const m of body.matchAll(/(?<![\w/.-])([a-z][\w]*(?:-[\w]+)*)\s?(?:PR\s)?#(\d{2,5})\b/g)) {
      const alias = Object.hasOwn(grammar.aliases, m[1]!) ? grammar.aliases[m[1]!] : undefined;
      const name = alias ?? (m[1]!.includes("-") ? m[1]! : undefined);
      const repo = name ? qualifyRepo(grammar.owner, name) : null;
      if (repo) add(`${repo}#${+m[2]!}`, m.index!, m[0].length, alias ? "alias" : "repo");
    }
    const homeRepo = home ? qualifyRepo(grammar.owner, home) : null;
    if (homeRepo) for (const m of body.matchAll(/(?<![\w/#-])#(\d{3,5})\b/g)) add(`${homeRepo}#${+m[1]!}`, m.index!, m[0].length, "bare");
  }
  return out.sort((a, b) => a.start - b.start);
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
  const fm = parseFrontmatter(markdown);
  const keySet = [...pageKeySet(markdown, relPath, trackers)];
  const projects = [...new Set(trackers.flatMap((t) => t.projects))];
  const all: Mention[] = [];
  for (const r of prMentions(body, grammar, pageHomeRepo(fm))) {
    if (r.form === "bare") {
      const title = titleOf(r.id);
      if (title === undefined || !keySet.some((k) => titleCarriesKey(title, k))) continue;
    }
    all.push({ id: r.id, kind: "pr", start: r.start, end: r.end });
  }
  if (projects.length) for (const m of bodyKeyMentions(body, projects)) all.push({ id: m.key, kind: "key", start: m.start, end: m.end });
  if (all.length === 0) return [];

  const code = markdownCodeRegions(body);
  const blocked: [number, number][] = [];
  for (const m of body.matchAll(TAG_RE)) blocked.push([m.index!, m.index! + m[0].length]);
  for (const m of body.matchAll(WIKILINK_WITH_LABEL_RE)) blocked.push([m.index!, m.index! + m[0].length]);
  const starts = lineStarts(body);
  const lines = body.split("\n");
  // `body` is `readerBody`'s string: its frontmatter is gone, so a leading `---` is a rule.
  const homes = new Set(stateLineRoles(body, { frontmatter: false }).home.flatMap((u) => u.lines));
  const isBlocked = (m: Mention) => {
    if (inProtectedRegion(m.start, code) || inProtectedRegion(m.end - 1, code)) return true;
    if (blocked.some(([a, b]) => m.start < b && m.end > a)) return true;
    const line = lineOf(starts, m.start);
    if (homes.has(line)) return true;
    return HEADING_RE.test(lines[line]!) && !inProtectedRegion(starts[line]!, code);
  };
  return all.filter((m) => !isBlocked(m)).sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Where the chips go: after a mention, or after the markdown link or bare URL
 * that holds it, one chip per distinct id at each site, in text order. Only
 * ids with a facts entry (`has`) get one.
 */
export function chipInsertions(body: string, mentions: readonly Mention[], has: (m: Mention) => boolean): ChipInsertion[] {
  const code = markdownCodeRegions(body);
  const spans: [number, number][] = [];
  for (const m of body.matchAll(LINK_RE)) if (!inProtectedRegion(m.index!, code) && body[m.index! - 1] !== "[") spans.push([m.index!, m.index! + m[0].length]);
  for (const m of body.matchAll(URL_RE)) {
    const start = m.index!;
    if (spans.some(([a, b]) => start >= a && start < b)) continue;
    const end = start + m[0].replace(/[.,;:!?'"*_]+$/, "").length;
    spans.push([start, end]);
  }
  const sites = new Map<number, ChipInsertion>();
  for (const m of mentions) {
    if (!has(m)) continue;
    const span = spans.find(([a, b]) => m.start >= a && m.end <= b);
    const at = span ? span[1] : m.end;
    let site = sites.get(at);
    if (!site) sites.set(at, (site = { at, ids: [] }));
    if (!site.ids.some((x) => x.id === m.id)) site.ids.push({ id: m.id, kind: m.kind });
  }
  return [...sites.values()].sort((a, b) => a.at - b.at);
}

/** The empty chip span the reader fills. */
export function chipSpanHtml(id: string): string {
  return `<span class="${FACT_CHIP_CLASS}" ${LIVE_FACT_ATTR}="${escapeHtml(id)}" ${READER_ONLY_ATTR}></span>`;
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
  const { facts, prIds } = input.loaded;
  const prEntry = (id: string): [string, FactsPrEntry] | undefined => {
    const fileId = prIds.get(id.toLowerCase());
    return fileId ? [fileId, facts.prs[fileId]!] : undefined;
  };
  const mentions = markedMentions(body, markdown, input.relPath, input.grammar, input.trackers, (id) => prEntry(id)?.[1].title);
  const insertions = chipInsertions(body, mentions, (m) => (m.kind === "pr" ? prEntry(m.id) !== undefined : Object.hasOwn(facts.keys, m.id)));
  if (insertions.length === 0) return { insertions, facts: undefined };
  const out: LiveFactsPayload = { prs: {}, keys: {}, noProd: [] };
  for (const site of insertions)
    for (const { id, kind } of site.ids) {
      if (kind === "pr") out.prs[id] = prEntry(id)![1];
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
