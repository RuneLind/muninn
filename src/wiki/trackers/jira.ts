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
import {
  RELATION_STRENGTH,
  type IssueRef,
  type IssueRelation,
  type StatusCategory,
  type TrackerAdapter,
  type TrackerConfig,
  type TrackerPage,
} from "./types.ts";

const ID = "jira";

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `(DEMO|OTHER)` for the configured projects. */
function projectAlt(config: TrackerConfig): string {
  return "(" + config.projects.map(escapeRe).join("|") + ")";
}

/** Letters or digits on either side end a key, in any script. */
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_DIGIT_AFTER = "(?!\\p{N})";

/** Every project-bounded key in `text`, case-insensitive, uppercased. */
function boundedKeys(text: string, config: TrackerConfig): string[] {
  const re = new RegExp(`${NOT_WORD_BEFORE}${projectAlt(config)}-(\\d+)${NOT_DIGIT_AFTER}`, "giu");
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(`${m[1]!.toUpperCase()}-${m[2]}`);
  return out;
}

/**
 * Title keys, including the shorthands `DEMO-145/174` and
 * `DEMO-158 + 169`, which expand to the same project. A shorthand number
 * needs three digits or more, so `KEY-1 + 2 andre` does not mint `KEY-2`.
 */
export function titleKeys(title: string, config: TrackerConfig): string[] {
  const re = new RegExp(
    `${NOT_WORD_BEFORE}${projectAlt(config)}-(\\d+)((?:\\s*[/+]\\s*\\d{3,}${NOT_DIGIT_AFTER})*)${NOT_DIGIT_AFTER}`,
    "giu",
  );
  const out: string[] = [];
  for (const m of title.matchAll(re)) {
    const project = m[1]!.toUpperCase();
    out.push(`${project}-${m[2]}`);
    for (const n of (m[3] ?? "").match(/\d+/g) ?? []) out.push(`${project}-${n}`);
  }
  return out;
}

/** A tag that IS a key: `demo-145`. */
function tagKeys(tags: readonly string[], config: TrackerConfig): string[] {
  const re = new RegExp(`^${projectAlt(config)}-(\\d+)$`, "iu");
  const out: string[] = [];
  for (const t of tags) {
    const m = re.exec(t.trim());
    if (m) out.push(`${m[1]!.toUpperCase()}-${m[2]}`);
  }
  return out;
}

/** Every key-shaped token in a stamped value, list or scalar — the prose scalar
 *  `jira: A-1 (kilde), ny ticket under epic A-2` yields both. Not
 *  project-bounded: the stamped line is the author's own claim. */
function stampedKeys(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const v of values) {
    for (const m of normalizeJiraKey(v).matchAll(/(?<![A-Z0-9-])[A-Z][A-Z0-9]*-[0-9]+(?![0-9])/g)) {
      if (JIRA_KEY_SHAPE.test(m[0])) out.push(m[0]);
    }
  }
  return out;
}

/** Strings of one frontmatter value, list or scalar. */
function valueStrings(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
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
 * Jira-markup links and wikilink aliases use. A newline ends every clause; a
 * list item starts on its own line. Never a character count.
 */
export function clauseBoundaries(line: string): number[] {
  const tableRow = /^\s*\|/.test(line);
  const out: number[] = [];
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "·" || ch === ";") out.push(i);
    else if (ch === "|" && tableRow && depth === 0) out.push(i);
    else if (ch === "." && (i + 1 === line.length || /\s/.test(line[i + 1]!))) out.push(i);
  }
  return out;
}

/** The text of the clause before `col`, from its opening boundary. */
function clauseBefore(line: string, col: number): string {
  let start = 0;
  for (const b of clauseBoundaries(line)) {
    if (b < col) start = b + 1;
    else break;
  }
  return line.slice(start, col);
}

function markerRe(marker: string): RegExp {
  return new RegExp(`${NOT_WORD_BEFORE}${escapeRe(marker)}(?![\\p{L}])`, "iu");
}

/** Fenced and inline code blanked, same length, so offsets survive. */
function maskCode(body: string): string {
  return maskInlineCode(maskFencedCode(body));
}

function linkHits(maskedBody: string, config: TrackerConfig): LinkHit[] {
  if (config.hosts.length === 0) return [];
  const re = new RegExp(
    `https?://(?:${config.hosts.map(escapeRe).join("|")})(?::\\d+)?/browse/${projectAlt(config)}-(\\d+)${NOT_DIGIT_AFTER}`,
    "giu",
  );
  const out: LinkHit[] = [];
  maskedBody.split("\n").forEach((text, line) => {
    for (const m of text.matchAll(re)) {
      out.push({ key: `${m[1]!.toUpperCase()}-${m[2]}`, line, col: m.index });
    }
  });
  return out;
}

/**
 * Mentions: a bare, uppercase, project-bounded key in the body. The scanner is
 * `extractJiraKeys` (fenced-code mask, denylist); inline code, URLs and
 * wikilink targets are blanked first, since a key there is an address or a
 * path, not a sentence about the issue.
 */
function mentionKeys(body: string, config: TrackerConfig): string[] {
  let text = maskInlineCode(maskFencedCode(body));
  text = text.replace(/https?:\/\/[^\s)\]>]+/g, (u) => " ".repeat(u.length));
  text = text.replace(/\[\[([^\]|\n]*)/g, (all, target: string) => "[[" + " ".repeat(target.length));
  const projects = new Set(config.projects);
  return extractJiraKeys(text).filter((k) => projects.has(k.slice(0, k.indexOf("-"))));
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
    add(valueStrings(page.frontmatter[field]).flatMap((v) => boundedKeys(v, config)), "declared");
  }
  if (page.authoredTitle) add(titleKeys(page.authoredTitle, config), "title");
  add(boundedKeys(page.stem, config), "stem");
  add(tagKeys(page.tags, config), "tag");

  if (page.kind === "markdown" && page.body) {
    const masked = maskCode(page.body);
    const lines = masked.split("\n");
    const markers = config.createdMarkers.map(markerRe);
    for (const hit of linkHits(masked, config)) {
      add([hit.key], "link");
      const before = clauseBefore(lines[hit.line]!, hit.col);
      if (markers.some((re) => re.test(before))) add([hit.key], "created");
    }
    add(mentionKeys(page.body, config), "mention");
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
};
