/**
 * The Jira adapter — the only file under `src/wiki/` that knows what a Jira
 * key, a `browse/` link or a Jira status looks like.
 *
 * `inferFrom` runs at index time over a page the store has already read, one
 * rule per relation (`types.ts`). Every rule except `stamped` is bounded by the
 * wiki's configured `projects`, so a repo tag like `demo-api`, an Oracle error
 * `ORA-01407` or a case number `SAK-4711` never reads as a key. `stamped` is
 * the page's own `jira:` line and keeps today's behaviour: any key-shaped token.
 */

import { JIRA_KEY_SHAPE, normalizeJiraKey } from "../provenance.ts";
import { extractJiraKeys } from "../../jira/key-scan.ts";
import { maskFencedCode, maskInlineCode } from "../../jira/markdown-scan.ts";
import { JIRA_TRACKER_ID } from "./jira-id.ts";
import { loadIssueFields } from "./jira-lookup.ts";
import {
  RELATION_STRENGTH,
  type IssueRef,
  type IssueRelation,
  type StatusCategory,
  type TrackerAdapter,
  type TrackerConfig,
  type TrackerPage,
} from "./types.ts";

const ID = JIRA_TRACKER_ID;

/** Jira's own English workflow names. A wiki's `statusMap` merges over this. */
export const JIRA_DEFAULT_STATUS_MAP: Readonly<Record<string, StatusCategory>> = Object.freeze({
  "Backlog": "todo",
  "Open": "todo",
  "To Do": "todo",
  "Selected for Development": "todo",
  "In Progress": "active",
  "In Development": "active",
  "In Review": "review",
  "Code Review": "review",
  "In Test": "review",
  "Done": "done",
  "Resolved": "done",
  "Closed": "done",
});

/**
 * The projects claude-usage records session mentions for — a mirror of its
 * `JIRA_KEY_PREFIXES` (`claude-usage/src/session-files.ts`), which this repo
 * cannot import. A key outside them renders "not tracked", never "$0". A wiki
 * may name its own list (`ledgerProjects` in `.wiki-reader.json`).
 */
export const JIRA_DEFAULT_LEDGER_PROJECTS: readonly string[] = Object.freeze(["MELOSYS", "TESTLOOP", "SMOKE"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `(DEMO|OTHER)` for the configured projects. */
function projectAlt(config: TrackerConfig): string {
  return "(" + config.projects.map(escapeRe).join("|") + ")";
}

/**
 * ASCII word edges, the same `\b` `extractJiraKeys` uses, on every rule: a
 * letter, digit or `_` on the left (`xdemo-1`), or on the right (`demo-12x`),
 * means the run is not a key. The key rules' flags carry no `u`, so a
 * case-insensitive rule cannot fold a lookalike (the Kelvin sign, `ſ`) into a
 * project letter.
 */
const LEFT = "(?<![A-Za-z0-9_])";
/** A key NUMBER: no leading zero (`DEMO-0145` is not `DEMO-145`), at most eight
 *  digits like `JIRA_KEY_SOURCE`, and not running on into a digit. */
const NUM = "([1-9][0-9]{0,7})(?![0-9])";
/** What may not follow a whole key: a word character, or `-` and a digit (a
 *  date `demo-2026-09-25`, a step `DEMO-1-2`). */
const END_RE = /^(?:[A-Za-z0-9_]|-[0-9])/;
/** How many shorthand numbers one base key may expand to. */
const MAX_EXPANSIONS = 5;

/** Emit only a key that is ASCII key-shaped and in a configured project. */
function keep(key: string, config: TrackerConfig): boolean {
  return JIRA_KEY_SHAPE.test(key) && config.projects.includes(key.slice(0, key.indexOf("-")));
}

/**
 * The project-bounded keys in `text`. `chain` is a sticky separator pattern
 * whose one group is a further number of the same project — the title's
 * `DEMO-145/174` and `DEMO-158 + 169`, the stem's `demo-7588-7969`. A chained
 * number must have the base number's digit count (so `DEMO-145/2026` and
 * `demo-2026-09` do not expand), no leading zero, and must itself end cleanly;
 * `maxGap` adds how far from the base it may be (the title's 1000, so
 * `DEMO-8045/2026` and `DEMO-8045 + 2025-kjøringen` do not expand while
 * `DEMO-7588/7969 Nullable sats` does). A base key that does not end cleanly
 * after its chain yields nothing.
 */
function scanKeys(
  text: string,
  config: TrackerConfig,
  opts: { caseSensitive: boolean; chain?: RegExp; maxGap?: number },
): string[] {
  const re = new RegExp(`${LEFT}${projectAlt(config)}-${NUM}`, opts.caseSensitive ? "g" : "gi");
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const project = m[1]!.toUpperCase();
    const base = m[2]!;
    const found = [`${project}-${base}`];
    let pos = m.index + m[0].length;
    if (opts.chain) {
      for (let n = 0; n < MAX_EXPANSIONS; n++) {
        opts.chain.lastIndex = pos;
        const c = opts.chain.exec(text);
        if (!c) break;
        const num = c[1]!;
        const next = c.index + c[0].length;
        const rest = text.slice(next);
        if (num.length !== base.length || num[0] === "0" || END_RE.test(rest)) break;
        if (opts.maxGap !== undefined && Math.abs(Number(num) - Number(base)) > opts.maxGap) break;
        found.push(`${project}-${num}`);
        pos = next;
      }
    }
    if (END_RE.test(text.slice(pos))) continue;
    for (const k of found) if (keep(k, config)) out.push(k);
  }
  return out;
}

const TITLE_CHAIN = /\s*[/+]\s*([0-9]+)/y;
/** How far a title shorthand may sit from its base key. A year or a count is
 *  rarely this close to a same-width key; `DEMO-145 + 300 saker` still is. */
const TITLE_MAX_GAP = 1000;
const STEM_CHAIN = /-([0-9]+)/y;

/**
 * Title keys: UPPERCASE only (like `mention` — `melosys-2 bot-plan` names a
 * bot), with the shorthands `DEMO-145/174` and `DEMO-158 + 169` expanded to the
 * same project under {@link scanKeys}' digit-count and distance rules.
 */
export function titleKeys(title: string, config: TrackerConfig): string[] {
  return scanKeys(title, config, { caseSensitive: true, chain: TITLE_CHAIN, maxGap: TITLE_MAX_GAP });
}

/** Stem keys, case-insensitive; `demo-7588-7969-notes` yields both. */
export function stemKeys(stem: string, config: TrackerConfig): string[] {
  return scanKeys(stem, config, { caseSensitive: false, chain: STEM_CHAIN });
}

/** A tag that IS a key: `demo-145`. */
function tagKeys(tags: readonly string[], config: TrackerConfig): string[] {
  const re = new RegExp(`^${projectAlt(config)}-${NUM}$`, "i");
  const out: string[] = [];
  for (const t of tags) {
    const m = re.exec(t.trim());
    const key = m ? `${m[1]!.toUpperCase()}-${m[2]}` : "";
    if (key && keep(key, config)) out.push(key);
  }
  return out;
}

/** Strings of one frontmatter value, list or scalar. */
function valueStrings(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

/**
 * The keys in a stamped value, list or scalar. An entry that is itself exactly
 * ASCII key-shaped is kept whatever its case (`jira: [demo-103]`); any other entry is
 * prose and goes through `extractJiraKeys` — uppercase keys only, with its
 * denylist — so `jira: DEMO-140 (kilde), se steg-2 og utf-8` yields DEMO-140
 * alone. Not project-bounded: the stamped line is the author's own claim.
 */
export function stampedKeys(value: string | string[] | undefined): string[] {
  const out: string[] = [];
  for (const v of valueStrings(value)) {
    // ASCII-shaped BEFORE uppercasing: `toUpperCase` maps `ſ` to S and `ı` to I.
    if (/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(v.trim())) out.push(normalizeJiraKey(v));
    else out.push(...extractJiraKeys(v));
  }
  return out;
}

/** A `browse/KEY` link on a configured host, with its offset on its line. */
interface LinkHit {
  key: string;
  line: number;
  col: number;
}

/**
 * Where each clause on a line ENDS: a `·`, a `;`, a period followed by
 * whitespace or the end of the line (so `jira.example.invalid` and `22.09` do not
 * split), and — on a table row only — a `|` outside `[...]` and `[[...]]`, which
 * Jira-markup links and wikilink aliases use. Only a `[` with a matching `]`
 * later on the line opens a bracket, so a stray `[` does not swallow every
 * later cell. A newline ends every clause; a list item starts on its own line.
 * Never a character count.
 */
export function clauseBoundaries(line: string): number[] {
  const tableRow = /^\s*\|/.test(line);
  const matched = new Set<number>();
  if (tableRow) {
    const open: number[] = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "[") open.push(i);
      else if (line[i] === "]" && open.length) matched.add(open.pop()!);
    }
  }
  const out: number[] = [];
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "[") {
      if (matched.has(i)) depth++;
    } else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "·" || ch === ";") out.push(i);
    else if (ch === "|" && tableRow && depth === 0) out.push(i);
    else if (ch === "." && (i + 1 === line.length || /\s/.test(line[i + 1]!))) out.push(i);
  }
  return out;
}

/** The text of the clause before `col`, from its opening boundary. */
function clauseBefore(line: string, boundaries: readonly number[], col: number): string {
  let start = 0;
  for (const b of boundaries) {
    if (b < col) start = b + 1;
    else break;
  }
  return line.slice(start, col);
}

function markerRe(marker: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(marker)}(?![\\p{L}])`, "iu");
}

/** Blank a match same-length, newlines kept, so offsets and lines survive. */
const blank = (s: string) => s.replace(/[^\n]/g, " ");

/** Fenced code, inline code and HTML comments blanked — the text every body
 *  rule reads. A key there is an example or a note to self, not a reference. */
function maskBody(body: string): string {
  return maskInlineCode(maskFencedCode(body)).replace(/<!--[\s\S]*?-->/g, blank);
}

function linkHits(maskedBody: string, config: TrackerConfig): LinkHit[] {
  if (config.hosts.length === 0) return [];
  const re = new RegExp(
    `https?://(?:${config.hosts.map(escapeRe).join("|")})(?::\\d+)?/browse/${projectAlt(config)}-${NUM}(?![A-Za-z0-9_]|-[0-9])`,
    "gi",
  );
  const out: LinkHit[] = [];
  maskedBody.split("\n").forEach((text, line) => {
    for (const m of text.matchAll(re)) {
      const key = `${m[1]!.toUpperCase()}-${m[2]}`;
      if (keep(key, config)) out.push({ key, line, col: m.index });
    }
  });
  return out;
}

/**
 * Mentions: a bare, uppercase, project-bounded key in the already-masked body.
 * The scanner is `extractJiraKeys` (denylist); URLs, markdown link
 * destinations and wikilink targets are blanked first, since a key there is an
 * address or a path, not a sentence about the issue.
 */
function mentionKeys(maskedBody: string, config: TrackerConfig): string[] {
  const text = maskedBody
    .replace(/https?:\/\/[^\s)\]>]+/g, blank)
    .replace(/\]\(([^)\n]*)\)/g, (_all, dest: string) => "](" + blank(dest) + ")")
    .replace(/\[\[([^\]|\n]*)/g, (_all, target: string) => "[[" + blank(target));
  return extractJiraKeys(text).filter((k) => k.slice(k.indexOf("-") + 1)[0] !== "0" && keep(k, config));
}

/**
 * Every issue a page relates to. Bookkeeping pages are filtered out by the
 * store before this is called.
 */
export function inferJiraIssues(page: TrackerPage, config: TrackerConfig): IssueRef[] {
  const rels = new Map<string, Set<IssueRelation>>();
  const add = (keys: readonly string[], rel: IssueRelation) => {
    for (const key of keys) {
      let set = rels.get(key);
      if (!set) rels.set(key, (set = new Set()));
      set.add(rel);
    }
  };

  add(stampedKeys(page.frontmatter[jiraAdapter.frontmatterKey]), "stamped");
  for (const field of config.frontmatterKeys) {
    if (!Object.prototype.hasOwnProperty.call(page.frontmatter, field)) continue;
    add(valueStrings(page.frontmatter[field]).flatMap((v) => scanKeys(v, config, { caseSensitive: false })), "declared");
  }
  if (page.authoredTitle) add(titleKeys(page.authoredTitle, config), "title");
  add(stemKeys(page.stem, config), "stem");
  add(tagKeys(page.tags, config), "tag");

  if (page.kind === "markdown" && page.body) {
    const masked = maskBody(page.body);
    const lines = masked.split("\n");
    const markers = config.createdMarkers.map(markerRe);
    /** Line → its clause boundaries, computed once and only when a marker exists. */
    const bounds = new Map<number, number[]>();
    for (const hit of linkHits(masked, config)) {
      add([hit.key], "link");
      if (!markers.length) continue;
      const line = lines[hit.line]!;
      let b = bounds.get(hit.line);
      if (!b) bounds.set(hit.line, (b = clauseBoundaries(line)));
      const before = clauseBefore(line, b, hit.col);
      if (markers.some((re) => re.test(before))) add([hit.key], "created");
    }
    add(mentionKeys(masked, config), "mention");
  }

  const refs: IssueRef[] = [];
  for (const [key, set] of rels) {
    refs.push({ tracker: ID, key, relations: RELATION_STRENGTH.filter((r) => set.has(r)) });
  }
  const rank = (r: IssueRef) => RELATION_STRENGTH.indexOf(r.relations[0]!);
  return refs.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

export const jiraAdapter: TrackerAdapter = {
  id: ID,
  label: "Jira",
  keyPattern: JIRA_KEY_SHAPE,
  normalize: normalizeJiraKey,
  inferFrom: inferJiraIssues,
  urlFor: (key, config) =>
    config.hosts.length ? `https://${config.hosts[0]}/browse/${encodeURIComponent(key)}` : "",
  frontmatterKey: "jira",
  stampFlag: "--jira",
  defaultStatusMap: JIRA_DEFAULT_STATUS_MAP,
  defaultLedgerProjects: JIRA_DEFAULT_LEDGER_PROJECTS,
  lookup: (knowledgeApiUrl) => loadIssueFields(knowledgeApiUrl),
  ledgerPath: (key) => `/api/jira?key=${encodeURIComponent(key)}`,
};
