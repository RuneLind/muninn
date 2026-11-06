/**
 * One pass over one wiki: repos resolved first, a line for every card in scope,
 * tool-less model calls in batches, and everything appended through a sink. The
 * run writes no wiki page and takes no write lock (D3). A batch that fails makes
 * the night `partial` and keeps what landed; only a night with no verdicts at all
 * is `failed`, including one a throw or the pass's bound cut short (`TriageProgress`).
 */

import { randomUUID } from "node:crypto";
import { resolveFencedAgentCwd } from "../../ai/agent-cwd.ts";
import { extractJson } from "../../ai/json-extract.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { Config, WorkMapEffort } from "../../config.ts";
import { runFencedOneShot } from "../../core/fenced-one-shot.ts";
import type { WikiAnswerVersion } from "../../db/wiki-answers.ts";
import { getLog } from "../../logging.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import type { WikiIndex, WikiPageMeta } from "../store.ts";
import type { ModelReply, ModelRequest } from "../work-map/run.ts";
import { WORK_MAP_SPAWN_ARGS, WORK_MAP_TIMEOUT_MS } from "../work-map/run.ts";
import { collectOpenCards } from "./cards.ts";
import { answeredByChoice, gatherCardFacts, gatherPageFacts, liveAnswers, liveView, type GatherContext, type PageFacts, type PageRead } from "./facts.ts";
import { parseRepoRoots, resolveRepo, type GitRun, type ResolvedRepo, type RepoRoots } from "./git.ts";
import { buildBatches, TRIAGE_SYSTEM_PROMPT, type Batch, type BatchItem } from "./prompt.ts";
import {
  answerSchema,
  DECISION_TRIAGE_PROMPT_VERSION,
  MODEL_OFF_MODEL,
  MODEL_OFF_VERSION,
  verdictSchema,
  type CardLine,
  type FloorState,
  type LogLine,
  type RepoFact,
  type RunLine,
  type RunOutcome,
  type TriageUsage,
  type Verdict,
} from "./schema.ts";
import { parseRecommendation, type ParsedQuestion } from "../../format/question.ts";
import { sha256 } from "../../gardener/util.ts";

const log = getLog("wiki", "decision-triage");

/** One card's facts get this long, so one stuck repo costs one card. */
const CARD_GATHER_TIMEOUT_MS = 90_000;
/** Stop gathering past this (the 10-02 kernel panic was a corpus script). */
const RSS_GUARD_BYTES = 3 * 1024 ** 3;

export function decisionTriageBotConfig(opts: { model: string; effort?: WorkMapEffort; dir: string }): BotConfig {
  return {
    name: "decision-triage",
    dir: opts.dir,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    connector: "claude-cli",
    model: opts.model,
    toolSurface: "none",
    timeoutMs: WORK_MAP_TIMEOUT_MS,
    spawnArgs: [...WORK_MAP_SPAWN_ARGS],
    spawnEnvOmit: ["MAX_THINKING_TOKENS"],
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
}

/** The real call, under its own trace root and `/agents` run. Night and replay share it. */
export function realDecisionTriageModel(config: Config, seams: Pick<Parameters<typeof runFencedOneShot>[0], "oneShot" | "tracer"> = {}) {
  return async (req: ModelRequest): Promise<ModelReply> => {
    const result = await runFencedOneShot({
      traceName: "decision-triage",
      platform: "wiki",
      kind: "decision_triage",
      phase: "organizing",
      runName: `Decision triage: ${req.wiki}`,
      sourcePage: `/wiki?wiki=${encodeURIComponent(req.wiki)}`,
      source: "decision-triage",
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
      config,
      botConfig: decisionTriageBotConfig({ model: req.model, effort: req.effort, dir: resolveFencedAgentCwd() }),
      timeoutMs: WORK_MAP_TIMEOUT_MS,
      thinkingMaxTokens: null,
      startAttrs: { wiki: req.wiki, promptChars: req.prompt.length },
      ...seams,
    });
    return {
      text: result.result,
      model: result.model,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  };
}

export type TriageModel = (req: ModelRequest) => Promise<ModelReply>;

function addUsage(total: TriageUsage, reply: ModelReply): void {
  total.calls++;
  for (const key of ["costUsd", "durationMs", "inputTokens", "outputTokens"] as const) {
    const v = reply[key];
    if (v !== undefined) total[key] = (total[key] ?? 0) + v;
  }
}

/** A batch's answer by its short card ids. A malformed entry or a whole answer
 *  that does not parse leaves its cards with no verdict. */
export function parseVerdicts(text: string): { verdicts: Map<string, Verdict>; invalid: Set<string> } {
  const raw = answerSchema.parse(extractJson<unknown>(text));
  const verdicts = new Map<string, Verdict>();
  const invalid = new Set<string>();
  for (const entry of raw.verdicts) {
    const parsed = verdictSchema.safeParse(entry);
    if (parsed.success) verdicts.set(parsed.data.card, parsed.data);
    else {
      const card = (entry as { card?: unknown } | null)?.card;
      if (typeof card === "string") invalid.add(card);
    }
  }
  return { verdicts, invalid };
}

export interface BatchResult {
  batch: Batch;
  verdicts: (Verdict | null)[];
  failed?: string;
  /** Items whose verdict came back and did not parse. */
  malformed?: ReadonlySet<number>;
}

const MALFORMED = "a malformed verdict";
const MISSING = "missing from the answer";
/** D19's stop trigger (mimir plans/muninn-wiki-decision-triage.mdx): 6 of the 8 positives
 *  the gate needed, so the night gathers and logs, and asks no model. */
export const MODEL_OFF = "the model call is off (D19)";

/** Why item `i` of a batch has no verdict. */
export const noVerdictReason = (r: BatchResult, i: number) => (r.failed ? "the batch failed" : r.malformed?.has(i) ? MALFORMED : MISSING);

/** Call one batch; never throws. */
export async function callBatch(wiki: string, batch: Batch, opts: { model: string; effort?: WorkMapEffort; call: TriageModel }, usage: TriageUsage): Promise<BatchResult> {
  try {
    const reply = await opts.call({
      wiki,
      prompt: batch.prompt,
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort } : {}),
    });
    addUsage(usage, reply);
    const { verdicts, invalid } = parseVerdicts(reply.text);
    const malformed = new Set(batch.items.flatMap((_, i) => (invalid.has(`c${i + 1}`) ? [i] : [])));
    return { batch, verdicts: batch.items.map((_, i) => verdicts.get(`c${i + 1}`) ?? null), malformed };
  } catch (err) {
    return { batch, verdicts: batch.items.map(() => null), failed: err instanceof Error ? err.message : String(err) };
  }
}

export function verdictFields(v: Verdict): Pick<CardLine, "verdict" | "costOfDelay" | "reversible" | "onlyOwnerHas" | "why" | "evidence" | "restsOnPrs"> {
  return {
    verdict: v.verdict,
    costOfDelay: v.costOfDelay,
    reversible: v.reversible,
    onlyOwnerHas: v.onlyOwnerHas,
    why: v.why,
    evidence: v.evidence,
    restsOnPrs: v.restsOnPrs,
  };
}

export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export const overRss = () => process.memoryUsage().rss > RSS_GUARD_BYTES;

/** A per-run repo resolver: one fetch per repo however many cards name it. */
export function repoResolver(roots: RepoRoots, git: GitRun, opts: { fetch: boolean }) {
  const memo = new Map<string, Promise<ResolvedRepo>>();
  return {
    repo: (name: string) => {
      let held = memo.get(name);
      if (!held) {
        held = resolveRepo(name, roots, git, opts);
        memo.set(name, held);
      }
      return held;
    },
    facts: async (): Promise<RepoFact[]> => {
      const names = [...memo.keys()];
      const settled = await Promise.allSettled(memo.values());
      return settled.map((r, i) => (r.status === "fulfilled" ? r.value.fact : { repo: names[i]!, found: false, reason: "could not be resolved" }));
    },
  };
}

/** What a pass has done so far, live, for the failure path when it throws or hits its
 *  bound. `usage` counts calls answered, so one still in flight is not in it. */
export interface TriageProgress {
  runId: string;
  at: number;
  usage: TriageUsage;
  repos: RepoFact[];
  /** Open cards in scope, once read. */
  open: number | null;
  cardsLogged: number;
  verdicts: number;
  /** What this pass's lines carry: the prompt's, or `MODEL_OFF_*` with the call off. */
  promptVersion: string;
  model: string;
}

export interface TriageRunDeps {
  entry: WikiRegistryEntry;
  now: () => number;
  repoRoots: string | null;
  model: string;
  effort?: WorkMapEffort;
  /** Null: gather and log every card, ask no model (`MODEL_OFF`). */
  call: TriageModel | null;
  git: GitRun;
  /** The rebuilt index, or null when it cannot be read. */
  loadIndex: () => Promise<WikiIndex | null>;
  readFile: (absPath: string) => Promise<string | null>;
  /** Every version of every answer in this wiki. */
  answers: () => Promise<WikiAnswerVersion[]>;
  owner: string | null;
  groups: GatherContext["groups"];
  /** The run's sink: the nightly log, or `--out`. */
  append: (lines: readonly LogLine[]) => Promise<void>;
  /** The floor's state for the run line; `startedAt` is this run's own line. */
  floor?: (startedAt: number) => Promise<FloorState>;
  signal?: AbortSignal;
  /** Handed the run's live progress before anything is spent. */
  track?: (progress: TriageProgress) => void;
}

export type TriageRunResult =
  | { outcome: Exclude<RunOutcome, "refused">; run: RunLine; counts: Record<string, number>; wallMs: number }
  | { outcome: "refused"; run: RunLine; reason: string; counts: Record<string, number>; wallMs: number }
  | { outcome: "aborted" };

/** Run one pass, in order: read the cards, resolve their repos, log the cards
 *  that take no model call, gather, then call in batches. */
export async function runDecisionTriage(deps: TriageRunDeps): Promise<TriageRunResult> {
  const startedAt = deps.now();
  const runId = randomUUID();
  const wiki = deps.entry.name;
  const usage: TriageUsage = { calls: 0 };
  const promptVersion = deps.call ? DECISION_TRIAGE_PROMPT_VERSION : MODEL_OFF_VERSION;
  const model = deps.call ? deps.model : MODEL_OFF_MODEL;
  const progress: TriageProgress = { runId, at: startedAt, usage, repos: [], open: null, cardsLogged: 0, verdicts: 0, promptVersion, model };
  deps.track?.(progress);
  const counts: Record<string, number> = {};
  const roots = parseRepoRoots(deps.repoRoots);
  const resolver = repoResolver(roots, deps.git, { fetch: true });

  /** Null when a stop came in while the floor was read: no line then. */
  const finish = async (outcome: RunOutcome, cards: number, reason?: string): Promise<RunLine | null> => {
    let floor: FloorState | null = null;
    if (deps.floor) {
      try {
        floor = await deps.floor(startedAt);
      } catch (err) {
        floor = { labelled: 0, added: 0, addedPages: 0, met: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (deps.signal?.aborted) return null;
    const run: RunLine = {
      type: "run",
      runId,
      at: startedAt,
      wiki,
      model,
      promptVersion,
      usage,
      repoRoots: deps.repoRoots,
      repos: await resolver.facts(),
      cards,
      floor,
      outcome,
      ...(reason ? { reason } : {}),
    };
    await deps.append([run]);
    return run;
  };
  // A stop is no refusal: no line, and no failure against the day's count.
  const refuse = async (reason: string): Promise<TriageRunResult> => {
    const run = await finish("refused", 0, reason);
    if (!run) return { outcome: "aborted" };
    log.warn("Decision triage refused for {wiki}: {reason}", { wiki, reason });
    return { outcome: "refused", reason, run, counts, wallMs: deps.now() - startedAt };
  };

  // Nothing is spent yet, so a throw here is a refusal and retries at the next check.
  let index: WikiIndex;
  let versions: WikiAnswerVersion[];
  let open: Awaited<ReturnType<typeof collectOpenCards>>;
  try {
    const loaded = await deps.loadIndex();
    if (!loaded) return refuse("the wiki index could not be read");
    index = loaded;
    // No page at all is a wrong root, never a quiet night. Pages with no open card are one.
    if (!index.pages.some((p) => /\.mdx?$/i.test(p.relPath))) return refuse("the wiki has no pages");
    versions = await deps.answers();
    open = await collectOpenCards(index, (meta: WikiPageMeta) => deps.readFile(`${index.root}/${meta.relPath}`));
    if (open.inScope > 0 && open.readable === 0) return refuse(`none of its ${open.inScope} page(s) could be read`);
  } catch (err) {
    return refuse(`the cards could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { pages, cards } = open;
  progress.open = cards.length;
  if (deps.signal?.aborted) return { outcome: "aborted" };

  // Repos before anything is spent. A setup fault is no verdict on any card.
  const names = new Set(pages.flatMap((p) => p.repos));
  let resolved: ResolvedRepo[];
  try {
    resolved = await Promise.all([...names].map((n) => resolver.repo(n)));
  } catch (err) {
    return refuse(`the repos could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
  }
  progress.repos = resolved.map((r) => r.fact);
  if (cards.length > 0 && names.size > 0 && !resolved.some((r) => r.fact.found)) return refuse("no-repo");

  const view = liveView(index, deps.readFile);
  const byPage = new Map<string, PageRead>(pages.map((p) => [p.relPath, p]));
  const ctx: GatherContext = { git: deps.git, repo: resolver.repo, answers: versions, owner: deps.owner, groups: deps.groups };
  const line = (fields: Omit<CardLine, "type" | "runId" | "at" | "wiki" | "promptVersion">): CardLine => {
    counts[fields.verdict] = (counts[fields.verdict] ?? 0) + 1;
    return { type: "card", runId, at: startedAt, wiki, promptVersion, ...fields };
  };
  const base = (relPath: string, id: string) => {
    const q = byPage.get(relPath)!.page.questions.find((x) => x.id === id)!;
    return { relPath, id, questionHash: sha256(q.hashInput) };
  };

  const appendCards = async (lines: readonly CardLine[]) => {
    await deps.append(lines);
    progress.cardsLogged += lines.length;
    progress.verdicts += lines.filter((l) => l.verdict !== "ANSWERED" && l.verdict !== "NO_VERDICT").length;
  };

  const items: BatchItem[] = [];
  const held: CardLine[] = [];
  const pageFacts = new Map<string, PageFacts>();
  let noFacts = 0;
  for (const { relPath, id } of cards) {
    if (deps.signal?.aborted) return { outcome: "aborted" };
    const read = byPage.get(relPath)!;
    const { questionHash } = base(relPath, id);
    if (answeredByChoice(liveAnswers(versions, relPath, id, questionHash, null))) {
      const q = read.page.questions.find((x) => x.id === id)!;
      held.push(line({ ...base(relPath, id), recommendation: recommendationOf(q), verdict: "ANSWERED" }));
      continue;
    }
    if (overRss()) {
      noFacts++;
      held.push(line({ ...base(relPath, id), recommendation: recommendationOf(read.page.questions.find((x) => x.id === id)!), verdict: "NO_VERDICT", reason: "the memory guard stopped the gather" }));
      continue;
    }
    try {
      const gathered = await withTimeout(gatherCardFacts({ wiki, relPath, id, answeredAt: null, commit: null }, read, view, ctx), CARD_GATHER_TIMEOUT_MS, "the facts");
      let page = pageFacts.get(relPath);
      if (!page) {
        page = await gatherPageFacts(read, view);
        pageFacts.set(relPath, page);
      }
      items.push({ gathered, page });
    } catch (err) {
      noFacts++;
      held.push(line({ ...base(relPath, id), recommendation: recommendationOf(read.page.questions.find((x) => x.id === id)!), verdict: "NO_VERDICT", reason: `facts: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  if (deps.signal?.aborted) return { outcome: "aborted" };
  await appendCards(held);

  if (deps.call === null) {
    await appendCards(items.map((item) => line({ ...lineBase(item), verdict: "NO_VERDICT", reason: MODEL_OFF })));
    const why = [MODEL_OFF, ...(noFacts > 0 ? [`${noFacts} card(s) with no facts`] : [])].join(", ");
    const run = await finish(noFacts > 0 ? "partial" : "ok", cards.length, why);
    if (!run) return { outcome: "aborted" };
    return { outcome: run.outcome as Exclude<RunOutcome, "refused">, run, counts, wallMs: deps.now() - startedAt };
  }
  const call = deps.call;
  const { batches, oversized } = buildBatches(wiki, items);
  await appendCards(oversized.map((o) => line({ ...lineBase(o), verdict: "NO_VERDICT", reason: "over the call's size limit" })));

  let batchFailures = 0;
  let malformed = 0;
  let missing = 0;
  for (const batch of batches) {
    if (deps.signal?.aborted) return { outcome: "aborted" };
    const result = await callBatch(wiki, batch, { ...deps, call }, usage);
    if (deps.signal?.aborted) return { outcome: "aborted" };
    if (result.failed) {
      batchFailures++;
      log.warn("Decision triage for {wiki}: a batch failed: {error}", { wiki, error: result.failed });
    }
    const lines = batch.items.map((item, i) => {
      const v = result.verdicts[i];
      const reason = noVerdictReason(result, i);
      if (!v && reason === MALFORMED) malformed++;
      if (!v && reason === MISSING) missing++;
      return line({
        ...lineBase(item),
        ...(v ? verdictFields(v) : { verdict: "NO_VERDICT" as const, reason }),
      });
    });
    await appendCards(lines);
  }

  // `failed`: cards went unjudged and none was judged. `partial`: a batch or a gather
  // fell over, or the model dropped or garbled a card, beside verdicts that landed. A
  // card too large to send beside verdicts stays `ok`, with a reason. Nothing to ask
  // (no open card, or only `ANSWERED` lines) is a clean `ok`, with no reason.
  const unjudged = (counts.NO_VERDICT ?? 0) > 0;
  const outcome: RunOutcome = progress.verdicts === 0 && unjudged ? "failed" : batchFailures > 0 || noFacts > 0 || malformed > 0 || missing > 0 ? "partial" : "ok";
  const why = [
    ...(batchFailures > 0 ? [`${batchFailures} of ${batches.length} batch(es) failed`] : []),
    ...(noFacts > 0 ? [`${noFacts} card(s) with no facts`] : []),
    ...(malformed > 0 ? [`${malformed} malformed verdict(s)`] : []),
    ...(missing > 0 ? [`${missing} card(s) ${MISSING}`] : []),
    ...(oversized.length > 0 ? [`${oversized.length} card(s) over the call's size limit`] : []),
  ].join(", ");
  const run = await finish(outcome, cards.length, why);
  if (!run) return { outcome: "aborted" };
  if (why) log.warn("Decision triage for {wiki}: {outcome}: {why}", { wiki, outcome, why });
  return { outcome, run, counts, wallMs: deps.now() - startedAt };
}

const recommendationOf = (q: ParsedQuestion) => parseRecommendation(q.body, q.choices);

const lineBase = (item: BatchItem) => ({
  relPath: item.gathered.ref.relPath,
  id: item.gathered.ref.id,
  questionHash: item.gathered.questionHash,
  recommendation: item.gathered.recommendation,
  codeFacts: item.gathered.codeFacts,
});

