/**
 * The reader's `<Chart>` view (MDX visual components PR 3, O1: server-side
 * SVG). `formatWebHtml` calls it only on the reader's page render
 * (`views: true`); every other caller prints the table as written.
 *
 * The section holds the table as written in `.vc-table` and the chart chrome
 * beside it. Every chrome element carries `READER_ONLY_ATTR`, so an Explain or
 * fact-check selection and a fold size leave it out, and `cloneBare` strips
 * its classes from a peek. The toggles (Chart/Table, the scale, the gate's
 * bar, a steps series) are wired by `wiki-visuals.ts` on the client; the
 * server renders every variant and the client shows one.
 *
 * Pure: `web-format.ts` ships in the chat bundle, so this imports no server
 * module. Colours are CSS classes over theme tokens (`chartCss`), never
 * literals.
 */

import type { CellNum, ChartFinding, ChartModel, ChartRead, GateRow } from "./chart-block.ts";
import { gateVerdict } from "./chart-block.ts";
import type { NumberContext } from "./cell-number.ts";
import { escapeHtml } from "./markdown-core.ts";
import type { PrState } from "./pr-ledger.ts";
import { anchorSlug } from "./query-block.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";

/** The chart's root class; `wiki-visuals.ts` finds sections by it. */
export const CHART_CLASS = "vc-chart";

/** Chrome classes a peek strips (`cloneBare`, `wiki-ref-links.ts`). The table
 *  (`.vc-table`) is not among them: a peek shows the table only. */
export const CHART_CHROME_CLASSES = ["vc-caption", "vc-ctl", "vc-plot", "vc-legend", "vc-finding"] as const;

const RO = `${READER_ONLY_ATTR}=""`;

const WORDS: Record<QuestionLanguage, Record<string, string>> = {
  en: {
    chart: "Chart",
    table: "Table",
    points: "Points",
    pct: "% of target",
    decided: "As decided",
    after: "Bar after",
    pass: "numbers pass",
    miss: "numbers miss",
    of: "of",
    bar: "bar",
    gap: "gap",
    target: "target",
    view: "View",
    scale: "Scale",
    barToggle: "Bar",
    series: "Series",
    chartLabel: "Chart",
    noKind: 'needs kind="gap|steps|gate|funnel"',
  },
  no: {
    chart: "Diagram",
    table: "Tabell",
    points: "Poeng",
    pct: "% av mål",
    decided: "Som besluttet",
    after: "Senere krav",
    pass: "tallene holder",
    miss: "tallene holder ikke",
    of: "av",
    bar: "krav",
    gap: "gap",
    target: "mål",
    view: "Visning",
    scale: "Skala",
    barToggle: "Krav",
    series: "Serier",
    chartLabel: "Diagram",
    noKind: 'trenger kind="gap|steps|gate|funnel"',
  },
};

/** What the view needs; `table` cells are VISIBLE text (`chart-block.ts`). */
export interface ChartViewInput {
  read: ChartRead;
  caption: string;
  /** The `kind=` value as written, for the finding a missing kind gets. */
  kindKnown: boolean;
  /** The rendered table (`<table>…`), empty when the body holds none. */
  tableHtml: string;
  /** The rest of the body, rendered, shown above the chart. */
  introHtml: string;
  language: QuestionLanguage;
  /** PR number → ledger state, for the gate kind; null without a ledger. */
  prStates: ReadonlyMap<number, PrState> | null;
  /** The state's word in the wiki's language (`prStateWord`). */
  stateWord: (state: PrState, language: QuestionLanguage) => string;
}

/** The whole `<Chart>` section. A chart whose table fails its kind renders the
 *  table with the findings, never an empty chart. */
export function chartViewHtml(input: ChartViewInput): string {
  const w = WORDS[input.language];
  const { read } = input;
  const caption = input.caption.trim() ? `<div class="vc-caption" ${RO}>${escapeHtml(input.caption.trim())}</div>` : "";
  const intro = input.introHtml.trim() ? `<div class="vc-intro">${input.introHtml}</div>` : "";
  const table = input.tableHtml ? `<div class="vc-table tablewrap">${input.tableHtml}</div>` : "";
  const notes: ChartFinding[] = input.kindKnown ? read.findings : [{ message: w.noKind!, fatal: true }];
  const findings = notes.length
    ? `<ul class="vc-finding" ${RO}>${notes
        .map((f) => `<li class="${f.fatal ? "vc-fatal" : "vc-warn"}">${escapeHtml(w.chartLabel!)}: ${escapeHtml(f.message)}</li>`)
        .join("")}</ul>`
    : "";
  const model = read.model;
  if (!model || !input.tableHtml) {
    return `<section class="${CHART_CLASS} vc-fallback">${caption}${intro}${findings}${table}</section>`;
  }
  const body = plotFor(model, read.ctx, input);
  const ctl =
    `<div class="vc-ctl" ${RO}>` +
    group(w.view!, [btn("data-vc-mode", "chart", w.chart!, true), btn("data-vc-mode", "table", w.table!, false)]) +
    (body.variants.length > 1 ? group(body.variantLabel, body.variants.map((v, i) => btn("data-vc-variant", v.id, v.label, i === 0))) : "") +
    `</div>`;
  const plots = body.variants
    .map((v, i) => `<div class="vc-plot" ${RO} data-vc-variant="${v.id}"${i === 0 ? "" : " hidden"}>${v.html}</div>`)
    .join("");
  return `<section class="${CHART_CLASS} vc-${model.kind} vc-has-plot">${caption}${intro}${ctl}${plots}${body.legend}${findings}${table}</section>`;
}

function group(label: string, buttons: string[]): string {
  return `<span class="vc-group" role="group" aria-label="${escapeHtml(label)}">${buttons.join("")}</span>`;
}

function btn(attr: string, value: string, label: string, pressed: boolean): string {
  return `<button type="button" class="vc-btn" ${attr}="${value}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
}

interface Plot {
  variantLabel: string;
  variants: { id: string; label: string; html: string }[];
  legend: string;
}

function plotFor(model: ChartModel, ctx: NumberContext, input: ChartViewInput): Plot {
  const w = WORDS[input.language];
  switch (model.kind) {
    case "gap": {
      const pctOk = model.rows.every((r) => r.target.n > 0);
      const variants = [{ id: "pts", label: w.points!, html: gapRows(model, ctx, false, w) }];
      if (pctOk) variants.push({ id: "pct", label: w.pct!, html: gapRows(model, ctx, true, w) });
      const legend = legendHtml([
        ["vc-k-value", model.valueName],
        ["vc-k-target", model.targetName],
        ...(model.markName ? ([["vc-k-mark", model.markName]] as [string, string][]) : []),
      ]);
      return { variantLabel: w.scale!, variants, legend };
    }
    case "gate": {
      const variants = [{ id: "decided", label: w.decided!, html: gateRows(model.rows, false, ctx, input) }];
      if (model.barAfterName) variants.push({ id: "after", label: w.after!, html: gateRows(model.rows, true, ctx, input) });
      const legend = legendHtml([
        ["vc-k-value", model.passName],
        ...(model.holdName ? ([["vc-k-hold", model.holdName]] as [string, string][]) : []),
        ["vc-k-target", w.bar!],
      ]);
      return { variantLabel: w.barToggle!, variants, legend };
    }
    case "steps":
      return { variantLabel: "", variants: [{ id: "lines", label: "", html: stepsSvg(model, ctx) }], legend: stepsLegend(model, w) };
    case "funnel":
      return { variantLabel: "", variants: [{ id: "bars", label: "", html: funnelRows(model, ctx, w) }], legend: "" };
  }
}

function legendHtml(keys: [string, string][]): string {
  return `<div class="vc-legend" ${RO}>${keys
    .map(([cls, name]) => `<span class="vc-key"><span class="vc-sw ${cls}"></span>${escapeHtml(name)}</span>`)
    .join("")}</div>`;
}

// ── scales and numbers ──────────────────────────────────────────────────────

/** A linear 0–100 scale over `values`, always including 0. */
function scale(values: number[]): (v: number) => number {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.04;
  if (lo < 0) lo -= pad;
  hi += pad;
  return (v) => round2(((v - lo) / (hi - lo)) * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A computed number in the table's own spelling: a decimal comma when the
 *  table writes one, U+2212 for a minus. */
function fmt(n: number, ctx: NumberContext, decimals = 1): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(decimals).replace(/\.?0+$/, "");
  const signed = s.startsWith("-") ? `−${s.slice(1)}` : s;
  return ctx.decimalComma ? signed.replace(".", ",") : signed;
}

function pctOf(v: number, of: number, ctx: NumberContext): string {
  return `${fmt((v / of) * 100, ctx)}%`;
}

// ── gap ─────────────────────────────────────────────────────────────────────

function gapRows(model: Extract<ChartModel, { kind: "gap" }>, ctx: NumberContext, pct: boolean, w: Record<string, string>): string {
  const val = (n: number, target: number) => (pct ? (n / target) * 100 : n);
  const all = model.rows.flatMap((r) => [
    val(r.value.n, r.target.n),
    val(r.target.n, r.target.n),
    ...(r.mark ? [val(r.mark.n, r.target.n)] : []),
  ]);
  const x = scale(all);
  const rows = model.rows.map((r) => {
    const v = x(val(r.value.n, r.target.n));
    const t = x(val(r.target.n, r.target.n));
    const z = x(0);
    const m = r.mark ? x(val(r.mark.n, r.target.n)) : null;
    const svg =
      svgOpen("0 0 100 12") +
      `<rect class="vc-track" x="0" y="3" width="100" height="6"/>` +
      `<rect class="vc-gapband" x="${Math.min(v, t)}" y="3" width="${round2(Math.abs(t - v))}" height="6"/>` +
      `<rect class="vc-value" x="${Math.min(z, v)}" y="3" width="${round2(Math.abs(v - z))}" height="6"/>` +
      (m === null ? "" : vline("vc-mark", m, 1, 11)) +
      vline("vc-target", t, 0, 12) +
      `</svg>`;
    const nums = pct
      ? `${pctOf(r.value.n, r.target.n, ctx)} ${w.of} ${escapeHtml(r.target.text)}`
      : `${escapeHtml(r.value.text)} → ${escapeHtml(r.target.text)}` +
        (r.gapText ? ` <span class="vc-gap">${escapeHtml(w.gap!)} ${escapeHtml(r.gapText)}</span>` : "");
    return rowHtml(escapeHtml(r.label), svg, nums);
  });
  return `<div class="vc-rows">${rows.join("")}</div>`;
}

function rowHtml(label: string, svg: string, nums: string, extra = ""): string {
  return `<div class="vc-row"><span class="vc-lab">${label}${extra}</span><span class="vc-bar">${svg}</span><span class="vc-num">${nums}</span></div>`;
}

function svgOpen(viewBox: string): string {
  return `<svg class="vc-svg" viewBox="${viewBox}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`;
}

function vline(cls: string, x: number, y1: number, y2: number): string {
  return `<line class="${cls}" x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
}

// ── gate ────────────────────────────────────────────────────────────────────

/** `(D17)` after a bar's number: each decision id becomes a link to its
 *  DecisionLog item (`retargetViewLinks` points it at the final anchor). */
function idLinks(rest: string): string {
  return escapeHtml(rest).replace(
    /\b([A-Z]{1,3}\d{1,4})\b/g,
    (_m, id: string) => `<a class="dc-go" href="#${anchorSlug(id)}" data-dc-ref="${id}">${id}</a>`,
  );
}

function gateRows(rows: GateRow[], after: boolean, ctx: NumberContext, input: ChartViewInput): string {
  const w = WORDS[input.language];
  const barOf = (r: GateRow): { bar: CellNum; rest: string } =>
    after && r.barAfter ? { bar: r.barAfter, rest: r.barAfterRest } : { bar: r.bar, rest: r.barRest };
  const x = scale(rows.flatMap((r) => [r.pass.n, ...(r.hold ? [r.hold.n] : []), r.bar.n, ...(r.barAfter ? [r.barAfter.n] : [])]));
  const html = rows.map((r) => {
    const { bar, rest } = barOf(r);
    const verdict = gateVerdict(r.pass, r.hold, bar);
    const z = x(0);
    const p = x(r.pass.n);
    const h = r.hold ? x(r.hold.n) : null;
    const b = x(bar.n);
    const svg =
      svgOpen("0 0 100 12") +
      `<rect class="vc-track" x="0" y="1" width="100" height="10"/>` +
      `<rect class="vc-value" x="${Math.min(z, p)}" y="1" width="${round2(Math.abs(p - z))}" height="${h === null ? 10 : 5}"/>` +
      (h === null ? "" : `<rect class="vc-hold" x="${Math.min(z, h)}" y="6" width="${round2(Math.abs(h - z))}" height="5"/>`) +
      vline("vc-target", b, 0, 12) +
      `</svg>`;
    const state = r.pr !== null ? input.prStates?.get(r.pr) : undefined;
    const pill = state ? ` <span class="vc-state vc-st-${state}">${escapeHtml(input.stateWord(state, input.language))}</span>` : "";
    const verdictHtml = verdict.pass
      ? `<span class="vc-verdict vc-ok">${escapeHtml(w.pass!)}</span>`
      : `<span class="vc-verdict vc-miss">${escapeHtml(w.miss!)}: ${escapeHtml(verdict.miss!)}</span>`;
    const nums =
      `${escapeHtml(r.pass.text)}${r.hold ? ` · ${escapeHtml(r.hold.text)}` : ""} · ${escapeHtml(w.bar!)} ${escapeHtml(bar.text)}` +
      (rest ? ` ${idLinks(rest)}` : "");
    return rowHtml(escapeHtml(r.label), svg, `${nums}<br>${verdictHtml}`, pill);
  });
  return `<div class="vc-rows">${html.join("")}</div>`;
}

// ── steps ───────────────────────────────────────────────────────────────────

const SERIES_CLASSES = 6;

function stepsSvg(model: Extract<ChartModel, { kind: "steps" }>, ctx: NumberContext): string {
  const W = 300;
  const H = 120;
  const n = model.steps.length;
  const xAt = (i: number) => (n === 1 ? W / 2 : round2((i / (n - 1)) * W));
  const norm = (v: number, ref: CellNum | null) => (model.normalize && ref ? (v / ref.n) * 100 : v);
  // Empty cells carry the last value forward; leading empties draw nothing.
  const series = model.series.map((s) => {
    let last: number | null = null;
    const pts = s.values.map((c) => {
      if (c) last = norm(c.n, s.ref);
      return last;
    });
    return { s, pts };
  });
  const refLines = model.series.map((s, k) => {
    const lines: number[] = [];
    if (model.normalize) lines.push(100);
    else if (s.ref) lines.push(s.ref.n);
    for (const e of model.extras) {
      const c = e.values[k];
      if (c) lines.push(norm(c.n, s.ref));
    }
    return lines;
  });
  const all = [...series.flatMap((x) => x.pts.filter((p): p is number => p !== null)), ...refLines.flat()];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.06;
  const top = hi + pad;
  const bottom = lo - pad;
  const yAt = (v: number) => round2(H - ((v - bottom) / (top - bottom)) * H);
  const groups = series.map(({ pts }, k) => {
    const coords = pts.flatMap((p, i) => (p === null ? [] : [`${xAt(i)},${yAt(p)}`]));
    const line =
      coords.length > 1
        ? `<polyline class="vc-line" points="${coords.join(" ")}" vector-effect="non-scaling-stroke"/>`
        : coords.length === 1
          ? `<line class="vc-line" x1="${xAt(pts.findIndex((p) => p !== null)) - 2}" x2="${xAt(pts.findIndex((p) => p !== null)) + 2}" y1="${coords[0]!.split(",")[1]}" y2="${coords[0]!.split(",")[1]}" vector-effect="non-scaling-stroke"/>`
          : "";
    const refs = refLines[k]!.map(
      (v) => `<line class="vc-ref" x1="0" x2="${W}" y1="${yAt(v)}" y2="${yAt(v)}" vector-effect="non-scaling-stroke"/>`,
    ).join("");
    return `<g class="vc-series vc-s${k % SERIES_CLASSES}" data-vc-series="${k}">${refs}${line}</g>`;
  });
  const unit = model.normalize ? "%" : "";
  const axis = `<div class="vc-yaxis"><span>${fmt(hi, ctx)}${unit}</span><span>${fmt(lo, ctx)}${unit}</span></div>`;
  const xs = `<div class="vc-xaxis">${model.steps.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</div>`;
  return `<div class="vc-steps-grid">${axis}<div class="vc-area">${svgOpen(`0 0 ${W} ${H}`)}${groups.join("")}</svg></div>${xs}</div>`;
}

function stepsLegend(model: Extract<ChartModel, { kind: "steps" }>, w: Record<string, string>): string {
  const keys = model.series
    .map(
      (s, k) =>
        `<button type="button" class="vc-key vc-btn vc-s${k % SERIES_CLASSES}" data-vc-series="${k}" aria-pressed="true"><span class="vc-sw vc-k-line"></span>${escapeHtml(s.name)}</button>`,
    )
    .join("");
  const ref = model.refLabel ? `<span class="vc-key"><span class="vc-sw vc-k-ref"></span>${escapeHtml(model.refLabel)}</span>` : "";
  return `<div class="vc-legend" ${RO} role="group" aria-label="${escapeHtml(w.series!)}">${keys}${ref}</div>`;
}

// ── funnel ──────────────────────────────────────────────────────────────────

function funnelRows(model: Extract<ChartModel, { kind: "funnel" }>, ctx: NumberContext, w: Record<string, string>): string {
  const rows = model.rows.map((r) => {
    const share = r.of && r.of.n > 0 ? Math.max(0, Math.min(100, (r.value.n / r.of.n) * 100)) : 100;
    const svg = svgOpen("0 0 100 12") + `<rect class="vc-track" x="0" y="2" width="100" height="8"/><rect class="vc-value" x="0" y="2" width="${round2(share)}" height="8"/></svg>`;
    const nums = r.of
      ? `${escapeHtml(r.value.text)} ${escapeHtml(w.of!)} ${escapeHtml(r.of.text)} <span class="vc-pct">(${pctOf(r.value.n, r.of.n, ctx)})</span>`
      : escapeHtml(r.value.text);
    return rowHtml(`<span class="vc-d${Math.min(r.depth, 4)}">${escapeHtml(r.label)}</span>`, svg, nums);
  });
  return `<div class="vc-rows">${rows.join("")}</div>`;
}
