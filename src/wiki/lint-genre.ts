/**
 * Lint check 26 — a report page's genre and its picture. Two info findings,
 * page text only (`checkPageText`, so `wiki-check` reports them), on `.mdx`
 * pages under `plans/` or `archive/` that are not culled and not reserved
 * ({@link isGenreScope}):
 *
 * - `genre-missing` — a picture-scope page (`isPictureScopePage`) with no
 *   `genre:` value; the message suggests one ({@link suggestGenre});
 * - `genre-picture` — a page whose `genre:` is a slug other than `none` and
 *   whose first screen ({@link firstScreen}) holds none of what that genre
 *   accepts; or a `genre:` that is not a slug.
 *
 * A third check, `chart-candidate` (a table a Chart kind could draw), was
 * dropped: two hand checks scored 15/20 and 14/20 against the plan's 16/20.
 *
 * The rules are the plan's (mimir `plans/muninn-mdx-genre-pictures.mdx`,
 * Design) as its P2 state table (rows A1–A86, rulings D1–D25; Table B retired
 * with `chart-candidate`) reads them against the code; `lint-genre.test.ts`
 * pins every row by id. Every structural test reads the parsed AST, wikilinks
 * read as their text, and every drawability test is the reader's own
 * (`readChart`, `prStripHtml`, `viewSlot`).
 */

import { chartBody, chartTable, readChart } from "../format/chart-block.ts";
import { parseMeterAttrs, readCaseBoardView, readChartKind } from "../format/component-spec.ts";
import { parseCaseBoard } from "../format/case-board.ts";
import { headerKey } from "../format/delta-table.ts";
import { CHAIN_VIEW_MIN, pageDecisionData, prStripHtml, viewSlot } from "../format/decision-views.ts";
import { componentBlocks, parseBlocks, type Block, type ComponentName, type TableBlock } from "../format/markdown-ast.ts";
import { findGlanceLedger, findLedgers } from "../format/pr-ledger.ts";
import { readSystemMapBlock } from "../format/system-map.ts";
import { visibleText } from "../format/report-top.ts";
import { WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import { isReservedBasename } from "./frontmatter-lists.ts";
import { isPictureScopePage } from "./lint-drift.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import { parseFrontmatter, readCommentedScalar, splitInlineArray, stripFrontmatter, type WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const GENRE_LINT_CHECKS = ["genre-missing", "genre-picture"] as const;

/** The genre slugs `genre:` takes, plus `none` (no picture check). Case-sensitive (D10). */
export const GENRES = ["campaign", "investigation", "runbook", "run-report", "bug", "design", "audit"] as const;
export type Genre = (typeof GENRES)[number] | "none";
const GENRE_VALUES: readonly string[] = [...GENRES, "none"];

/** Rule 1: an `archive/` page's tags, in this order whatever order they are written in (D11). */
const TAG_GENRES: readonly [string, Genre][] = [
  ["postmortem", "bug"],
  ["handover", "none"],
  ["audit", "audit"],
  ["plan", "campaign"],
];

/** D24: the `x=` column of an audit's steps chart. */
const ROUND_HEADERS = new Set(["round", "rounds", "runde", "runder"]);
/** D1: a top-level `### P1 —` / `## PR 2:` heading names a slate PR; so does
 *  `## PR A —`, one capital letter after `PR` and a space (§8). */
const SLATE_HEADING_RE = /^(?:P(?:R)?\s*(\d+)|PR\s+([A-Z]))\s*[—–:-]/;

/** The lint scope of both checks: a non-culled, non-reserved `.mdx` page under `plans/` or `archive/`. */
export function isGenreScope(page: { relPath: string; culled?: boolean }): boolean {
  const p = page.relPath;
  return !page.culled && p.toLowerCase().endsWith(".mdx") && (p.startsWith("plans/") || p.startsWith("archive/")) && !isReservedBasename(p);
}

/** `genre:` read as written (`readCommentedScalar`): absent
 *  or empty is missing; a slug (or `none`) is a genre; anything else is
 *  `invalid`, as written. */
export function readGenre(fm: Record<string, string | string[]>): { kind: "missing" } | { kind: "genre"; genre: Genre } | { kind: "invalid"; raw: string } {
  const v = fm.genre;
  if (v === undefined) return { kind: "missing" };
  if (Array.isArray(v)) return v.length === 0 ? { kind: "missing" } : { kind: "invalid", raw: `[${v.join(", ")}]` };
  const raw = readCommentedScalar(v);
  if (raw === "") return { kind: "missing" };
  return GENRE_VALUES.includes(raw) ? { kind: "genre", genre: raw as Genre } : { kind: "invalid", raw };
}

const isBlankBlock = (b: Block) => b.type === "text" && b.lines.every((l) => l.trim() === "");
const isComponent = (b: Block, name: ComponentName): b is Extract<Block, { type: "component" }> => b.type === "component" && b.name === name;

/** D1: the distinct PR ids of the page's slate — every ledger and the glance
 *  table (any `plan_status`), plus top-level `P1 —` / `PR A —` headings at
 *  levels 2–4. A number and a letter are two ids. */
export function slatePrs(blocks: Block[]): Set<string> {
  const prs = new Set<string>();
  const glance = findGlanceLedger(blocks);
  for (const l of [...findLedgers(blocks), ...(glance ? [glance] : [])]) for (const r of l.rows) if (r.pr !== null) prs.add(String(r.pr));
  for (const b of blocks) {
    if (b.type !== "heading" || b.level < 2 || b.level > 4) continue;
    const m = SLATE_HEADING_RE.exec(visibleText(b.content).trim());
    if (m) prs.add(m[1] !== undefined ? String(Number(m[1])) : m[2]!);
  }
  return prs;
}

/** `tags:` read as written, a trailing `# comment` dropped: `tags: [a]  # x` reaches here as one string. */
function tagsOf(fm: Record<string, string | string[]>): string[] {
  const v = fm.tags;
  let list: string[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === "string") {
    const raw = readCommentedScalar(v);
    list = raw.startsWith("[") && raw.endsWith("]") ? splitInlineArray(raw.slice(1, -1)) : raw.split(",");
  }
  return list.map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** The genre the four ordered rules give a page, and the rule that gave it. */
export function suggestGenre(relPath: string, fm: Record<string, string | string[]>, blocks: Block[]): { genre: Genre; rule: string } {
  if (relPath.startsWith("archive/")) {
    const tags = tagsOf(fm);
    for (const [tag, genre] of TAG_GENRES) if (tags.includes(tag)) return { genre, rule: `rule 1: tag ${tag}` };
  }
  const slate = slatePrs(blocks).size >= 2;
  const has = (name: ComponentName) => componentBlocks(blocks, name).length > 0;
  if (has("RunChecklist")) return { genre: "runbook", rule: "rule 2: <RunChecklist>" };
  if (has("DeltaTable") && !slate) return { genre: "run-report", rule: "rule 2: <DeltaTable> and no slate" };
  if (has("Query")) return { genre: "investigation", rule: "rule 2: <Query>" };
  if (has("CaseBoard")) return { genre: "investigation", rule: "rule 2: <CaseBoard>" };
  if (slate) return { genre: "campaign", rule: "rule 3: a slate of two or more PRs" };
  return { genre: "none", rule: "rule 4: nothing else matched" };
}

/** The first screen, as top-level block indices `[from, to)`: from the end
 *  of the `<Tldr>` box (the first non-blank block after a leading H1, or the
 *  first block), else from the H1, else from the first block; to the first
 *  top-level `<Fold>` (D5), else the end of the page (D6). */
export function firstScreen(blocks: Block[]): { from: number; to: number; foldAt: number } {
  const shown = blocks.flatMap((b, i) => (isBlankBlock(b) ? [] : [i]));
  const h1 = shown.length > 0 && blocks[shown[0]!]!.type === "heading" && (blocks[shown[0]!] as { level: number }).level === 1;
  const boxAt = shown[h1 ? 1 : 0];
  const box = boxAt !== undefined && isComponent(blocks[boxAt]!, "Tldr");
  const from = box ? boxAt! + 1 : h1 ? shown[0]! : 0;
  const foldAt = blocks.findIndex((b) => isComponent(b, "Fold"));
  return { from, to: foldAt < 0 ? blocks.length : foldAt, foldAt };
}

const cellText = (raw: string) => visibleText(raw);

/** Does this `<Chart>` draw (a model, D8), and of which kind? */
function readChartBlock(b: Extract<Block, { type: "component" }>): { kind: string | null; ok: boolean } {
  const kind = readChartKind(b.attrs.kind).value;
  const { table } = chartBody(b.children);
  const ok = kind !== null && readChart(kind, b.attrs, table ? chartTable(table, cellText) : null).model !== null;
  return { kind, ok };
}

/** What sits on the first screen that a genre can accept. */
interface ScreenPictures {
  charts: { kind: string; x: string }[];
  meter: boolean;
  mermaid: boolean;
  diagram: boolean;
  ruleTree: boolean;
  deltaTable: boolean;
  systemMapWrong: boolean;
  caseDots: boolean;
}

function screenPictures(window: Block[], files: LoadedPageFiles | undefined): ScreenPictures {
  const p: ScreenPictures = { charts: [], meter: false, mermaid: false, diagram: false, ruleTree: false, deltaTable: false, systemMapWrong: false, caseDots: false };
  const walk = (bs: readonly Block[]) => {
    for (const b of bs) {
      if (b.type === "code_block" && b.lang.toLowerCase() === "mermaid") p.mermaid = true;
      if ((b.type === "ul" || b.type === "ol") && b.nested) {
        for (const kids of b.nested) for (const k of kids ?? []) if (k.type === "code_block" && k.lang.toLowerCase() === "mermaid") p.mermaid = true;
      }
      if (b.type !== "component") continue;
      // D7: a collapsed block and anything in a Tldr never hold the picture.
      if (b.name === "Fold" || b.name === "More" || b.name === "Tldr") continue;
      if (b.name === "Chart") {
        const c = readChartBlock(b);
        if (c.ok && c.kind) p.charts.push({ kind: c.kind, x: b.attrs.x ?? "" });
      } else if (b.name === "Meter") {
        // Plan D7: a full Meter (N of N) repeats the Status row, so it is no picture.
        const m = parseMeterAttrs(b.attrs);
        if (!m || m.value < m.max) p.meter = true;
      } else if (b.name === "Diagram") p.diagram = true;
      else if (b.name === "RuleTree") p.ruleTree = true;
      else if (b.name === "DeltaTable") p.deltaTable = true;
      else if (b.name === "SystemMap") {
        const read = readSystemMapBlock(b.attrs, chartBody(b.children).table, (raw) => raw, () => "");
        if (read.rows.some((r) => r.status === "wrong")) p.systemMapWrong = true;
      } else if (b.name === "CaseBoard" && readCaseBoardView(b.attrs.view).value === "dots") {
        // D23: a file that cannot be read leaves the check silent.
        const f = b.attrs.src ? files?.get(b.attrs.src) : undefined;
        const data = f?.ok ? parseCaseBoard(f.text) : null;
        if (!data || !data.ok || data.total >= 5) p.caseDots = true;
      }
      walk(b.children);
    }
  };
  walk(window);
  return p;
}

/** Every pipe table on the page at any depth. */
function tablesOf(blocks: readonly Block[]): TableBlock[] {
  return blocks.flatMap((b) => (b.type === "table" ? [b] : b.type === "component" ? tablesOf(b.children) : []));
}

/** D2: is any table on the page, at any depth, a cost table the `range` reader
 *  parses — a column it draws with at least one `a–b` interval, totals counted? */
function hasCostTable(blocks: Block[]): boolean {
  return tablesOf(blocks).some((table) => {
    const ct = chartTable(table, cellText);
    return ct.headers.slice(1).some((value) => {
      const m = readChart("range", { value }, ct).model;
      return m?.kind === "range" && m.rows.some((r) => /–|\s-\s/u.test(r.value.text));
    });
  });
}

/** What a genre accepts, worded for the message. */
const ACCEPTS: Record<Exclude<Genre, "none">, string> = {
  campaign: '<Chart kind="range"> of the slice costs, a <Meter> that is not full, <Chart kind="bars">, or a PR strip or chain view the reader draws',
  investigation: '<Chart kind="funnel"> or <Chart kind="bars">, <CaseBoard view="dots"> with 5 or more cases, or <RuleTree>',
  runbook: '<DeltaTable> or <Chart kind="bars">',
  "run-report": '<Chart kind="bars"> or <DeltaTable>',
  bug: "<SystemMap> with a wrong row, or a mermaid fence",
  design: "a mermaid fence, <Diagram> or <RuleTree>",
  audit: '<Chart kind="steps"> with rounds as its x= column',
};

/** Plan D7 and O9: on a shipped campaign a fence counts and a Meter or bars chart does not. */
const ACCEPTS_SHIPPED_CAMPAIGN = 'a mermaid fence of how the system works, <Chart kind="range"> of the slice costs, or a PR strip or chain view the reader draws';

/** Does the first screen hold the genre's picture? */
function accepts(genre: Exclude<Genre, "none">, planStatus: string | undefined, blocks: Block[], files: LoadedPageFiles | undefined): boolean {
  const { from, to, foldAt } = firstScreen(blocks);
  const p = screenPictures(blocks.slice(from, to), files);
  const chart = (kind: string) => p.charts.some((c) => c.kind === kind);
  switch (genre) {
    case "investigation":
      return chart("funnel") || chart("bars") || p.caseDots || p.ruleTree;
    case "runbook":
    case "run-report":
      return p.deltaTable || chart("bars");
    case "bug":
      return p.systemMapWrong || p.mermaid;
    case "design":
      return p.mermaid || p.diagram || p.ruleTree;
    case "audit":
      return p.charts.some((c) => c.kind === "steps" && ROUND_HEADERS.has(headerKey(c.x)));
    case "campaign": {
      if (chart("range")) return true;
      // Plan D7: a finished plan shows how the system works.
      if (planStatus === "shipped" && p.mermaid) return true;
      // D4: a view counts only when its slot sits before the first top-level Fold.
      const slot = viewSlot(blocks);
      const viewShown = slot >= 0 && (foldAt < 0 || slot - 1 < foldAt);
      const early = planStatus === "proposed" || planStatus === "ready";
      if (early) {
        // D2: a page whose cost table parses as a range must draw it.
        if (hasCostTable(blocks)) return false;
        if (p.meter || chart("bars")) return true;
        const data = pageDecisionData(blocks, { proposed: planStatus === "proposed" });
        return viewShown && prStripHtml(data.ledgers, "en", data.analysis) !== "";
      }
      // Plan O9: on a shipped plan the ledger already shows a PR that did not land.
      if ((p.meter || chart("bars")) && planStatus !== "shipped") return true;
      if (!viewShown) return false;
      const data = pageDecisionData(blocks);
      return prStripHtml(data.ledgers, "en", data.analysis) !== "" || data.analysis.chains.length >= CHAIN_VIEW_MIN;
    }
  }
}

export type GenrePageRef = Pick<WikiPageMeta, "relPath" | "plan_status" | "followups"> & { culled?: boolean };

/** The value of the last top-level `key:` line that has one, as written: the
 *  parser's own last-wins rule, before its unquote loses whether a `#` sat
 *  inside quotes. */
function writtenValue(frontmatter: string, key: string): string | undefined {
  let v: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.replace(/\r$/, ""));
    if (m && m[1] === key && m[2]!.trim()) v = m[2]!.trim();
  }
  return v;
}

export function checkGenre(page: GenrePageRef, rawContent: string, files?: LoadedPageFiles): LintFinding[] {
  if (!isGenreScope(page)) return [];
  const parsed = parseFrontmatter(rawContent);
  const body = stripFrontmatter(rawContent);
  const frontmatter = rawContent.slice(0, rawContent.length - body.length);
  // `genre:` and `tags:` reach `readCommentedScalar` as written, so a value is unquoted once.
  const fm = { ...parsed };
  for (const key of ["genre", "tags"]) if (typeof fm[key] === "string") fm[key] = writtenValue(frontmatter, key) ?? fm[key];
  // Wikilinks read as their text, as the reader's decision text reads them; no line moves.
  const blocks = parseBlocks(body.replace(WIKILINK_WITH_LABEL_RE, (_m, t: string, l?: string) => wikiLinkText(t, l)));
  const pictureScope = isPictureScopePage(page.relPath, parsed, page.plan_status, page.followups);
  const genre = readGenre(fm);
  const findings: LintFinding[] = [];
  const info = (check: LintFinding["check"], message: string, extra: Partial<LintFinding> = {}) =>
    findings.push({ check, relPath: page.relPath, message, severity: "info", ...extra });

  const suggested = genre.kind === "genre" ? null : suggestGenre(page.relPath, fm, blocks);
  if (genre.kind === "missing" && pictureScope) {
    // The parser drops a value-less key, so an empty `genre:` is read off the fence.
    const lead = /^genre:/m.test(frontmatter) ? "The genre: key is empty." : "No genre: key.";
    info("genre-missing", `${lead} The blocks suggest genre: ${suggested!.genre} (${suggested!.rule}); write genre: none for a page with no genre picture`, { detail: suggested!.genre });
  } else if (genre.kind === "invalid") {
    info("genre-picture", `genre: "${genre.raw}" is not a genre slug (${GENRE_VALUES.join(", ")}; lower case)`, { detail: "invalid" });
  } else if (genre.kind === "genre" && genre.genre !== "none" && !accepts(genre.genre, page.plan_status, blocks, files)) {
    const ps = page.plan_status ? ` and plan_status ${page.plan_status}` : "";
    info("genre-picture", `genre: ${genre.genre}${ps}: the first screen (after the In short box, before the first <Fold>) holds none of ${genre.genre === "campaign" && page.plan_status === "shipped" ? ACCEPTS_SHIPPED_CAMPAIGN : ACCEPTS[genre.genre]}`, { detail: genre.genre });
  }

  return findings;
}
