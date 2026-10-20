/**
 * The reader's two decision visuals: the chain view (question → decision →
 * PRs, one row per decision) and the PR strip (one square per PR over the
 * drawing ledgers, grouped by the decision its row cites).
 *
 * Pure and server-free: `formatWebHtml` calls it with `views: true` only, and
 * the chat bundle carries this module without ever calling it. The HTML has
 * no `id` attribute (the anchor passes would rename a DecisionLog item), every
 * view carries `data-reader-only`, and a node's link is retargeted to its
 * item's final anchor by the caller (`DC_GO_RE`).
 */

import type { Block } from "./markdown-ast.ts";
import { escapeHtml } from "./markdown-core.ts";
import { anchorSlug } from "./query-block.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { DC_VIEW_CLASS, READER_ONLY_ATTR } from "./reader-lens.ts";
import { analyzeDecisionChains, CHAIN_LABELS, type ChainAnalysis, type DecisionChain } from "./decision-chain.ts";
import { firstRowPerPr, pageLedgers, type Ledger, type LedgerRow, type PrState } from "./pr-ledger.ts";
import { visibleText } from "./report-top.ts";

/** The chain view draws at this many chains (plan O2). */
export const CHAIN_VIEW_MIN = 3;
/** The strip draws at this many squares (one per PR) over the drawing
 *  ledgers (plan O2). */
export const STRIP_VIEW_MIN = 4;

/** A node's go-to link, as the caller retargets it after the anchor passes. */
export const DC_GO_RE = /<a class="dc-go" href="#[^"]*" data-dc-ref="([^"]*)">/g;

export interface PageDecisionData {
  ledgers: Ledger[];
  analysis: ChainAnalysis;
}

/** The whole-page pre-pass: the ledgers and the chains read from them. */
export function pageDecisionData(
  blocks: Block[],
  opts: { linkText?: (i: number) => string; proposed?: boolean } = {},
): PageDecisionData {
  const { linkText, proposed = false } = opts;
  const ledgers = pageLedgers(blocks, proposed);
  return {
    ledgers,
    analysis: analyzeDecisionChains(blocks, ledgers, linkText ? { linkText } : {}),
  };
}

const STATE_WORDS: Record<QuestionLanguage, Record<PrState, string>> = {
  en: {
    merged: "merged",
    dropped: "dropped",
    closed: "closed",
    open: "open",
    measurement: "measurement",
    "not-started": "not started",
    blocked: "blocked",
    optional: "optional",
    planned: "planned",
    unknown: "unknown",
  },
  no: {
    merged: "merget",
    dropped: "forkastet",
    closed: "lukket",
    open: "åpen",
    measurement: "måling",
    "not-started": "ikke startet",
    blocked: "blokkert",
    optional: "valgfri",
    planned: "planlagt",
    unknown: "ukjent",
  },
};

/** The states `decisionViewsCss` draws alike, one group per look; the strip's
 *  legend lists each look once. A unit test holds the CSS to these groups. */
export const STATE_LOOKS: readonly (readonly PrState[])[] = [
  ["merged"],
  ["open", "measurement"],
  ["planned", "not-started", "optional"],
  ["blocked"],
  ["dropped", "closed"],
  ["unknown"],
];

const NO_DECISION: Record<QuestionLanguage, string> = { en: "No decision", no: "Uten beslutning" };
const GO_TO: Record<QuestionLanguage, string> = { en: "Go to", no: "Gå til" };

/** The state's word in the wiki's language. */
export function prStateWord(state: PrState, language: QuestionLanguage): string {
  return STATE_WORDS[language][state];
}

// One shared `name`: opening a node closes the open one, so a row's popover
// band holds one popover.
function node(id: string, kind: "q" | "d", label: string, language: QuestionLanguage, struck = false): string {
  const text = escapeHtml(label);
  return (
    `<details class="dc-node dc-${kind}${struck ? " dc-struck" : ""}" name="dc-chain"><summary>${escapeHtml(id)}</summary>` +
    `<div class="dc-pop">${struck ? `<s>${text}</s>` : text} ` +
    `<a class="dc-go" href="#${anchorSlug(id)}" data-dc-ref="${escapeHtml(id)}">${GO_TO[language]} ${escapeHtml(id)} ↓</a></div></details>`
  );
}

function chainRow(c: DecisionChain, language: QuestionLanguage): string {
  const words = CHAIN_LABELS[language];
  const qs = c.questions.map((q) => node(q.id, "q", q.label, language)).join("");
  const reversed = c.reversed
    ? `<span class="dc-snudd">${escapeHtml(words.reversed)}</span>` +
      (c.reversed.by ? `<span class="dc-by">${escapeHtml(words.supersededBy)} ${escapeHtml(c.reversed.by)}</span>` : "")
    : "";
  const outs = c.outputs
    .map((o) => {
      const state = o.state ?? "unknown";
      const word = prStateWord(state, language);
      const name = `${o.noun} ${o.number}`;
      // The state is a colour; the accessible name says it too (as `.dc-pr`).
      const title = escapeHtml(`${name} · ${word}`);
      return `<span class="dc-out dc-s-${state}${o.source === "prose" ? " dc-prose" : ""}" role="img" title="${title}" aria-label="${title}">${escapeHtml(name)}</span>`;
    })
    .join("");
  // Every cell sits on a fixed column of the shared grid (`decisionViewsCss`),
  // so a row leaves out the cells it has nothing for instead of drawing them empty.
  return (
    `<div class="dc-row${c.reversed ? " dc-reversed" : ""}">` +
    (qs ? `<span class="dc-qs">${qs}</span><span class="dc-arrow dc-a-q" aria-hidden="true">→</span>` : "") +
    `<span class="dc-dec">${node(c.decision, "d", c.label, language, c.reversed !== null)}${reversed}</span>` +
    (outs ? `<span class="dc-arrow dc-a-out" aria-hidden="true">→</span><span class="dc-outs">${outs}</span>` : "") +
    `</div>`
  );
}

/** The chain view, newest decision first; "" under `CHAIN_VIEW_MIN` chains. */
export function chainViewHtml(analysis: ChainAnalysis, language: QuestionLanguage): string {
  if (analysis.chains.length < CHAIN_VIEW_MIN) return "";
  const title = CHAIN_LABELS[language].title;
  return (
    `<section class="${DC_VIEW_CLASS} dc-chain" ${READER_ONLY_ATTR} aria-label="${escapeHtml(title)}">` +
    `<div class="dc-title">${escapeHtml(title)}</div>` +
    `<div class="dc-rows">${analysis.chains.map((c) => chainRow(c, language)).join("")}</div></section>`
  );
}

function square(r: LedgerRow, language: QuestionLanguage): string {
  const word = prStateWord(r.state, language);
  // The row label is cell markdown; a tooltip and an accessible name are
  // plain text, so links read as their text and markers drop.
  const label = visibleText(r.label);
  const title = `PR ${r.pr} · ${word}${label ? ` · ${label}` : ""}`;
  return `<span class="dc-pr dc-s-${r.state}" role="img" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${r.pr}</span>`;
}

/** The PR strip: one square per PR over the drawing ledgers (the first row
 *  wins), grouped by the first decision the row cites that the log has, else
 *  by the oldest unreversed decision whose chain names that PR (a later
 *  decision's «PR n» is usually a reference back), else by the row's
 *  first cited id, unlinked; groups in order of first appearance; "" under
 *  `STRIP_VIEW_MIN` squares. */
export function prStripHtml(ledgers: Ledger[], language: QuestionLanguage, analysis: ChainAnalysis): string {
  const rows = firstRowPerPr(ledgers.filter((l) => l.draws));
  if (rows.length < STRIP_VIEW_MIN) return "";
  // Chains come newest first: walking them backwards leaves the oldest.
  const chainOfPr = new Map<number, string>();
  for (const c of [...analysis.chains].reverse()) {
    if (c.reversed) continue;
    for (const o of c.outputs) if (!chainOfPr.has(o.number)) chainOfPr.set(o.number, c.decision);
  }
  const inLog = new Set(analysis.chains.map((c) => c.decision));
  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const key = r.decisions.find((d) => inLog.has(d)) ?? chainOfPr.get(r.pr!) ?? r.decisions[0] ?? "";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  const phases = [...groups]
    .map(([d, rs]) => {
      const head = d && inLog.has(d)
        ? `<a class="dc-go" href="#${anchorSlug(d)}" data-dc-ref="${escapeHtml(d)}">${escapeHtml(d)}</a>`
        : escapeHtml(d || NO_DECISION[language]);
      return `<div class="dc-phase"><div class="dc-ph">${head}</div><div class="dc-prs">${rs.map((r) => square(r, language)).join("")}</div></div>`;
    })
    .join("");
  // One legend entry per look, naming the present states that share it.
  const looks = new Map<readonly PrState[], PrState[]>();
  for (const r of rows) {
    const look = STATE_LOOKS.find((l) => l.includes(r.state))!;
    const present = looks.get(look);
    if (!present) looks.set(look, [r.state]);
    else if (!present.includes(r.state)) present.push(r.state);
  }
  const legend = [...looks.values()]
    .map((ss) => {
      const words = ss.map((s) => prStateWord(s, language)).join(" / ");
      return `<span class="dc-key"><span class="dc-sw dc-s-${ss[0]}" aria-hidden="true"></span>${escapeHtml(words)}</span>`;
    })
    .join("");
  const title = CHAIN_LABELS[language].strip;
  return (
    `<section class="${DC_VIEW_CLASS} dc-strip" ${READER_ONLY_ATTR} aria-label="${escapeHtml(title)}">` +
    `<div class="dc-title">${escapeHtml(title)}</div>` +
    `<div class="dc-track">${phases}</div><div class="dc-legend">${legend}</div></section>`
  );
}

/** Where the views go: after the first top-level `<NextMoves>`, else after
 *  the first `<StatusRows>`; -1 ⇒ the page has neither and gets no view. */
export function viewSlot(blocks: Block[]): number {
  for (const name of ["NextMoves", "StatusRows"] as const) {
    const i = blocks.findIndex((b) => b.type === "component" && b.name === name);
    if (i >= 0) return i + 1;
  }
  return -1;
}
