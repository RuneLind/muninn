/**
 * The weekly `youtube-discovery` watcher (plan muninn-youtube-discovery, PR 3):
 * the last 7 days' YouTube summaries (widened back to the day of this bot's newest
 * stored watcher run, `seedWindowStart`), the newest not yet searched, at most `maxSeeds` (5), each searched as
 * its own discovery run and stored as a shelf on `/summaries/discover`
 * (`origin = 'watcher'`). It sends no alert of its own: the shelves are the
 * output (D5). Its failures go to `source-health.ts`, and as a weekly source it
 * escalates on the FIRST bad week (`sourceEscalateAfter`; architecture review
 * 2026-11-16, F16 — three bad weeks was the old design), so a broken yt-dlp
 * search or a dead model is heard within a week.
 *
 * Health keys, each judged only when a run reached its step:
 *   - `youtube:huginn` — the listing, then each seed's raw read (ok when no read ran)
 *   - `youtube:model`  — the queries and rank calls
 *   - `youtube:search` — the yt-dlp searches (one failed search fails that seed's step)
 *   - `youtube:store`  — saving each run (the watcher's only output)
 * A key is `ok` when every run that reached its step passed it, `error` when any
 * failed there (F14: three of five seeds failing used to read all-ok), carried
 * when no run reached it. A search that finds no videos passes.
 *
 * A failed seed is stored too, as a run with `failed > 0` and no hits (migration
 * 092), and the next run searches every listed seed whose newest run failed
 * FIRST, until it has failed {@link MAX_RETRY_ATTEMPTS} runs in a row, so a
 * failed week's seeds are not left behind the moving window. Any other seed
 * already searched (by any origin) is skipped: the reader's own Find on YouTube,
 * or an earlier weekly run, already made its shelf. The window is anchored on
 * this bot's newest stored watcher run (`seedWindowStart`).
 *
 * The run keeps inside the runner's net: every model call carries one run-wide
 * `deadlineAt` (min(net, tick) minus the net's margin, so `health.finish()` still runs), and
 * no seed starts with less than {@link MIN_SEED_MS} left.
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { HaikuTelemetry } from "../scheduler/executor.ts";
import { loadConfig } from "../config.ts";
import { Tracer } from "../tracing/tracer.ts";
import { extractYouTubeVideoId } from "../youtube/url.ts";
import { defaultDiscoverServices, YOUTUBE_SUMMARIES_COLLECTION, type DiscoverServices } from "../youtube/discover-deps.ts";
import { runDiscovery, type DiscoverRunOutcome, type DiscoverTracer } from "../youtube/discover-run.ts";
import { seedsSince, seedWindowStart, toSeedDocs, DISCOVER_SEED_CAP } from "../youtube/discover-seeds.ts";
import { readIntKnob } from "./config-knobs.ts";
import {
  getDiscoverKnownVideoIds,
  getDiscoverRetrySeeds,
  getLatestDiscoverRunAt,
  getLatestDiscoverRunTimes,
  saveDiscoverRun,
  type DiscoverHitInput,
  type DiscoverRunInput,
} from "../db/youtube-discover.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { openSourceHealth, sourceEscalateAfter, type SourceHealthRecorder } from "./source-health.ts";
import { effectiveCadenceMs } from "./run-health.ts";
import { computeWatcherTimeoutMs, TICK_TIMEOUT_MS, WATCHER_TIMEOUT_MARGIN_MS } from "./timeout.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "youtube-discovery");

export const HEALTH_HUGINN = "youtube:huginn";
export const HEALTH_MODEL = "youtube:model";
export const HEALTH_SEARCH = "youtube:search";
export const HEALTH_STORE = "youtube:store";
const MAX_SEEDS_LIMIT = 10;
/** A seed needs this much of the run's budget left to start (a healthy run took 11–14 s in 4 live traces, 2026-11-14). */
export const MIN_SEED_MS = 60_000;
/** A failed seed is searched again next run until it has failed this many runs in a row. */
export const MAX_RETRY_ATTEMPTS = 3;

export interface YouTubeDiscoveryDeps {
  services: Pick<DiscoverServices, "readRaw" | "queriesCall" | "rankCall" | "search" | "listCaptured">;
  saveRun: (run: DiscoverRunInput, hits: readonly DiscoverHitInput[]) => Promise<string>;
  storedKnownIds: () => Promise<Set<string>>;
  latestRunTimes: (docIds: readonly string[]) => Promise<Map<string, number>>;
  /** Seeds whose newest run failed → their failed runs since the last complete one. */
  retrySeeds: () => Promise<Map<string, number>>;
  /** When this bot's newest watcher run was stored, or null: the window's anchor. */
  lastWatcherRunAt: (botName: string) => Promise<number | null>;
  profile: (userId: string, botName: string) => Promise<string | null>;
  health: (watcher: Watcher) => Promise<SourceHealthRecorder>;
  tracer?: (bot: BotConfig) => DiscoverTracer | null;
  now?: () => number;
}

export function defaultYouTubeDiscoveryDeps(): YouTubeDiscoveryDeps {
  return {
    services: defaultDiscoverServices(loadConfig().knowledgeApiUrl),
    saveRun: saveDiscoverRun,
    storedKnownIds: getDiscoverKnownVideoIds,
    latestRunTimes: (ids) => getLatestDiscoverRunTimes(ids),
    retrySeeds: () => getDiscoverRetrySeeds(),
    lastWatcherRunAt: (botName) => getLatestDiscoverRunAt("watcher", botName),
    profile: (userId, botName) => loadInterestProfile(userId, botName),
    health: (w) => openSourceHealth(w.id, w.name, Date.now(), { escalateAfter: discoveryEscalateAfter(w) }),
    tracer: (bot) => new Tracer("youtube-discover", { botName: bot.name, platform: "youtube-discovery" }),
  };
}

/** The row's escalation threshold: 1 on its weekly cadence (F16). */
export function discoveryEscalateAfter(w: Pick<Watcher, "intervalMs" | "config">): number {
  return sourceEscalateAfter(effectiveCadenceMs(w));
}

/** `config.maxSeeds`, 1–10; anything else is warned about and runs at the default (5). */
export function resolveMaxSeeds(config: Record<string, unknown> | undefined, ctx: { botName?: string; watcherId?: string } = {}): number {
  const raw = config?.maxSeeds;
  return readIntKnob(raw, {
    field: "maxSeeds",
    fallback: DISCOVER_SEED_CAP,
    min: 1,
    max: MAX_SEEDS_LIMIT,
    botName: ctx.botName,
    ...(ctx.watcherId ? { dedupeKey: `${ctx.watcherId}:${String(raw)}` } : {}),
  });
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Each step's verdict over this week's runs: reached, and passed. */
interface StepTally {
  reached: number;
  passed: number;
  detail?: string;
}

/** Which steps one outcome reached and passed (`runDiscovery` runs read → queries → search → rank). */
export function tallyOutcome(out: DiscoverRunOutcome, t: { huginn: StepTally; model: StepTally; search: StepTally }): void {
  const fail = (s: StepTally, detail: string) => {
    s.reached++;
    s.detail ??= detail;
  };
  const pass = (s: StepTally) => {
    s.reached++;
    s.passed++;
  };
  // Searches that failed inside a run that went on past them.
  const searches = (n: number) => `${n} of ${out.queries?.length ?? "?"} searches failed`;
  if (out.ok) {
    pass(t.huginn);
    pass(t.model);
    if (out.failed > 0) fail(t.search, searches(out.failed));
    else pass(t.search);
    return;
  }
  const why = out.cause ?? out.error;
  switch (out.stage) {
    case "read":
      // A seed deleted since the listing says nothing about huginn's health.
      if (out.code !== "not_found") fail(t.huginn, why);
      return;
    case "queries":
      pass(t.huginn);
      fail(t.model, why);
      return;
    case "search":
      pass(t.huginn);
      pass(t.model);
      fail(t.search, why);
      return;
    case "rank":
      pass(t.huginn);
      // `failed` counts the rank call itself.
      if (out.failed > 1) fail(t.search, searches(out.failed - 1));
      else pass(t.search);
      fail(t.model, why);
      return;
  }
}

function markStep(health: SourceHealthRecorder, key: string, s: StepTally): void {
  if (s.reached === 0) health.carry(key);
  else if (s.passed === s.reached) health.mark(key, "ok");
  else health.mark(key, "error", `${s.reached - s.passed} of ${s.reached} seeds failed: ${s.detail ?? "no detail"}`);
}

export async function checkYouTubeDiscovery(
  watcher: Watcher,
  botConfig: BotConfig,
  _telemetry?: HaikuTelemetry,
  deps: YouTubeDiscoveryDeps = defaultYouTubeDiscoveryDeps(),
): Promise<WatcherAlert[]> {
  const now = deps.now ?? Date.now;
  // The tick is the true ceiling: a net above it (a large `timeoutMs`) never fires first (`timeout.ts`).
  const deadlineAt = now() + Math.min(computeWatcherTimeoutMs(watcher), TICK_TIMEOUT_MS) - WATCHER_TIMEOUT_MARGIN_MS;
  const health = await deps.health(watcher);
  const botName = botConfig.name;

  let listed;
  try {
    listed = await deps.services.listCaptured();
  } catch (err) {
    log.warn("YouTube discovery: the youtube-summaries listing failed: {error}", { botName, error: errText(err) });
    health.mark(HEALTH_HUGINN, "error", `listing failed: ${errText(err)}`);
    health.carry(HEALTH_MODEL);
    health.carry(HEALTH_SEARCH);
    health.carry(HEALTH_STORE);
    return health.finish();
  }

  // Anchored on the newest STORED watcher run: the runner writes `last_success_at` for email only.
  const lastRun = await deps.lastWatcherRunAt(botName).catch((err) => {
    log.warn("YouTube discovery: reading the last watcher run failed, using the last 7 days: {error}", { botName, error: errText(err) });
    return null;
  });
  const all = toSeedDocs(listed);
  const week = seedsSince(all, seedWindowStart(now(), lastRun), Infinity);
  let recent = new Map<string, number>();
  try {
    recent = await deps.latestRunTimes(week.map((s) => s.id));
  } catch (err) {
    log.warn("YouTube discovery: reading earlier runs failed, searching every seed: {error}", { botName, error: errText(err) });
  }
  let retry = new Map<string, number>();
  try {
    retry = await deps.retrySeeds();
  } catch (err) {
    log.warn("YouTube discovery: reading the failed seeds failed, none retried: {error}", { botName, error: errText(err) });
  }
  // A failed seed goes first, whatever its date: the window has moved past last week's.
  const retrying = all.filter((s) => (retry.get(s.id) ?? Infinity) < MAX_RETRY_ATTEMPTS);
  const exhausted = all.filter((s) => (retry.get(s.id) ?? 0) >= MAX_RETRY_ATTEMPTS).length;
  if (exhausted > 0)
    log.warn("YouTube discovery: {n} seeds failed {max} runs in a row and are not retried", { botName, n: exhausted, max: MAX_RETRY_ATTEMPTS });
  const seeds = [
    ...retrying,
    // Searched once is enough: a doc in the window was captured inside it, so any search of it is
    // this window's, and the band widened back to the last run is not searched twice. A failed
    // run counts as a search here: its seed is retried above, or has run out of retries.
    ...week.filter((s) => !recent.has(s.id) && !retry.has(s.id)),
  ].slice(0, resolveMaxSeeds(watcher.config, { botName, watcherId: watcher.id }));

  const tally = { huginn: { reached: 0, passed: 0 } as StepTally, model: { reached: 0, passed: 0 } as StepTally, search: { reached: 0, passed: 0 } as StepTally };
  const store: StepTally = { reached: 0, passed: 0 };
  const captured = new Set(listed.map((d) => extractYouTubeVideoId(d.url ?? "")).filter((id): id is string => !!id));
  // Videos this run already put on a shelf: one video lands on one shelf per run.
  const shelved = new Set<string>();
  // Known = captured ∪ dismissed ∪ queued ∪ shelved this run; the store half is re-read per seed.
  const knownIds = async () => {
    const stored = await deps.storedKnownIds().catch(() => new Set<string>());
    return new Set([...captured, ...stored, ...shelved]);
  };
  const opts = { deadlineAt };
  // The owner's interest profile, read once per run (it changes weekly at most).
  let profile: Promise<string | null> | null = null;
  const loadProfile = () => (profile ??= deps.profile(watcher.userId, botName));

  let shelves = 0;
  let failedSeeds = 0;
  let stoppedAt: number | null = null;
  for (const [i, seed] of seeds.entries()) {
    if (deadlineAt - now() < MIN_SEED_MS) {
      stoppedAt = i;
      break;
    }
    const tracer = deps.tracer?.(botConfig) ?? null;
    const out = await runDiscovery(
      {
        readRaw: deps.services.readRaw,
        queriesCall: (p, b, t) => deps.services.queriesCall(p, b, t, opts),
        rankCall: (p, b, t) => deps.services.rankCall(p, b, t, opts),
        search: deps.services.search,
        knownIds,
        profile: loadProfile,
      },
      botConfig,
      tracer,
      { collection: YOUTUBE_SUMMARIES_COLLECTION, docId: seed.id },
    );
    tallyOutcome(out, tally);
    if (!out.ok) {
      log.warn("YouTube discovery: {code} for {doc}: {error}", { botName, doc: seed.id, code: out.code, error: out.cause ?? out.error });
      // A seed deleted since the listing has nothing to retry.
      if (out.code === "not_found") continue;
    } else if (out.failed > 0) {
      log.warn("YouTube discovery: {failed} of {queries} searches failed for {doc}", {
        botName,
        doc: seed.id,
        failed: out.failed,
        queries: out.queries.length,
      });
    }
    if (out.failed > 0) failedSeeds++;
    // A failed run is stored too (no hits, `failed > 0`): it is what the next run retries first.
    store.reached++;
    try {
      await deps.saveRun(
        {
          seedSource: "youtube",
          seedDocId: seed.id,
          seedTitle: out.seed?.title ?? seed.title,
          seedVideoId: out.seed?.videoId ?? null,
          seedCategory: out.seed?.category ?? seed.category,
          seedDate: out.seed?.date ?? seed.date,
          queries: out.queries ?? [],
          searched: out.ok ? out.searched : 0,
          known: out.ok ? out.known : 0,
          origin: "watcher",
          botName,
          failed: out.failed,
        },
        out.ok ? out.results : [],
      );
      store.passed++;
      if (out.ok) {
        shelves++;
        for (const r of out.results) shelved.add(r.videoId);
      }
    } catch (err) {
      store.detail ??= errText(err);
      log.warn("YouTube discovery: saving the run for {doc} failed: {error}", { botName, doc: seed.id, error: errText(err) });
    }
  }

  if (stoppedAt !== null)
    log.warn("YouTube discovery: out of time, {left} of {seeds} seeds not searched", { botName, left: seeds.length - stoppedAt, seeds: seeds.length });
  log.info("YouTube discovery: {shelves} shelves from {seeds} seeds ({failed} with failures, {retried} retried, {week} in the window)", {
    botName,
    shelves,
    seeds: seeds.length,
    failed: failedSeeds,
    retried: retrying.length,
    week: week.length,
  });
  // The listing answered: huginn is ok unless a raw read that ran failed.
  if (tally.huginn.reached === 0) health.mark(HEALTH_HUGINN, "ok");
  else markStep(health, HEALTH_HUGINN, tally.huginn);
  markStep(health, HEALTH_MODEL, tally.model);
  markStep(health, HEALTH_SEARCH, tally.search);
  markStep(health, HEALTH_STORE, store);
  return health.finish();
}
