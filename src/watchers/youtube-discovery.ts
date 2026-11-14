/**
 * The weekly `youtube-discovery` watcher (plan muninn-youtube-discovery, PR 3):
 * the last 7 days' YouTube summaries (widened back to the day of this bot's newest
 * stored watcher run, `seedWindowStart`), the newest not yet searched, at most `maxSeeds` (5), each searched as
 * its own discovery run and stored as a shelf on `/summaries/discover`
 * (`origin = 'watcher'`). It sends no alert of its own: the shelves are the
 * output (D5). Its failures go to `source-health.ts`, so a broken yt-dlp search
 * or a dead model raises one escalation after three bad weeks instead of
 * silence.
 *
 * Health keys, each judged only when a run reached its step:
 *   - `youtube:huginn` — the listing, then each seed's raw read (ok when no read ran)
 *   - `youtube:model`  — the queries and rank calls
 *   - `youtube:search` — the yt-dlp searches
 *   - `youtube:store`  — saving each shelf (the watcher's only output)
 * A key is `ok` when at least one run passed its step, `error` when every run
 * that reached it failed there, carried when no run reached it.
 *
 * A seed already searched (by any origin) is skipped: the reader's own Find on
 * YouTube, or an earlier weekly run, already made its shelf. The window is
 * anchored on this bot's newest stored watcher run (`seedWindowStart`).
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
  getLatestDiscoverRunAt,
  getLatestDiscoverRunTimes,
  saveDiscoverRun,
  type DiscoverHitInput,
  type DiscoverRunInput,
} from "../db/youtube-discover.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { openSourceHealth, type SourceHealthRecorder } from "./source-health.ts";
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

export interface YouTubeDiscoveryDeps {
  services: Pick<DiscoverServices, "readRaw" | "queriesCall" | "rankCall" | "search" | "listCaptured">;
  saveRun: (run: DiscoverRunInput, hits: readonly DiscoverHitInput[]) => Promise<string>;
  storedKnownIds: () => Promise<Set<string>>;
  latestRunTimes: (docIds: readonly string[]) => Promise<Map<string, number>>;
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
    lastWatcherRunAt: (botName) => getLatestDiscoverRunAt("watcher", botName),
    profile: (userId, botName) => loadInterestProfile(userId, botName),
    health: (w) => openSourceHealth(w.id, w.name),
    tracer: (bot) => new Tracer("youtube-discover", { botName: bot.name, platform: "youtube-discovery" }),
  };
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

/** Each step's verdict over this week's runs: reached, and passed at least once. */
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
  if (out.ok) {
    pass(t.huginn);
    pass(t.model);
    pass(t.search);
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
      pass(t.search);
      fail(t.model, why);
      return;
  }
}

function markStep(health: SourceHealthRecorder, key: string, s: StepTally): void {
  if (s.reached === 0) health.carry(key);
  else if (s.passed > 0) health.mark(key, "ok");
  else health.mark(key, "error", s.detail);
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
  const week = seedsSince(toSeedDocs(listed), seedWindowStart(now(), lastRun), Infinity);
  let recent = new Map<string, number>();
  try {
    recent = await deps.latestRunTimes(week.map((s) => s.id));
  } catch (err) {
    log.warn("YouTube discovery: reading earlier runs failed, searching every seed: {error}", { botName, error: errText(err) });
  }
  const seeds = week
    // Searched once is enough: a doc in the window was captured inside it, so any search of it is
    // this window's, and the band widened back to the last run is not searched twice.
    .filter((s) => !recent.has(s.id))
    .slice(0, resolveMaxSeeds(watcher.config, { botName, watcherId: watcher.id }));

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
      continue;
    }
    store.reached++;
    try {
      await deps.saveRun(
        {
          seedSource: "youtube",
          seedDocId: seed.id,
          seedTitle: out.seed.title,
          seedVideoId: out.seed.videoId,
          seedCategory: out.seed.category,
          seedDate: out.seed.date,
          queries: out.queries,
          searched: out.searched,
          known: out.known,
          origin: "watcher",
          botName,
        },
        out.results,
      );
      shelves++;
      store.passed++;
      for (const r of out.results) shelved.add(r.videoId);
    } catch (err) {
      store.detail ??= errText(err);
      log.warn("YouTube discovery: saving the run for {doc} failed: {error}", { botName, doc: seed.id, error: errText(err) });
    }
  }

  if (stoppedAt !== null)
    log.warn("YouTube discovery: out of time, {left} of {seeds} seeds not searched", { botName, left: seeds.length - stoppedAt, seeds: seeds.length });
  log.info("YouTube discovery: {shelves} shelves from {seeds} seeds ({week} in the window)", {
    botName,
    shelves,
    seeds: seeds.length,
    week: week.length,
  });
  // The listing answered: huginn is ok unless every raw read that ran failed.
  if (tally.huginn.reached === 0) health.mark(HEALTH_HUGINN, "ok");
  else markStep(health, HEALTH_HUGINN, tally.huginn);
  markStep(health, HEALTH_MODEL, tally.model);
  markStep(health, HEALTH_SEARCH, tally.search);
  markStep(health, HEALTH_STORE, store);
  return health.finish();
}
