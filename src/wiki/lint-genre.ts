/**
 * Lint check 26 — a report page's genre and its picture. Three info findings,
 * page text only (`checkPageText`, so `wiki-check` reports them), on `.mdx`
 * pages under `plans/` or `archive/` that are not culled and not reserved
 * ({@link isGenreScope}):
 *
 * - `genre-missing` — a picture-scope page (`isPictureScopePage`) with no
 *   `genre:` value; the message suggests one ({@link suggestGenre});
 * - `genre-picture` — a page whose `genre:` is a slug other than `none` and
 *   whose first screen ({@link firstScreen}) holds none of what that genre
 *   accepts; or a `genre:` that is not a slug;
 * - `chart-candidate` — on a picture-scope page, a pipe table a Chart kind or
 *   `<DeltaTable>` can draw as it stands ({@link inferTableKind}).
 *
 * The rules are the plan's (mimir `plans/muninn-mdx-genre-pictures.mdx`,
 * Design) as its P2 state table (rows A1–A62, B1–B45, rulings D1–D25) reads
 * them against the code; `lint-genre.test.ts` pins every row by id. Every
 * structural test reads the parsed AST, wikilinks read as their text, and
 * every drawability test is the reader's own (`readChart`, `deltaGrid`,
 * `computeDelta`, `prStripHtml`, `viewSlot`).
 */

import { chartBody, chartTable, FUNNEL_OF_HEADERS, readChart } from "../format/chart-block.ts";
import { readCaseBoardView, readChartKind } from "../format/component-spec.ts";
import { parseCaseBoard } from "../format/case-board.ts";
import { computeDelta, deltaGrid, deltaRowContexts, headerKey } from "../format/delta-table.ts";
import { CHAIN_VIEW_MIN, pageDecisionData, prStripHtml, viewSlot } from "../format/decision-views.ts";
import { componentBlocks, parseBlocks, type Block, type ComponentName, type TableBlock } from "../format/markdown-ast.ts";
import { findGlanceLedger, findLedgers, STATE_HEADER_RE } from "../format/pr-ledger.ts";
import { readSystemMapBlock } from "../format/system-map.ts";
import { visibleText } from "../format/report-top.ts";
import { WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import { isReservedBasename } from "./frontmatter-lists.ts";
import { isCaseRow, isPictureScopePage } from "./lint-drift.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import { parseFrontmatter, stripFrontmatter, type WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const GENRE_LINT_CHECKS = ["genre-missing", "genre-picture", "chart-candidate"] as const;

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

/** A table inside one of these is not a candidate: the block draws or owns it,
 *  keeps history, is an answer card or must hold no chart. Closed list (D20). */
const SHIELDS: ReadonlySet<ComponentName> = new Set<ComponentName>([
  "Chart", "DeltaTable", "Query", "CaseBoard", "ComparisonTable", "SystemMap", "Historic", "Question", "Tldr", "More",
]);

/** Run-column headers (`headerKey` form) a `<DeltaTable>` candidate needs two of (D18). */
const RUN_HEADER_RE = new RegExp(
  "^(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?|(?:run|round|runde|kjøring) #?\\d+|before|after|før|etter|last run|this run|previous|current|forrige|forrige kjøring|denne kjøring)(?: ?\\([^()]*\\))?$",
  "u",
);
/** A share of rows a delta must compute on (inclusive). */
export const DELTA_CANDIDATE_MIN = 0.7;
/** The fewest data rows any candidate needs; a total row (the trailing bold
 *  run the bars and range readers mark) is not one (row B44). */
export const CANDIDATE_MIN_ROWS = 3;
/** The fewest rows whose cell is a real `a–b` interval a `range` candidate needs (row B42). */
export const RANGE_CANDIDATE_MIN_INTERVALS = 2;

/** D17: the header words of a `gap` candidate's three columns. */
const GAP_VALUE = new Set(["value", "verdi", "målt", "measured"]);
const GAP_TARGET = new Set(["target", "mål", "krav"]);
const GAP_GAP = new Set(["gap", "avvik"]);
/** D24: the `x=` column of an audit's steps chart. */
const ROUND_HEADERS = new Set(["round", "rounds", "runde", "runder"]);
/** D1: a top-level `### P1 —` / `## PR 2:` heading names a slate PR. */
const SLATE_HEADING_RE = /^P(?:R)?\s*(\d+)\s*[—–:-]/;
/** D22: the heading of the brief. */
const BRIEF_HEADING_RE = /^(?:brief|oppsummering)$/i;

/** The lint scope of all three checks: a non-culled, non-reserved `.mdx` page under `plans/` or `archive/`. */
export function isGenreScope(page: { relPath: string; culled?: boolean }): boolean {
  const p = page.relPath;
  return !page.culled && p.toLowerCase().endsWith(".mdx") && (p.startsWith("plans/") || p.startsWith("archive/")) && !isReservedBasename(p);
}

/** `genre:` read: absent or empty is missing; a slug (or `none`) is a genre; anything else is `invalid`, as written. */
export function readGenre(fm: Record<string, string | string[]>): { kind: "missing" } | { kind: "genre"; genre: Genre } | { kind: "invalid"; raw: string } {
  const v = fm.genre;
  if (v === undefined) return { kind: "missing" };
  if (Array.isArray(v)) return v.length === 0 ? { kind: "missing" } : { kind: "invalid", raw: `[${v.join(", ")}]` };
  const raw = v.trim();
  if (raw === "") return { kind: "missing" };
  return GENRE_VALUES.includes(raw) ? { kind: "genre", genre: raw as Genre } : { kind: "invalid", raw };
}

const isBlankBlock = (b: Block) => b.type === "text" && b.lines.every((l) => l.trim() === "");
const isComponent = (b: Block, name: ComponentName): b is Extract<Block, { type: "component" }> => b.type === "component" && b.name === name;

/** D1: the distinct PRs of the page's slate — every ledger and the glance
 *  table (any `plan_status`), plus top-level `P1 —` headings at levels 2–4. */
export function slatePrs(blocks: Block[]): Set<number> {
  const prs = new Set<number>();
  const glance = findGlanceLedger(blocks);
  for (const l of [...findLedgers(blocks), ...(glance ? [glance] : [])]) for (const r of l.rows) if (r.pr !== null) prs.add(r.pr);
  for (const b of blocks) {
    if (b.type !== "heading" || b.level < 2 || b.level > 4) continue;
    const m = SLATE_HEADING_RE.exec(visibleText(b.content).trim());
    if (m) prs.add(Number(m[1]));
  }
  return prs;
}

function tagsOf(fm: Record<string, string | string[]>): string[] {
  const v = fm.tags;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\[|\]$/g, "").split(",") : [];
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
      } else if (b.name === "Meter") p.meter = true;
      else if (b.name === "Diagram") p.diagram = true;
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

/** Every pipe table on the page at any depth, with the components around it. */
function tablesOf(blocks: Block[]): { table: TableBlock; inside: ComponentName[] }[] {
  const out: { table: TableBlock; inside: ComponentName[] }[] = [];
  const walk = (bs: readonly Block[], inside: ComponentName[]) => {
    for (const b of bs) {
      if (b.type === "table") out.push({ table: b, inside });
      else if (b.type === "component") walk(b.children, [...inside, b.name]);
    }
  };
  walk(blocks, []);
  return out;
}

export type CandidateKind = "funnel" | "gap" | "delta" | "range" | "bars";

/** The first kind that draws this table, in D19's order (funnel > gap >
 *  DeltaTable > range > bars), with the attributes it was read with. */
export function inferTableKind(table: TableBlock): { kind: CandidateKind; attrs: Record<string, string> } | null {
  const ct = chartTable(table, cellText);
  const h = ct.headers;
  const keys = h.map(headerKey);
  const model = (kind: "funnel" | "gap" | "range" | "bars", attrs: Record<string, string>) => readChart(kind, attrs, ct).model;
  const col = (set: ReadonlySet<string>) => keys.findIndex((k, i) => i > 0 && set.has(k));
  // Row B44: funnel, gap and DeltaTable mark no totals, so every data row counts.
  const enoughRows = ct.rows.length >= CANDIDATE_MIN_ROWS;

  // An `Of`/`Av` column commits the table to funnel: a broken one is no candidate (row B18).
  if (keys.some((k, i) => i > 0 && FUNNEL_OF_HEADERS.has(k))) return enoughRows && model("funnel", {}) ? { kind: "funnel", attrs: {} } : null;

  const [vi, ti, gi] = [col(GAP_VALUE), col(GAP_TARGET), col(GAP_GAP)];
  if (enoughRows && vi > 0 && ti > 0 && gi > 0) {
    const attrs = { value: h[vi]!, target: h[ti]!, gap: h[gi]! };
    if (model("gap", attrs)) return { kind: "gap", attrs };
  }

  const runCols = keys.flatMap((k, i) => (i > 0 && RUN_HEADER_RE.test(k) ? [i] : []));
  if (enoughRows && runCols.length >= 2) {
    const grid = deltaGrid([h[0]!, ...runCols.map((i) => h[i]!)], ct.rows.map((r) => [r[0]!, ...runCols.map((i) => r[i]!)]));
    if (grid.runs) {
      const [a, b] = grid.runs;
      const ctxs = deltaRowContexts(grid, "");
      const overflow = table.rows.map((r) => r.slice(table.headers.length).some((c) => c.trim() !== ""));
      const computed = grid.rows.filter((r, k) => !overflow[k] && computeDelta(r[a]!, r[b]!, "", ctxs[k]) !== null).length;
      if (computed >= DELTA_CANDIDATE_MIN * grid.rows.length) return { kind: "delta", attrs: {} };
    }
  }

  const range = rangeColumn(ct, RANGE_CANDIDATE_MIN_INTERVALS, CANDIDATE_MIN_ROWS);
  if (range !== null) return { kind: "range", attrs: { value: range } };

  // D16: exactly one count column. The bars reader judges each column (a blank
  // cell, mixed units, dates, times and years rule it out); row B43 adds that
  // the parts are not all one value, and row B44 that 3 of them are not a total.
  const counts = h.flatMap((name, i) => {
    const m = i > 0 ? model("bars", { value: name }) : null;
    if (m?.kind !== "bars") return [];
    const parts = m.rows.filter((r) => !r.total).map((r) => r.value.n);
    return parts.length >= CANDIDATE_MIN_ROWS && new Set(parts).size > 1 ? [i] : [];
  });
  if (counts.length === 1) return { kind: "bars", attrs: { value: h[counts[0]!]! } };
  return null;
}

/** The first column the `range` reader draws with at least `minIntervals`
 *  rows whose cell is a real `a–b` interval and `minRows` rows in all, totals
 *  left out of both unless `totals` (D14, rows B42 and B44); else null. The
 *  reader judges every cell, under the column's own date rule (row B45). */
function rangeColumn(ct: ReturnType<typeof chartTable>, minIntervals: number, minRows: number, totals = false): string | null {
  for (let i = 1; i < ct.headers.length; i++) {
    const m = readChart("range", { value: ct.headers[i]! }, ct).model;
    if (m?.kind !== "range") continue;
    const parts = m.rows.filter((r) => totals || !r.total);
    if (parts.length >= minRows && parts.filter((r) => /–|\s-\s/u.test(r.value.text)).length >= minIntervals) return ct.headers[i]!;
  }
  return null;
}

/** Is any table on the page, at any depth, a cost table the `range` reader parses (D2)? */
function hasCostTable(blocks: Block[]): boolean {
  // D2 keeps D14's bar: one interval, any row count (the candidate rules are chart-candidate's).
  return tablesOf(blocks).some(({ table }) => rangeColumn(chartTable(table, cellText), 1, 1, true) !== null);
}

/** D22: the brief's slot-5 table — the first top-level pipe table under
 *  `## Brief`/`## Oppsummering`, before the next H2 and the first top-level Fold. */
export function slotFiveTable(blocks: Block[]): TableBlock | null {
  const at = blocks.findIndex((b) => b.type === "heading" && b.level === 2 && BRIEF_HEADING_RE.test(visibleText(b.content).trim()));
  if (at < 0) return null;
  for (let i = at + 1; i < blocks.length; i++) {
    const b = blocks[i]!;
    if ((b.type === "heading" && b.level <= 2) || isComponent(b, "Fold")) return null;
    if (b.type === "table") return b;
  }
  return null;
}

/** What a genre accepts, worded for the message. */
const ACCEPTS: Record<Exclude<Genre, "none">, string> = {
  campaign: '<Chart kind="range"> of the slice costs, a <Meter>, or a PR strip or chain view the reader draws',
  investigation: '<Chart kind="funnel">, <CaseBoard view="dots"> with 5 or more cases, or <RuleTree>',
  runbook: '<DeltaTable> or <Chart kind="bars">',
  "run-report": '<Chart kind="bars"> or <DeltaTable>',
  bug: "<SystemMap> with a wrong row, or a mermaid fence",
  design: "a mermaid fence, <Diagram> or <RuleTree>",
  audit: '<Chart kind="steps"> with rounds as its x= column',
};

/** Does the first screen hold the genre's picture? */
function accepts(genre: Exclude<Genre, "none">, planStatus: string | undefined, blocks: Block[], files: LoadedPageFiles | undefined): boolean {
  const { from, to, foldAt } = firstScreen(blocks);
  const p = screenPictures(blocks.slice(from, to), files);
  const chart = (kind: string) => p.charts.some((c) => c.kind === kind);
  switch (genre) {
    case "investigation":
      return chart("funnel") || p.caseDots || p.ruleTree;
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
      // D4: a view counts only when its slot sits before the first top-level Fold.
      const slot = viewSlot(blocks);
      const viewShown = slot >= 0 && (foldAt < 0 || slot - 1 < foldAt);
      const early = planStatus === "proposed" || planStatus === "ready";
      if (early) {
        // D2: a page whose cost table parses as a range must draw it.
        if (hasCostTable(blocks)) return false;
        if (p.meter) return true;
        const data = pageDecisionData(blocks, { proposed: planStatus === "proposed" });
        return viewShown && prStripHtml(data.ledgers, "en", data.analysis) !== "";
      }
      if (p.meter) return true;
      if (!viewShown) return false;
      const data = pageDecisionData(blocks);
      return prStripHtml(data.ledgers, "en", data.analysis) !== "" || data.analysis.chains.length >= CHAIN_VIEW_MIN;
    }
  }
}

/** The chart tag a candidate would take. */
function candidateTag(c: { kind: CandidateKind; attrs: Record<string, string> }): string {
  if (c.kind === "delta") return "<DeltaTable>";
  const attrs = Object.entries(c.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<Chart kind="${c.kind}"${attrs}>`;
}

export type GenrePageRef = Pick<WikiPageMeta, "relPath" | "plan_status" | "followups"> & { culled?: boolean };

export function checkGenre(page: GenrePageRef, rawContent: string, files?: LoadedPageFiles): LintFinding[] {
  if (!isGenreScope(page)) return [];
  const fm = parseFrontmatter(rawContent);
  const body = stripFrontmatter(rawContent);
  const bodyAt = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  // Wikilinks read as their text, as the reader's decision text reads them; no line moves.
  const blocks = parseBlocks(body.replace(WIKILINK_WITH_LABEL_RE, (_m, t: string, l?: string) => wikiLinkText(t, l)));
  const pictureScope = isPictureScopePage(page.relPath, fm, page.plan_status, page.followups);
  const genre = readGenre(fm);
  const findings: LintFinding[] = [];
  const info = (check: LintFinding["check"], message: string, extra: Partial<LintFinding> = {}) =>
    findings.push({ check, relPath: page.relPath, message, severity: "info", ...extra });

  const suggested = genre.kind === "genre" ? null : suggestGenre(page.relPath, fm, blocks);
  if (genre.kind === "missing" && pictureScope) {
    info("genre-missing", `No genre: key. The blocks suggest genre: ${suggested!.genre} (${suggested!.rule}); write genre: none for a page with no genre picture`, { detail: suggested!.genre });
  } else if (genre.kind === "invalid") {
    info("genre-picture", `genre: "${genre.raw}" is not a genre slug (${GENRE_VALUES.join(", ")}; lower case)`, { detail: "invalid" });
  } else if (genre.kind === "genre" && genre.genre !== "none" && !accepts(genre.genre, page.plan_status, blocks, files)) {
    const ps = page.plan_status ? ` and plan_status ${page.plan_status}` : "";
    info("genre-picture", `genre: ${genre.genre}${ps}: the first screen (after the In short box, before the first <Fold>) holds none of ${ACCEPTS[genre.genre]}`, { detail: genre.genre });
  }

  if (!pictureScope) return findings;
  const pastProposed = page.plan_status !== undefined && page.plan_status !== "proposed";
  const exemptGenre = genre.kind === "genre" ? genre.genre : (suggested?.genre ?? "none");
  const slotFive = pastProposed && exemptGenre !== "run-report" ? slotFiveTable(blocks) : null;
  for (const { table, inside } of tablesOf(blocks)) {
    if (table === slotFive || inside.some((n) => SHIELDS.has(n))) continue;
    if (table.headers.some((hd) => STATE_HEADER_RE.test(visibleText(hd).trim()))) continue;
    if (table.rows.some(isCaseRow)) continue;
    const c = inferTableKind(table);
    if (!c) continue;
    const line = table.line === undefined ? {} : { line: bodyAt + table.line + 1 };
    const headers = table.headers.map((x) => visibleText(x).trim()).join(" | ");
    info("chart-candidate", `The table "${headers}" can draw as ${candidateTag(c)}; wrap it`, { detail: c.kind, ...line });
  }
  return findings;
}
