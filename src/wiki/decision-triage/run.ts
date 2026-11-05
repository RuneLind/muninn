/**
 * One pass over one wiki: repos resolved first, a line for every card in scope,
 * tool-less model calls in batches, and everything appended through a sink. The
 * run writes no wiki page and takes no write lock (D3). A batch that fails makes
 * the night `partial` and keeps what landed; only a night with no verdicts at all
 * is `failed`.
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
export function parseVerdicts(text: string): { verdicts: Map<string, Verdict>; invalid: number } {
  const raw = answerSchema.parse(extractJson<unknown>(text));
  const verdicts = new Map<string, Verdict>();
  let invalid = 0;
  for (const entry of raw.verdicts) {
    const parsed = verdictSchema.safeParse(entry);
    if (parsed.success) verdicts.set(parsed.data.card, parsed.data);
    else invalid++;
  }
  return { verdicts, invalid };
}

export interface BatchResult {
  batch: Batch;
  verdicts: (Verdict | null)[];
  failed?: string;
}

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
    const { verdicts } = parseVerdicts(reply.text);
    return { batch, verdicts: batch.items.map((_, i) => verdicts.get(`c${i + 1}`) ?? null) };
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
    facts: async (): Promise<RepoFact[]> => (await Promise.all(memo.values())).map((r) => r.fact),
  };
}

export interface TriageRunDeps {
  entry: WikiRegistryEntry;
  now: () => number;
  repoRoots: string | null;
  model: string;
  effort?: WorkMapEffort;
  call: TriageModel;
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
  /** The floor's state for the run line. */
  floor?: () => Promise<FloorState>;
  signal?: AbortSignal;
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
  const counts: Record<string, number> = {};
  const roots = parseRepoRoots(deps.repoRoots);
  const resolver = repoResolver(roots, deps.git, { fetch: true });

  const finish = async (outcome: RunOutcome, cards: number, reason?: string): Promise<RunLine> => {
    let floor: FloorState | null = null;
    if (deps.floor) {
      try {
        floor = await deps.floor();
      } catch (err) {
        floor = { labelled: 0, added: 0, addedPages: 0, met: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const run: RunLine = {
      type: "run",
      runId,
      at: startedAt,
      wiki,
      model: deps.model,
      promptVersion: DECISION_TRIAGE_PROMPT_VERSION,
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
  const refuse = async (reason: string): Promise<TriageRunResult> => {
    log.warn("Decision triage refused for {wiki}: {reason}", { wiki, reason });
    return { outcome: "refused", reason, run: await finish("refused", 0, reason), counts, wallMs: deps.now() - startedAt };
  };

  // Nothing is spent yet, so a throw here is a refusal and retries at the next check.
  let index: WikiIndex;
  let versions: WikiAnswerVersion[];
  let open: Awaited<ReturnType<typeof collectOpenCards>>;
  try {
    const loaded = await deps.loadIndex();
    if (!loaded) return refuse("the wiki index could not be read");
    index = loaded;
    versions = await deps.answers();
    open = await collectOpenCards(index, (meta: WikiPageMeta) => deps.readFile(`${index.root}/${meta.relPath}`));
  } catch (err) {
    return refuse(`the cards could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { pages, cards } = open;
  if (deps.signal?.aborted) return { outcome: "aborted" };

  // Repos before anything is spent. A setup fault is no verdict on any card.
  const names = new Set(pages.flatMap((p) => p.repos));
  const resolved = await Promise.all([...names].map((n) => resolver.repo(n)));
  if (cards.length > 0 && names.size > 0 && !resolved.some((r) => r.fact.found)) return refuse("no-repo");

  const view = liveView(index, deps.readFile);
  const byPage = new Map<string, PageRead>(pages.map((p) => [p.relPath, p]));
  const ctx: GatherContext = { git: deps.git, repo: resolver.repo, answers: versions, owner: deps.owner, groups: deps.groups };
  const line = (fields: Omit<CardLine, "type" | "runId" | "at" | "wiki">): CardLine => {
    counts[fields.verdict] = (counts[fields.verdict] ?? 0) + 1;
    return { type: "card", runId, at: startedAt, wiki, ...fields };
  };
  const base = (relPath: string, id: string) => {
    const q = byPage.get(relPath)!.page.questions.find((x) => x.id === id)!;
    return { relPath, id, questionHash: sha256(q.hashInput) };
  };

  const items: BatchItem[] = [];
  const held: CardLine[] = [];
  const pageFacts = new Map<string, PageFacts>();
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
      held.push(line({ ...base(relPath, id), recommendation: recommendationOf(read.page.questions.find((x) => x.id === id)!), verdict: "NO_VERDICT", reason: `facts: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  await deps.append(held);

  const { batches, oversized } = buildBatches(wiki, items);
  await deps.append(oversized.map((o) => line({ ...lineBase(o), verdict: "NO_VERDICT", reason: "over the call's size limit" })));

  let batchFailures = 0;
  let verdictCount = 0;
  for (const batch of batches) {
    if (deps.signal?.aborted) return { outcome: "aborted" };
    const result = await callBatch(wiki, batch, deps, usage);
    if (deps.signal?.aborted) return { outcome: "aborted" };
    if (result.failed) {
      batchFailures++;
      log.warn("Decision triage for {wiki}: a batch failed: {error}", { wiki, error: result.failed });
    }
    const lines = batch.items.map((item, i) => {
      const v = result.verdicts[i];
      if (v) verdictCount++;
      return line({
        ...lineBase(item),
        ...(v ? verdictFields(v) : { verdict: "NO_VERDICT" as const, reason: result.failed ? "the batch failed" : "missing from the answer" }),
      });
    });
    await deps.append(lines);
  }

  const asked = items.length > 0;
  const outcome: RunOutcome = asked && verdictCount === 0 ? "failed" : batchFailures > 0 ? "partial" : "ok";
  const run = await finish(outcome, cards.length, outcome === "ok" ? undefined : `${batchFailures} of ${batches.length} batch(es) failed`);
  if (outcome === "failed") log.warn("Decision triage for {wiki} got no verdicts", { wiki });
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

