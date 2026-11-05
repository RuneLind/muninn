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
 * `--root <wiki>=<path>` (repeatable) names a wiki's root; `--log-dir <dir>` moves
 * the logs. Both replays refuse without DECISION_TRIAGE_REPO_ROOTS. From a worktree,
 * run with `bun --env-file <checkout>/.env`.
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
import { frozenAfterMs, labelsSince, type WikiLabels } from "../src/wiki/decision-triage/floor.ts";
import { realGit } from "../src/wiki/decision-triage/git.ts";
import { appendLogLines, DECISION_TRIAGE_DIR, nightlyLogPath, readLog, replayLogPath, type ParsedLog } from "../src/wiki/decision-triage/log.ts";
import { gatherReplay, replayCounts, replayKey, ReplayRefused, runReplay, type ReplayDeps } from "../src/wiki/decision-triage/replay.ts";
import { realDecisionTriageModel } from "../src/wiki/decision-triage/run.ts";
import { DECISION_TRIAGE_PROMPT_VERSION, type CardLine } from "../src/wiki/decision-triage/schema.ts";
import {
  floorOf,
  nightlyCatches,
  nightlyShares,
  nightsOf,
  part1Headline,
  part2Headline,
  replayReport,
  SETTLE_WINDOW_MS,
  verdictFlips,
  type ReplayReport,
  type ScoredItem,
} from "../src/wiki/decision-triage/score.ts";
import { rootOverrides, triageEntries } from "../src/wiki/decision-triage/script-roots.ts";
import { closedQuestionIds } from "../src/format/question.ts";
import { getWikiIndex, readWikiPage } from "../src/wiki/store.ts";
import { parseBlocks } from "../src/format/markdown-ast.ts";
import { splitFrontmatter } from "../src/wiki/page-text.ts";

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

const DEFAULT_BASELINE = path.join(homedir(), ".muninn", "decision-triage", "baseline-2026-11-04.json");
const SAMPLE_PER_KIND = 5;

const config = loadConfig();
const answerConfig = resolveWikiAnswerConfig();
const overrides = rootOverrides(values.root ?? []);
const logDir = values["log-dir"] ? path.resolve(values["log-dir"]) : DECISION_TRIAGE_DIR;
const wikiNames = () => [...new Set([...config.workMapWikis.map((w) => w.toLowerCase())].filter((w) => answerConfig.wikis.has(w)))];
const entriesFor = (names: readonly string[]) => triageEntries(overrides, names).map((e) => ({ wiki: e.name, root: e.root }));

function replayDeps(wikis: readonly string[]): ReplayDeps {
  return {
    roots: new Map(entriesFor(wikis).map((e) => [e.wiki, e.root])),
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

async function modelReplay(cards: readonly ReplayCard[], wikis: readonly string[]): Promise<Map<string, CardLine>> {
  const gathered = await gatherReplay(cards, replayDeps(wikis));
  const file = replayLogPath(DECISION_TRIAGE_PROMPT_VERSION, logDir);
  const { cards: existing } = await readLog(file);
  const { lines, usage } = await runReplay(gathered, {
    call: realDecisionTriageModel(config),
    model: config.workMapModel,
    ...(config.workMapEffort ? { effort: config.workMapEffort } : {}),
    existing,
    append: (l) => appendLogLines(file, l),
    now: Date.now,
    repoRoots: config.decisionTriageRepoRoots,
  });
  console.log(`replay: ${gathered.items.length} cards, ${gathered.refused.length} refused, ${gathered.oversized.length} over the limit; usage ${JSON.stringify(usage)}; log ${file}`);
  return lines;
}

async function modePart1(): Promise<number> {
  const text = await readFile(path.resolve(values.baseline ?? DEFAULT_BASELINE), "utf8");
  const { cards, unreplayable } = readBaselineCards(text);
  const wikis = [...new Set(cards.map((c) => c.wiki))];
  if (values["dry-run"]) {
    const counts = replayCounts(await gatherReplay(cards, replayDeps(wikis)));
    console.log(JSON.stringify({ mode: "replay --dry-run", unreplayable, ...counts }, null, 1));
    return 0;
  }
  const lines = await modelReplay(cards, wikis);
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

/** Part (2)'s cards: first answered since `sinceMs`, with a commit holding the answered wording. */
function sinceCards(wikis: readonly WikiLabels[]): ReplayCard[] {
  return wikis.flatMap(({ wiki, labelled }) =>
    labelled
      .filter((l) => l.status === "ok" && l.commit !== null)
      .map((l) => ({
        wiki,
        relPath: l.settled.relPath,
        id: l.settled.id,
        answeredAt: new Date(l.settled.firstAt).toISOString(),
        commit: l.commit!,
        hashMatches: true,
        replayable: true as const,
      })),
  );
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
  const nights = nightsOf(log.runs, log.cards, Date.now());
  const shares = nightlyShares(nights);
  const tally: Record<string, number> = { ok: 0, partial: 0, refused: 0, failed: 0, absent: 0 };
  for (const n of nights) tally[n.outcome]!++;
  console.log(`nights: ${JSON.stringify(tally)}${log.broken ? `; ${log.broken} broken line(s) skipped` : ""}`);
  for (const n of nights) console.log(`  ${n.day} ${n.wiki}: ${n.outcome} ${JSON.stringify(n.kinds)}`);
  console.log(`nightly median share: ASK_OWNER ${shares.askOwnerMedian}, ASK_OWNER+ASK_OTHER ${shares.askAnyMedian}, over ${shares.nights} wiki-night(s)`);
  const flips = verdictFlips(log.cards);
  console.log(`verdict flips: ${flips.flips} across ${flips.cardsFlipped} of ${flips.cards} card(s) with two or more nights`);
  const answers = labelled.flatMap(({ wiki, labelled: rows }) => rows.map((l) => ({ wiki, relPath: l.settled.relPath, id: l.settled.id, firstAt: l.settled.firstAt, added: l.added })));
  const catches = nightlyCatches(answers, log.cards);
  console.log(`nightly catches on cards that waited a night (no bar): ${catches.caught} of ${catches.addedWaited}, over ${catches.waited} labelled`);
  console.log(`SETTLED or VOID later answered (counts against the verdict): ${catches.settledThenAnswered}`);
  const byPage = new Map<string, number>();
  for (const a of answers) if (a.added) byPage.set(a.relPath, (byPage.get(a.relPath) ?? 0) + 1);
  console.log(`positives by page: ${[...byPage.values()].sort((a, b) => b - a).join(", ") || "none"} on ${byPage.size} page(s)`);
  const coded = log.cards.filter((c) => c.codeFacts !== undefined);
  console.log(`cards with code facts: ${coded.filter((c) => c.codeFacts).length} of ${coded.length} card lines`);
  const counts = { after: 0, mismatch: 0 };
  for (const { labelled: rows } of labelled) {
    for (const r of rows) {
      if (r.status === "after-answer" || r.status === "no-history") counts.after++;
      if (r.status === "hash-mismatch") counts.mismatch++;
    }
  }
  console.log(`not scored: ${counts.after} on a card first committed after its answer, ${counts.mismatch} whose hash does not match the page at that commit, ${await closedWithNoAnswer(wikis)} closed on the page with no card answer`);
}

async function modePart2(): Promise<number> {
  const sinceArg = Date.parse(`${values.since}T00:00:00Z`);
  if (!Number.isFinite(sinceArg)) throw new Error(`--since takes a day (YYYY-MM-DD), got ${values.since}`);
  const sinceMs = Math.max(sinceArg, frozenAfterMs());
  const names = wikiNames();
  const wikis = entriesFor(names);
  if (wikis.length !== names.length) throw new ReplayRefused(`a wiki's root is missing: pass --root for each of ${names.join(", ")}`);
  if (!config.decisionTriageRepoRoots) throw new ReplayRefused("DECISION_TRIAGE_REPO_ROOTS is not set");
  const labelled = await labelsSince(wikis, sinceMs, listWikiAnswerHistory, realGit);
  const cards = sinceCards(labelled);
  if (values["dry-run"]) {
    const counts = replayCounts(await gatherReplay(cards, replayDeps(names)));
    console.log(JSON.stringify({ mode: "since --dry-run", ...counts }, null, 1));
    return 0;
  }
  const lines = await modelReplay(cards, names);
  const byCard = new Map(labelled.flatMap(({ wiki, labelled: rows }) => rows.map((l) => [`${wiki}\0${l.settled.relPath}\0${l.settled.id}`, l] as const)));
  const items: ScoredItem[] = cards.flatMap((c) => {
    const l = byCard.get(`${c.wiki}\0${c.relPath}\0${c.id}`);
    if (!l || l.added === null) return [];
    return [{ wiki: c.wiki, relPath: c.relPath, id: c.id, added: l.added, verdict: lines.get(replayKey(c))?.verdict }];
  });
  const report = replayReport(items);
  const floor = floorOf(items.map((i) => ({ wiki: i.wiki, relPath: i.relPath, added: i.added })));
  const log = await nightlyLogs(names);
  const started = log.runs.filter((r) => r.outcome === "ok" || r.outcome === "partial").map((r) => r.at);
  const day = started.length ? Math.floor((Date.now() - Math.min(...started)) / 86_400_000) : null;
  const handFile = values.hand ? (JSON.parse(await readFile(path.resolve(values.hand), "utf8")) as { read: number; wrong: number }) : null;
  // A `SETTLED` or `VOID` later answered counts against the verdict, as a wrong read does.
  const later = nightlyCatches(labelled.flatMap(({ wiki, labelled: rows }) => rows.map((l) => ({ wiki, relPath: l.settled.relPath, id: l.settled.id, firstAt: l.settled.firstAt, added: l.added }))), log.cards).settledThenAnswered;
  const headline = part2Headline({ report, floor, day, shares: nightlyShares(nightsOf(log.runs, log.cards, Date.now())), handRead: handFile?.read ?? null, handWrong: handFile ? handFile.wrong + later : later });
  console.log(headline.line);
  for (const note of headline.notes) console.log(note);
  printReport(report);
  await printNightly(log, labelled, wikis);
  printHandSample(cards, lines, values.final === true);
  return 0;
}

/** Cards to read by hand, from replayed cards, which were all answered. An open
 *  card's verdict is never in this set. */
function printHandSample(cards: readonly ReplayCard[], lines: ReadonlyMap<string, CardLine>, final: boolean): void {
  const rows = cards.flatMap((c) => {
    const line = lines.get(replayKey(c));
    return line ? [line] : [];
  });
  const kinds = final ? ["SETTLED", "VOID", "DEFAULT", "ASK_OWNER", "ASK_OTHER"] : ["SETTLED", "VOID"];
  for (const kind of kinds) {
    const sample = rows.filter((r) => r.verdict === kind);
    console.log(`hand sample, ${kind}: ${sample.length} card(s)`);
    for (const r of sample.slice(0, kind === "SETTLED" || kind === "VOID" ? sample.length : SAMPLE_PER_KIND)) console.log(`  ${r.wiki} ${r.relPath} ${r.id}: ${r.why ?? ""}`);
  }
}

async function modeLabels(): Promise<number> {
  const names = wikiNames();
  const wikis = entriesFor(names);
  const untilMs = values.until ? Date.parse(values.until) : Date.parse((JSON.parse(await readFile(DEFAULT_BASELINE, "utf8")) as { answersUntil: string }).answersUntil);
  for (const [label, windowMs] of [["with the 10-minute rule", SETTLE_WINDOW_MS], ["without it", 0]] as const) {
    const rows = (await labelsSince(wikis, 0, listWikiAnswerHistory, realGit, { windowMs, untilMs })).flatMap((w) => w.labelled);
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
  else if (values.since) exit = await modePart2();
  else if (values.labels) exit = await modeLabels();
  else {
    const names = wikiNames();
    const wikis = entriesFor(names);
    await printNightly(await nightlyLogs(names), await labelsSince(wikis, frozenAfterMs(), listWikiAnswerHistory, realGit), wikis);
  }
} catch (err) {
  if (!(err instanceof ReplayRefused)) throw err;
  console.error(`REFUSED: ${err.message}. This is a setup fault, not a result.`);
  exit = 2;
} finally {
  await closeDb();
}
process.exit(exit);
