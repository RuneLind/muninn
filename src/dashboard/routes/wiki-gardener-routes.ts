import type { Context, Hono } from "hono";
import path from "node:path";
import { renderWikiGardenerPage } from "../views/wiki-gardener-page.ts";
import { renderWikiHtml, stripFrontmatter } from "../../wiki/render.ts";
import { getWikiIndex, wikiPageStem, type WikiIndex } from "../../wiki/store.ts";
import { scanUnresolvedBodyLinks } from "../../gardener/draft.ts";
import { buildIndexEntry, catalogPage, selectWirablePages } from "../../gardener/wire.ts";
import type { WiringPreview } from "../views/components/wiki-gardener-wiring.ts";
import type { BacklogWatcherInfo } from "../views/components/wiki-gardener-strip.ts";
import { computeWatcherNextRun } from "../agents-overview.ts";
import { lintWiki } from "../../wiki/lint.ts";
import { findWiki, listWikis, resolveWikiRequest, type WikiRegistryEntry } from "../../wiki/registry.ts";
import {
  isReadonlyWikiRoot,
  wikiNoEgressReason,
  wikiReadonlyRootReason,
} from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { discoverAllBots, type BotConfig } from "../../bots/config.ts";
import { fetchKnowledgeApi, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { lineDiff, type DiffLine } from "../../gardener/diff.ts";
import { applyWikiProposal, draftTitle, type ApplyDeps } from "../../gardener/apply.ts";
import { commitWikiChange } from "../../wiki/commit.ts";
import {
  approveWikiProposal,
  rejectWikiProposal,
  markWikiProposalApplied,
  markWikiProposalStale,
  markWikiProposalError,
  revertWikiProposalToDraft,
  listAllWikiProposals,
  listAllWikiProposalsByWiki,
  getWikiProposalById,
  DEFAULT_COVERAGE_DEPS,
  type CoverageDeps,
  type WikiProposal,
} from "../../db/wiki-proposals.ts";
import { SUMMARY_SOURCES } from "../../summaries/sources.ts";
import { listSummaryCollections } from "../../summaries/list-collections.ts";
import type { StatsError } from "../../summaries/stats.ts";
import { collectWikiRefs, computeIngestBacklog, type ListedDoc } from "../../wiki/ingest-backlog.ts";
import { resolveGardenerConfig } from "../../gardener/types.ts";
import { docDateMs } from "../../gardener/harvest.ts";
import { runGardener, type GardenerDeps } from "../../gardener/runner.ts";
import {
  assembleBacklog,
  startBacklogRun,
  resetBacklogOffered,
  runExclusive,
  draftedCount,
  draftedKeysSince,
  passesAgeFloor,
  gardenerRunInFlight,
  getBacklogProgress,
  requestBacklogCancel,
  recoverRunJournal,
  BACKLOG_BATCH_SIZE,
  BACKLOG_MAX_PROPOSALS,
  BACKLOG_LOOKBACK_DAYS,
  DRAFT_TIMEOUT_MS,
  WIKI_GARDENER_OFFERED_KEY,
  WIKI_GARDENER_DISMISSED_KEY,
  WIKI_GARDENER_RUN_KEY,
  WIKI_GARDENER_LAST_RUN_KEY,
  WIKI_GARDENER_WEEKLY_RUN_KEY,
  type AssembledBacklog,
  type BacklogProgress,
  type DraftedScanProposal,
  type GardenerRunHooks,
  type LastBacklogRun,
  type WeeklyGardenerRun,
  type RunJournal,
} from "../../gardener/backlog.ts";
import { buildGardenerSeams } from "../../watchers/wiki-gardener.ts";
import {
  runSourceDraftForNewest,
  runSourceDraftBacklog,
  clampSourceBacklogLimit,
  draftOneBacklogDoc,
  defaultSourceBacklogDeps,
} from "../../gardener/source-drafter-run.ts";
import { findStemTwin, stemCollisionMessage } from "../../gardener/source-drafter.ts";
import {
  getWikiGardenerWatcher,
  getWatcherSnapshot,
  setWatcherSnapshot,
} from "../../db/watchers.ts";
import {
  getSourceDraftAttempts,
  deleteSourceDraftAttempt,
  deleteSourceDraftAttemptForProposal,
  type SourceDraftAttempt,
  type SourceDraftAttemptOutcome,
  type SourceDraftTrigger,
} from "../../db/source-draft-attempts.ts";
import { loadConfig } from "../../config.ts";
import { Tracer } from "../../tracing/index.ts";
import { getLog } from "../../logging.ts";
import { readonlyRefusal as sharedReadonlyRefusal } from "./route-utils.ts";

const log = getLog("dashboard", "wiki-gardener");

const KNOWLEDGE_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

/**
 * Cap on a client-supplied source-page title (the row's rename retry) — a sanity
 * bound on a field that reaches a model prompt, generous for a real encyclopedic
 * title. Explicitly NOT a security boundary: the value is operator-typed on an
 * auth-less loopback dashboard and 120 chars is ample for a sentence of
 * instructions, so the cap and `sanitizeTitleOverride` (whitespace + quotes) buy
 * containment of accidents, not defence against a hostile author. The real
 * containment is downstream — the draft is shape-gated, contained, and lands in a
 * human review gate that writes nothing on its own.
 */
export const SOURCE_DRAFT_TITLE_MAX = 120;

/**
 * The shared `readonlyRefusal` (`route-utils.ts`) bound to this file's logger,
 * as the FIRST statement of every gardener mutation route.
 *
 * The two write seams (`applyWikiProposal`, `writeWikiPage`) refuse on their own,
 * so this is not the only line of defence — it exists so the refusal costs no DB
 * round-trip, no model call and no status CAS, and so the *drafting* routes
 * (backlog-run / source-draft-*) are covered too: they persist proposals rather
 * than pages, and a readonly instance must not build a backlog it can never apply.
 *
 * `reject` is deliberately NOT guarded — it flips a DB status and mutates no wiki.
 */
const readonlyRefusal = (c: Context) => sharedReadonlyRefusal(c, log);

/** Bot configs are static until restart — discover once and memoize (see wiki-routes.ts). */
let cachedBots: BotConfig[] | null = null;
function getBots(): BotConfig[] {
  return (cachedBots ??= discoverAllBots());
}

/**
 * Test-only: pin (or with `null` release) the discovered bots, so a route test can
 * drive a fabricated bot wiki without touching the real `bots/` folder. Pairs with
 * `__setWikiRegistryForTest` (the registry is the other half of the resolution).
 */
export function __setBotsForTest(bots: BotConfig[] | null): void {
  cachedBots = bots;
}

/**
 * Wikis the gardener gate can review. Two sources:
 *   - **bot wikis** — the bot-keyed gardener (weekly clustering, source drafter);
 *   - **standalone (extra) wikis WITH backing `collections`** — the consolidation
 *     gardener, which turns semantic clusters of a wiki's own pages into wiki-keyed
 *     `synthesis` proposals (mimir). A collection-less extra wiki can't be
 *     semantically clustered, so it stays out of the picker (and reads as
 *     "unavailable" if reached by URL).
 * Shares the reader's memoized registry (one bot discovery + `WIKI_EXTRA` parse).
 */
function isGardenerWiki(e: WikiRegistryEntry): boolean {
  // A `WIKI_READONLY_ROOTS` wiki is excluded — but this is COSMETIC, and saying
  // so matters: the predicate's three consumers are all read-side (the picker
  // listing, a render flag, the proposals-listing gate), every gardener drafting
  // POST in this file already refuses a non-bot wiki through `resolveBacklogBot`,
  // and `proposals/:id/approve` resolves against the FULL registry. What actually
  // stops an apply is the root-keyed guard inside `applyWikiProposal`. This just
  // keeps a wiki that can never be written out of a gate picker.
  if (isReadonlyWikiRoot(e.root)) return false;
  return e.source === "bot" || !!(e.collections && e.collections.length > 0);
}

function getGardenerRegistry(): WikiRegistryEntry[] {
  return getWikiRegistry().filter(isGardenerWiki);
}

/** The rich per-proposal shape the review page renders (meta + server-computed preview/diff). */
interface ProposalView {
  id: string;
  topicKey: string;
  title: string;
  kind: string;
  mode: string;
  targetPath: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  rationale: string | null;
  sourceDocs: { collection: string; docId: string; title: string; url: string }[];
  /** Rendered draft preview — empty for terminal rows (applied/rejected/error). */
  previewHtml: string;
  diff: DiffLine[] | null;
  /** Body [[wikilinks]] that don't resolve against the live index (surfaced, not
   *  stripped). LEGACY read-time fallback: only computed for rows without a
   *  persisted `containedLinks` report (drafted before body containment). Read-time
   *  so a page created while the proposal awaited review stops being flagged. */
  unresolvedLinks: string[];
  /** Body [[wikilinks]] the persist-time guard auto-de-linked to plain text
   *  (informational, from the `contained_links` column). Null on legacy rows. */
  containedLinks: string[] | null;
  /** Read-time preview of the apply-time wire stage (index line + inbound See-also
   *  targets). Null for terminal rows (nothing will be wired). */
  wiring: WiringPreview | null;
}

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await Bun.file(absPath).text();
  } catch {
    return null;
  }
}

/** Real huginn reindex seam — best-effort POST, never throws (swallowed for apply). */
async function triggerReindex(collection: string): Promise<void> {
  try {
    await fetchKnowledgeApi(
      KNOWLEDGE_API_URL,
      `/api/collections/${encodeURIComponent(collection)}/update`,
      { method: "POST", timeoutMs: 10_000 },
    );
    log.info("Wiki-gardener: triggered reindex of collection {collection}", { collection });
  } catch (err) {
    log.warn("Wiki-gardener: reindex trigger failed for {collection}: {error}", {
      collection,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build the filesystem/index/reindex/commit seams the apply step needs for a
 *  wiki root. `push` defaults to true (per-bot `wikiAutoCommit.push` opt-out); the
 *  commit helper still skips the push when the repo has no remote/upstream.
 *  `catalogKinds` is the wiki's per-kind index-cataloging policy (default
 *  `["concept"]` when the bot doesn't set `wikiAutoCommit.catalogKinds`).
 *  `reindexCollections` overrides the default life/wiki mapping — passed for
 *  wiki-keyed (standalone-wiki) applies so the reindex hits the wiki registry
 *  entry's own collections instead of jarvis's hardcoded `wiki`/`wiki-life`. */
function applyDepsFor(
  wikiDir: string,
  push: boolean,
  catalogKinds?: string[],
  reindexCollections?: string[],
): ApplyDeps {
  return {
    wikiDir,
    catalogKinds,
    ...(reindexCollections ? { reindexCollections } : {}),
    now: () => Date.now(),
    readFile: readFileOrNull,
    // Bun.write creates parent directories itself.
    writeFile: async (absPath, content) => {
      await Bun.write(absPath, content);
    },
    // Deliberately NOT `refresh: true`, and the freshness the in-queue checks need
    // comes from somewhere else: every write path in `applyInner` awaits
    // `refreshIndex()` below (step 5, and step 2a's re-run branch) BEFORE releasing
    // the write queue, so the second of two concurrent approves already reads a
    // cache the first one refreshed after writing — which is the exact window the
    // in-queue collision re-check exists for. A refresh here would rebuild the
    // whole index a second time (measured warm 2026-08-30: 245 ms on the 1,148-page
    // jarvis wiki) INSIDE the shared per-wiki write queue, on every approve, which
    // is the one thing that queue's docblock says not to grow — and mutation-proven
    // inert: the suite is green in both directions. The route's own pre-CAS guard
    // keeps its explicit `refresh: true`; that one IS the guard, and it runs outside
    // the queue.
    getWikiIndex: () => getWikiIndex({ root: wikiDir }),
    refreshIndex: async () => {
      await getWikiIndex({ root: wikiDir, refresh: true });
    },
    reindex: triggerReindex,
    commit: (paths, message) => commitWikiChange(wikiDir, paths, message, { push }),
  };
}

/** Flip the terminal status via CAS; a null result means the row's state changed
 *  under us — surface that instead of reporting success. */
async function finishProposal(
  id: string,
  mark: (id: string) => Promise<WikiProposal | null>,
  label: string,
): Promise<boolean> {
  const row = await mark(id);
  if (!row) {
    log.error("Wiki-gardener: terminal CAS to {label} lost for proposal {id} — state changed during apply", {
      label,
      id,
    });
    return false;
  }
  return true;
}

// ── Ingest backlog (report-only "queued up" counter) ────────────────────────

/** Injectable coverage lookups so the route test can drive them without a DB —
 *  the shared {@link CoverageDeps} shape (also used by the summaries Stats route). */
export type IngestBacklogDeps = CoverageDeps;

/**
 * A minimal `wiki-gardener` watcher projection: the FK the offered memory needs
 * (`id`), plus the scheduling fields the strip's fresh-segment affordance reads
 * (`enabled`/`lastRunAt`/`intervalMs`/`forceNextRun`) to render the next-weekly-run
 * time + the "Run gardener now" button.
 */
export interface GardenerWatcherRef {
  id: string;
  enabled: boolean;
  lastRunAt: number | null;
  intervalMs: number;
  forceNextRun: boolean;
  /** Watcher config (carries the Oslo time-of-day gate `hour`/`minute`) — read by
   * `computeWatcherNextRun` for the honest next-fire projection. */
  config: Record<string, unknown>;
}

/**
 * The wider deps the backlog-run routes need on top of {@link CoverageDeps}: the
 * bot's `wiki-gardener` watcher row (offered memory's `watcher_id`), a generic
 * per-key snapshot read/write (offered / run journal / last-run all live in the
 * same `watcher_snapshots` table), and the bot's proposal list (for the
 * interrupted-run scan). All injectable so the routes test without a DB.
 */
export interface BacklogRouteDeps extends CoverageDeps {
  getWikiGardenerWatcher: (botName: string) => Promise<GardenerWatcherRef | null>;
  getSnapshot: (watcherId: string, key: string) => Promise<unknown>;
  setSnapshot: (watcherId: string, key: string, value: unknown) => Promise<void>;
  listProposals: (botName: string) => Promise<DraftedScanProposal[]>;
  /**
   * The two DB seams the APPROVE route needs before it commits to anything —
   * the read, and the draft→approved CAS.
   *
   * They are injectable for one specific reason: the read-only refusal has to
   * happen BETWEEN them (after the proposal's wiki is known, before the row is
   * claimed), and a test that cannot drive that gap can only assert the guard
   * exists, not that it fires in the one position where it matters. The
   * regression it pins — approve 403s, row stuck in `approved` forever — is
   * invisible to any test that stubs the whole route.
   */
  getProposalById: (id: string) => Promise<WikiProposal | null>;
  approveProposal: (id: string) => Promise<WikiProposal | null>;
  /**
   * The third seam, and injectable for the same reason: the approved→draft CAS the
   * route runs when the apply REFUSES on a stem collision it only saw inside the
   * write queue. Its whole observable is "the row is reviewable again", which a
   * test that cannot see the CAS can only assume.
   */
  revertProposal: (id: string) => Promise<WikiProposal | null>;
}

export const DEFAULT_BACKLOG_ROUTE_DEPS: BacklogRouteDeps = {
  ...DEFAULT_COVERAGE_DEPS,
  getWikiGardenerWatcher: async (botName) => {
    const w = await getWikiGardenerWatcher(botName);
    return w
      ? {
          id: w.id,
          enabled: w.enabled,
          lastRunAt: w.lastRunAt,
          intervalMs: w.intervalMs,
          forceNextRun: w.forceNextRun,
          config: w.config,
        }
      : null;
  },
  getSnapshot: (watcherId, key) => getWatcherSnapshot(watcherId, key),
  setSnapshot: (watcherId, key, value) => setWatcherSnapshot(watcherId, key, value),
  listProposals: (botName) => listAllWikiProposals(botName),
  getProposalById: (id) => getWikiProposalById(id),
  approveProposal: (id) => approveWikiProposal(id),
  revertProposal: (id) => revertWikiProposalToDraft(id),
};

/** Read the offered-key snapshot as a Set (JSONB array → Set; anything else ⇒ ∅). */
async function readOffered(deps: BacklogRouteDeps, watcherId: string): Promise<Set<string>> {
  const snap = await deps.getSnapshot(watcherId, WIKI_GARDENER_OFFERED_KEY);
  return new Set(Array.isArray(snap) ? (snap as string[]) : []);
}

/**
 * Read the dismissed-key snapshot as a Set (JSONB array → Set; anything else ⇒ ∅).
 * Sibling of {@link readOffered}; see `WIKI_GARDENER_DISMISSED_KEY` for why the two
 * sets are kept separate rather than folded together.
 */
async function readDismissed(deps: BacklogRouteDeps, watcherId: string): Promise<Set<string>> {
  const snap = await deps.getSnapshot(watcherId, WIKI_GARDENER_DISMISSED_KEY);
  return new Set(Array.isArray(snap) ? (snap as string[]) : []);
}

/** Read the run-journal snapshot, validating its shape (null when absent/cleared). */
async function readRunJournal(deps: BacklogRouteDeps, watcherId: string): Promise<RunJournal | null> {
  const snap = await deps.getSnapshot(watcherId, WIKI_GARDENER_RUN_KEY);
  if (snap && typeof snap === "object" && Array.isArray((snap as { batchKeys?: unknown }).batchKeys)) {
    return snap as RunJournal;
  }
  return null;
}

/**
 * Per-bot record of the most recent manual backlog run's outcome (in-memory —
 * a dashboard convenience, not durable). Surfaced by the extended GET so the UI
 * can render the "run finished — nothing clustered" / "drafted N" line.
 */
const lastBacklogRuns = new Map<string, LastBacklogRun>();
function setLastBacklogRun(botName: string, r: LastBacklogRun): void {
  lastBacklogRuns.set(botName, r);
}
function getLastBacklogRun(botName: string): LastBacklogRun | null {
  return lastBacklogRuns.get(botName) ?? null;
}

/** The per-request live fields merged onto the cached backlog payload. */
export interface BacklogLiveFields {
  running: boolean;
  offered: number;
  remaining: number;
  /**
   * Queued docs that are ALSO in the offered set — the honest "offered in past
   * runs" count. Computed server-side (not derived client-side as `queued −
   * remaining`, which the age floor would inflate with merely-too-fresh docs).
   * Gates the strip's Reset button + picks its label.
   */
  offeredStillQueued: number;
  /**
   * Queued docs a human DISMISSED (the inspector's prune verb) — the fourth bucket.
   * Excluded from `remaining`/`fresh`/`offeredStillQueued` by construction (dismissed
   * wins the precedence), so `remaining + offeredStillQueued + fresh + dismissed ===
   * queued` still holds exactly. Emitted as its own wire field so the strip can
   * subtract it wherever it presents `queued` as ACTIONABLE.
   */
  dismissed: number;
  /**
   * Per-collection breakdown of `dismissed` — always present (empty object when
   * nothing is dismissed). The strip's ACTIONABLE affordances ("Backfill oldest" +
   * its `<select>` counts) subtract it from the cached per-collection `queued`, which
   * is a FOOTPRINT number and keeps counting dismissed docs. Without it, dismissing a
   * whole collection left the button enabled and mislabeled against a queue every
   * selection seam already refuses.
   */
  dismissedByCollection: Record<string, number>;
  /**
   * Queued docs still inside the weekly gardener's window (not offered, fails the
   * drain's age floor) — the "new arrivals" the strip leads with. These are the
   * weekly watcher's turf: the drain refuses them, so without this count they are
   * invisible (in `queued` but in neither `remaining` nor `offeredStillQueued`).
   */
  fresh: number;
  /**
   * Per-source breakdown of `fresh` (non-zero sources only, listing order). The
   * `collection` rides along so the strip's per-source toggle can scope the
   * inspector to that collection (the label alone isn't a stable key).
   */
  freshBySource: { label: string; count: number; collection: string }[];
  /** The resolved age-floor window in days — lets the client label "new (last Nd)". */
  freshWindowDays: number;
  /**
   * The bot's resolved minimum cluster size (per-bot, from `resolveGardenerConfig`
   * — NOT the merge-time constants `batchSize`/`maxProposals`). The strip's
   * run-suggestion meter derives its threshold from this (≥ 2× ⇒ "worth a gardener
   * run"); hardcoding 3 client-side would break the strip's no-hardcode contract and
   * any bot with a different config.
   */
  minClusterSize: number;
  lastBacklogRun: LastBacklogRun | null;
  /**
   * The most recent WEEKLY gardener run's outcome (the watcher path — distinct from
   * `lastBacklogRun`, the manual drain). Read from the durable `gardener:lastRun`
   * snapshot; null when the weekly run has never completed a clustering pass. Backs
   * the strip's weekly-run render branch (clusters found / kept / dropped-by-reason).
   */
  weeklyRun: WeeklyGardenerRun | null;
  watcherSeeded: boolean;
  /**
   * Whether the wiki gardener is enabled for this bot (`bot.gardener?.enabled !==
   * false`). The source-draft route 400s when it's disabled, so the strip reads this
   * to hide the "Draft source pages" button rather than let it POST into a 400.
   */
  gardenerEnabled: boolean;
  /**
   * The bot's wiki-gardener watcher, projected for the strip's fresh-segment
   * affordance (next-weekly-run time + "Run gardener now"). Null when the bot has
   * no seeded watcher. `nextRunAt` is `lastRunAt + intervalMs` (null ⇒ never run ⇒
   * due on the next tick); `forceQueued` reflects a pending manual/external trigger.
   */
  watcher?: BacklogWatcherInfo | null;
  /** Live progress of an in-flight drain (null when idle — including weekly runs). */
  progress: BacklogProgress | null;
  /**
   * Set when a run journal survived a crash / error settle AND no run is in flight
   * (PR 3) — backs the recovery banner. `drafted` = journal batch keys that produced
   * proposals since `at`. Absent/null when there is no stranded run.
   */
  interrupted?: { at: number; batchSize: number; drafted: number } | null;
  /**
   * The per-doc partition behind the counts — emitted ONLY when the request opts
   * in with `?docs=1` (the backlog inspector's lazy fetch). Absent otherwise so
   * the strip's 3s drain poll stays a small, count-only payload.
   */
  docs?: BacklogDocRow[];
}

/**
 * Merge the per-request live fields onto the cached (by-reference) backlog
 * payload WITHOUT mutating the cached object: strip the server-only `queuedKeys`
 * and spread a fresh object. Exported so the non-mutation contract is unit-tested.
 *
 * The batch constants (`batchSize`/`maxProposals`) are always emitted from the
 * shared `src/gardener/backlog.ts` source so the client confirm panel can render
 * "drain a batch of N … up to M drafts" without hardcoding the numbers.
 */
export function mergeBacklogLiveFields(
  data: IngestBacklogResponse,
  live: BacklogLiveFields,
): Record<string, unknown> {
  const { queuedKeys: _drop, ...rest } = data;
  return {
    ...rest,
    ...live,
    batchSize: BACKLOG_BATCH_SIZE,
    maxProposals: BACKLOG_MAX_PROPOSALS,
  };
}

/**
 * A cached queued-doc row (server-only until the `docs=1` opt-in). `key` is the
 * synthetic `<collection>/<id>`; `url` is the doc's original source URL, carried
 * through so the inspector can offer an "open ↗" link without a second listing.
 */
export interface BacklogQueuedKey {
  key: string;
  id: string;
  collection: string;
  date?: string;
  url?: string;
}

/**
 * Which live bucket a queued doc falls in — the inspector's row chip + filter.
 * `dismissed` is the PRUNE bucket (PR 2): a human said "never select this", so it is
 * excluded from every actionable count AND from every selection seam.
 */
export type BacklogBucket = "fresh" | "drainable" | "offered" | "dismissed";

/**
 * One inspector row: the queued doc decorated with its live {@link BacklogBucket}
 * membership. Emitted ONLY on `?docs=1` (the strip's 3s poll stays count-only).
 */
export interface BacklogDocRow {
  collection: string;
  id: string;
  /** Human row label — the id's basename, extension stripped ({@link backlogDocLabel}). */
  label: string;
  bucket: BacklogBucket;
  date?: string;
  url?: string;
  /**
   * The source drafter's LAST attempt on this doc, when one was recorded. Absent
   * means "never attempted" — which, before the ledger existed, was also what an
   * attempt that ended in `covered`/`skipped`/`error` looked like from here.
   */
  draft?: BacklogDocDraftAttempt;
}

/** The wire shape of a recorded drafter attempt on a backlog row. */
export interface BacklogDocDraftAttempt {
  outcome: SourceDraftAttemptOutcome;
  /** The skip burned model calls (as opposed to a cheap deterministic guard). */
  degraded: boolean;
  reason?: string;
  /** The drafted title, or the page that owns the colliding stem. */
  title?: string;
  /** Wiki-relative path of the page that blocked the draft — the row's deep link. */
  collidingPath?: string;
  /** The resulting `wiki_proposals` row, on a `drafted` outcome. */
  proposalId?: string;
  trigger: SourceDraftTrigger;
  /** Epoch ms of the attempt. */
  at: number;
}

/**
 * Decorate doc rows with the bot's recorded drafter attempts (pure). Rows with no
 * attempt are returned untouched, so a missing migration / degraded read (an empty
 * map) renders exactly the pre-ledger payload rather than an error.
 */
export function attachDraftAttempts(
  docs: BacklogDocRow[],
  attempts: Map<string, SourceDraftAttempt>,
): BacklogDocRow[] {
  if (attempts.size === 0) return docs;
  return docs.map((d) => {
    const a = attempts.get(`${d.collection}/${d.id}`);
    if (!a) return d;
    return {
      ...d,
      draft: {
        outcome: a.outcome,
        degraded: a.degraded,
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.collidingPath ? { collidingPath: a.collidingPath } : {}),
        ...(a.proposalId ? { proposalId: a.proposalId } : {}),
        trigger: a.trigger,
        at: a.attemptedAt,
      },
    };
  });
}

/**
 * Split the cached `queuedKeys` into the two honest live counts the strip needs,
 * applying the SAME age floor the drain uses ({@link passesAgeFloor}):
 *  - `remaining` = queued, NOT offered, AND past the age floor (the eligible-now
 *    set the "Drain a batch" button acts on);
 *  - `offeredStillQueued` = queued AND in the offered set (the exact "offered in
 *    past runs" count — replaces the old client-side `queued − remaining`, which
 *    the floor inflated by counting merely-too-fresh docs as offered);
 *  - `freshByCollection` = queued, NOT offered, and INSIDE the window (fails the
 *    floor) — the per-collection "new arrivals" bucket the strip leads with.
 *    Offered docs never count as fresh (pre-#288 burns belong to the tail).
 *  - `dismissed` = queued AND in the dismissed set — the human-pruned bucket.
 *
 * **Precedence: dismissed WINS over offered** (checked first). A doc that is both
 * must land in `dismissed`, because dismissed means "never select, drop from every
 * actionable counter" — if it counted as `offeredStillQueued` instead, "Reset
 * offered" would quietly make it eligible again. The intended side effect is that
 * dismissing an offered doc SHRINKS `offeredStillQueued` (and so the Reset button's
 * count/visibility).
 *
 * The four buckets partition the queued set exactly:
 * `remaining + offeredStillQueued + dismissed + Σ freshByCollection === queuedKeys.length`.
 *
 * It also returns `docs` — the SAME partition expressed per doc (`bucket`), in
 * input order. The counts are derived from the same single pass, so a count and
 * its bucket membership can never disagree; the route emits `docs` only on the
 * `?docs=1` opt-in (the strip's 3s poll stays count-only). `withDocs: false` skips
 * building that list entirely (the poll path) — the counts are unaffected.
 *
 * Pure + injectable so the route's floor branch is unit-testable. `q.id` is the
 * bare doc id (the floor's filename-prefix fallback needs it, not the key);
 * `q.collection` is carried through from the listing so the fresh bucket never
 * has to re-parse it out of the synthetic key.
 */
export function computeBacklogFloorCounts(
  queuedKeys: BacklogQueuedKey[],
  offeredSet: Set<string>,
  minAgeDays: number,
  now: number,
  withDocs = true,
  dismissedSet: Set<string> = new Set(),
): {
  remaining: number;
  offeredStillQueued: number;
  dismissed: number;
  /** Per-collection share of `dismissed` — the actionable affordances' subtrahend. */
  dismissedByCollection: Record<string, number>;
  freshByCollection: Record<string, number>;
  docs: BacklogDocRow[];
} {
  let remaining = 0;
  let offeredStillQueued = 0;
  let dismissed = 0;
  const dismissedByCollection: Record<string, number> = {};
  const freshByCollection: Record<string, number> = {};
  const docs: BacklogDocRow[] = [];
  for (const q of queuedKeys) {
    let bucket: BacklogBucket;
    // Dismissed wins over offered — see the precedence note above.
    if (dismissedSet.has(q.key)) {
      dismissed++;
      dismissedByCollection[q.collection] = (dismissedByCollection[q.collection] ?? 0) + 1;
      bucket = "dismissed";
    } else if (offeredSet.has(q.key)) {
      offeredStillQueued++;
      bucket = "offered";
    } else if (passesAgeFloor({ id: q.id, date: q.date }, minAgeDays, now)) {
      remaining++;
      bucket = "drainable";
    } else {
      freshByCollection[q.collection] = (freshByCollection[q.collection] ?? 0) + 1;
      bucket = "fresh";
    }
    if (!withDocs) continue;
    // The rendered date is the SAME value the floor (and the drain) judged the doc
    // by — `docDateMs` falls back to the id's `YYYY-MM-DD` prefix, so an undated
    // listing row shows its real date instead of a bare "—".
    const date = backlogDocDate(q);
    docs.push({
      collection: q.collection,
      id: q.id,
      label: backlogDocLabel(q.id),
      bucket,
      ...(date ? { date } : {}),
      ...(q.url ? { url: q.url } : {}),
    });
  }
  return { remaining, offeredStillQueued, dismissed, dismissedByCollection, freshByCollection, docs };
}

/**
 * A queued doc's EFFECTIVE date (`YYYY-MM-DD`), resolved exactly the way the drain
 * resolves it ({@link docDateMs}): the listing's explicit `date`, else the id's
 * `YYYY-MM-DD` prefix. Undefined only when neither yields a date. Without the
 * fallback an undated-but-prefixed doc rendered "—" and sorted to the bottom while
 * the drain would take it FIRST — the panel's top rows must be the drain's queue.
 */
export function backlogDocDate(q: { id: string; date?: string }): string | undefined {
  if (q.date) return q.date;
  const ms = docDateMs(q);
  return ms === undefined ? undefined : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Newest-first ordering for the inspector's doc list (undated docs last, then a
 * stable id tiebreak). Ordering is keyed on {@link docDateMs} — the SAME date the
 * drain selects by — so an undated row whose id carries a date prefix sorts by that
 * prefix instead of sinking to the bottom. Pure so the ordering contract is
 * unit-testable. Sorts a COPY — the caller's array (and the cached `queuedKeys`
 * order the counts rely on) is never reordered.
 */
export function sortBacklogDocsNewestFirst(docs: BacklogDocRow[]): BacklogDocRow[] {
  return [...docs].sort((a, b) => {
    const ad = docDateMs(a);
    const bd = docDateMs(b);
    if (ad !== bd) {
      if (ad === undefined) return 1;
      if (bd === undefined) return -1;
      return bd - ad;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Row label for the inspector: the doc id's basename with its extension stripped.
 * Huginn's listing endpoint carries NO usable `title` (its `title?` field is never
 * populated), and ids ARE human-readable source paths (`career/Why 2026 Is the
 * Year….md`) — so the basename is the honest v1 label, with the full id kept on
 * the row for the tooltip + deep link. Deliberately NOT N per-doc fetches.
 */
export function backlogDocLabel(id: string): string {
  const base = id.split("/").pop() || id;
  const dot = base.lastIndexOf(".");
  const stripped = dot > 0 ? base.slice(0, dot) : base;
  return stripped || id;
}

/**
 * Per-collection backlog counts decorated with the summary-source id + label for
 * the UI. Deliberately count-only: the module's per-collection `queuedDocs` list
 * (up to ~hundreds of doc objects) stays server-side — no client consumes it, and
 * PR 2's drain uses the module directly, not this HTTP payload.
 */
interface BacklogCollection {
  collection: string;
  source: string;
  label: string;
  total: number;
  ingested: number;
  queued: number;
}

/** The full `/api/wiki/ingest-backlog` payload (the cached, expensive part). */
export interface IngestBacklogResponse {
  byCollection: BacklogCollection[];
  total: number;
  ingested: number;
  queued: number;
  /** Distinct normalized URLs found across the wiki (reconciliation diagnostic). */
  wikiUrlCount: number;
  generatedAt: number;
  /** Present only when ≥1 collection failed to load (partial data). */
  errors?: StatsError[];
  /**
   * Server-only: every queued doc's `<collection>/<id>` key, its bare `id`, and
   * its listing date (when known). Cached alongside the counts so the extended GET
   * can compute `remaining` (queued minus the offered set AND minus docs still
   * inside the weekly gardener's window — the same age floor the drain applies).
   * The `id` is the BARE doc id, kept alongside `key` because the age floor's
   * `docDateMs` filename-prefix fallback inspects the id, not the collection-prefixed
   * key. The date is needed for that floor; youtube ids carry no date prefix, so an
   * undated doc reads its date from the id prefix. The doc's original `url` rides
   * along for the inspector's "open ↗" link (`?docs=1`). STRIPPED before the wire
   * by {@link mergeBacklogLiveFields}.
   */
  queuedKeys?: BacklogQueuedKey[];
}

const BACKLOG_TTL_MS = 5 * 60_000;

/**
 * Upper bound on a single dismiss/un-dismiss request's key list. The bulk affordance
 * selects every FILTERED row, which on a tail-heavy bot is in the hundreds — this
 * just fences a pathological payload, it is not a UX limit.
 */
const MAX_DISMISS_KEYS = 2000;

/** Timeout for huginn's DELETE (it moves a file + enqueues reindexes, then returns). */
const DELETE_TIMEOUT_MS = 20_000;

/**
 * Per-bot backlog cache. The backlog (wiki URL sweep + 4 collection listings +
 * partition) is expensive and stable within a TTL, so it's cached keyed by bot
 * name; `?refresh=1` bypasses the read, and an in-flight map single-flights
 * concurrent misses. Mirrors the summaries stats cache exactly.
 */
const backlogCache = new Map<string, { data: IngestBacklogResponse; at: number }>();
const backlogInFlight = new Map<string, Promise<IngestBacklogResponse>>();
/**
 * Per-bot invalidation generation. Bumped by {@link invalidateIngestBacklogCache};
 * captured by a compute at START and re-read on settle. Without it a compute that had
 * ALREADY read huginn's pre-delete listing would still `backlogCache.set` after the
 * invalidation — re-poisoning the cache with the stale listing for the whole TTL — and
 * its `.finally` would delete the NEWER in-flight promise out of the map. Both are
 * empirically reproducible: the refresh a delete triggers races the poll's compute.
 */
const backlogGeneration = new Map<string, number>();

function backlogGenerationOf(botName: string): number {
  return backlogGeneration.get(botName) ?? 0;
}

/**
 * Drop one bot's cached backlog (and any in-flight computation started BEFORE the
 * call). The production invalidation seam for the delete verb: huginn's DELETE only
 * moves the source file — the doc leaves huginn's LISTING when the background
 * reindex finishes, so the cached payload (and an in-flight compute that already
 * read the pre-prune listing) stays wrong for up to `BACKLOG_TTL_MS`. Called when
 * the reindex poll reaches a terminal status, right before the client's `refresh=1`
 * re-fetch — dropping the in-flight entry is the load-bearing half, since `refresh=1`
 * bypasses the cache READ but would otherwise still join a stale in-flight promise.
 */
export function invalidateIngestBacklogCache(botName: string): void {
  backlogCache.delete(botName);
  backlogInFlight.delete(botName);
  // Fence every compute that started before this call: on settle it must neither
  // re-cache its (now stale) payload nor evict a newer in-flight entry.
  backlogGeneration.set(botName, backlogGenerationOf(botName) + 1);
}

/** Test-only: clear the backlog cache (and in-flight guard) between cases. */
export function __resetIngestBacklogCacheForTest(): void {
  backlogCache.clear();
  backlogInFlight.clear();
  backlogGeneration.clear();
}

/**
 * Compute the backlog for a bot's wiki root: sweep the wiki for referenced URLs,
 * list every summary collection (via the shared sequential listing helper — never
 * unbounded concurrency at huginn's Python server), pull the consumed/pending
 * sets, and partition. A collection that fails contributes nothing and lands in
 * `errors` — never a page-breaking throw (huginn unreachable ⇒ partial/empty
 * data + errors).
 */
export async function computeIngestBacklogResponse(
  root: string,
  botName: string,
  deps: IngestBacklogDeps,
): Promise<IngestBacklogResponse> {
  const { byCollection: listedRaw, errors } = await listSummaryCollections(KNOWLEDGE_API_URL);

  const listedBySource: Record<string, ListedDoc[]> = {};
  for (const source of SUMMARY_SOURCES) {
    listedBySource[source.collection] = (listedRaw[source.collection] ?? []).map((d) => ({
      collection: source.collection,
      id: d.id,
      ...(d.url ? { url: d.url } : {}),
      ...(d.date ? { date: d.date } : {}),
    }));
  }

  const wikiRefs = await collectWikiRefs(root);
  const [consumed, pending] = await Promise.all([deps.getConsumed(botName), deps.getPending(botName)]);
  const backlog = computeIngestBacklog(listedBySource, wikiRefs, consumed, pending);

  // Counts only over the wire — queuedDocs stays in the module's return for
  // server-side consumers (PR 2's drain), never in the HTTP payload.
  const byCollection: BacklogCollection[] = backlog.byCollection.map((c) => {
    const src = SUMMARY_SOURCES.find((s) => s.collection === c.collection);
    return {
      collection: c.collection,
      source: src?.id ?? c.collection,
      label: src?.label ?? c.collection,
      total: c.total,
      ingested: c.ingested,
      queued: c.queued,
    };
  });

  // Server-only queued keys + dates (stripped before the wire) — used by the
  // extended GET to compute `remaining` against the offered set AND the age floor.
  const queuedKeys = backlog.byCollection.flatMap((c) =>
    c.queuedDocs.map((d) => ({
      key: `${d.collection}/${d.id}`,
      id: d.id,
      collection: d.collection,
      ...(d.date ? { date: d.date } : {}),
      // Carried for the inspector's "open ↗" link (`?docs=1`) — the listing already
      // has it, so decorating a row costs no extra fetch.
      ...(d.url ? { url: d.url } : {}),
    })),
  );

  return {
    byCollection,
    total: backlog.total,
    ingested: backlog.ingested,
    queued: backlog.queued,
    wikiUrlCount: wikiRefs.urls.size,
    generatedAt: Date.now(),
    queuedKeys,
    ...(errors.length ? { errors } : {}),
  };
}

/**
 * TTL-cached, single-flighted backlog for a resolved bot wiki. `refresh` bypasses
 * the cache read; concurrent misses share one computation; a degraded (errors)
 * payload is never cached so a recovered huginn is picked up on the next request.
 * This caches ONLY the expensive computation — the route merges any per-request
 * live fields (PR 2) OUTSIDE this seam. NOTE: the returned object IS the cached
 * entry (by reference) — callers must never mutate it (spread/clone instead).
 */
export async function getIngestBacklogCached(
  root: string,
  botName: string,
  deps: IngestBacklogDeps,
  refresh: boolean,
): Promise<IngestBacklogResponse> {
  if (!refresh) {
    const cached = backlogCache.get(botName);
    if (cached && Date.now() - cached.at < BACKLOG_TTL_MS) return cached.data;
  }

  let inflight = backlogInFlight.get(botName);
  if (!inflight) {
    // Capture the invalidation generation at START. Both the cache write and the
    // in-flight eviction below are conditional on it still being current, so a compute
    // that read huginn BEFORE an invalidation can neither re-poison the cache nor
    // evict the newer compute that replaced it.
    const startedGen = backlogGenerationOf(botName);
    inflight = (async () => {
      try {
        const data = await computeIngestBacklogResponse(root, botName, deps);
        // Only cache fully-successful results — a degraded payload (a collection down)
        // must not be served for the whole TTL once huginn recovers.
        const stale = backlogGenerationOf(botName) !== startedGen;
        if (!stale && (!data.errors || data.errors.length === 0)) {
          backlogCache.set(botName, { data, at: Date.now() });
        }
        return data;
      } finally {
        if (backlogGenerationOf(botName) === startedGen) backlogInFlight.delete(botName);
      }
    })();
    backlogInFlight.set(botName, inflight);
  }

  return await inflight;
}

/**
 * Assemble the full `GardenerDeps` for a manual backlog run from an
 * {@link AssembledBacklog}: the consumed-complement (harvest cap), the memoized
 * per-collection `listDocs` (huginn listed once during assembly — never re-listed),
 * an all-time lookback, and the raised proposal cap. Every other seam is IDENTICAL
 * to the weekly checker's via `buildGardenerSeams`, so the two paths can't drift.
 */
function buildBacklogGardenerDeps(
  assembled: AssembledBacklog,
  ctx: {
    bot: BotConfig;
    config: ReturnType<typeof loadConfig>;
    apiUrl: string;
    root: string;
    tracer: Tracer;
  },
  hooks: GardenerRunHooks,
): GardenerDeps {
  const { bot, config, apiUrl, root, tracer } = ctx;
  return {
    // Progress + soft-cancel seams (owned by the backlog work fn; the route only
    // forwards them). Undefined on the weekly path — behavior is byte-identical.
    onProgress: hooks.onProgress,
    shouldAbort: hooks.shouldAbort,
    onAborted: hooks.onAborted,
    onTally: hooks.onTally,
    botName: bot.name,
    wikiDir: root,
    collections: SUMMARY_SOURCES.map((s) => s.collection),
    minClusterSize: resolveGardenerConfig(bot.gardener).minClusterSize,
    lookbackDays: BACKLOG_LOOKBACK_DAYS,
    maxProposalsPerRun: BACKLOG_MAX_PROPOSALS,
    draftTimeoutMs: DRAFT_TIMEOUT_MS,
    now: () => Date.now(),
    tracer,
    // Serve harvest's listing from the memoized snapshot (huginn listed once in
    // assembleBacklog) — the gardener ListedDoc shape is id/url/date (no collection).
    listDocs: async (collection) =>
      (assembled.listedBySource[collection] ?? []).map((d) => ({
        id: d.id,
        ...(d.url ? { url: d.url } : {}),
        ...(d.date ? { date: d.date } : {}),
      })),
    // consumed-complement: everything except the batch is "consumed", so harvest
    // caps to exactly the selected batch.
    consumedDocIds: async () => assembled.consumedComplement,
    // Thread the drain's own tracer (the `wiki-gardener-backlog` root, finished by
    // the route) so the cluster haiku row joins the trace and each draft stamps a
    // `claude` child span under the "draft" stage span — parity with the weekly
    // checker. The drain never surfaces on /agents via traces (its root isn't a
    // `watcher:%`/`%_message` span), so the child span can't double-count.
    ...buildGardenerSeams({ botConfig: bot, config, apiUrl, wikiDir: root, tracer }),
  };
}

/**
 * Shared resolve/guard prologue for the two backlog POSTs: resolve the wiki
 * request against the full registry, reject unknown / non-bot wikis, and find
 * the matching wikiDir-bearing bot. Returns the resolved bot + root or a
 * `{ error, status }` the handler returns verbatim.
 */
type BacklogRefusal = { error: string; status: 400 | 403 | 404; readonly?: true };

/**
 * Render a `resolveBacklogBot` refusal. One helper, because a per-wiki refusal
 * carries `readonly: true` beside its 403 — the ONE shape the whole read-only
 * family answers with (`src/wiki/CLAUDE.md`) and the flag the client branches
 * on. Spelling the body at each of the nine call sites is how one of them ends
 * up dropping it.
 */
function backlogRefusal(c: Context, r: BacklogRefusal): Response {
  return c.json(r.readonly ? { error: r.error, readonly: true } : { error: r.error }, r.status);
}

function resolveBacklogBot(
  wikiQuery: string | undefined,
  botQuery: string | undefined,
): { bot: BotConfig; root: string } | BacklogRefusal {
  const { entry, unknownWiki } = resolveWikiRequest(
    getWikiRegistry(),
    wikiQuery,
    botQuery,
    process.env.WIKI_DIR,
  );
  if (unknownWiki) return { error: "no wiki configured for that name", status: 404 };
  if (entry && entry.source !== "bot") {
    return { error: "the ingest backlog is only available for bot wikis", status: 400 };
  }
  // Per-wiki read-only guard, on the ONE prologue every drafting POST in this
  // file already funnels through (backlog-run, source-draft-{run,backlog,doc},
  // backlog-doc-delete). The `source !== "bot"` check above covers a standalone
  // read-only wiki; it does NOT cover a BOT whose own `wikiDir` is listed in
  // `WIKI_READONLY_ROOTS`, and every one of these verbs spends a model call on
  // that wiki's content or reaches huginn with it.
  if (entry && isReadonlyWikiRoot(entry.root)) {
    // 403 + `readonly: true`, not a 400: this is a POLICY refusal about the wiki,
    // not a complaint about the request, and it is the shape every other per-wiki
    // guard in the family answers with.
    return { error: wikiNoEgressReason(entry.name), status: 403, readonly: true };
  }
  const root = entry?.root;
  const bot = entry
    ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir)
    : undefined;
  if (!bot || !root) return { error: "no wiki bot resolved", status: 404 };
  return { bot, root };
}

export function registerWikiGardenerRoutes(
  app: Hono,
  backlogDeps: BacklogRouteDeps = DEFAULT_BACKLOG_ROUTE_DEPS,
): void {
  // Review page.
  app.get("/wiki/gardener", async (c) => {
    // The picker lists every gardener-capable wiki (bot wikis + consolidation-
    // capable standalone wikis; see `isGardenerWiki`).
    const wikiBots = listWikis(getGardenerRegistry());
    // Resolve against the FULL registry so a `?wiki=<extra>` is recognized. An
    // extra wiki WITHOUT collections still reads as "unavailable" (no consolidation
    // corpus); one WITH collections is a valid consolidation gate scope.
    const { wiki: selected, envOverride, entry } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    const notBotWiki = !!entry && !isGardenerWiki(entry);
    return c.html(await renderWikiGardenerPage({ wikiBots, selected, envOverride, notBotWiki }));
  });

  // List a bot's proposals (all statuses, newest first). Preview + diff are only
  // computed for the rows a reviewer actually inspects (draft/stale) so the page
  // cost doesn't grow unbounded with terminal history.
  app.get("/api/wiki/proposals", async (c) => {
    // One resolution against the full registry — root + source + bot all come from
    // the single resolved entry (no separate root lookup + re-resolve dance).
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ proposals: [], error: "no wiki configured for that name" });
    }
    // `root` is the wiki the proposals are drawn from — previews + update-diffs
    // read the same wiki the gardener writes into. A bot wiki draws bot-keyed
    // rows; a standalone (extra) wiki draws its own wiki-keyed consolidation
    // `synthesis` rows (see the wiki-scoped reads).
    const root = entry?.root;
    let rows: WikiProposal[];
    // The bot's per-kind index-cataloging policy — applies ONLY to bot-keyed rows.
    // Wiki-keyed (consolidation `synthesis`) rows use default kinds regardless of
    // which gate view lists them (computed per-row in the map below via
    // `p.wikiName ? undefined : botCatalogKinds`).
    let botCatalogKinds: string[] | undefined;
    if (entry && entry.source === "extra") {
      // Same gate as the page route: a collection-less standalone wiki can't be
      // semantically clustered, so it has no proposals surface at all.
      if (!isGardenerWiki(entry)) {
        return c.json({ proposals: [], error: "no gardener collections configured for this wiki" });
      }
      // Standalone wiki: consolidation-gardener rows keyed to the wiki name. No
      // per-wiki catalog policy — default `["concept"]` (synthesis is never
      // cataloged regardless, so the wiring preview always shows a skip).
      rows = await listAllWikiProposalsByWiki(entry.name);
    } else {
      const bot = entry
        ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir)
        : undefined;
      if (!bot || !entry) return c.json({ proposals: [], error: "no wiki bot resolved" });
      // A bot wiki's gate lists BOTH the bot-keyed rows (concept/entity/source — the
      // gardener's own) AND any wiki-keyed consolidation `synthesis` rows for this
      // wiki name. The rail's Draft-synthesis button drafts those on bot-owned wikis
      // too (collections like jarvis `["wiki","wiki-life"]`), and they'd otherwise be
      // invisible + un-approvable here.
      const [botRows, wikiRows] = await Promise.all([
        listAllWikiProposals(bot.name),
        listAllWikiProposalsByWiki(entry.name),
      ]);
      rows = [...botRows, ...wikiRows].sort((a, b) => b.createdAt - a.createdAt);
      botCatalogKinds = bot.wikiAutoCommit?.catalogKinds;
    }
    const index = await getWikiIndex({ root });
    const resolve = index ? index.resolve : () => undefined;

    const proposals: ProposalView[] = await Promise.all(
      rows.map(async (p) => {
        const title = draftTitle(p);
        const reviewable = p.status === "draft" || p.status === "stale";
        let diff: DiffLine[] | null = null;
        if (reviewable && p.mode === "update" && root) {
          const current = await readFileOrNull(path.join(root, p.targetPath));
          if (current !== null) diff = lineDiff(current, p.draft);
        }
        // New rows carry a persisted containment report (`contained_links`); the
        // read-time scan is only a fallback for legacy rows drafted before body
        // containment. Computed read-time (a page created post-draft clears it).
        const containedLinks = p.containedLinks ? p.containedLinks.delinked : null;
        const unresolvedLinks =
          reviewable && !containedLinks
            ? scanUnresolvedBodyLinks(stripFrontmatter(p.draft), { resolve, selfTitle: title })
            : [];
        // Wiring preview: what the apply-time wire stage will do — the planned
        // index line (or entity skip) + the related pages that still resolve in the
        // live index and will gain an inbound See-also link. Read-time, no persisted
        // state; a NULL `related_pages` (pre-migration row) degrades to a note.
        let wiring: WiringPreview | null = null;
        if (reviewable) {
          const domain: "ai" | "life" = p.targetPath.startsWith("life/") ? "life" : "ai";
          // A wiki-keyed (consolidation `synthesis`) row uses default kinds even when
          // listed in a bot wiki's gate — never the drafting bot's catalog policy —
          // matching apply's wire stage (which resolves standalone/wiki-keyed rows
          // with `undefined` catalogKinds). Bot-keyed rows use the bot's real policy
          // (jarvis catalogs sources; a concept-only wiki doesn't).
          const catalogKinds = p.wikiName ? undefined : botCatalogKinds;
          const entry = buildIndexEntry(
            {
              title,
              kind: p.kind,
              domain,
              rationale: p.rationale,
              body: stripFrontmatter(p.draft),
            },
            catalogKinds,
          );
          const seeAlso = selectWirablePages(p.relatedPages, index, p.targetPath).map(
            (wp) => wp.title,
          );
          // Derive the skip cause from the real policy: entities are hard-skipped
          // (split index, file manually); any other uncataloged kind is out of this
          // wiki's `catalogKinds` policy (e.g. a source page on a concept-only wiki).
          const indexSkip = catalogPage(p.kind, catalogKinds)
            ? null
            : p.kind === "entity"
              ? "entity"
              : "not-in-policy";
          wiring = {
            indexLine: entry ? entry.line : null,
            indexSkip,
            seeAlso,
            legacyNoRelated: p.relatedPages === null,
          };
        }
        return {
          id: p.id,
          topicKey: p.topicKey,
          title,
          kind: p.kind,
          mode: p.mode,
          targetPath: p.targetPath,
          status: p.status,
          createdAt: p.createdAt,
          resolvedAt: p.resolvedAt,
          rationale: p.rationale,
          sourceDocs: p.sourceDocs,
          previewHtml: reviewable ? renderWikiHtml(p.draft, resolve, { stripTitle: title }) : "",
          diff,
          unresolvedLinks,
          containedLinks,
          wiring,
        };
      }),
    );
    return c.json({ proposals });
  });

  // Report-only wiki lint findings, recomputed on demand from the wiki tree (no
  // DB table, no writes). Same wiki resolution as `/api/wiki/proposals`; a
  // missing/unreadable wiki degrades to a 200 with an `error` field, never a 5xx.
  //
  // **Available for EVERY registered wiki, bot-owned or standalone.** It used to
  // refuse `entry.source !== "bot"` and then resolve a bot it never used — the bot
  // was read for one `log.warn` field and nothing else. Linting is a pure index read
  // (`getWikiIndex` + per-page file reads); it needs no connector, no collections, no
  // bot-keyed DB rows. The refusal meant the standalone `WIKI_EXTRA` wikis — mimir
  // and melosys-kode-wiki, i.e. the two that carry the most hand-authored
  // frontmatter — had NO lint surface at all, so a finding like an implausible future
  // `updated:` (which the reader's recency sort drops silently by design) was
  // invisible there on every surface at once.
  //
  // The proactive `wiki-linter` WATCHER stays bot-only on purpose: it delivers a
  // Telegram alert, and a bot is what owns a delivery channel. This on-demand read
  // has no such dependency.
  app.get("/api/wiki/linter-findings", async (c) => {
    const empty = { findings: [], counts: {}, generatedAt: Date.now() };
    const { wiki, entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ ...empty, error: "no wiki configured for that name" });
    }
    // Absent entry = the `WIKI_DIR` env-override path; `getWikiIndex` resolves the
    // same default root the reader uses.
    const root = entry?.root;

    // Never-5xx contract: any unexpected throw (index build, file reads) degrades
    // to a 200 with an `error` field, like the resolution failures above.
    try {
      const index = await getWikiIndex({ root });
      if (!index) return c.json({ ...empty, error: "wiki directory is not readable" });

      const report = await lintWiki(index);
      return c.json(report);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("Wiki-linter: lint run failed for {wiki}: {error}", {
        wiki: entry?.name || wiki || "(default)",
        error: reason,
      });
      return c.json({ ...empty, error: `lint failed: ${reason}` });
    }
  });

  // Report-only ingest backlog — the all-time count of summary docs never
  // ingested into the wiki (in any form), per collection. Same bot resolution +
  // never-5xx contract as `/api/wiki/linter-findings`; huginn unreachable ⇒ 200
  // with partial/empty data + an `errors` array (the page never breaks).
  app.get("/api/wiki/ingest-backlog", async (c) => {
    const empty = { byCollection: [], total: 0, ingested: 0, queued: 0, wikiUrlCount: 0, generatedAt: Date.now() };
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ ...empty, error: "no wiki configured for that name" });
    }
    if (entry && entry.source !== "bot") {
      return c.json({ ...empty, error: "the ingest backlog is only available for bot wikis" });
    }
    const root = entry?.root;
    const bot = entry
      ? getBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase() && !!b.wikiDir)
      : undefined;
    if (!bot || !root) return c.json({ ...empty, error: "no wiki bot resolved" });

    const refresh = c.req.query("refresh") === "1";
    // Never-5xx contract: getIngestBacklogCached swallows per-collection fetch
    // errors, so a throw here means the wiki sweep or DB lookups failed. Degrade
    // to a 200 with empty data + an error note rather than a 5xx.
    try {
      const data = await getIngestBacklogCached(root, bot.name, backlogDeps, refresh);
      // Per-request live fields (backlog-run state) are merged HERE — outside the
      // cached computation above. `mergeBacklogLiveFields` spreads a fresh object
      // (and strips the server-only `queuedKeys`), never mutating the cached entry.
      const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
      const offeredSet = watcher ? await readOffered(backlogDeps, watcher.id) : new Set<string>();
      // The dismissed overlay is read per-request alongside `offered` — deliberately
      // OUTSIDE the 5-min cache, so a dismiss click moves the counters on the very
      // next plain refetch (no `refresh=1`, which would force the expensive recompute).
      const dismissedSet = watcher ? await readDismissed(backlogDeps, watcher.id) : new Set<string>();
      const queuedKeys = data.queuedKeys ?? [];
      // Mirror the drain's age floor here (shared `computeBacklogFloorCounts` ⇒
      // `passesAgeFloor`) so the strip stops advertising docs the drain now refuses:
      // a doc counts as `remaining` only when it is not already offered AND is old
      // enough to have left the weekly gardener's window (undated ⇒ old backlog,
      // kept). `offeredStillQueued` (queued ∩ offered) is emitted explicitly so the
      // strip no longer derives it as `queued − remaining` (which the floor inflates).
      const gardenerCfg = resolveGardenerConfig(bot.gardener);
      const minAgeDays = gardenerCfg.lookbackDays;
      const now = Date.now();
      // Opt-in per-doc list (the backlog inspector). Classified in the SAME pass as
      // the counts, at the live merge layer, so bucket membership reflects the
      // per-request offered set — never the 5-min-cached compute (which knows
      // nothing about offered/floor). Gated so the 3s drain poll never allocates
      // (or labels) a row per queued doc; the counts are identical either way.
      const wantDocs = c.req.query("docs") === "1";
      const { remaining, offeredStillQueued, dismissed, dismissedByCollection, freshByCollection, docs } =
        computeBacklogFloorCounts(queuedKeys, offeredSet, minAgeDays, now, wantDocs, dismissedSet);
      // Per-source fresh breakdown in listing order, labels from the cached
      // byCollection rows (non-zero only — the wire stays compact).
      const freshBySource = data.byCollection
        .filter((c) => (freshByCollection[c.collection] ?? 0) > 0)
        .map((c) => ({ label: c.label, count: freshByCollection[c.collection]!, collection: c.collection }));
      const fresh =Object.values(freshByCollection).reduce((s, n) => s + n, 0);
      const running = gardenerRunInFlight(bot.name);

      // Last-run: the in-memory record wins; after a restart it's gone, so fall back
      // to the durable `backlog:lastRun` snapshot written alongside it.
      let lastBacklogRun = getLastBacklogRun(bot.name);
      if (!lastBacklogRun && watcher) {
        const snap = await backlogDeps.getSnapshot(watcher.id, WIKI_GARDENER_LAST_RUN_KEY);
        if (snap && typeof snap === "object") lastBacklogRun = snap as LastBacklogRun;
      }

      // Weekly-run outcome (watcher path) — durable-snapshot only (no in-memory
      // record; the watcher fires out-of-band, unlike the dashboard-driven drain).
      let weeklyRun: WeeklyGardenerRun | null = null;
      if (watcher) {
        const snap = await backlogDeps.getSnapshot(watcher.id, WIKI_GARDENER_WEEKLY_RUN_KEY);
        if (snap && typeof snap === "object") weeklyRun = snap as WeeklyGardenerRun;
      }

      // Interrupted-run detection: a journal that outlived its run (a crash or an
      // error settle KEEPS it) with no run currently in flight ⇒ surface a banner.
      let interrupted: BacklogLiveFields["interrupted"] = null;
      if (watcher && !running) {
        const journal = await readRunJournal(backlogDeps, watcher.id);
        // Re-probe after the read: an Ingest that started during the awaits above
        // may have just written ITS journal — that's a live run, not an interrupted
        // one (would flash a false banner for one poll).
        if (journal && !gardenerRunInFlight(bot.name)) {
          const proposals = await backlogDeps.listProposals(bot.name);
          const drafted = draftedKeysSince(proposals, journal.startedAt, journal.batchKeys);
          interrupted = { at: journal.startedAt, batchSize: journal.batchKeys.length, drafted: drafted.size };
        }
      }

      // Watcher projection for the strip's fresh-segment affordance. `nextRunAt` is
      // the canonical next-fire projection `computeWatcherNextRun` (the same one the
      // /agents page uses) — it honors the gardener's time-of-day gate (config.hour,
      // Oslo), so a watcher whose interval elapsed at 03:00 still projects ~10:00,
      // not "due on next tick". That projection always returns a number, using `now`
      // as the sentinel for the due-now / force-queued / never-run cases; we map any
      // result at-or-before `now` back to the wire's `null` ("due on next tick"),
      // keeping the `nextRunAt: number | null` wire shape unchanged.
      const watcherInfo: BacklogWatcherInfo | null = watcher
        ? {
            id: watcher.id,
            enabled: watcher.enabled,
            lastRunAt: watcher.lastRunAt ?? null,
            nextRunAt: (() => {
              const projected = computeWatcherNextRun(watcher, now).nextRunAt;
              return projected > now ? projected : null;
            })(),
            forceQueued: watcher.forceNextRun === true,
          }
        : null;

      return c.json(
        mergeBacklogLiveFields(data, {
          running,
          offered: offeredSet.size,
          remaining,
          offeredStillQueued,
          dismissed,
          dismissedByCollection,
          fresh,
          freshBySource,
          freshWindowDays: minAgeDays,
          minClusterSize: gardenerCfg.minClusterSize,
          lastBacklogRun,
          weeklyRun,
          watcherSeeded: !!watcher,
          gardenerEnabled: bot.gardener?.enabled !== false,
          watcher: watcherInfo,
          progress: getBacklogProgress(bot.name),
          interrupted,
          // Attempt ledger joined on the opt-in docs path only — the 3s poll must not
          // pay for a table read, and a degraded read returns an empty map, which
          // `attachDraftAttempts` renders as the untouched pre-ledger payload.
          ...(wantDocs
            ? {
                docs: attachDraftAttempts(
                  sortBacklogDocsNewestFirst(docs),
                  await getSourceDraftAttempts(bot.name),
                ),
              }
            : {}),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Ingest backlog computation failed for {bot}: {error}", { bot: bot.name, error: message });
      return c.json({
        ...empty,
        errors: [{ source: "backlog", collection: "", error: message }],
      });
    }
  });

  // Manual "ingest backlog" drain — kicks a DETACHED gardener run over a bounded
  // batch of never-ingested summary docs (URL-referenced docs are never drafted),
  // routed through the SAME pipeline so every draft is a reviewable proposal. No
  // Telegram alert (the user is at the dashboard). Responds immediately with the
  // run state; the client polls the GET while `running`.
  app.post("/api/wiki/gardener/backlog-run", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot, root } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    const config = loadConfig();

    // Real-seam wiring for the R4 low-volume fallback — built once, reused per doc.
    const sourceFallbackDeps = defaultSourceBacklogDeps(bot, root, KNOWLEDGE_API_URL);

    const result = startBacklogRun({
      botName: bot.name,
      gardenerEnabled: bot.gardener?.enabled !== false,
      hasWatcher: !!watcher,
      // A batch below the cluster minimum can't draft — the work fn short-circuits
      // to an `insufficient` outcome (no journal/offer/run) rather than burning the
      // tiny tail. Sourced from the SAME resolved config as the runner's clusterer.
      minClusterSize: resolveGardenerConfig(bot.gardener).minClusterSize,
      assemble: () =>
        assembleBacklog({
          botName: bot.name,
          wikiDir: root,
          apiUrl: KNOWLEDGE_API_URL,
          listCollections: listSummaryCollections,
          sweepWikiRefs: collectWikiRefs,
          getConsumed: backlogDeps.getConsumed,
          getPending: backlogDeps.getPending,
          getOffered: () => readOffered(backlogDeps, watcher!.id),
          // Prune seam: dismissed keys are unioned into the batch EXCLUSION (never
          // into the persisted offered set — see WIKI_GARDENER_DISMISSED_KEY).
          getDismissed: () => readDismissed(backlogDeps, watcher!.id),
          // Age floor = the bot's RESOLVED weekly window, so the drain never
          // touches docs the weekly gardener still owns (would burn a fresh
          // arrival that can't cluster, hiding it from both paths).
          minAgeDays: resolveGardenerConfig(bot.gardener).lookbackDays,
          now: Date.now(),
        }),
      persistOffered: (keys) => backlogDeps.setSnapshot(watcher!.id, WIKI_GARDENER_OFFERED_KEY, keys),
      // Journal seams (PR 3) — the auto-recover + crash-safety record all ride the
      // same watcher_snapshots table, keyed by `backlog:run`.
      getOffered: () => readOffered(backlogDeps, watcher!.id),
      readRunJournal: () => readRunJournal(backlogDeps, watcher!.id),
      writeRunJournal: (j) => backlogDeps.setSnapshot(watcher!.id, WIKI_GARDENER_RUN_KEY, j),
      clearRunJournal: () => backlogDeps.setSnapshot(watcher!.id, WIKI_GARDENER_RUN_KEY, null),
      draftedKeysSince: async (startedAt, batchKeys) =>
        draftedKeysSince(await backlogDeps.listProposals(bot.name), startedAt, batchKeys),
      // The tracer root span must be finished HERE — runGardener only creates
      // sub-spans (the weekly checker finishes its own tracer the same way);
      // without this every drain leaves a malformed open trace in the waterfall.
      runGardener: async (assembled, hooks) => {
        const tracer = new Tracer("wiki-gardener-backlog", { botName: bot.name });
        try {
          const alerts = await runGardener(
            buildBacklogGardenerDeps(assembled, { bot, config, apiUrl: KNOWLEDGE_API_URL, root, tracer }, hooks),
          );
          tracer.finish("ok", {
            offered: assembled.batchKeys.length,
            drafted: draftedCount(alerts),
          });
          return alerts;
        } catch (err) {
          tracer.error(err instanceof Error ? err : String(err));
          throw err;
        }
      },
      // Low-volume vertical fallback (R4): when the gardener drafts ZERO cluster
      // proposals, draft the batch docs individually as source pages instead. Bound to
      // the real `draftOneBacklogDoc` (which fetches each doc's body internally — the
      // drain discarded harvested bodies) via `defaultSourceBacklogDeps`. A candidate
      // carries collection/id/date but no url, so we pass url:"" and rely on the
      // fetched doc's metadata.url. `sourceFallbackDeps` is built ONCE per run.
      draftSourceFallback: (cand) =>
        draftOneBacklogDoc(
          {
            collection: cand.collection,
            id: cand.id,
            url: "",
            ...(cand.date ? { date: cand.date } : {}),
          },
          sourceFallbackDeps,
        ),
      recordLastRun: (r) => {
        setLastBacklogRun(bot.name, r);
        // Durable fallback for the extended GET after a restart drops the in-memory
        // map. Best-effort — a snapshot-write failure must not fail the settled run.
        if (watcher) {
          void backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_LAST_RUN_KEY, r).catch((err) => {
            log.warn("Backlog run: persisting last-run snapshot failed for {bot}: {error}", {
              bot: bot.name,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      },
    });

    if (result.state === "no-watcher") {
      return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);
    }
    if (result.state === "disabled") {
      return c.json({ error: "the wiki gardener is disabled for this bot" }, 400);
    }
    return c.json({ state: result.state });
  });

  // Reset the offered memory — writes an empty offered snapshot so every queued
  // doc is eligible again (the recovery path for rejected-but-still-offered docs).
  // Refused while a run is in flight: the run's persistOffered was computed from
  // a pre-reset read and would silently clobber the empty set.
  app.post("/api/wiki/gardener/backlog-reset", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    const outcome = await resetBacklogOffered(bot.name, () =>
      backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY, []),
    );
    if (!outcome.ok) return c.json({ state: "running", error: outcome.error }, 409);
    return c.json({ ok: true });
  });

  // Soft-cancel an in-flight backlog drain — flips the run's cancel flag; the
  // runner stops after at most one more draft, keeping every persisted proposal
  // and returning the undrafted docs to the queue. Same resolution/watcher guards
  // as backlog-reset. No run in flight (a cancel racing the natural settle — the
  // likely case) is a no-op 200 `{cancelled:false}`, not an error.
  app.post("/api/wiki/gardener/backlog-cancel", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    return c.json({ cancelled: requestBacklogCancel(bot.name) });
  });

  // Recover an interrupted (crashed / errored) drain — return its undrafted batch
  // docs to the offered pool so they're eligible again, then clear the journal. The
  // math is DELIBERATELY the coarse `batchKeys − draftedKeys` (not PR 2's cancel
  // math that subtracts only skipped clusters' docs): a crash may predate clustering
  // so no cluster info exists, and the user explicitly chose Recover over Dismiss.
  // Held under the per-bot mutex so a recover click racing an Ingest click serializes
  // rather than interleaving (the same check-then-persist TOCTOU §3a rejects for
  // run-start). No journal (a refresh race) ⇒ a clean no-op 200 `{recovered:0}`.
  app.post("/api/wiki/gardener/backlog-recover", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    const run = runExclusive(bot.name, () =>
      // The ONE recover body, shared with startBacklogRun's in-mutex auto-recover.
      recoverRunJournal({
        readRunJournal: () => readRunJournal(backlogDeps, watcher.id),
        draftedKeysSince: async (startedAt, batchKeys) =>
          draftedKeysSince(await backlogDeps.listProposals(bot.name), startedAt, batchKeys),
        getOffered: async () => readOffered(backlogDeps, watcher.id),
        persistOffered: (keys) => backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_OFFERED_KEY, keys),
        clearRunJournal: () => backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_RUN_KEY, null),
      }),
    );
    if (run === null) return c.json({ error: "a run is in flight" }, 409);
    return c.json({ recovered: await run });
  });

  // Dismiss an interrupted drain — leave the batch skipped (offered), just clear the
  // journal so the banner goes away. No journal is a clean no-op (refresh-race
  // friendly). Same resolution/watcher guards as the other backlog POSTs. Held under
  // the per-bot mutex like recover — a stale banner's Dismiss (e.g. another tab)
  // racing a fresh Ingest must NOT null the live run's journal, which would strand
  // that batch unrecoverably if it crashed.
  app.post("/api/wiki/gardener/backlog-dismiss", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot } = resolved;

    const watcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    if (!watcher) return c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404);

    const run = runExclusive(bot.name, () =>
      backlogDeps.setSnapshot(watcher.id, WIKI_GARDENER_RUN_KEY, null),
    );
    if (run === null) return c.json({ error: "a run is in flight" }, 409);
    await run;
    return c.json({ ok: true });
  });

  // ── Prune verbs (PR 2): dismiss (cheap, reversible) + delete (destructive) ──
  //
  // NB the route names: `backlog-dismiss` above is the INTERRUPTED-RUN banner's
  // dismiss (clears the run journal). These act on queued DOCS, hence the `-docs-`
  // / `-doc-` infix — a collision here would silently null a live run's journal.

  /**
   * Shared body parse for the dismiss verbs: `{ keys: string[] }`, each key the
   * inspector's `<collection>/<id>`. Rejects a non-array / empty list and caps the
   * batch (the bulk affordance can select every filtered row).
   */
  const parseDismissKeys = (body: unknown): { keys: string[] } | { error: string } => {
    const raw = (body as { keys?: unknown })?.keys;
    if (!Array.isArray(raw)) return { error: "expected a non-empty `keys` array of doc keys" };
    const keys = raw.filter((k): k is string => typeof k === "string" && k.length > 0);
    if (!keys.length) return { error: "expected a non-empty `keys` array of doc keys" };
    // Distinct message: an over-cap batch is a DIFFERENT failure from a malformed
    // body, and "expected a non-empty array" would send the caller hunting the wrong
    // bug. The client chunks under the cap, so this is a fence, not a UX limit.
    if (keys.length > MAX_DISMISS_KEYS) {
      return {
        error: `too many keys: ${keys.length} (max ${MAX_DISMISS_KEYS} per request — send them in chunks)`,
      };
    }
    return { keys };
  };

  /**
   * Guard prologue shared by every prune route: resolve the bot, require a seeded
   * `wiki-gardener` watcher (the snapshot's FK — exactly the RESET route's 404), and
   * hold the per-bot gardener mutex (exactly the `backlog-recover` route's 409) so a
   * prune can't interleave with a drain's offered read/persist. Returns a Response on
   * refusal, else the resolved `{ bot, watcher }` (the wiki `root` is deliberately not
   * returned — no prune verb touches the wiki on disk).
   *
   * The readonly refusal leads it: a prune verb writes no wiki page, but it DOES
   * mutate snapshots the write owner's in-flight drain reads (and, for delete,
   * huginn itself) — so a non-owner instance must not touch them.
   */
  const resolvePruneTarget = async (
    c: Context,
  ): Promise<{ bot: BotConfig; watcher: GardenerWatcherRef } | { refusal: Response }> => {
    const refused = readonlyRefusal(c);
    if (refused) return { refusal: refused };
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) {
      return { refusal: backlogRefusal(c, resolved) };
    }
    const watcher = await backlogDeps.getWikiGardenerWatcher(resolved.bot.name);
    if (!watcher) {
      return { refusal: c.json({ error: "no wiki-gardener watcher seeded for this bot" }, 404) };
    }
    return { bot: resolved.bot, watcher };
  };

  /** Read-modify-write the dismissed snapshot under the mutex. `null` ⇒ 409. */
  const mutateDismissed = (
    botName: string,
    watcherId: string,
    edit: (current: Set<string>) => Set<string>,
  ): Promise<number> | null =>
    runExclusive(botName, async () => {
      const next = edit(await readDismissed(backlogDeps, watcherId));
      await backlogDeps.setSnapshot(watcherId, WIKI_GARDENER_DISMISSED_KEY, [...next]);
      return next.size;
    });

  // Dismiss queued docs — add their keys to `backlog:dismissed`. Cheap + reversible:
  // nothing is deleted anywhere, the docs just stop being selected (drain / source
  // drafter / weekly harvest) and drop out of every actionable counter. The counters
  // move on the next PLAIN refetch (the set is read outside the 5-min cache), so the
  // client must never send `refresh=1` for this.
  app.post("/api/wiki/gardener/backlog-docs-dismiss", async (c) => {
    const target = await resolvePruneTarget(c);
    if ("refusal" in target) return target.refusal;

    const parsed = parseDismissKeys(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const keys = parsed.keys;

    const run = mutateDismissed(target.bot.name, target.watcher.id, (current) => {
      for (const k of keys) current.add(k);
      return current;
    });
    if (run === null) return c.json({ error: "a gardener run is in flight" }, 409);
    const dismissed = await run;
    log.info("Backlog: dismissed {n} doc(s) for {bot} (set now {dismissed})", {
      bot: target.bot.name,
      n: keys.length,
      dismissed,
    });
    return c.json({ ok: true, dismissed });
  });

  // Un-dismiss — remove keys from the set, returning those docs to their natural
  // bucket (fresh / drainable / offered) on the next refetch.
  app.post("/api/wiki/gardener/backlog-docs-undismiss", async (c) => {
    const target = await resolvePruneTarget(c);
    if ("refusal" in target) return target.refusal;

    const parsed = parseDismissKeys(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const run = mutateDismissed(target.bot.name, target.watcher.id, (current) => {
      for (const k of parsed.keys) current.delete(k);
      return current;
    });
    if (run === null) return c.json({ error: "a gardener run is in flight" }, 409);
    return c.json({ ok: true, dismissed: await run });
  });

  // Reset the whole dismissed set — the "Reset offered" analogue for the prune
  // bucket. Every dismissed doc becomes selectable again.
  app.post("/api/wiki/gardener/backlog-docs-dismiss-reset", async (c) => {
    const target = await resolvePruneTarget(c);
    if ("refusal" in target) return target.refusal;

    const run = mutateDismissed(target.bot.name, target.watcher.id, () => new Set<string>());
    if (run === null) return c.json({ error: "a gardener run is in flight" }, 409);
    await run;
    return c.json({ ok: true, dismissed: 0 });
  });

  /**
   * DELETE a queued doc from huginn — the destructive prune verb, for junk that
   * should not exist at all. Proxied server-side because huginn's CORS is GET/POST
   * only (the browser cannot call its DELETE).
   *
   * huginn soft-deletes: it moves the source file outside the reader's basePath and
   * enqueues a BACKGROUND reindex for every collection sharing that path. Its 200
   * therefore does NOT mean the doc has left the listing — the client polls
   * `backlog-doc-delete-status` until terminal before re-fetching with `refresh=1`
   * (an immediate `refresh=1` would re-list the still-present doc and cache that
   * wrong payload for the whole TTL).
   *
   * On success the key is pruned from BOTH snapshot sets (a deleted doc must not
   * leave a dangling offered/dismissed entry that outlives it).
   */
  app.post("/api/wiki/gardener/backlog-doc-delete", async (c) => {
    const target = await resolvePruneTarget(c);
    if ("refusal" in target) return target.refusal;

    const body = (await c.req.json().catch(() => null)) as
      | { collection?: unknown; id?: unknown }
      | null;
    const collection = typeof body?.collection === "string" ? body.collection : "";
    const id = typeof body?.id === "string" ? body.id : "";
    if (!collection || !id) return c.json({ error: "expected `collection` and `id`" }, 400);
    if (!SUMMARY_SOURCES.some((s) => s.collection === collection)) {
      return c.json({ error: `unknown summary collection "${collection}"` }, 400);
    }

    const key = `${collection}/${id}`;
    const run = runExclusive(target.bot.name, async () => {
      const res = await fetchKnowledgeApi(
        KNOWLEDGE_API_URL,
        `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
        { method: "DELETE", timeoutMs: DELETE_TIMEOUT_MS },
      );
      // Prune the key from both live sets — the doc is gone, so an entry naming it
      // would linger forever (the sets are never garbage-collected against a listing).
      const pruneKeyFrom = async (
        snapKey: string,
        read: (deps: BacklogRouteDeps, watcherId: string) => Promise<Set<string>>,
      ): Promise<void> => {
        const current = await read(backlogDeps, target.watcher.id);
        if (current.delete(key)) {
          await backlogDeps.setSnapshot(target.watcher.id, snapKey, [...current]);
        }
      };
      await pruneKeyFrom(WIKI_GARDENER_OFFERED_KEY, readOffered);
      await pruneKeyFrom(WIKI_GARDENER_DISMISSED_KEY, readDismissed);
      // Same rule for the attempt ledger: the doc is gone, and a re-capture under the
      // same id must not inherit a months-old skip reason.
      await deleteSourceDraftAttempt(target.bot.name, collection, id);
      return res;
    });
    if (run === null) return c.json({ error: "a gardener run is in flight" }, 409);

    let res: Record<string, unknown>;
    try {
      res = (await run) as Record<string, unknown>;
    } catch (err) {
      // huginn 404 = the id isn't a member of that collection (its membership gate);
      // anything else is an upstream/transport failure. Never a muninn 5xx.
      const upstream = err instanceof KnowledgeApiError ? err.upstreamStatus : undefined;
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Backlog delete failed for {bot} ({key}): {error}", {
        bot: target.bot.name,
        key,
        error: message,
      });
      if (upstream === 404) return c.json({ error: "that doc is not in that collection" }, 404);
      return c.json({ error: `huginn refused the delete: ${message}` }, 502);
    }

    // Split huginn's `reindex` map into what we can poll and what we cannot: a
    // `skipped_already_running` collection's in-flight run started BEFORE the move,
    // so polling it would report a success that doesn't reflect this delete. Surface
    // it honestly instead (doc moved; reindex pending a later run / manual retry).
    const reindex = (res.reindex ?? {}) as Record<string, unknown>;
    const polling: string[] = [];
    const skipped: string[] = [];
    for (const [coll, state] of Object.entries(reindex)) {
      if (state === "started") polling.push(coll);
      else skipped.push(coll);
    }
    log.info("Backlog: deleted {key} for {bot} (reindex started: {polling}, skipped: {skipped})", {
      bot: target.bot.name,
      key,
      polling: polling.join(",") || "none",
      skipped: skipped.join(",") || "none",
    });
    return c.json({
      ok: true,
      collection,
      id,
      movedTo: typeof res.movedTo === "string" ? res.movedTo : null,
      polling,
      skipped,
    });
  });

  /**
   * Poll one collection's huginn reindex status after a delete. Proxies
   * `GET /api/collections/<c>/update-status`. When the status is TERMINAL
   * (`succeeded`/`failed`) it also drops the bot's cached backlog + any in-flight
   * compute ({@link invalidateIngestBacklogCache}) — the reindex is what actually
   * removes the doc from huginn's listing, so this is the exact moment the cached
   * payload becomes stale and the client's follow-up `refresh=1` can be trusted.
   * Never 5xx: an unreachable huginn reports `status: "unknown"` + an error so the
   * client's poll loop can give up instead of hanging on "removing…".
   */
  app.get("/api/wiki/gardener/backlog-doc-delete-status", async (c) => {
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);

    const collection = c.req.query("collection") ?? "";
    if (!SUMMARY_SOURCES.some((s) => s.collection === collection)) {
      return c.json({ error: `unknown summary collection "${collection}"` }, 400);
    }

    try {
      const data = await fetchKnowledgeApi(
        KNOWLEDGE_API_URL,
        `/api/collections/${encodeURIComponent(collection)}/update-status`,
      );
      const status = typeof data?.status === "string" ? data.status : "unknown";
      if (status === "succeeded" || status === "failed") {
        invalidateIngestBacklogCache(resolved.bot.name);
      }
      return c.json({
        collection,
        status,
        ...(typeof data?.error === "string" ? { error: data.error } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ collection, status: "unknown", error: message });
    }
  });

  // Run-now source drafter — draft a per-article `.mdx` source page for the NEWEST
  // doc in a summary collection (default youtube-summaries), on demand. Persists a
  // `wiki_proposals` row (kind `source`) that appears in this same gate. Awaits the
  // one traced model call (a deliberate manual action) and returns the outcome; a
  // covered/empty collection is a normal 200, a model/DB failure a 500.
  app.post("/api/wiki/gardener/source-draft-run", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot, root } = resolved;

    if (bot.gardener?.enabled === false) {
      return c.json({ error: "the wiki gardener is disabled for this bot" }, 400);
    }

    const collection = c.req.query("collection") ?? "youtube-summaries";
    if (!SUMMARY_SOURCES.some((s) => s.collection === collection)) {
      return c.json({ error: `unknown summary collection "${collection}"` }, 400);
    }

    // Prune seam — the fourth selection site (drain / source-drafter backlog / weekly
    // harvest are the other three). No seeded watcher ⇒ no snapshot ⇒ ∅.
    const rnWatcher = await backlogDeps.getWikiGardenerWatcher(bot.name);

    // Serialize under the same per-bot gardener mutex the drain routes use, so
    // concurrent source-draft clicks (or a click racing a backlog drain) can't
    // double-spend model calls. `runExclusive` is a try-lock: it returns null WITHOUT
    // starting when a run is already in flight — respond 409 with the same message as
    // `source-draft-backlog` (its batch sibling, whose guard this mirrors) rather than
    // queue behind a potentially long drain. Holding the mutex also makes the WEEKLY
    // `wiki-gardener` watcher skip its slot if it fires meanwhile (see
    // `src/watchers/wiki-gardener.ts`) — accepted by precedent: both batch siblings
    // have taken the same lock since they shipped, and a run-now is short.
    const run = runExclusive(bot.name, () =>
      runSourceDraftForNewest(bot, root, collection, KNOWLEDGE_API_URL, () =>
        rnWatcher ? readDismissed(backlogDeps, rnWatcher.id) : Promise.resolve(new Set<string>()),
      ),
    );
    if (run === null) return c.json({ error: "a gardener run is already in flight for this bot" }, 409);

    // The drafter turns its own failures into an `error` OUTCOME, but the seams around
    // it (`getDismissed`, the attempt ledger) do real DB I/O and can throw — same
    // try/catch → JSON 500 as both mutex siblings, so a caller reading `res.json()`
    // never lands on Hono's text/plain default handler.
    try {
      const outcome = await run;
      log.info("Source-draft run-now for {bot} ({collection}): {outcome}", {
        bot: bot.name,
        collection,
        outcome: outcome.outcome,
      });
      return c.json(outcome, outcome.outcome === "error" ? 500 : 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Source-draft run-now failed for {bot} ({collection}): {error}", {
        bot: bot.name,
        collection,
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // Backlog source drafter — draft per-article `.mdx` source pages for up to
  // `limit` UNCOVERED docs in a collection (default youtube-summaries), on an
  // explicit click. Sequential (each is a real model one-shot on the resolved wiki
  // bot), capped at SOURCE_BACKLOG_MAX_LIMIT, and skip-not-fail per doc so one bad
  // doc can't abort the batch. Drafts land in this same gate — nothing is
  // auto-approved. Awaits the whole batch (a deliberate manual action) and returns
  // per-doc outcomes + totals; a batch always returns 200 (a per-doc error is a
  // recorded outcome, not a route failure).
  app.post("/api/wiki/gardener/source-draft-backlog", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot, root } = resolved;

    if (bot.gardener?.enabled === false) {
      return c.json({ error: "the wiki gardener is disabled for this bot" }, 400);
    }

    const collection = c.req.query("collection") ?? "youtube-summaries";
    if (!SUMMARY_SOURCES.some((s) => s.collection === collection)) {
      return c.json({ error: `unknown summary collection "${collection}"` }, 400);
    }

    // `limit` clamps to [1, SOURCE_BACKLOG_MAX_LIMIT]; a missing/bad value ⇒ the
    // small default. Parse defensively — an unparseable query is a bad request.
    const rawLimit = c.req.query("limit");
    const parsedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (rawLimit !== undefined && !Number.isFinite(parsedLimit)) {
      return c.json({ error: `invalid limit "${rawLimit}"` }, 400);
    }
    const limit = clampSourceBacklogLimit(parsedLimit);

    // Serialize under the same per-bot gardener mutex the drain routes use, so
    // concurrent source-draft clicks (or a click racing a backlog drain) can't
    // double-spend model calls. `runExclusive` is a try-lock: it returns null WITHOUT
    // starting when a run is already in flight — respond 409 (same shape as the recover/dismiss
    // routes, different message — theirs is the backlog-row lock) rather than queue behind a potentially long drain.
    // Bind the prune seam onto the real deps so a dismissed doc is skipped here too
    // (dismissal must stop model spend on EVERY selection seam, not just the drain).
    // No seeded watcher ⇒ no snapshot to read ⇒ ∅ (today's behaviour).
    const sdWatcher = await backlogDeps.getWikiGardenerWatcher(bot.name);
    const sourceDeps = {
      ...defaultSourceBacklogDeps(bot, root, KNOWLEDGE_API_URL),
      getDismissed: () =>
        sdWatcher ? readDismissed(backlogDeps, sdWatcher.id) : Promise.resolve(new Set<string>()),
    };

    const run = runExclusive(bot.name, () =>
      runSourceDraftBacklog(bot, root, collection, limit, KNOWLEDGE_API_URL, sourceDeps),
    );
    if (run === null) return c.json({ error: "a gardener run is already in flight for this bot" }, 409);

    // Never-500 contract for the batch itself: per-doc failures are recorded
    // outcomes; only an unexpected orchestration throw (listing / sweep / coverage)
    // reaches here and degrades to a 500 with the message.
    try {
      const result = await run;
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Source-draft backlog failed for {bot} ({collection}): {error}", {
        bot: bot.name,
        collection,
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // Per-doc source drafter — the backlog row's "draft" / "rename & draft" retry.
  //
  // The batch routes above pick their own docs (newest / oldest-first over the whole
  // uncovered queue), which is the wrong tool for "this specific row didn't get a
  // page, run it again". `title` is the rename affordance: the drafter uses it
  // verbatim and, because a human chose it, forgoes the collision retry whose SKIP
  // branch is what dropped the doc in the first place.
  //
  // Same guards as its siblings: gardener-enabled, known collection, per-bot mutex
  // (409, never queue behind a drain). Always awaits the one-shot — a deliberate
  // single-doc action — and reports the outcome the ledger just recorded.
  app.post("/api/wiki/gardener/source-draft-doc", async (c) => {
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const resolved = resolveBacklogBot(c.req.query("wiki"), c.req.query("bot"));
    if ("error" in resolved) return backlogRefusal(c, resolved);
    const { bot, root } = resolved;

    if (bot.gardener?.enabled === false) {
      return c.json({ error: "the wiki gardener is disabled for this bot" }, 400);
    }

    let body: { collection?: unknown; id?: unknown; title?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const collection = typeof body.collection === "string" ? body.collection : "";
    const id = typeof body.id === "string" ? body.id : "";
    if (!collection || !id) return c.json({ error: "collection and id are required" }, 400);
    if (!SUMMARY_SOURCES.some((s) => s.collection === collection)) {
      return c.json({ error: `unknown summary collection "${collection}"` }, 400);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length > SOURCE_DRAFT_TITLE_MAX) {
      return c.json({ error: `title exceeds ${SOURCE_DRAFT_TITLE_MAX} characters` }, 400);
    }

    // Deliberately NO dismissed-set exclusion here (unlike all four selection seams):
    // this route drafts the doc the human just pointed at, and the row's own dismiss
    // button is right beside it. A dismissal suppresses AUTOMATIC selection, not an
    // explicit click.
    const deps = defaultSourceBacklogDeps(bot, root, KNOWLEDGE_API_URL, "doc");
    const run = runExclusive(bot.name, () =>
      draftOneBacklogDoc({ collection, id, url: "" }, deps, title || undefined),
    );
    if (run === null) {
      return c.json({ error: "a gardener run is already in flight for this bot" }, 409);
    }

    try {
      const result = await run;
      log.info("Source-draft one doc for {bot} ({collection}/{id}): {outcome}", {
        bot: bot.name,
        collection,
        id,
        outcome: result.outcome,
        ...(title ? { title } : {}),
      });
      // Same status contract as `source-draft-run` (its single-doc sibling): a failed
      // draft is a 500, so a caller reading `res.ok` can't record it as a success.
      // `covered`/`skipped` stay 200 — they are answers, not failures.
      return c.json(result, result.outcome === "error" ? 500 : 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Source-draft one doc failed for {bot} ({collection}/{id}): {error}", {
        bot: bot.name,
        collection,
        id,
        error: message,
      });
      return c.json({ error: message }, 500);
    }
  });

  // Approve → CAS draft→approved, run the apply step, flip to applied|stale|error.
  // A row already in `approved` is re-runnable (recovery for a crash between the
  // approve CAS and the terminal CAS — apply itself is re-run safe).
  app.post("/api/wiki/proposals/:id/approve", async (c) => {
    // Before the draft→approved CAS: a refusal must leave the row reviewable,
    // and the seam's own `forbidden` (mapped below) would arrive after the flip.
    const refused = readonlyRefusal(c);
    if (refused) return refused;
    const id = c.req.param("id");
    const existing = await backlogDeps.getProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    // …and the same refusal for the PER-WIKI guard, for the same reason and in
    // the same place. `applyWikiProposal` re-checks the root, but it is reached
    // only AFTER the draft→approved CAS below: measured, an approve on a
    // read-only wiki returned 403 with the row left in `approved`, where the
    // gate offers no verb at all (reject 409s "not reviewable"). The row was
    // stuck forever on a refusal that changed nothing.
    //
    // So the root lookup is hoisted out of the apply-target resolution further
    // down — the CHEAP half of it: a missing wiki/bot still falls through to
    // that block's own error handling (which flips the row to `error`, and must
    // therefore keep running after the claim).
    const targetRoot = existing.wikiName
      ? findWiki(getWikiRegistry(), existing.wikiName)?.root
      : getBots().find((b) => b.name === existing.botName)?.wikiDir;
    if (targetRoot && isReadonlyWikiRoot(targetRoot)) {
      log.info("Read-only wiki refused approve of proposal {id} (wiki={wiki})", {
        id,
        wiki: existing.wikiName ?? existing.botName,
      });
      return c.json({ error: wikiReadonlyRootReason(targetRoot), readonly: true }, 403);
    }

    // …and the stem-collision guard, in the same place and for the same reason.
    //
    // `applyWikiProposal`'s only create-mode guard is path-EXACT (`current !== null`
    // ⇒ "target path already exists"), so an approved entity/concept proposal landed
    // on a stem an existing source page already owned — measured 2026-08-29:
    // `sources/<Stem>.mdx` was drafted first, `entities/<Stem>.md` applied second,
    // and the store's same-stem precedence (`.md` > `.mdx`) then DROPPED the source
    // page from the index entirely. There is no model at apply time to rename with,
    // so the answer is a refusal the reviewer acts on, not a new terminal state:
    // deliberately NO new `ApplyOutcome` variant.
    //
    // Three scoping clauses, each load-bearing:
    //
    //  · **`draft` ONLY.** The gate renders Approve/Reject on `status === "draft"`
    //    and nothing else, so a 409 here on any other status is a refusal with no
    //    verb behind it: an `approved` crash-recovery row (whose whole purpose is
    //    to be re-runnable) would 409 forever, and a terminal `error`/`rejected`/
    //    `stale` row would be told about a collision instead of the truth, which is
    //    that it is not reviewable. Those two statuses fall through to the branch
    //    below that says exactly that. The `approved`-re-run residual — a twin that
    //    appeared inside the crash window — is covered by the re-check INSIDE
    //    `applyWikiProposal`'s write queue, which is also the TOCTOU close for two
    //    concurrent approves this pre-CAS guard cannot see.
    //  · **CREATE mode only.** In update mode the proposal's own page IS at the
    //    target and is the point of the write; a twin standing elsewhere is a
    //    pre-existing collision the write did not create.
    //  · **`refresh: true`.** This index is the whole guard, and the store's cache
    //    is a 5-minute TTL — measured, the exact historical incident reproduces
    //    with the guard installed if a page lands through a non-refreshing path
    //    while the cache is warm. An approve is human-paced and a build is cheap
    //    (measured warm 2026-08-30: jarvis 245 ms / 1,148 pages, mimir 129 ms / 477);
    //    every comparable write seam already refreshes (`page-write.ts`,
    //    `sync/run.ts`).
    if (existing.status === "draft" && existing.mode === "create") {
      if (!targetRoot) {
        // The row names a wiki/bot this process can't resolve. The apply block below
        // reports that properly (and flips the row to `error`); logged here because
        // otherwise the guard is silently skipped and nothing says so.
        log.warn(
          "Wiki-gardener approve: no wiki root for proposal {id} (wiki={wiki}) — stem-collision check skipped",
          { id, wiki: existing.wikiName ?? existing.botName },
        );
      } else {
        let index: WikiIndex | null = null;
        try {
          index = await getWikiIndex({ root: targetRoot, refresh: true });
          if (!index) {
            // Consistent with every other index-dependent step here (the apply's own
            // body-link containment skips on a null index): degrade, don't refuse.
            // Logged because a silently disabled guard is the failure this PR is about.
            log.warn(
              "Wiki-gardener approve: wiki index unavailable for {root} — stem-collision check skipped for proposal {id}",
              { root: targetRoot, id },
            );
          }
        } catch (err) {
          // `getWikiIndex` degrades a missing directory to null but does NOT catch a
          // `buildWikiIndex` throw, and this guard sits above the route's own
          // try/catch — so an unreadable wiki turned an approve into a Hono 500 with
          // the row still a draft and no explanation. Skip-with-warn, like the null.
          log.warn(
            "Wiki-gardener approve: wiki index build failed for {root} ({error}) — stem-collision check skipped for proposal {id}",
            { root: targetRoot, id, error: err instanceof Error ? err.message : String(err) },
          );
        }
        const stem = wikiPageStem(existing.targetPath);
        const blocking = index ? findStemTwin(index, stem, existing.targetPath) : null;
        if (blocking) {
          log.info(
            "Wiki-gardener approve refused for {id}: stem \"{stem}\" is already owned by {blocking}",
            { id, stem, blocking: blocking.relPath },
          );
          // The gate renders `data.error` verbatim, so the machine-readable part
          // rides beside it rather than in it (the `{error, readonly}` shape).
          // `collision: true` is the whole marker: the blocking page's path and
          // title were also shipped as fields and nothing read them — the same file
          // dropped `outcome: "forbidden"` for exactly that reason.
          return c.json({ error: stemCollisionMessage(blocking, stem), collision: true }, 409);
        }
      }
    }

    let claimed: WikiProposal | null = null;
    if (existing.status === "draft") {
      claimed = await backlogDeps.approveProposal(id);
      if (!claimed) {
        return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
      }
    } else if (existing.status === "approved") {
      claimed = existing;
      log.info("Wiki-gardener: re-running apply for stuck approved proposal {id}", { id });
    } else {
      return c.json({ error: "proposal is not reviewable", status: existing.status }, 409);
    }

    // Resolve the apply target. Wiki-keyed (consolidation) rows resolve their
    // root + reindex collections from the WIKI REGISTRY entry — the drafting bot's
    // `wikiDir` is a different wiki. Legacy bot-keyed rows keep the bot-config path.
    let deps: ApplyDeps;
    if (claimed.wikiName) {
      const wikiEntry = findWiki(getWikiRegistry(), claimed.wikiName);
      if (!wikiEntry) {
        await finishProposal(id, markWikiProposalError, "error");
        log.error("Wiki-gardener approve: wiki {wiki} is not registered — cannot apply proposal {id}", {
          wiki: claimed.wikiName,
          id,
        });
        return c.json({ outcome: "error", error: `wiki "${claimed.wikiName}" is not registered` }, 500);
      }
      // Standalone wikis carry no per-wiki commit config → commit defaults (push on
      // upstream); reindex over the entry's own collections (empty ⇒ no reindex,
      // NOT the jarvis wiki/wiki-life default).
      deps = applyDepsFor(wikiEntry.root, true, undefined, wikiEntry.collections ?? []);
    } else {
      const bot = getBots().find((b) => b.name === claimed.botName);
      if (!bot || !bot.wikiDir) {
        await finishProposal(id, markWikiProposalError, "error");
        log.error("Wiki-gardener approve: bot {bot} has no wikiDir — cannot apply proposal {id}", {
          bot: claimed.botName,
          id,
        });
        return c.json({ outcome: "error", error: "bot has no wikiDir configured" }, 500);
      }
      deps = applyDepsFor(bot.wikiDir, bot.wikiAutoCommit?.push ?? true, bot.wikiAutoCommit?.catalogKinds);
    }

    let result;
    try {
      result = await applyWikiProposal(claimed, deps);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await finishProposal(id, markWikiProposalError, "error");
      log.error("Wiki-gardener apply threw for {id}: {error}", { id, error: reason });
      return c.json({ outcome: "error", error: reason }, 500);
    }

    if (result.outcome === "applied") {
      if (!(await finishProposal(id, markWikiProposalApplied, "applied"))) {
        return c.json({ error: "proposal state changed during apply" }, 409);
      }
      log.info("Wiki-gardener applied proposal {id} → {path}", { id, path: result.writtenPath });
      return c.json({ outcome: "applied", writtenPath: result.writtenPath });
    }
    // Defense in depth behind the route guard above (which normally answers
    // first). A REFUSAL: the proposal keeps its `approved` status — which is
    // re-runnable by design — so the write-owning instance can apply it later.
    // Flipping it to `error` would burn a perfectly good draft on a policy answer.
    if (result.outcome === "forbidden") {
      // The seam does not say WHICH mechanism refused (instance flag or
      // read-only root) and neither should this line — it used to assert
      // "instance is wiki-readonly", which is false on the per-wiki path that
      // reaches here. `result.reason` is the seam's own sentence.
      log.warn("Wiki-gardener approve refused for {id}: {reason}", { id, reason: result.reason });
      // Same body as every other readonly refusal (`{error, readonly}`): a client
      // must be able to recognize the refusal by one shape, and the extra
      // `outcome: "forbidden"` here was a third spelling nothing read.
      return c.json({ error: result.reason, readonly: true }, 403);
    }
    // The in-queue stem-collision re-check (the TOCTOU the pre-CAS guard above
    // cannot see: it sits OUTSIDE the per-wiki write queue, and each gate card
    // only disables its OWN buttons, so two colliding proposals approved together
    // both pass it). A REFUSAL on policy, exactly like `forbidden` — nothing was
    // written — but with the opposite disposition on the ROW, and that difference
    // is the whole point of this branch:
    //
    //  · `forbidden` keeps `approved`, because the refusal is about the INSTANCE
    //    (this muninn may not write) and the write-owning instance re-runs the
    //    same approved row later.
    //  · a collision is about the WIKI, and every instance answers it the same
    //    way. Nobody re-runs it; a human renames one of the two pages. So the row
    //    goes back to `draft`, where the gate renders Approve/Reject and the
    //    reviewer has a verb again. Leaving it `approved` strands it (no verb at
    //    all); `markWikiProposalError` — what this did first — burns a perfectly
    //    good draft terminal on a policy answer, which is exactly the objection
    //    the route states above for the read-only refusal beside it.
    //
    // A LOST revert CAS (the row moved under us) is logged, not surfaced: the
    // answer to the caller is the collision either way, and nothing was written.
    if (result.outcome === "collision") {
      const reverted = await backlogDeps.revertProposal(id);
      if (!reverted) {
        log.error(
          "Wiki-gardener: approved→draft revert lost for proposal {id} — state changed during apply",
          { id },
        );
      }
      log.info("Wiki-gardener apply refused for {id} (collision), row returned to draft: {reason}", {
        id,
        reason: result.reason,
      });
      // Byte-identical to the pre-CAS guard's body — a reviewer hitting the two
      // paths seconds apart must not be able to tell them apart.
      return c.json({ error: result.reason, collision: true }, 409);
    }
    if (result.outcome === "stale") {
      if (!(await finishProposal(id, markWikiProposalStale, "stale"))) {
        return c.json({ error: "proposal state changed during apply" }, 409);
      }
      log.info("Wiki-gardener proposal {id} stale: {reason}", { id, reason: result.reason });
      return c.json({ outcome: "stale", reason: result.reason });
    }
    await finishProposal(id, markWikiProposalError, "error");
    log.error("Wiki-gardener apply error for {id}: {reason}", { id, reason: result.reason });
    return c.json({ outcome: "error", error: result.reason }, 500);
  });

  // Reject → CAS draft→rejected. Rejected topicKeys are skipped by the cluster filter.
  app.post("/api/wiki/proposals/:id/reject", async (c) => {
    const id = c.req.param("id");
    const existing = await getWikiProposalById(id);
    if (!existing) return c.json({ error: "proposal not found" }, 404);

    const rejected = await rejectWikiProposal(id);
    if (!rejected) {
      return c.json({ error: "proposal is no longer a draft", status: existing.status }, 409);
    }
    // The doc returns to the backlog uncovered, so THIS proposal's attempt row must
    // stop saying "drafted" — it would point at a gate entry the reject just removed.
    // Keyed on the proposal id, never on its `source_docs`: a concept proposal lists
    // every member doc, and a doc-keyed delete would blank the "why" line for members
    // whose own source draft is still live in the gate. Best-effort — a ledger
    // cleanup must never turn a successful reject into a failure.
    await deleteSourceDraftAttemptForProposal(id);
    return c.json({ outcome: "rejected" });
  });
}
