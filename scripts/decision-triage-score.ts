/**
 * The decision triage's judge. Every mode prints aggregates; a verdict on an open
 * card is never printed, so the answers stay unanchored until the final scoring.
 *
 *   --replay [--baseline <file>] [--dry-run]   part (1): the baseline's replayable cards
 *   --since <day> [--dry-run] [--final]        part (2): every card first answered since;
 *     [--hand <file>]                          {"read": n, "wrong": n} from the hand sample
 *   --labels [--until <iso>]                   the label's two counts, with and without
 *                                              the 10-minute rule
 *   (no mode)                                  the nightly logs' figures
 *
 * `--dry-run` gathers facts, makes no model call, reads no label and writes nothing.
 * `--since` makes no model call either when its headline will be TOO EARLY or TOO FEW.
 * From day 14 each real `--since` goes on the record (`part2-scorings.jsonl` in the log
 * folder), which allows one decision scoring, then only the first at or past day 28.
 * `--hand` on a scoring already recorded adds the sample to its figures, once.
 * `--root <wiki>=<path>` (repeatable) names a wiki's root; `--log-dir <dir>` moves
 * the logs. Both replays refuse without DECISION_TRIAGE_REPO_ROOTS, or on a wiki
 * `scope.ts` refuses (a readonly root). From a worktree, run with `bun --env-file <checkout>/.env`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, resolveWikiAnswerConfig } from "../src/config.ts";
import { closeDb, initDb } from "../src/db/client.ts";
import { listWikiAnswerHistory } from "../src/db/wiki-answers.ts";
import { readBaselineCards, readBaselineLabels } from "../src/wiki/decision-triage/baseline.ts";
import type { ReplayCard } from "../src/wiki/decision-triage/facts.ts";
import { answerWindowMs, labelsSince, type WikiLabels } from "../src/wiki/decision-triage/floor.ts";
import {
  amendWithHand,
  cardDoneToday,
  currentLog,
  droppedOf,
  finalRefusal,
  handSample,
  parseScoringRecords,
  part2Day,
  part2Plan,
  runPart2,
  scoringGate,
  sinceAfterWindow,
  type Dropped,
} from "../src/wiki/decision-triage/part2.ts";
import { realGit } from "../src/wiki/decision-triage/git.ts";
import { appendLogLines, DECISION_TRIAGE_DIR, nightlyLogPath, readLog, readScoringText, replayLogPath, scoringRecordPath, type ParsedLog } from "../src/wiki/decision-triage/log.ts";
import { gatherReplay, replayCounts, replayKey, ReplayRefused, runReplay, type ReplayDeps } from "../src/wiki/decision-triage/replay.ts";
import { realDecisionTriageModel } from "../src/wiki/decision-triage/run.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, type CardLine } from "../src/wiki/decision-triage/schema.ts";
import {
  CAP_DAY,
  FLAGGING_RULE_WIKI,
  nightlyCatches,
  nightlyShares,
  nightsOf,
  part1Headline,
  replayReport,
  SETTLE_WINDOW_MS,
  verdictFlips,
  type ReplayReport,
  type ScoredItem,
} from "../src/wiki/decision-triage/score.ts";
import { scopeVerdict, triageScope, type TriageScope } from "../src/wiki/decision-triage/scope.ts";
import { parseHandSample, parseIsoMoment, parseSinceDay, rootOverrides, todayNightDue, triageEntries, UsageError } from "../src/wiki/decision-triage/script-roots.ts";
import type { WikiRegistryEntry } from "../src/wiki/registry.ts";
import { closedQuestionIds } from "../src/format/question.ts";
import { getWikiIndex, readWikiPage } from "../src/wiki/store.ts";
import { parseBlocks } from "../src/format/markdown-ast.ts";
import { splitFrontmatter } from "../src/wiki/page-text.ts";

const USAGE = "usage: bun scripts/decision-triage-score.ts [--replay [--baseline <file>] | --since <YYYY-MM-DD> [--final] [--hand <file>] | --labels [--until <iso>]] [--dry-run] [--root <wiki>=<path>] [--log-dir <dir>]";
const usageExit = (message: string): never => {
  console.error(`usage error: ${message}. ${USAGE}`);
  process.exit(2);
};

/** Every flag read before anything else runs, or one usage line. */
function readFlags() {
  try {
    const { values } = parseArgs({
      options: {
        replay: { type: "boolean" },
        since: { type: "string" },
        labels: { type: "boolean" },
        until: { type: "string" },
        baseline: { type: "string" },
        "dry-run": { type: "boolean" },
        final: { type: "boolean" },
        root: { type: "string", multiple: true },
        "log-dir": { type: "string" },
        hand: { type: "string" },
      },
    });
    return {
      values,
      overrides: rootOverrides(values.root ?? []),
      sinceArg: values.since === undefined ? null : parseSinceDay(values.since),
      untilArg: values.until === undefined ? null : parseIsoMoment("--until", values.until),
    };
  } catch (err) {
    return usageExit(err instanceof Error ? err.message : String(err));
  }
}

const { values, overrides, sinceArg, untilArg } = readFlags();

const DEFAULT_BASELINE = path.join(homedir(), ".muninn", "decision-triage", "baseline-2026-11-04.json");

const config = loadConfig();
const answerConfig = resolveWikiAnswerConfig();
const logDir = values["log-dir"] ? path.resolve(values["log-dir"]) : DECISION_TRIAGE_DIR;
const readScope = () => triageScope({ workMapWikis: config.workMapWikis, answerWikis: answerConfig.wikis, entryOf: (name) => triageEntries(overrides, [name])[0] });
const asRoots = (entries: readonly WikiRegistryEntry[]) => entries.map((e) => ({ wiki: e.name, root: e.root }));
const faultsOf = (scope: TriageScope) => scope.dropped.filter((d) => d.fault).map((d) => `${d.wiki}: ${d.reason}`);

function replayDeps(entries: readonly WikiRegistryEntry[]): ReplayDeps {
  return {
    roots: new Map(asRoots(entries).map((e) => [e.wiki, e.root])),
    repoRoots: config.decisionTriageRepoRoots,
    git: realGit,
    answers: listWikiAnswerHistory,
    owner: answerConfig.owner,
    groups: answerConfig.groups,
    now: Date.now,
  };
}

const fmt = (f: { caught: number; of: number; flagged: number; cards: number }) => `${f.caught} of ${f.of} caught, ${f.flagged} of ${f.cards} flagged`;

function printReport(r: ReplayReport): void {
  console.log(`verdict:    ${fmt(r.verdict)}, projected share ${r.sharePct}%`);
  console.log(`text alone: ${fmt(r.textAlone)}, projected share ${r.textAlone.sharePct}%`);
  console.log(`rule:       ${fmt(r.rule)}, projected share ${r.rule.sharePct}%`);
  console.log(`by kind:    ${JSON.stringify(r.byKind)}; catches by verdict ${JSON.stringify(r.catchesBy)}`);
  for (const [wiki, f] of Object.entries(r.perWiki)) console.log(`  ${wiki}: ${fmt(f)}`);
  console.log(`answered more than 12 h after writing (passes nothing): ${fmt(r.late)}; text alone ${fmt(r.lateTextAlone)}`);
}

async function modelReplay(cards: readonly ReplayCard[], entries: readonly WikiRegistryEntry[]): Promise<Map<string, CardLine>> {
  const gathered = await gatherReplay(cards, replayDeps(entries));
  const file = replayLogPath(DECISION_TRIAGE_PROMPT_VERSION, logDir);
  const { cards: existing } = await readLog(file);
  const { lines, usage, kept, rejudged } = await runReplay(gathered, {
    call: realDecisionTriageModel(config),
    model: config.workMapModel,
    ...(config.workMapEffort ? { effort: config.workMapEffort } : {}),
    existing,
    append: (l) => appendLogLines(file, l),
    now: Date.now,
    repoRoots: config.decisionTriageRepoRoots,
  });
  console.log(`replay: ${gathered.items.length} cards, ${gathered.refused.length} refused, ${gathered.oversized.length} over the limit; ${kept} verdict(s) kept for the same message, ${rejudged} re-judged because the message changed; usage ${JSON.stringify(usage)}; log ${file}`);
  return lines;
}

async function modePart1(): Promise<number> {
  const text = await readFile(path.resolve(values.baseline ?? DEFAULT_BASELINE), "utf8");
  const { cards, unreplayable } = readBaselineCards(text);
  const scope = await readScope();
  // A readonly root forbids the model call, and a rehearsal refuses what the run would.
  const entries = [...new Set(cards.map((c) => c.wiki))].map((wiki) => {
    const standing = scopeVerdict(scope, wiki);
    if ("reason" in standing) throw new ReplayRefused(standing.reason);
    return { ...standing.entry, name: wiki };
  });
  if (values["dry-run"]) {
    const counts = replayCounts(await gatherReplay(cards, replayDeps(entries)));
    console.log(JSON.stringify({ mode: "replay --dry-run", unreplayable, ...counts }, null, 1));
    return 0;
  }
  const lines = await modelReplay(cards, entries);
  // The labels are read here, after every verdict is on disk.
  const { labels, population } = readBaselineLabels(text);
  const items: ScoredItem[] = cards.map((c) => {
    const label = labels.get(replayKey(c))!;
    return { wiki: c.wiki, relPath: c.relPath, id: c.id, added: label.added, gapHours: label.gapHours, textAlone: label.textAlone, verdict: lines.get(replayKey(c))?.verdict };
  });
  const report = replayReport(items, population);
  console.log(part1Headline(report).line);
  printReport(report);
  return 0;
}

async function nightlyLogs(names: readonly string[]): Promise<ParsedLog> {
  const out: ParsedLog = { runs: [], cards: [], broken: 0 };
  for (const name of names) {
    const log = await readLog(nightlyLogPath(name, logDir));
    out.runs.push(...log.runs);
    out.cards.push(...log.cards);
    out.broken += log.broken;
  }
  return out;
}

/** Cards closed on the page with no card answer: never labelled, so printed apart. */
async function closedWithNoAnswer(wikis: readonly { wiki: string; root: string }[]): Promise<number> {
  let n = 0;
  for (const { wiki, root } of wikis) {
    const index = await getWikiIndex({ root, refresh: true });
    if (!index) continue;
    const answered = new Set((await listWikiAnswerHistory(wiki)).map((v) => `${v.relPath}\0${v.questionId}`));
    for (const meta of index.pages) {
      if (!/\.mdx?$/i.test(meta.relPath)) continue;
      const text = await readWikiPage(index, meta);
      if (!text?.includes("<Question")) continue;
      for (const id of closedQuestionIds(parseBlocks(splitFrontmatter(text).body))) {
        if (!answered.has(`${meta.relPath}\0${id}`)) n++;
      }
    }
  }
  return n;
}

async function printNightly(log: ParsedLog, labelled: readonly WikiLabels[], wikis: readonly { wiki: string; root: string }[]): Promise<void> {
  const current = currentLog(log);
  const nights = nightsOf(current.runs, current.cards, Date.now(), todayNightDue(Date.now(), config.workMapHour));
  const shares = nightlyShares(nights);
  const tally: Record<string, number> = { ok: 0, partial: 0, refused: 0, failed: 0, absent: 0 };
  for (const n of nights) tally[n.outcome]!++;
  console.log(`nights: ${JSON.stringify(tally)}${log.broken ? `; ${log.broken} broken line(s) skipped` : ""}; ${current.olderLines} line(s) of older prompt versions left out`);
  for (const n of nights) console.log(`  ${n.day} ${n.wiki}: ${n.outcome} ${JSON.stringify(n.kinds)}`);
  console.log(`nightly median share: ASK_OWNER ${shares.askOwnerMedian}, ASK_OWNER+ASK_OTHER ${shares.askAnyMedian}, over ${shares.nights} night(s)`);
  const flips = verdictFlips(current.cards);
  console.log(`verdict flips: ${flips.flips} across ${flips.cardsFlipped} of ${flips.cards} card(s) with two or more nights`);
  const answers = labelled.flatMap(({ wiki, labelled: rows }) => rows.map((l) => ({ wiki, relPath: l.settled.relPath, id: l.settled.id, firstAt: l.settled.firstAt, added: l.added })));
  const catches = nightlyCatches(answers, current.cards);
  console.log(`nightly catches on cards that waited a night (no bar): ${catches.caught} of ${catches.addedWaited}, over ${catches.waited} labelled`);
  console.log(`SETTLED or VOID later answered (counts against the verdict): ${catches.settledThenAnswered}`);
  const byPage = new Map<string, number>();
  for (const a of answers) if (a.added) byPage.set(a.relPath, (byPage.get(a.relPath) ?? 0) + 1);
  console.log(`positives by page: ${[...byPage.values()].sort((a, b) => b - a).join(", ") || "none"} on ${byPage.size} page(s)`);
  const coded = current.cards.filter((c) => c.codeFacts !== undefined);
  console.log(`cards with code facts: ${coded.filter((c) => c.codeFacts).length} of ${coded.length} card lines`);
  const d = droppedOf(labelled);
  console.log(`not scored: ${d.afterAnswer} on a card first committed after its answer, ${d.hashMismatch} whose hash does not match the page at that commit, ${await closedWithNoAnswer(wikis)} closed on the page with no card answer`);
  console.log(droppedLine(d));
}

const droppedLine = (d: Dropped) => `answers with no card in git: ${d.noHistory} no-history, ${d.unreadable} whose history could not be read`;

async function modePart2(): Promise<number> {
  const hand = values.hand ? parseHandSample(await readFile(path.resolve(values.hand), "utf8").catch(() => "not a file")) : null;
  const scope = await readScope();
  const faults = faultsOf(scope);
  if (faults.length > 0) throw new ReplayRefused(faults.join("; "));
  const wikis = asRoots(scope.covered);
  const names = wikis.map((w) => w.wiki);
  if (!config.decisionTriageRepoRoots) throw new ReplayRefused("DECISION_TRIAGE_REPO_ROOTS is not set");
  const log = await nightlyLogs(names);
  const windowMs = answerWindowMs(log.runs);
  if (sinceAfterWindow(values.since!, windowMs)) throw new UsageError(`--since ${values.since} is later than this prompt's window, which starts ${new Date(windowMs).toISOString()}; the floor on the run line counts from there`);
  const dryRun = values["dry-run"] === true;
  const recordFile = scoringRecordPath(logDir);
  const records = parseScoringRecords(await readScoringText(recordFile));
  const nowMs = Date.now();
  const day = part2Day(log.runs, nowMs);
  const gate = scoringGate(records, day);
  // All before the answers are read: a refusal reads no label and writes no record.
  if (!dryRun && !gate.allowed) {
    if (hand && gate.amend) {
      const amended = amendWithHand(gate.amend, hand, nowMs);
      await appendLogLines(recordFile, [amended.record]);
      console.log(amended.headline.line);
      for (const note of amended.headline.notes) console.log(note);
      return 0;
    }
    console.error(gate.line);
    return 2;
  }
  const finalEarly = !dryRun && values.final ? finalRefusal(day) : null;
  if (finalEarly) {
    console.error(finalEarly);
    return 2;
  }
  const labelled = await labelsSince(wikis, windowMs, listWikiAnswerHistory, realGit);
  // A wiki whose history cannot be read would otherwise read as no answers at all.
  const historyFaults = labelled.flatMap((w) => w.fault ?? []);
  if (historyFaults.length > 0) throw new ReplayRefused(historyFaults.join("; "));
  console.log(droppedLine(droppedOf(labelled)));
  const todayCounts = todayNightDue(nowMs, config.workMapHour);
  if (dryRun) {
    const plan = part2Plan(labelled, log, nowMs, todayCounts);
    const counts = replayCounts(await gatherReplay(plan.cards, replayDeps(scope.covered)));
    const wouldStop = !gate.allowed ? gate.line : plan.stop?.line;
    console.log(JSON.stringify({ mode: "since --dry-run", ...(wouldStop ? { wouldStopAt: wouldStop } : {}), day: plan.day, floor: plan.floor, dropped: plan.dropped, context: plan.context, ...counts }, null, 1));
    return 0;
  }
  const { plan, headline, scored } = await runPart2({
    wikis: labelled,
    log,
    nowMs,
    todayCounts,
    hand,
    final: values.final === true,
    records,
    record: (r) => appendLogLines(recordFile, [r]),
    replay: (cards) => modelReplay(cards, scope.covered),
  });
  if (headline.result === "refused") {
    console.error(headline.line);
    return 2;
  }
  console.log(headline.line);
  for (const note of headline.notes) console.log(note);
  if (!scored) console.log("no model call: this headline needs no verdict.");
  if (scored) printReport(scored.report);
  await printNightly(log, labelled, wikis);
  if (scored) await printHandSample(plan.cards, scored.lines, scored.report, values.final === true || headline.result === "pass" || (plan.day ?? 0) >= CAP_DAY, wikis);
  return 0;
}

/** Which replayed cards are done as of today: each page and answer list read now. */
async function doneToday(cards: readonly ReplayCard[], wikis: readonly { wiki: string; root: string }[]): Promise<Set<string>> {
  const done = new Set<string>();
  for (const { wiki, root } of wikis) {
    const mine = cards.filter((c) => c.wiki === wiki);
    if (mine.length === 0) continue;
    const index = await getWikiIndex({ root, refresh: true });
    const versions = await listWikiAnswerHistory(wiki);
    for (const card of mine) {
      const meta = index?.pages.find((p) => p.relPath === card.relPath);
      const text = index && meta ? await readWikiPage(index, meta) : null;
      if (cardDoneToday(card, text, versions, answerConfig.owner)) done.add(replayKey(card));
    }
  }
  return done;
}

/** The cards to read by hand. A replayed card may still be open: its first answer can
 *  be a not-sure, text only or a colleague's, so `handSample` takes done cards alone. */
async function printHandSample(cards: readonly ReplayCard[], lines: ReadonlyMap<string, CardLine>, report: ReplayReport, final: boolean, wikis: readonly { wiki: string; root: string }[]): Promise<void> {
  const done = await doneToday(cards, wikis);
  for (const { kind, total, rows } of handSample(cards, lines, (c) => done.has(replayKey(c)), final)) {
    console.log(`hand sample, ${kind}: ${total} card(s)`);
    for (const r of rows) console.log(`  ${r.wiki} ${r.relPath} ${r.id}: ${r.why ?? ""}`);
  }
  console.log(`hand sample leaves out ${cards.length - done.size} replayed card(s) still open today`);
  if (final) {
    console.log(`catches by verdict: ASK_OWNER ${report.catchesBy.ASK_OWNER}, ASK_OTHER ${report.catchesBy.ASK_OTHER}`);
    console.log(`control, flag every ${FLAGGING_RULE_WIKI} card: ${fmt(report.rule)}, share ${report.rule.sharePct}%`);
  }
}

/** The wikis a read-only report covers: a fault is printed, and the rest still report. */
async function reportWikis(): Promise<{ wiki: string; root: string }[]> {
  const scope = await readScope();
  for (const fault of faultsOf(scope)) console.error(`left out: ${fault}`);
  return asRoots(scope.covered);
}

const printHistoryFaults = (read: readonly WikiLabels[]) => {
  for (const w of read) if (w.fault) console.error(`left out: ${w.fault}`);
};

async function modeLabels(): Promise<number> {
  const wikis = await reportWikis();
  const untilMs = untilArg !== null ? untilArg : Date.parse((JSON.parse(await readFile(DEFAULT_BASELINE, "utf8")) as { answersUntil: string }).answersUntil);
  for (const [label, windowMs] of [["with the 10-minute rule", SETTLE_WINDOW_MS], ["without it", 0]] as const) {
    const read = await labelsSince(wikis, 0, listWikiAnswerHistory, realGit, { windowMs, untilMs });
    printHistoryFaults(read);
    const rows = read.flatMap((w) => w.labelled);
    const added = rows.filter((r) => r.added === true).length;
    const other = rows.filter((r) => r.added === false).length;
    const statuses: Record<string, number> = {};
    for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    console.log(`${label}: ${added} added, ${other} other, ${rows.length - added - other} no label; ${rows.length} questions; ${JSON.stringify(statuses)}`);
  }
  return 0;
}

initDb(config);
let exit = 0;
try {
  if (values.replay) exit = await modePart1();
  else if (sinceArg !== null) exit = await modePart2();
  else if (values.labels) exit = await modeLabels();
  else {
    const wikis = await reportWikis();
    const log = await nightlyLogs(wikis.map((w) => w.wiki));
    const read = await labelsSince(wikis, answerWindowMs(log.runs), listWikiAnswerHistory, realGit);
    printHistoryFaults(read);
    await printNightly(log, read, wikis);
  }
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`usage error: ${err.message}. ${USAGE}`);
  } else if (err instanceof ReplayRefused) {
    console.error(`REFUSED: ${err.message}. This is a setup fault, not a result.`);
  } else throw err;
  exit = 2;
} finally {
  await closeDb();
}
process.exit(exit);
