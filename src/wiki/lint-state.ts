/**
 * Lint check 14 — volatile state outside its home (living-facts PR 1, D10).
 * Each volatile fact (a PR's state, a prod release, a Jira status) has one
 * home, on one page: the page whose frontmatter `owns:` lists the key. On a
 * page the homes are `<StatusRows>`, a paragraph that starts with
 * `**Status:**`, a pipe table directly under a `PR ledger` / `PR-oversikt`
 * label or heading, and `status_note`. Every other line names the key and
 * leaves the state to the chip.
 *
 * | check                | fires when                                                                 |
 * |----------------------|----------------------------------------------------------------------------|
 * | `state-outside-home` | a line outside the exempt blocks holds a state phrase or a date qualifier  |
 * |                      | (`per D.M`, `per D.M.YYYY`, `(D.M)`) AND an anchor: a Jira key, the bare    |
 * |                      | number of a key the page names in `jira:`/`owns:`, a PR reference or a      |
 * |                      | task word                                                                  |
 * | `state-not-owner`    | a home clause states the state of a key some page owns, on a page whose     |
 * |                      | `owns:` does not list it                                                   |
 *
 * Scope: live report pages (`isLiveReportPage`, check 9's predicate), not
 * reserved or culled. Frontmatter `description` is linted by check 1;
 * `status_note` is a home. Exempt from check 1, besides the homes: `<Timeline>`,
 * `<DecisionLog>`, `<Historic>`, blockquotes, code fences and inline code.
 * Lanes and plain tables are linted.
 *
 * Off unless `.wiki-reader.json` declares `statePhrases`
 * (`src/format/state-phrases.ts`): the phrases and task words are the wiki's
 * own, so a public repo carries no domain list.
 *
 * A clause (check 2) is the text between `·`, `;` or a sentence end; a state
 * phrase belongs to the nearest key in its clause, and a clause with no key
 * states the page's own work, so it is never a finding. Known gap: a clause
 * that names only a PR cannot be attributed to a key.
 */

import { maskLineCodeSpans } from "../format/code-spans.ts";
import type { StatePhrasesConfig } from "../format/state-phrases.ts";
import { escapeRegExp } from "../utils/escape-regexp.ts";
import { fencedLineMask, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { normalizeJiraKey } from "./provenance.ts";
import type { WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const STATE_LINT_CHECKS = ["state-outside-home", "state-not-owner"] as const;

/** Blocks whose lines check 1 skips: history, and the one block home. */
const HISTORY_BLOCKS = ["Timeline", "DecisionLog", "Historic"] as const;
const HOME_BLOCK = "StatusRows";
const TRACKED_BLOCKS: readonly string[] = [...HISTORY_BLOCKS, HOME_BLOCK];
/** A component tag opening a line; its attributes may run onto later lines. */
const TAG_OPEN_RE = /^<([A-Za-z][A-Za-z0-9]*)(?=[\s>/]|$)/;

/** A Jira-shaped key: a prefix of two or more capitals/digits, a hyphen,
 *  digits, so the page's own `D-1`/`Q-8`/`S-3` ids are not keys. On a wiki
 *  whose trackers name projects the prefix must be one of them
 *  ({@link jiraKeyRe}), so a case id (`MEL-600070`) is not a key either. */
function jiraKeyRe(projects: readonly string[]): RegExp {
  const prefix = projects.length > 0 ? `(?:${projects.map(escapeRegExp).join("|")})` : "[A-Z][A-Z0-9]+";
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${prefix}-\\d+(?![\\p{L}\\p{N}])`, "gu");
}
/** A PR reference: a pull URL, `repo#n`, or a bare `#n`. */
const PR_REF_RE = /\/pull\/\d+|[\w.-]+#\d+|(?<![\p{L}\p{N}&])#\d+(?!\p{N})/u;
/** A date qualifier: `per 11.10`, `per 11.10.2026`, `(11.10)`. */
const DATE_QUALIFIER_RE = /(?<![\p{L}\p{N}])per\s+\d{1,2}\.\d{1,2}(?:\.\d{4})?(?![\p{N}])|\(\d{1,2}\.\d{1,2}\)/giu;
/** Where a clause ends (check 2): `·`, `;`, or a sentence end. */
const CLAUSE_END_RE = /[·;]|[.!?](?=\s|$)/gu;
/** A pipe table's label: a heading or label line naming the PR ledger. */
const LEDGER_LABEL_RE = /PR[ -]ledger|PR-oversikt/i;
/** A paragraph that is a home: it opens with `**Status:**`, after an optional list marker. */
const STATUS_PARA_RE = /^(?:[-*+]\s+|\d+[.)]\s+)?\*\*Status:\*\*/;

/** One case-insensitive, word-edged alternation over `words`, longest first so
 *  `ikke opprettet` wins over `opprettet` at the same place. */
function wordsRe(words: readonly string[]): RegExp | null {
  if (words.length === 0) return null;
  const alt = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "giu");
}

/** The bare number of each key, for a `8332 kan i prod` anchor. */
function keyNumbers(keys: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of keys) {
    const n = /-(\d+)$/.exec(k)?.[1];
    if (n && !out.has(n)) out.set(n, k);
  }
  return out;
}

function numbersRe(numbers: Iterable<string>): RegExp | null {
  const list = [...numbers];
  if (list.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}\\-#/.])(?:${list.join("|")})(?![\\p{N}]|\\.\\d)`, "gu");
}

function keyList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : [];
  return raw.map((k) => normalizeJiraKey(String(k))).filter((k) => k.length > 0);
}

/** A page the state checks read: its meta, its raw content, its frontmatter. */
export interface StatePage {
  page: WikiPageMeta;
  content: string;
  fm: Record<string, string | string[]>;
}

/** Where each line of a page stands. `home` lines are exempt from check 1 and
 *  are what check 2 reads; `exempt` lines are read by neither. */
interface LineRoles {
  /** 0-based line indices check 1 reads. */
  linted: number[];
  /** 0-based line indices check 2 reads. */
  home: number[];
}

/**
 * Classify a page's lines. Frontmatter: `description` (and its block-scalar
 * continuation) is linted, `status_note` is a home, the rest is neither. Body:
 * fences, blockquotes and the three history blocks are exempt; `<StatusRows>`,
 * a `**Status:**` paragraph and a PR-ledger table are homes; every other line
 * is linted.
 */
export function stateLineRoles(content: string): LineRoles {
  const lines = content.split("\n");
  const body = frontmatterEndLine(lines);
  const fenced = fencedLineMask(lines);
  const linted: number[] = [];
  const home: number[] = [];

  // Frontmatter keys, with an indented continuation for a block scalar.
  if (body > 0) {
    for (let i = 1; i < body - 1; i++) {
      const m = /^(description|status_note):\s*(.*)$/.exec(lines[i]!);
      if (!m) continue;
      const into = m[1] === "description" ? linted : home;
      into.push(i);
      if (/^[>|][+-]?\s*$/.test(m[2]!.trim())) {
        for (let k = i + 1; k < body - 1 && /^\s+\S/.test(lines[k]!); k++) into.push(k);
      }
    }
  }

  const depth = new Map<string, number>();
  const inside = (names: readonly string[]) => names.some((n) => (depth.get(n) ?? 0) > 0);
  let statusPara = false;
  let ledger = false;
  for (let i = body; i < lines.length; i++) {
    if (fenced[i]) {
      statusPara = false;
      ledger = false;
      continue;
    }
    const line = lines[i]!;
    const t = line.trim();
    if (t === "") {
      statusPara = false;
      ledger = false;
      continue;
    }

    // Component open/close lines of the tracked blocks.
    let tagLine: string | null = null;
    const open = TAG_OPEN_RE.exec(t);
    if (open && TRACKED_BLOCKS.includes(open[1]!)) {
      const name = open[1]!;
      tagLine = name;
      const closesHere = /\/>\s*$/.test(t) || t.includes(`</${name}>`);
      if (!closesHere) depth.set(name, (depth.get(name) ?? 0) + 1);
    } else {
      const close = /^<\/([A-Za-z][A-Za-z0-9]*)>/.exec(t);
      if (close && (depth.get(close[1]!) ?? 0) > 0) {
        tagLine = close[1]!;
        depth.set(close[1]!, depth.get(close[1]!)! - 1);
      }
    }
    if (tagLine === HOME_BLOCK || inside([HOME_BLOCK])) {
      home.push(i);
      continue;
    }
    if (tagLine !== null || inside(HISTORY_BLOCKS)) continue;
    if (t.startsWith(">")) continue;

    // A `**Status:**` paragraph runs to the next blank line or block start.
    if (STATUS_PARA_RE.test(t)) statusPara = true;
    else if (statusPara && /^(?:[-*+]\s|\d+[.)]\s|#|<|\|)/.test(t)) statusPara = false;
    if (statusPara) {
      home.push(i);
      continue;
    }

    // A pipe table whose nearest non-blank line above is a PR-ledger label.
    if (t.startsWith("|")) {
      if (!ledger) {
        let j = i - 1;
        while (j >= body && lines[j]!.trim() === "") j--;
        const prev = j >= body ? lines[j]!.trim() : "";
        ledger =
          !prev.startsWith("|") &&
          LEDGER_LABEL_RE.test(prev) &&
          (prev.startsWith("#") || prev.startsWith("**") || prev.endsWith(":"));
      }
      if (ledger) {
        home.push(i);
        continue;
      }
    } else ledger = false;

    linted.push(i);
  }
  return { linted, home };
}

interface Match {
  text: string;
  start: number;
}

function allMatches(re: RegExp | null, text: string): Match[] {
  if (!re) return [];
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => ({ text: m[0], start: m.index! }));
}

/** `"a", "b"` quoted the reader's way. */
const quoted = (xs: readonly string[]) => xs.map((x) => `«${x}»`).join(", ");

/**
 * Run both state checks over the live report pages in `pages`. `owners` maps
 * every key some page in the wiki owns to the pages that own it (built over
 * every page, live or not, since an owner is any page whose `owns:` lists it).
 * `trackerProjects` is the union of the wiki's tracker projects; empty ⇒ any
 * Jira-shaped key.
 */
export function checkState(
  pages: readonly StatePage[],
  owners: ReadonlyMap<string, readonly string[]>,
  cfg: StatePhrasesConfig,
  trackerProjects: readonly string[] = [],
): LintFinding[] {
  const JIRA_KEY_RE = jiraKeyRe(trackerProjects);
  const phraseRe = wordsRe(cfg.phrases);
  const taskRe = wordsRe(cfg.taskWords);
  const ownedNumbers = keyNumbers(owners.keys());
  const findings: LintFinding[] = [];

  for (const { page, content, fm } of pages) {
    const lines = content.split("\n");
    const roles = stateLineRoles(content);
    const own = keyList(fm.owns);
    const named = keyNumbers([...own, ...(page.jira ?? keyList(fm.jira))]);
    const namedRe = numbersRe(named.keys());

    // ── Check 1: state outside its home ────────────────────────────────────
    for (const i of roles.linted) {
      const text = maskLineCodeSpans(lines[i]!);
      const states = [...allMatches(phraseRe, text), ...allMatches(DATE_QUALIFIER_RE, text)].map((m) => m.text);
      if (states.length === 0) continue;
      const anchor =
        allMatches(JIRA_KEY_RE, text)[0]?.text ??
        allMatches(namedRe, text)[0]?.text ??
        PR_REF_RE.exec(text)?.[0] ??
        allMatches(taskRe, text)[0]?.text;
      if (anchor === undefined) continue;
      findings.push({
        check: "state-outside-home",
        relPath: page.relPath,
        line: i + 1,
        message: `State outside its home: ${quoted([...new Set(states)])} beside ${quoted([anchor])} — write state only in <StatusRows>, a **Status:** paragraph, the PR ledger or status_note, and name the key or PR elsewhere (D10)`,
      });
    }

    // ── Check 2: a home states a key this page does not own ────────────────
    if (owners.size === 0) continue;
    const ownSet = new Set(own);
    const allNumbers = new Map([...ownedNumbers, ...named]);
    const numRe = numbersRe(allNumbers.keys());
    for (const i of roles.home) {
      const text = maskLineCodeSpans(lines[i]!);
      const reported = new Set<string>();
      let from = 0;
      const ends = [...text.matchAll(CLAUSE_END_RE)].map((m) => m.index!).concat(text.length);
      for (const end of ends) {
        const clause = text.slice(from, end);
        from = end + 1;
        const phrases = allMatches(phraseRe, clause);
        if (phrases.length === 0) continue;
        const keys = [
          ...allMatches(JIRA_KEY_RE, clause).map((m) => ({ key: normalizeJiraKey(m.text), start: m.start, len: m.text.length })),
          ...allMatches(numRe, clause).map((m) => ({ key: allNumbers.get(m.text)!, start: m.start, len: m.text.length })),
        ];
        if (keys.length === 0) continue; // the page's own work
        for (const p of phrases) {
          const pEnd = p.start + p.text.length;
          const gap = (k: { start: number; len: number }) =>
            k.start >= pEnd ? k.start - pEnd : p.start >= k.start + k.len ? p.start - (k.start + k.len) : 0;
          const nearest = keys.reduce((a, b) => (gap(b) < gap(a) ? b : a));
          const ownedBy = owners.get(nearest.key);
          if (!ownedBy || ownSet.has(nearest.key) || reported.has(nearest.key)) continue;
          reported.add(nearest.key);
          findings.push({
            check: "state-not-owner",
            relPath: page.relPath,
            line: i + 1,
            message: `${quoted([p.text])} states ${nearest.key}, which ${ownedBy.join(", ")} owns (owns:) — name the key here and keep its state on the owning page (D10)`,
          });
        }
      }
    }
  }
  return findings;
}

/** The wiki-wide owner map: key → the pages whose `owns:` lists it. */
export function stateOwners(pages: Iterable<{ relPath: string; fm: Record<string, string | string[]> }>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { relPath, fm } of pages) {
    for (const key of keyList(fm.owns)) {
      const list = owners.get(key) ?? [];
      if (!list.includes(relPath)) list.push(relPath);
      owners.set(key, list);
    }
  }
  return owners;
}
