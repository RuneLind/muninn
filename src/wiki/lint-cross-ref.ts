/**
 * Lint check 29, `cross-page-id-unlinked`, and check 30,
 * `step-query-missing-case` (both warnings): an id another page defines, named
 * with no quick way to it.
 *
 * The reader links a cross-page id only when it stands right before `i`, `in`,
 * `på` or `on` and a wikilink (`Q-5 på [[plans/x|vaktsaksiden]]`,
 * `core/cross-ref.ts`). Check 29 reports the two places where the author meant
 * another page and the link cannot form:
 *
 * | Detail  | Reported                                                              |
 * |---------|-----------------------------------------------------------------------|
 * | `prose` | an id run, the connector, then plain text (`Q-5 på vaktsaksiden`)     |
 * | `step`  | an open `<NextMoves>` step that names an id outside the linked form   |
 *
 * In both, the id is one the page does not define itself and a page it links
 * to, or a page of its `series:`, does. An id nobody near defines (`Q-1 i
 * prod`) and an id the page defines are never findings. The id grammar and the
 * tracker-key exception are the linker's.
 *
 * Check 30 reads the same steps: a clause that names a `<Query>` card and a
 * case key (`CASE-10234`: two or more capitals, `-`, four or more digits, not
 * a tracker key), where the card lists two or more case keys and not that
 * one. A card that names no case key is a general query, and a card that names
 * one may hold an example row; neither is a finding.
 *
 * Not read: frontmatter, code fences and spans, `<Timeline>`, `<DecisionLog>`
 * and `<Historic>`, blockquote lines and table header rows (`stateExemptLines`,
 * check 14's masks), a tag's attribute values, and the inside of a link.
 *
 * A label the page gives a row of its own is not another page's id: an id in
 * a heading, a bold id that opens a list item, a paragraph or a table cell,
 * and a plain id that is a table row's first cell ({@link localLabels}).
 *
 * What a page defines is read off its source: `<DecisionLog>` items and
 * `<Query>` ids. An id two of them carry names no target, as in the reader.
 * A `<CaseBoard>` case is a target in the reader and not here: prose names a
 * case with `i` or `på` all the time (`CASE-10234 i innsyn`), and both such
 * hits on melosys-kode-wiki were false (2026-11-17).
 *
 * Three more shapes are never a finding: an id glued after a hyphen (`Q-R4`
 * holds no `R4`), a connector that opens a state phrase (`Q-1 i prod`,
 * `STATUS_STATES`), and a connector before a date (`O5 on 14.11`, `D3 i 2025`).
 */

import { maskLineCodeSpans } from "../format/code-spans.ts";
import { countedNextMovesLanes, parseBlocks, type Block } from "../format/markdown-ast.ts";
import { decisionLogEntries, eachComponent } from "../format/question.ts";
import { lookupPageFile, parseQueryAttrs, type PageFiles } from "../format/query-block.ts";
import { STATUS_STATES } from "../format/report-top.ts";
import { isTrackerKey, XREF_CONNECTOR_SRC, XREF_ID_SRC, XREF_RUN_SRC, xrefIdsIn, type XrefKind, type XrefRunId } from "./core/cross-ref.ts";
import { stateExemptLines } from "./lint-state.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LintFinding } from "./lint.ts";

export const CROSS_REF_LINT_CHECKS = ["cross-page-id-unlinked", "step-query-missing-case"] as const;

const RUN_CONNECTOR_RE = new RegExp(`(${XREF_RUN_SRC})(${XREF_CONNECTOR_SRC})`, "gu");

export interface XrefConnectedRun {
  /** The run's ids, tracker keys cut as `findXrefRun` cuts them. */
  ids: XrefRunId[];
  /** The connector word as written (`i`, `in`, `på`, `on`). */
  connector: string;
  /** Just past the white space after the connector: where the wikilink
   *  stands when the reader can link the run. */
  end: number;
}

/**
 * Every id run in `text` that `i`, `in`, `på` or `on` follows, wherever it
 * stands: the grammar `findXrefRun` (`core/cross-ref.ts`) reads backwards
 * from a wikilink, read forwards. What follows the connector is the caller's
 * to judge. Here and not in `core/`: that file is in the reader's bundle.
 */
export function xrefRunsBeforeConnector(text: string, trackerProjects: readonly string[] = []): XrefConnectedRun[] {
  const out: XrefConnectedRun[] = [];
  for (const m of text.matchAll(RUN_CONNECTOR_RE)) {
    const ids: XrefRunId[] = [];
    for (const t of xrefIdsIn(m[1]!)) ids.push({ id: t.id, start: m.index + t.start, end: m.index + t.end });
    let k = ids.length;
    while (k > 0 && !isTrackerKey(ids[k - 1]!.id, trackerProjects)) k--;
    const kept = ids.slice(k);
    if (kept.length) out.push({ ids: kept, connector: m[2]!.trim(), end: m.index + m[0].length });
  }
  return out;
}

/** Stands in for text the checks do not read; no id, space or bracket. */
const HOLE = "\uFFFC";
const hole = (s: string): string => s.replace(/[^\n]/g, HOLE);

/** A tag with its attributes, quoted values included (a `>` inside one does not end it). */
const TAG_RE = /<[A-Za-z][\w.-]*(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'))?)*\s*\/?>/g;
/** `[[target|label]]`: the brackets stay, so a link is still seen after a connector. */
const WIKILINK_RE = /\[\[([^\]\n]*)\]\]/g;
/** `[label](target)`: the label stays text, the target goes. */
const MD_LINK_TARGET_RE = /\]\(([^)\s]*)\)/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
/** A wikilink or a markdown link right after the connector, emphasis and an
 *  opening bracket or quote aside. */
const LINK_AHEAD_RE = /^[_(«"'“]*\[/;
/** A case key: capitals, `-`, four or more digits. */
const CASE_KEY_RE = /(?<![\p{L}\p{N}-])\p{Lu}{2,}-[0-9]{4,}(?![\p{L}\p{N}])/gu;
/** The case keys in `text`, tracker keys left out. */
const caseKeysIn = (text: string, trackerProjects: readonly string[]): string[] => [
  ...new Set([...text.matchAll(CASE_KEY_RE)].map((m) => m[0]).filter((k) => !isTrackerKey(k, trackerProjects))),
];
/** A state phrase that opens with a connector (`i prod`, `in prod`), from the
 *  connector on. */
const STATE_AHEAD_RE = new RegExp(
  `^(?:${[...STATUS_STATES.no, ...STATUS_STATES.en].map((s) => s.phrase).filter((p) => /^(?:i|in|på|on) /.test(p)).join("|")})(?![\\p{L}\\p{N}-])`,
  "u",
);
/** A date after the connector: `on 14.11`, `i 2025`. A bare page number (`i 8371`) is none. */
const DATE_AHEAD_RE = /^(?:\d{1,2}\.\d{1,2}|(?:19|20)\d{2}(?![\p{L}\p{N}-]))/u;
/** A step's clauses: split at `;` and at a sentence end. */
const CLAUSE_SPLIT_RE = /;|(?<=[.!?])\s+/;

/** One line or step as the checks read it: code spans, attribute values, link
 *  insides and URLs holed out, `*` emphasis removed. Offsets are not the
 *  source's once a `*` is gone; line breaks are kept. */
function readable(text: string): string {
  return text
    .split("\n")
    .map((line) => maskLineCodeSpans(line).replace(/\n/g, HOLE))
    .join("\n")
    .replace(TAG_RE, (tag) => tag.replace(/=(?:"[^"]*"|'[^']*')/g, (v) => `=${hole(v.slice(1))}`))
    .replace(WIKILINK_RE, (_, inner: string) => `[[${hole(inner)}]]`)
    .replace(MD_LINK_TARGET_RE, (_, target: string) => `](${hole(target)})`)
    .replace(URL_RE, hole)
    .replace(/\*+/g, "");
}

const clean = (s: string): string => s.replaceAll(HOLE, "").replace(/\s+/g, " ").trim();

/** An id the page names where the reader cannot link it. */
export interface XrefMention {
  kind: "prose" | "step";
  ids: string[];
  /** 1-based line, when the text was found in the source. */
  line?: number;
  /** The words as written: `Q-5 på vaktsaksiden`, or a step's ids. */
  snippet: string;
  /** `prose` only: the connector as written. */
  connector?: string;
}

/** An open `<NextMoves>` step, for check 30. */
export interface XrefStep {
  line?: number;
  /** Per clause that names both: its ids and its case keys. */
  clauses: { ids: string[]; cases: string[] }[];
  /** The wikilink targets the step holds, as written. */
  links: string[];
}

export interface XrefPageScan {
  /** The ids the page defines once, by kind. */
  defined: Map<string, XrefKind>;
  /** The page's own row and heading labels ({@link localLabels}). */
  local: Set<string>;
  mentions: XrefMention[];
  steps: XrefStep[];
}

/** The ids a page's source defines as cross-page targets. */
export function pageDefinedIds(content: string): Map<string, XrefKind> {
  const seen = new Map<string, XrefKind | null>();
  if (!/<(?:Query|DecisionLog)\b/.test(content)) return new Map();
  const claim = (id: string, kind: XrefKind) => {
    if (id) seen.set(id, seen.has(id) ? null : kind);
  };
  const blocks = parseBlocks(splitFrontmatter(content).body);
  for (const e of decisionLogEntries(blocks)) claim(e.id, "decision");
  eachComponent(blocks, (b) => {
    if (b.name === "Query") claim(parseQueryAttrs(b.attrs).id, "query");
  });
  const out = new Map<string, XrefKind>();
  for (const [id, kind] of seen) if (kind) out.set(id, kind);
  return out;
}

const BOLD_LABEL_RE = new RegExp(String.raw`(?:^|\|)\s*(?:(?:[-*+]|\d+\.)\s+)?(?:\[[ xX]\]\s+)?(?:~~)?\*\*(${XREF_ID_SRC}):?\*\*`, "gmu");
const ROW_LABEL_RE = new RegExp(String.raw`^\s*\|\s*(${XREF_ID_SRC})\s*\|`, "gmu");

/** The ids a page uses as labels of its own rows and sections. */
export function localLabels(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(BOLD_LABEL_RE)) out.add(m[1]!);
  for (const m of content.matchAll(ROW_LABEL_RE)) out.add(m[1]!);
  for (const line of content.split("\n")) if (/^#{1,6}\s/.test(line)) for (const t of xrefIdsIn(line)) out.add(t.id);
  return out;
}

/** The 1-based line of `content` that holds the start of `text`. */
function lineOf(lines: readonly string[], text: string): number | undefined {
  const head = text.split("\n")[0]!.trim().slice(0, 60);
  if (!head) return undefined;
  const at = lines.findIndex((l) => l.includes(head));
  return at === -1 ? undefined : at + 1;
}

/**
 * What one page names and defines. `subject: false` (a reserved or culled
 * page) reads the definitions only.
 */
export function scanXrefPage(content: string, trackerProjects: readonly string[], subject = true): XrefPageScan {
  const defined = pageDefinedIds(content);
  const mentions: XrefMention[] = [];
  const steps: XrefStep[] = [];
  if (!subject) return { defined, local: new Set(), mentions, steps };
  const isId = (id: string) => !isTrackerKey(id, trackerProjects);
  const hasMoves = content.includes("<NextMoves");
  // The cheap test first, emphasis removed as `readable` removes it (`**Q-5** på …`).
  if (!hasMoves && !xrefRunsBeforeConnector(content.replace(/\*+/g, ""), trackerProjects).length) return { defined, local: new Set(), mentions, steps };
  const local = localLabels(content);

  const { lines, body, exempt } = stateExemptLines(content);
  const text = readable(lines.map((l, i) => (i < body || exempt.has(i) ? "" : l)).join("\n"));
  // `Q-R4` holds no `R4`.
  const glued = (src: string, start: number) => src[start - 1] === "-";
  for (const run of xrefRunsBeforeConnector(text, trackerProjects)) {
    const after = text.slice(run.end);
    if (LINK_AHEAD_RE.test(after)) continue;
    if (STATE_AHEAD_RE.test(`${run.connector} ${after}`) || DATE_AHEAD_RE.test(after)) continue;
    if (run.ids.some((r) => glued(text, r.start))) continue;
    const first = run.ids[0]!;
    const words = /^\S+(?:[ \t]\S+)?/.exec(after)?.[0] ?? "";
    mentions.push({
      kind: "prose",
      ids: run.ids.map((r) => r.id),
      line: text.slice(0, first.start).split("\n").length,
      snippet: clean(`${text.slice(first.start, run.end)}${words}`).replace(/[.,;:)]+$/, ""),
      connector: run.connector,
    });
  }

  if (!hasMoves) return { defined, local, mentions, steps };
  const { lanes } = countedNextMovesLanes(parseBlocks(splitFrontmatter(content).body));
  for (const item of lanes.flatMap((l) => l.items)) {
    const step = readable(item);
    const line = lineOf(lines, item);
    // The ids a connector follows are the prose rule's, linked or not.
    const connected = new Set(xrefRunsBeforeConnector(step, trackerProjects).flatMap((r) => r.ids.map((i) => i.start)));
    const loose = [...new Set(xrefIdsIn(step).filter((t) => isId(t.id) && !connected.has(t.start) && !glued(step, t.start)).map((t) => t.id))];
    if (loose.length) mentions.push({ kind: "step", ids: loose, line, snippet: loose.join(", ") });
    const clauses = step
      .split(CLAUSE_SPLIT_RE)
      .map((c) => {
        const cases = caseKeysIn(c, trackerProjects);
        const ids = [...new Set(xrefIdsIn(c).map((t) => t.id).filter((id) => isId(id) && !cases.includes(id)))];
        return { ids, cases };
      })
      .filter((c) => c.ids.length && c.cases.length);
    if (clauses.length) steps.push({ line, clauses, links: [...item.matchAll(WIKILINK_RE)].map((m) => m[1]!.split("|")[0]!.split("#")[0]!.trim()) });
  }
  return { defined, local, mentions, steps };
}

/** The text of the `<Query id>` card on a page: its attributes, its body and
 *  its `sql=`/`csv=` files. Null when the page has no such card. */
export function queryCardText(content: string, files: PageFiles | undefined, id: string): string | null {
  let card: Extract<Block, { type: "component" }> | null = null;
  eachComponent(parseBlocks(splitFrontmatter(content).body), (b) => {
    if (!card && b.name === "Query" && parseQueryAttrs(b.attrs).id === id) card = b;
  });
  if (!card) return null;
  const found: Extract<Block, { type: "component" }> = card;
  const q = parseQueryAttrs(found.attrs);
  const fileText = (ref: string, kind: "sql" | "csv"): string => {
    const f = ref ? lookupPageFile(files, ref, kind) : null;
    return f?.ok ? f.text : "";
  };
  return [JSON.stringify(found.attrs), JSON.stringify(found.children), fileText(q.sql, "sql"), fileText(q.csv, "csv")].join("\n");
}

export interface XrefLintDeps {
  /** The pages a page links to and the pages of its series, itself left out. */
  neighbours: (relPath: string) => string[];
  /** A wikilink target as written, to the page's relPath. */
  resolve: (target: string) => string | undefined;
  /** {@link queryCardText} for a page of the wiki. */
  cardText: (relPath: string, id: string) => Promise<string | null>;
  /** The connector a suggestion uses: `på` or `on`. */
  connector: string;
  trackerProjects: readonly string[];
}

const linkTarget = (relPath: string): string => relPath.replace(/\.mdx?$/i, "");
const list = (items: readonly string[]): string => items.join(", ");

/** Checks 29 and 30 over every scanned page. */
export async function checkCrossRefs(scans: ReadonlyMap<string, XrefPageScan>, deps: XrefLintDeps): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  for (const [relPath, scan] of scans) {
    if (!scan.mentions.length && !scan.steps.length) continue;
    const near = deps.neighbours(relPath).filter((p) => scans.has(p));
    const definers = (id: string, kind?: XrefKind): string[] =>
      near.filter((p) => {
        const k = scans.get(p)!.defined.get(id);
        return kind ? k === kind : k !== undefined;
      });

    for (const m of scan.mentions) {
      const defines = definers;
      const foreign = m.ids.filter((id) => !scan.defined.has(id) && !scan.local.has(id) && defines(id).length > 0);
      if (!foreign.length) continue;
      // One page that defines every id is the page to name; otherwise the author picks.
      const common = defines(foreign[0]!).filter((p) => foreign.every((id) => defines(id).includes(p)));
      const target = common.length === 1 ? linkTarget(common[0]!) : "<page>";
      const where = foreign.map((id) => `${id} is defined on ${list(defines(id))}`).join("; ");
      const message =
        m.kind === "prose"
          ? `"${m.snippet}": no wikilink follows "${m.connector}", so the reader cannot link ${list(foreign)}. ${where}. Write "${list(foreign)} ${m.connector} [[${target}|…]]"`
          : `a <NextMoves> step names ${list(foreign)} with no link to the page that defines it. ${where}. Write "${list(foreign)} ${deps.connector} [[${target}|…]]"`;
      findings.push({ check: "cross-page-id-unlinked", relPath, message, detail: m.kind, ...(m.line ? { line: m.line } : {}) });
    }

    for (const step of scan.steps) {
      const linked = step.links.map((t) => deps.resolve(t)).filter((p): p is string => !!p);
      for (const clause of step.clauses) {
        for (const id of clause.ids) {
          let page: string | undefined;
          if (scan.defined.get(id) === "query") page = relPath;
          else if (!scan.defined.has(id) && !scan.local.has(id)) {
            const pages = definers(id, "query");
            const named = pages.filter((p) => linked.includes(p));
            page = pages.length === 1 ? pages[0] : named.length === 1 ? named[0] : undefined;
          }
          if (!page) continue;
          const card = await deps.cardText(page, id);
          if (card === null) continue;
          // A card that names no case key is a general query, and one key is
          // an example row as often as a list.
          if (caseKeysIn(card, deps.trackerProjects).length < 2) continue;
          for (const key of clause.cases) {
            if (card.includes(key)) continue;
            findings.push({
              check: "step-query-missing-case",
              relPath,
              message: `a <NextMoves> step names ${id} with ${key}, but the ${id} card${page === relPath ? "" : ` on ${page}`} lists other cases and not ${key}; add it to the card or write a new card for it`,
              detail: key,
              ...(step.line ? { line: step.line } : {}),
            });
          }
        }
      }
    }
  }
  return findings;
}
