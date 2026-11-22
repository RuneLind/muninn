/**
 * The weekly `youtube-discovery` watcher (plan muninn-youtube-discovery, PR 3;
 * outcomes reworked by architecture review 2026-11-16, F14/F16): the YouTube
 * summaries captured in its window, the newest not yet searched first, at most
 * `maxSeeds` (5), each searched as its own discovery run and stored as a shelf on
 * `/summaries/discover` (`origin = 'watcher'`). It sends no alert of its own: the
 * shelves are the output (D5). Its failures go to `source-health.ts`, which
 * escalates after ONE failed weekly run (`runEscalateAfter`, shared with run health).
 *
 * The window (`discoveryWindowStart`): the last 7 days, widened back to the day of
 * this bot's newest stored watcher run (≤14 days), and further back to the oldest
 * seed an earlier run left unsearched (its cap, its deadline; ≤28 days, `carryFrom`).
 * A seed already searched (by any origin) is skipped.
 *
 * A seed whose run made no shelf (every search failed, a model call failed, the
 * save failed) stores NO row: an earlier shelf of that seed stays as it was, and
 * the watcher's window anchor (its newest stored run) does not move. It is
 * recorded in `watcher_snapshots` (`youtube-discovery:state`, {@link DiscoveryState})
 * and retried after this week's seeds, in the slots they left under `maxSeeds` plus
 * {@link MAX_RETRIES_PER_RUN} of its own, fewest attempts first, up to
 * {@link MAX_SEED_ATTEMPTS} failed attempts in all; the exhausted warning is logged
 * once. Retries stand down in a run whose week seeds all failed (the dependency is
 * down: an attempt then would only spend the seed's cap). A shelf whose searches
 * partly failed is kept, with its `failed` count, and is not retried. A record or a
 * carried seed that falls past the 28-day floor unsearched is warned about once and
 * counted on `youtube:store`.
 *
 * The state is written BEFORE any seed runs (a checkpoint carrying every week seed and
 * every planned retry's attempt), so a run whose final save fails loses nothing; a run
 * that cannot read or checkpoint the state stands down and searches nothing.
 *
 * Health keys, each judged only over the seeds that reached its step:
 *   - `youtube:huginn` — the listing, then each seed's raw read (ok when no read ran)
 *   - `youtube:model`  — the queries and rank calls
 *   - `youtube:search` — the yt-dlp searches (a seed fails it when every search failed)
 *   - `youtube:store`  — saving each shelf (the watcher's only output)
 * A key is `error` when at least half of the seeds that reached its step failed it
 * (`partial` when some passed and the run stored a shelf), `ok` otherwise with any failures counted in its
 * detail, carried when no seed reached it.
 *
 * The run keeps inside the runner's net: every model call carries one run-wide
 * `deadlineAt` (min(net, tick) minus the net's margin, so `health.finish()` still runs), and
 * no seed starts with less than {@link MIN_SEED_MS} left. A seed whose model call the deadline
 * cuts is no failure of the seed or the model: it is left for the next run uncharged, and
 * `youtube:model` does not count it.
 */

import type { Watcher, WatcherAlert } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { HaikuTelemetry } from "../scheduler/executor.ts";
import { loadConfig } from "../config.ts";
import { Tracer } from "../tracing/tracer.ts";
import { extractYouTubeVideoId } from "../youtube/url.ts";
import { defaultDiscoverServices, YOUTUBE_SUMMARIES_COLLECTION, type DiscoverServices } from "../youtube/discover-deps.ts";
import { runDiscovery, type DiscoverRunOutcome, type DiscoverTracer } from "../youtube/discover-run.ts";
import { carryFloorDay, discoveryWindowStart, seedsSince, toSeedDocs, DISCOVER_MAX_CARRY_DAYS, DISCOVER_SEED_CAP, type SeedDoc } from "../youtube/discover-seeds.ts";
import { readIntKnob } from "./config-knobs.ts";
import {
  getDiscoverKnownVideoIds,
  getLatestDiscoverRunAt,
  getLatestDiscoverRunTimes,
  saveDiscoverRun,
  type DiscoverHitInput,
  type DiscoverRunInput,
} from "../db/youtube-discover.ts";
import { getWatcherSnapshot, setWatcherSnapshot } from "../db/watchers.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { openSourceHealth, type SourceHealthRecorder } from "./source-health.ts";
import { effectiveCadenceMs, runEscalateAfter } from "./run-health.ts";
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
/**
 * A model call that fails with less than this left before the run's deadline was cut by it: the
 * router bounds its last attempt at the deadline itself, so such a call rejects at or after it.
 */
export const DEADLINE_CUT_SLACK_MS = 1_000;
/** Failed attempts (the first one included) after which a seed is no longer retried. */
export const MAX_SEED_ATTEMPTS = 3;
/**
 * Retries a run may make beyond `maxSeeds`: one default week's seeds, so any steady failure
 * rate up to 5 a week clears every run; a larger backlog clears 5 a run, oldest seed first,
 * and what passes the 28-day floor first is dropped and reported.
 */
export const MAX_RETRIES_PER_RUN = DISCOVER_SEED_CAP;
/** The `watcher_snapshots` key holding {@link DiscoveryState}. */
export const DISCOVERY_STATE_KEY = "youtube-discovery:state";

/** A seed whose last attempt made no shelf. */
export interface DiscoveryRetry {
  /** Failed attempts in a row, the first one included. */
  attempts: number;
  /** Epoch ms of the last failed attempt: a run of the seed stored after it (any origin) ends the retry. */
  lastAt: number;
  error: string;
  /** Set once attempts reach {@link MAX_SEED_ATTEMPTS}: not retried, and the warning is not logged again. */
  exhausted?: true;
}

/** The watcher's carried state between weekly runs. */
export interface DiscoveryState {
  /** The oldest seed day the last run left unsearched (cap or deadline), or null. */
  carryFrom: string | null;
  /** Doc id → its failed attempts. */
  retry: Record<string, DiscoveryRetry>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRetry(v: unknown): DiscoveryRetry | null {
  if (!isObject(v)) return null;
  const { attempts, lastAt, error, exhausted } = v;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) return null;
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt)) return null;
  return { attempts, lastAt, error: typeof error === "string" ? error : "", ...(exhausted === true ? { exhausted: true as const } : {}) };
}

/**
 * The stored state, keeping every part that is well formed: a malformed `carryFrom` reads
 * as null and a malformed retry entry is dropped, each named in `malformed`, so one bad
 * entry never resets `carryFrom` and the other records.
 */
export function parseDiscoveryState(v: unknown): { state: DiscoveryState; malformed: string[] } {
  const malformed: string[] = [];
  if (v === null || v === undefined) return { state: { carryFrom: null, retry: {} }, malformed };
  if (!isObject(v)) return { state: { carryFrom: null, retry: {} }, malformed: ["the whole state"] };
  let carryFrom: string | null = null;
  if (typeof v.carryFrom === "string" && DAY_RE.test(v.carryFrom)) carryFrom = v.carryFrom;
  else if (v.carryFrom !== null && v.carryFrom !== undefined) malformed.push("carryFrom");
  const retry: Record<string, DiscoveryRetry> = {};
  if (isObject(v.retry)) {
    for (const [id, r] of Object.entries(v.retry)) {
      const ok = parseRetry(r);
      if (ok) retry[id] = ok;
      else malformed.push(`retry[${id}]`);
    }
  } else if (v.retry !== undefined) malformed.push("retry");
  return { state: { carryFrom, retry }, malformed };
}

export interface YouTubeDiscoveryDeps {
  services: Pick<DiscoverServices, "readRaw" | "queriesCall" | "rankCall" | "search" | "listCaptured">;
  saveRun: (run: DiscoverRunInput, hits: readonly DiscoverHitInput[]) => Promise<string>;
  storedKnownIds: () => Promise<Set<string>>;
  latestRunTimes: (docIds: readonly string[]) => Promise<Map<string, number>>;
  /** When this bot's newest watcher run was stored, or null: the window's anchor. */
  lastWatcherRunAt: (botName: string) => Promise<number | null>;
  /** The stored {@link DiscoveryState} (any value; validated by the caller), or null. */
  loadState: (watcherId: string) => Promise<unknown>;
  saveState: (watcherId: string, state: DiscoveryState) => Promise<void>;
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
    loadState: (id) => getWatcherSnapshot(id, DISCOVERY_STATE_KEY),
    saveState: (id, state) => setWatcherSnapshot(id, DISCOVERY_STATE_KEY, state),
    profile: (userId, botName) => loadInterestProfile(userId, botName),
    // Run health's rule (F16): a weekly row escalates after one failed run, not three weeks.
    health: (w) => openSourceHealth(w.id, w.name, Date.now(), { escalateAfter: runEscalateAfter(effectiveCadenceMs(w)) }),
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

/** One step's tally over this run's seeds: how many reached it, how many failed it, the first failure. */
export interface StepTally {
  reached: number;
  failed: number;
  detail?: string;
}

export interface RunTally {
  huginn: StepTally;
  model: StepTally;
  search: StepTally;
  /** Searches run and failed across every seed that reached the search step. */
  searches: { ran: number; failed: number };
}

export const emptyTally = (): RunTally => ({
  huginn: { reached: 0, failed: 0 },
  model: { reached: 0, failed: 0 },
  search: { reached: 0, failed: 0 },
  searches: { ran: 0, failed: 0 },
});

/**
 * Which steps one outcome reached and failed (`runDiscovery` runs read → queries → search → rank).
 * A seed's searches count whatever later step failed. `deadlineCut`: the model call was cut by the
 * run's deadline, which says nothing about the model, so the model step is not counted at all.
 */
export function tallyOutcome(out: DiscoverRunOutcome, t: RunTally, deadlineCut = false): void {
  const fail = (s: StepTally, detail: string) => {
    s.reached++;
    s.failed++;
    s.detail ??= detail;
  };
  const pass = (s: StepTally) => void s.reached++;
  if (out.ok) {
    pass(t.huginn);
    pass(t.model);
    pass(t.search);
    t.searches.ran += out.queries.length;
    t.searches.failed += out.failed;
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
      if (!deadlineCut) fail(t.model, why);
      return;
    case "search":
      pass(t.huginn);
      pass(t.model);
      fail(t.search, why);
      t.searches.ran += out.searches ?? 0;
      t.searches.failed += out.failed ?? out.searches ?? 0;
      return;
    case "rank":
      pass(t.huginn);
      pass(t.search);
      t.searches.ran += out.searches ?? 0;
      t.searches.failed += out.failed ?? 0;
      if (!deadlineCut) fail(t.model, why);
      return;
  }
}

/**
 * One key's verdict: `error` when at least half of the seeds that reached the step
 * failed it, else `ok`, with the failures in the detail. The error is `partial` only
 * when some seeds passed the step AND the run stored a shelf (`shelves`): the alert
 * then says part of the run succeeded, which a run with no shelf would make false.
 */
export function markStep(health: SourceHealthRecorder, key: string, s: StepTally, shelves: number, extra?: string): void {
  if (s.reached === 0) return health.carry(key);
  const seeds = s.failed > 0 ? `${s.failed} of ${s.reached} seed${s.reached === 1 ? "" : "s"} failed: ${s.detail ?? "no detail"}` : "";
  const detail = [seeds, extra ?? ""].filter(Boolean).join("; ");
  if (s.failed * 2 >= s.reached) health.mark(key, "error", detail, { partial: s.failed < s.reached && shelves > 0 });
  else health.mark(key, "ok", detail || undefined);
}

/** A seed this run will try: one of the window's, or a retry of one that failed. */
interface Planned {
  seed: SeedDoc;
  retry: boolean;
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

  // A run that cannot record its seeds moves none of them: it searches nothing, stores no
  // shelf (so the window anchor stays), and leaves the stored state as it was.
  const standDown = (why: string) => {
    log.warn("YouTube discovery: {why}; searching nothing this run", { botName, why });
    health.mark(HEALTH_HUGINN, "ok");
    health.carry(HEALTH_MODEL);
    health.carry(HEALTH_SEARCH);
    health.mark(HEALTH_STORE, "error", why);
    return health.finish();
  };

  let rawState: unknown;
  try {
    rawState = await deps.loadState(watcher.id);
  } catch (err) {
    return standDown(`reading the retry state failed: ${errText(err)}`);
  }
  const { state: prior, malformed } = parseDiscoveryState(rawState);
  if (malformed.length > 0)
    log.warn("YouTube discovery: dropped malformed parts of the retry state: {parts}", { botName, parts: malformed.join(", ") });

  // Anchored on the newest STORED watcher run: the runner writes `last_success_at` for email only.
  const lastRun = await deps.lastWatcherRunAt(botName).catch((err) => {
    log.warn("YouTube discovery: reading the last watcher run failed, using the last 7 days: {error}", { botName, error: errText(err) });
    return null;
  });
  const runStart = now();
  const docs = toSeedDocs(listed);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const floor = carryFloorDay(runStart);
  // A retry record lasts while its seed is listed and young enough to be in some window; one
  // whose seed passed the floor before it was exhausted is a loss, reported below.
  const retry: Record<string, DiscoveryRetry> = {};
  const floorDropped: SeedDoc[] = [];
  for (const [id, r] of Object.entries(prior.retry)) {
    const d = byId.get(id);
    if (!d?.date) continue;
    if (d.date >= floor) retry[id] = r;
    else if (!r.exhausted) floorDropped.push(d);
  }
  // Seeds the last run left (its cap, its deadline) that are now older than the floor.
  const priorCarry = prior.carryFrom;
  const carryBand =
    priorCarry && priorCarry < floor
      ? docs.filter((d) => d.date !== null && d.date >= priorCarry && d.date < floor && !prior.retry[d.id])
      : [];
  const window = seedsSince(docs, discoveryWindowStart(runStart, lastRun, prior.carryFrom), Infinity);
  let recent = new Map<string, number>();
  let recentRead = true;
  try {
    recent = await deps.latestRunTimes([...new Set([...window.map((s) => s.id), ...Object.keys(retry), ...carryBand.map((d) => d.id)])]);
  } catch (err) {
    recentRead = false;
    log.warn("YouTube discovery: reading earlier runs failed, searching every seed: {error}", { botName, error: errText(err) });
  }
  // Without the run times a carried seed that was searched cannot be told from one that was not.
  if (recentRead) floorDropped.push(...carryBand.filter((d) => !recent.has(d.id)));
  // A seed searched (any origin) at or after its failed attempt has a shelf now: its retry is over.
  // `>=`: a checkpoint's pre-charged attempt is stamped with the run's start (see below).
  for (const [id, r] of Object.entries(retry)) if ((recent.get(id) ?? -Infinity) >= r.lastAt) delete retry[id];

  const maxSeeds = resolveMaxSeeds(watcher.config, { botName, watcherId: watcher.id });
  // Searched once is enough: a doc in the window was captured inside it, so any search of it is this
  // window's. A seed with a retry record is handled by the retry budget below, never as a week seed.
  const week = window.filter((s) => !recent.has(s.id) && !retry[s.id]);
  // Every record gets a turn before any gets a second: fewest attempts first, then the oldest
  // seed (the nearest the floor), then the oldest failure.
  const retries = Object.entries(retry)
    .filter(([, r]) => !r.exhausted)
    .sort(([a, ra], [b, rb]) => {
      const da = byId.get(a)!.date!;
      const db = byId.get(b)!.date!;
      return ra.attempts - rb.attempts || (da < db ? -1 : da > db ? 1 : 0) || ra.lastAt - rb.lastAt || (a < b ? -1 : 1);
    })
    .map(([id]) => byId.get(id)!);
  // This week's seeds first, under `maxSeeds`; retries take what they left plus a budget of their own.
  const plannedRetries = retries.slice(0, Math.max(0, maxSeeds - week.length) + MAX_RETRIES_PER_RUN);
  const plan: Planned[] = [
    ...week.slice(0, maxSeeds).map((seed) => ({ seed, retry: false })),
    ...plannedRetries.map((seed) => ({ seed, retry: true })),
  ];

  const oldestDay = (seeds: readonly SeedDoc[]) =>
    seeds.reduce<string | null>((min, s) => (s.date && (!min || s.date < min) ? s.date : min), null);
  // The checkpoint, written before any seed runs: every week seed is still carried, and every
  // planned retry's attempt is already counted. If the final save fails, the next run reads
  // this, so no seed this run leaves is lost and no exhausted seed is retried (or warned) again.
  const checkpoint: DiscoveryState = { carryFrom: oldestDay(week), retry: { ...retry } };
  for (const seed of plannedRetries) {
    const r = retry[seed.id]!;
    const attempts = r.attempts + 1;
    checkpoint.retry[seed.id] = { ...r, attempts, lastAt: runStart, ...(attempts >= MAX_SEED_ATTEMPTS ? { exhausted: true as const } : {}) };
  }
  try {
    await deps.saveState(watcher.id, checkpoint);
  } catch (err) {
    return standDown(`saving the retry state failed: ${errText(err)}`);
  }
  for (const d of floorDropped) {
    const r = prior.retry[d.id];
    log.warn("YouTube discovery: {doc} ({date}) passed the {days}-day carry floor unsearched and is dropped: {why}", {
      botName,
      doc: d.id,
      date: d.date,
      days: DISCOVER_MAX_CARRY_DAYS,
      why: r ? `${r.attempts} failed attempt(s), last: ${r.error}` : "left by an earlier run",
    });
  }

  const tally = emptyTally();
  const store: StepTally = { reached: 0, failed: 0 };
  const captured = new Set(listed.map((d) => extractYouTubeVideoId(d.url ?? "")).filter((id): id is string => !!id));
  // Videos this run already put on a shelf: one video lands on one shelf per run.
  const shelved = new Set<string>();
  // Known = captured ∪ dismissed ∪ queued ∪ shelved this run; the store half is re-read per seed.
  const knownIds = async () => {
    const stored = await deps.storedKnownIds().catch(() => new Set<string>());
    return new Set([...captured, ...stored, ...shelved]);
  };
  const opts = { deadlineAt };
  // Set when a model call of the current seed rejects at the deadline (see DEADLINE_CUT_SLACK_MS).
  let cut = false;
  const bounded =
    <A extends unknown[]>(call: (...a: A) => Promise<string>) =>
    async (...a: A): Promise<string> => {
      try {
        return await call(...a);
      } catch (err) {
        if (deadlineAt - now() < DEADLINE_CUT_SLACK_MS) cut = true;
        throw err;
      }
    };
  // The owner's interest profile, read once per run (it changes weekly at most).
  let profile: Promise<string | null> | null = null;
  const loadProfile = () => (profile ??= deps.profile(watcher.userId, botName));

  const recordFailure = (seed: SeedDoc, error: string) => {
    const attempts = (retry[seed.id]?.attempts ?? 0) + 1;
    const exhausted = attempts >= MAX_SEED_ATTEMPTS;
    retry[seed.id] = { attempts, lastAt: now(), error, ...(exhausted ? { exhausted: true as const } : {}) };
    if (exhausted)
      log.warn("YouTube discovery: {doc} failed {attempts} times; not retried again: {error}", { botName, doc: seed.id, attempts, error });
  };

  let shelves = 0;
  let retried = 0;
  // Week seeds that reached an outcome (a seed deleted since the listing did not), and how many made a shelf.
  let weekRan = 0;
  let weekShelves = 0;
  let stoodDown = 0;
  const started = new Set<string>();
  for (const [i, { seed, retry: isRetry }] of plan.entries()) {
    if (deadlineAt - now() < MIN_SEED_MS) break;
    // Every week seed failed: the dependency is down, and a retry now would only spend its cap.
    if (isRetry && weekRan > 0 && weekShelves === 0) {
      stoodDown = plan.length - i;
      break;
    }
    started.add(seed.id);
    if (isRetry) retried++;
    cut = false;
    const tracer = deps.tracer?.(botConfig) ?? null;
    const out = await runDiscovery(
      {
        readRaw: deps.services.readRaw,
        queriesCall: bounded((p, b, t) => deps.services.queriesCall(p, b, t, opts)),
        rankCall: bounded((p, b, t) => deps.services.rankCall(p, b, t, opts)),
        search: deps.services.search,
        knownIds,
        profile: loadProfile,
      },
      botConfig,
      tracer,
      { collection: YOUTUBE_SUMMARIES_COLLECTION, docId: seed.id },
    );
    const deadlineCut = cut && !out.ok && out.code === "model_failed";
    tallyOutcome(out, tally, deadlineCut);
    if (deadlineCut) {
      // The run ran out of time, not the seed: no attempt is charged, and a week seed stays a
      // seed (carried). A retry keeps its record as it was; only a failed final save leaves the
      // checkpoint's pre-charged attempt standing.
      log.warn("YouTube discovery: the run's deadline cut {doc}; left for the next run", { botName, doc: seed.id });
      started.delete(seed.id);
      if (isRetry) retried--;
      break;
    }
    if (!isRetry && (out.ok || out.code !== "not_found")) weekRan++;
    if (!out.ok) {
      log.warn("YouTube discovery: {code} for {doc}: {error}", { botName, doc: seed.id, code: out.code, error: out.cause ?? out.error });
      // A seed deleted since the listing is gone, not failed: nothing to retry.
      if (out.code === "not_found") delete retry[seed.id];
      else recordFailure(seed, out.cause ?? out.error);
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
          failed: out.failed,
        },
        out.results,
      );
      shelves++;
      if (!isRetry) weekShelves++;
      delete retry[seed.id];
      for (const r of out.results) shelved.add(r.videoId);
    } catch (err) {
      store.failed++;
      store.detail ??= errText(err);
      log.warn("YouTube discovery: saving the run for {doc} failed: {error}", { botName, doc: seed.id, error: errText(err) });
      recordFailure(seed, `save failed: ${errText(err)}`);
    }
  }

  // Window seeds this run did not start (the cap, the deadline) stay seeds next run.
  const left = week.filter((s) => !started.has(s.id));
  const carryFrom = oldestDay(left);
  if (left.length > 0) log.warn("YouTube discovery: {left} of {week} seeds left for the next run", { botName, left: left.length, week: week.length });
  if (stoodDown > 0)
    log.warn("YouTube discovery: every week seed failed; {n} retries stood down until a run with a shelf", { botName, n: stoodDown });
  log.info("YouTube discovery: {shelves} shelves from {started} seeds ({retried} retries; {week} new in the window)", {
    botName,
    shelves,
    started: started.size,
    retried,
    week: week.length,
  });
  // One retry of the save; if both fail, the checkpoint stands (nothing lost, see above).
  let saveError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.saveState(watcher.id, { carryFrom, retry });
      saveError = null;
      break;
    } catch (err) {
      saveError = errText(err);
    }
  }
  if (saveError) log.warn("YouTube discovery: saving the retry state failed twice; the checkpoint stands: {error}", { botName, error: saveError });

  // The listing answered: huginn is ok unless half the raw reads that ran failed.
  if (tally.huginn.reached === 0) health.mark(HEALTH_HUGINN, "ok");
  else markStep(health, HEALTH_HUGINN, tally.huginn, shelves);
  markStep(health, HEALTH_MODEL, tally.model, shelves);
  const s = tally.searches;
  markStep(health, HEALTH_SEARCH, tally.search, shelves, s.failed > 0 ? `${s.failed} of ${s.ran} searches failed` : undefined);
  // A seed dropped at the floor is output lost for good: it counts as a failed store.
  const extras: string[] = [];
  if (floorDropped.length > 0) {
    store.reached += floorDropped.length;
    store.failed += floorDropped.length;
    store.detail ??= `passed the ${DISCOVER_MAX_CARRY_DAYS}-day carry floor unsearched`;
    extras.push(`${floorDropped.length} seed${floorDropped.length === 1 ? "" : "s"} dropped unsearched at the ${DISCOVER_MAX_CARRY_DAYS}-day carry floor`);
  }
  if (saveError) {
    extras.push(`saving the retry state failed: ${saveError}`);
    health.mark(HEALTH_STORE, "error", extras.join("; "), { partial: shelves > 0 });
  } else markStep(health, HEALTH_STORE, store, shelves, extras.join("; ") || undefined);
  return health.finish();
}
