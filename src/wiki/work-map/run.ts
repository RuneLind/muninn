/**
 * The organize run: one wiki, warm inputs, one tool-less model call, the
 * answer validated and normalized, `.work-map.json` written. A failed or
 * invalid run keeps the previous map; every attempt is recorded in the state
 * file (`state.ts`), never in the committed map.
 *
 * One run per wiki is in flight at a time, shared by the loop and
 * `POST /api/wiki/work-map/refresh`. `runFencedOneShot` takes no abort signal,
 * so the stop hook cannot kill a model call in flight: once the signal fired
 * the run writes and commits nothing, and the stop waits for a write already
 * in its section. That write lands, but its commit is skipped; the file stays
 * uncommitted until the next successful run commits it, about a day later,
 * since the stopped run still records ok. No wiki-committer sweep reaches it:
 * the sweep covers a bot's `wikiDir` only.
 */

import { extractJson } from "../../ai/json-extract.ts";
import { resolveFencedAgentCwd } from "../../ai/agent-cwd.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { Config, MuninnProfile, WorkMapEffort } from "../../config.ts";
import { runFencedOneShot } from "../../core/fenced-one-shot.ts";
import { getLog } from "../../logging.ts";
import type { WikiRegistryEntry } from "../registry.ts";
import { isReadonlyWikiRoot, isWikiReadonly } from "../readonly.ts";
import { buildWorkMapDigest, WORK_MAP_SYSTEM_PROMPT, WORK_MAP_TOUCH_WINDOW_DAYS } from "./digest.ts";
import { gatherWarmInputs, type WarmInputDeps } from "./inputs.ts";
import { normalizeWorkMapAnswer, type DeclaredEffortsHook } from "./normalize.ts";
import { parseWorkMap, WORK_MAP_VERSION, workMapAnswerSchema, type WorkMap, type WorkMapAnswer } from "./schema.ts";
import type { WorkMapStateStore } from "./state.ts";
import { WORK_MAP_FILE, writeWorkMapFile, type WorkMapWriteOptions, type WorkMapWriteOutcome } from "./write.ts";
import path from "node:path";

const log = getLog("wiki", "work-map");

/** The model call's own budget. The prototype measured 93 s on mimir's digest. */
export const WORK_MAP_TIMEOUT_MS = 300_000;
/** A run whose active pages fall below this share of the previous run's gets a
 *  coverage warning (not a refusal: commits leaving the window halve it alone). */
export const WORK_MAP_DROP_WARN_RATIO = 0.5;

/**
 * The extra CLI flags a tool-less surface appends (`executor.ts`): the
 * prototype's `--setting-sources "" --no-session-persistence`, plus auto memory
 * off, so neither `~/.claude/settings.json` nor the global `CLAUDE.md` loads.
 */
export const WORK_MAP_SPAWN_ARGS = [
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--settings",
  '{"autoMemoryEnabled":false}',
] as const;

/**
 * The run's `BotConfig`, built from scratch rather than cloned from a bot: a
 * clone would carry that bot's `effort`, thinking budget, `spawnArgs` and tool
 * settings, and would need a bot to exist. `effort` only when
 * `WORK_MAP_EFFORT` names one; no thinking budget at all, not even one
 * inherited from muninn's own env.
 */
export function workMapBotConfig(opts: { model: string; effort?: WorkMapEffort; dir: string }): BotConfig {
  return {
    name: "work-map",
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

export interface ModelRequest {
  wiki: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  effort?: WorkMapEffort;
}

export interface ModelReply {
  text: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** The real call: one tool-less `runFencedOneShot` under its own trace root
 *  and `/agents` run. `thinkingMaxTokens: null` sends no budget and no effort,
 *  so the CLI runs at its own default unless `WORK_MAP_EFFORT` is set. */
export function realWorkMapModel(config: Config, seams: Pick<Parameters<typeof runFencedOneShot>[0], "oneShot" | "tracer"> = {}) {
  return async (req: ModelRequest): Promise<ModelReply> => {
    const botConfig = workMapBotConfig({ model: req.model, effort: req.effort, dir: resolveFencedAgentCwd() });
    const result = await runFencedOneShot({
      traceName: "work-map",
      platform: "wiki",
      kind: "work_map",
      phase: "organizing",
      runName: `Work map: ${req.wiki}`,
      sourcePage: `/wiki?wiki=${encodeURIComponent(req.wiki)}`,
      source: "work-map",
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
      config,
      botConfig,
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

export interface WorkMapRunConfig {
  workMapWikis: readonly string[];
  workMapModel: string;
  workMapEffort?: WorkMapEffort;
  schedulerEnabled: boolean;
  profile: MuninnProfile;
}

export interface WorkMapRunDeps {
  config: WorkMapRunConfig;
  now: () => number;
  registry: () => readonly WikiRegistryEntry[];
  isReadonly?: () => boolean;
  isReadonlyRoot?: (root: string) => boolean;
  inputs: WarmInputDeps;
  readText: (absPath: string) => Promise<string | null>;
  model: (req: ModelRequest) => Promise<ModelReply>;
  write?: (opts: WorkMapWriteOptions) => Promise<WorkMapWriteOutcome>;
  /** The commit tail handed to the write seam; `null` commits nothing. */
  commit?: WorkMapWriteOptions["commit"];
  state: WorkMapStateStore;
  declared?: DeclaredEffortsHook;
}

export type Organizable = { ok: true; entry: WikiRegistryEntry } | { ok: false; reason: string };

/**
 * Does THIS instance organize `wiki`? Listed in `WORK_MAP_WIKIS`, the
 * scheduler on, the instance not readonly, its root not readonly, the profile
 * not `nais`. The loop, the POST and the GET's `organizable` all ask this.
 */
export function workMapOrganizable(
  wiki: string,
  deps: Pick<WorkMapRunDeps, "config" | "registry" | "isReadonly" | "isReadonlyRoot">,
): Organizable {
  const { config } = deps;
  if (config.profile === "nais") return { ok: false, reason: "the work map does not run under MUNINN_PROFILE=nais" };
  if (!config.workMapWikis.some((n) => n.toLowerCase() === wiki.toLowerCase())) {
    return { ok: false, reason: `WORK_MAP_WIKIS does not list ${wiki} on this instance` };
  }
  if (!config.schedulerEnabled) return { ok: false, reason: "SCHEDULER_ENABLED is off on this instance" };
  if ((deps.isReadonly ?? isWikiReadonly)()) return { ok: false, reason: "this instance is wiki-readonly" };
  const entry = deps.registry().find((e) => e.name.toLowerCase() === wiki.toLowerCase());
  if (!entry) return { ok: false, reason: `${wiki} is not a registered wiki` };
  if ((deps.isReadonlyRoot ?? isReadonlyWikiRoot)(entry.root)) return { ok: false, reason: `${entry.name} has a readonly root` };
  return { ok: true, entry };
}

export type WorkMapRunResult =
  | { outcome: "ok"; map: WorkMap; written: boolean }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "aborted" };

const inFlight = new Map<string, { startedAt: number; promise: Promise<WorkMapRunResult> }>();
const pendingWrites = new Set<Promise<unknown>>();
/** Fired by the stop hook: every run in flight, the POST's included, writes and
 *  commits nothing after it. */
let shutdown = new AbortController();

/** Re-arm after a stop (a loop started again in the same process). */
export function armWorkMapRuns(): void {
  if (shutdown.signal.aborted) shutdown = new AbortController();
}

/** The stop hook's half here: no run writes after this; returns the writes
 *  already inside their section, for the caller to wait on. */
export function abortWorkMapRuns(): Promise<unknown>[] {
  shutdown.abort();
  return [...pendingWrites];
}

/** The run in flight for `wiki`, if any. */
export function workMapRunInFlight(wiki: string): { startedAt: number } | null {
  const f = inFlight.get(wiki.toLowerCase());
  return f ? { startedAt: f.startedAt } : null;
}

/** Start a run for `wiki`, or join the one in flight. */
export function startWorkMapRun(
  wiki: string,
  deps: WorkMapRunDeps,
  signal?: AbortSignal,
): { joined: boolean; startedAt: number; promise: Promise<WorkMapRunResult> } {
  const key = wiki.toLowerCase();
  const existing = inFlight.get(key);
  if (existing) return { joined: true, ...existing };
  const startedAt = deps.now();
  const stop = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
  const promise = organizeWorkMap(wiki, deps, startedAt, stop)
    .catch((err): WorkMapRunResult => ({ outcome: "failed", reason: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });
  inFlight.set(key, { startedAt, promise });
  return { joined: false, startedAt, promise };
}

/** Test-only: forget runs in flight. */
export function __resetWorkMapRunsForTest(): void {
  inFlight.clear();
  pendingWrites.clear();
  shutdown = new AbortController();
}

async function organizeWorkMap(wiki: string, deps: WorkMapRunDeps, runStart: number, signal?: AbortSignal): Promise<WorkMapRunResult> {
  const record = async (outcome: "ok" | "refused" | "failed", error?: string) => {
    try {
      await deps.state.record(wiki, { at: runStart, outcome, ...(error ? { error } : {}) });
    } catch (err) {
      log.warn("Work map: state file write failed for {wiki}: {error}", { wiki, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const refuse = async (reason: string): Promise<WorkMapRunResult> => {
    log.info("Work map run refused for {wiki}: {reason}", { wiki, reason });
    await record("refused", reason);
    return { outcome: "refused", reason };
  };
  const fail = async (reason: string): Promise<WorkMapRunResult> => {
    log.warn("Work map run failed for {wiki}: {reason}", { wiki, reason });
    await record("failed", reason);
    return { outcome: "failed", reason };
  };

  // A throw anywhere below is recorded too: `failed` once the model was
  // called (it counts toward the day's gate), `refused` before.
  const progress = { modelCalled: false };
  try {
    return await organizeSteps(wiki, deps, runStart, signal, { refuse, fail, record }, progress);
  } catch (err) {
    if (signal?.aborted) return { outcome: "aborted" };
    const reason = `the run threw: ${err instanceof Error ? err.message : String(err)}`;
    return progress.modelCalled ? fail(reason) : refuse(reason);
  }
}

interface RunOutcomes {
  refuse: (reason: string) => Promise<WorkMapRunResult>;
  fail: (reason: string) => Promise<WorkMapRunResult>;
  record: (outcome: "ok" | "refused" | "failed", error?: string) => Promise<void>;
}

async function organizeSteps(
  wiki: string,
  deps: WorkMapRunDeps,
  runStart: number,
  signal: AbortSignal | undefined,
  { refuse, fail, record }: RunOutcomes,
  progress: { modelCalled: boolean },
): Promise<WorkMapRunResult> {
  const org = workMapOrganizable(wiki, deps);
  if (!org.ok) return refuse(org.reason);
  const { entry } = org;
  const warm = await gatherWarmInputs(entry.root, runStart, deps.inputs);
  if (signal?.aborted) return { outcome: "aborted" };
  if (!warm.ok) return refuse(warm.reason);
  const index = warm.index;
  const work = index.work!;

  const previousText = await deps.readText(path.join(entry.root, WORK_MAP_FILE));
  const previous = previousText === null ? null : parseWorkMap(previousText);
  const logText = await deps.readText(path.join(entry.root, "log.md"));
  const digest = buildWorkMapDigest({
    wiki: entry.name,
    nowMs: runStart,
    pages: index.pages,
    outgoing: index.outgoing,
    threads: work.threads,
    sessionsSinceMs: work.sinceMs,
    sessionsAsOfMs: work.asOfMs,
    gitTouches: index.gitTouches!,
    ...(index.gitMetadataFilter ? { metadataFilter: index.gitMetadataFilter } : {}),
    logText,
    resolveLink: (t) => index.resolve(t)?.relPath,
    previous,
  });

  const warnings: string[] = [];
  const filter = index.gitMetadataFilter;
  const filterWarning = metadataFilterWarning(filter);
  if (filterWarning) warnings.push(filterWarning);
  const prevActive = previous?.coverage.activePages;
  if (prevActive && digest.active.length < prevActive * WORK_MAP_DROP_WARN_RATIO) {
    warnings.push(`Active pages fell from ${prevActive} to ${digest.active.length} since the previous run.`);
  }

  if (signal?.aborted) return { outcome: "aborted" };
  let reply: ModelReply;
  progress.modelCalled = true;
  try {
    reply = await deps.model({
      wiki: entry.name,
      prompt: digest.text,
      systemPrompt: WORK_MAP_SYSTEM_PROMPT,
      model: deps.config.workMapModel,
      ...(deps.config.workMapEffort ? { effort: deps.config.workMapEffort } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return { outcome: "aborted" };
    return fail(`the model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (signal?.aborted) return { outcome: "aborted" };

  let raw: unknown;
  try {
    raw = extractJson<unknown>(reply.text);
  } catch {
    return fail(`the answer was not JSON (${reply.text.length} chars)`);
  }
  const parsed = workMapAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return fail(`the answer did not match the schema (${issues})`);
  }
  const answer: WorkMapAnswer = parsed.data;
  const byRel = new Map(index.pages.map((p) => [p.relPath, p]));
  const sessionRefs = new Map((work.evidence?.contributions.rows ?? []).map((r) => [`${r[1]}\0${r[6]}`, r[0]]));
  const normalized = normalizeWorkMapAnswer(answer, {
    rel: digest.rel,
    nowMs: runStart,
    sessionsSinceMs: work.sinceMs,
    gitTouches: index.gitTouches!,
    workEvents: (rel) => byRel.get(rel)?.work?.events,
    sessionOf: (rel, lastMs) => sessionRefs.get(`${rel}\0${lastMs}`),
    ...(deps.declared ? { declared: deps.declared } : {}),
  });
  const map: WorkMap = {
    version: WORK_MAP_VERSION,
    wiki: entry.name,
    runAtMs: runStart,
    model: reply.model ?? deps.config.workMapModel,
    coverage: {
      sessionsSinceMs: work.sinceMs,
      sessionsAsOfMs: work.asOfMs,
      touchWindowDays: WORK_MAP_TOUCH_WINDOW_DAYS,
      activePages: digest.active.length,
      threads: digest.threads,
      logEntries: digest.logEntries,
      logEntriesInWindow: digest.logEntriesInWindow,
      digestChars: digest.text.length,
      ...(filter ? { metadataFilter: filter } : {}),
      warnings,
    },
    ...normalized,
    usage: {
      ...(reply.costUsd !== undefined ? { costUsd: reply.costUsd } : {}),
      ...(reply.durationMs !== undefined ? { durationMs: reply.durationMs } : {}),
      ...(reply.inputTokens !== undefined ? { inputTokens: reply.inputTokens } : {}),
      ...(reply.outputTokens !== undefined ? { outputTokens: reply.outputTokens } : {}),
    },
  };

  if (signal?.aborted) return { outcome: "aborted" };
  const writing = (deps.write ?? writeWorkMapFile)({
    wikiDir: entry.root,
    content: `${JSON.stringify(map, null, 1)}\n`,
    commitMessage: `work-map: organize ${entry.name} (${map.efforts.length} efforts)`,
    proceed: () => !signal?.aborted,
    ...(deps.isReadonly ? { isReadonly: deps.isReadonly } : {}),
    ...(deps.isReadonlyRoot ? { isReadonlyRoot: deps.isReadonlyRoot } : {}),
    ...(deps.commit !== undefined ? { commit: deps.commit } : {}),
  });
  pendingWrites.add(writing);
  let wrote: WorkMapWriteOutcome;
  try {
    wrote = await writing;
  } finally {
    pendingWrites.delete(writing);
  }
  if (signal?.aborted && wrote.outcome === "noop") return { outcome: "aborted" };
  if (wrote.outcome === "forbidden" || wrote.outcome === "locked" || wrote.outcome === "error") {
    return fail(`the map was not written: ${wrote.reason}`);
  }
  await record("ok");
  log.info("Work map for {wiki}: {efforts} effort(s), {needs} needs-you, {pages} active page(s)", {
    wiki: entry.name,
    efforts: map.efforts.length,
    needs: map.needsYou.length,
    pages: digest.active.length,
  });
  return { outcome: "ok", map, written: wrote.outcome === "written" };
}

/** The coverage warning for a degraded git metadata filter (the card shows it as written). */
export function metadataFilterWarning(filter: { degraded: boolean; reason?: string; pages?: number } | undefined): string | null {
  if (!filter?.degraded) return null;
  return filter.reason === "steps"
    ? `The git walk left ${filter.pages} page(s) with only metadata-only commits unverified; a stamp burst may count as recent work.`
    : "The git walk ran out of time filtering metadata-only commits; a stamp burst may count as recent work.";
}
