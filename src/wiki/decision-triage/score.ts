/**
 * The judge, pure. A label says whether an answer added something; the figures
 * say how many of those a verdict flagged and how many verdicts flagged at all.
 * Labels reach this module and no fact or prompt code (`facts.ts`, `prompt.ts`).
 *
 * The nightly run and the score measure different things (D14): most answers
 * arrive with no night between card and answer, so part (2) replays them, and the
 * nightly catches are printed beside it as what the inbox will really show.
 */

import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { QUESTION_NOT_SURE } from "../../format/question.ts";
import { osloDay } from "../work-map/ids.ts";
import type { CardLine, CardOutcome, FloorState, RunLine, VerdictKind } from "./schema.ts";
import { VERDICT_KINDS } from "./schema.ts";

export const SETTLE_WINDOW_MS = 10 * 60_000;
export const FLOOR_LABELLED = 20;
export const FLOOR_ADDED = 10;
export const FLOOR_PAGES = 2;
export const CAP_DAY = 28;
export const FLAGGING_RULE_WIKI = "melosys-kode-wiki";
const DAY_MS = 86_400_000;

/** A question's first answer, as its author settled it. */
export interface Settled {
  relPath: string;
  id: string;
  answerId: string;
  author: string;
  /** Epoch ms of the answer's first version: the moment replay cuts at. */
  firstAt: number;
  /** Epoch ms of the settled version. */
  at: number;
  choice: string | null;
  body: string;
  /** The hash of the first version: the wording the card was first answered on,
   *  which is what a replay reads and what the label compares with. */
  questionHash: string;
}

/**
 * One row per question: its first live answer, as that author left it within
 * `windowMs` (a not-sure corrected 7 minutes later is the correction). An answer
 * with a redacted version is gone. `windowMs: 0` reads the first version alone.
 */
export function settledAnswers(versions: readonly WikiAnswerVersion[], opts: { windowMs?: number } = {}): Settled[] {
  const windowMs = opts.windowMs ?? SETTLE_WINDOW_MS;
  const redacted = new Set(versions.filter((v) => v.redactedAt !== null).map((v) => v.answerId));
  const byQuestion = new Map<string, WikiAnswerVersion[]>();
  for (const v of versions) {
    if (redacted.has(v.answerId)) continue;
    const key = `${v.relPath}\0${v.questionId}`;
    const held = byQuestion.get(key);
    if (held) held.push(v);
    else byQuestion.set(key, [v]);
  }
  const out: Settled[] = [];
  for (const rows of byQuestion.values()) {
    rows.sort((a, b) => a.createdAt - b.createdAt || a.version - b.version);
    const first = rows[0]!;
    const authorKey = first.author.userId ?? first.author.name;
    const mine = rows.filter((v) => (v.author.userId ?? v.author.name) === authorKey && v.createdAt <= first.createdAt + windowMs);
    const last = mine[mine.length - 1]!;
    out.push({
      relPath: first.relPath,
      id: first.questionId,
      answerId: last.answerId,
      author: first.author.name,
      firstAt: first.createdAt,
      at: last.createdAt,
      choice: last.choice,
      body: last.body,
      questionHash: first.questionHash,
    });
  }
  return out;
}

/** Did this answer add something? Not sure, no choice, a choice other than the
 *  card's recommendation or a body all do. A plain choice on a card with no
 *  recommendation has no label. */
export function labelOf(a: Pick<Settled, "choice" | "body">, recommendation: string | null): boolean | null {
  if (a.choice === null || a.choice === QUESTION_NOT_SURE || a.body.trim() !== "") return true;
  if (recommendation === null) return null;
  return a.choice !== recommendation;
}

export const isFlag = (v: CardOutcome | undefined) => v === "ASK_OWNER" || v === "ASK_OTHER";
const isModelVerdict = (v: CardOutcome): v is VerdictKind => (VERDICT_KINDS as readonly string[]).includes(v);

/** One replayed card with its label: only the scorer holds this shape. */
export interface ScoredItem {
  wiki: string;
  relPath: string;
  id: string;
  added: boolean;
  gapHours?: number | null;
  textAlone?: boolean;
  verdict: CardOutcome | undefined;
}

export interface Figures {
  caught: number;
  of: number;
  flagged: number;
  cards: number;
}

const figures = (items: readonly { added: boolean; flag: boolean }[]): Figures => ({
  caught: items.filter((i) => i.added && i.flag).length,
  of: items.filter((i) => i.added).length,
  flagged: items.filter((i) => i.flag).length,
  cards: items.length,
});

/** The flag share projected onto a population: the added and other answers at
 *  this sample's rates. With none, the sample's own share. */
export function projectedShare(f: Figures, population?: { added: number; other: number }): number {
  if (f.cards === 0) return 0;
  if (!population || f.of === 0 || f.cards === f.of) return Math.round((100 * f.flagged) / f.cards);
  const flaggedOther = f.flagged - f.caught;
  const others = f.cards - f.of;
  return Math.round((100 * (population.added * (f.caught / f.of) + population.other * (flaggedOther / others))) / (population.added + population.other));
}

export interface ReplayReport {
  verdict: Figures;
  sharePct: number;
  textAlone: Figures & { sharePct: number };
  rule: Figures & { sharePct: number };
  perWiki: Record<string, Figures>;
  late: Figures;
  lateTextAlone: Figures;
  notScored: number;
  byKind: Record<string, number>;
  catchesBy: { ASK_OWNER: number; ASK_OTHER: number };
}

export function replayReport(items: readonly ScoredItem[], population?: { added: number; other: number }): ReplayReport {
  const scored = items.filter((i) => i.verdict !== undefined && i.verdict !== "NO_VERDICT");
  const verdict = figures(scored.map((i) => ({ added: i.added, flag: isFlag(i.verdict) })));
  const text = figures(items.map((i) => ({ added: i.added, flag: i.textAlone === true })));
  const rule = figures(items.map((i) => ({ added: i.added, flag: i.wiki === FLAGGING_RULE_WIKI })));
  const perWiki: Record<string, Figures> = {};
  for (const wiki of new Set(items.map((i) => i.wiki))) {
    perWiki[wiki] = figures(scored.filter((i) => i.wiki === wiki).map((i) => ({ added: i.added, flag: isFlag(i.verdict) })));
  }
  const late = items.filter((i) => (i.gapHours ?? 0) > 12);
  const byKind: Record<string, number> = {};
  for (const i of scored) byKind[i.verdict!] = (byKind[i.verdict!] ?? 0) + 1;
  return {
    verdict,
    sharePct: projectedShare(verdict, population),
    textAlone: { ...text, sharePct: projectedShare(text, population) },
    rule: { ...rule, sharePct: projectedShare(rule, population) },
    perWiki,
    late: figures(late.filter((i) => i.verdict !== undefined && i.verdict !== "NO_VERDICT").map((i) => ({ added: i.added, flag: isFlag(i.verdict) }))),
    lateTextAlone: figures(late.map((i) => ({ added: i.added, flag: i.textAlone === true }))),
    notScored: items.length - scored.length,
    byKind,
    catchesBy: {
      ASK_OWNER: scored.filter((i) => i.added && i.verdict === "ASK_OWNER").length,
      ASK_OTHER: scored.filter((i) => i.added && i.verdict === "ASK_OTHER").length,
    },
  };
}

/** Part (1)'s headline: a card left with no verdict re-opens the contract and
 *  never reads as a worse result. */
export function part1Headline(r: ReplayReport): { result: "better" | "worse" | "tie" | "not scored"; line: string } {
  if (r.notScored > 0) {
    return { result: "not scored", line: `NOT SCORED: ${r.notScored} card(s) have no verdict after the re-runs. This re-opens the contract; it is not a worse result.` };
  }
  const { caught, of } = r.verdict;
  const stated = `${caught} of ${of} caught, ${r.sharePct}% flagged (text alone ${r.textAlone.caught} of ${r.textAlone.of}, ${r.textAlone.sharePct}%; rule ${r.rule.caught} of ${r.rule.of}, ${r.rule.sharePct}%)`;
  if (caught <= 9 || r.sharePct > 50) return { result: "worse", line: `WORSE: ${stated}.` };
  if (caught >= 12 && r.sharePct <= 39) return { result: "better", line: `BETTER: ${stated}.` };
  const belowRule = caught < r.rule.caught || (caught === r.rule.caught && r.sharePct > r.rule.sharePct);
  return { result: "tie", line: `TIE: ${stated}. It fell ${belowRule ? "below" : "at or above"} the «flag every ${FLAGGING_RULE_WIKI} card» rule.` };
}

/** The floor over labelled answers. */
export function floorOf(labelled: readonly { relPath: string; wiki?: string; added: boolean | null }[]): FloorState {
  const known = labelled.filter((l) => l.added !== null);
  const added = known.filter((l) => l.added);
  const addedPages = new Set(added.map((l) => `${l.wiki ?? ""}\0${l.relPath}`)).size;
  return {
    labelled: known.length,
    added: added.length,
    addedPages,
    met: known.length >= FLOOR_LABELLED && added.length >= FLOOR_ADDED && addedPages >= FLOOR_PAGES,
  };
}

export interface NightRecord {
  day: string;
  wiki: string;
  outcome: "ok" | "partial" | "refused" | "failed" | "absent";
  /** Model verdicts by kind this night; empty with none. */
  kinds: Partial<Record<VerdictKind, number>>;
}

const OUTCOME_RANK = { ok: 4, partial: 3, failed: 2, refused: 1, absent: 0 } as const;

/** Every wiki's nights, from its first `ok` or `partial` line to `todayMs`. A day
 *  takes its best outcome, and a card line with no run line still counts its
 *  verdicts (a kill mid-run); such a day with no run line reads absent. */
export function nightsOf(runs: readonly RunLine[], cards: readonly CardLine[], todayMs: number): NightRecord[] {
  const out: NightRecord[] = [];
  for (const wiki of new Set([...runs, ...cards].map((l) => l.wiki))) {
    const mine = runs.filter((r) => r.wiki === wiki);
    const started = mine.filter((r) => r.outcome === "ok" || r.outcome === "partial").map((r) => r.at);
    const first = started.length ? Math.min(...started) : null;
    if (first === null) {
      for (const day of [...new Set(mine.map((r) => osloDay(r.at)))].sort()) {
        const best = mine.filter((r) => osloDay(r.at) === day).sort((a, b) => OUTCOME_RANK[b.outcome] - OUTCOME_RANK[a.outcome])[0]!;
        out.push({ day, wiki, outcome: best.outcome, kinds: {} });
      }
      continue;
    }
    const lastDay = osloDay(todayMs);
    for (let at = first; ; at += DAY_MS) {
      const day = osloDay(at);
      if (day > lastDay) break;
      const today = mine.filter((r) => osloDay(r.at) === day);
      const best = today.sort((a, b) => OUTCOME_RANK[b.outcome] - OUTCOME_RANK[a.outcome])[0];
      const kinds: NightRecord["kinds"] = {};
      for (const c of cards) {
        if (c.wiki === wiki && osloDay(c.at) === day && isModelVerdict(c.verdict)) kinds[c.verdict] = (kinds[c.verdict] ?? 0) + 1;
      }
      out.push({ day, wiki, outcome: best?.outcome ?? "absent", kinds });
      if (day === lastDay) break;
    }
  }
  return out.sort((a, b) => (a.day === b.day ? a.wiki.localeCompare(b.wiki) : a.day.localeCompare(b.day)));
}

const median = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** A night's share of model verdicts: one per wiki and night with any. */
export function nightlyShares(nights: readonly NightRecord[]): { askOwnerMedian: number | null; askAnyMedian: number | null; nights: number } {
  const shares = nights.flatMap((n) => {
    const total = Object.values(n.kinds).reduce((a, b) => a + (b ?? 0), 0);
    return total ? [{ owner: (n.kinds.ASK_OWNER ?? 0) / total, any: ((n.kinds.ASK_OWNER ?? 0) + (n.kinds.ASK_OTHER ?? 0)) / total }] : [];
  });
  return { askOwnerMedian: median(shares.map((s) => s.owner)), askAnyMedian: median(shares.map((s) => s.any)), nights: shares.length };
}

/** How many cards' verdict changed between one night and the next, over how many
 *  cards ran at least two nights. */
export function verdictFlips(cards: readonly CardLine[]): { flips: number; cardsFlipped: number; cards: number } {
  const byCard = new Map<string, CardLine[]>();
  for (const c of cards) {
    if (!isModelVerdict(c.verdict)) continue;
    const key = `${c.wiki}\0${c.relPath}\0${c.id}`;
    const held = byCard.get(key);
    if (held) held.push(c);
    else byCard.set(key, [c]);
  }
  let flips = 0;
  let cardsFlipped = 0;
  let twice = 0;
  for (const rows of byCard.values()) {
    if (rows.length < 2) continue;
    twice++;
    rows.sort((a, b) => a.at - b.at);
    const n = rows.slice(1).filter((r, i) => r.verdict !== rows[i]!.verdict).length;
    flips += n;
    if (n) cardsFlipped++;
  }
  return { flips, cardsFlipped, cards: twice };
}

/** What a nightly verdict recorded before an answer did with it. */
export interface NightlyCatches {
  waited: number;
  addedWaited: number;
  caught: number;
  /** A `SETTLED` or `VOID` before an answer: counts against that verdict. */
  settledThenAnswered: number;
}

/** The nightly verdict's catches on cards that waited a night (no bar: this is
 *  what the inbox will really show). */
export function nightlyCatches(answers: readonly { wiki: string; relPath: string; id: string; firstAt: number; added: boolean | null }[], cards: readonly CardLine[]): NightlyCatches {
  const out: NightlyCatches = { waited: 0, addedWaited: 0, caught: 0, settledThenAnswered: 0 };
  for (const a of answers) {
    const before = cards
      .filter((c) => c.wiki === a.wiki && c.relPath === a.relPath && c.id === a.id && c.at < a.firstAt && isModelVerdict(c.verdict))
      .sort((x, y) => y.at - x.at)[0];
    if (!before) continue;
    if (before.verdict === "SETTLED" || before.verdict === "VOID") out.settledThenAnswered++;
    if (a.added === null) continue;
    out.waited++;
    if (a.added) {
      out.addedWaited++;
      if (isFlag(before.verdict)) out.caught++;
    }
  }
  return out;
}

export interface Part2Input {
  report: ReplayReport;
  floor: FloorState;
  day: number | null;
  shares: ReturnType<typeof nightlyShares>;
  /** Distinct cards read in the hand sample of `SETTLED` and `VOID`. */
  handRead: number | null;
  handWrong: number | null;
  /** Nightly `SETTLED` or `VOID` verdicts on a card answered later: each counts against the verdict, sample or no sample. */
  settledThenAnswered: number;
}

export type Part2Result = "too early" | "too few to score" | "pass" | "miss" | "not scored";
export type Part2Headline = { result: Part2Result; line: string; notes: string[] };

/** The two headlines known before any verdict: nothing to replay for. */
export function part2Stop(day: number | null, floor: FloorState): Part2Headline | null {
  const dayText = day === null ? "no ok or partial run line yet" : `day ${day}`;
  if (day === null || day < 14) return { result: "too early", line: `TOO EARLY (${dayText}): the first scoring is at day 14.`, notes: [] };
  if (floor.met) return null;
  const note = day >= CAP_DAY ? "At the cap this is neither a pass nor a failure: the counts go to Rune, silence stays off, and Rune decides on P3." : `The decision moves to day ${CAP_DAY}, with no scoring between.`;
  return { result: "too few to score", line: `TOO FEW TO SCORE (${dayText}): ${floor.labelled} labelled, ${floor.added} added, on ${floor.addedPages} page(s); the floor is ${FLOOR_LABELLED}, ${FLOOR_ADDED} and ${FLOOR_PAGES}.`, notes: [note] };
}

/** Part (2)'s headline. Below the floor reads «too few to score», never a pass,
 *  and only the first scoring on or after day 14 can pass. */
export function part2Headline(p: Part2Input): Part2Headline {
  const notes: string[] = [];
  const { report: r, floor, day, shares } = p;
  const stop = part2Stop(day, floor);
  if (stop) return stop;
  const dayText = `day ${day}`;
  const atCap = day! >= CAP_DAY;
  if (r.notScored > 0) return { result: "not scored", line: `NOT SCORED (${dayText}): ${r.notScored} card(s) have no verdict after the re-runs. This re-opens the contract.`, notes };
  const caughtPct = r.verdict.of ? (100 * r.verdict.caught) / r.verdict.of : 0;
  const ownerOk = shares.askOwnerMedian !== null && shares.askOwnerMedian <= 0.3;
  const anyOk = shares.askAnyMedian !== null && shares.askAnyMedian <= 0.5;
  const handJudged = p.handRead !== null && p.handRead >= 5;
  if (r.rule.caught >= r.verdict.caught && r.rule.sharePct <= r.sharePct) notes.push(`The «flag every ${FLAGGING_RULE_WIKI} card» rule matches this result.`);
  if (r.catchesBy.ASK_OTHER > r.catchesBy.ASK_OWNER) notes.push("Most catches are ASK_OTHER.");
  const handOk = !handJudged || p.handWrong === 0;
  const later = p.settledThenAnswered;
  const pass = caughtPct >= 90 && ownerOk && anyOk && handOk && later === 0;
  const settled = later > 0 ? `; ${later} SETTLED or VOID later answered` : handJudged ? "" : `; «SETTLED or VOID» not judged (${p.handRead ?? 0} distinct card(s) read, 5 are needed, so P3 keeps those cards visible)`;
  if (!pass) notes.push(atCap ? "A miss at the cap stops the work on P3 and re-opens the contract." : `The decision moves to day ${CAP_DAY}, with no scoring between.`);
  const stated = `${r.verdict.caught} of ${r.verdict.of} caught (${Math.round(caughtPct)}%), nightly median ASK_OWNER ${pct(shares.askOwnerMedian)}, both ${pct(shares.askAnyMedian)}${settled}`;
  return { result: pass ? "pass" : "miss", line: `${pass ? "PASS" : "MISS"} (${dayText}): ${stated}.`, notes };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
