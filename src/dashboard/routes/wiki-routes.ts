import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, normalizeRelPath, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { projectAtlas } from "../../wiki/atlas.ts";
import { getSemanticOverlay } from "../../wiki/atlas-semantic.ts";
import {
  computeClusters,
  synthesisTopicKey,
  RAIL_MIN_MEMBERS,
  RAIL_BLOB_MAX,
  SEM_THRESHOLD_MIN,
  SEM_THRESHOLD_MAX,
  SEM_THRESHOLD_STEP,
  type SemanticOverlay,
} from "../views/components/wiki-atlas-semantic.ts";
import { getLiveOrAppliedTopicKeysByWiki } from "../../db/wiki-proposals.ts";
import { draftAndPersistSynthesis } from "../../gardener/synthesis-drafter.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import {
  listWikis,
  resolveWikiRequest,
  type WikiRegistryEntry,
} from "../../wiki/registry.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { enrichCitationsWithPages } from "../../wiki/citation-links.ts";
import {
  fetchSimilarPages,
  type SimilarPage,
  type SimilarSearchFn,
} from "../../wiki/similar.ts";
import {
  buildExplainAskOptions,
  buildExplainQuestion,
  htmlToText,
  EXPLAIN_HEADING_MAX,
  EXPLAIN_SELECTION_MAX,
} from "../../wiki/explain-context.ts";
import {
  buildFactcheckAppendix,
  buildFactcheckBlock,
  hasFactcheckBlock,
  FACTCHECK_ANSWER_MAX,
  FACTCHECK_SELECTION_MAX,
  FACTCHECK_HEADING_MAX,
} from "../../wiki/factcheck-context.ts";
import { appendBlockToPage, spliceSentinelBlock, withTrailingNewline } from "../../wiki/append-block.ts";
import { writeWikiPage } from "../../wiki/page-write.ts";
import {
  annotateEdits,
  annotatedMaxEdits,
  applyEdits,
  buildIntegratePrompt,
  changedCharsOfOutcomes,
  enforceChangeBudget,
  enforceEditBounds,
  hasSourcesSection,
  integrateBodyLen,
  maxChangedChars,
  neutralizeFactcheckSentinels,
  originalsOfOutcomes,
  parseEditList,
  promptMaskBody,
  countFactWrappers,
  stripFactWrappers,
  INTEGRATE_BODY_MAX,
  INTEGRATE_MAX_EDIT_CHARS,
  type DroppedEdit,
  type IntegrateEdit,
} from "../../wiki/integrate-edits.ts";
import { hasForbiddenBasename } from "../../gardener/draft.ts";
import { runIntegrateOneShot } from "../../wiki/integrate-oneshot.ts";
import {
  carriesFactWrapper,
  correctableClaims,
  parseFactcheckClaims,
  validateClaimQuotes,
} from "../views/components/wiki-integrate.ts";
import { commitWikiChange } from "../../wiki/commit.ts";
import { todayOslo } from "../../gardener/util.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import { streamFactcheckSSE } from "./factcheck-sse.ts";
import { createHash } from "node:crypto";
import { mergeWikiTypes } from "../views/components/wiki-filter.ts";
import { renderAskAnswerHtml } from "../../wiki/ask-render.ts";
import {
  generateWikiDigest,
  readLogMtimeMs,
  newestLogEntryDate,
  type WikiDigest,
} from "../../wiki/digest.ts";
import { discoverAllBots, resolveWikiSynthesisBot, type BotConfig } from "../../bots/config.ts";
import { chatState } from "../../chat/state.ts";
import { loadChatConfig } from "../../chat/chat-config.ts";
import { setPendingMessage } from "../../chat/pending-messages.ts";
import { createThread, findThreadByName } from "../../db/threads.ts";
import {
  buildAskChatSeed,
  deriveAskThreadTitle,
  uniqueAskThreadTitle,
  type AskChatCitation,
} from "../../wiki/ask-chat.ts";
import { buildSynthesisSystemPrompt } from "../../research/answer.ts";
import { streamResearchSSE } from "./research-sse.ts";
import { parseResearchHistory } from "../../research/history-param.ts";
import { countDraftWikiProposals } from "../../db/wiki-proposals.ts";
import { fetchKnowledgeApi, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { listCollections } from "../../summaries/list-collections.ts";
import {
  buildReindexResponse,
  buildReindexStatusResponse,
  type PostOutcome,
  type StatusOutcome,
} from "../../wiki/reindex.ts";
import {
  buildIndexCoverageResponse,
  type CollectionPatterns,
  type CoverageListing,
  type IndexCoverageResponse,
} from "../../wiki/index-coverage.ts";
import { EXPLAINER_BRIDGE_SCRIPT } from "../../wiki/explainer-bridge.ts";
import { wikiDirtyStat } from "../../wiki/commit.ts";
import { buildDistillPrompt, parseDistillResult, buildSavedNotesBlock } from "../../wiki/remember.ts";
import { callHaikuWithFallback } from "../../ai/haiku-direct.ts";
import { generateEmbedding } from "../../ai/embeddings.ts";
import { saveMemory, searchMemoriesHybrid } from "../../db/memories.ts";
import { getBotDefaultUser } from "../../db/chat-preferences.ts";
import { activityLog } from "../../observability/activity-log.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki");

/**
 * In-memory "what's new" digest cache, keyed by canonical wiki name. A digest is
 * reused while the wiki's `log.md` mtime is unchanged; `?refresh=1` bypasses it.
 * An in-process Map is deliberate: digests are cheap to regenerate, the dashboard
 * restarts rarely, and there's no existing persistent job-store the reader shares
 * — so a durable store would be over-engineering. A future scheduler that wants
 * warm digests across restarts can precompute via `generateWikiDigest` and store
 * the plain-markdown `WikiDigest` itself.
 */
const digestCache = new Map<string, WikiDigest>();

/**
 * Single-flight guard: concurrent generations for the same wiki (two tabs, or an
 * auto-load racing a manual refresh) share one connector call instead of each
 * spawning their own. A refresh joins any in-flight generation rather than
 * starting a second. Keyed by canonical wiki name; the entry is cleared when the
 * generation settles.
 */
const digestInFlight = new Map<string, Promise<WikiDigest | null>>();

/** Test-only: clear the digest cache (and in-flight guard) between cases. */
export function __resetWikiDigestCacheForTest(): void {
  digestCache.clear();
  digestInFlight.clear();
}

/** Test-only: seed the digest cache to exercise the cache-hit path. */
export function __seedWikiDigestForTest(name: string, digest: WikiDigest): void {
  digestCache.set(name, digest);
}

/**
 * Injectable Huginn searcher for the `/api/wiki/similar` + `/api/wiki/explain`
 * routes. Defaults to the real `fetchKnowledgeApi`; tests override it to exercise
 * the happy / self-exclusion / unresolved-drop / huginn-down branches without a
 * live Huginn. Shared by both routes via `fetchSimilarPages`.
 */
let similarSearchFn: SimilarSearchFn | null = null;

/** Test-only: override (or reset with `null`) the Huginn searcher used by the
 *  Similar + Explain routes. */
export function __setSimilarSearchForTest(fn: SimilarSearchFn | null): void {
  similarSearchFn = fn;
}

/**
 * Injectable seams for `POST /api/wiki/atlas/draft-synthesis` (the consolidation
 * gardener's Draft-synthesis button). Default to the real overlay/DB/drafter; tests
 * override them to drive candidacy confirmation + dedup without a live huginn/DB.
 */
export interface SynthesisDraftDeps {
  /** Fresh overlay fetch. Typed to the CLIENT overlay shape (`computeClusters`'s
   *  input) — the server overlay is structurally assignable to it, so the real
   *  `getSemanticOverlay` slots in while test fixtures stay concise. */
  getOverlay: (
    baseUrl: string,
    wikiName: string,
    index: WikiIndex,
    collections: string[],
    refresh: boolean,
  ) => Promise<SemanticOverlay | null>;
  /** Dedup source for the POST: live (draft/approved) AND applied topic keys, matching
   *  the GET's pending-mark (`getLiveOrAppliedTopicKeysByWiki`) so an APPLIED topic that
   *  hides the button also 409s a direct re-POST (applied-skip-is-primary dedup rule). */
  getLiveTopics: (wikiName: string) => Promise<string[]>;
  draft: typeof draftAndPersistSynthesis;
}
const defaultSynthesisDraftDeps: SynthesisDraftDeps = {
  getOverlay: getSemanticOverlay,
  getLiveTopics: getLiveOrAppliedTopicKeysByWiki,
  draft: draftAndPersistSynthesis,
};
let synthesisDraftDeps: SynthesisDraftDeps = defaultSynthesisDraftDeps;

/** Test-only: override (pass a partial) or reset (no arg) the synthesis-draft deps.
 *  A bare reset also clears the module-level in-flight set so a test that hangs a
 *  draft (to exercise the single-flight 409) can't leak an in-flight key into the
 *  next test. */
export function __setSynthesisDraftDepsForTest(over?: Partial<SynthesisDraftDeps>): void {
  synthesisDraftDeps = over ? { ...defaultSynthesisDraftDeps, ...over } : defaultSynthesisDraftDeps;
  if (!over) synthesisInFlight.clear();
}

/**
 * In-flight guard for the detached draft launch, keyed `<wiki>\0<topicKey>`. A
 * second POST for the same wiki+topic while one drafts gets a clean 409 instead of
 * double-spending a model call. Also test-resettable via `__setSynthesisDraftDepsForTest`.
 */
const synthesisInFlight = new Set<string>();
function inFlightKey(wiki: string, topicKey: string): string {
  return `${wiki}\u0000${topicKey}`;
}

/**
 * Server-side single-flight per wiki: is ANY synthesis draft currently in flight for
 * `wiki` (regardless of topic)? The v1 contract is one concurrent synthesis draft per
 * wiki — this hardens the narrow label-drift double-spend where a slider move shifts a
 * cluster label to a different `topicKey`, slipping past the per-topic guard above.
 */
function wikiHasInFlightDraft(wiki: string): boolean {
  const prefix = `${wiki}\u0000`;
  for (const k of synthesisInFlight) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * Server-side candidacy re-validation: does `members` (normalized relPaths) form a
 * synthesis CANDIDATE cluster at SOME threshold in the slider's range? Reuses the
 * exact client heuristic (`computeClusters`, which drops < RAIL_MIN_MEMBERS, marks
 * > RAIL_BLOB_MAX as non-candidate, and sets `candidate` from CLUSTER_ROLE_BY_TYPE),
 * so the server never trusts the client's badge — it recomputes from the fresh
 * overlay. Scans thresholds MAX→MIN; a candidate cluster whose member set exactly
 * equals `members` at any threshold confirms it.
 */
export function confirmSynthesisCandidate(overlay: SemanticOverlay, members: string[]): boolean {
  const wanted = [...members].sort();
  const eq = (a: string[]): boolean =>
    a.length === wanted.length && a.every((v, i) => v === wanted[i]);
  // Step MAX→MIN; round to 3 decimals to keep the float steps aligned with the slider.
  for (let t = SEM_THRESHOLD_MAX; t >= SEM_THRESHOLD_MIN - 1e-9; t -= SEM_THRESHOLD_STEP) {
    const threshold = Math.round(t * 1000) / 1000;
    for (const c of computeClusters(overlay, threshold)) {
      if (c.candidate && eq(c.members)) return true;
    }
  }
  return false;
}

/**
 * Pre-stream lookup budget shared by the Explain route's Similar fetch and the
 * Ask/Explain saved-notes lookup (PR C). Both run BEFORE `streamResearchSSE`'s
 * heartbeat exists, so a slow-but-alive Huginn / DB must not stall the stream
 * open — each is raced against this timer and degrades to its empty fallback.
 */
export const PRESTREAM_TIMEOUT_MS = 3000;

/** Race a never-rejecting promise against a timer (default {@link PRESTREAM_TIMEOUT_MS}),
 *  resolving to `fallback` if the timer wins. The caller MUST pass a promise that
 *  never rejects (both current callers do — `fetchSimilarPages` and
 *  `fetchSavedNotesBlock` each catch internally) so a late real settle after the
 *  timer can't throw. The `ms` override exists for tests (a short hang bound). */
export function raceTimeout<T>(p: Promise<T>, fallback: T, ms = PRESTREAM_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Injectable seams for `POST /api/wiki/ask/chat` (the Ask tab's "Continue in
 * chat →" escalation). The route otherwise needs a live DB (users + threads) and
 * the in-memory chat state, so every side-effecting call goes through here and
 * tests drive user resolution / 409+forceNew / seeding with fakes.
 */
export interface AskChatDeps {
  discoverBots: () => BotConfig[];
  loadChatConfig: (botName?: string) => Promise<{ users: { id: string; name: string }[] } | null>;
  /** The bot's `bot_default_user` mapping — the same "whose bot is this?" answer
   *  the sibling Remember button attributes memories to. Resolves the common
   *  multi-user case without a picker the reader doesn't have. */
  getBotDefaultUser: (botName: string) => Promise<string | null>;
  findThreadByName: (
    userId: string,
    botName: string,
    name: string,
  ) => Promise<{ id: string; name: string } | null>;
  createThread: (
    userId: string,
    botName: string,
    name: string,
    description?: string,
  ) => Promise<{ id: string }>;
  setPendingMessage: (threadId: string, text: string, meta?: { title?: string }) => void;
  getConversations: () => { id: string; userId: string; botName: string; type: string }[];
  createConversation: (params: {
    type: "web";
    botName: string;
    userId: string;
    username: string;
  }) => { id: string };
}
const defaultAskChatDeps: AskChatDeps = {
  discoverBots: discoverAllBots,
  loadChatConfig,
  getBotDefaultUser,
  findThreadByName,
  createThread,
  setPendingMessage,
  getConversations: () => chatState.getConversations(),
  createConversation: (params) => chatState.createConversation(params),
};
let askChatDeps: AskChatDeps = defaultAskChatDeps;

/** Test-only: override (pass a partial) or reset (no arg) the ask→chat deps. */
export function __setAskChatDepsForTest(over?: Partial<AskChatDeps>): void {
  askChatDeps = over ? { ...defaultAskChatDeps, ...over } : defaultAskChatDeps;
}

/** Injectable deps for {@link fetchSavedNotes} — the DB/embedding fns are passed
 *  in so the helper unit-tests with hanging/throwing fakes (the route passes the
 *  real imports). */
export interface SavedNotesDeps {
  botName: string;
  question: string;
  getBotDefaultUser: (botName: string) => Promise<string | null>;
  generateEmbedding: (text: string) => Promise<number[] | null>;
  searchMemoriesHybrid: (
    userId: string,
    query: string,
    embedding: number[] | null,
    limit: number,
    botName?: string,
    tags?: string[],
  ) => Promise<{ content: string }[]>;
}

/**
 * The reader's saved wiki notes for an Ask/Explain question: resolve the wiki's
 * synthesis bot's `bot_default_user`, embed the question, and run a `wiki-note`-
 * tag-scoped hybrid memory search (cap 5). NEVER rejects — any failure ⇒ `[]`.
 *
 * Null-embedding guard (load-bearing): bail to `[]` when `generateEmbedding`
 * returns null. `searchMemoriesHybrid` falls back to an UNFILTERED FTS search on a
 * null embedding (it has no tags param), which would inject general chat memories
 * under the saved-notes label — so no notes beat mislabeled notes. No mapping for
 * the bot ⇒ `[]` (injection skipped silently, same as Remember's owner rule).
 */
export async function fetchSavedNotes(deps: SavedNotesDeps): Promise<{ content: string }[]> {
  try {
    const userId = await deps.getBotDefaultUser(deps.botName);
    if (!userId) return [];
    const embedding = await deps.generateEmbedding(deps.question);
    if (!embedding) return []; // null-embedding guard — no notes beat mislabeled notes
    return await deps.searchMemoriesHybrid(userId, deps.question, embedding, 5, deps.botName, [
      "wiki-note",
    ]);
  } catch {
    return [];
  }
}

/** {@link fetchSavedNotes} → {@link buildSavedNotesBlock}. Never rejects (the
 *  fetch catches; the builder is pure). null when there are no saved notes. */
export async function fetchSavedNotesBlock(deps: SavedNotesDeps): Promise<string | null> {
  return buildSavedNotesBlock(await fetchSavedNotes(deps));
}

/**
 * Cache decision for `/api/wiki/digest`: reuse a cached digest only when it's
 * present, the caller didn't ask for a refresh, and its `logMtimeMs` still
 * matches the wiki's current `log.md` mtime. Pure so the mtime-match / refresh-
 * bypass rules are unit-testable without a connector run.
 */
export function digestCacheDecision(
  cached: WikiDigest | undefined,
  logMtimeMs: number,
  refresh: boolean,
): "hit" | "regenerate" {
  if (refresh) return "regenerate";
  if (cached && cached.logMtimeMs === logMtimeMs) return "hit";
  return "regenerate";
}

/**
 * The `/api/wiki/explain` preflight decision chain, extracted as a pure function
 * so the "does an explainer page preflight out?" behavior is unit-testable (a
 * status-only route assertion can't prove it — both the old and new paths return
 * 200 and reading the body drives the unreachable synthesis path). Mirrors the
 * staged Ask/Similar checks: unknown wiki → no collections → unloadable index →
 * unknown page. Explainer pages are NOT a preflight error — they are excerpted via
 * `htmlToText` like markdown. The route resolves `index`/`meta` ONLY on the happy
 * path (unknown wiki / no collections short-circuit before any filesystem touch),
 * so a null `index`/`undefined` meta from an earlier short-circuit is never
 * reached by the later branches. A missing/unreadable file is NOT a preflight
 * error either — it degrades via `readWikiPage ?? ""` exactly like the md branch.
 */
export function resolveExplainPreflight(input: {
  wiki: string;
  unknownWiki: boolean;
  entry: WikiRegistryEntry | undefined;
  index: WikiIndex | null;
  meta: WikiPageMeta | undefined;
  page: string;
}): string | null {
  const { wiki, unknownWiki, entry, index, meta, page } = input;
  if (unknownWiki || !entry) return `No wiki configured for "${wiki || "(none)"}".`;
  if ((entry.collections ?? []).length === 0) return "No search collection connected for this wiki.";
  if (!index) return "wiki directory not found";
  if (!meta) return `No wiki page named "${page}".`;
  return null;
}

/**
 * Should a fact-checked page carry INLINE `<Fact>`/`<FactCheck>` annotations?
 *
 * This is a **policy** predicate, not a capability one. `renderWikiHtml` is
 * extension-agnostic, so a `.md` page would render the component pair in the
 * reader just fine — but a `.md` page is also read as raw markdown outside the
 * reader (GitHub, an editor), where the JSX-ish tags would show as literal text.
 * So `.md` pages deliberately keep the `> [!factcheck]` blockquote form and get
 * NO inline wrappers; native `.mdx` pages are reader-rendered by convention and
 * are the only annotated form.
 *
 * The `type !== "explainer"` term is belt-and-braces: a real explainer is `.html`
 * on disk and can never satisfy the extension test. It stays so a future
 * type/extension mismatch can't quietly opt an explainer in.
 */
export function isAnnotatablePage(relPath: string, type: string): boolean {
  return type !== "explainer" && relPath.endsWith(".mdx");
}

/** Listing shape sent to the client — meta plus connection counts for sorting. */
interface WikiPageListing extends WikiPageMeta {
  linkCount: number;
  backlinkCount: number;
}

function toListing(index: WikiIndex, meta: WikiPageMeta): WikiPageListing {
  // `desc` + `pubDate` are Atlas-only fields (only `GET /api/wiki/atlas` reads
  // them); excluded here so they don't bloat this hot pages-listing payload
  // (~100 KB on jarvis). The listing type keeps them optional/undefined.
  // Nothing else may join this strip list without checking BOTH callers first:
  // `/api/wiki/page` builds its single-page `meta` from this same function, so a
  // field stripped for payload size (e.g. `status_note`) goes out of reach of the
  // reader too. `desc`/`pubDate` are safe only because Atlas alone reads them.
  const { desc, pubDate, ...rest } = meta;
  void desc;
  void pubDate;
  return {
    ...rest,
    linkCount: index.outgoing.get(normalizeRelPath(meta.relPath))?.length ?? 0,
    backlinkCount: index.backlinks.get(normalizeRelPath(meta.relPath))?.length ?? 0,
  };
}

/**
 * Freshness date (`YYYY-MM-DD`) per wiki, for the picker labels. Derived from the
 * newest `## [date]` header in `log.md` (a bounded read) so it matches the dates
 * the digest shows and doesn't drift a day near midnight the way the file's mtime
 * (a wall-clock instant rendered in UTC) does. Falls back to `log.md`'s mtime
 * date when no header parses, then to the newest page date from the (TTL-cached)
 * index when there's no `log.md` at all. Wikis with none are omitted (no date).
 */
async function computeWikiFreshness(
  registry: WikiRegistryEntry[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    registry.map(async (entry) => {
      const headerDate = await newestLogEntryDate(entry.root);
      if (headerDate) {
        out[entry.name] = headerDate;
        return;
      }
      // Log exists but no parseable header — fall back to its mtime date.
      const mtime = await readLogMtimeMs(entry.root);
      if (mtime !== null) {
        out[entry.name] = new Date(mtime).toISOString().slice(0, 10);
        return;
      }
      // No log.md — fall back to the newest page date from the index. Wikis with
      // no frontmatter at all (mimir) only have mtime, so consider both.
      const index = await getWikiIndex({ root: entry.root });
      if (!index) return;
      let newest = "";
      for (const p of index.pages) {
        const mtimeDate = p.mtimeMs ? new Date(p.mtimeMs).toISOString().slice(0, 10) : "";
        const d = p.updated || p.created || "";
        const best = d > mtimeDate ? d : mtimeDate;
        if (best > newest) newest = best;
      }
      if (newest) out[entry.name] = newest;
    }),
  );
  return out;
}

/**
 * Fetch each collection's reader include/exclude regex patterns from huginn's
 * `GET /api/collections`, keyed by collection name. Degrade-tolerant and
 * best-effort: an unreachable huginn, or an OLDER huginn whose response lacks the
 * pattern fields, yields an empty map — the coverage pure layer then skips the
 * excludedByRule partition and meta pages stay in `missing` (documented degrade).
 * Only entries carrying BOTH pattern arrays are kept (no hardcoded pattern copies
 * live in muninn — the denylist is sourced entirely from huginn's manifests).
 */
async function fetchCollectionPatterns(
  knowledgeApiUrl: string,
): Promise<Map<string, CollectionPatterns>> {
  const out = new Map<string, CollectionPatterns>();
  try {
    const data = await fetchKnowledgeApi(knowledgeApiUrl, "/api/collections", { timeoutMs: 10_000 });
    const collections = (data?.collections ?? []) as Record<string, unknown>[];
    for (const c of collections) {
      const name = c?.name;
      const inc = c?.includePatterns;
      const exc = c?.excludePatterns;
      if (typeof name === "string" && Array.isArray(inc) && Array.isArray(exc)) {
        out.set(name, {
          includePatterns: inc.filter((p): p is string => typeof p === "string"),
          excludePatterns: exc.filter((p): p is string => typeof p === "string"),
        });
      }
    }
  } catch (err) {
    log.warn("Index-coverage: /api/collections patterns fetch failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

/**
 * POST huginn's `/api/collections/<c>/update` for one collection, normalizing the
 * outcome for the pure reindex assembler. huginn's CAS 409 (a rebuild — nightly
 * job or a prior trigger — already in flight) maps to `conflict` (⇒ the honest
 * `already-running` state), not an error. An unreachable huginn / any other status
 * maps to `error`. Never throws.
 */
async function postCollectionUpdate(
  knowledgeApiUrl: string,
  collection: string,
): Promise<PostOutcome> {
  try {
    await fetchKnowledgeApi(
      knowledgeApiUrl,
      `/api/collections/${encodeURIComponent(collection)}/update`,
      { method: "POST", timeoutMs: 10_000 },
    );
    return { kind: "ok" };
  } catch (err) {
    if (err instanceof KnowledgeApiError && err.upstreamStatus === 409) {
      return { kind: "conflict" };
    }
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GET huginn's `/api/collections/<c>/update-status` for one collection, normalizing
 * the outcome for the pure status assembler. An unexpected/absent status value or a
 * failed fetch maps to `error` (⇒ the client-facing `unknown` state). Never throws.
 */
async function getCollectionUpdateStatus(
  knowledgeApiUrl: string,
  collection: string,
): Promise<StatusOutcome> {
  try {
    const data = await fetchKnowledgeApi(
      knowledgeApiUrl,
      `/api/collections/${encodeURIComponent(collection)}/update-status`,
      { timeoutMs: 10_000 },
    );
    const status = data?.status;
    if (status === "idle" || status === "running" || status === "succeeded" || status === "failed") {
      return {
        kind: "ok",
        status,
        error: typeof data?.error === "string" ? data.error : undefined,
      };
    }
    return { kind: "error", error: `unexpected status: ${String(status)}` };
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Dashboard /wiki reader: a named knowledge wiki as a browsable site.
 *  `?wiki=<name>` selects which wiki (bot wikis + `WIKI_EXTRA` standalone wikis);
 *  `?bot=<name>` is a legacy alias. A bare `/wiki` renders the default wiki
 *  (jarvis if registered, else the first) — unless `WIKI_DIR` is set, which
 *  stays an explicit legacy override with no wiki claimed in the picker. */
export function registerWikiRoutes(app: Hono, config: Config): void {
  app.get("/wiki", async (c) => {
    const registry = getWikiRegistry();
    const wikis = listWikis(registry);
    const { wiki: selected, envOverride, entry, unknownWiki } = resolveWikiRequest(
      registry,
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    // The gardener is a bot feature — only bot-source wikis carry proposals.
    const isBotWiki = entry?.source === "bot";
    // Pending-draft count for the selected bot wiki — drives the "Gardener"
    // header badge. Best-effort: a DB hiccup must not take the reader down.
    let gardenerPending = 0;
    if (selected && isBotWiki) {
      try {
        gardenerPending = await countDraftWikiProposals(selected);
      } catch (err) {
        log.warn("Wiki: draft-proposal count failed for {wiki}: {error}", {
          wiki: selected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Resolved synthesis bot for the Ask tab's "Answered by …" line — same
    // owner-routing the ask/digest handlers use, computed at render time so
    // the tab can say who will answer before a question is asked.
    let askBot: { bot: string; connector: string; model: string; origin: "pinned" | "owner" | "fallback" } | null = null;
    if (entry) {
      const { bot, origin } = resolveWikiSynthesisBot(entry, discoverAllBots());
      if (bot) {
        askBot = {
          bot: bot.name,
          connector: bot.connector ?? "claude-cli",
          model: bot.model ?? (process.env.CLAUDE_MODEL || "sonnet"),
          origin,
        };
      }
    }
    // Per-wiki freshness dates for the picker labels (best-effort — a failure
    // just omits dates, never blocks the reader).
    let wikiDates: Record<string, string> = {};
    try {
      wikiDates = await computeWikiFreshness(registry);
    } catch (err) {
      log.warn("Wiki: freshness computation failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return c.html(
      await renderWikiPage({
        wikis,
        wikiDates,
        selected,
        envOverride,
        unknownWiki,
        gardenerPending,
        gardener: isBotWiki,
        askBot,
      }),
    );
  });

  // Full page listing — the client filters/sorts locally (712 pages ≈ trivial).
  //
  // `no-store` is a correctness header, not a tuning knob. This listing is the ONLY
  // source of the reader's page set, the client loads it exactly once at boot and
  // never refetches, and the response carried no `Cache-Control` at all — which lets
  // a browser heuristically cache it (RFC 9111 §4.2.2, permitted precisely when no
  // freshness information is given). The visible failure is "I wrote a new page and
  // the reader can't find it, even with the filters cleared, even after a reload":
  // the search box filters an array that was stale before it was rendered, and a
  // plain reload can replay the cached JSON rather than re-asking. A wiki gains
  // pages constantly here — the gardener writes them, so does the user — so a
  // listing that is allowed to go stale is a listing that will.
  app.get("/api/wiki/pages", async (c) => {
    c.header("Cache-Control", "no-store");
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) {
      return c.json({ pages: [], scannedAt: null, error: "no wiki configured for that name" });
    }
    const root = entry?.root;
    const index = await getWikiIndex({ root, refresh: c.req.query("refresh") === "1" });
    if (!index) {
      return c.json({ pages: [], scannedAt: null, error: "wiki directory not found" });
    }
    return c.json({
      pages: index.pages.map((m) => toListing(index, m)),
      scannedAt: index.scannedAt,
      // The wiki's ordered type list + labels (built-in defaults merged with its
      // `.wiki-reader.json` customs). The client stores this and renders every
      // type-keyed site off it, so a custom-typed page is never dropped/miscolored.
      types: mergeWikiTypes(
        index.readerConfig,
        index.pages.map((p) => p.type),
      ),
    });
  });

  // Atlas tab data: the hybrid Types/Months graph view + curated trails. A PURE
  // projection (`projectAtlas`) over the TTL-cached index — no per-request reads of
  // wiki page files, so a repeat request within the TTL touches no disk. Same
  // registry resolution + `?bot=` alias as the other wiki routes; works for ANY
  // registered wiki. Unknown/absent wiki or a missing dir returns an empty payload
  // (all seven keys present) rather than 5xx.
  app.get("/api/wiki/atlas", async (c) => {
    const emptyAtlas = (error?: string) =>
      c.json({
        types: [],
        nodes: {},
        monthKeys: [],
        months: {},
        topics: [],
        trails: [],
        omitted: { byType: {}, byMonth: {} },
        ...(error ? { error } : {}),
      });
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return emptyAtlas("no wiki configured for that name");
    const refresh = c.req.query("refresh") === "1";
    const index = await getWikiIndex({ root: entry?.root, refresh });
    if (!index) return emptyAtlas("wiki directory not found");
    const payload = projectAtlas(index);

    // Semantic overlay: opt-in via `?semantic=1`, and only when the wiki has
    // backing collections. Absent flag ⇒ byte-identical to the pre-PR behavior.
    // Degrade (huginn unreachable / no collections / nothing resolved) leaves the
    // field absent — the rest of the payload is untouched, always HTTP 200.
    const collections = entry?.collections ?? [];
    if (c.req.query("semantic") === "1" && collections.length > 0) {
      const overlay = await getSemanticOverlay(
        config.knowledgeApiUrl,
        entry!.name,
        index,
        collections,
        refresh,
      );
      if (overlay) {
        // Attach the consolidation-gardener pending-proposal topic_keys OUTSIDE the
        // cached overlay object (a fresh DB read per request — pending state must
        // not go 5-min stale like the cached similarity graph). Spread so the
        // cached overlay is never mutated. Degrade-tolerant: a DB hiccup drops the
        // marks (button just renders instead of the gate link), never 5xxs.
        let pendingSynthesisTopics: string[] = [];
        try {
          pendingSynthesisTopics = await getLiveOrAppliedTopicKeysByWiki(entry!.name);
        } catch (err) {
          log.warn("Atlas pending-synthesis topics lookup failed for {wiki}: {error}", {
            wiki: entry!.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return c.json({ ...payload, semantic: { ...overlay, pendingSynthesisTopics } });
      }
    }
    return c.json(payload);
  });

  // Draft-synthesis (consolidation gardener): turn a badged Atlas-rail synthesis
  // candidate into ONE `synthesis` proposal in the /wiki/gardener gate for a
  // standalone wiki (mimir). Plain JSON route — the server NEVER trusts the client's
  // badge: it resolves the members in the wiki index, rebuilds a FRESH semantic
  // overlay, and re-runs `computeClusters` to confirm the members form a candidate
  // at some threshold. Dedup (live topic_key) → 409; a second in-flight draft for
  // the same wiki+topic → 409; the draft itself runs DETACHED (respond
  // `{state:"started"}` immediately, /agents visibility via the traced one-shot).
  // Never 5xx on an expected failure; the whole body is wrapped so an unexpected
  // throw returns 500 JSON (mirrors POST /api/wiki/remember).
  app.post("/api/wiki/atlas/draft-synthesis", async (c) => {
    try {
      type Body = { wiki?: string; members?: unknown; label?: unknown };
      const body = await c.req.json<Body>().catch(() => ({}) as Body);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      const members =
        Array.isArray(body.members) && body.members.every((m) => typeof m === "string")
          ? (body.members as string[])
          : null;
      if (!label) return c.json({ error: "label is required" }, 400);
      if (!members || members.length === 0) {
        return c.json({ error: "members[] is required" }, 400);
      }
      // Cheap upper guard BEFORE any index/huginn work — reject an oversized payload
      // (the blob guard) without 40+ index lookups. Re-checked post-resolve below.
      if (members.length > RAIL_BLOB_MAX) {
        return c.json({ error: `cluster too large (> ${RAIL_BLOB_MAX} pages)` }, 400);
      }

      const { entry, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki") ?? body.wiki,
        c.req.query("bot"),
        process.env.WIKI_DIR,
      );
      if (unknownWiki || !entry) {
        return c.json({ error: "no wiki configured for that name" }, 404);
      }
      const collections = entry.collections ?? [];
      if (collections.length === 0) {
        return c.json({ error: "No search collection connected for this wiki" }, 400);
      }

      const index = await getWikiIndex({ root: entry.root });
      if (!index) return c.json({ error: "wiki directory not found" }, 404);

      // Members must resolve in the wiki index; normalize to emitKey form so the
      // candidacy recompute (overlay keys) and dedup agree.
      const normMembers: string[] = [];
      for (const m of members) {
        const page = index.resolveRelPath(m);
        if (!page) return c.json({ error: `member "${m}" is not a page in this wiki` }, 400);
        normMembers.push(normalizeRelPath(page.relPath));
      }
      if (normMembers.length < RAIL_MIN_MEMBERS) {
        return c.json({ error: `a synthesis cluster needs ≥ ${RAIL_MIN_MEMBERS} members` }, 400);
      }
      if (normMembers.length > RAIL_BLOB_MAX) {
        return c.json({ error: `cluster too large (> ${RAIL_BLOB_MAX} pages)` }, 400);
      }

      // Fresh overlay + candidacy re-check — never trust the client's badge.
      const overlay = await synthesisDraftDeps.getOverlay(
        config.knowledgeApiUrl,
        entry.name,
        index,
        collections,
        true,
      );
      if (!overlay) {
        return c.json({ error: "semantic overlay unavailable — cannot confirm candidacy" }, 400);
      }
      if (!confirmSynthesisCandidate(overlay, normMembers)) {
        return c.json({ error: "these pages do not form a synthesis candidate" }, 400);
      }

      const topicKey = synthesisTopicKey(label);

      // Dedup: a live (draft/approved) OR applied proposal for this topic already
      // exists — matches the GET's pending-mark, so an applied topic 409s a re-POST.
      const live = await synthesisDraftDeps.getLiveTopics(entry.name);
      if (live.includes(topicKey)) {
        return c.json({ state: "pending", topicKey }, 409);
      }

      const key = inFlightKey(entry.name, topicKey);
      if (synthesisInFlight.has(key)) {
        return c.json({ state: "running", topicKey }, 409);
      }
      // Server-side single-flight per wiki: one concurrent synthesis draft per wiki
      // (v1 contract). Catches the label-drift double-spend where a slider move maps
      // to a different topicKey that slips past the per-topic guard above.
      if (wikiHasInFlightDraft(entry.name)) {
        return c.json({ state: "running", topicKey }, 409);
      }

      // Attribution bot — resolved like Ask/digest/remember. Guard before drafting.
      const { bot } = resolveWikiSynthesisBot(entry, discoverAllBots());
      if (!bot) return c.json({ error: "No synthesis bot for this wiki" }, 409);

      // Launch DETACHED — respond immediately; /agents shows the run via the traced
      // one-shot. The in-flight guard is cleared on settle (success OR failure).
      synthesisInFlight.add(key);
      void synthesisDraftDeps
        .draft({ wiki: entry, members: normMembers, label, index, config, botConfig: bot })
        .then((res) => {
          if (!res.ok) {
            log.warn("Synthesis draft for wiki={wiki} topic={topic} rejected: {reason}", {
              wiki: entry.name,
              topic: topicKey,
              reason: res.reason,
            });
          }
        })
        .catch((err) => {
          log.error("Synthesis draft for wiki={wiki} topic={topic} threw: {error}", {
            wiki: entry.name,
            topic: topicKey,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => synthesisInFlight.delete(key));

      return c.json({ state: "started", topicKey });
    } catch (err) {
      log.error("Draft-synthesis: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });

  // "What's new" digest — an AI summary of the wiki's recent `log.md` entries
  // for the reader's start view. Cached per wiki while `log.md`'s mtime is
  // unchanged; `?refresh=1` regenerates unconditionally. A wiki without a
  // `log.md` (or an unknown/absent wiki) returns `{ digest: null }` so the card
  // simply stays hidden. The stored digest carries plain-markdown `bullets`; we
  // render them to reader HTML here (page mentions → in-reader links) so the
  // persistable form stays render-agnostic.
  app.get("/api/wiki/digest", async (c) => {
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) return c.json({ digest: null });

    const logMtimeMs = await readLogMtimeMs(entry.root);
    if (logMtimeMs === null) return c.json({ digest: null });

    const refresh = c.req.query("refresh") === "1";
    const cached = digestCache.get(entry.name);
    const index = await getWikiIndex({ root: entry.root });
    if (!index) return c.json({ digest: null });

    let digest: WikiDigest | null = cached ?? null;
    if (digestCacheDecision(cached, logMtimeMs, refresh) === "regenerate") {
      // Owner-routing: the owning bot synthesizes its own wiki's digest (jarvis
      // wiki → jarvis, nav → melosys); standalone / opus-owned wikis fall back to
      // the research bot. See resolveWikiSynthesisBot.
      const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());
      if (!botConfig) return c.json({ digest: null, error: "no bot available to summarize" });
      // Single-flight: reuse an in-flight generation for this wiki (a second tab
      // or a refresh racing the auto-load joins it) rather than spawning a
      // second connector call.
      let pending = digestInFlight.get(entry.name);
      if (!pending) {
        pending = generateWikiDigest(entry.root, index, config, botConfig).finally(() => {
          digestInFlight.delete(entry.name);
        });
        digestInFlight.set(entry.name, pending);
      }
      try {
        digest = await pending;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("Wiki digest generation failed for {wiki}: {error}", {
          wiki: entry.name,
          error: msg,
        });
        const timedOut = /time?d?\s*out|timeout/i.test(msg);
        return c.json({
          digest: null,
          error: timedOut ? "digest generation timed out" : "digest generation failed",
        });
      }
      if (!digest) return c.json({ digest: null });
      digestCache.set(entry.name, digest);
    }

    if (!digest) return c.json({ digest: null });
    // Render the stored markdown bullets to reader HTML (wikilinks → in-reader
    // page anchors) at response time — cheap, and keeps the cached form plain.
    return c.json({
      digest: { ...digest, html: renderWikiHtml(digest.bullets, index.resolve) },
    });
  });

  // Read-only index-coverage overview for the reader start view: compares the
  // wiki's on-disk `.md` pages against the deduped union of its backing search
  // collections' document ids (huginn doc `id` IS the wiki-relative path). Reports
  // `missing` (pages in no collection), `ghosts` (indexed ids with no file), and
  // `htmlPages` (explainers — informational, never counted as missing). A wiki
  // with no `collections` returns a clean `{ error }` (Ask-tab precedent). Never
  // 5xx: a failed collection listing degrades to 200 + `errors[]` AND suppresses
  // the coverage fields (a partial union would flag really-indexed pages as
  // missing). `?refresh=1` busts the page-index TTL cache only — the collection
  // listings are 1–2 cheap calls and aren't muninn-side cached in v1.
  app.get("/api/wiki/index-coverage", async (c) => {
    const nullCoverage = (extra: Partial<IndexCoverageResponse> & { error?: string }) =>
      c.json({
        collections: [] as string[],
        totalMd: null,
        indexed: null,
        missing: null,
        excludedByRule: null,
        ghosts: null,
        htmlPages: 0,
        generatedAt: Date.now(),
        ...extra,
      });

    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) {
      return nullCoverage({ error: "no wiki configured for that name" });
    }
    const collections = entry.collections ?? [];
    if (collections.length === 0) {
      return nullCoverage({ error: "no search collection connected for this wiki" });
    }
    const index = await getWikiIndex({ root: entry.root, refresh: c.req.query("refresh") === "1" });
    if (!index) {
      return nullCoverage({ collections, error: "wiki directory not found" });
    }

    const pageRelPaths = index.pages.map((p) => p.relPath);

    // Best-effort source of each collection's reader include/exclude patterns —
    // one degrade-tolerant `/api/collections` call. Present only on a huginn that
    // exposes the pattern fields; absent (older huginn / unreachable) ⇒ no
    // excludedByRule partition (meta pages stay in `missing`). Never blocks the
    // main coverage: a failure here just omits the partition, it doesn't error.
    const patternsByCollection = await fetchCollectionPatterns(config.knowledgeApiUrl);

    // List each collection sequentially — never fan unbounded concurrency at
    // huginn's Python server (shared `listCollections` helper). A listing that
    // fails contributes an error entry (empty ids), which the pure builder turns
    // into the suppress-coverage path.
    const { byCollection, errors } = await listCollections(config.knowledgeApiUrl, collections);
    const errorByCollection = new Map(errors.map((e) => [e.collection, e]));
    const listings: CoverageListing[] = collections.map((collection) => {
      const err = errorByCollection.get(collection);
      if (err) return { ids: [], error: err };
      const ids = (byCollection[collection] ?? [])
        .map((d) => d.id)
        .filter((id): id is string => typeof id === "string");
      return { ids, patterns: patternsByCollection.get(collection) };
    });

    // Dirty-state probe for the Index card's "uncommitted changes: N" badge.
    // Independent of collections (a git fact about the wiki dir); cheap + never
    // throws (non-repo ⇒ 0). Attached alongside the coverage fields.
    const dirty = await wikiDirtyStat(entry.root);
    return c.json({
      ...buildIndexCoverageResponse(collections, pageRelPaths, listings),
      ...dirty,
    });
  });

  // Manual reindex trigger for the reader's Index card. Resolves the wiki exactly
  // like index-coverage, then POSTs huginn's `/api/collections/<c>/update` for
  // EACH backing collection. huginn's CAS 409 (a rebuild already in flight — the
  // nightly job may be running) maps to the honest `already-running` state, NOT a
  // failure. There is no muninn-side mutex — huginn's CAS is the serialization
  // point. Never 5xx: an unknown / collection-less wiki returns 200 + `{ error }`;
  // an unreachable huginn returns 200 with per-collection `error` entries.
  app.post("/api/wiki/reindex", async (c) => {
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) {
      return c.json({ collections: [], error: "no wiki configured for that name" });
    }
    const collections = entry.collections ?? [];
    if (collections.length === 0) {
      return c.json({ collections: [], error: "no search collection connected for this wiki" });
    }
    const response = await buildReindexResponse(collections, (name) =>
      postCollectionUpdate(config.knowledgeApiUrl, name),
    );
    return c.json(response);
  });

  // Reindex status proxy for the Index card's poll loop: same resolution, then
  // proxies each collection's huginn `/api/collections/<c>/update-status`. A failed
  // status fetch degrades to `status: "unknown"` + error for that entry (never
  // 5xx). Same unknown / collection-less contract as the trigger route.
  app.get("/api/wiki/reindex-status", async (c) => {
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) {
      return c.json({ collections: [], error: "no wiki configured for that name" });
    }
    const collections = entry.collections ?? [];
    if (collections.length === 0) {
      return c.json({ collections: [], error: "no search collection connected for this wiki" });
    }
    const response = await buildReindexStatusResponse(collections, (name) =>
      getCollectionUpdateStatus(config.knowledgeApiUrl, name),
    );
    return c.json(response);
  });

  // One page: rendered HTML + connections (outgoing links and backlinks).
  // Resolves by `relPath` when given (exact, collision-proof — the Atlas tab's
  // node clicks send the node's normalized relPath so a same-stem page in another
  // folder can't shadow the intended page), else by `name` (first-stem-match, the
  // legacy wikilink/list-click path).
  app.get("/api/wiki/page", async (c) => {
    const relPathQ = c.req.query("relPath");
    const name = c.req.query("name");
    if (!relPathQ && !name) {
      return c.json({ error: "name or relPath query param required" }, 400);
    }
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    const meta = relPathQ ? index.resolveRelPath(relPathQ) : index.resolve(name!);
    if (!meta) {
      const which = relPathQ ? `relPath "${relPathQ}"` : `name "${name}"`;
      return c.json({ error: `no wiki page for ${which}` }, 404);
    }
    const markdown = await readWikiPage(index, meta);
    if (markdown === null) return c.json({ error: "page file unreadable" }, 503);

    const listings = (relPaths: string[] | undefined) =>
      (relPaths ?? [])
        .map((rp) => index.resolveRelPath(rp))
        .filter((m): m is WikiPageMeta => m !== undefined)
        .map((m) => toListing(index, m));

    return c.json({
      meta: toListing(index, meta),
      html: renderWikiHtml(markdown, index.resolve, { stripTitle: meta.title }),
      outgoing: listings(index.outgoing.get(normalizeRelPath(meta.relPath))),
      backlinks: listings(index.backlinks.get(normalizeRelPath(meta.relPath))),
    });
  });

  // Semantic "Similar" articles for one page: a query built from the page's
  // title + tags + first body paragraph, searched against the wiki's backing
  // collections, then resolved back onto pages in the SAME wiki. Powers the
  // reader's Connections panel "Similar" section (fetched lazily after render).
  // Same registry resolution + `?bot=` alias as the other wiki routes. A wiki
  // with no `collections` (or an unknown name) is a clean 404 (Ask precedent);
  // an unreachable Huginn degrades to `{ similar: [] }` + a warn (never errors
  // the page). Explainers query on title only (no markdown body to read).
  app.get("/api/wiki/similar", async (c) => {
    const pageName = c.req.query("page");
    if (!pageName) return c.json({ error: "page query param required" }, 400);
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) return c.json({ error: "no wiki configured for that name" }, 404);
    const collections = entry.collections ?? [];
    if (collections.length === 0) {
      return c.json({ error: "no search collection connected for this wiki" }, 404);
    }
    const index = await getWikiIndex({ root: entry.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 404);
    const meta = index.resolve(pageName);
    if (!meta) return c.json({ error: `no wiki page named "${pageName}"` }, 404);

    // Build query + search + resolve is shared with the Explain route. Best-effort:
    // a Huginn failure resolves to [] (section hides), never errors the page.
    const search: SimilarSearchFn = similarSearchFn ?? ((baseUrl, p) => fetchKnowledgeApi(baseUrl, p));
    const similar = await fetchSimilarPages(entry, index, meta, config, search);
    return c.json({ similar });
  });

  // Raw HTML for a standalone explainer, served for the reader's <iframe>. The
  // page is resolved strictly via its index entry's stored relPath — the `name`
  // query is only ever a lookup key, never joined into a filesystem path — and
  // the resolved path is verified to stay under the wiki root before serving.
  app.get("/api/wiki/html", async (c) => {
    const name = c.req.query("name");
    if (!name) return c.text("name query param required", 400);
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return c.text("no wiki configured for that name", 404);
    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.text("wiki directory not found", 503);
    const meta = index.resolve(name);
    if (!meta || meta.type !== "explainer") {
      return c.text(`no explainer named "${name}"`, 404);
    }
    // meta.relPath is the index's own stored path (never user input); still,
    // defend in depth — confirm the resolved file stays under the wiki root.
    const rootAbs = path.resolve(index.root);
    const fileAbs = path.resolve(rootAbs, meta.relPath);
    if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + path.sep)) {
      return c.text("invalid path", 400);
    }
    const file = Bun.file(fileAbs);
    if (!(await file.exists())) return c.text("explainer file not found", 404);
    // Append the Select-to-Explain forwarder. A trailing listener-only script
    // runs wherever it lands (even after </html>), so no anchor parsing is
    // needed. Full-text read is fine at explainer sizes (≤ a few hundred KB).
    const html = (await file.text()) + EXPLAINER_BRIDGE_SCRIPT;
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  // Wiki Ask tab: research-style cited Q&A scoped to a single wiki's search
  // collections. Mirrors /api/research/ask (SSE over GET, bounded `history`
  // replayed from the client) but pins the corpus to the selected wiki's
  // `collections` and enriches each citation with the matched wiki page name so
  // the reader can open it in-place. A wiki with no collections (or an unknown
  // name) returns a clean app_error instead of searching the whole corpus.
  app.get("/api/wiki/ask", async (c) => {
    const question = (c.req.query("q") ?? "").trim();
    if (!question) return c.json({ error: "Missing query parameter: q" }, 400);

    const registry = getWikiRegistry();
    const { entry, unknownWiki, wiki } = resolveWikiRequest(
      registry,
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    const history = parseResearchHistory(c.req.query("history"));
    // Owner-routing: the owning bot answers its own wiki's Ask (jarvis wiki →
    // jarvis, nav → melosys); standalone / opus-owned wikis fall back to the
    // research bot. `entry` may be undefined here (resolved before the unknown-
    // wiki preflight below) — the resolver's fallback branch covers that.
    const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());

    // Corpus is pinned to this wiki's collections. Compute the wiki/collection
    // preflight errors here; the shared helper handles the "no bots" case. The
    // "no bots" message deliberately lives in the helper (shared with /research).
    const collections = entry?.collections ?? [];
    let preflightError: string | null = null;
    if (unknownWiki || !entry) {
      preflightError = `No wiki configured for "${wiki || "(none)"}".`;
    } else if (collections.length === 0) {
      preflightError = "No search collection connected for this wiki.";
    }
    if (!preflightError && entry && botConfig) {
      log.info("Wiki ask: wiki={wiki} bot={bot} turn={turn} q={q}", {
        wiki: entry.name,
        bot: botConfig.name,
        turn: history.length + 1,
        q: question.slice(0, 120),
      });
    }

    // Per-wiki framing so the answer is scoped to this wiki's corpus. The same
    // line is used on owner- and fallback-routed wikis (no "for its owner"
    // phrasing — an owner claim would be false on a fallback/standalone wiki).
    // Hoisted to a variable so PR C can append the saved-notes block below.
    let systemPrompt: string | undefined = entry
      ? buildSynthesisSystemPrompt(
          `You answer questions about the "${entry.name}" knowledge wiki, using ONLY the numbered sources provided in the user message.`,
        )
      : undefined;

    // Saved-notes injection (PR C): a `wiki-note`-tag-scoped hybrid memory lookup
    // for the wiki's synthesis bot, appended to the system prompt as background.
    // Only on the happy path (preflight clean, prompt + synthesis bot present).
    // Bounded by the pre-stream timer and degrade-to-absent — a slow/failed lookup
    // leaves the prompt unchanged and never stalls the SSE open.
    if (!preflightError && systemPrompt && botConfig) {
      const block = await raceTimeout(
        fetchSavedNotesBlock({
          botName: botConfig.name,
          question,
          getBotDefaultUser,
          generateEmbedding,
          searchMemoriesHybrid,
        }),
        null,
      );
      if (block) systemPrompt = systemPrompt + "\n\n" + block;
    }

    return streamResearchSSE(c, {
      question,
      config,
      botConfig: botConfig ?? null,
      history,
      collections,
      preflightError,
      systemPrompt,
      // Pin enrichment to the resolved wiki (not the whole registry) so a
      // collection shared by two wikis can't attribute a citation to the wrong
      // one. `entry` is guaranteed set whenever enrich runs (preflightError
      // covers the unknown-wiki case), so a missing entry disables enrichment.
      enrich: entry ? (citations) => enrichCitationsWithPages(citations, [entry]) : undefined,
      // The reader renders the answer as a formatted article in its main pane, so
      // the route emits a trailing `answer_html` (markdown → reader HTML, `[n]`
      // markers linked to matched pages). `/research` leaves this unset.
      renderAnswerHtml: renderAskAnswerHtml,
    });
  });

  // Wiki Explain tab: Select-to-Explain. A sibling of `/api/wiki/ask` — the reader
  // selects a passage on a page and we run the SAME research pipeline (retrieval
  // over the wiki's collections → coverage gate → cited synthesis → answer_html)
  // with a per-wiki system prompt carrying the selected passage's article context.
  // Markdown pages are sent verbatim; HTML explainer pages are reduced to prose
  // via `htmlToText` before the same locator runs. The inherited coverage gate
  // applies — a selection from a non-indexed page may get the canned "No strong
  // match" decline (accepted). Never 5xx: param problems are 400 JSON; wiki/page
  // problems are `app_error` events on the already-committed 200 SSE response.
  app.get("/api/wiki/explain", async (c) => {
    const sel = (c.req.query("sel") ?? "").trim().slice(0, EXPLAIN_SELECTION_MAX);
    if (!sel) return c.json({ error: "Missing query parameter: sel" }, 400);
    const page = c.req.query("page");
    if (!page) return c.json({ error: "Missing query parameter: page" }, 400);
    const ctx = (c.req.query("ctx") ?? "").trim().slice(0, EXPLAIN_HEADING_MAX) || undefined;
    const history = parseResearchHistory(c.req.query("history"));

    const registry = getWikiRegistry();
    const { entry, unknownWiki, wiki } = resolveWikiRequest(
      registry,
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    // Owner-routing, identical to the Ask route (jarvis wiki → jarvis, nav →
    // melosys; standalone / opus-owned wikis fall back to the research bot).
    const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());
    const collections = entry?.collections ?? [];

    // Preflight (mirrors Ask's wiki/collection checks, plus the index/page checks
    // the Similar route makes — but as app_error, since the SSE response is
    // already committed to 200). Resolve index/meta ONLY on the happy path
    // (unknown wiki / no collections short-circuit before any filesystem touch);
    // the decision chain itself is the pure `resolveExplainPreflight`.
    let index: WikiIndex | null = null;
    let meta: WikiPageMeta | undefined;
    if (entry && !unknownWiki && collections.length > 0) {
      index = await getWikiIndex({ root: entry.root });
      if (index) meta = index.resolve(page);
    }
    const preflightError = resolveExplainPreflight({ wiki, unknownWiki, entry, index, meta, page });

    // Context assembly — ONLY when preflight passed (index/meta/entry are set).
    let question = "";
    let systemPrompt: string | undefined;
    if (!preflightError && entry && index && meta) {
      // Explainers are HTML on disk; reduce to prose so the locator sees lines.
      // Markdown pages pass through verbatim. A missing/unreadable file degrades
      // to an empty body (no 500) exactly like the markdown branch.
      const raw = (await readWikiPage(index, meta)) ?? "";
      const body = meta.type === "explainer" ? htmlToText(raw) : raw;
      // Similar titles are best-effort background context, and (PR C) the reader's
      // saved wiki notes are a second best-effort lookup. Both run BEFORE
      // streamResearchSSE's heartbeat exists, so each is bounded by the shared
      // pre-stream timer and degrades to empty — a slow/dead Huginn or DB can't
      // stall the stream open. They run CONCURRENTLY (`Promise.all` of two
      // never-rejecting raced promises) so the worst-case budget stays ~3s, not
      // additive. The notes query is `buildExplainQuestion(sel, meta.title)` —
      // derived here (pure, pre-race) so it never serializes behind the Similar
      // race that produces the route's `question` variable below.
      const search: SimilarSearchFn = similarSearchFn ?? ((baseUrl, p) => fetchKnowledgeApi(baseUrl, p));
      const notesQuestion = buildExplainQuestion(sel, meta.title);
      const [similar, notesBlock] = await Promise.all([
        raceTimeout(fetchSimilarPages(entry, index, meta, config, search), [] as SimilarPage[]),
        botConfig
          ? raceTimeout(
              fetchSavedNotesBlock({
                botName: botConfig.name,
                question: notesQuestion,
                getBotDefaultUser,
                generateEmbedding,
                searchMemoriesHybrid,
              }),
              null,
            )
          : Promise.resolve<string | null>(null),
      ]);
      const similarTitles = similar.map((s) => s.title);

      const opts = buildExplainAskOptions({
        meta,
        body,
        sel,
        ctx,
        similarTitles,
        wikiName: entry.name,
      });
      question = opts.question;
      // Append the saved-notes block AFTER the article-context block that
      // buildExplainAskOptions already assembled into the system prompt.
      systemPrompt = notesBlock ? opts.systemPrompt + "\n\n" + notesBlock : opts.systemPrompt;
      log.info("Wiki explain: wiki={wiki} bot={bot} page={page} sel={sel}", {
        wiki: entry.name,
        bot: botConfig?.name,
        page,
        sel: sel.slice(0, 80),
      });
    }

    return streamResearchSSE(c, {
      question,
      config,
      botConfig: botConfig ?? null,
      history,
      collections,
      preflightError,
      systemPrompt,
      // Same per-wiki citation enrichment as Ask (pinned to the resolved wiki).
      enrich: entry ? (citations) => enrichCitationsWithPages(citations, [entry]) : undefined,
      renderAnswerHtml: renderAskAnswerHtml,
    });
  });

  // Wiki Fact check: web-verified per-claim verdicts for a selected passage (`sel`
  // mode) or a whole page (`article` mode). A sibling of `/api/wiki/explain`, but
  // it runs NO retrieval and NO coverage gate — a tool-enabled one-shot verifies
  // claims against the LIVE web (WebFetch) and streams verdicts via the dedicated
  // `streamFactcheckSSE`. Unlike Ask/Explain it needs NO search collections (it's
  // corpus-independent) but DOES need a connector with web tools (claude-cli /
  // claude-sdk) — a non-web connector preflights out with a clean app_error.
  // Never 5xx: param problems are 400 JSON; wiki/page/connector problems are
  // `app_error` events on the already-committed 200 SSE response.
  app.get("/api/wiki/factcheck", async (c) => {
    const mode = c.req.query("mode") === "article" ? "article" : "sel";
    const page = c.req.query("page");
    if (!page) return c.json({ error: "Missing query parameter: page" }, 400);
    const sel = (c.req.query("sel") ?? "").trim().slice(0, FACTCHECK_SELECTION_MAX);
    if (mode === "sel" && !sel) return c.json({ error: "Missing query parameter: sel" }, 400);
    const ctx = (c.req.query("ctx") ?? "").trim().slice(0, FACTCHECK_HEADING_MAX) || undefined;

    const registry = getWikiRegistry();
    const { entry, unknownWiki, wiki } = resolveWikiRequest(
      registry,
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    // Owner-routing, identical to Ask/Explain.
    const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());

    // Preflight (never-5xx: app_error on the committed 200 stream). Fact-check
    // needs NO collections, so this chain omits Explain's collection check but
    // ADDS the web-tools connector check. Resolve index/meta only on the happy
    // path (unknown wiki short-circuits before any filesystem touch).
    let index: WikiIndex | null = null;
    let meta: WikiPageMeta | undefined;
    if (entry && !unknownWiki) {
      index = await getWikiIndex({ root: entry.root });
      if (index) meta = index.resolve(page);
    }
    let preflightError: string | null = null;
    if (unknownWiki || !entry) {
      preflightError = `No wiki configured for "${wiki || "(none)"}".`;
    } else if (!index) {
      preflightError = "wiki directory not found";
    } else if (!meta) {
      preflightError = `No wiki page named "${page}".`;
    } else if (botConfig && !connectorCapabilities(botConfig).supportsWebTools) {
      preflightError =
        `This wiki's bot (${botConfig.name}) can't run web fact-checks — its connector has no web tools. ` +
        `Point the wiki at a claude-cli or claude-sdk bot.`;
    }

    // Context assembly — ONLY when preflight passed (entry/index/meta set). The
    // SSE now builds the extraction/verify/compose prompts at runtime; the route
    // only reduces the body + computes the base hash.
    let body = "";
    let baseHash = "";
    let bodyLen: number | undefined;
    // Should this page carry inline `<Fact>` annotations? A POLICY call, not a
    // capability one — `renderWikiHtml` would render the pair from a `.md` page
    // too, but `.md` is read raw outside the reader (GitHub), so those pages keep
    // the blockquote form and get no wrappers. See `isAnnotatablePage`. Derived
    // here from the RESOLVED path — the client only ever holds a display name and
    // must never guess the extension.
    let annotatable = false;
    if (!preflightError && entry && index && meta) {
      // Explainers are HTML on disk; reduce to prose so claim extraction / the
      // locator see plain text. Markdown pages pass through verbatim. A missing/
      // unreadable file degrades to an empty body (no 500), like the explain branch.
      const raw = (await readWikiPage(index, meta)) ?? "";
      baseHash = createHash("sha256").update(raw).digest("hex");
      // The ONE body-length referent shared with the integrate route's
      // INTEGRATE_BODY_MAX check — same function, same arguments, so the number
      // the client budgets against is the number the server enforces. Explainers
      // are never integrable (HTML on disk), so they get NO bodyLen at all rather
      // than an HTML length nothing enforces.
      // Measured on the WRAPPER-STRIPPED body, because that is what the integrate
      // route resolves against — the two must be the same number or the client
      // budgets a "too long" verdict the server would never reach.
      if (meta.type !== "explainer") {
        bodyLen = integrateBodyLen(stripFactWrappers(raw), meta.relPath.endsWith(".mdx"));
      }
      annotatable = isAnnotatablePage(meta.relPath, meta.type);
      body = meta.type === "explainer" ? htmlToText(raw) : raw;
      log.info("Wiki factcheck: wiki={wiki} bot={bot} page={page} mode={mode}", {
        wiki: entry.name,
        bot: botConfig?.name,
        page,
        mode,
      });
    }

    return streamFactcheckSSE(c, {
      config,
      botConfig: botConfig ?? null,
      preflightError,
      body,
      meta: meta
        ? { title: meta.title, tags: meta.tags, type: meta.type }
        : { title: page, tags: [], type: "note" },
      wikiName: entry?.name ?? "",
      mode,
      sel: mode === "sel" ? sel : undefined,
      ctx: mode === "sel" ? ctx : undefined,
      botDir: botConfig?.dir,
      baseHash,
      ...(bodyLen !== undefined ? { bodyLen } : {}),
      annotatable,
      // Same reader HTML pipeline as Ask/Explain (no citations — fact-check cites
      // raw URLs inline in the answer markdown, not numbered sources).
      renderAnswerHtml: (answer) => renderAskAnswerHtml(answer, []),
    });
  });

  // Wiki "Remember this": persist a durable memory distilled from an Ask/Explain
  // Q&A turn. The first dashboard-originated memory write (auth-less loopback like
  // POST /feedback). Plain JSON route — normal REST semantics (400/404/409/502),
  // NOT the SSE never-5xx contract — but no unhandled throws: the body is wrapped
  // so a truly unexpected failure logs + returns a 500 JSON instead of crashing.
  //
  // Owner-routing: the memory is attributed to the wiki's synthesis bot (same
  // `resolveWikiSynthesisBot` as Ask) and that bot's `bot_default_user` mapping —
  // an explicit mapping, never a silent fallback user, so a wiki whose bot has no
  // mapping gets a clean 409 rather than an orphaned memory. The stable `wiki-note`
  // first tag is PR C's injection filter.
  app.post("/api/wiki/remember", async (c) => {
    try {
      type RememberBody = { wiki?: string; bot?: string; question?: string; answer?: string };
      const body = await c.req.json<RememberBody>().catch(() => ({} as RememberBody));
      const question = typeof body.question === "string" ? body.question.trim() : "";
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!question) return c.json({ error: "question is required" }, 400);
      if (!answer) return c.json({ error: "answer is required" }, 400);

      const { entry, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki") ?? body.wiki,
        c.req.query("bot") ?? body.bot,
        process.env.WIKI_DIR,
      );
      if (unknownWiki || !entry) {
        return c.json({ error: "no wiki configured for that name" }, 404);
      }

      // Attribution bot — may be undefined (no fast bot, or the research-bot
      // fallback resolves to nothing). Guard BEFORE touching bot.name.
      const { bot } = resolveWikiSynthesisBot(entry, discoverAllBots());
      if (!bot) {
        return c.json({ error: "No synthesis bot for this wiki" }, 409);
      }

      // Explicit owner mapping — never a silent fallback user.
      const userId = await getBotDefaultUser(bot.name);
      if (!userId) {
        return c.json(
          { error: `No default user mapped for bot ${bot.name} — memory would be orphaned` },
          409,
        );
      }

      // Distill via the bot's Haiku backend (same router the decomposer/extractors
      // use; no MCP needed, so the one-shot router, not spawnHaiku). A null parse
      // ⇒ 502; we do NOT save a verbatim fallback.
      const prompt = buildDistillPrompt({ wikiName: entry.name, question, answer });
      const haiku = await callHaikuWithFallback(prompt, {
        source: "wiki_remember",
        entrypoint: `${bot.name}-wiki-remember`,
        botName: bot.name,
        cwd: bot.dir,
        connector: bot.connector,
        haikuBackend: bot.haikuBackend,
      });
      const distilled = parseDistillResult(haiku.result);
      if (!distilled) {
        log.warn("Wiki remember: distill failed for wiki={wiki} bot={bot} raw={raw}", {
          wiki: entry.name,
          bot: bot.name,
          raw: haiku.result.slice(0, 200),
        });
        return c.json({ error: "distill failed" }, 502);
      }

      // Embed the search line (the extractor's exact degrade — save without an
      // embedding + warn if the model is unavailable).
      const embedding = await generateEmbedding(distilled.summary);
      if (!embedding) {
        log.warn("Wiki remember: embedding returned null — saving without embedding", {
          bot: bot.name,
          summary: distilled.summary,
        });
      }

      await saveMemory({
        userId,
        botName: bot.name,
        content: distilled.content,
        summary: distilled.summary,
        // Stable `wiki-note` first tag + the wiki name, then the distilled topics.
        tags: [...new Set(["wiki-note", entry.name, ...distilled.tags])],
        scope: "personal",
        embedding,
      });

      activityLog.push("system", `Wiki remember: ${entry.name} — ${distilled.summary}`, {
        botName: bot.name,
        userId,
        metadata: { source: "wiki-remember", wiki: entry.name },
      });
      log.info("Wiki remember: wiki={wiki} bot={bot} user={user} summary={summary}", {
        wiki: entry.name,
        bot: bot.name,
        user: userId,
        summary: distilled.summary,
      });

      return c.json({ saved: true, summary: distilled.summary });
    } catch (err) {
      log.error("Wiki remember: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Wiki Ask → chat escalation ("Continue in chat →"): spawn a real conversation
  // thread seeded with the Ask turn, so the reader can keep going with the FULL
  // prompt-builder context (persona, memories incl. shared scope, goals, MCP
  // tools) that the stateless Ask tab has none of. Mirrors `POST /api/research/chat`
  // — same thread/conversation/pending-message plumbing and the same `chatUrl`
  // shape the chat page's `handleDeepLink()` consumes — deliberately duplicated
  // rather than refactored into a shared helper (surgical-changes rule).
  //
  // Bot routing is the ONE deliberate divergence from Ask: the conversation goes
  // to the wiki's OWNING bot, not `resolveWikiSynthesisBot`'s answer. Synthesis
  // routing optimizes for a fast model and falls back to the research bot, but a
  // chat thread must land where the user's memories, goals and tools live.
  //
  // Body `bot` is the CHAT-bot override (not the legacy wiki alias — that stays
  // the `?bot=` query param, as on every other reader route).
  app.post("/api/wiki/ask/chat", async (c) => {
    try {
      type AskChatBody = {
        wiki?: string;
        bot?: string;
        userId?: string;
        question?: string;
        answer?: string;
        citations?: AskChatCitation[];
        forceNew?: boolean;
      };
      const body = await c.req.json<AskChatBody>().catch(() => ({}) as AskChatBody);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!question) return c.json({ error: "question is required" }, 400);
      if (!answer) return c.json({ error: "answer is required" }, 400);
      const citations = Array.isArray(body.citations) ? body.citations : [];

      const { entry, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki") ?? body.wiki,
        c.req.query("bot"),
        process.env.WIKI_DIR,
      );
      if (unknownWiki || !entry) {
        return c.json({ error: "no wiki configured for that name" }, 404);
      }

      // Owning bot (or the explicit override). A standalone `WIKI_EXTRA` wiki has
      // no owner — there is no defensible bot whose memories the thread belongs
      // to, so say that instead of silently picking one.
      const allBots = askChatDeps.discoverBots();
      const wanted = typeof body.bot === "string" ? body.bot.trim() : "";
      let botConfig: BotConfig | undefined;
      if (wanted) {
        botConfig = allBots.find((b) => b.name.toLowerCase() === wanted.toLowerCase());
        if (!botConfig) return c.json({ error: `Unknown bot "${wanted}"` }, 400);
      } else if (entry.source === "bot") {
        botConfig = allBots.find((b) => b.name.toLowerCase() === entry.name.toLowerCase());
        if (!botConfig) {
          return c.json({ error: `Bot "${entry.name}" is no longer configured` }, 400);
        }
      } else {
        return c.json(
          {
            error:
              `The "${entry.name}" wiki belongs to no bot, so there is no chat to continue in ` +
              "— pass an explicit bot to escalate anyway.",
            needsBot: true,
            bots: allBots.map((b) => ({ name: b.name })),
          },
          400,
        );
      }

      // User resolution — explicit `userId` when the bot has more than one, so the
      // thread can never land on an arbitrary user (mirrors /api/research/chat).
      const chatConfig = await askChatDeps.loadChatConfig(botConfig.name);
      const botUsers = chatConfig?.users ?? [];
      if (body.userId && !botUsers.find((u) => u.id === body.userId)) {
        return c.json({
          error: `User "${body.userId}" not found for bot "${botConfig.name}"`,
          needsUser: true,
          users: botUsers.map((u) => ({ id: u.id, name: u.name })),
        }, 400);
      }
      // Several users and no explicit pick: fall back to the bot's
      // `bot_default_user` mapping — the same owner answer the sibling Remember
      // button attributes memories to. Unlike the Jira extension (which can
      // prompt), the reader has no user picker, and on a real install a bot
      // routinely carries several historical user rows, so without this the
      // button would be a permanent `needsUser` 400. No mapping ⇒ still a clean
      // `needsUser`, never an arbitrary pick.
      let defaultUserId: string | null = null;
      if (!body.userId && botUsers.length > 1) {
        defaultUserId = await askChatDeps.getBotDefaultUser(botConfig.name);
        if (!defaultUserId || !botUsers.find((u) => u.id === defaultUserId)) {
          return c.json({
            error: "Multiple users available — please specify userId",
            needsUser: true,
            users: botUsers.map((u) => ({ id: u.id, name: u.name })),
          }, 400);
        }
      }
      const pickedId = body.userId ?? defaultUserId;
      const chatUser = pickedId ? botUsers.find((u) => u.id === pickedId)! : botUsers[0];
      if (!chatUser) {
        return c.json({ error: `No user found for bot "${botConfig.name}"` }, 400);
      }

      // Thread name derived from the question (lowercased + ≤50 chars, the
      // `createThread` contract). An existing thread of that name is a 409 the
      // client retries with `forceNew`, which timestamp-suffixes the name.
      const title = deriveAskThreadTitle(question);
      const existing = await askChatDeps.findThreadByName(chatUser.id, botConfig.name, title);
      if (existing && !body.forceNew) {
        return c.json({
          threadExists: true,
          existingThreadId: existing.id,
          existingThreadName: existing.name,
          userId: chatUser.id,
          botName: botConfig.name,
        }, 409);
      }
      const threadTitle = existing && body.forceNew ? uniqueAskThreadTitle(title) : title;

      // Find or create the web conversation shell for this user+bot.
      const existingConv = askChatDeps
        .getConversations()
        .find(
          (conv) =>
            conv.userId === chatUser.id && conv.botName === botConfig!.name && conv.type === "web",
        );
      const conversationId =
        existingConv?.id ??
        askChatDeps.createConversation({
          type: "web",
          botName: botConfig.name,
          userId: chatUser.id,
          username: chatUser.name,
        }).id;

      const thread = await askChatDeps.createThread(
        chatUser.id,
        botConfig.name,
        threadTitle,
        `Continued from the ${entry.name} wiki Ask tab`,
      );

      // Seed the first message — the chat page's deep-link handler consumes it
      // from `GET /chat/pending/:threadId` and sends it through the normal
      // pipeline once the WebSocket is up (5-min TTL, one-shot).
      const seed = buildAskChatSeed({
        wikiName: entry.name,
        question,
        answer,
        citations,
      });
      askChatDeps.setPendingMessage(thread.id, seed, { title: question.slice(0, 80) });

      log.info("Wiki ask→chat: wiki={wiki} bot={bot} user={user} thread={threadId}", {
        wiki: entry.name,
        bot: botConfig.name,
        user: chatUser.id,
        threadId: thread.id,
      });

      return c.json({
        threadId: thread.id,
        conversationId,
        chatUrl:
          `/chat?bot=${encodeURIComponent(botConfig.name)}` +
          `&thread=${encodeURIComponent(thread.id)}` +
          `&user=${encodeURIComponent(chatUser.id)}`,
      });
    } catch (err) {
      log.error("Wiki ask→chat: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Fact check "➕ Add to article" (PR B): persist a fact-check answer as a
  // `> [!factcheck]` callout block on the checked page. Plain JSON route (normal
  // REST semantics — 400/403/404/409/500 — NOT the SSE never-5xx contract), but
  // the whole body is wrapped so an unexpected failure returns 500 JSON, never an
  // unhandled throw. Allowed on ANY registered wiki's MARKDOWN pages; explainer
  // (.html) pages are rejected — appending markdown would corrupt the file.
  // Writes via the dedicated `appendBlockToPage` helper (splice + raw-bytes
  // staleness + log + reindex over the wiki's registry collections), never the
  // gardener apply path.
  app.post("/api/wiki/factcheck/append", async (c) => {
    try {
      type AppendBody = { wiki?: string; bot?: string; page?: string; answer?: string; baseHash?: string };
      const body = await c.req.json<AppendBody>().catch(() => ({} as AppendBody));
      const page = typeof body.page === "string" ? body.page.trim() : "";
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      const baseHash = typeof body.baseHash === "string" ? body.baseHash.trim() : "";
      if (!page) return c.json({ error: "page is required" }, 400);
      if (!answer) return c.json({ error: "answer is required" }, 400);
      // The answer is client-posted and gets spliced into the page — bound it like
      // every other input on this write path.
      if (answer.length > FACTCHECK_ANSWER_MAX) {
        return c.json(
          { error: `answer exceeds the ${FACTCHECK_ANSWER_MAX}-char limit`, max: FACTCHECK_ANSWER_MAX },
          400,
        );
      }
      if (!baseHash) return c.json({ error: "baseHash is required" }, 400);

      const { entry, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki") ?? body.wiki,
        c.req.query("bot") ?? body.bot,
        process.env.WIKI_DIR,
      );
      if (unknownWiki || !entry) {
        return c.json({ error: "no wiki configured for that name" }, 404);
      }

      const index = await getWikiIndex({ root: entry.root });
      if (!index) return c.json({ error: "wiki directory not found" }, 404);
      const meta = index.resolve(page);
      if (!meta) return c.json({ error: `no wiki page named "${page}"` }, 404);
      // Markdown-only: appending a callout to a standalone .html explainer would
      // corrupt it. Reject before any write.
      if (meta.type === "explainer") {
        return c.json({ error: "fact-check blocks can only be added to markdown pages" }, 400);
      }

      // Resolve the owning bot's push preference for the commit. A bot wiki's
      // registry entry shares its name with the bot; a standalone wiki has no
      // owning bot — default push:true either way.
      const owningBot =
        entry.source === "bot"
          ? discoverAllBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase())
          : undefined;
      const push = owningBot?.wikiAutoCommit?.push ?? true;

      // A native `.mdx` page gets the `<FactCheck>` component appendix (collapsed,
       // severity-ordered, per-claim `<section id="fc-claim-N">`); a `.md` page keeps
      // the `> [!factcheck]` blockquote, because it is read raw outside the reader
      // where JSX-ish tags would show as literal text. No `Was:` lines here — the ➕
      // action changes no prose, so there is no "was" to state.
      const block = isAnnotatablePage(meta.relPath, meta.type)
        ? buildFactcheckAppendix(answer, todayOslo(Date.now()))
        : buildFactcheckBlock(answer, todayOslo(Date.now()));
      const result = await appendBlockToPage({
        wikiDir: entry.root,
        relPath: meta.relPath,
        block,
        baseHash,
        collections: entry.collections ?? [],
        logTitle: meta.title,
        now: () => Date.now(),
        readFile: async (absPath) => {
          try {
            return await Bun.file(absPath).text();
          } catch {
            return null;
          }
        },
        writeFile: async (absPath, content) => {
          await Bun.write(absPath, content);
        },
        refreshIndex: async () => {
          await getWikiIndex({ root: entry.root, refresh: true });
        },
        reindex: async (collection) => {
          await postCollectionUpdate(config.knowledgeApiUrl, collection);
        },
        commit: (paths, message) => commitWikiChange(entry.root, paths, message, { push }),
      });

      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      if (result.outcome === "error") {
        log.warn("Fact-check append failed for wiki={wiki} page={page}: {reason}", {
          wiki: entry.name,
          page,
          reason: result.reason,
        });
        return c.json({ error: result.reason }, 500);
      }

      activityLog.push("system", `Wiki fact-check appended: ${entry.name} — ${meta.title}`, {
        metadata: { source: "wiki-factcheck-append", wiki: entry.name, page: meta.relPath },
      });
      log.info("Wiki fact-check appended: wiki={wiki} page={page}", {
        wiki: entry.name,
        page: meta.relPath,
      });
      return c.json({ written: true, page: meta.relPath });
    } catch (err) {
      log.error("Wiki fact-check append: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Fact check "Integrate into article" — PROPOSE. Runs the fenced integrate
  // one-shot on the wiki's synthesis bot and returns a validated, range-resolved
  // edit list for the client to preview. It NEVER writes: the human accepts edits
  // and the sibling /apply route below does the write under CAS + the per-wiki
  // queue. Plain JSON route (400/404/409/502/500), whole body wrapped like the
  // append route so an unexpected failure is a 500 JSON, never an unhandled throw.
  app.post("/api/wiki/factcheck/integrate", async (c) => {
    try {
      type IntegrateBody = {
        wiki?: string;
        bot?: string;
        page?: string;
        answer?: string;
        baseHash?: string;
        /** Per-claim verbatim supporting passages `{index, quote}` from Phase-1
         *  extraction (PR 2: carried + validated + echoed for instrumentation
         *  only — the inline-wrapper write path lands in a later PR). */
        quotes?: unknown;
      };
      const reqBody = await c.req.json<IntegrateBody>().catch(() => ({}) as IntegrateBody);
      const page = typeof reqBody.page === "string" ? reqBody.page.trim() : "";
      const answer = typeof reqBody.answer === "string" ? reqBody.answer.trim() : "";
      const baseHash = typeof reqBody.baseHash === "string" ? reqBody.baseHash.trim() : "";
      if (!page) return c.json({ error: "page is required" }, 400);
      if (!answer) return c.json({ error: "answer is required" }, 400);
      if (!baseHash) return c.json({ error: "baseHash is required" }, 400);

      const resolved = await resolveIntegrateTarget(c, reqBody);
      if ("response" in resolved) return resolved.response;
      const { entry, meta } = resolved;

      const current = (await readWikiPage(resolved.index, meta)) ?? "";
      // CAS FIRST — a drifted page invalidates the whole turn before we spend a
      // model call on it (same raw-bytes convention as the fact-check route).
      if (createHash("sha256").update(current).digest("hex") !== baseHash) {
        return c.json({ error: "page changed since the fact check", stale: true }, 409);
      }

      const isMdx = meta.relPath.endsWith(".mdx");
      // STRIP → resolve → splice. Every prior `<Fact>` wrapper comes off before the
      // model sees the page and before any offset is resolved, so (a) the anchors
      // the model quotes exist in the body we resolve against, and (b) a re-run
      // cannot nest a wrapper inside a wrapper. Prior wrappers not re-emitted by
      // THIS run are reported as superseded, never silently vanished.
      const supersededWrappers = countFactWrappers(current);
      const editable = stripFactWrappers(current);
      const bodyLen = integrateBodyLen(editable, isMdx);
      if (bodyLen > INTEGRATE_BODY_MAX) {
        return c.json({ error: "page too long to integrate", bodyLen, max: INTEGRATE_BODY_MAX }, 400);
      }
      // Only native `.mdx` pages carry inline annotations (policy — a `.md` page is
      // read raw outside the reader, where JSX-ish tags are literal text).
      const annotatable = isAnnotatablePage(meta.relPath, meta.type);
      const maxEdits = annotatedMaxEdits(annotatable);

      // Claim anchors are parsed SERVER-SIDE out of the answer markdown (its
      // `### <emoji> Claim n/m — <title>` headings are a fixed prompt contract),
      // rather than accepting the client's already-split claim list. NB the
      // `answer` itself is CLIENT-POSTED — this buys parsing robustness and one
      // implementation of the heading contract, NOT trust: a caller that can post
      // an answer can post any verdict blocks it likes, which is acceptable on the
      // auth-less loopback dashboard and is why every edit is previewed, bounded
      // and CAS-guarded before it can touch the page.
      // Additive (PR 2): does the page already carry a persisted fact-check
      // callout? The reader defaults its "also add summary callout" checkbox ON
      // when it does (refreshing a stale block is almost always wanted) and OFF on
      // a clean page. The client cannot derive this — the page body is not in the
      // turn — so it rides the propose response.
      // PAIRED matcher, not a bare START scan: an orphan start sentinel means
      // there is no block to replace, so claiming one would default the reader's
      // refresh checkbox ON and make the apply append a SECOND block (whose next
      // strip would then swallow the prose between them). `hasFactcheckBlock` is
      // the shared authority the strip + splice + exclusion zones already use.
      const hasSentinelBlock = hasFactcheckBlock(current);

      // Claim quotes are validated against the anchors we parse out of the SAME
      // posted answer — count + index range must agree, or the whole list is
      // dropped. Guessing an alignment is the one thing we must never do: a quote
      // paired with claim k+1 would later wrap that passage in the wrong verdict.
      // A dropped list is never a hard error — propose works exactly as before.
      const quoteCheck = validateClaimQuotes(reqBody.quotes, answer);
      if (quoteCheck.note) {
        log.info("Wiki fact-check integrate: claim quotes wiki={wiki} page={page} note={note}", {
          wiki: entry.name,
          page: meta.relPath,
          note: quoteCheck.note,
        });
      }
      const quoteFields = {
        quotes: quoteCheck.quotes,
        ...(quoteCheck.note ? { quotesNote: quoteCheck.note } : {}),
      };

      const allClaims = parseFactcheckClaims(answer);
      const claims = correctableClaims(answer);
      // The ALL-✅ gate relaxation, `.mdx` ONLY. On an annotatable page a check with
      // nothing to correct still has real output — every confirmed passage gets its
      // inline mark plus the appendix — so ≥1 parsed claim is enough. On a `.md` page
      // (no wrappers by policy) the only output is corrected prose, so ❌/⚠️ is still
      // required. The button gate and the e2e assertion relax on the same predicate.
      if (claims.length === 0 && !(annotatable && allClaims.length > 0)) {
        return c.json({
          edits: [],
          dropped: [],
          note: "No ❌ or ⚠️ claims to integrate.",
          budget: integrateBudget(bodyLen, annotatable),
          hasSentinelBlock,
          annotatable,
          ...quoteFields,
        });
      }

      // Nothing to CORRECT ⇒ no editor model call at all: the wrapper pass needs
      // only the claim quotes and the body. A 90s one-shot asked to correct an
      // all-✅ page has nothing to say.
      let modelEdits: IntegrateEdit[] = [];
      let modelDropped: DroppedEdit[] = [];
      let modelNote: string | undefined;
      if (claims.length > 0) {
        const { bot } = resolveWikiSynthesisBot(entry, discoverAllBots());
        if (!bot) return c.json({ error: "No synthesis bot for this wiki" }, 409);

        const prompts = buildIntegratePrompt({
          pageTitle: meta.title,
          wikiName: entry.name,
          claims,
          maskedBody: promptMaskBody(editable, isMdx),
          hasSourcesSection: hasSourcesSection(editable),
        });

        let raw: string;
        try {
          const result = await runIntegrateOneShot({
            pageTitle: meta.title,
            wikiName: entry.name,
            prompt: prompts.userPrompt,
            systemPrompt: prompts.systemPrompt,
            config,
            botConfig: bot,
          });
          raw = result.result ?? "";
        } catch (err) {
          log.warn("Wiki fact-check integrate: one-shot failed for wiki={wiki} page={page}: {error}", {
            wiki: entry.name,
            page: meta.relPath,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: "the editor model call failed" }, 502);
        }

        // Validate-to-null: a malformed response is a clean error, never a write.
        const parsed = parseEditList(raw);
        if (!parsed) {
          log.warn("Wiki fact-check integrate: unparseable edit list wiki={wiki} raw={raw}", {
            wiki: entry.name,
            raw: raw.slice(0, 200),
          });
          return c.json({ error: "the editor model returned no usable edit list" }, 502);
        }
        modelEdits = parsed.edits;
        modelDropped = parsed.dropped;
        modelNote = parsed.note;
      }

      // Payload bounds are enforced HERE too, so the preview only ever shows
      // edits the apply route will accept — count + per-edit size first, then the
      // RATIO budget over the RESOLVED spans (a tier-2 rescue's raw span can
      // exceed `old.length`, so measuring pre-resolution under-counts). Without
      // the ratio pass a preview could offer an accept-all that was a guaranteed
      // 400 at apply.
      //
      // `enforceEditBounds` runs on the model's edits PRE-wrapper (unchanged); the
      // POST-wrapper `new` length is re-checked inside `annotateEdits`, which also
      // owns the two-pass correction-first resolution and the newline tiers.
      const bounded = enforceEditBounds(modelEdits);
      const annotation = annotatable
        ? annotateEdits({
            body: editable,
            isMdx,
            corrections: bounded.kept,
            claims: allClaims,
            quotes: quoteCheck.quotes,
            maxEdits,
            maxEditChars: INTEGRATE_MAX_EDIT_CHARS,
          })
        : { edits: bounded.kept, dropped: [] as DroppedEdit[] };
      const resolvedEdits = applyEdits(editable, annotation.edits, isMdx);
      const budgetDrops = enforceChangeBudget(resolvedEdits.outcomes, bodyLen);
      const edits = resolvedEdits.outcomes
        .filter((o) => o.applied)
        .map((o) => ({
          ...o.edit,
          start: o.start,
          end: o.end,
          tier: o.tier,
          resolvedText: o.resolvedText,
          beforeCtx: o.beforeCtx,
          afterCtx: o.afterCtx,
        }));
      // Every drop is reported — including the model's own malformed items, which
      // used to be `continue`d into the void at parse time (#397's class).
      const dropped = [
        ...modelDropped,
        ...bounded.dropped,
        ...annotation.dropped,
        ...resolvedEdits.outcomes
          .filter((o) => !o.applied)
          .map((o) => ({ edit: o.edit, reason: o.reason ?? "could not be placed" })),
      ];
      // The SUPERSEDE rule made visible: the strip removed every prior mark, and
      // only this run's claims are re-marked. Reported so a shrinking claim set never
      // reads as marks silently disappearing off the page — as a RUN-level note, not
      // a blank row in `dropped` (which inflated the "N not applied" count with an
      // entry that corresponds to no proposed edit).
      const supersededNote =
        supersededWrappers > 0
          ? `${supersededWrappers} inline mark${supersededWrappers === 1 ? "" : "s"} ` +
            "from a previous check superseded — this run re-marks the page from its own claims"
          : undefined;

      log.info(
        "Wiki fact-check integrate: wiki={wiki} page={page} proposed={n} dropped={d} quotes={q}",
        {
          wiki: entry.name,
          page: meta.relPath,
          n: edits.length,
          d: dropped.length,
          q: quoteCheck.quotes.length,
        },
      );

      return c.json({
        edits,
        dropped,
        ...(modelNote ? { note: modelNote } : {}),
        // Measured on RESOLVED spans, so accept-all is guaranteed within budget.
        // Wrapper-only annotations score 0 (see `outcomeChangedChars`).
        ...(supersededNote ? { supersededNote } : {}),
        budget: {
          ...integrateBudget(bodyLen, annotatable),
          proposedChangedChars: budgetDrops.changedChars,
        },
        hasSentinelBlock,
        annotatable,
        ...quoteFields,
      });
    } catch (err) {
      log.error("Wiki fact-check integrate: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Fact check "Integrate into article" — APPLY. The client echoes the accepted
  // edits back verbatim (stateless by design; a stated tradeoff — apply trusts the
  // client payload, acceptable on the auth-less loopback dashboard but bounded
  // HARD: edit count, per-edit chars, and total changed chars vs the body).
  // Everything from the re-read through log.md runs inside the per-WIKI write
  // queue (`writeWikiPage`); the commit is the tail after it releases.
  app.post("/api/wiki/factcheck/integrate/apply", async (c) => {
    try {
      type ApplyBody = {
        wiki?: string;
        bot?: string;
        page?: string;
        baseHash?: string;
        edits?: unknown;
        /** Also refresh the `> [!factcheck]` summary callout in this SAME write. */
        appendCallout?: boolean;
        /** The fact-check answer the callout is built from — required iff
         *  `appendCallout`. It cannot be fetched server-side: the answer lives only
         *  on the client's turn. */
        answer?: string;
      };
      const reqBody = await c.req.json<ApplyBody>().catch(() => ({}) as ApplyBody);
      const page = typeof reqBody.page === "string" ? reqBody.page.trim() : "";
      const baseHash = typeof reqBody.baseHash === "string" ? reqBody.baseHash.trim() : "";
      if (!page) return c.json({ error: "page is required" }, 400);
      if (!baseHash) return c.json({ error: "baseHash is required" }, 400);

      // The callout must ride the SAME write as the edits — a second POST to the
      // append route would always 409, since applying the edits stales the very
      // `baseHash` the client holds.
      const appendCallout = reqBody.appendCallout === true;
      const calloutAnswer = typeof reqBody.answer === "string" ? reqBody.answer.trim() : "";
      if (appendCallout && !calloutAnswer) {
        return c.json({ error: "answer is required when appendCallout is set" }, 400);
      }
      // Same bound as the ➕ append route — the callout answer is spliced into the
      // page, so it can't be the one unbounded input on a hard-bounded write.
      if (calloutAnswer.length > FACTCHECK_ANSWER_MAX) {
        return c.json(
          { error: `answer exceeds the ${FACTCHECK_ANSWER_MAX}-char limit`, max: FACTCHECK_ANSWER_MAX },
          400,
        );
      }

      const edits = coerceClientEdits(reqBody.edits);
      if (!edits) return c.json({ error: "edits must be a non-empty array of {old, new} with both non-empty" }, 400);

      // Page resolution moved AHEAD of the count cap (it reads the index, not the
      // body): an ANNOTATED apply legitimately carries the corrections PLUS one mark
      // per claim, so the cap depends on whether this page is annotatable. There is
      // no wrapper/non-wrapper split in the cap — a correction's `new` is Fact-shaped
      // too — so the whole cap is raised rather than the marks counted separately.
      const resolved = await resolveIntegrateTarget(c, reqBody);
      if ("response" in resolved) return resolved.response;
      const { entry, meta } = resolved;
      const annotatable = isAnnotatablePage(meta.relPath, meta.type);
      const maxEdits = annotatedMaxEdits(annotatable);
      if (edits.length > maxEdits) {
        return c.json({ error: `too many edits — the cap is ${maxEdits} per apply` }, 400);
      }
      if (edits.some((e) => e.old.length > INTEGRATE_MAX_EDIT_CHARS || e.new.length > INTEGRATE_MAX_EDIT_CHARS)) {
        return c.json(
          { error: `an edit exceeds the ${INTEGRATE_MAX_EDIT_CHARS}-char per-edit limit` },
          400,
        );
      }
      // FAIL-CLOSED payload-shape pre-check, deliberately NOT the structural
      // wrapper-only predicate (which needs a resolved span this route has not read
      // yet): any edit whose replacement OPENS with a `<Fact` tag emits a chip, and
      // every chip links to a `#fc-claim-N` section that only the appendix carries.
      // So an annotated write cannot proceed without the answer to build it from —
      // the `appendCallout` checkbox is not the authority here, because it defaults
      // OFF on a clean page and would ship chips pointing at nothing.
      const annotatedWrite = carriesFactWrapper(edits);
      if (annotatedWrite && !calloutAnswer) {
        return c.json({ error: "answer is required for an annotated apply" }, 400);
      }

      const current = (await readWikiPage(resolved.index, meta)) ?? "";
      const isMdx = meta.relPath.endsWith(".mdx");
      const bodyLen = integrateBodyLen(stripFactWrappers(current), isMdx);
      // Same cap + same copy as propose — apply must not be a way around it.
      if (bodyLen > INTEGRATE_BODY_MAX) {
        return c.json({ error: "page too long to integrate", bodyLen, max: INTEGRATE_BODY_MAX }, 400);
      }
      // NB there is deliberately NO cheap pre-resolution RATIO check here. The
      // pre-resolution `changedChars` sum (Σ max(old,new)) is not a lower bound on
      // the authoritative span-based measure — a model `old` carrying reflowed
      // whitespace can OVER-count it — so a set that propose approved (and whose
      // resolved spans fit) could 400 before ever being re-resolved. The count cap
      // and per-edit char caps above stay (they are exact on the payload); the
      // ratio budget is owned by the authoritative in-transform check below, which
      // measures the freshly-resolved spans and reports its own 400 via
      // `budgetError`.
      const owningBot =
        entry.source === "bot"
          ? discoverAllBots().find((b) => b.name.toLowerCase() === entry.name.toLowerCase())
          : undefined;
      const push = owningBot?.wikiAutoCommit?.push ?? true;

      // Re-resolved INSIDE the critical section against the freshly-read body.
      let applyResult: ReturnType<typeof applyEdits> | null = null;
      // Set when the re-resolved spans breach the ratio budget. The transform then
      // declines the write, and the route reports it as a 400 naming the bound
      // (client-caused), not the 500 a thrown transform would produce.
      let budgetError: string | null = null;
      // Set by the transform when the callout actually got spliced, so the response
      // can't claim a callout on a run that short-circuited to `noop`.
      let calloutAdded = false;
      const result = await writeWikiPage({
        wikiDir: entry.root,
        relPath: meta.relPath,
        baseHash,
        collections: entry.collections ?? [],
        logKind: "factcheck-integrate",
        logTitle: meta.title,
        logLine: appendCallout || annotatedWrite
          ? "fact-check corrections integrated via the wiki reader (with summary callout)"
          : "fact-check corrections integrated via the wiki reader",
        commitMessage: `[fact-check] integrate: ${meta.relPath}`,
        now: () => Date.now(),
        transform: (raw) => {
          // STRIP first, on the freshly-read body: the offsets the client echoed were
          // resolved against a stripped body, and a re-annotation must not nest.
          const body = stripFactWrappers(raw);
          applyResult = applyEdits(body, edits, isMdx);
          // Authoritative budget check: on the FRESHLY-read body, over the spans
          // actually resolved (a tier-2 rescue's span can exceed `old.length`).
          // Wrapper-only annotations score 0 here exactly as they did at propose —
          // the SAME structural predicate, re-derived from this body's own slices.
          const liveMax = maxChangedChars(integrateBodyLen(body, isMdx));
          const liveChanged = changedCharsOfOutcomes(applyResult.outcomes);
          if (liveChanged > liveMax) {
            budgetError = `the accepted edits change ${liveChanged} chars, over the ${liveMax}-char limit for this page`;
            return null;
          }
          // Zero survivors ⇒ short-circuit BEFORE the write: no write, no log
          // entry, no reindex, no commit. The callout deliberately does NOT rescue
          // this into a write — "applied: 0" stays a clean no-op, and the ➕ button
          // remains the way to add a callout on its own.
          if (applyResult.appliedCount === 0) return null;
          // Did any mark actually land? If so the appendix is MANDATORY regardless of
          // the checkbox — the chips have nowhere to point without it.
          // Same authority as the payload-shape pre-check above — one wrapper-shape
          // test, applied to the outcomes that actually landed.
          const wroteWrapper = carriesFactWrapper(
            applyResult.outcomes.filter((o) => o.applied).map((o) => o.edit),
          );
          // BOTH branches end in the same normalization (exactly one trailing
          // newline) so ticking the callout checkbox can't be the reason an
          // unrelated trailing byte changed.
          if (!appendCallout && !wroteWrapper) return withTrailingNewline(applyResult.body);
          // Same splice the ➕ route uses: REPLACE an existing sentinel block in
          // place (a stale callout is refreshed, never duplicated), else insert
          // before a trailing `## Sources`, else append. Runs on the already-edited
          // body inside the critical section, so page + callout are one write.
          // Edit offsets were resolved BEFORE this, and the sentinel block is a
          // masked exclusion zone, so the two can't collide.
          //
          // `.mdx` gets the `<FactCheck>` component appendix (whose `#fc-claim-N`
          // sections are the chips' targets, and whose `Was:` lines come from THIS
          // write's freshly-resolved spans); `.md` keeps the blockquote callout, since
          // a `.md` page is read raw outside the reader.
          const block = annotatable
            ? buildFactcheckAppendix(calloutAnswer, todayOslo(Date.now()), {
                originals: originalsOfOutcomes(applyResult.outcomes),
              })
            : buildFactcheckBlock(calloutAnswer, todayOslo(Date.now()));
          const spliced = spliceSentinelBlock(applyResult.body, block);
          calloutAdded = true;
          return withTrailingNewline(spliced);
        },
        readFile: async (absPath) => {
          try {
            return await Bun.file(absPath).text();
          } catch {
            return null;
          }
        },
        writeFile: async (absPath, content) => {
          await Bun.write(absPath, content);
        },
        refreshIndex: async () => {
          await getWikiIndex({ root: entry.root, refresh: true });
        },
        reindex: async (collection) => {
          await postCollectionUpdate(config.knowledgeApiUrl, collection);
        },
        commit: (paths, message) => commitWikiChange(entry.root, paths, message, { push }),
      });

      const droppedOf = (r: ReturnType<typeof applyEdits> | null) =>
        (r?.outcomes ?? [])
          .filter((o) => !o.applied)
          .map((o) => ({ edit: o.edit, reason: o.reason ?? "could not be placed" }));

      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      // A budget breach declines the transform, so it surfaces as `noop` — but it
      // is a client-caused 400 naming the bound, not a silent "nothing applied".
      if (budgetError) return c.json({ error: budgetError }, 400);
      if (result.outcome === "noop") {
        log.info("Wiki fact-check integrate apply: nothing resolved wiki={wiki} page={page}", {
          wiki: entry.name,
          page: meta.relPath,
        });
        // `calloutAdded` is reported on BOTH terminal paths so a caller never has
        // to infer "no callout" from an absent field: a zero-resolving apply
        // writes nothing at all, callout included.
        return c.json({
          applied: 0,
          calloutAdded: false,
          dropped: droppedOf(applyResult),
          page: meta.relPath,
        });
      }
      if (result.outcome === "error") {
        log.warn("Wiki fact-check integrate apply failed wiki={wiki} page={page}: {reason}", {
          wiki: entry.name,
          page,
          reason: result.reason,
        });
        // A confinement rejection is caused by the requested PAGE, not by the
        // server — report it as a 400 like the sibling rejections, not a 500.
        const clientFault = result.reason.startsWith("path confinement failed");
        return c.json({ error: result.reason }, clientFault ? 400 : 500);
      }

      const applied = (applyResult as ReturnType<typeof applyEdits> | null)?.appliedCount ?? 0;
      activityLog.push("system", `Wiki fact-check integrated: ${entry.name} — ${meta.title}`, {
        metadata: { source: "wiki-factcheck-integrate", wiki: entry.name, page: meta.relPath },
      });
      log.info("Wiki fact-check integrated: wiki={wiki} page={page} applied={applied}", {
        wiki: entry.name,
        page: meta.relPath,
        applied,
      });
      return c.json({
        applied,
        calloutAdded,
        dropped: droppedOf(applyResult),
        page: meta.relPath,
        committed: result.commit?.committed ?? false,
        ...(result.commit?.reason ? { reason: result.commit.reason } : {}),
      });
    } catch (err) {
      log.error("Wiki fact-check integrate apply: unexpected failure: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "internal error" }, 500);
    }
  });
}

/**
 * Resolve `{wiki|bot, page}` to a registered wiki entry + its index + the target
 * page meta for BOTH integrate routes, or the error Response to return. Markdown
 * only — an `.html` explainer is rejected before any model call or write, exactly
 * like the append route (splicing markdown into a standalone explainer would
 * corrupt it).
 */
async function resolveIntegrateTarget(
  c: { req: { query: (k: string) => string | undefined }; json: (o: unknown, s?: 400 | 404) => Response },
  body: { wiki?: string; bot?: string; page?: string },
): Promise<
  | { entry: WikiRegistryEntry; index: WikiIndex; meta: WikiPageMeta }
  | { response: Response }
> {
  const page = typeof body.page === "string" ? body.page.trim() : "";
  const { entry, unknownWiki } = resolveWikiRequest(
    getWikiRegistry(),
    c.req.query("wiki") ?? body.wiki,
    c.req.query("bot") ?? body.bot,
    process.env.WIKI_DIR,
  );
  if (unknownWiki || !entry) {
    return { response: c.json({ error: "no wiki configured for that name" }, 404) };
  }
  const index = await getWikiIndex({ root: entry.root });
  if (!index) return { response: c.json({ error: "wiki directory not found" }, 404) };
  const meta = index.resolve(page);
  if (!meta) return { response: c.json({ error: `no wiki page named "${page}"` }, 404) };
  if (meta.type === "explainer") {
    return {
      response: c.json({ error: "fact-check edits can only be applied to markdown pages" }, 400),
    };
  }
  // Reserved wiki infrastructure (log.md / index.md / CLAUDE.md, either
  // extension) — the same set `isPathConfined` rejects at write time, checked
  // HERE so the rejection is a clean 400 at BOTH routes. Without it, proposing on
  // `index` spent a 90s one-shot and then the apply hit the confinement backstop
  // as a 500 (verified live).
  if (hasForbiddenBasename(meta.relPath)) {
    return {
      response: c.json(
        { error: `"${meta.relPath}" is reserved wiki infrastructure and can't be edited here` },
        400,
      ),
    };
  }
  return { entry, index, meta };
}

/** The edit budget echoed to the client so it can disable accept-all honestly.
 *  `annotatable` drives `maxEdits` through the shared {@link annotatedMaxEdits}, so
 *  BOTH propose exits echo the cap the apply route actually enforces. */
function integrateBudget(
  bodyLen: number,
  annotatable: boolean,
): {
  bodyLen: number;
  maxEdits: number;
  maxEditChars: number;
  maxChangedChars: number;
} {
  return {
    bodyLen,
    maxEdits: annotatedMaxEdits(annotatable),
    maxEditChars: INTEGRATE_MAX_EDIT_CHARS,
    maxChangedChars: maxChangedChars(bodyLen),
  };
}

/**
 * Shape-validate the client-echoed edit list. Returns null when it isn't a
 * non-empty array of objects carrying a non-blank string `old` and a NON-EMPTY
 * string `new` — apply must never guess at a malformed payload.
 *
 * Kept at PARITY with `parseEditList` (the model-side entry point): both reject a
 * blank anchor and an empty replacement (an empty `new` is a silent deletion, not
 * an integrate edit), both normalize a bare ⚠ to ⚠️, both trim `reason`, and both
 * neutralize embedded fact-check sentinels in `new`. Two entry points into one
 * write path must not have two validation standards.
 *
 * Exported for unit tests only (the `resolveExplainPreflight` precedent).
 */
export function coerceClientEdits(raw: unknown): IntegrateEdit[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const edits: IntegrateEdit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const o = item as Record<string, unknown>;
    if (typeof o.old !== "string" || !o.old.trim()) return null;
    if (typeof o.new !== "string" || !o.new) return null;
    const idx = Number(o.claimIndex);
    edits.push({
      claimIndex: Number.isFinite(idx) && idx > 0 ? Math.trunc(idx) : 0,
      verdict: o.verdict === "⚠" ? "⚠️" : typeof o.verdict === "string" ? o.verdict : "",
      old: o.old,
      new: neutralizeFactcheckSentinels(o.new),
      reason: typeof o.reason === "string" ? o.reason.trim() : "",
    });
  }
  return edits;
}
