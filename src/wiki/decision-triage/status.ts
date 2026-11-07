/**
 * The triage status (PR 2 of mimir plans/muninn-decision-triage-visibility.mdx):
 * one wiki's nightly log and state, read into the last run, one row per night and
 * the next due time. Pure: the route reads the files, this counts. Lanes are not
 * here: the log holds none.
 */

import { WORK_MAP_FRESH_MS, workMapDue } from "../work-map/loop.ts";
import { osloDay } from "../work-map/ids.ts";
import type { WorkMapState } from "../work-map/state.ts";
import type { ParsedLog } from "./log.ts";
import type { CardLine, RepoFact, RunLine, RunOutcome } from "./schema.ts";

/** Nights the status returns, newest first. */
export const TRIAGE_STATUS_NIGHTS = 14;

export interface TriageLastRun {
  at: number;
  outcome: RunOutcome;
  reason: string | null;
  cards: number;
  model: string;
  /** The card lines the run logged with code facts. */
  codeFacts: number;
}

export interface TriageNight {
  /** The Oslo date, `YYYY-MM-DD`. */
  night: string;
  /** The night's last run line's outcome; null when only card lines survive. */
  outcome: RunOutcome | null;
  /** Distinct cards the night logged, the latest line per card. */
  cards: number;
  codeFacts: number;
  answered: number;
  reposNotFound: string[];
}

export interface TriageWikiStatus {
  wiki: string;
  lastRun: TriageLastRun | null;
  nights: TriageNight[];
  /** The last run's repos that were not found, with why. */
  reposNotFound: { repo: string; reason: string | null }[];
  /** When the loop's due rule next says yes; null when nothing within the scan does. */
  nextDueAt: number | null;
  /** Log lines that did not parse. */
  broken: number;
}

const STEP_MS = 15 * 60_000;
const SCAN_MS = 3 * 86_400_000;

/**
 * The first instant from `nowMs` on at which {@link workMapDue} says due: `nowMs`
 * itself, the end of the 20 h freshness, or a quarter-hour mark (Oslo's day hour
 * falls on one). The loop checks hourly, so a run starts up to an hour after.
 */
export function nextTriageDue(state: WorkMapState | null, nowMs: number, hour: number): number | null {
  const candidates = [nowMs];
  if (state?.lastSuccessAt !== undefined) candidates.push(state.lastSuccessAt + WORK_MAP_FRESH_MS);
  for (let t = Math.ceil(nowMs / STEP_MS) * STEP_MS; t <= nowMs + SCAN_MS; t += STEP_MS) candidates.push(t);
  for (const t of candidates.filter((c) => c >= nowMs).sort((a, b) => a - b)) {
    if (workMapDue(state, t, hour).due) return t;
  }
  return null;
}

const cardKey = (c: CardLine) => `${c.relPath}#${c.id}`;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A run line the counts can read, or null. `parseLog` checks only `type`, and its
 *  fields reach the status line's markup: repos keep their well-formed entries, `cards` is a number. */
function readableRun(r: RunLine): RunLine | null {
  if (!isStr(r.runId) || !isNum(r.at) || !isStr(r.outcome) || !Array.isArray(r.repos)) return null;
  const repos = r.repos.filter((x): x is RepoFact => !!x && typeof x === "object" && isStr(x.repo) && typeof x.found === "boolean");
  const { reason, ...rest } = r;
  return { ...rest, repos, cards: isNum(r.cards) ? r.cards : 0, model: isStr(r.model) ? r.model : "", ...(isStr(reason) ? { reason } : {}) };
}
const readableCard = (c: CardLine) => isStr(c.runId) && isNum(c.at) && isStr(c.relPath) && isStr(c.id) && isStr(c.verdict);

export function triageWikiStatus(
  wiki: string,
  parsed: ParsedLog,
  state: WorkMapState | null,
  nowMs: number,
  hour: number,
  maxNights = TRIAGE_STATUS_NIGHTS,
): TriageWikiStatus {
  const readRuns = parsed.runs.map(readableRun).filter((r): r is RunLine => r !== null);
  const readCards = parsed.cards.filter(readableCard);
  // A wrong-shaped line counts with the torn ones.
  const log: ParsedLog = { runs: readRuns, cards: readCards, broken: parsed.broken + (parsed.runs.length - readRuns.length) + (parsed.cards.length - readCards.length) };
  const runs = [...log.runs].sort((a, b) => a.at - b.at);
  const runAt = new Map(runs.map((r) => [r.runId, r.at]));
  const nights = new Map<string, { runs: RunLine[]; cards: Map<string, CardLine> }>();
  const nightOf = (key: string) => {
    let n = nights.get(key);
    if (!n) nights.set(key, (n = { runs: [], cards: new Map() }));
    return n;
  };
  for (const r of runs) nightOf(osloDay(r.at)).runs.push(r);
  for (const c of [...log.cards].sort((a, b) => a.at - b.at)) {
    // A card line belongs to its run's night; a run killed before its line, to its own.
    nightOf(osloDay(runAt.get(c.runId) ?? c.at)).cards.set(cardKey(c), c);
  }
  const rows: TriageNight[] = [...nights.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, maxNights)
    .map(([night, n]) => {
      const lastRun = n.runs.at(-1) ?? null;
      const withRepos = [...n.runs].reverse().find((r) => r.repos.length > 0);
      const cards = [...n.cards.values()];
      return {
        night,
        outcome: lastRun?.outcome ?? null,
        cards: cards.length,
        codeFacts: cards.filter((c) => c.codeFacts === true).length,
        answered: cards.filter((c) => c.verdict === "ANSWERED").length,
        reposNotFound: (withRepos?.repos ?? []).filter((r) => !r.found).map((r) => r.repo),
      };
    });
  const last = runs.at(-1) ?? null;
  return {
    wiki,
    lastRun: last && {
      at: last.at,
      outcome: last.outcome,
      reason: last.reason ?? null,
      cards: last.cards,
      model: last.model,
      codeFacts: log.cards.filter((c) => c.runId === last.runId && c.codeFacts === true).length,
    },
    nights: rows,
    reposNotFound: (last?.repos ?? []).filter((r) => !r.found).map((r) => ({ repo: r.repo, reason: isStr(r.reason) ? r.reason : null })),
    nextDueAt: nextTriageDue(state, nowMs, hour),
    broken: log.broken,
  };
}
