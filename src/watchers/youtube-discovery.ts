/**
 * The weekly `youtube-discovery` watcher (plan muninn-youtube-discovery, PR 3):
 * the last 7 days' YouTube summaries, at most `maxSeeds` (5), each searched as
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
 * A key is `ok` when at least one run passed its step, `error` when every run
 * that reached it failed there, carried when no run reached it.
 *
 * A seed searched in the last 6 days (by any origin) is skipped: the reader's
 * own Find on YouTube already made its shelf.
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { HaikuTelemetry } from "../scheduler/executor.ts";
import { loadConfig } from "../config.ts";
import { Tracer } from "../tracing/tracer.ts";
import { extractYouTubeVideoId } from "../youtube/url.ts";
import { defaultDiscoverServices, YOUTUBE_SUMMARIES_COLLECTION, type DiscoverServices } from "../youtube/discover-deps.ts";
import { runDiscovery, type DiscoverRunOutcome, type DiscoverTracer } from "../youtube/discover-run.ts";
import { lastWeekSeeds, toSeedDocs, DISCOVER_SEED_CAP } from "../youtube/discover-seeds.ts";
import {
  getDiscoverKnownVideoIds,
  getLatestDiscoverRunTimes,
  saveDiscoverRun,
  type DiscoverHitInput,
  type DiscoverRunInput,
} from "../db/youtube-discover.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { openSourceHealth, type SourceHealthRecorder } from "./source-health.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "youtube-discovery");

export const HEALTH_HUGINN = "youtube:huginn";
export const HEALTH_MODEL = "youtube:model";
export const HEALTH_SEARCH = "youtube:search";
/** A seed searched more recently than this is not searched again. */
export const RECENT_RUN_SKIP_MS = 6 * 86_400_000;
const MAX_SEEDS_LIMIT = 10;

export interface YouTubeDiscoveryDeps {
  services: Pick<DiscoverServices, "readRaw" | "queriesCall" | "rankCall" | "search" | "listCaptured">;
  saveRun: (run: DiscoverRunInput, hits: readonly DiscoverHitInput[]) => Promise<string>;
  storedKnownIds: () => Promise<Set<string>>;
  latestRunTimes: (docIds: readonly string[]) => Promise<Map<string, number>>;
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
    profile: (userId, botName) => loadInterestProfile(userId, botName),
    health: (w) => openSourceHealth(w.id, w.name),
    tracer: (bot) => new Tracer("youtube-discover", { botName: bot.name, platform: "youtube-discovery" }),
  };
}

/** `config.maxSeeds`, 1–10; anything else is the default (5). */
export function resolveMaxSeeds(config: Record<string, unknown> | undefined): number {
  const v = config?.maxSeeds;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_SEEDS_LIMIT ? v : DISCOVER_SEED_CAP;
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
    return health.finish();
  }

  const week = lastWeekSeeds(toSeedDocs(listed), now(), MAX_SEEDS_LIMIT * 4);
  let recent = new Map<string, number>();
  try {
    recent = await deps.latestRunTimes(week.map((s) => s.id));
  } catch (err) {
    log.warn("YouTube discovery: reading earlier runs failed, searching every seed: {error}", { botName, error: errText(err) });
  }
  const seeds = week.filter((s) => (recent.get(s.id) ?? 0) < now() - RECENT_RUN_SKIP_MS).slice(0, resolveMaxSeeds(watcher.config));

  const tally = { huginn: { reached: 0, passed: 0 } as StepTally, model: { reached: 0, passed: 0 } as StepTally, search: { reached: 0, passed: 0 } as StepTally };
  const captured = new Set(listed.map((d) => extractYouTubeVideoId(d.url ?? "")).filter((id): id is string => !!id));
  // Known = captured ∪ dismissed ∪ queued, re-read before each seed so this run's own shelves count too.
  const knownIds = async () => {
    const stored = await deps.storedKnownIds().catch(() => new Set<string>());
    return new Set([...captured, ...stored]);
  };

  let shelves = 0;
  for (const seed of seeds) {
    const tracer = deps.tracer?.(botConfig) ?? null;
    const out = await runDiscovery(
      {
        readRaw: deps.services.readRaw,
        queriesCall: deps.services.queriesCall,
        rankCall: deps.services.rankCall,
        search: deps.services.search,
        knownIds,
        profile: () => deps.profile(watcher.userId, botName),
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
    } catch (err) {
      log.warn("YouTube discovery: saving the run for {doc} failed: {error}", { botName, doc: seed.id, error: errText(err) });
    }
  }

  log.info("YouTube discovery: {shelves} shelves from {seeds} seeds ({week} in the last week)", {
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
  return health.finish();
}
