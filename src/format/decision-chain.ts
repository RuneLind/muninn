/**
 * The decision chain: which question a decision closed and which PRs it led
 * to, read off one page's `<DecisionLog>` and PR ledger.
 *
 * Pure and server-free (web-format ships in the chat bundle). Edges, in order:
 *  1. question → decision: the question item's close rule
 *     (`itemQuestionState`). A decision's present-tense «Lukker Sn» /
 *     «Closes On» adds the edge only when the last canonical phrase of Sn's
 *     own item is no close (none, or a reopen); when Sn's close names another
 *     decision, the question wins and the pair is a conflict (lint reports it).
 *  2. decision → PR: every ledger row citing the decision. «PR n» /
 *     «oppgave n» in the decision's prose adds an edge only when no ledger row
 *     for that number cites a decision, and not right after a context word
 *     («after PR 6», «som PR 9», «from the PR 2 review»). A ledger whose
 *     first header is Oppgave numbers oppgaver; every other ledger numbers
 *     PRs, and each noun is gated and stated by its own ledgers only.
 *  3. «via»: the `Q-n` ids a question item names.
 */

import type { Block } from "./markdown-ast.ts";
import { wholeStrike, supersededById } from "./genre-lists.ts";
import {
  DECISION_ID_RE,
  QUESTION_ID_RE,
  lastCanonicalPhrase,
  maskCodeSpans,
  parseQuestionPage,
  type DecisionLogEntry,
} from "./question.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { splitFirstSentence, visibleText } from "./report-top.ts";
import { prStateMap, type Ledger, type PrState } from "./pr-ledger.ts";

/** «Lukker S3», «Closes O2, O4 and O5»: present tense only. */
const CLOSES_RE =
  /(?<![\p{L}\p{N}_])(?:[Ll]ukker|[Cc]loses)[ \t ]+([SO]\d{1,4}(?:[ \t ]*(?:,|og|and|&)[ \t ]*[SO]\d{1,4})*)(?![\p{L}\p{N}])/gu;
/** «PR 7», «oppgave 1 og 2», «PR 22/23», «PR 4–6»: a slate number in plain
 *  prose, `PR` in capitals only (Norwegian «pr 4» reads «per 4»). A
 *  `#` form (`PR #3497`, `[PR #3497](…)`) names a pull request on GitHub,
 *  usually as evidence, and is never a slate output. Only an en dash makes a
 *  range; a number running on into `-n` or `.n` is a date or a version. */
const PROSE_PR_RE =
  /(?<![\p{L}\p{N}_[])(PR|[Oo]ppgave)[ \t ]+(\d{1,4})(?![-.]\d)((?:[ \t ]*(?:,|og|and|&|\/|–)[ \t ]*\d{1,4}(?![\p{L}\p{N}#]|[-.]\d))*)(?![\p{L}\p{N}\]])/gu;
/** A prose PR mention right after one of these words is context, not an
 *  output: «once after PR 6», «as PR 9 indexes», «from the PR 2 review». */
const CONTEXT_BEFORE_RE =
  /(?<![\p{L}\p{N}])(?:after|before|since|until|than|as|like|from|etter|før|siden|inntil|enn|som|fra)(?:[ \t ]+(?:the|den|det))?[ \t ]+$/iu;
const VIA_RE = /(?<![\p{L}\p{N}_])Q-\d{1,4}(?![\p{L}\p{N}])/gu;
const LABEL_MAX = 140;
/** Lineage lines `GET /api/wiki/decision-chain` answers at most (plan O3). */
export const DECISION_CHAIN_LINES_MAX = 20;

export interface ChainQuestion {
  id: string;
  label: string;
  /** `close`: the question's own close phrase; `closes`: the decision's «Lukker». */
  source: "close" | "closes";
}

export interface ChainOutput {
  noun: "PR" | "oppgave";
  number: number;
  state: PrState | null;
  source: "ledger" | "prose";
}

export interface DecisionChain {
  decision: string;
  label: string;
  questions: ChainQuestion[];
  outputs: ChainOutput[];
  /** Null unless the decision was reversed; `by` names the replacement. */
  reversed: { by: string | null } | null;
  via: string[];
}

export interface ChainAnalysis {
  /** Newest decision first. */
  chains: DecisionChain[];
  /** A question closed by a decision the log does not define. */
  orphans: { question: string; decision: string }[];
  /** A decision's «Lukker Sn» where Sn's own close names another decision. */
  conflicts: { question: string; closedBy: string; claimant: string }[];
  /** How many decision → PR edges came from prose. */
  proseEdges: number;
}

export interface ChainOptions {
  /** A wikilink sentinel's shown text; absent ⇒ the sentinel is dropped. */
  linkText?: (index: number) => string;
}

function clip(s: string): string {
  const cps = [...s];
  return cps.length > LABEL_MAX ? cps.slice(0, LABEL_MAX - 1).join("").trimEnd() + "…" : s;
}

/** The item's first sentence as plain text, sentinels resolved. */
function labelOf(markdown: string, opts: ChainOptions): string {
  const split = splitFirstSentence(markdown);
  const text = visibleText(split ? split.first : markdown).replace(/\x00WIKIPAGELINK(\d+)\x00/g, (_m, i: string) =>
    opts.linkText ? opts.linkText(Number(i)) : "",
  );
  return clip(text.replace(/\s+/g, " ").trim());
}

/** A reversal word right after the struck lead: snudd, reversed, superseded
 *  or erstattet in any case, as a whole word. Whitespace, dashes, `.,:;!?()`,
 *  `*`/`_` and an opening `[`, `«`, `"` or `“` may come first. */
const REVERSAL_FOLLOWER_RE = /^[\s\-–—.,:;!?()*_[«"“]*(?:snudd|reversed|superseded|erstattet)(?![\p{L}\p{N}])/iu;
/** A struck first sentence ends in `.`, `!`, `?` or `…`, perhaps then one
 *  closing quote or bracket. */
const SENTENCE_END_RE = /[.!?…][»"”’')\]]?$/u;

/** The item's leading `~~…~~` span when it is a struck first sentence. The
 *  first `~~` after the opener closes it, found with one `indexOf` so an
 *  unclosed `~~` costs one scan; a `~~` inside a code span closes it too (an
 *  accepted limitation). */
function struckLead(text: string): { struck: string; end: number } | null {
  if (!text.startsWith("~~")) return null;
  const close = text.indexOf("~~", 2);
  if (close < 0) return null;
  const struck = text.slice(2, close);
  return SENTENCE_END_RE.test(struck.trimEnd()) ? { struck, end: close + 2 } : null;
}

/** A reversed decision: struck whole, dimmed by the log («superseded by Dn»,
 *  `parseLogItem`), or a struck first sentence followed by a reversal word.
 *  `struck` is the label source: the strike's inside for a whole strike, the
 *  struck sentence for a reversed item, else null (the item's first sentence). */
function reversalOf(e: DecisionLogEntry): { struck: string | null; reversed: boolean } {
  const whole = wholeStrike(e.itemText);
  if (whole !== null) return { struck: whole, reversed: true };
  const lead = struckLead(e.itemText);
  const reversed = e.dim || (lead !== null && REVERSAL_FOLLOWER_RE.test(e.itemText.slice(lead.end)));
  return { struck: reversed && lead ? lead.struck : null, reversed };
}

/** A ledger whose first column numbers oppgaver rather than PRs. */
function numbersOppgaver(l: Ledger): boolean {
  return /^(?:(?:planned|planlagt)\s+)?oppgave$/i.test((l.headers[0] ?? "").replace(/\*\*|__|~~/g, "").trim());
}

function idsIn(list: string): string[] {
  return list.match(/[SO]\d{1,4}/g) ?? [];
}

/** A range expands to its numbers up to this many; a longer one keeps its ends. */
const RANGE_MAX = 10;

/** The numbers a prose mention names: a list as written, `4–6` as 4, 5, 6. */
function numbersIn(first: string, tail: string): number[] {
  const out = [Number(first)];
  for (const m of tail.matchAll(/(,|og|and|&|\/|–)[ \t\u00a0]*(\d{1,4})/g)) {
    const n = Number(m[2]);
    const from = out[out.length - 1]!;
    if (m[1] === "–" && n > from && n - from < RANGE_MAX) for (let k = from + 1; k < n; k++) out.push(k);
    out.push(n);
  }
  return out;
}

/**
 * Read the page's decision chains. `ledgers` are the page's PR ledgers
 * (`pageLedgers`); a glance fallback contributes outputs but no decisions.
 */
export function analyzeDecisionChains(blocks: Block[], ledgers: Ledger[], opts: ChainOptions = {}): ChainAnalysis {
  const page = parseQuestionPage(blocks);
  const questionIds = new Set(page.questions.map((q) => q.id).filter((id): id is string => !!id));
  const firstEntry = new Map<string, DecisionLogEntry>();
  for (const e of page.entries) if (!firstEntry.has(e.id)) firstEntry.set(e.id, e);

  const decisions = [...firstEntry.values()].filter((e) => DECISION_ID_RE.test(e.id));
  const questions = [...firstEntry.values()].filter((e) => QUESTION_ID_RE.test(e.id) || questionIds.has(e.id));
  const chainOf = new Map<string, DecisionChain>();
  const reversals = new Map<string, ReturnType<typeof reversalOf>>();
  const reversal = (e: DecisionLogEntry) => {
    let r = reversals.get(e.id);
    if (!r) reversals.set(e.id, (r = reversalOf(e)));
    return r;
  };
  const chain = (e: DecisionLogEntry): DecisionChain => {
    let c = chainOf.get(e.id);
    if (!c) {
      const rev = reversal(e);
      c = {
        decision: e.id,
        label: labelOf(rev.struck ?? e.itemText, opts),
        questions: [],
        outputs: [],
        reversed: rev.reversed ? { by: supersededById(e.itemText) } : null,
        via: [],
      };
      chainOf.set(e.id, c);
    }
    return c;
  };

  const orphans: ChainAnalysis["orphans"] = [];
  const conflicts: ChainAnalysis["conflicts"] = [];
  const closedBy = new Map<string, string>();

  // 1. question → decision, from the question's own close.
  for (const q of questions) {
    const state = page.states.get(q.id);
    const phrase = lastCanonicalPhrase(q.text);
    if (state?.kind === "decided") {
      const d = firstEntry.get(state.decision);
      if (!d) continue;
      closedBy.set(q.id, state.decision);
      const c = chain(d);
      c.questions.push({ id: q.id, label: labelOf(q.itemText, opts), source: "close" });
      for (const v of maskCodeSpans(q.text).match(VIA_RE) ?? []) if (!c.via.includes(v)) c.via.push(v);
    } else if (phrase?.kind === "close" && phrase.decision && !page.decisions.has(phrase.decision)) {
      orphans.push({ question: q.id, decision: phrase.decision });
    }
  }

  // 1b. «Lukker Sn» on a decision.
  const questionEntry = new Map(questions.map((q) => [q.id, q] as const));
  for (const d of decisions) {
    const masked = maskCodeSpans(d.text);
    for (const m of masked.matchAll(CLOSES_RE)) {
      for (const qid of idsIn(m[1]!)) {
        const q = questionEntry.get(qid);
        if (!q) continue;
        const phrase = lastCanonicalPhrase(q.text);
        if (phrase?.kind !== "close") {
          const c = chain(d);
          if (!c.questions.some((x) => x.id === qid)) c.questions.push({ id: qid, label: labelOf(q.itemText, opts), source: "closes" });
        } else if (phrase.decision && phrase.decision !== d.id) {
          if (!conflicts.some((x) => x.question === qid && x.claimant === d.id))
            conflicts.push({ question: qid, closedBy: phrase.decision, claimant: d.id });
        }
      }
    }
  }

  // 2. decision → PR, from the ledgers, each ledger under its own noun.
  const nounOf = (l: Ledger): ChainOutput["noun"] => (numbersOppgaver(l) ? "oppgave" : "PR");
  const states = {
    PR: prStateMap(ledgers.filter((l) => nounOf(l) === "PR")),
    oppgave: prStateMap(ledgers.filter((l) => nounOf(l) === "oppgave")),
  };
  const cited = { PR: new Set<number>(), oppgave: new Set<number>() };
  for (const l of ledgers) {
    const noun = nounOf(l);
    for (const r of l.rows) {
      if (r.pr === null || r.decisions.length === 0) continue;
      cited[noun].add(r.pr);
      for (const did of r.decisions) {
        const d = firstEntry.get(did);
        if (!d) continue;
        const c = chain(d);
        if (!c.outputs.some((o) => o.number === r.pr && o.noun === noun))
          c.outputs.push({ noun, number: r.pr, state: r.state, source: "ledger" });
      }
    }
  }

  // 2b. decision → PR, from prose, where no ledger row cites a decision.
  let proseEdges = 0;
  for (const d of decisions) {
    const masked = maskCodeSpans(d.text);
    for (const m of masked.matchAll(PROSE_PR_RE)) {
      if (CONTEXT_BEFORE_RE.test(masked.slice(Math.max(0, m.index! - 24), m.index!))) continue;
      const noun: ChainOutput["noun"] = m[1] === "PR" ? "PR" : "oppgave";
      for (const n of numbersIn(m[2]!, m[3] ?? "")) {
        if (cited[noun].has(n)) continue;
        const c = chain(d);
        if (c.outputs.some((o) => o.number === n && o.noun === noun)) continue;
        c.outputs.push({ noun, number: n, state: states[noun].get(n) ?? null, source: "prose" });
        proseEdges++;
      }
    }
  }

  // A reversal is a chain of its own even with no edge: it is the row that
  // says the decision was turned.
  for (const d of decisions) if (reversal(d).reversed) chain(d);

  for (const c of chainOf.values()) c.outputs.sort((a, b) => a.number - b.number);
  const chains = [...chainOf.values()]
    .filter((c) => c.questions.length > 0 || c.outputs.length > 0 || c.reversed !== null)
    .sort((a, b) => Number(b.decision.slice(1)) - Number(a.decision.slice(1)));
  return { chains, orphans, conflicts, proseEdges };
}

/** One lineage line: `O13 → D20 → PR 21 (dropped)`. */
export function lineageLine(c: DecisionChain): string {
  const parts: string[] = [];
  if (c.questions.length) parts.push(c.questions.map((q) => q.id).join(", "));
  parts.push(c.reversed ? `${c.decision} (reversed${c.reversed.by ? ` by ${c.reversed.by}` : ""})` : c.decision);
  if (c.outputs.length)
    parts.push(c.outputs.map((o) => `${o.noun} ${o.number}${o.state && o.state !== "unknown" ? ` (${o.state})` : ""}`).join(", "));
  return parts.join(" → ");
}

/** The words a chain row shows, per wiki language. */
export const CHAIN_LABELS: Record<QuestionLanguage, { reversed: string; supersededBy: string; title: string; strip: string }> = {
  en: { reversed: "Reversed", supersededBy: "superseded by", title: "Decision chain", strip: "PRs by decision" },
  no: { reversed: "Snudd", supersededBy: "erstattet av", title: "Beslutningskjede", strip: "PR-er per beslutning" },
};
