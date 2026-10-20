/**
 * The wiki reader's `<Chart>` view: server SVG over the table read by
 * `chart-block.ts`. `renderWikiHtml` passes it to `formatWebHtml` as
 * `chartView`, so this module never ships in the chat bundle.
 *
 * The section keeps the source order: the blocks before the table, the chart
 * chrome, the table, the blocks after it. Every chrome element carries
 * `READER_ONLY_ATTR`, so an Explain selection reads the table and the prose
 * around it as written. In chart mode the table is visually hidden (still
 * read by a screen reader); `wiki-visuals.ts` wires the toggles, which only
 * flip `hidden`, `aria-pressed` and one class on the section.
 */

import {
  chartGateVerdict,
  formatChartNumber,
  formatChartPercent,
  type ChartModel,
  type ChartValue,
  type ChartViewInput,
  type GateRow,
} from "./chart-block.ts";
import type { ChartKind } from "./component-spec.ts";
import { dcGoLink, prStateWord } from "./decision-views.ts";
import { escapeHtml } from "./markdown-core.ts";
import { gateRowState } from "./pr-ledger.ts";
import { DECISION_ID_RE, QUESTION_ID_RE } from "./question.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";

/** The section's class; `cloneBare` strips it, so a peek shows the table only. */
export const CHART_CLASS = "vc";

/** The chrome a peek drops (`PEEK_STRIP_SELECTOR`). */
export const CHART_CHROME_CLASSES = ["vc-head", "vc-plot", "vc-legend", "vc-notes"] as const;

export interface ChartWords {
  chart: string;
  table: string;
  view: string;
  scale: string;
  points: string;
  pctOfTarget: string;
  barToggle: string;
  decided: string;
  /** The gate toggle; the same words as `GATE_BAR_AFTER_HEADERS`. */
  after: string;
  pass: string;
  miss: string;
  holdNotMeasured: string;
  of: string;
  gap: string;
  bar: string;
  kinds: Record<ChartKind, string>;
}

export const CHART_WORDS: Record<QuestionLanguage, ChartWords> = {
  en: {
    chart: "Chart",
    table: "Table",
    view: "View",
    scale: "Scale",
    points: "Points",
    pctOfTarget: "% of target",
    barToggle: "Bar",
    decided: "As decided",
    after: "Bar after",
    pass: "numbers pass",
    miss: "numbers miss",
    holdNotMeasured: "hold not measured",
    of: "of",
    gap: "gap",
    bar: "bar",
    kinds: { gap: "Gap chart", steps: "Steps chart", gate: "Gate chart", funnel: "Funnel chart" },
  },
  no: {
    chart: "Diagram",
    table: "Tabell",
    view: "Visning",
    scale: "Skala",
    points: "Poeng",
    pctOfTarget: "% av mål",
    barToggle: "Krav",
    decided: "Som besluttet",
    after: "Krav etter",
    pass: "tallene holder",
    miss: "tallene holder ikke",
    holdNotMeasured: "hold ikke målt",
    of: "av",
    gap: "gap",
    bar: "krav",
    kinds: { gap: "Gapdiagram", steps: "Trinndiagram", gate: "Kravdiagram", funnel: "Trakt" },
  },
};

const RO = `${READER_ONLY_ATTR}=""`;

interface Variant {
  id: string;
  label: string;
  html: string;
}

/** The whole `<Chart>` section: the view, or for a table that fails its
 *  kind, the table as written under its findings. */
export function chartViewHtml(input: ChartViewInput): string {
  const { model } = input.read;
  const w = CHART_WORDS[input.language];
  const notes = input.read.findings.length
    ? `<ul class="vc-notes" ${RO}>${input.read.findings.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}</ul>`
    : "";
  if (!model) {
    const name = input.captionText.trim() || w.chart;
    return (
      `<section class="${CHART_CLASS} vc-fallback" role="figure" aria-label="${escapeHtml(name)}">` +
      input.beforeHtml +
      notes +
      `<div class="tablewrap">${input.tableHtml}</div>` +
      input.afterHtml +
      `</section>`
    );
  }
  const comma = input.language === "no" || input.read.ctx.decimalComma === true;
  const caption = input.caption.trim();
  const name = input.captionText.trim() || w.kinds[model.kind];
  const plot = plotFor(model, input, w, comma);
  const variants =
    plot.variants.length > 1
      ? group(w[plot.toggle], "vc-variants", plot.variants.map((v, i) => btn("data-vc-variant", v.id, v.label, i === 0)))
      : "";
  const head =
    `<div class="vc-head" ${RO}>` +
    (caption ? `<span class="vc-caption">${escapeHtml(caption)}</span>` : "") +
    `<span class="vc-ctl">${group(w.view, "vc-modes", [btn("data-vc-mode", "chart", w.chart, true), btn("data-vc-mode", "table", w.table, false)])}${variants}</span>` +
    `</div>`;
  const plots = plot.variants
    .map((v, i) => `<div class="vc-plot" ${RO} data-vc-plot="${v.id}"${i === 0 ? "" : " hidden"}>${v.html}</div>`)
    .join("");
  return (
    `<section class="${CHART_CLASS} vc-kind-${model.kind}" role="figure" aria-label="${escapeHtml(name)}">` +
    input.beforeHtml +
    head +
    plots +
    plot.legend +
    notes +
    `<div class="vc-table tablewrap">${input.tableHtml}</div>` +
    input.afterHtml +
    `</section>`
  );
}

function group(label: string, cls: string, buttons: string[]): string {
  return `<span class="vc-group ${cls}" role="group" aria-label="${escapeHtml(label)}">${buttons.join("")}</span>`;
}

function btn(attr: string, value: string, label: string, pressed: boolean): string {
  return `<button type="button" class="vc-btn" ${attr}="${value}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
}

function plotFor(
  model: ChartModel,
  input: ChartViewInput,
  w: ChartWords,
  comma: boolean,
): { toggle: "scale" | "barToggle"; variants: Variant[]; legend: string } {
  switch (model.kind) {
    case "gap": {
      const variants: Variant[] = [{ id: "pts", label: w.points, html: gapRows(model, false, w, comma, input.logIds) }];
      if (model.rows.every((r) => r.target.n > 0)) variants.push({ id: "pct", label: w.pctOfTarget, html: gapRows(model, true, w, comma, input.logIds) });
      const keys: [string, string][] = [
        ["vc-k-value", model.valueName],
        ["vc-k-band", w.gap],
        ["vc-k-target", model.targetName],
      ];
      if (model.markName) keys.push(["vc-k-mark", model.markName]);
      return { toggle: "scale", variants, legend: legendHtml(keys) };
    }
    case "gate": {
      const variants: Variant[] = [{ id: "decided", label: w.decided, html: gateRows(model.rows, false, input, w) }];
      if (model.barAfter) variants.push({ id: "after", label: w.after, html: gateRows(model.rows, true, input, w) });
      const keys: [string, string][] = [
        ["vc-k-value", model.passName],
        ["vc-k-hold", model.holdName],
        ["vc-k-target", w.bar],
      ];
      return { toggle: "barToggle", variants, legend: legendHtml(keys) };
    }
    case "steps":
      return { toggle: "scale", variants: [{ id: "lines", label: "", html: stepsPlot(model, comma, input.captionText.trim() || w.kinds.steps) }], legend: stepsLegend(model) };
    case "funnel":
      return { toggle: "scale", variants: [{ id: "bars", label: "", html: funnelRows(model, w, comma, input.logIds) }], legend: "" };
  }
}

function legendHtml(keys: [string, string][]): string {
  return `<div class="vc-legend" ${RO}>${keys
    .map(([cls, name]) => `<span class="vc-key"><span class="vc-sw ${cls}" aria-hidden="true"></span>${escapeHtml(name)}</span>`)
    .join("")}</div>`;
}

// ── shared pieces ───────────────────────────────────────────────────────────

/** A 0–100 scale over `values`, 0 included, so every bar has a baseline. */
function scale(values: number[]): { at: (v: number) => number; negative: boolean } {
  const lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.04;
  const low = lo < 0 ? lo - pad : lo;
  const high = hi + pad;
  return { at: (v) => round2(((v - low) / (high - low)) * 100), negative: lo < 0 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function svgOpen(title: string): string {
  return `<svg class="vc-svg" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>`;
}

function rect(cls: string, x1: number, x2: number, y: number, h: number): string {
  return `<rect class="${cls}" x="${Math.min(x1, x2)}" y="${y}" width="${round2(Math.abs(x2 - x1))}" height="${h}"/>`;
}

function vline(cls: string, x: number, y1 = 0, y2 = 12): string {
  return `<line class="${cls}" x1="${x}" x2="${x}" y1="${y1}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
}

const track = `<rect class="vc-track" x="0" y="1" width="100" height="10" vector-effect="non-scaling-stroke"/>`;

/** A value cell as shown: the number as written, its `± n`, and its ids; an id
 *  of the decision or question shape links to its log item when the page's
 *  DecisionLog has one (`logIds`), else stays text, so no link goes nowhere. */
export function valueHtml(v: ChartValue, logIds: ReadonlySet<string>): string {
  const linked = (id: string) => (DECISION_ID_RE.test(id) || QUESTION_ID_RE.test(id)) && logIds.has(id);
  const ids = v.ids.length
    ? ` (${v.ids.map((id) => (linked(id) ? dcGoLink(id, escapeHtml(id)) : escapeHtml(id))).join(", ")})`
    : "";
  return `${escapeHtml(v.text)}${v.pm ? ` ± ${escapeHtml(v.pm)}` : ""}${ids}`;
}

function rowHtml(label: string, svg: string, nums: string): string {
  return `<div class="vc-row"><span class="vc-lab">${label}</span><span class="vc-bar">${svg}</span><span class="vc-num">${nums}</span></div>`;
}

// ── gap ─────────────────────────────────────────────────────────────────────

function gapRows(model: Extract<ChartModel, { kind: "gap" }>, pct: boolean, w: ChartWords, comma: boolean, logIds: ReadonlySet<string>): string {
  const value = (v: ChartValue) => valueHtml(v, logIds);
  const val = (v: number, target: number) => (pct ? (v / target) * 100 : v);
  const sc = scale(model.rows.flatMap((r) => [val(r.value.n, r.target.n), val(r.target.n, r.target.n), ...(r.mark ? [val(r.mark.n, r.target.n)] : [])]));
  const rows = model.rows.map((r) => {
    const v = sc.at(val(r.value.n, r.target.n));
    const t = sc.at(val(r.target.n, r.target.n));
    const z = sc.at(0);
    const title = pct
      ? `${r.label}: ${formatChartPercent((r.value.n / r.target.n) * 100, comma)} ${w.of} ${r.target.text}`
      : `${r.label}: ${r.value.text} → ${r.target.text}`;
    const svg =
      svgOpen(title) +
      track +
      // The band goes over the bar: a value past its target puts the band inside the bar.
      rect("vc-value", z, v, 2, 8) +
      rect("vc-band", v, t, 4, 4) +
      (sc.negative ? vline("vc-zero", z) : "") +
      (r.mark ? vline("vc-mark", sc.at(val(r.mark.n, r.target.n)), 1, 11) : "") +
      vline("vc-target", t) +
      `</svg>`;
    const nums = pct
      ? `${formatChartPercent((r.value.n / r.target.n) * 100, comma)} ${escapeHtml(w.of)} ${value(r.target)}`
      : `${value(r.value)} → ${value(r.target)}` +
        (r.gapText ? ` <span class="vc-gap">${escapeHtml(w.gap)} ${escapeHtml(r.gapText)}</span>` : "");
    return rowHtml(escapeHtml(r.label), svg, nums);
  });
  return `<div class="vc-rows">${rows.join("")}</div>`;
}

// ── gate ────────────────────────────────────────────────────────────────────

function gateRows(rows: GateRow[], after: boolean, input: ChartViewInput, w: ChartWords): string {
  const barOf = (r: GateRow) => (after && r.barAfter ? r.barAfter : r.bar);
  const sc = scale(rows.flatMap((r) => [r.pass.n, ...(r.hold ? [r.hold.n] : []), barOf(r).n]));
  const value = (v: ChartValue) => valueHtml(v, input.logIds);
  const html = rows.map((r) => {
    const bar = barOf(r);
    const verdict = chartGateVerdict(r.pass, r.hold, bar);
    const z = sc.at(0);
    const p = sc.at(r.pass.n);
    const b = sc.at(bar.n);
    const verdictText = verdict.pass
      ? w.pass
      : `${w.miss}: ${verdict.reason === "hold-not-measured" ? w.holdNotMeasured : `${verdict.value} < ${verdict.bar}`}`;
    const svg =
      svgOpen(`${r.label}: ${verdictText}`) +
      track +
      rect("vc-value", z, p, 1.5, 4.5) +
      (r.hold ? `<rect class="vc-hold" x="${Math.min(z, sc.at(r.hold.n))}" y="6.5" width="${round2(Math.abs(sc.at(r.hold.n) - z))}" height="4" vector-effect="non-scaling-stroke"/>` : "") +
      (sc.negative ? vline("vc-zero", z) : "") +
      vline("vc-target", b) +
      `</svg>`;
    const state = r.pr && input.ledgerRows ? gateRowState(r.pr, input.ledgerRows) : undefined;
    const word = state ? prStateWord(state, input.language) : "";
    const n = r.pr?.slate ?? r.pr?.link;
    const pill = state
      ? ` <span class="dc-pr dc-s-${state} vc-pill" role="img" title="PR ${n} · ${escapeHtml(word)}" aria-label="PR ${n} · ${escapeHtml(word)}">${escapeHtml(word)}</span>`
      : "";
    const nums =
      `${value(r.pass)} · ${r.hold ? value(r.hold) : "—"} · ${escapeHtml(w.bar)} ${value(bar)}` +
      `<span class="vc-verdict ${verdict.pass ? "vc-ok" : "vc-miss"}">${escapeHtml(verdictText)}</span>`;
    return rowHtml(`${escapeHtml(r.label)}${pill}`, svg, nums);
  });
  return `<div class="vc-rows">${html.join("")}</div>`;
}

// ── steps ───────────────────────────────────────────────────────────────────

/** Series looks: a token colour and a dash, so a series reads beyond hue. */
export const STEPS_SERIES_LOOKS = 6;

/** At most this many x labels; the rest are thinned, each kept in a title. */
export const STEPS_X_LABELS_MAX = 8;

/** Decimals that tell the two extremes apart: the data's own, more when the
 *  range is under 1, at most 4. */
export function stepsAxisDecimals(lo: number, hi: number, dataDecimals: number): number {
  const range = Math.abs(hi - lo);
  const need = range > 0 && range < 1 ? Math.ceil(-Math.log10(range)) : 0;
  return Math.min(4, Math.max(dataDecimals, need));
}

/** The step indexes that get an x label: the first, the last and an even
 *  spread between, at most `STEPS_X_LABELS_MAX`. */
export function stepsLabelIndexes(n: number): number[] {
  if (n <= STEPS_X_LABELS_MAX) return Array.from({ length: n }, (_, i) => i);
  const k = Math.ceil((n - 1) / (STEPS_X_LABELS_MAX - 1));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += k) out.push(i);
  if (n - 1 - out[out.length - 1]! < k / 2) out.pop();
  out.push(n - 1);
  return out;
}

const LABEL_SEP = /[\s\-–—_/:·,]/u;

/** The step names split for the x axis: the words every name shares at its
 *  start (`head`) and end (`tail`), cut only at a separator and only when
 *  every name keeps some text, and each name without them (`parts`). Long
 *  names that differ in the middle otherwise all ellipsize to the same text. */
function stepsLabelParts(names: readonly string[]): { head: string; tail: string; parts: string[] } {
  const cps = names.map((n) => [...n]);
  if (cps.length < 2) return { head: "", tail: "", parts: [...names] };
  const shared = (at: (c: string[], k: number) => string | undefined) => {
    let k = 0;
    while (cps.every((c) => k < c.length && at(c, k) === at(cps[0]!, k))) k++;
    return k;
  };
  const keeps = (p: number, t: number) => cps.every((c) => c.slice(p, c.length - t).join("").trim() !== "");
  // The head ends on a separator, the tail starts on one.
  let p = shared((c, k) => c[k]);
  while (p > 0 && !LABEL_SEP.test(cps[0]![p - 1]!)) p--;
  if (!keeps(p, 0)) p = 0;
  let t = shared((c, k) => (c.length - 1 - k >= p ? c[c.length - 1 - k] : undefined));
  while (t > 0 && !LABEL_SEP.test(cps[0]![cps[0]!.length - t]!)) t--;
  if (!keeps(p, t)) t = 0;
  const trim = (x: string) => x.replace(/^[\s\-–—_/:·,]+|[\s\-–—_/:·,]+$/gu, "");
  return {
    head: trim(cps[0]!.slice(0, p).join("")),
    tail: trim(cps[0]!.slice(cps[0]!.length - t).join("")),
    parts: cps.map((c) => c.slice(p, c.length - t).join("").trim()),
  };
}

function stepsPlot(model: Extract<ChartModel, { kind: "steps" }>, comma: boolean, title: string): string {
  const W = 300;
  const H = 120;
  const n = model.steps.length;
  const xPct = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const refs = model.normalize ? [100] : model.series.flatMap((s) => (s.ref === null ? [] : [s.ref]));
  const plotted = model.series.flatMap((s) => s.points.filter((p): p is number => p !== null));
  const lo = Math.min(...plotted);
  const hi = Math.max(...plotted);
  const all = [...plotted, ...refs];
  let top = Math.max(...all);
  let bottom = Math.min(...all);
  if (top === bottom) {
    top += 1;
    bottom -= 1;
  }
  const pad = (top - bottom) * 0.06;
  top += pad;
  bottom -= pad;
  const yAt = (v: number) => round2(H - ((v - bottom) / (top - bottom)) * H);
  const lines = model.series.map((s, k) => {
    const pts = s.points.flatMap((p, i) => (p === null ? [] : [`${round2((xPct(i) / 100) * W)},${yAt(p)}`]));
    const first = s.points.findIndex((p) => p !== null);
    const shape =
      pts.length > 1
        ? `<polyline class="vc-line" points="${pts.join(" ")}" vector-effect="non-scaling-stroke"/>`
        : `<line class="vc-line" x1="${round2((xPct(first) / 100) * W) - 4}" x2="${round2((xPct(first) / 100) * W) + 4}" y1="${yAt(s.points[first]!)}" y2="${yAt(s.points[first]!)}" vector-effect="non-scaling-stroke"/>`;
    const ref = !model.normalize && s.ref !== null ? hline("vc-ref", yAt(s.ref), W) : "";
    return `<g class="vc-s${k % STEPS_SERIES_LOOKS}">${ref}${shape}</g>`;
  });
  const refLine = model.normalize ? hline("vc-ref vc-ref-100", yAt(100), W) : "";
  const unit = model.normalize ? "%" : "";
  const d = stepsAxisDecimals(lo, hi, model.normalize ? 0 : model.decimals);
  const yLabel = (v: number) =>
    `<span class="vc-ylab" style="top:${round2((yAt(v) / H) * 100)}%">${formatChartNumber(v, d, comma)}${unit}</span>`;
  const shown = stepsLabelIndexes(n);
  const names = stepsLabelParts(model.steps);
  const xLabels = shown
    .map((i) => {
      const edge = n > 1 && i === 0 ? " vc-xfirst" : n > 1 && i === n - 1 ? " vc-xlast" : "";
      // An edge label grows one way only: half the width keeps it off its neighbour.
      const width = (edge ? 50 : 100) / shown.length;
      return `<span class="vc-xlab${edge}" style="left:${round2(xPct(i))}%;max-width:${round2(width)}%" title="${escapeHtml(model.steps[i]!)}">${escapeHtml(names.parts[i]!)}</span>`;
    })
    .join("");
  const shared = names.head || names.tail ? [names.head, "…", names.tail].filter(Boolean).join(" ") : "";
  return (
    `<div class="vc-steps">` +
    `<div class="vc-yaxis">${yLabel(hi)}${lo === hi ? "" : yLabel(lo)}</div>` +
    `<div class="vc-area"><svg class="vc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${refLine}${lines.join("")}</svg></div>` +
    `<div class="vc-xaxis">${xLabels}</div>` +
    (shared ? `<div class="vc-xcap">${escapeHtml(shared)}</div>` : "") +
    `</div>`
  );
}

function hline(cls: string, y: number, W: number): string {
  return `<line class="${cls}" x1="0" x2="${W}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`;
}

function stepsLegend(model: Extract<ChartModel, { kind: "steps" }>): string {
  const keys = model.series
    .map(
      (s, k) =>
        `<span class="vc-key vc-s${k % STEPS_SERIES_LOOKS}"><svg class="vc-sw-line" viewBox="0 0 20 4" aria-hidden="true"><line class="vc-line" x1="0" x2="20" y1="2" y2="2"/></svg>${escapeHtml(s.name)}</span>`,
    )
    .join("");
  const ref = model.refLabel ? `<span class="vc-key"><span class="vc-sw vc-k-ref" aria-hidden="true"></span>${escapeHtml(model.refLabel)}${model.normalize ? " = 100%" : ""}</span>` : "";
  return `<div class="vc-legend" ${RO}>${keys}${ref}</div>`;
}

// ── funnel ──────────────────────────────────────────────────────────────────

function funnelRows(model: Extract<ChartModel, { kind: "funnel" }>, w: ChartWords, comma: boolean, logIds: ReadonlySet<string>): string {
  const value = (v: ChartValue) => valueHtml(v, logIds);
  const rows = model.rows.map((r) => {
    const width = r.of === null ? 100 : r.share === null ? 0 : Math.max(0, Math.min(100, r.share));
    const pct = r.of === null ? "" : r.share === null ? "—" : formatChartPercent(r.share, comma);
    const svg = svgOpen(r.of === null ? `${r.label}: ${r.value.text}` : `${r.label}: ${r.value.text} ${w.of} ${r.of.text} (${pct})`) + track + rect("vc-value", 0, width, 2, 8) + `</svg>`;
    const nums = r.of === null ? value(r.value) : `${value(r.value)} ${escapeHtml(w.of)} ${escapeHtml(r.of.text)} <span class="vc-pct">(${pct})</span>`;
    return rowHtml(`<span class="vc-d${Math.min(r.depth, 4)}">${escapeHtml(r.label)}</span>`, svg, nums);
  });
  return `<div class="vc-rows">${rows.join("")}</div>`;
}
