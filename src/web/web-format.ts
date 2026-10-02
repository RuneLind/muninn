import {
  parseBlocks,
  scanInlineComponents,
  normalizeCalloutTone,
  normalizePillTone,
  parseResolvedDate,
  normalizeVerdictValue,
  normalizeFactVerdict,
  factClaimIndex,
  factClaimNumberFromHeading,
  FACT_VERDICT_MARK,
  FACT_VERDICT_WORD,
  FACT_COUNT_WORD,
  parseMeterAttrs,
  firstCodeBlock,
  diffLineClass,
  parseChecklist,
  nextMovesLanes,
  laneFromAttrs,
  laneLeadText,
  isTaskList,
  runChecklistBody,
  runChecklistSteps,
  taskListRows,
} from "../format/markdown-ast.ts";
import type { Block, ChecklistList, ChecklistRow, FactVerdict, ListChild, NextMovesLane } from "../format/markdown-ast.ts";
import { ordinals, renderBlocks, type BlockRenderer, type RenderedChild } from "../format/block-renderer.ts";
import { Placeholders, escapeHtml } from "../format/markdown-core.ts";
import { highlightCode } from "../format/highlight.ts";
import { codeSpanContent, lineCodeSpanRanges } from "../format/code-spans.ts";
import { parseEmbedAttrs } from "../format/embed.ts";
import { parseCsv } from "../format/csv.ts";
import {
  CASEBOARD_NO_SRC,
  QUERY_CSV_MAX_ROWS,
  anchorSlug,
  formatCount,
  lookupPageFile,
  pageFileFailureText,
  pageFileName,
  parseQueryAttrs,
  splitQuerySql,
  type PageFiles,
} from "../format/query-block.ts";
import { commandCode, parseLogItem, parseTimelineItem, runParts, runStepLine, type RunEntry } from "../format/genre-lists.ts";
import { caseBoardWarnings, caseCountParts, groupCases, parseCaseBoard, type BoardCase } from "../format/case-board.ts";
import {
  betterLabelWarnings,
  computeDelta,
  deltaGrid,
  deltaRowContexts,
  gridWritesComma,
  parseDeltaAttrs,
  rowBetter,
  stripEmphasis,
  type DeltaAttrs,
  type DeltaGrid,
} from "../format/delta-table.ts";

type ComponentBlock = Extract<Block, { type: "component" }>;
const isTab = (b: Block): b is ComponentBlock => b.type === "component" && b.name === "Tab";

// ── Fact-check annotation ────────────────────────────────────────────────────
// `<Fact n="4" v="bad">passage</Fact>` marks a fact-checked passage and hangs a
// verdict chip off its end; `<FactCheck …>` is the collapsed appendix holding the
// per-claim evidence. Both render fully SERVER-SIDE — the reader's client only
// wires the chip's expand-on-click, so an article with JS disabled still shows
// which passages were checked and how they came out.

/** The three generated pieces of a `Fact` mark, kept separate because the wrapped
 *  PROSE must keep flowing through the rest of the inline pipeline (bold, links)
 *  rather than being escaped as an opaque label. */
function factMarkParts(attrs: Record<string, string>): {
  open: string;
  close: string;
  chip: string;
} {
  const v = normalizeFactVerdict(attrs.v);
  const n = factClaimIndex(attrs.n);
  const nAttr = n === null ? "" : ` data-fact="${n}"`;
  const label = n === null
    ? `Fact check: ${FACT_VERDICT_WORD[v]}`
    : `Claim ${n} — ${FACT_VERDICT_WORD[v]}`;
  return {
    open: `<span class="fc-mark fc-mark-${v}"${nAttr}>`,
    close: `</span>`,
    // A real <button>: the chip is the interactive affordance for the evidence
    // card, so it must be keyboard-reachable and announce itself. The glyph is
    // aria-hidden (a screen reader saying "check mark" is noise) and the label
    // rides a visually-hidden span instead.
    chip:
      `<button type="button" class="fc-chip fc-chip-${v}"${nAttr}` +
      ` aria-expanded="false" title="${escapeHtml(label)}">` +
      `<span aria-hidden="true">${FACT_VERDICT_MARK[v]}</span>` +
      `<span class="fc-chip-label">${escapeHtml(label)}</span></button>`,
  };
}

/** Counts strip for the collapsed `FactCheck` appendix. A count attr that is
 *  absent or not a number is omitted rather than rendered as `0` — the appendix
 *  must not claim "0 corrected" on a page whose writer simply didn't say.
 *  Counts are DIGITS-ONLY: a bare `Number()` rendered `ok="1e5"` as "100000
 *  confirmed" and `ok="0x10"` as 16. */
function factCheckSummary(attrs: Record<string, string>): string {
  const date = attrs.date?.trim();
  const parts: string[] = [];
  const count = (key: "ok" | "warn" | "bad" | "unknown", v: FactVerdict) => {
    const raw = attrs[key]?.trim();
    if (!raw || !/^\d+$/.test(raw)) return;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return;
    parts.push(
      `<span class="fc-count fc-count-${v}">${FACT_VERDICT_MARK[v]} ${n} ${FACT_COUNT_WORD[v]}</span>`,
    );
  };
  count("ok", "ok");
  count("warn", "warn");
  count("bad", "bad");
  // The ❓ claims — no `<Fact>` mark and no appendix section, so this count is the
  // ONLY trace a deadline-truncated run leaves. Last, after the real verdicts.
  count("unknown", "unknown");
  const lead = date ? `Fact-checked <b>${escapeHtml(date)}</b>` : "Fact-checked";
  return `<span class="fc-strip-lead">${lead}</span>${parts.join("")}`;
}

/**
 * Render the appendix children, wrapping each claim's blocks in a
 * `<section id="fc-claim-N">`. Those ids are what the reader's client clones into
 * the evidence card when a chip is activated — the claim's evidence therefore
 * lives on the page EXACTLY ONCE, rather than being duplicated into `data-`
 * attributes on every chip (where arbitrary source and "Was:" text would have to
 * survive attribute escaping).
 */
function factCheckSections(children: Block[]): string {
  const groups: { n: number | null; blocks: Block[] }[] = [];
  for (const b of children) {
    const n = b.type === "heading" ? factClaimNumberFromHeading(b.content) : null;
    if (n !== null || groups.length === 0) groups.push({ n, blocks: [] });
    groups[groups.length - 1]!.blocks.push(b);
  }
  // Two headings carrying the SAME claim number would emit two
  // `id="fc-claim-1"` — invalid HTML, and `getElementById` would hand the chip
  // whichever the browser picked first. Only the first occurrence keeps the id;
  // later duplicates still render their evidence, just unaddressed.
  const seen = new Set<number>();
  return groups
    .map((g) => {
      const body = renderBlocks(g.blocks, webRenderer);
      if (g.n === null) return body;
      if (seen.has(g.n)) return `<section class="fc-claim" data-claim="${g.n}">${body}</section>`;
      seen.add(g.n);
      return `<section class="fc-claim" id="fc-claim-${g.n}" data-claim="${g.n}">${body}</section>`;
    })
    .join("");
}

/**
 * Converts Claude's markdown output to rich HTML for the web chat.
 *
 * Walks the shared block AST from `parseBlocks` via the shared `renderBlocks`
 * dispatcher; each block emits its own HTML and inline content runs through
 * `renderInline`. The chat-page client picks this up automatically via
 * `web-format-browser.ts`'s bundle.
 */
export function formatWebHtml(text: string, opts?: { files?: PageFiles }): string {
  // `files` is read by the `Query`, `CaseBoard` and `DeltaTable` cases, deep
  // inside the shared renderer, so it rides a module slot for the length of
  // this synchronous call.
  const prev = currentPageFiles;
  currentPageFiles = opts?.files;
  try {
    const rendered = renderBlocks(parseBlocks(text), webRenderer);
    // Cases first: a Query card that collides with a case anchor yields; a
    // DecisionLog item yields to both.
    return uniqueLogAnchors(uniqueAnchors(uniqueCaseAnchors(collapseBlockSpacing(rendered).trim())));
  } finally {
    currentPageFiles = prev;
  }
}

/** The page's sibling files for the call in progress; absent ⇒ the `Query`,
 *  `CaseBoard` and `DeltaTable` blocks say their file is not loaded here. */
let currentPageFiles: PageFiles | undefined;

const ANCHOR_RE = /<section class="query" id="([^"]+)">([\s\S]*?)<a class="query-id" href="#\1">/g;

/** Each `Query` card's anchor made unique in the finished HTML, across the
 *  cards and the `CaseBoard` rows (made unique first, {@link
 *  uniqueCaseAnchors}): a repeat, or a card whose slug a case holds
 *  (`<Query id="Case-A">` beside case `A`), gets the first free `-2`, `-3`,
 *  and its id link follows. A pass over the OUTPUT, because some components
 *  render a body twice and keep one copy (`foldBodyHtml`). */
function uniqueAnchors(html: string): string {
  if (!html.includes('<section class="query" id="')) return html;
  const cases = [...html.matchAll(CASE_ROW_RE)].map((m) => m[1]!);
  // Every card's own slug is reserved first, so a repeat's suffix never takes
  // an id an author wrote (`Q-8`, `Q-8`, `Q-8-2` → `q-8`, `q-8-3`, `q-8-2`).
  const reserved = new Set([...[...html.matchAll(ANCHOR_RE)].map((m) => m[1]!), ...cases]);
  const used = new Set<string>(cases);
  return html.replace(ANCHOR_RE, (_m, slug: string, between: string) => {
    let anchor = slug;
    if (used.has(anchor)) {
      let k = 2;
      while (used.has(`${slug}-${k}`) || reserved.has(`${slug}-${k}`)) k++;
      anchor = `${slug}-${k}`;
    }
    used.add(anchor);
    return `<section class="query" id="${anchor}">${between}<a class="query-id" href="#${anchor}">`;
  });
}

const CASEBOARD_RE = /<section class="caseboard">[\s\S]*?<\/section>/g;
const CASE_ROW_RE = /<div class="cb-row" id="([^"]+)">([\s\S]*?)<a class="cb-id" href="#\1">/g;

/** A second `CaseBoard` on the page repeating an anchor of an earlier one:
 *  the repeat gets the first free `-2`, `-3` past every anchor either board
 *  holds. Within one board the anchors are already unique, in file order
 *  (`parseCaseBoard`), so a status change never moves a suffix there. */
function uniqueCaseAnchors(html: string): string {
  if (!html.includes('<div class="cb-row" id="')) return html;
  const taken = new Set<string>();
  return html.replace(CASEBOARD_RE, (board) => {
    const own = new Set([...board.matchAll(CASE_ROW_RE)].map((m) => m[1]!));
    const out = board.replace(CASE_ROW_RE, (m, slug: string, between: string) => {
      if (!taken.has(slug)) return m;
      let k = 2;
      while (taken.has(`${slug}-${k}`) || own.has(`${slug}-${k}`)) k++;
      own.add(`${slug}-${k}`);
      return `<div class="cb-row" id="${slug}-${k}">${between}<a class="cb-id" href="#${slug}-${k}">`;
    });
    for (const a of own) taken.add(a);
    return out;
  });
}

const LOG_ITEM_RE = /<li class="(dl-item[^"]*)"((?: value="\d+")?) id="([^"]+)"><a class="dl-id" href="#\3">/g;

/** Each `DecisionLog` item's anchor made unique in the finished HTML: the
 *  first `d1` on the page keeps it, a repeat (a second log, or an id any other
 *  element already holds) gets the first free `-2`, `-3`, and its id link
 *  follows. Runs last, so a log item yields to cards and cases. */
function uniqueLogAnchors(html: string): string {
  if (!html.includes('<a class="dl-id" href="#')) return html;
  const used = new Set([...html.replace(LOG_ITEM_RE, "").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
  return html.replace(LOG_ITEM_RE, (_m, cls: string, value: string, slug: string) => {
    let anchor = slug;
    for (let k = 2; used.has(anchor); k++) anchor = `${slug}-${k}`;
    used.add(anchor);
    return `<li class="${cls}"${value} id="${anchor}"><a class="dl-id" href="#${anchor}">`;
  });
}

/** A `CaseBoard` or `DeltaTable` line in place of its file or its data. */
function blockNote(cls: string, text: string): string {
  return `<p class="${cls}">${escapeHtml(text)}</p>`;
}

/** One `CaseBoard` row: id link, status pill, owner, note (inline markdown),
 *  refs. Every value comes from the file and is escaped. */
function caseRowHtml(c: BoardCase): string {
  const id = c.anchor
    ? `<a class="cb-id" href="#${c.anchor}">${escapeHtml(c.id)}</a>`
    : `<span class="cb-id">${escapeHtml(c.id)}</span>`;
  const pill =
    c.status === "unknown"
      ? `<span class="cb-pill cb-unknown" title="${escapeHtml(`status: ${c.rawStatus || "(none)"}`)}">unknown</span>`
      : `<span class="cb-pill cb-${c.status}">${c.status}</span>`;
  const owner = c.owner ? `<span class="cb-owner">${escapeHtml(c.owner)}</span>` : "";
  const note = c.note ? `<span class="cb-note">${renderInline(c.note)}</span>` : "";
  const refs = c.refs.length
    ? `<span class="cb-refs">${c.refs.map((r) => `<span class="cb-ref">${escapeHtml(r)}</span>`).join("")}</span>`
    : "";
  // An id link comes first in the row: `CASE_ROW_RE` reads up to it.
  return `<div class="cb-row"${c.anchor ? ` id="${c.anchor}"` : ""}>${id}${pill}${owner}${note}${refs}</div>`;
}

/** A `<CaseBoard src>`: the count strip, then the rows grouped by status. */
function caseBoardHtml(src: string): string {
  const section = (inner: string) => `<section class="caseboard">${inner}</section>`;
  if (!src) return section(blockNote("cb-unavailable", CASEBOARD_NO_SRC));
  const file = lookupPageFile(currentPageFiles, src, "yaml");
  if (!file.ok) return section(blockNote("cb-unavailable", pageFileFailureText(file.reason, src, "Cases")));
  const board = parseCaseBoard(file.text);
  if (!board.ok) return section(blockNote("cb-unavailable", `${board.reason}: ${pageFileName(src)}`));
  const parts = caseCountParts(board.counts);
  const strip = parts.length
    ? parts
        .map(([n, s]) => `<span class="cb-count cb-count-${s}"><span class="cb-n">${formatCount(n)}</span> ${s}</span>`)
        .join(`<span class="cb-sep"> · </span>`)
    : `<span class="cb-count">0 cases</span>`;
  const notes =
    (board.total > board.cases.length
      ? blockNote("cb-truncated", `showing ${formatCount(board.cases.length)} of ${formatCount(board.total)} cases`)
      : "") + caseBoardWarnings(board).map((w) => blockNote("cb-warning", w)).join("");
  const groups = groupCases(board.cases)
    .map((g) => `<div class="cb-group" data-status="${g.status}">${g.cases.map(caseRowHtml).join("")}</div>`)
    .join("");
  return section(`<p class="cb-strip">${strip}</p>${notes}${groups}`);
}

/** A toned delta's marker: a sign and an accessible name, so good and bad do
 *  not rest on colour alone. */
const DELTA_MARK: Record<"good" | "bad", string> = {
  good: `<span class="dt-mark" role="img" aria-label="better">✓</span> `,
  bad: `<span class="dt-mark" role="img" aria-label="worse">✗</span> `,
};

/** A `<DeltaTable>`'s table: the label column, every run, and the delta
 *  between the last two runs. `cell` renders one cell's text (escaped for a
 *  CSV, inline markdown for a pipe table); `value` is the text a number is
 *  read from (a pipe cell past its emphasis, so a bold Sum row keeps its
 *  delta). A bare `d,ddd` cell is read by {@link deltaRowContexts}; the
 *  percents write a comma when any cell of the table writes an unambiguous
 *  decimal comma, or with `decimal="comma"`. A row wider than
 *  the header gets a marker cell whether or not there is a delta column. */
function deltaTableHtml(
  grid: DeltaGrid,
  attrs: DeltaAttrs,
  cell: (s: string) => string,
  value: (s: string) => string,
): string {
  const { header, rows, overflow, runs } = grid;
  const markerColumn = runs !== null || overflow.some(Boolean);
  const pctComma = gridWritesComma(grid, value) || attrs.decimal === "comma";
  const ctxs = deltaRowContexts(grid, attrs.decimal, value);
  const dir = attrs.better ? `${attrs.better} is better` : attrs.rows?.size ? "✓ better, ✗ worse — per row" : "";
  const th =
    header.map((h, k) => `<th scope="col"${k > 0 ? ` class="dt-run"` : ""}>${cell(h)}</th>`).join("") +
    (runs
      ? `<th scope="col" class="dt-delta">Δ <span class="dt-delta-runs">${cell(header[runs[0]]!)} → ` +
        `${cell(header[runs[1]]!)}</span>${dir ? `<span class="dt-delta-dir">${escapeHtml(dir)}</span>` : ""}</th>`
      : markerColumn
        ? `<th scope="col" class="dt-delta"></th>`
        : "");
  const trs = rows
    .map((r, i) => {
      const tds = r.map((c, k) => (k === 0 ? `<th scope="row">${cell(c)}</th>` : `<td class="dt-run">${cell(c)}</td>`)).join("");
      if (overflow[i]) return `<tr>${tds}<td class="dt-delta dt-overflow">more cells than the header</td></tr>`;
      if (!markerColumn) return `<tr>${tds}</tr>`;
      if (!runs) return `<tr>${tds}<td class="dt-delta dt-none"></td></tr>`;
      const d = computeDelta(
        value(r[runs[0]]!),
        value(r[runs[1]]!),
        rowBetter(attrs, r[0] ?? ""),
        ctxs[i],
        pctComma,
      );
      const dHtml = d
        ? `<td class="dt-delta${d.tone ? ` dt-${d.tone}` : ""}">` +
          (d.tone === "good" || d.tone === "bad" ? DELTA_MARK[d.tone] : "") +
          `<span class="dt-abs">${escapeHtml(d.abs)}</span>` +
          (d.pct ? ` <span class="dt-pct">(${escapeHtml(d.pct)})</span>` : "") +
          `</td>`
        : `<td class="dt-delta dt-none"></td>`;
      return `<tr>${tds}${dHtml}</tr>`;
    })
    .join("");
  const note = runs ? "" : blockNote("dt-note", "Two runs are needed for a delta");
  // Checked against the rows shown: a label past a CSV's row cap reads as no row.
  const labelWarnings = betterLabelWarnings(attrs, rows.map((r) => r[0] ?? ""))
    .map((w) => blockNote("dt-warning", w))
    .join("");
  return (
    `${labelWarnings}<div class="dt-wrap"><table class="dt-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>${note}`
  );
}

/** A `<DeltaTable>`: from its `src=` CSV, else from the first pipe table
 *  that is a direct child of its body. The rest of the body renders above the
 *  table. */
function deltaBlockHtml(attrs: Record<string, string>, rawChildren: Block[]): string {
  const d = parseDeltaAttrs(attrs);
  const bClass = d.better ? ` dt-better-${d.better}` : "";
  const k = d.src ? -1 : rawChildren.findIndex((b) => b.type === "table");
  const rest = k === -1 ? rawChildren : [...rawChildren.slice(0, k), ...rawChildren.slice(k + 1)];
  const intro = rest.some((b) => !isBlankTextBlock(b)) ? `<div class="dt-body">${renderBlocks(rest, webRenderer)}</div>` : "";
  const warn = [d.warning, d.decimalWarning].filter(Boolean).map((w) => blockNote("dt-warning", w)).join("");
  let table: string;
  if (d.src) {
    const csv = readCsvFile(d.src, "Table");
    table = !csv.ok
      ? blockNote("dt-unavailable", csv.note)
      : (csv.warning ? blockNote("dt-warning", csv.warning) : "") +
        deltaTableHtml(deltaGrid(csv.header, csv.shown, csv.headerWidth), d, queryCellHtml, (s) => s) +
        (csv.truncated ? blockNote("dt-truncated", csv.truncated) : "");
  } else if (k !== -1) {
    const t = rawChildren[k] as Extract<Block, { type: "table" }>;
    table = deltaTableHtml(deltaGrid(t.headers, t.rows), d, renderInline, stripEmphasis);
  } else {
    table = blockNote("dt-unavailable", "DeltaTable without src or a table");
  }
  return `<section class="delta-table${bClass}">${intro}${warn}${table}</section>`;
}

/** A `csv=`/`src=` file read for a table: the parsed rows, at most
 *  `QUERY_CSV_MAX_ROWS` of them `shown`, and the warning and truncation lines
 *  as text; or the one line shown in place of the table. Shared by the
 *  `Query` result and the `DeltaTable`. */
type CsvFile =
  | { ok: false; note: string }
  | {
      ok: true;
      name: string;
      header: string[];
      /** The header's cells as written, before padding to the widest row. */
      headerWidth: number;
      rows: string[][];
      shown: string[][];
      warning: string;
      truncated: string;
    };

function readCsvFile(ref: string, what: string): CsvFile {
  const file = lookupPageFile(currentPageFiles, ref, "csv");
  if (!file.ok) return { ok: false, note: pageFileFailureText(file.reason, ref, what) };
  const { header, headerWidth, rows, warning } = parseCsv(file.text);
  const name = pageFileName(ref);
  if (header.length === 0) return { ok: false, note: `Empty file: ${name}` };
  const shown = rows.slice(0, QUERY_CSV_MAX_ROWS);
  return {
    ok: true,
    name,
    header,
    headerWidth: headerWidth ?? header.length,
    rows,
    shown,
    warning: warning === "unterminated-quote" ? `Unterminated quote — the rest of the file is one cell: ${name}` : "",
    truncated: rows.length > shown.length ? `showing ${formatCount(shown.length)} of ${formatCount(rows.length)} rows` : "",
  };
}

/** A `Query` card's unavailable line, in place of a table or the SQL. */
function queryFileNote(text: string): string {
  return `<p class="query-unavailable">${escapeHtml(text)}</p>`;
}

/** A cell's text: escaped, with each line end as `&#10;` so the cell's
 *  `white-space: pre-line` shows it and `collapseBlockSpacing` cannot fold it. */
function queryCellHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, "&#10;");
}

/** The result table from a `csv=` file: escaped cells, header verbatim, at most
 *  `QUERY_CSV_MAX_ROWS` rows. The reader's enhancer adds header-click sorting. */
function queryResultHtml(ref: string): string {
  const csv = readCsvFile(ref, "Result");
  if (!csv.ok) return `<div class="query-result">${queryFileNote(csv.note)}</div>`;
  const th = csv.header.map((h) => `<th scope="col">${queryCellHtml(h)}</th>`).join("");
  const trs = csv.shown.map((r) => `<tr>${r.map((c) => `<td>${queryCellHtml(c)}</td>`).join("")}</tr>`).join("");
  // The reader sorts the rows it has; a truncated table says so.
  const more = csv.truncated
    ? `<p class="query-truncated">${escapeHtml(`${csv.truncated} — sorting reorders the rows shown`)}</p>`
    : "";
  const warn = csv.warning ? `<p class="query-warning">${escapeHtml(csv.warning)}</p>` : "";
  const n = csv.rows.length;
  return (
    `<div class="query-result"><div class="query-result-head"><code>${escapeHtml(csv.name)}</code>` +
    `<span class="query-rows">${formatCount(n)} ${n === 1 ? "row" : "rows"}</span></div>${warn}` +
    `<div class="query-table-wrap"><table class="query-table"><thead><tr>${th}</tr></thead>` +
    `<tbody>${trs}</tbody></table></div>${more}</div>`
  );
}

/** A `Query` card's SQL disclosure: the `sql=` file when set, else the fence
 *  `splitQuerySql` moved out of the body; nothing when there is neither. */
function querySqlHtml(sqlRef: string, fence: { lang: string; code: string } | null): string {
  let inner = "";
  let source = "";
  if (sqlRef) {
    const file = lookupPageFile(currentPageFiles, sqlRef, "sql");
    inner = file.ok ? codeFenceHtml("sql", file.text.trimEnd()) : queryFileNote(pageFileFailureText(file.reason, sqlRef));
    source = ` <code>${escapeHtml(pageFileName(sqlRef))}</code>`;
  } else if (fence) {
    inner = codeFenceHtml(fence.lang, fence.code);
  }
  if (!inner) return "";
  return `<details class="query-sql"><summary>SQL${source}</summary><div class="query-sql-body">${inner}</div></details>`;
}

/**
 * The ONE place a fence becomes HTML — both the ordinary `code_block` branch
 * and `AnnotatedCode` go through it, so a fence is highlighted the same way
 * whichever wrapper it sits in.
 *
 * `highlightCode` escapes what it does not tokenize, so this is a drop-in for
 * the `escapeHtml(code)` it replaced; an unknown language returns exactly that.
 * The `language-*` class stays: the mermaid enhancer selects on it.
 */
function codeFenceHtml(lang: string, code: string): string {
  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre><code${langClass}>${highlightCode(code, lang)}</code></pre>`;
}

/**
 * A `<Fold>` body, with the DOUBLED LABEL suppressed.
 *
 * The retrofit convention puts the section's own `##` heading inside the fold —
 * huginn's breadcrumbs, Explain's `nearestHeading` and the strip-and-diff guard
 * all read it — so a fold titled after its section shows the same words twice.
 * When the body's FIRST block is a heading whose trimmed source equals the
 * title, it renders with `fold-heading-dup`, which the fold CSS hides. The
 * element stays in the DOM on purpose: Explain walks previous siblings for a
 * heading tag, and removing it would move every following paragraph's section.
 * Every other heading, and a first heading that differs, renders normally.
 */
function foldBodyHtml(title: string, children: string, rawChildren: Block[]): string {
  if (!title) return children;
  // The component grammar wants a blank line after the opening tag, so the body's
  // first BLOCK is routinely an empty `text` one. Skipping those is what makes the
  // rule "the section's own heading", not "a heading written flush against the tag".
  let i = 0;
  while (i < rawChildren.length && isBlankTextBlock(rawChildren[i]!)) i++;
  const first = rawChildren[i];
  if (!first || first.type !== "heading" || first.content.trim() !== title) return children;
  const tag = `h${Math.min(first.level + 1, 6)}`;
  const head = `<${tag} class="fold-heading-dup">${renderInline(first.content)}</${tag}>`;
  const rest = rawChildren.slice(i + 1);
  return [
    ...(i > 0 ? [renderBlocks(rawChildren.slice(0, i), webRenderer)] : []),
    head,
    ...(rest.length > 0 ? [renderBlocks(rest, webRenderer)] : []),
  ].join("\n");
}

function isBlankTextBlock(block: Block): boolean {
  return block.type === "text" && block.lines.every((l) => l.trim() === "");
}

/** A list item's text: a continuation line after a `\n`, which the chat's
 *  `pre-wrap` shows as a line break and the wiki reader as a space. */
function itemHtml(text: string): string {
  return text.split("\n").map(renderInline).join("\n");
}

/** ` value="n"` on an ordered item that keeps its own source number. */
function liValue(values: (number | undefined)[] | undefined, k: number): string {
  const v = values?.[k];
  return v === undefined ? "" : ` value="${v}"`;
}

/** What sits under an item: child lists and code as rendered, a further
 *  paragraph of the item as a `<p>` inside the `<li>`. */
function childrenHtml(children: RenderedChild[] | undefined): string {
  return children?.map((c) => (c.kind === "para" ? `<p>${itemHtml(c.text)}</p>` : c.out)).join("") ?? "";
}

/** Checklist rows as `<ul class="checklist">`, a nested list inside its parent
 *  row. Every task row wraps its text in `check-text`: a flat row is a flex box,
 *  so the wrapper keeps its text one flex item, and on a parent row (`check-parent`,
 *  taken out of the flex row by the CSS) it stops the todo colour at the row's own
 *  words instead of reaching the rows under it. A nested row with no task marker is a
 *  plain `check-plain` item, and a nested ordered list keeps its numbers. */
function checklistHtml(
  rows: ChecklistRow[],
  ordered = false,
  start = 1,
  values?: (number | undefined)[],
  /** How a list nested directly under a row renders; `RunChecklist`'s labelled rows. */
  nestedList?: (list: ChecklistList) => string,
  /** A `RunChecklist` step list: an ordered one paints each step's number,
   *  since a flex row shows no list marker. */
  stepNumbers = false,
): string {
  // A task row is a flex box, not a list item, so it does not advance an <ol>'s
  // counter: in an ordered sublist every row carries its number as `value`.
  const nums = ordered ? ordinals(start, rows.length, values) : undefined;
  const lis = rows
    .map((it, k) => {
      const nested = (it.children ?? [])
        .map((c) =>
          c.type === "code_block"
            ? codeFenceHtml(c.lang, c.code)
            : c.type === "paragraph"
              ? `<p>${itemHtml(c.text)}</p>`
              : nestedList
                ? nestedList(c)
                : checklistHtml(c.rows, c.ordered, c.start, c.values),
        )
        .join("");
      const value = nums ? ` value="${nums[k]}"` : "";
      if (it.plain) return `<li class="check-plain"${value}>${itemHtml(it.text)}${nested}</li>`;
      const state = it.checked ? "done" : "todo";
      const mark = it.checked ? "✓" : "✗";
      // Always one wrapper: the row is a flex box, so unwrapped text runs, <code>
      // and <strong> each became a flex item and a long row split into columns.
      const text = `<span class="check-text">${itemHtml(it.text)}</span>`;
      const num = stepNumbers && nums ? `<span class="rc-num">${nums[k]}.</span>` : "";
      return (
        `<li class="check-item check-${state}${nested ? " check-parent" : ""}"${value}>` +
        `${num}<span class="check-mark">${mark}</span> ${text}${nested}</li>`
      );
    })
    .join("");
  if (!ordered) return `<ul class="checklist">${lis}</ul>`;
  return `<ol class="checklist check-ol"${start !== 1 ? ` start="${start}"` : ""}>${lis}</ol>`;
}

/** One `<Lane>` card of a `NextMoves` grid. `data-count` is the lane's OPEN
 *  step count (`NextMovesLane.items`), which the reader's header pills sum, so
 *  the pill and the index-time count come from one function. `data-since` stays
 *  an ISO date: the reader turns it into an age client-side, so cached HTML
 *  never carries a stale one. A `since` that is not a date renders as written,
 *  with no `data-since` and so no age. A list carrying `[x]`/`[ ]` markers
 *  renders with the checklist marks. */
function laneHtml(lane: NextMovesLane): string {
  const since = lane.since ? ` data-since="${lane.since}"` : "";
  const unknown = lane.known ? "" : " nm-kind-unknown";
  // The authored label, for the reader's header pill; absent ⇒ the pill's
  // English default.
  const who = lane.who ? ` data-who="${escapeHtml(lane.who)}"` : "";
  const sinceHtml = lane.since
    ? `<span class="nm-since"${since}>${lane.since}</span>`
    : lane.sinceRaw
      ? `<span class="nm-since nm-since-raw">${escapeHtml(lane.sinceRaw)}</span>`
      : "";
  const body = lane.children
    .map((b) =>
      (b.type === "ul" || b.type === "ol") && isTaskList(b)
        ? checklistHtml(taskListRows(b), b.type === "ol", b.type === "ol" ? b.start : 1, b.type === "ol" ? b.values : undefined)
        : renderBlocks([b], webRenderer),
    )
    .join("\n");
  return (
    `<div class="nm-lane nm-${lane.kind}${unknown}" data-kind="${lane.kind}" data-count="${lane.items.length}"${since}${who}>` +
    `<div class="nm-head"><span class="nm-who">${escapeHtml(lane.label)}</span>` +
    `<span class="nm-count">${lane.items.length}</span>${sinceHtml}</div>` +
    `<div class="nm-body">${body}</div></div>`
  );
}

/** The grid's column class for `n` card lanes: one row of up to three, and
 *  four as 2×2, so no count leaves a lone card on a row of its own at the
 *  reader's width. Five or more fall back to auto-fit. Narrow containers go to
 *  one column (`component-styles.ts`). */
function laneColsClass(n: number): string {
  return n === 4 ? "nm-cols-2" : n <= 3 ? `nm-cols-${n}` : "nm-cols-auto";
}

/** What sits under a `Timeline` or `DecisionLog` item, as the list renderer
 *  draws it. */
function listChildHtml(c: ListChild): string {
  if (c.type === "code_block") return codeFenceHtml(c.lang, c.code);
  if (c.type === "paragraph") return `<p>${itemHtml(c.text)}</p>`;
  return renderBlocks([c], webRenderer);
}

/** A `Timeline` or `DecisionLog` body: every top-level item of every list
 *  directly in it goes through `li` (its text, what sits under it, and an
 *  ordered item's ` value`); any other block renders as markdown in place. */
function wrappedListsHtml(
  blocks: Block[],
  listClass: string,
  li: (text: string, nested: string, value: string) => string,
): string {
  return blocks
    .map((b) => {
      if (b.type !== "ul" && b.type !== "ol") return renderBlocks([b], webRenderer);
      const lis = b.items
        .map((text, k) =>
          li(text, (b.nested?.[k] ?? []).map(listChildHtml).join(""), b.type === "ol" ? liValue(b.values, k) : ""),
        )
        .join("");
      return b.type === "ul"
        ? `<ul class="${listClass}">${lis}</ul>`
        : `<ol class="${listClass}"${b.start !== 1 ? ` start="${b.start}"` : ""}>${lis}</ol>`;
    })
    .join("\n");
}

/** One `Timeline` item: a dated one sits on the rail with its date, as
 *  written, for a marker; an undated one has no marker. */
function timelineItemHtml(text: string, nested: string, value: string): string {
  const t = parseTimelineItem(text);
  if (!t.date) return `<li class="gtl-item gtl-undated"${value}>${itemHtml(t.text)}${nested}</li>`;
  return (
    `<li class="gtl-item gtl-dated"${value}><span class="gtl-date">${escapeHtml(t.date)}</span>` +
    `<span class="gtl-text">${itemHtml(t.text)}</span>${nested}</li>`
  );
}

/** One `DecisionLog` item: the id as a chip linking its own anchor (made
 *  unique by `uniqueLogAnchors`), dimmed when struck or superseded. An item
 *  with no id is a plain item. The id link must follow the `<li>` directly:
 *  `LOG_ITEM_RE` reads it there. */
function logItemHtml(text: string, nested: string, value: string): string {
  const p = parseLogItem(text);
  const dim = p.dim ? " dl-dim" : "";
  if (!p.id) return `<li class="dl-item dl-noid${dim}"${value}>${itemHtml(p.text)}${nested}</li>`;
  const anchor = anchorSlug(p.id);
  return (
    `<li class="dl-item${dim}"${value} id="${anchor}"><a class="dl-id" href="#${anchor}">${escapeHtml(p.id)}</a>` +
    `<span class="dl-text">${itemHtml(p.text)}</span>${nested}</li>`
  );
}

/** A list nested under a `RunChecklist` step: labelled entries as rows, the
 *  unlabelled ones between them as an ordinary nested list. */
function runListHtml(list: ChecklistList): string {
  const nums = ordinals(list.start, list.rows.length, list.values);
  return runParts(list, nums)
    .map((p) =>
      p.kind === "list" ? checklistHtml(p.list.rows, p.list.ordered, p.list.start, p.list.values) : runEntryHtml(p.entry, p.row),
    )
    .join("");
}

/** One labelled row. A command that is one code span renders as a one-line
 *  code block, so the reader's copy button reaches it; anything under the
 *  entry follows as written. (A fence cannot sit this deep; one directly under
 *  the step is an ordinary fence beside the rows.) */
function runEntryHtml(e: RunEntry, row: ChecklistRow): string {
  const code = e.kind === "command" ? commandCode(e.value) : null;
  const value = code !== null ? codeFenceHtml("", code) : itemHtml(e.value);
  const under = (row.children ?? [])
    .map((c) =>
      c.type === "code_block"
        ? codeFenceHtml(c.lang, c.code)
        : c.type === "paragraph"
          ? `<p>${itemHtml(c.text)}</p>`
          : checklistHtml(c.rows, c.ordered, c.start, c.values),
    )
    .join("");
  return (
    `<div class="rc-row rc-${e.kind}"><span class="rc-label">${escapeHtml(e.label)}</span>` +
    `<div class="rc-value">${value}${under}</div></div>`
  );
}

const webRenderer: BlockRenderer = {
  code_block(block) {
    return codeFenceHtml(block.lang, block.code);
  },
  hr: () => "<hr>",
  heading(block) {
    const tag = `h${Math.min(block.level + 1, 6)}`;
    return `<${tag}>${renderInline(block.content)}</${tag}>`;
  },
  blockquote: (lines) => `<blockquote>${lines.map(renderInline).join("<br>")}</blockquote>`,
  ul: (items, nest) =>
    `<ul>${items.map((i, k) => `<li>${itemHtml(i)}${childrenHtml(nest.children[k])}</li>`).join("")}</ul>`,
  ol: (items, start, nest) =>
    `<ol${start !== 1 ? ` start="${start}"` : ""}>` +
    items.map((i, k) => `<li${liValue(nest.values, k)}>${itemHtml(i)}${childrenHtml(nest.children[k])}</li>`).join("") +
    `</ol>`,
  table(headers, rows) {
    const thead = "<thead><tr>" + headers.map((h) => `<th>${renderInline(h)}</th>`).join("") + "</tr></thead>";
    const tbody = "<tbody>" + rows.map((row) =>
      "<tr>" + row.map((cell) => `<td>${renderInline(cell)}</td>`).join("") + "</tr>"
    ).join("") + "</tbody>";
    return `<table>${thead}${tbody}</table>`;
  },
  component(name, attrs, children, rawChildren) {
    switch (name) {
      case "Callout": {
        const tone = normalizeCalloutTone(attrs.tone);
        const resolved = parseResolvedDate(attrs.resolved);
        if (resolved) {
          // A closed issue: one good-tone row, "✓ <date> · <title>", with the
          // original body kept behind the fold so the history stays readable.
          // The author's tone is dropped — the row reports the outcome.
          const t = attrs.title?.trim();
          const titleHtml = t ? ` · <span class="callout-resolved-title">${escapeHtml(t)}</span>` : "";
          return (
            `<details class="callout callout-good callout-resolved">` +
            `<summary class="callout-resolved-row"><span class="callout-resolved-mark">✓</span> ` +
            `<span class="callout-resolved-date">${resolved}</span>${titleHtml}</summary>` +
            `<div class="callout-body">${children}</div></details>`
          );
        }
        const calloutTitle = attrs.title?.trim();
        const title = calloutTitle
          ? `<strong class="callout-title">${escapeHtml(calloutTitle)}</strong>`
          : "";
        return `<div class="callout callout-${tone}">${title}<div class="callout-body">${children}</div></div>`;
      }
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return `<span class="verdict verdict-${value}">${label}</span>`;
      }
      case "Pill": {
        const tone = normalizePillTone(attrs.tone);
        const cls = tone === "default" ? "pill" : `pill pill-${tone}`;
        return `<span class="${cls}">${children}</span>`;
      }
      case "Figure": {
        const caption = attrs.caption
          ? `<figcaption class="caption">${escapeHtml(attrs.caption)}</figcaption>`
          : "";
        return `<figure class="figure"><div class="figure-body">${children}</div>${caption}</figure>`;
      }
      case "FileRef":
        return `<code class="fileref">${children.trim() || escapeHtml(attrs.path ?? "")}</code>`;
      case "ComparisonTable":
        return `<div class="tablewrap">${children}</div>`;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        if (!meter) return children; // missing/non-numeric value → label as plain text
        const pct = Math.round((meter.value / meter.max) * 100);
        const cls = meter.tone === "default" ? "meter" : `meter meter-${meter.tone}`;
        return (
          `<div class="${cls}">` +
          `<span class="meter-label">${children}</span>` +
          `<span class="meter-bar"><span class="meter-fill" style="width:${pct}%"></span></span>` +
          `<span class="meter-value">${meter.value}/${meter.max}</span>` +
          `</div>`
        );
      }
      case "Diff": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children; // no fenced diff → fall back to the rendered body
        const rows = fence.code
          .split("\n")
          .map((line) => {
            const content = escapeHtml(line);
            return `<div class="diff-line diff-${diffLineClass(line)}">${content || "&nbsp;"}</div>`;
          })
          .join("");
        return `<div class="diff">${rows}</div>`;
      }
      case "FileTree":
        // Wrap-only: the rendered fence (a <pre><code>) is the tree; CSS gives it
        // the monospace box + guide styling.
        return `<div class="filetree">${children}</div>`;
      case "Checklist": {
        const items = parseChecklist(rawChildren);
        if (items.length === 0) return children; // no task list → render body as-is
        return checklistHtml(items);
      }
      case "AnnotatedCode": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children; // no code fence → nothing to annotate; body as-is
        const lang = attrs.lang || fence.lang;
        const codeHtml = codeFenceHtml(lang, fence.code);
        const fileHeader = attrs.file
          ? `<div class="annotated-code-file">${escapeHtml(attrs.file)}</div>`
          : "";
        // Annotations are every non-fence body block (the paragraphs after it).
        const notes = rawChildren.filter((b) => b.type !== "code_block");
        const notesHtml = renderBlocks(notes, webRenderer);
        const notesBlock = notesHtml.trim()
          ? `<div class="annotated-code-notes">${notesHtml}</div>`
          : "";
        return (
          `<div class="annotated-code">${fileHeader}` +
          `<div class="annotated-code-panel">${codeHtml}</div>${notesBlock}</div>`
        );
      }
      case "CodeTabs": {
        const tabs = rawChildren.filter(isTab);
        if (tabs.length === 0) {
          // No recognized <Tab> children (e.g. nested past the depth cap) → a
          // visible fallback panel rather than raw escaped tags.
          return `<div class="code-tabs-fallback">${children}</div>`;
        }
        const bar = tabs
          .map((t, i) => {
            const label = t.attrs.label ? escapeHtml(t.attrs.label) : `Tab ${i + 1}`;
            return `<button class="code-tabs-tab${i === 0 ? " is-active" : ""}" type="button">${label}</button>`;
          })
          .join("");
        const panels = tabs
          .map((t, i) => {
            const body = renderBlocks(t.children, webRenderer);
            return `<div class="code-tabs-panel${i === 0 ? " is-active" : ""}">${body}</div>`;
          })
          .join("");
        return (
          `<div class="code-tabs">` +
          `<div class="code-tabs-bar" role="tablist">${bar}</div>` +
          `<div class="code-tabs-panels">${panels}</div></div>`
        );
      }
      case "Tab": {
        // A standalone <Tab> (outside CodeTabs) gets its own labeled panel.
        const label = attrs.label ? escapeHtml(attrs.label) : "Tab";
        return `<div class="code-tab-standalone"><div class="code-tab-label">${label}</div>${children}</div>`;
      }
      case "Fact": {
        // BLOCK form — a `<Fact>` owning its whole line, which the block parser
        // claims before `renderInline` ever sees it. `children` is already rendered
        // block HTML (a <p>), so the mark is a block-level wrapper here; the
        // common inline form is handled in `renderInline`.
        const { chip } = factMarkParts(attrs);
        const v = normalizeFactVerdict(attrs.v);
        const n = factClaimIndex(attrs.n);
        const nAttr = n === null ? "" : ` data-fact="${n}"`;
        if (!children.trim()) return chip;
        return `<div class="fc-mark fc-mark-block fc-mark-${v}"${nAttr}>${children}${chip}</div>`;
      }
      case "Embed": {
        // Server render emits NO iframe: `formatWebHtml` does not know which page
        // it is rendering, so it cannot resolve a relative `src`, and the chat's
        // `sanitizeHtml` has no `iframe` in its tag allowlist anyway. The reader's
        // `enhanceEmbeds` (wiki-embed.ts) resolves the data attributes against
        // the open page and swaps the fallback line for the sandboxed frame; every
        // other surface shows the line itself, which names the file.
        const e = parseEmbedAttrs(attrs);
        if (!e) {
          return `<figure class="embed embed-invalid"><p class="embed-fallback">Embedded page: invalid embed</p></figure>`;
        }
        return (
          `<figure class="embed" data-embed-src="${escapeHtml(e.src)}" data-embed-height="${e.height}" data-embed-title="${escapeHtml(e.title)}">` +
          `<p class="embed-fallback">Embedded page: <code>${escapeHtml(e.src)}</code></p></figure>`
        );
      }
      case "Fold": {
        const title = (attrs.title ?? "").trim();
        // Closed by default; `open="true"` is the one spelling that expands it.
        const openAttr = attrs.open === "true" ? " open" : "";
        // The teaser rides INSIDE <summary> so it shows while the fold is
        // closed; the duplicate-heading test below still compares the title alone.
        const teaser = (attrs.summary ?? "").trim();
        const teaserHtml = teaser ? `<span class="fold-summary">${escapeHtml(teaser)}</span>` : "";
        return (
          `<details class="fold"${openAttr}>` +
          `<summary>${title ? escapeHtml(title) : "Details"}${teaserHtml}</summary>` +
          `<div class="fold-body">${foldBodyHtml(title, children, rawChildren)}</div>` +
          `</details>`
        );
      }
      case "Historic": {
        // Sections the page keeps as history. CSS dims the body; the stamp line
        // stays at full contrast so the reader sees WHY the body is dimmed.
        const since = (attrs.since ?? "").trim();
        const note = (attrs.note ?? "").trim();
        const stamp =
          `<div class="historic-stamp"><span class="historic-mark">↻</span>` +
          (since ? ` <span class="historic-since">${escapeHtml(since)}</span>` : "") +
          (note ? `${since ? " ·" : ""} <span class="historic-note">${escapeHtml(note)}</span>` : "") +
          `</div>`;
        return `<section class="historic">${stamp}<div class="historic-body">${children}</div></section>`;
      }
      case "NextMoves": {
        // Who has the next move: one card per `<Lane>` in a grid. A `blocked`
        // lane is a full-width, quieter strip below the cards: it is the one
        // lane nobody can act on, and taking it out of the grid keeps a
        // four-lane block from leaving one card alone on a row.
        // No lane ⇒ the body renders as plain markdown, with no grid.
        const lanes = nextMovesLanes(rawChildren);
        if (lanes.length === 0) return children;
        // Anything in the block that is not a lane (an intro line) sits above the grid.
        const rest = rawChildren.filter(
          (b) => !(b.type === "component" && b.name === "Lane") && !isBlankTextBlock(b),
        );
        const intro = rest.length ? `<div class="nm-intro">${renderBlocks(rest, webRenderer)}</div>` : "";
        const cards = lanes.filter((l) => l.kind !== "blocked");
        const strips = lanes.filter((l) => l.kind === "blocked");
        const grid = cards.length
          ? `<div class="nm-grid ${laneColsClass(cards.length)}">${cards.map(laneHtml).join("")}</div>`
          : "";
        const stripHtml = strips.length ? `<div class="nm-strips">${strips.map(laneHtml).join("")}</div>` : "";
        return `<section class="next-moves">${intro}${grid}${stripHtml}</section>`;
      }
      case "Lane": {
        // A lane outside `<NextMoves>` renders plain: its label line, then its body.
        const lane = laneFromAttrs(attrs, rawChildren);
        return `<p><strong>${laneLeadText(lane, escapeHtml, escapeHtml)}</strong></p>${children}`;
      }
      case "Query": {
        // One card per query: header (id, question, answer, run date, uses),
        // the reading, the result table, the SQL behind a closed disclosure.
        const q = parseQueryAttrs(attrs);
        // Made unique across the page by `uniqueAnchors`, after rendering.
        const anchor = q.anchor;
        const { sql, body } = splitQuerySql(rawChildren, q.sql !== "");
        const idHtml = !q.id
          ? ""
          : anchor
            ? `<a class="query-id" href="#${anchor}">${escapeHtml(q.id)}</a>`
            : `<span class="query-id">${escapeHtml(q.id)}</span>`;
        // `id` is required: a card without one still renders, and says so.
        const noId = q.id ? "" : `<p class="query-warning">Query without id</p>`;
        const question = q.question ? `<span class="query-question">${renderInline(q.question)}</span>` : "";
        const answer = q.answer ? `<div class="query-answer">${renderInline(q.answer)}</div>` : "";
        const uses = q.uses.map((u) => `<span class="query-use">${escapeHtml(u)}</span>`).join("");
        const meta =
          (q.run ? `<span class="query-run">run ${escapeHtml(q.run)}</span>` : "") +
          (uses ? `<span class="query-uses">uses ${uses}</span>` : "");
        const head =
          `<div class="query-head">${noId}<div class="query-title">${idHtml}${question}</div>${answer}` +
          `${meta ? `<div class="query-meta">${meta}</div>` : ""}</div>`;
        const bodyHtml = body.some((b) => !isBlankTextBlock(b))
          ? `<div class="query-body">${renderBlocks(body, webRenderer)}</div>`
          : "";
        const result = q.csv ? queryResultHtml(q.csv) : "";
        return (
          `<section class="query"${anchor ? ` id="${anchor}"` : ""}>` +
          `${head}${bodyHtml}${result}${querySqlHtml(q.sql, sql)}</section>`
        );
      }
      case "CaseBoard": {
        // Self-closing in the authoring rule; a body, if written, follows the board.
        const board = caseBoardHtml((attrs.src ?? "").trim());
        return rawChildren.some((b) => !isBlankTextBlock(b)) ? `${board}${children}` : board;
      }
      case "DeltaTable":
        return deltaBlockHtml(attrs, rawChildren);
      case "Tldr": {
        // The page's lead box, where the author put it.
        const label = attrs.label?.trim() || "TL;DR";
        return `<section class="tldr"><div class="tldr-label">${escapeHtml(label)}</div><div class="tldr-body">${children}</div></section>`;
      }
      case "Timeline":
        // `gtl-`, not `timeline`/`tl-`: chat's inspector styles those unscoped.
        return `<section class="gtl">${wrappedListsHtml(rawChildren, "gtl-list", timelineItemHtml)}</section>`;
      case "DecisionLog":
        return `<section class="decision-log">${wrappedListsHtml(rawChildren, "dl-list", logItemHtml)}</section>`;
      case "RunChecklist": {
        // A Checklist whose steps carry Command / Expect / Stop-if rows. Every
        // direct-child list is a step list; other blocks render in place.
        const parts = runChecklistBody(rawChildren);
        if (!parts.some((p) => p.kind === "steps")) return children;
        const body = parts
          .map((p) =>
            p.kind === "steps"
              ? checklistHtml(p.list.rows, p.list.ordered, p.list.start, p.list.values, runListHtml, true)
              : renderBlocks([p.block], webRenderer),
          )
          .join("\n");
        return (
          `<section class="run-checklist"><div class="rc-head"><span class="rc-count">${runStepLine(runChecklistSteps(rawChildren))}</span></div>` +
          `${body}</section>`
        );
      }
      case "FactCheck": {
        // Collapsed by DEFAULT — the per-claim evidence is reachable from the
        // chips in the prose, so the appendix that used to add 74 lines to the
        // page now adds one summary line. `open` is deliberately not set.
        return (
          `<details class="fc-block">` +
          `<summary class="fc-strip">${factCheckSummary(attrs)}</summary>` +
          `<div class="fc-block-body">${factCheckSections(rawChildren)}</div>` +
          `</details>`
        );
      }
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  inlineComponent(name, attrs, text) {
    switch (name) {
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = text.trim() ? escapeHtml(text.trim()) : value === "yes" ? "Yes" : "No";
        return `<span class="verdict verdict-${value}">${label}</span>`;
      }
      case "Pill": {
        const tone = normalizePillTone(attrs.tone);
        const cls = tone === "default" ? "pill" : `pill pill-${tone}`;
        return `<span class="${cls}">${escapeHtml(text.trim())}</span>`;
      }
      case "Fact": {
        // Reachable only via a direct call — `renderInline` intercepts `Fact`
        // before delegating here, because its wrapped body is PROSE that must keep
        // running through the inline pipeline. Escaping the body (what every other
        // inline component correctly does with its plain label) would render
        // `**1.32 kg**` as literal asterisks. Chip-only is the safe answer here.
        return factMarkParts(attrs).chip;
      }
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  text: (lines) => lines.map(renderInline).join("\n"),
};

function renderInline(text: string): string {
  const ph = new Placeholders();

  // Inline code FIRST — protect its content from further markdown processing.
  // Parking code before the component scan is what keeps a component tag inside
  // backticks (`` `<Verdict …>x</Verdict>` ``) literal: the parked sentinel
  // contains no `<`, so the scan below never sees the tag and it stays code.
  // Backtick runs pair by CommonMark's exact-N rule (the grammar the fact-check
  // strip uses), so `` `` `<Fact>` `` `` is one span, not two plus a live tag.
  let result = "";
  let cursor = 0;
  for (const r of lineCodeSpanRanges(text)) {
    result += text.slice(cursor, r.start) + ph.add("INLINE", `<code>${escapeHtml(codeSpanContent(text, r))}</code>`);
    cursor = r.end;
  }
  result += text.slice(cursor);

  // Inline components (Verdict, Pill) on the code-shielded text. Their generated
  // HTML must be parked BEFORE the escapeHtml pass below — otherwise the escape
  // would turn the chip markup into visible text. The inner text is escaped
  // inside inlineComponent, so the parked value is safe. A component whose label
  // contained backticks now embeds an INLINE sentinel; the fixed-point restore
  // in Placeholders resolves that nesting.
  result = scanInlineComponents(result)
    .map((seg) => {
      if (seg.kind === "text") return seg.text;
      // `Fact` is the one inline component that wraps PROSE rather than a plain
      // label: only its generated tags are parked, and the body is left in the
      // stream so the bold/link/escape passes below still apply to it. Every other
      // inline component escapes its own label inside `inlineComponent`.
      if (seg.name === "Fact") {
        const { open, close, chip } = factMarkParts(seg.attrs);
        if (!seg.text) return ph.add("INLINECMP", chip);
        return (
          ph.add("INLINECMP", open) +
          seg.text +
          ph.add("INLINECMP", close) +
          ph.add("INLINECMP", chip)
        );
      }
      return ph.add("INLINECMP", webRenderer.inlineComponent(seg.name, seg.attrs, seg.text));
    })
    .join("");

  // Defensive: Claude occasionally outputs Slack-style angle-bracket links;
  // normalize them to markdown form before HTML-escaping (which would otherwise
  // turn the angle brackets into entities and hide the link).
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  // Escape HTML entities — prevents raw HTML in Claude's response from being
  // interpreted as tags. Must happen before generated tags are emitted below.
  result = escapeHtml(result);

  // Markdown links → <a>. Only http/https to prevent javascript: injection,
  // plus an in-page `#fragment` (no quote or space can reach the attribute:
  // the text is escaped above and the class below excludes whitespace).
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    if (/^https?:\/\//.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    }
    if (/^#[^\s#]+$/.test(url)) return `<a href="${url}">${label}</a>`;
    return label;
  });

  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  return ph.restore(result);
}

const BLOCK_TAG = "(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)";
const NL_BEFORE_BLOCK = new RegExp(`\\n+(</?${BLOCK_TAG}[>\\s])`, "g");
const NL_AFTER_BLOCK = new RegExp(`(</${BLOCK_TAG}>|<hr>)\\n+`, "g");

/** Collapse excess blank lines, especially around block-level elements. */
function collapseBlockSpacing(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(NL_BEFORE_BLOCK, "\n$1")
    .replace(NL_AFTER_BLOCK, "$1\n");
}
