/**
 * Pure, side-effect-free model + HTML builders for the /wiki/gardener "Ingest
 * backlog" strip. Split out from `wiki-gardener-browser.ts` (which touches the
 * DOM at module load, so it can't be imported in tests) so the strip's numbers,
 * control gating, and confirm-panel copy are unit-testable without a DOM — the
 * same split rationale as `wiki-ask-render.ts` / `wiki-filter.ts`.
 *
 * The honest-numbers contract lives here: "offered in past runs" and the reset
 * gate/label both use the server-computed `offeredStillQueued` (queued ∩ offered),
 * NOT the raw all-time `offered` field and NOT a client-side `queued − remaining`
 * derivation. The all-time offered set includes since-consumed keys, and the
 * drain's age floor makes `remaining` exclude merely-too-fresh docs, so neither
 * `offered` nor `queued − remaining` equals the offered-and-still-queued truth —
 * the route emits it explicitly. `batchSize`/`maxProposals` come from the
 * GET response (sourced from `src/gardener/backlog.ts`) so the client never
 * hardcodes them; when live fields are absent (the GET's degraded catch branch)
 * every number falls back cleanly to a real integer — never `NaN`/`undefined`.
 */

import { escHtml as esc } from "./escape.ts";

export interface BacklogCollection {
  collection: string;
  source: string;
  label: string;
  total: number;
  ingested: number;
  queued: number;
}

/**
 * Hand-mirror of `src/gardener/cluster.ts`'s `ClusterDropTally` — the per-reason
 * cluster-drop counts. Kept as a standalone interface (not imported) so the client
 * bundle never pulls in gardener logic, the same reason {@link LastBacklogRun} is
 * declared twice.
 */
export interface BacklogDropTally {
  clusters_dropped: number;
  clusters_dropped_size: number;
  clusters_dropped_skip: number;
  clusters_dropped_hallucinated: number;
  clusters_dropped_duplicate: number;
  clusters_dropped_cap: number;
  clusters_dropped_reserved: number;
  clusters_dropped_topics: string;
}

export interface LastBacklogRun {
  finishedAt: number;
  offered: number;
  drafted: number;
  error?: string;
  /** Set when the run was soft-cancelled — `drafted` of `of` clusters drafted. */
  cancelled?: { drafted: number; of: number };
  /**
   * Set when the eligible batch was below the cluster minimum — the run was
   * provably unable to draft, so nothing was offered/journalled/run. `eligible`
   * is the too-small batch size.
   */
  outcome?: "insufficient";
  eligible?: number;
  /** The resolved threshold the guard fired against — per-bot configurable, default 3. */
  minClusterSize?: number;
  /** Docs the run attempted (assembled batch size) — the zero-draft reason line's count. */
  attemptedDocs?: number;
  /** Aggregate cluster-drop tally — absent when the pipeline never clustered. */
  dropTally?: BacklogDropTally;
  /**
   * Post-gate cluster survivor count. `keptClusters > 0` with `drafted === 0` means
   * clusters formed and passed the gate but every draft attempt failed — the zero-draft
   * reason line renders the honest draft-failure copy instead of a false size failure.
   */
  keptClusters?: number;
  /**
   * Source pages the low-volume fallback (R4) drafted when the gardener produced ZERO
   * cluster proposals (insufficient batch / harvest floor / cluster-size gate). Distinct
   * from {@link drafted} (gardener CLUSTER proposals) — when > 0 the outcome/reason copy
   * reports "drafted N source pages (fallback — nothing clustered)" instead of empty.
   * Mirrors the journal shape in `src/gardener/backlog.ts` — keep both in sync.
   */
  fallbackDrafted?: number;
}

/**
 * Hand-mirror of `src/gardener/backlog.ts`'s `WeeklyGardenerRun` — the most recent
 * WEEKLY gardener run's outcome (the watcher path, distinct from the manual drain's
 * {@link LastBacklogRun}). Declared here so the client bundle never imports gardener
 * logic (same rationale as {@link LastBacklogRun}/{@link BacklogDropTally}). Keep in
 * sync with the write-side shape.
 */
export interface WeeklyGardenerRun {
  finishedAt: number;
  clustersFound: number;
  kept: number;
  dropped: number;
  dropTally: BacklogDropTally;
  evictedTopics: { topicKey: string; reason: string; size: number }[];
}

/**
 * The bot's `wiki-gardener` watcher, projected for the strip's fresh segment (the
 * "Run gardener now" affordance + next-run time). Merged into the LIVE fields on
 * every GET (never cached), mirroring the server's `BacklogWatcherInfo`. Absent on
 * a degraded/older server ⇒ the fresh segment falls back to the plain
 * "weekly watcher's turf" note.
 */
export interface BacklogWatcherInfo {
  id: string;
  enabled: boolean;
  /** Epoch ms of the last run (null ⇒ never run ⇒ due on the next tick). */
  lastRunAt: number | null;
  /** Epoch ms of the next scheduled run (null ⇒ due on the next tick). */
  nextRunAt: number | null;
  /** A force-run is already queued (a just-clicked "Run now", or an external trigger). */
  forceQueued: boolean;
}

/** Live progress of an in-flight backlog drain (mirrors the server shape). */
export interface BacklogProgress {
  stage: "assembling" | "harvesting" | "clustering" | "resolving" | "drafting";
  draftsDone: number;
  draftsTotal: number;
  currentTopic?: string;
  startedAt: number;
  cancelRequested: boolean;
}

export interface IngestBacklogResponse {
  byCollection: BacklogCollection[];
  total: number;
  ingested: number;
  queued: number;
  wikiUrlCount: number;
  generatedAt: number;
  errors?: { source: string; collection: string; error: string }[];
  error?: string;
  // Live fields (PR 2) — merged fresh on every response, outside the TTL cache.
  running?: boolean;
  offered?: number;
  remaining?: number;
  /** Queued docs also in the offered set — the honest "offered in past runs" count. */
  offeredStillQueued?: number;
  /** Queued docs a human DISMISSED — the fourth bucket (absent/older server ⇒ 0). */
  dismissed?: number;
  /** Queued docs still inside the weekly watcher's window — the "new arrivals" lead. */
  fresh?: number;
  /**
   * Per-source breakdown of `fresh` (non-zero sources only). `collection` is the
   * stable key the per-source inspector toggle scopes on (optional — an older
   * server omits it, in which case the toggle falls back to the whole bucket).
   */
  freshBySource?: { label: string; count: number; collection?: string }[];
  /** The resolved age-floor window in days — labels "new (last Nd)"; 0/absent ⇒ degraded. */
  freshWindowDays?: number;
  /**
   * The bot's resolved minimum cluster size (per-bot, from `resolveGardenerConfig` —
   * NOT the merge-time `batchSize`/`maxProposals`). The run-suggestion meter derives
   * its threshold from this; absent/≤0 (degraded/older server) ⇒ the meter hides.
   */
  minClusterSize?: number;
  /** The bot's wiki-gardener watcher (next-run + Run-now affordance). Null/absent ⇒ no affordance. */
  watcher?: BacklogWatcherInfo | null;
  watcherSeeded?: boolean;
  /**
   * Whether the wiki gardener is enabled for this bot. Gates the source-draft
   * button — the source-draft route 400s when the gardener is disabled, so the
   * button must hide to match. Absent (degraded/older server) ⇒ treated as enabled.
   */
  gardenerEnabled?: boolean;
  lastBacklogRun?: LastBacklogRun | null;
  /** The most recent WEEKLY gardener run's outcome (watcher path). Null/absent ⇒ never completed a clustering pass. */
  weeklyRun?: WeeklyGardenerRun | null;
  /** Live drain progress (null when idle / a weekly run holds the mutex). */
  progress?: BacklogProgress | null;
  /** Interrupted (crashed/errored) run awaiting Recover/Dismiss (PR 3). */
  interrupted?: { at: number; batchSize: number; drafted: number } | null;
  // Batch constants (PR 1) — echoed from src/gardener/backlog.ts so the confirm
  // panel renders "drain a batch of N … up to M drafts" without hardcoding.
  batchSize?: number;
  maxProposals?: number;
  /**
   * The per-doc partition behind the counts — present ONLY on the inspector's
   * opt-in `?docs=1` fetch (the 3s drain poll stays count-only).
   */
  docs?: BacklogDoc[];
}

/**
 * Which live bucket a queued doc falls in (mirrors the route's `BacklogBucket`).
 * `dismissed` is the human-pruned bucket — excluded from every actionable count and
 * from every selection seam, and it WINS over `offered` when a doc is in both.
 */
export type BacklogBucket = "fresh" | "drainable" | "offered" | "dismissed";

/**
 * One inspector row (mirrors the route's `BacklogDocRow` — hand-declared here for
 * the same client-bundle-hygiene reason as {@link LastBacklogRun}: the client must
 * never import route/gardener modules).
 */
export interface BacklogDoc {
  collection: string;
  id: string;
  /** The id's basename, extension stripped — the row's visible label. */
  label: string;
  bucket: BacklogBucket;
  date?: string;
  /** The doc's original source URL (http(s) only is linkified). */
  url?: string;
}

/**
 * The inspector panel's module-level state. Lives OUTSIDE the strip's DOM (the
 * drain poller replaces the strip's innerHTML every 3s, which would otherwise
 * slam the panel shut — the same footgun the tail `<details>` open-state guards
 * against), so open/filter/paging survive every re-render.
 */
export interface BacklogInspectorState {
  open: boolean;
  /** Bucket filter — `"all"` shows every queued doc. */
  bucket: BacklogBucket | "all";
  /** Collection filter — `""` shows every collection. */
  collection: string;
  loading: boolean;
  error: string | null;
  /** Null until the first lazy fetch resolves. */
  docs: BacklogDoc[] | null;
  /** How many filtered rows to render (paging guard for tail-heavy bots). */
  limit: number;
  /**
   * Doc keys (`<collection>/<id>`) whose DELETE is in flight — huginn's 200 only
   * means "source moved + reindex started", so the row stays "removing…" until the
   * reindex poll goes terminal (see the delete route). Also used as a per-row
   * re-entrancy guard for the dismiss verbs.
   */
  removing: string[];
}

/** How many rows the inspector renders per page (Show more adds another page). */
export const INSPECTOR_PAGE_SIZE = 200;

/** A fresh, closed inspector state — the client's module-level seed. */
export function initialInspectorState(): BacklogInspectorState {
  return {
    open: false,
    bucket: "all",
    collection: "",
    loading: false,
    error: null,
    docs: null,
    limit: INSPECTOR_PAGE_SIZE,
    removing: [],
  };
}

/** The pure, testable model behind the strip — numbers + control gating. */
export interface BacklogStripModel {
  totalNeverIngested: number;
  /** All-time doc total across every collection — the coverage sentence's denominator. */
  allTimeTotal: number;
  perSource: { label: string; queued: number; total: number; collection: string }[];
  eligibleNow: number;
  offeredStillQueued: number;
  /**
   * Queued docs a human dismissed (the fourth bucket). Presented as a tail chip +
   * a "Reset dismissed" affordance — see {@link backlogTailHtml} for why the
   * COVERAGE sentence keeps counting them while the actionable counts do not.
   */
  dismissedCount: number;
  /** New arrivals inside the watcher window (the sentence's lead segment). */
  freshTotal: number;
  freshPerSource: { label: string; count: number; collection?: string }[];
  /** Age-floor window in days; 0 ⇒ degraded response, hide the fresh segment. */
  freshWindowDays: number;
  /**
   * The bot's resolved minimum cluster size (the run-suggestion meter's threshold
   * basis; meter threshold = 2×). 0 ⇒ absent/degraded response ⇒ the meter hides.
   */
  minClusterSize: number;
  /**
   * The wiki-gardener watcher id when a manual "Run gardener now" is offered:
   * non-null iff there are fresh docs, no run is in flight, and the watcher is
   * enabled with no force-run already queued. Null otherwise (renderer shows the
   * next-run text and/or the fallback note instead of a button).
   */
  watcherRunNow: { id: string } | null;
  /**
   * A force-run is already queued for the (enabled) watcher — the strip shows a
   * "queued — starts on the next scheduler tick" note instead of the button (and
   * the next-run text is suppressed so the two don't contradict). Only meaningful
   * when fresh > 0 (the renderer gates on that).
   */
  watcherQueued: boolean;
  /**
   * Relative next-weekly-run copy for the fresh segment ("next weekly run in ~4d"
   * / "~3h", or "next weekly run due on next tick" when never-run/past-due). Null
   * when there is no enabled watcher or the response is degraded (freshWindowDays 0).
   */
  nextRunText: string | null;
  draftsAwaitingReview: number;
  running: boolean;
  /** Live drain progress when this bot's own drain holds the mutex (else null). */
  progress: BacklogProgress | null;
  /** An interrupted run awaiting Recover/Dismiss (null when none) — banner source. */
  interrupted: { at: number; batchSize: number; drafted: number } | null;
  /** No wiki-gardener watcher seeded ⇒ hide the run/reset control entirely. */
  controlHidden: boolean;
  showRun: boolean;
  showReset: boolean;
  /**
   * Offer "Reset dismissed (N)" — mirrors {@link showReset} exactly (hidden without a
   * seeded watcher, hidden while a run holds the mutex since the route 409s then).
   */
  showDismissReset: boolean;
  /**
   * The inspector may render its prune buttons. Same gate as the Reset controls: the
   * dismissed set is keyed by the gardener watcher's id, so a bot with no seeded
   * watcher has nowhere to store it and the route 404s — hide rather than 404.
   */
  pruneEnabled: boolean;
  /** Queued but nothing drainable now (every past-floor doc already offered). */
  nothingDrainable: boolean;
  batchSize: number;
  maxProposals: number;
  /** How many docs a click drains now: min(batchSize, eligibleNow). */
  drainNow: number;
  /**
   * The per-article source-page drafter is offered: at least one collection has
   * uncovered docs and no run is in flight. Distinct from the gardener drain — it
   * drafts one `.mdx` source page per doc (batched, on an explicit click) into the
   * SAME review gate. Which collection it drafts is chosen in the strip's `<select>`
   * ({@link sourceDraftOptions}); the button gates on that collection's queue.
   */
  sourceDraftAvailable: boolean;
  /**
   * Per-collection options for the source-draft `<select>` — every collection the
   * ingest counter reports, with its queued count (the option label). Empty when
   * the strip has no backlog rows.
   */
  sourceDraftOptions: { collection: string; label: string; queued: number }[];
  /** The pre-selected collection — the one with the largest queue ("" when none). */
  sourceDraftDefaultCollection: string;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Defensive parse of the live `watcher` block (a degraded/older server may omit it
 * or emit a malformed shape). Returns null unless the id + booleans are the right
 * types; `lastRunAt`/`nextRunAt` are coerced to `number | null`.
 */
function parseWatcher(v: unknown): BacklogWatcherInfo | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id) return null;
  if (typeof w.enabled !== "boolean") return null;
  const lastRunAt = typeof w.lastRunAt === "number" && Number.isFinite(w.lastRunAt) ? w.lastRunAt : null;
  const nextRunAt = typeof w.nextRunAt === "number" && Number.isFinite(w.nextRunAt) ? w.nextRunAt : null;
  return { id: w.id, enabled: w.enabled, lastRunAt, nextRunAt, forceQueued: w.forceQueued === true };
}

/**
 * Relative "next weekly run" copy from the watcher's `nextRunAt`. Days granularity
 * at ≥1d, hours below; a never-run or past-due watcher is due on the next scheduler
 * tick. `now` is injected so the derivation stays pure/testable.
 */
function computeNextRunText(w: BacklogWatcherInfo, now: number): string {
  if (w.lastRunAt == null || w.nextRunAt == null || w.nextRunAt <= now) {
    return "next weekly run due on next tick";
  }
  const ms = w.nextRunAt - now;
  const hours = ms / 3_600_000;
  if (hours >= 24) {
    return `next weekly run in ~${Math.round(hours / 24)}d`;
  }
  return `next weekly run in ~${Math.max(1, Math.round(hours))}h`;
}

/**
 * Pure model derivation. `pendingDraftCount` comes from the proposal list the
 * page already loads (count of `status === "draft"`), passed in so this stays
 * DOM-free.
 */
export function backlogStripModel(
  data: IngestBacklogResponse,
  pendingDraftCount: number,
  now: number = Date.now(),
): BacklogStripModel {
  const queued = numOr(data.queued, 0);
  // Degraded response (no live fields) ⇒ remaining falls back to queued, i.e.
  // "all eligible, none offered yet" — a clean, add-up-able default.
  const remaining = numOr(data.remaining, queued);
  // Server-computed (queued ∩ offered) — NOT `queued − remaining`, which the age
  // floor would inflate by counting merely-too-fresh docs as offered. Falls back
  // to 0 on a degraded response (no live fields ⇒ "none offered yet").
  const offeredStillQueued = Math.max(0, numOr(data.offeredStillQueued, 0));
  // Fourth bucket. Absent on a degraded/older server ⇒ 0 ⇒ every dismissed
  // affordance hides, and the sentence reads exactly as it did before PR 2.
  const dismissedCount = Math.max(0, numOr(data.dismissed, 0));
  // Fresh bucket (new arrivals inside the watcher window). freshWindowDays doubles
  // as the presence marker: 0/absent ⇒ degraded response ⇒ the sentence hides the
  // fresh segment rather than showing a false "0 new".
  const freshWindowDays = Math.max(0, numOr(data.freshWindowDays, 0));
  const freshTotal = Math.max(0, numOr(data.fresh, 0));
  // Run-suggestion meter threshold basis (per-bot). 0 on a degraded/older server
  // (no field) ⇒ the meter renderer hides rather than dividing by a bogus threshold.
  const minClusterSize = Math.max(0, numOr(data.minClusterSize, 0));
  const freshPerSource = (Array.isArray(data.freshBySource) ? data.freshBySource : [])
    .filter(
      (s): s is { label: string; count: number; collection?: string } =>
        !!s && typeof s.label === "string" && typeof s.count === "number" && s.count > 0,
    )
    // A malformed/absent `collection` degrades the per-source toggle to the whole
    // fresh bucket rather than scoping on a bogus key.
    .map((s) => ({
      label: s.label,
      count: s.count,
      ...(typeof s.collection === "string" && s.collection ? { collection: s.collection } : {}),
    }));
  const running = data.running === true;
  const controlHidden = data.watcherSeeded === false;
  const batchSize = numOr(data.batchSize, 0);
  const maxProposals = numOr(data.maxProposals, 0);
  // Watcher affordance (fresh segment). Only an ENABLED watcher offers a next-run
  // time / Run-now button — a disabled watcher never fires even when force-queued
  // (getWatchersDueNow filters enabled=true), so it degrades to the plain note. The
  // fresh window doubles as the presence marker (0 ⇒ degraded ⇒ no watcher affordance).
  const watcher = parseWatcher(data.watcher);
  const watcherUsable = !!watcher && watcher.enabled && freshWindowDays > 0;
  const watcherQueued = watcherUsable && watcher!.forceQueued;
  const watcherRunNow =
    watcherUsable && !running && freshTotal > 0 && !watcher!.forceQueued
      ? { id: watcher!.id }
      : null;
  const nextRunText = watcherUsable ? computeNextRunText(watcher!, now) : null;
  // One pass over the reported collections feeds BOTH the tail breakdown and the
  // source-draft select (the latter is a strict subset of the former — same
  // collection/label/queued, clamped identically, so they can never disagree).
  const perSource = (data.byCollection || []).map((c) => ({
    label: c.label,
    queued: Math.max(0, numOr(c.queued, 0)),
    total: Math.max(0, numOr(c.total, 0)),
    collection: typeof c.collection === "string" ? c.collection : "",
  }));
  // Source-draft select options: one per reported collection, its queued count as
  // the label. The button is offered when ANY collection has uncovered docs; the
  // pre-selected collection is the one with the largest queue (the client can pick
  // another and the button re-gates on that collection's count).
  const sourceDraftOptions = perSource.map((s) => ({
    collection: s.collection,
    label: s.label,
    queued: s.queued,
  }));
  const sourceDraftDefaultCollection = sourceDraftOptions.length
    ? sourceDraftOptions.reduce((best, o) => (o.queued > best.queued ? o : best)).collection
    : "";
  return {
    totalNeverIngested: queued,
    allTimeTotal: Math.max(0, numOr(data.total, 0)),
    perSource,
    eligibleNow: remaining,
    offeredStillQueued,
    dismissedCount,
    freshTotal,
    freshPerSource,
    freshWindowDays,
    minClusterSize,
    watcherRunNow,
    watcherQueued,
    nextRunText,
    draftsAwaitingReview: Math.max(0, numOr(pendingDraftCount, 0)),
    running,
    progress: data.progress ?? null,
    interrupted: data.interrupted ?? null,
    controlHidden,
    showRun: !controlHidden && !running && remaining > 0,
    // Reset whenever offered-and-still-queued > 0 (not the raw all-time offered):
    // gating on `offered > 0` could render "Reset offered (0)" once every offered
    // key is consumed, where a reset would be a no-op anyway.
    showReset: !controlHidden && !running && offeredStillQueued > 0,
    showDismissReset: !controlHidden && !running && dismissedCount > 0,
    // The prune verbs need the watcher (dismissed snapshot FK) — same gate as Reset.
    // Deliberately NOT gated on `running`: the routes 409 cleanly under the mutex and
    // the panel is a reading surface, so the buttons stay visible mid-drain.
    pruneEnabled: !controlHidden,
    nothingDrainable: !controlHidden && !running && remaining <= 0 && queued > 0,
    batchSize,
    maxProposals,
    drainNow: Math.max(0, Math.min(batchSize, remaining)),
    // Independent of the watcher/drain (source pages need no offered-memory): offer
    // it whenever ANY collection has an uncovered tail and nothing is running. The
    // strip's <select> picks which collection to draft (default = largest queue);
    // the button re-gates on the selected collection's count client-side. Hidden
    // when the gardener is disabled (the route 400s then, mirroring the
    // control-hidden pattern); an absent `gardenerEnabled` (degraded server) ⇒ shown.
    sourceDraftAvailable:
      !running && data.gardenerEnabled !== false && sourceDraftOptions.some((o) => o.queued > 0),
    sourceDraftOptions,
    sourceDraftDefaultCollection,
  };
}

function strong(n: number): string {
  return `<span class="bk-strong">${n}</span>`;
}

/**
 * Wrap a count in an inspector toggle button. Every count in the strip that names
 * a set of docs becomes one of these — clicking opens the ONE shared inspector
 * panel filtered to `bucket` (+ `collection` when the count is per-source).
 *
 * `inspect` is the live panel state (absent on a plain render): a toggle whose
 * filter pair matches the OPEN panel renders pressed, so the strip always shows
 * which count the panel is currently showing.
 */
function inspectToggle(
  inner: string,
  bucket: BacklogBucket | "all",
  collection: string,
  inspect?: BacklogInspectorState,
): string {
  const active = !!inspect && inspect.open && inspect.bucket === bucket && inspect.collection === collection;
  return (
    `<button type="button" class="bk-toggle${active ? " bk-toggle-on" : ""}" ` +
    `data-backlog-inspect="${bucket}" data-inspect-collection="${esc(collection)}" ` +
    `aria-expanded="${active ? "true" : "false"}" title="Show these docs">${inner}</button>`
  );
}

/** "Label 4 · Label 2" — the per-source breakdown markup (sentence + tail share it). */
function perSourceBreakdownHtml(
  items: { label: string; n: number; collection?: string }[],
  bucket: BacklogBucket | "all",
  inspect?: BacklogInspectorState,
): string {
  return items
    .map((s) =>
      inspectToggle(
        `${esc(s.label)} <span class="bk-n">${s.n}</span>`,
        bucket,
        s.collection ?? "",
        inspect,
      ),
    )
    .join('<span class="bk-sep"> · </span>');
}

/**
 * The run-suggestion meter (pure HTML) — a tiny progress bar in the fresh segment
 * showing how the un-offered new-in-window count ({@link BacklogStripModel.freshTotal})
 * tracks toward a threshold where a gardener run is likely to draft something. The
 * threshold is **2× the bot's minClusterSize** (clustering needs `minClusterSize`
 * docs on ONE topic, so 2× scattered arrivals is the "likely at least one cluster"
 * heuristic) — sourced from the response, never hardcoded.
 *
 * It is purely **informational**: it renders NO button, so it never competes with the
 * existing "Run gardener now" affordance ({@link freshWatcherSuffixHtml}) that IS the
 * call-to-action. Below threshold it reports how many more arrivals would suggest a run;
 * once crossed it flips to "worth a gardener run" and hands the user off to that button.
 * It deliberately promises NO page count — a scattered fresh count can legitimately draft
 * zero, the exact false expectation this kills.
 *
 * Hidden when there are no fresh docs OR the response carries no usable `minClusterSize`
 * (degraded/older server ⇒ 0 ⇒ no threshold ⇒ no meter, never a NaN width).
 */
function freshMeterHtml(model: BacklogStripModel): string {
  if (model.freshTotal <= 0 || model.minClusterSize <= 0) return "";
  const threshold = 2 * model.minClusterSize;
  const crossed = model.freshTotal >= threshold;
  const pct = Math.max(0, Math.min(100, Math.round((model.freshTotal / threshold) * 100)));
  const fillClass = crossed ? "bk-meter-fill bk-meter-full" : "bk-meter-fill";
  const bar =
    `<span class="bk-meter" role="progressbar" aria-label="progress toward a suggested gardener run" ` +
    `aria-valuemin="0" aria-valuemax="${threshold}" ` +
    `aria-valuenow="${Math.min(model.freshTotal, threshold)}"><span class="${fillClass}" style="width:${pct}%"></span></span>`;
  const label = crossed
    ? `<span class="bk-note bk-meter-hit">worth a gardener run</span>`
    : `<span class="bk-note">${threshold - model.freshTotal} more to suggest a run</span>`;
  return `<span class="bk-sep"> · </span><span class="bk-run-meter">${bar}${label}</span>`;
}

/**
 * The fresh segment's trailing affordance (pure HTML). With watcher info present
 * (enabled watcher + a live response): the next-weekly-run time, plus either a
 * "Run gardener now" button ({@link BacklogStripModel.watcherRunNow}) or a
 * "queued — starts on the next scheduler tick" note ({@link BacklogStripModel.watcherQueued}),
 * which suppresses the next-run text so the queued state doesn't contradict it.
 * While a run is in flight only the next-run time shows (the control area's
 * running/progress rendering already owns the run state — no double-render). With
 * NO watcher info (a degraded/older server) it falls back to the original dead-end
 * "weekly watcher's turf" note. Empty when there are no fresh docs.
 */
function freshWatcherSuffixHtml(model: BacklogStripModel): string {
  if (model.freshTotal <= 0) return "";
  const hasWatcherInfo = model.nextRunText != null || !!model.watcherRunNow || model.watcherQueued;
  if (!hasWatcherInfo) {
    // Degraded/older server (no watcher block) — the original dead-end note.
    return ` <span class="bk-note">— weekly watcher's turf</span>`;
  }
  const parts: string[] = [];
  // A queued force-run wins: showing "next weekly run in ~Nd" alongside "queued —
  // starts on the next scheduler tick" reads as a contradiction, so the queued note
  // suppresses the next-run text.
  const queuedNoteShows = !model.running && model.watcherQueued;
  if (model.nextRunText && !queuedNoteShows) {
    parts.push(`<span class="bk-note">${esc(model.nextRunText)}</span>`);
  }
  if (!model.running) {
    if (model.watcherQueued) {
      parts.push(`<span class="bk-note bk-queued">gardener run queued — starts on the next scheduler tick</span>`);
    } else if (model.watcherRunNow) {
      parts.push(
        `<button class="gard-btn bk-run-watcher" data-backlog-action="run-watcher" ` +
          `data-watcher-id="${esc(model.watcherRunNow.id)}">Run gardener now</button>`,
      );
    }
  }
  return parts.map((p) => `<span class="bk-sep"> · </span>${p}`).join("");
}

/**
 * The honest labeled sentence (pure HTML string) — recency-first: the lead is
 * "how many NEW summaries aren't in the wiki" (the number the all-time totals
 * used to bury), then what a drain can act on now. The all-time accounting moved
 * into the collapsed tail ({@link backlogTailHtml}). On a degraded response
 * (no live fields ⇒ `freshWindowDays` 0) the fresh segment is hidden rather than
 * showing a false "0 new".
 */
export function backlogSentenceHtml(model: BacklogStripModel, inspect?: BacklogInspectorState): string {
  const segs: string[] = [];
  if (model.freshWindowDays > 0) {
    let freshSeg = inspectToggle(
      `${strong(model.freshTotal)} new (last ${model.freshWindowDays}d)`,
      "fresh",
      "",
      inspect,
    );
    if (model.freshPerSource.length) {
      freshSeg +=
        ": " +
        perSourceBreakdownHtml(
          model.freshPerSource.map((s) => ({ label: s.label, n: s.count, collection: s.collection })),
          "fresh",
          inspect,
        );
    }
    // The informational run-suggestion meter sits BEFORE the watcher affordance
    // (next-run text + "Run gardener now" button), never competing with it.
    freshSeg += freshMeterHtml(model);
    freshSeg += freshWatcherSuffixHtml(model);
    segs.push(freshSeg);
  }
  segs.push(inspectToggle(`${strong(model.eligibleNow)} drainable now`, "drainable", "", inspect));
  if (model.draftsAwaitingReview > 0) {
    segs.push(`${strong(model.draftsAwaitingReview)} drafts awaiting review`);
  }
  return `<span class="bk-sentence">${segs.join('<span class="bk-sep"> · </span>')}</span>`;
}

/**
 * The de-emphasized, collapsed all-time accounting (pure HTML) — reframed as an
 * honest COVERAGE sentence (R2): "N of M all-time docs have no wiki footprint",
 * collapsing the redundant "offered in past runs, never drafted / never ingested"
 * pair into one line, with a per-source "queued of total" breakdown behind the
 * toggle. The parenthetical names the tail for what it is: the pre-auto-drafter
 * backlog (new captures now auto-draft their own source page). Empty when nothing
 * is queued. This is where "280 never ingested · YouTube 269" went — true numbers,
 * but dead weight as a headline.
 */
export function backlogTailHtml(model: BacklogStripModel, inspect?: BacklogInspectorState): string {
  if (model.totalNeverIngested <= 0) return "";
  // Denominator falls back to the queued count on a degraded response with no all-
  // time total (never < numerator, so "N of N" reads as full-tail rather than lying).
  const total = Math.max(model.allTimeTotal, model.totalNeverIngested);
  // The coverage sentence deliberately KEEPS counting dismissed docs: it is a
  // statement about wiki FOOTPRINT, and dismissing a doc doesn't ingest it. The
  // ACTIONABLE counts (fresh / drainable / offered) exclude them by construction —
  // so the note names the dismissed share, keeping the two readings reconcilable
  // instead of leaving an unexplained gap between the tail and the lead.
  const dismissedNote = model.dismissedCount > 0 ? `; ${model.dismissedCount} dismissed` : "";
  const summary =
    `${strong(model.totalNeverIngested)} of ${strong(total)} all-time docs have no wiki footprint` +
    ` <span class="bk-note">(pre-auto-drafter tail; new captures auto-draft their own source page` +
    `${dismissedNote})</span>`;
  const breakdown = model.perSource
    .map((s) => {
      // Guard the denominator like the aggregate line: a degraded/older response can
      // carry total 0 (or below queued), which "269 of 0" would render as a lie — fall
      // back to a queued-only label when total isn't a usable denominator.
      const label = `${esc(s.label)} <span class="bk-n">${s.queued}</span>`;
      const inner =
        s.total >= s.queued && s.total > 0 ? `${label} of <span class="bk-n">${s.total}</span>` : label;
      // A fully-covered collection (0 queued) has no docs behind it — a toggle there
      // could only ever open an empty panel, so the count stays visible as plain text.
      if (s.queued <= 0) return `<span class="bk-tail-item">${inner}</span>`;
      // Every bucket for this collection — the tail is the all-time accounting.
      return inspectToggle(inner, "all", s.collection ?? "", inspect);
    })
    .join('<span class="bk-sep"> · </span>');
  // The offered bucket's own affordance. Deliberately NOT the "Reset offered (N)"
  // button — that stays a pure action (and hides at 0 / while running), so
  // overloading it would make the only way to SEE the offered docs an action the
  // user may not want to take. This chip is always present whenever the bucket is
  // non-empty; the panel's bucket filter is the second way in.
  const offeredChip =
    model.offeredStillQueued > 0
      ? '<span class="bk-sep"> · </span>' +
        inspectToggle(
          `<span class="bk-n">${model.offeredStillQueued}</span> previously offered`,
          "offered",
          "",
          inspect,
        )
      : "";
  // The dismissed bucket's chip + its reset affordance. `Reset dismissed (N)` is a
  // pure action button like `Reset offered (N)`; the chip beside it is the way to SEE
  // the rows without acting on them.
  const dismissedChip =
    model.dismissedCount > 0
      ? '<span class="bk-sep"> · </span>' +
        inspectToggle(
          `<span class="bk-n">${model.dismissedCount}</span> dismissed`,
          "dismissed",
          "",
          inspect,
        ) +
        (model.showDismissReset
          ? ` <button class="gard-btn bk-reset-dismissed" data-backlog-action="reset-dismissed">` +
            `Reset dismissed (${model.dismissedCount})</button>`
          : "")
      : "";
  return (
    '<details class="bk-tail">' +
    `<summary>${summary}</summary>` +
    `<span class="bk-tail-body">${breakdown}${offeredChip}${dismissedChip}</span>` +
    "</details>"
  );
}

/** Friendly stage text for a live drain (drafting shows k/n + the current topic). */
export function backlogProgressText(p: BacklogProgress): string {
  switch (p.stage) {
    case "assembling":
      return "Selecting batch…";
    case "harvesting":
      return "Fetching docs…";
    case "clustering":
      return "Clustering…";
    case "resolving":
      return "Resolving targets…";
    case "drafting": {
      const base = p.draftsTotal > 0 ? `Drafting ${p.draftsDone}/${p.draftsTotal}` : "Drafting…";
      return p.currentTopic ? `${base} — ${p.currentTopic}` : base;
    }
    default:
      return "Working…";
  }
}

/** Local HH:MM from an epoch-ms start time (best-effort; empty on a bad value). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The live-drain progress line + a soft-cancel button (replaces "Running…"). */
export function backlogProgressHtml(p: BacklogProgress): string {
  const parts: string[] = [`⏳ ${esc(backlogProgressText(p))}`];
  const clock = fmtClock(p.startedAt);
  if (clock) parts.push(`started ${esc(clock)}`);
  if (p.draftsDone > 0) {
    parts.push(`${p.draftsDone} draft${p.draftsDone === 1 ? "" : "s"} ready below`);
  }
  const line = parts.join('<span class="bk-sep"> · </span>');
  const cancelLabel = p.cancelRequested ? "Cancelling…" : "Cancel";
  const cancelBtn =
    `<button class="gard-btn bk-cancel-run" data-backlog-action="cancel-run"` +
    `${p.cancelRequested ? " disabled" : ""}>${cancelLabel}</button>`;
  return `<span class="bk-control bk-progress"><span class="bk-progress-line">${line}</span>${cancelBtn}</span>`;
}

/** The run/reset control + the (hidden) informed-consent confirm panel. */
export function backlogControlHtml(model: BacklogStripModel): string {
  if (model.controlHidden) return "";
  if (model.running) {
    // A live drain (this bot's own run) shows progress + soft-cancel; a weekly run
    // holds the mutex with no progress → keep the plain disabled "Running…".
    if (model.progress) return backlogProgressHtml(model.progress);
    return `<span class="bk-control"><button class="gard-btn bk-run" disabled>Running…</button></span>`;
  }
  let inner = "";
  if (model.showRun) {
    inner += `<button class="gard-btn bk-run" data-backlog-action="confirm">Drain a batch (${model.drainNow})</button>`;
  } else if (model.nothingDrainable) {
    // Not "all offered": fresh in-window docs are un-offered too, so that wording
    // lies whenever new arrivals exist. This states what the button's absence means.
    inner += `<span class="bk-run-note">nothing drainable</span>`;
  }
  if (model.showReset) {
    const label = model.nothingDrainable ? "Reset to re-run" : `Reset offered (${model.offeredStillQueued})`;
    inner += `<button class="gard-btn bk-reset" data-backlog-action="reset">${label}</button>`;
  }
  if (!inner) return ""; // nothing queued at all
  let html = `<span class="bk-control">${inner}</span>`;
  if (model.showRun) {
    html += backlogConfirmHtml(model);
  }
  return html;
}

/** The informed-consent confirm panel — hidden until the run button is clicked. */
export function backlogConfirmHtml(model: BacklogStripModel): string {
  return (
    '<div class="bk-confirm">' +
    `<div class="bk-confirm-copy">Drain a batch of <strong>${model.drainNow}</strong> ` +
    `(of ${model.eligibleNow} drainable) through the gardener? ~10–20 min in the background — ` +
    `you can leave this page. 1 Haiku clustering call + up to ${model.maxProposals} drafts on this ` +
    `bot's model. Produces <strong>draft proposals</strong> below — nothing is written to the wiki ` +
    "until you approve.</div>" +
    '<div class="bk-confirm-actions">' +
    '<button class="gard-btn bk-start" data-backlog-action="run">Start batch</button>' +
    '<button class="gard-btn bk-cancel" data-backlog-action="cancel">Cancel</button>' +
    "</div></div>"
  );
}

/**
 * The per-article "Draft source pages" control (pure HTML) — a collection
 * `<select>` + a button. Offered whenever the source-drafter is available (some
 * collection has uncovered docs, nothing running). The select is populated from
 * the ingest counter's per-collection queued counts (default = largest queue); a
 * single explicit click POSTs a small batch for the SELECTED collection — the
 * drafts land in the same review gate below. The button renders disabled when the
 * default collection has 0 queued (the client re-gates it on select change). Empty
 * when unavailable.
 */
export function backlogSourceDraftHtml(model: BacklogStripModel): string {
  if (!model.sourceDraftAvailable) return "";
  const options = model.sourceDraftOptions
    .map((o) => {
      const selected = o.collection === model.sourceDraftDefaultCollection ? " selected" : "";
      return (
        `<option value="${esc(o.collection)}" data-queued="${o.queued}"${selected}>` +
        `${esc(o.label)} — ${o.queued} queued</option>`
      );
    })
    .join("");
  const defaultQueued =
    model.sourceDraftOptions.find((o) => o.collection === model.sourceDraftDefaultCollection)?.queued ?? 0;
  const disabled = defaultQueued > 0 ? "" : " disabled";
  return (
    '<span class="bk-control bk-source-draft">' +
    `<select class="bk-source-draft-select" data-backlog-select="source-draft" ` +
    `aria-label="Collection to draft source pages for">${options}</select>` +
    `<button class="gard-btn bk-source-draft-btn" data-backlog-action="source-draft"${disabled} ` +
    'title="Backfill the oldest uncovered docs in the selected collection — one .mdx source page each, into the review gate below">' +
    "Backfill oldest</button></span>"
  );
}

/** The per-doc outcomes + rolled-up totals a source-draft batch returns. */
export interface SourceBacklogResult {
  results: {
    collection: string;
    docId: string;
    outcome: string;
    reason?: string;
    proposalId?: string;
    title?: string;
  }[];
  totals: { selected: number; drafted: number; covered: number; skipped: number; error: number };
  totalQueued: number;
  limit: number;
}

/**
 * Result note for the last source-draft batch (pure HTML). `{error}` renders a
 * failure note; a real result rolls up "N drafted, …" with only the non-zero
 * buckets. `collectionLabel` (the human vertical name, when known) prefixes the
 * note so it names the collection the batch drafted. Empty for a null (no run yet).
 */
export function sourceDraftResultHtml(
  r: SourceBacklogResult | { error: string } | null,
  collectionLabel?: string,
): string {
  if (!r) return "";
  const tag = collectionLabel ? `${esc(collectionLabel)} ` : "";
  if ("error" in r) {
    return ` <span class="bk-err">${tag}source draft failed: ${esc(r.error)}</span>`;
  }
  const t = r.totals;
  if (t.selected === 0) {
    return ` <span class="bk-run-note">${tag}source draft: no uncovered docs to draft</span>`;
  }
  const parts = [`${t.drafted} drafted`];
  if (t.covered) parts.push(`${t.covered} covered`);
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  if (t.error) parts.push(`${t.error} error`);
  return ` <span class="bk-run-note">${tag}source pages: ${esc(parts.join(", "))} of ${t.selected} — see proposals below</span>`;
}

/** Last-run outcome note (pure HTML string). */
export function backlogOutcomeHtml(run: LastBacklogRun | null | undefined): string {
  if (!run) return "";
  if (run.error) {
    return ` <span class="bk-err">last run failed: ${esc(run.error)}</span>`;
  }
  // Below-minimum batch: the run never touched the offered set (nothing burned),
  // so this is an informational note, not the burn warning below. `eligible` is
  // the too-small batch size (falls back to `offered`, which is 0 for this outcome).
  if (run.outcome === "insufficient") {
    const eligible = run.eligible ?? run.offered;
    const min = run.minClusterSize ?? 3;
    const fb = run.fallbackDrafted ?? 0;
    // The low-volume fallback (R4) drafted the too-small batch individually as source
    // pages — report that instead of a bare "nothing offered".
    const fbTail =
      fb > 0
        ? ` — drafted ${fb} source page${fb === 1 ? "" : "s"} individually (fallback)`
        : "; nothing offered";
    if (eligible === 0) {
      return ` <span class="bk-run-note">last run: no eligible docs in the backlog — nothing offered</span>`;
    }
    return ` <span class="bk-run-note">last run: ${eligible} eligible doc(s) — below the minimum cluster size of ${min}${fbTail}</span>`;
  }
  if (run.cancelled) {
    const { drafted, of } = run.cancelled;
    if (drafted === 0) {
      return ` <span class="bk-run-note">last run cancelled before drafting — batch docs returned to the queue</span>`;
    }
    return ` <span class="bk-run-note">last run cancelled after ${drafted}/${of} drafts — undrafted docs returned to the queue</span>`;
  }
  if (run.drafted > 0) {
    return ` <span class="bk-run-note">last run: ${run.drafted} draft(s) from ${run.offered} docs — see proposals below</span>`;
  }
  // Completed, un-cancelled, zero-draft run. Post-#311 such a run rolls its offered
  // set back to 0 (batch stays eligible), so the old `offered > 0 && drafted === 0`
  // ⚠ burn branch is now unreachable here — a *cancelled* zero-draft hits
  // run.cancelled above, an errored one hits run.error, and the #311 rollback means
  // a completed one always reports offered:0. So the burn warning is folded into the
  // reason line below: surface WHY nothing drafted (from the drop tally + attempted-
  // doc count) so a reviewer needn't open the logs.
  if (run.attemptedDocs !== undefined || run.dropTally) {
    return backlogZeroDraftReasonHtml(run);
  }
  return ` <span class="bk-run-note">last run finished — nothing to draft</span>`;
}

/** Short drop-reason qualifiers for the weekly-run headline ("… 3 kept (cap) …"). */
const WEEKLY_REASON_SHORT: Record<string, string> = {
  cap: "cap",
  size: "cluster size",
  skip: "already covered",
  duplicate: "duplicates",
  hallucinated: "unknown docs",
  "reserved-path": "reserved path",
};

/**
 * Last WEEKLY gardener run note (pure HTML) — its OWN render branch, distinct from
 * the drain's {@link backlogOutcomeHtml} (the two paths persist different snapshot
 * shapes and can both show). Reads "last weekly run: 26 clusters found, 3 kept (cap)
 * — 23 dropped", the `(cap)` naming the dominant drop reason so a cap-eviction is
 * legible at a glance (the incident that showed nothing on the page). The FULL
 * evicted-topic list rides in a `title` tooltip — lossless + inspectable — since the
 * snapshot stores the structured (untruncated) tail. Empty when no weekly run has
 * completed a clustering pass. Follows `backlogZeroDraftReasonHtml`'s copy
 * conventions (`.bk-run-note`, "last … run …") but does NOT reuse it.
 */
export function weeklyRunHtml(run: WeeklyGardenerRun | null | undefined): string {
  if (!run) return "";
  const clustersFound = Math.max(0, numOr(run.clustersFound, 0));
  const kept = Math.max(0, numOr(run.kept, 0));
  const dropped = Math.max(0, numOr(run.dropped, 0));
  if (clustersFound <= 0) {
    return ` <span class="bk-run-note">last weekly run: no clusters found</span>`;
  }
  const foundPhrase = `${clustersFound} cluster${clustersFound === 1 ? "" : "s"} found`;
  if (dropped <= 0) {
    return ` <span class="bk-run-note">last weekly run: ${foundPhrase}, all ${kept} kept</span>`;
  }
  const t = run.dropTally;
  const counts: [string, number][] = t
    ? [
        ["cap", t.clusters_dropped_cap],
        ["size", t.clusters_dropped_size],
        ["skip", t.clusters_dropped_skip],
        ["duplicate", t.clusters_dropped_duplicate],
        ["hallucinated", t.clusters_dropped_hallucinated],
        ["reserved-path", t.clusters_dropped_reserved],
      ]
    : [];
  const dominant = counts.reduce<[string, number] | null>(
    (best, c) => (c[1] > 0 && (!best || c[1] > best[1]) ? c : best),
    null,
  );
  const qualifier = dominant ? ` (${WEEKLY_REASON_SHORT[dominant[0]] ?? dominant[0]})` : "";
  const line = `last weekly run: ${foundPhrase}, ${kept} kept${qualifier} — ${dropped} dropped`;
  const topics = Array.isArray(run.evictedTopics) ? run.evictedTopics : [];
  const titleAttr = topics.length
    ? ` title="${esc(topics.map((e) => `${e.topicKey} (${e.reason}, n:${e.size})`).join(", "))}"`
    : "";
  return ` <span class="bk-run-note"${titleAttr}>${esc(line)}</span>`;
}

/**
 * Why a completed run drafted nothing (pure HTML), from the aggregate drop tally +
 * attempted-doc count. The tally counts CLUSTERS, `attemptedDocs` counts DOCS — kept
 * distinct in the copy. The dominant, most-legible case (nothing reached cluster
 * size, incl. the harvest-floor fallback with no tally) reads "drained N docs, none
 * clustered — all below cluster size (need M on one topic)"; other drop reasons
 * (skip/duplicate/cap/hallucinated) are surfaced explicitly when present.
 */
function backlogZeroDraftReasonHtml(run: LastBacklogRun): string {
  const min = run.minClusterSize ?? 3;
  const t = run.dropTally;
  // Low-volume fallback (R4): the gardener clustered nothing draftable, so the run
  // drafted the batch docs individually as source pages. Report that plainly rather
  // than the "none clustered" reason — nothing was actually left empty.
  const fb = run.fallbackDrafted ?? 0;
  if (fb > 0) {
    return ` <span class="bk-run-note">last run drafted ${fb} source page${fb === 1 ? "" : "s"} (fallback — nothing clustered)</span>`;
  }
  const docPhrase =
    run.attemptedDocs !== undefined
      ? `drained ${run.attemptedDocs} doc${run.attemptedDocs === 1 ? "" : "s"}`
      : "drafted nothing";
  // Clusters formed and passed the gate, but every draft attempt failed (a draft-call
  // error or a shape-gate reject). The size/skip copy below would lie ("none clustered")
  // — clustering succeeded — so surface the honest draft-failure story. Takes precedence
  // over the tally buckets: with kept clusters, why OTHER clusters dropped is secondary.
  if (run.keptClusters !== undefined && run.keptClusters > 0) {
    return ` <span class="bk-run-note">last run ${docPhrase}, clusters formed but no drafts survived (draft errors or quality gate)</span>`;
  }
  const extras: string[] = [];
  if (t) {
    if (t.clusters_dropped_skip > 0)
      extras.push(`${t.clusters_dropped_skip} already covered/recently rejected`);
    if (t.clusters_dropped_duplicate > 0) extras.push(`${t.clusters_dropped_duplicate} duplicate`);
    if (t.clusters_dropped_cap > 0) extras.push(`${t.clusters_dropped_cap} over the per-run cap`);
    if (t.clusters_dropped_hallucinated > 0)
      extras.push(`${t.clusters_dropped_hallucinated} referenced unknown docs`);
    if (t.clusters_dropped_reserved > 0)
      extras.push(`${t.clusters_dropped_reserved} targeted a reserved path`);
  }
  let reason: string;
  if (extras.length === 0) {
    // No non-size drops (or no tally at all) — the whole story is "nothing clustered".
    reason = `none clustered — all below cluster size (need ${min} on one topic)`;
  } else {
    const parts = [...extras];
    const sizeDrops = t?.clusters_dropped_size ?? 0;
    if (sizeDrops > 0) parts.push(`${sizeDrops} below cluster size`);
    reason = `no draftable cluster — ${parts.join(", ")}`;
  }
  return ` <span class="bk-run-note">last run ${docPhrase}, ${esc(reason)}</span>`;
}

/**
 * The interrupted-run recovery banner (pure HTML). Rendered above the strip when
 * the GET carries an `interrupted` field — a run journal that outlived its run (a
 * crash or an error settle) with nothing in flight. Offers Recover (return the
 * undrafted batch to the pool) or Dismiss (leave it skipped). Empty when none.
 */
export function backlogBannerHtml(model: BacklogStripModel): string {
  const i = model.interrupted;
  if (!i) return "";
  const clock = fmtClock(i.at);
  const when = clock ? ` started ${esc(clock)}` : "";
  return (
    '<div class="bk-banner">' +
    `<span class="bk-banner-msg">⚠ A drain${when} was interrupted — ` +
    `${strong(i.drafted)} of ${strong(i.batchSize)} docs produced drafts.</span>` +
    '<span class="bk-banner-actions">' +
    '<button class="gard-btn bk-recover" data-backlog-action="recover">Recover batch</button>' +
    '<button class="gard-btn bk-dismiss" data-backlog-action="dismiss">Dismiss</button>' +
    "</span></div>"
  );
}

/** Full strip innerHTML (pure). renderBacklog just assigns this to the element. */
export function backlogStripHtml(
  model: BacklogStripModel,
  errors?: unknown[],
  inspect?: BacklogInspectorState,
): string {
  const errNote = errors && errors.length
    ? ` <span class="bk-err">(some sources unavailable)</span>`
    : "";
  return (
    backlogBannerHtml(model) +
    `<span class="bk-label">Ingest backlog:</span> ` +
    backlogSentenceHtml(model, inspect) +
    errNote +
    " " +
    backlogControlHtml(model) +
    backlogSourceDraftHtml(model)
  );
}

/** Human bucket labels (chips + the panel's filter buttons). */
const BUCKET_LABEL: Record<BacklogBucket, string> = {
  fresh: "new",
  drainable: "drainable",
  offered: "offered",
  dismissed: "dismissed",
};

/** The snapshot key a queued doc is tracked by — identical to the server's. */
export function backlogDocKey(d: { collection: string; id: string }): string {
  return `${d.collection}/${d.id}`;
}

/**
 * The dashboard doc-reader deep link for a queued doc. **Always** percent-encodes
 * the id segment: real ids carry `/`, spaces, `#` and non-ASCII, and a naive
 * interpolation would truncate the URL at the first `#`. The reader route is a
 * wildcard (`/search/document/:collection/*`), so a slash-bearing id still
 * resolves once encoded.
 */
export function backlogDocHref(collection: string, id: string): string {
  return `/search/document/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
}

/** Apply the panel's bucket + collection filters (pure). */
export function filterBacklogDocs(
  docs: BacklogDoc[],
  bucket: BacklogBucket | "all",
  collection: string,
): BacklogDoc[] {
  return docs.filter(
    (d) => (bucket === "all" || d.bucket === bucket) && (!collection || d.collection === collection),
  );
}

/**
 * One inspector row — the Stats tab's never-clustered row shape (badge + title +
 * open link, `src/dashboard/views/components/sum-stats.ts`) with the backlog's two
 * extras: the doc date and its bucket chip. The label links to the dashboard doc
 * reader; the external "open ↗" only renders for an http(s) url (`esc()` does not
 * neutralize a `javascript:` scheme).
 */
function inspectorRowHtml(
  d: BacklogDoc,
  sourceLabel: string,
  pruneEnabled: boolean,
  removing: Set<string>,
): string {
  const open = d.url && /^https?:\/\//i.test(d.url)
    ? `<a class="bk-doc-open" href="${esc(d.url)}" target="_blank" rel="noopener">open ↗</a>`
    : "";
  const key = backlogDocKey(d);
  const attrs =
    `data-doc-key="${esc(key)}" data-doc-collection="${esc(d.collection)}" ` +
    `data-doc-id="${esc(d.id)}" data-doc-label="${esc(d.label || d.id)}"`;
  let actions = "";
  if (removing.has(key)) {
    // A delete's huginn 200 only means "moved + reindex started" — the row stays in
    // this state until the reindex poll goes terminal, so the user never sees a doc
    // that looks deleted but is still listed.
    actions = '<span class="bk-doc-removing">removing…</span>';
  } else if (pruneEnabled) {
    actions =
      d.bucket === "dismissed"
        ? `<button type="button" class="bk-doc-btn" data-doc-action="undismiss" ${attrs} ` +
          `title="Return this doc to the queue">un-dismiss</button>`
        : `<button type="button" class="bk-doc-btn" data-doc-action="dismiss" ${attrs} ` +
          `title="Never select this doc (reversible)">dismiss</button>` +
          `<button type="button" class="bk-doc-btn bk-doc-danger" data-doc-action="delete" ${attrs} ` +
          `title="Delete this doc from huginn (irreversible)">delete</button>`;
  }
  return (
    '<div class="bk-doc-row">' +
    `<span class="bk-doc-date">${esc(d.date ?? "—")}</span>` +
    `<span class="bk-doc-badge">${esc(sourceLabel)}</span>` +
    `<a class="bk-doc-title" href="${backlogDocHref(d.collection, d.id)}" title="${esc(d.id)}">${esc(d.label || d.id)}</a>` +
    `<span class="bk-doc-chip bk-doc-${d.bucket}">${esc(BUCKET_LABEL[d.bucket])}</span>` +
    open +
    (actions ? `<span class="bk-doc-actions">${actions}</span>` : "") +
    "</div>"
  );
}

/**
 * The shared inspector panel (pure HTML) — a filterable table of the queued docs
 * behind whichever count was clicked. Renders nothing when closed.
 *
 * `sources` supplies the collection→label map for the row badges + the collection
 * `<select>` (the strip model's per-source rows). Rendering is capped at
 * `state.limit` rows with a "Show more" affordance — 253 rows is fine, but a
 * tail-heavy bot must not lay out thousands.
 *
 * A source with `queued: 0` still labels its rows (an already-drained collection can
 * own rows in a stale snapshot) but is dropped from the `<select>`: picking it could
 * only ever render "No docs in this filter". The currently-selected collection is
 * always kept as an option so the control can never show a value it doesn't offer.
 */
export function backlogInspectorHtml(
  state: BacklogInspectorState,
  sources: { collection: string; label: string; queued?: number }[],
  opts: { pruneEnabled?: boolean } = {},
): string {
  if (!state.open) return "";
  const pruneEnabled = opts.pruneEnabled === true;
  const removing = new Set(state.removing);
  const labelOf = (collection: string): string =>
    sources.find((s) => s.collection === collection)?.label || collection;
  const buckets: (BacklogBucket | "all")[] = ["all", "fresh", "drainable", "offered", "dismissed"];
  const bucketBtns = buckets
    .map((b) => {
      const on = state.bucket === b ? " bk-filter-on" : "";
      const label = b === "all" ? "all" : BUCKET_LABEL[b];
      return (
        `<button type="button" class="bk-filter${on}" data-inspect-bucket="${b}" ` +
        `aria-pressed="${state.bucket === b ? "true" : "false"}">${esc(label)}</button>`
      );
    })
    .join("");
  const selectable = sources.filter(
    (s) => s.queued === undefined || s.queued > 0 || s.collection === state.collection,
  );
  const options = [{ collection: "", label: "all sources" }, ...selectable]
    .map(
      (s) =>
        `<option value="${esc(s.collection)}"${s.collection === state.collection ? " selected" : ""}>` +
        `${esc(s.label)}</option>`,
    )
    .join("");
  const head =
    '<div class="bk-inspector-head">' +
    `<span class="bk-inspector-filters">${bucketBtns}` +
    `<select class="bk-inspector-select" data-backlog-select="inspector" ` +
    `aria-label="Filter by collection">${options}</select></span>` +
    '<button type="button" class="bk-inspector-close" data-inspect-action="close" ' +
    'aria-label="Close the backlog inspector">✕</button>' +
    "</div>";

  let body: string;
  let footer = "";
  // A failed refresh must NOT wipe rows the user is reading: with docs already
  // loaded the error renders as a note ABOVE them (matching `loadInspectorDocs`'s
  // "any previously-loaded rows stay on screen" contract); an error with nothing
  // loaded is the only error-only body.
  const errNote = state.error ? `<div class="bk-inspector-note bk-err">${esc(state.error)}</div>` : "";
  if (state.error && !state.docs?.length) {
    body = errNote;
  } else if (!state.docs) {
    body = `<div class="bk-inspector-note">${state.loading ? "Loading docs…" : "No docs loaded."}</div>`;
  } else {
    const filtered = filterBacklogDocs(state.docs, state.bucket, state.collection);
    if (!filtered.length) {
      body = errNote + '<div class="bk-inspector-note">No docs in this filter.</div>';
    } else {
      const shown = filtered.slice(0, Math.max(1, state.limit));
      body =
        errNote +
        '<div class="bk-inspector-rows">' +
        shown.map((d) => inspectorRowHtml(d, labelOf(d.collection), pruneEnabled, removing)).join("") +
        "</div>";
      const more = filtered.length - shown.length;
      // Bulk is dismiss-ONLY (delete stays single-row + per-doc confirm) and acts on
      // the whole FILTERED set — not just the rendered page — so a "Show more" click
      // isn't a prerequisite for pruning a long tail. Already-dismissed rows are
      // excluded (dismissing them again is a no-op that would only inflate the count).
      const bulkTargets = filtered.filter((d) => d.bucket !== "dismissed");
      footer =
        '<div class="bk-inspector-foot">' +
        `<span class="bk-note">showing ${shown.length} of ${filtered.length}</span>` +
        (pruneEnabled && bulkTargets.length
          ? `<button type="button" class="gard-btn bk-inspector-bulk" data-inspect-action="bulk-dismiss">` +
            `Dismiss all ${bulkTargets.length}</button>`
          : "") +
        (more > 0
          ? `<button type="button" class="gard-btn bk-inspector-more" data-inspect-action="more">Show ${Math.min(more, INSPECTOR_PAGE_SIZE)} more</button>`
          : "") +
        (state.loading ? '<span class="bk-note">refreshing…</span>' : "") +
        "</div>";
    }
  }
  return `<div class="bk-inspector">${head}${body}${footer}</div>`;
}
