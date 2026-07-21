/**
 * Production wiring for the source-page drafter — binds `draftSourcePage`'s
 * injected seams to the real huginn / wiki-index / DB / one-shot implementations.
 *
 * Two entry points:
 *  - `runSourceDraftForNewest` — the RUN-NOW trigger: pick the newest doc in a
 *    collection (metadata-only listing → fetch its body + url), then draft it.
 *  - `triggerSourceDraftFromCapture` — the fire-and-forget AUTO trigger: draft
 *    the just-finished capture IN-PROCESS from the summary already in hand (no
 *    huginn re-fetch — ingest is best-effort and indexing may lag).
 */

import type { BotConfig } from "../bots/config.ts";
import type { ListedDoc, RawFetchedDoc } from "./types.ts";
import { fetchKnowledgeApi } from "../ai/knowledge-api-client.ts";
import { getWikiIndex } from "../wiki/store.ts";
import {
  collectWikiRefs,
  computeIngestBacklog,
  type ListedDoc as BacklogListedDoc,
  type QueuedDoc,
  type WikiRefs,
} from "../wiki/ingest-backlog.ts";
import {
  getLiveTopicKeys,
  getLiveSourceDocUrls,
  insertWikiProposal,
  DEFAULT_COVERAGE_DEPS,
  type CoverageDeps,
} from "../db/wiki-proposals.ts";
import { loadConfig } from "../config.ts";
import { docDateMs } from "./harvest.ts";
import { todayOslo } from "./util.ts";
import { DRAFT_TIMEOUT_MS } from "./backlog.ts";
import { runDrafterOneShot } from "./drafter-oneshot.ts";
import {
  draftSourcePage,
  type SourceDraftInput,
  type SourceDraftOutcome,
} from "./source-drafter.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "source-drafter");

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DOC_FETCH_TIMEOUT_MS = 15_000;

/**
 * Derive a huginn category from a collection-relative doc id (`<category>/<title>.md`,
 * e.g. `ai/rag/Foo.md` → `ai/rag`) — the SAME derivation the Summaries page uses
 * client-side (`docCategory`). Feeds `categoryToDomain` (via `SourceDraftInput.category`)
 * so run-now / backlog drafts file under the right domain. An unprefixed id (older
 * huginn / a fallback capture id) ⇒ "" ⇒ `categoryToDomain` defaults to `ai` (never
 * worse than the status quo).
 */
export function categoryFromDocId(docId: string): string {
  const parts = docId.split("/");
  return parts.length >= 2 ? parts.slice(0, -1).join("/") : "";
}

/** The first public http(s) URL among the candidates, or "" when none is public. */
function firstHttpUrl(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return "";
}

/**
 * Build the real-seam deps and run `draftSourcePage` for one input. `wikiDir` must
 * be the bot's resolved wiki root. Every seam is either injected or reads the env
 * knowledge API directly, so this path takes no `apiUrl` — the run-now entry point
 * does its own huginn fetches with one.
 */
export async function runSourceDraftForInput(
  botConfig: BotConfig,
  wikiDir: string,
  input: SourceDraftInput,
): Promise<SourceDraftOutcome> {
  const config = loadConfig();
  const index = await getWikiIndex({ root: wikiDir });
  return draftSourcePage({
    botName: botConfig.name,
    wikiDir,
    input,
    index,
    today: todayOslo(Date.now()),
    collectWikiRefs,
    liveTopicKeys: () => getLiveTopicKeys(botConfig.name),
    liveSourceDocUrls: () => getLiveSourceDocUrls(botConfig.name),
    insertProposal: (params) => insertWikiProposal(params),
    callDrafter: async (prompt, title) => {
      const res = await runDrafterOneShot({
        title,
        url: input.url,
        prompt,
        config,
        botConfig,
        timeoutMs: DRAFT_TIMEOUT_MS,
      });
      return res.result;
    },
  });
}

/**
 * RUN-NOW: draft the NEWEST doc in `collection`. Lists metadata only
 * (`?include_dates=1` → id/url/date, no title/content — the drafter synthesizes the
 * title), picks the newest by date, fetches its body + url via
 * `GET /api/document/<collection>/<id>`, then drafts it. Returns a "skipped" outcome
 * (never throws) when the collection is empty or the fetch yields no body/url.
 */
export async function runSourceDraftForNewest(
  botConfig: BotConfig,
  wikiDir: string,
  collection: string,
  apiUrl: string = DEFAULT_API_URL,
): Promise<SourceDraftOutcome> {
  let listed: ListedDoc[];
  try {
    const data = await fetchKnowledgeApi(
      apiUrl,
      `/api/collection/${encodeURIComponent(collection)}/documents?include_dates=1`,
    );
    listed = Array.isArray(data?.documents) ? (data.documents as ListedDoc[]) : [];
  } catch (err) {
    return { outcome: "error", reason: `listing ${collection} failed: ${errMsg(err)}` };
  }
  if (listed.length === 0) {
    return { outcome: "skipped", reason: `collection ${collection} is empty` };
  }

  // Newest-first by listing date (undated sorts last).
  const newest = [...listed].sort(
    (a, b) =>
      (docDateMs({ id: b.id, date: b.date }) ?? Number.NEGATIVE_INFINITY) -
      (docDateMs({ id: a.id, date: a.date }) ?? Number.NEGATIVE_INFINITY),
  )[0]!;

  let doc: RawFetchedDoc | null;
  try {
    doc = await fetchKnowledgeApi(
      apiUrl,
      `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(newest.id)}`,
      { timeoutMs: DOC_FETCH_TIMEOUT_MS },
    );
  } catch (err) {
    return { outcome: "error", reason: `fetching ${collection}/${newest.id} failed: ${errMsg(err)}` };
  }

  const body = (doc?.text ?? "").trim();
  const url = firstHttpUrl(doc?.metadata?.url, doc?.url, newest.url);
  if (!body) return { outcome: "skipped", reason: `doc ${collection}/${newest.id} has no body` };
  if (!url) return { outcome: "skipped", reason: `doc ${collection}/${newest.id} has no public URL` };

  log.info("Source drafter run-now: newest doc {collection}/{id}", { collection, id: newest.id });
  return runSourceDraftForInput(botConfig, wikiDir, {
    collection,
    docId: newest.id,
    url,
    body,
    category: categoryFromDocId(newest.id),
  });
}

// ── Backlog drafter (batched, on-demand over the UNCOVERED tail) ─────────────

/** Default number of source pages drafted per backlog-button click (kept small —
 *  each draft is a real model one-shot on the resolved wiki bot). */
export const SOURCE_BACKLOG_DEFAULT_LIMIT = 3;
/** Hard cap on a single backlog batch so one click can't hammer the summarizer. */
export const SOURCE_BACKLOG_MAX_LIMIT = 10;

/**
 * Clamp a caller-supplied `limit` into `[1, SOURCE_BACKLOG_MAX_LIMIT]`; a
 * missing / non-finite / sub-1 value falls back to {@link SOURCE_BACKLOG_DEFAULT_LIMIT}.
 */
export function clampSourceBacklogLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return SOURCE_BACKLOG_DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return SOURCE_BACKLOG_DEFAULT_LIMIT;
  return Math.min(n, SOURCE_BACKLOG_MAX_LIMIT);
}

/** Per-doc outcome in a backlog batch — mirrors {@link SourceDraftOutcome} flattened. */
export interface SourceBacklogDocResult {
  collection: string;
  docId: string;
  outcome: SourceDraftOutcome["outcome"];
  reason?: string;
  proposalId?: string;
  title?: string;
}

/** The whole batch's result: per-doc outcomes + rolled-up totals. */
export interface SourceBacklogResult {
  results: SourceBacklogDocResult[];
  totals: {
    /**
     * Docs VISITED this run (every outcome is reported). The batch scans past cheap
     * deterministic skips (`covered`/`skipped`) — only real model attempts
     * (`drafted`/`error`) are bounded by `limit` — so this can exceed `limit` when
     * the head of the queue is a run of skips.
     */
    selected: number;
    drafted: number;
    covered: number;
    skipped: number;
    error: number;
  };
  /** Total uncovered docs in the collection (the queue the batch drew from). */
  totalQueued: number;
  /** The resolved batch cap this run honored. */
  limit: number;
}

/**
 * Injected seams for {@link runSourceDraftBacklog} — every huginn/DB/model touch
 * is a seam so the batch selection + limit + skip-not-fail logic is unit-testable
 * with fakes (no real model calls). The default wiring is {@link defaultSourceBacklogDeps}.
 */
export interface SourceBacklogDeps {
  /** List a collection's docs (metadata: id/url/date) — the uncovered-partition input. */
  listDocs: (collection: string) => Promise<BacklogListedDoc[]>;
  /** Sweep the wiki for referenced URLs / id tokens (the credit side of the partition). */
  sweepWikiRefs: (root: string) => Promise<WikiRefs>;
  /** Consumed keys (`<collection>/<id>` of applied proposals) — credit rule. */
  getConsumed: CoverageDeps["getConsumed"];
  /** Pending keys (draft/approved proposals) — credit rule. */
  getPending: CoverageDeps["getPending"];
  /** Fetch a doc's body + url (`GET /api/document/<collection>/<id>`) for one draft. */
  fetchDoc: (collection: string, id: string) => Promise<RawFetchedDoc | null>;
  /** Draft ONE source page from a fully-formed input (the real model one-shot). */
  draftInput: (input: SourceDraftInput) => Promise<SourceDraftOutcome>;
}

/**
 * Real-seam wiring for the backlog batch: huginn listing + doc fetch, the wiki
 * sweep, the DB coverage sets, and the per-doc drafter (which runs the traced
 * one-shot through {@link runSourceDraftForInput}).
 */
export function defaultSourceBacklogDeps(
  botConfig: BotConfig,
  wikiDir: string,
  apiUrl: string = DEFAULT_API_URL,
): SourceBacklogDeps {
  return {
    listDocs: async (collection) => {
      const data = await fetchKnowledgeApi(
        apiUrl,
        `/api/collection/${encodeURIComponent(collection)}/documents?include_dates=1`,
      );
      const listed = Array.isArray(data?.documents) ? (data.documents as ListedDoc[]) : [];
      return listed.map((d) => ({
        collection,
        id: d.id,
        ...(d.url ? { url: d.url } : {}),
        ...(d.date ? { date: d.date } : {}),
      }));
    },
    sweepWikiRefs: collectWikiRefs,
    getConsumed: DEFAULT_COVERAGE_DEPS.getConsumed,
    getPending: DEFAULT_COVERAGE_DEPS.getPending,
    fetchDoc: (collection, id) =>
      fetchKnowledgeApi(
        apiUrl,
        `/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
        { timeoutMs: DOC_FETCH_TIMEOUT_MS },
      ),
    draftInput: (input) => runSourceDraftForInput(botConfig, wikiDir, input),
  };
}

/**
 * The FULL uncovered queue (listing order) plus its size. Pure: reuses the SAME
 * partition the ingest-backlog counter uses ({@link computeIngestBacklog}) —
 * consumed-wins / pending-wins / URL-referenced-wins / id-referenced-wins — so the
 * batch drains exactly the "queued" tail. Deliberately NOT capped here: the batch
 * loop ({@link runSourceDraftBacklog}) scans the whole queue in order and applies
 * the `limit` to real model attempts only, so cheap deterministic skips at the head
 * (no body/url, covered, stem collision) never strand the reachable tail. Selection
 * is listing order (newest-first is the drain's job, not this producer's — the
 * backlog tail is genuinely un-paged either way).
 */
export function selectSourceBacklogDocs(
  listedBySource: Record<string, BacklogListedDoc[]>,
  wikiRefs: WikiRefs,
  consumed: Set<string>,
  pending: Set<string>,
): { queued: QueuedDoc[]; totalQueued: number } {
  const backlog = computeIngestBacklog(listedBySource, wikiRefs, consumed, pending);
  const queued = backlog.byCollection.flatMap((c) => c.queuedDocs);
  return { queued, totalQueued: queued.length };
}

/**
 * BACKLOG batch: draft source pages for up to `limit` UNCOVERED docs in a
 * collection, sequentially (never parallel — each is a real model one-shot on the
 * resolved wiki bot). Drafts land in the same `/wiki/gardener` review gate; nothing
 * is auto-approved. Skip-not-fail: a per-doc fetch/draft failure is recorded as an
 * `error` outcome and the batch continues — one bad doc never aborts the run.
 *
 * `covered`/`skipped` outcomes come from {@link draftSourcePage} itself (its own
 * url-covered + live-proposal guards + shape gate) OR from {@link draftOneBacklogDoc}'s
 * cheap pre-fetch guards (no body / no public URL), so a doc that was credited
 * between selection and drafting is honestly reported rather than double-drafted.
 *
 * **Head-of-line fairness:** the loop scans the FULL queue in listing order and
 * counts only real MODEL attempts (`drafted`/`error`) toward `limit`. Cheap
 * deterministic skips (`skipped`/`covered`) don't consume the limit — the loop
 * continues deeper — so a run of poisoned docs at the head can't wedge the batch on
 * the same unreachable tail every click. Model calls stay bounded at `limit`; only
 * the (cheap HTTP) doc fetches for skip detection go past it. `totals.selected` is
 * the VISITED count, so it can exceed `limit` when the head is a run of skips.
 */
export async function runSourceDraftBacklog(
  botConfig: BotConfig,
  wikiDir: string,
  collection: string,
  limit: number,
  apiUrl: string = DEFAULT_API_URL,
  deps: SourceBacklogDeps = defaultSourceBacklogDeps(botConfig, wikiDir, apiUrl),
): Promise<SourceBacklogResult> {
  const cap = clampSourceBacklogLimit(limit);

  const [listed, wikiRefs, consumed, pending] = await Promise.all([
    deps.listDocs(collection),
    deps.sweepWikiRefs(wikiDir),
    deps.getConsumed(botConfig.name),
    deps.getPending(botConfig.name),
  ]);

  const { queued, totalQueued } = selectSourceBacklogDocs(
    { [collection]: listed },
    wikiRefs,
    consumed,
    pending,
  );

  // Scan the whole queue in order; only real model attempts (drafted/error) count
  // toward `cap`, so cheap skips at the head don't strand the reachable tail.
  const results: SourceBacklogDocResult[] = [];
  let modelAttempts = 0;
  for (const doc of queued) {
    if (modelAttempts >= cap) break;
    const result = await draftOneBacklogDoc(doc, deps);
    results.push(result);
    if (result.outcome === "drafted" || result.outcome === "error") modelAttempts++;
  }

  const totals = {
    selected: results.length,
    drafted: results.filter((r) => r.outcome === "drafted").length,
    covered: results.filter((r) => r.outcome === "covered").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    error: results.filter((r) => r.outcome === "error").length,
  };

  log.info(
    "Source-draft backlog for {bot} ({collection}): {drafted} drafted, {covered} covered, {skipped} skipped, {error} error of {selected} selected (queue {queue})",
    { bot: botConfig.name, collection, ...totals, queue: totalQueued },
  );

  return { results, totals, totalQueued, limit: cap };
}

/** Fetch one queued doc's body + url and draft it — never throws (skip-not-fail). */
async function draftOneBacklogDoc(
  doc: QueuedDoc,
  deps: SourceBacklogDeps,
): Promise<SourceBacklogDocResult> {
  const base = { collection: doc.collection, docId: doc.id };
  let fetched: RawFetchedDoc | null;
  try {
    fetched = await deps.fetchDoc(doc.collection, doc.id);
  } catch (err) {
    return { ...base, outcome: "error", reason: `fetch failed: ${errMsg(err)}` };
  }
  const body = (fetched?.text ?? "").trim();
  const url = firstHttpUrl(fetched?.metadata?.url, fetched?.url, doc.url);
  if (!body) return { ...base, outcome: "skipped", reason: "doc has no body" };
  if (!url) return { ...base, outcome: "skipped", reason: "doc has no public URL" };

  let outcome: SourceDraftOutcome;
  try {
    outcome = await deps.draftInput({
      collection: doc.collection,
      docId: doc.id,
      url,
      body,
      category: categoryFromDocId(doc.id),
    });
  } catch (err) {
    // draftSourcePage never throws, but runSourceDraftForInput's setup (config /
    // index load) could — contain it so one bad doc can't abort the batch.
    return { ...base, outcome: "error", reason: errMsg(err) };
  }
  return {
    ...base,
    outcome: outcome.outcome,
    ...("reason" in outcome ? { reason: outcome.reason } : {}),
    ...(outcome.outcome === "drafted"
      ? { proposalId: outcome.proposalId, title: outcome.title }
      : {}),
  };
}

/**
 * AUTO trigger: draft a source page for a just-finished capture, fire-and-forget.
 * The summary is handed in IN-PROCESS (no huginn re-fetch — best-effort ingest may
 * lag). Swallows every failure (logged) — a drafter hiccup must never fail the
 * capture job it rides behind. Skips silently when the bot has no `wikiDir`.
 */
export function triggerSourceDraftFromCapture(
  botConfig: BotConfig,
  input: SourceDraftInput,
): void {
  if (!botConfig.wikiDir) return;
  const wikiDir = botConfig.wikiDir;
  void runSourceDraftForInput(botConfig, wikiDir, input)
    .then((outcome) => {
      log.info("Source drafter auto-trigger for {collection}/{id}: {outcome}", {
        collection: input.collection,
        id: input.docId,
        outcome: outcome.outcome,
        ...("reason" in outcome ? { reason: outcome.reason } : {}),
      });
    })
    .catch((err) => {
      log.warn("Source drafter auto-trigger threw for {collection}/{id}: {error}", {
        collection: input.collection,
        id: input.docId,
        error: errMsg(err),
      });
    });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
