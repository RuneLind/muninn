import path from "node:path";
import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, normalizeRelPath, readWikiPage, resolveWikiRoot, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
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
import { isReadonlyWikiRoot, wikiNoEgressReason } from "../../wiki/readonly.ts";
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
  locateExcerpt,
  EXPLAIN_HEADING_MAX,
  EXPLAIN_SELECTION_MAX,
} from "../../wiki/explain-context.ts";
import {
  buildFactcheckAppendix,
  buildFactcheckBlock,
  hasFactcheckBlock,
  stripFactcheckBlock,
  FACTCHECK_ANSWER_MAX,
  FACTCHECK_SELECTION_MAX,
  FACTCHECK_HEADING_MAX,
} from "../../wiki/factcheck-context.ts";
import { appendBlockToPage, spliceSentinelBlock, withTrailingNewline } from "../../wiki/append-block.ts";
import { defaultPageWriteIo, writeWikiPage } from "../../wiki/page-write.ts";
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
  CLAIM_QUOTE_MAX,
} from "../views/components/wiki-integrate.ts";
// The dialog's surface copy — imported, never re-spelled: the 409 below and the
// dialog's own conflict line are the same sentence, and a reword that touched
// only one of them would split the route from the screen it answers.
import { WIKI_SHARE_COPY } from "../views/components/wiki-share-dialog.ts";
import { commitWikiChange } from "../../wiki/commit.ts";
import { todayOslo } from "../../gardener/util.ts";
import { capabilitiesForConnectorType, connectorCapabilities } from "../../ai/one-shot.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import { streamFactcheckSSE } from "./factcheck-sse.ts";
import { acquireShareFlight, shareFlightKey, streamShareSSE } from "./share-sse.ts";
import { findSharePreset, resolveSharePresets, type SharePreset } from "../../share/presets.ts";
import { prepareShareBody } from "../../share/body-prep.ts";
import {
  buildShareSystemPrompt,
  buildShareUserPrompt,
  shareBodyKindForPageType,
} from "../../share/prompt.ts";
import { parseShareRequestBody, SHARE_LANGS } from "../../share/wire.ts";
import {
  acquireClaimRetry,
  claimRetryKey,
  neutralizePromptFence,
  shapeClaimTitle,
  streamFactcheckRetrySSE,
  CLAIM_INDEX_MAX,
  CLAIM_TITLE_MAX,
} from "./factcheck-retry-sse.ts";
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
import {
  hasPendingMessage,
  setPendingMessage,
  setPendingMessageIfAbsent,
} from "../../chat/pending-messages.ts";
import {
  createThread,
  findThreadByName,
  getThreadById,
  updateThreadConnector,
} from "../../db/threads.ts";
import { getConnector, listConnectorOptions } from "../../db/connectors.ts";
import { isValidUuid, readonlyRefusal as sharedReadonlyRefusal } from "./route-utils.ts";
import type { ConnectorType } from "../../bots/config.ts";
import {
  articleThreadTagMatches,
  buildArticleChatSeed,
  buildArticleThreadDescription,
  buildAskChatSeed,
  buildDirectChatSeed,
  deriveAskThreadTitle,
  deriveAskThreadTitleOrNull,
  truncateUnits,
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
  postCollectionUpdate,
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
import { getBotDefaultUser, getChatPreferences } from "../../db/chat-preferences.ts";
import { activityLog } from "../../observability/activity-log.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki");

/** The shared `readonlyRefusal` (`route-utils.ts`) bound to this file's logger,
 *  as the FIRST statement of this file's model-spending write routes. */
const readonlyRefusal = (c: Context) => sharedReadonlyRefusal(c, log);

/**
 * The PER-WIKI egress prologue: refuse, with a 403, every route that would spend
 * a model call (or reach the live web, or seed a chat thread) on a wiki whose
 * root is listed in `WIKI_READONLY_ROOTS`.
 *
 * **Why this is a separate guard from `readonlyRefusal`.** That one is
 * instance-wide and runs as a route's FIRST statement, before any wiki is
 * resolved — deliberately, so the refusal costs nothing. A per-wiki rule inverts
 * that ordering by construction: it cannot answer until the entry is known. So
 * it is a prologue placed immediately after `resolveWikiRequest` (or after the
 * shared target resolver, where one exists) and BEFORE bot resolution, the index
 * read, the DB thread, the `/agents` run registration and the one-shot.
 *
 * **Why registration alone is not safe.** Registering a root as a browsable wiki
 * buys three surfaces, not two: file writes (the three seams), local reads
 * (bounded by `DASHBOARD_HOST=127.0.0.1`) — and this set of `?wiki=`-steerable
 * routes, two of which reach the live web through the fact-check prompt's
 * WebFetch/search instructions. `DASHBOARD_HOST` does not bound that, and a
 * bot-less standalone wiki does NOT fail bot resolution: `resolveWikiSynthesisBot`
 * falls through to `resolveResearchBot` for any entry with no pin and
 * `source !== "bot"`, so every one of these routes resolves a bot and runs.
 *
 * Enforcement reads the ROOT, never `entry.readonly` — the registry flag is
 * presentation, and a stale memo must not be able to open the guard.
 *
 * **And it reads the root even when there is no ENTRY.** `resolveWikiRequest`
 * returns `entry: undefined` for the `WIKI_DIR` env-override shape (a bare
 * `/wiki` on an instance that sets the var), and those routes go on to serve
 * `resolveWikiRoot(undefined)` — so keying the refusal on the entry made the
 * guard fail OPEN on exactly the root an operator pointed the env var at. The
 * fallback resolves the same root the store would, through the same function.
 *
 * `optionalResponder` exists for `/api/wiki/digest`, whose refusal body is not
 * the shared `{error}` shape (the What's-new card reads `error` as "generation
 * FAILED — keep the old digest and offer a retry", and a policy refusal is not a
 * failure). It gets the resolved wiki label so its own body can name it, rather
 * than re-spelling the resolution and drifting from this one.
 */
function egressRefusal(
  c: Context,
  entry: WikiRegistryEntry | undefined,
  optionalResponder?: (wikiLabel: string, reason: string) => Response,
) {
  const root = entry?.root ?? resolveWikiRoot(undefined);
  if (!isReadonlyWikiRoot(root)) return null;
  const wiki = entry?.name ?? "";
  log.info("Read-only wiki {wiki} refused {method} {path} (no model calls)", {
    wiki: wiki || "(WIKI_DIR override)",
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });
  const reason = wikiNoEgressReason(wiki);
  if (optionalResponder) return optionalResponder(wiki, reason);
  return c.json({ error: reason, readonly: true }, 403);
}

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
  /** The thread of this name for this user+bot, INCLUDING its description — which
   *  is what says whether an article-mode collision is this article's own
   *  discussion thread or an unrelated thread that merely owns the name (see
   *  `articleThreadTagMatches`). The real `findThreadByName` selects the whole
   *  row, so carrying it costs nothing and saves a second lookup. */
  findThreadByName: (
    userId: string,
    botName: string,
    name: string,
  ) => Promise<{ id: string; name: string; description?: string } | null>;
  createThread: (
    userId: string,
    botName: string,
    name: string,
    description?: string,
    connectorId?: string,
  ) => Promise<{ id: string }>;
  setPendingMessage: (threadId: string, text: string, meta?: { title?: string }) => void;
  /** Whether a seed is STILL queued (unopened, unexpired) on a thread — a cheap
   *  fail-fast so the common "already queued" case refuses BEFORE any side effect
   *  (connector stamp, conversation shell). Not the race guard; see below. */
  hasPendingMessage: (threadId: string) => boolean;
  /** Queue a seed ONLY if the thread carries none — the atomic form of the
   *  peek-then-write pair. The pending store is last-write-wins, so seeding a
   *  thread that already holds an unconsumed question would destroy it, and the
   *  peek above is separated from the write by several awaits (connector lookup,
   *  the connector stamp, the conversation shell). Returns false ⇒ 409. */
  setPendingMessageIfAbsent: (
    threadId: string,
    text: string,
    meta?: { title?: string },
  ) => boolean;
  /** Named connector rows, for the reader's connector picker (`GET
   *  /api/wiki/chat-target`). A seam because tests must never touch the live DB. */
  listConnectors: () => Promise<{ id: string; name: string; connectorType: ConnectorType }[]>;
  /** The user+bot's persisted sidebar connector preference — folded into `GET
   *  /api/wiki/chat-target` so the popover's common path is ONE fetch. */
  getPreferredConnector: (userId: string, botName: string) => Promise<string | null>;
  /** One connector row — validates a posted `connectorId` before it reaches
   *  `createThread`'s FK. */
  getConnector: (id: string) => Promise<{ id: string; connectorType: ConnectorType } | null>;
  /** The thread an `existingThreadId` names, so the route can verify it really
   *  belongs to the resolved user+bot before seeding a question onto it. */
  getThreadById: (
    threadId: string,
  ) => Promise<{
    id: string;
    userId: string;
    botName: string;
    connectorId?: string;
    /** Carries the article tag on an article thread — a "Send there →" naming a
     *  thread that isn't this article's must not be seeded. */
    description?: string;
  } | null>;
  /** Stamp a connector on an EXISTING thread — only ever called when that thread
   *  carries none, so an established thread keeps the model it has been using. */
  updateThreadConnector: (threadId: string, connectorId: string | null) => Promise<boolean>;
  /** The web-conversation shell for this user+bot, by its DETERMINISTIC id
   *  (`deterministicId("<user>:<bot>:web")`) — the same shell `hydrateFromDb` and
   *  every other web-conversation creator address. A randomly-id'd shell would
   *  leave later off-band broadcasters (dev_run roll-ups, hivemind replies routed
   *  via `botConversationId`) talking to a different conversation than the tab the
   *  reader just opened. */
  findOrCreateConversation: (params: {
    botName: string;
    userId: string;
    username: string;
  }) => Promise<{ id: string }>;
}
const defaultAskChatDeps: AskChatDeps = {
  discoverBots: discoverAllBots,
  loadChatConfig,
  getBotDefaultUser,
  findThreadByName,
  createThread,
  setPendingMessage,
  hasPendingMessage,
  setPendingMessageIfAbsent,
  listConnectors: listConnectorOptions,
  getPreferredConnector: async (userId, botName) =>
    (await getChatPreferences(userId, botName)).preferredConnectorId,
  getConnector,
  getThreadById,
  updateThreadConnector,
  findOrCreateConversation: (params) => chatState.findOrCreateBotConversation(params),
};
let askChatDeps: AskChatDeps = defaultAskChatDeps;

/** How many `-2`, `-3`… disambiguators a `forceNew` escalation walks before
 *  giving up (bounded — each step is a `findThreadByName` round-trip). */
const ASK_CHAT_NAME_ATTEMPTS = 50;

/** Test-only: override (pass a partial) or reset (no arg) the ask→chat deps. */
export function __setAskChatDepsForTest(over?: Partial<AskChatDeps>): void {
  askChatDeps = over ? { ...defaultAskChatDeps, ...over } : defaultAskChatDeps;
}

/** Why a wiki has no chat target. Each maps 1:1 onto one of the POST's existing
 *  400 bodies, whose exact strings are pinned by tests — the POST spells the
 *  message, this only says which one. */
export type AskChatTargetFailure = "unknown_bot" | "bot_gone" | "needs_bot";

/** Resolved chat target for a wiki: which bot the thread lands on, that bot's
 *  users, and the `bot_default_user` mapping when it names one of them. */
export type AskChatTarget =
  | {
      ok: true;
      botConfig: BotConfig;
      /** Every discovered bot. Carried on the ok path only for callers that need
       *  the full list; the popover's bot picker exists only for a wiki that did
       *  NOT resolve, so `GET /api/wiki/chat-target` deliberately does not ship
       *  this on its ok path (the client caches the list from the failure
       *  response it opened with). */
      bots: { name: string }[];
      users: { id: string; name: string }[];
      /** The bot's `bot_default_user`, **only when it is a member of `users`**.
       *  A stale mapping pointing at a user this bot no longer has resolves to
       *  null rather than a picked id nothing can honor. */
      defaultUserId: string | null;
    }
  | { ok: false; reason: AskChatTargetFailure; bots: { name: string }[] };

/**
 * Which bot a wiki's chat escalation belongs to, plus its users.
 *
 * Shared by `POST /api/wiki/ask/chat` and `GET /api/wiki/chat-target` — one
 * implementation, so the endpoint the popover prefills from can never disagree
 * with the endpoint that does the work.
 *
 * Bot routing (unchanged, see the POST): explicit override → the wiki's owner →
 * a standalone wiki's synthesis-bot pin → `needs_bot`.
 *
 * **Deliberate deviation from the POST's old inline code:** the mapping is
 * resolved unconditionally rather than only when the bot has >1 user. That is
 * one extra cheap query on the sole-user path and it is what lets the GET
 * prefill a user picker; the membership filter above keeps it from changing any
 * decision the sole-user path used to make (which never consulted the mapping).
 */
export async function resolveAskChatTarget(
  entry: { name: string; source: string; synthesisBot?: string },
  wantedBot: string,
  deps: AskChatDeps,
): Promise<AskChatTarget> {
  const allBots = deps.discoverBots();
  const bots = allBots.map((b) => ({ name: b.name }));
  const findBot = (name: string): BotConfig | undefined =>
    allBots.find((b) => b.name.toLowerCase() === name.toLowerCase());

  let botConfig: BotConfig | undefined;
  if (wantedBot) {
    botConfig = findBot(wantedBot);
    if (!botConfig) return { ok: false, reason: "unknown_bot", bots };
  } else if (entry.source === "bot") {
    botConfig = findBot(entry.name);
    if (!botConfig) return { ok: false, reason: "bot_gone", bots };
  } else {
    // Pin, validated against discovered bots — a pin naming no bot falls through
    // to `needs_bot` (same "warn + ignore" posture as `resolveWikiSynthesisBot`),
    // never to an arbitrary pick.
    const pin = typeof entry.synthesisBot === "string" ? entry.synthesisBot.trim() : "";
    botConfig = pin ? findBot(pin) : undefined;
    if (!botConfig) return { ok: false, reason: "needs_bot", bots };
  }

  // Concurrent: the two queries are independent, and this runs on every popover
  // open as well as on every escalation.
  const [chatConfig, mapped] = await Promise.all([
    deps.loadChatConfig(botConfig.name),
    // A `bot_default_user` lookup is a CONVENIENCE — it resolves the multi-user
    // case without a picker. Making it unconditional (so the GET can prefill)
    // also handed every sole-user escalation a brand-new way to 500, on a query
    // that path never needed. Degrade to "no mapping", which is a state the
    // callers already handle.
    deps.getBotDefaultUser(botConfig.name).catch((err: unknown) => {
      log.warn("Wiki chat target: bot_default_user lookup failed for {bot}: {error}", {
        bot: botConfig!.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
  ]);
  const users = (chatConfig?.users ?? []).map((u) => ({ id: u.id, name: u.name }));
  const defaultUserId = mapped && users.some((u) => u.id === mapped) ? mapped : null;
  return { ok: true, botConfig, bots, users, defaultUserId };
}

/** The message each {@link AskChatTargetFailure} carries. ONE spelling, shared by
 *  the POST's 400 bodies and the GET's `error` field — the two had already drifted
 *  (the POST's `needs_bot` copy names the escalation, the GET's named the popover)
 *  while the tests pinned both. */
export function askChatTargetErrorMessage(
  reason: AskChatTargetFailure,
  wikiName: string,
  wantedBot: string,
): string {
  if (reason === "unknown_bot") return `Unknown bot "${wantedBot}"`;
  if (reason === "bot_gone") return `Bot "${wikiName}" is no longer configured`;
  return (
    `The "${wikiName}" wiki belongs to no bot, so there is no chat to continue in ` +
    "— pass an explicit bot to escalate anyway."
  );
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
 * The `/api/wiki/factcheck` preflight decision chain, extracted as a pure function
 * for the same reason `resolveExplainPreflight` was — and, since the claim-retry
 * route (`GET /api/wiki/factcheck/claim`) runs the identical chain, so that the
 * load-bearing web-tools-connector check cannot drift between two copies.
 *
 * Differs from Explain's in exactly two ways: fact-check is corpus-independent, so
 * there is NO collections check; and it needs a connector with web tools, so it
 * ADDS one. Order is preserved from the original inline chain: unknown wiki →
 * unloadable index → unknown page → non-web connector. The connector term is
 * guarded on `botConfig` being present — a bot-less wiki is not a connector
 * problem, and the scaffold reports it as the "no bots configured" app_error
 * instead (the route resolves `index`/`meta` only on the happy path, so a null
 * index / undefined meta from an earlier short-circuit is never reached below).
 *
 * Explainer pages are NOT a preflight error (they are reduced via `htmlToText`),
 * and a missing/unreadable file is not either — it degrades to an empty body.
 */
export function resolveFactcheckPreflight(input: {
  wiki: string;
  unknownWiki: boolean;
  entry: WikiRegistryEntry | undefined;
  index: WikiIndex | null;
  meta: WikiPageMeta | undefined;
  page: string;
  botConfig: BotConfig | null | undefined;
}): string | null {
  const { wiki, unknownWiki, entry, index, meta, page, botConfig } = input;
  if (unknownWiki || !entry) return `No wiki configured for "${wiki || "(none)"}".`;
  if (!index) return "wiki directory not found";
  if (!meta) return `No wiki page named "${page}".`;
  if (botConfig && !connectorCapabilities(botConfig).supportsWebTools) {
    return (
      `This wiki's bot (${botConfig.name}) can't run web fact-checks — its connector has no web tools. ` +
      `Point the wiki at a claude-cli or claude-sdk bot.`
    );
  }
  return null;
}

/**
 * Preflight for `POST /api/wiki/share` — the decision chain whose failures become
 * an `app_error` on the committed stream (never a 5xx, matching Ask/Explain/
 * fact-check).
 *
 * Deliberately SHORTER than `resolveFactcheckPreflight`: share needs no
 * collections (it summarizes one page, it retrieves nothing) and no web-tools
 * connector (the web pair is fenced OFF — see `SHARE_EXCLUDED_TOOLS`), so any
 * connector can write a post. The bot-less case is the scaffold's own
 * `noBotMessage`, so it is not repeated here.
 *
 * Explainer pages are NOT an error — they go through `prepareExplainerBody`.
 */
export function resolveSharePreflight(input: {
  wiki: string;
  unknownWiki: boolean;
  entry: WikiRegistryEntry | undefined;
  index: WikiIndex | null;
  meta: WikiPageMeta | undefined;
  page: string;
}): string | null {
  const { wiki, unknownWiki, entry, index, meta, page } = input;
  if (unknownWiki || !entry) return `No wiki configured for "${wiki || "(none)"}".`;
  if (!index) return "wiki directory not found";
  if (!meta) return `No wiki page named "${page}".`;
  return null;
}

/**
 * Model seam for `POST /api/wiki/share`, threaded into `ShareSseOptions.oneShot`.
 *
 * Null in production (the runner then uses the real `executeOneShot`). It exists
 * so a route test can drive the HAPPY path — body prep → prompt assembly → stream
 * → `done` → slot release — which is otherwise unreachable without spending a
 * real model call, and was therefore the one part of this route with no coverage.
 */
let shareOneShot: typeof executeOneShot | null = null;

/** Test-only: install (or clear, with no arg) the share one-shot. */
export function __setShareOneShotForTest(fn?: typeof executeOneShot): void {
  shareOneShot = fn ?? null;
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

/**
 * The strip and its measurement in ONE pass: the stripped body, plus how many
 * marks that strip ACTUALLY removed from these exact bytes. The ONE measurement
 * behind {@link supersededMarksNote}, so the ➕ append route and integrate PROPOSE
 * can never report different numbers for the same page — and, more importantly,
 * so neither can report a number its own write disproves.
 *
 * `removed` means "marks removed by this write", nothing narrower. That INCLUDES
 * a `<Fact>` quoted inside the previous `<!-- factcheck -->` region (a `Was:` line,
 * a hand-edit): the strip runs over the whole body, so the tag really does come
 * off — the fact that the region is then replaced wholesale doesn't unremove it.
 *
 * It is a delta rather than a bare `countFactWrappers(current)` because the count
 * and the strip must be derived from ONE evaluation, not from two calls a reader
 * has to prove equivalent. The old spelling took the count over a
 * `stripFactcheckBlock`ped body while the strip ran on the full one, and the two
 * disagree whenever removing the sentinel region changes FENCE PARITY:
 * `buildFactcheckAppendix` does not balance fences, so an appendix quoting an
 * unterminated ``` opens a CommonMark fence that runs to EOF and makes every mark
 * below it documentation. The strip then removes 0 while the count answered 2, and
 * the note, the log.md line and the commit subject all claimed a deletion the file
 * disproved.
 */
export function stripSupersededMarks(current: string): { body: string; removed: number } {
  const body = stripFactWrappers(current);
  return { body, removed: countFactWrappers(current) - countFactWrappers(body) };
}

/**
 * The SUPERSEDE rule made visible, in ONE spelling for the two fact-check write
 * routes that report it — integrate PROPOSE and the ➕ append route. (Integrate
 * APPLY strips too, but re-measures rather than reporting; the proposal the human
 * accepted already carried the note.) A RUN-level note, so a shrinking claim set
 * never reads as marks silently disappearing off the page.
 *
 * "marks", not "inline marks": a `<Fact>` owning its whole line is claimed by the
 * BLOCK parser and renders as a left rail rather than an underline (see
 * `src/web/CLAUDE.md`), and those count here too.
 *
 * The lead is a participial noun phrase with no finite verb — deliberately, since
 * the two callers sit on opposite sides of the write: integrate PROPOSE renders it
 * in a preview of a write that has not happened, ➕ returns it from one that has.
 * "N marks … superseded" is true read either way; "were superseded" or "will be"
 * would be false for one of them. `tail` is per route for the same reason the lead
 * is shared: the two writes leave the page in different states — integrate re-marks
 * it from this run's claims, while ➕ changes no prose and so removes the marks
 * without replacing them.
 *
 * Zero ⇒ undefined, i.e. no field at all: "0 superseded" is a sentence about an
 * event that did not happen.
 */
export function supersededMarksNote(count: number, tail: string): string | undefined {
  if (count <= 0) return undefined;
  return `${count} mark${count === 1 ? "" : "s"} from a previous check superseded — ${tail}`;
}

/** Listing shape sent to the client — meta plus connection counts for sorting. */
interface WikiPageListing extends WikiPageMeta {
  linkCount: number;
  backlinkCount: number;
}

function toListing(
  index: WikiIndex,
  meta: WikiPageMeta,
  opts: { includeDesc?: boolean } = {},
): WikiPageListing {
  // `desc` + `pubDate` are stripped by default: they are page-body fields no
  // LISTING consumer reads, and on jarvis they add ~100 KB to the hot
  // `/api/wiki/pages` payload.
  //
  // Nothing may join (or leave) this strip list without checking ALL THREE
  // callers, because they share this one function:
  //   1. `/api/wiki/pages`      — the hot listing. Strip.
  //   2. `/api/wiki/page` meta  — the single page the reader has open.
  //   3. `/api/wiki/page`'s `listings()` — the outgoing/backlink ARRAYS on that
  //      same response, which are link-heavy pages' bulk. Strip.
  // So a field stripped for payload size (e.g. `status_note`) also goes out of
  // reach of the reader, and a field opted IN for caller 2 must not be opted in
  // for caller 3, which would re-bloat exactly the pages this strip protects.
  //
  // `includeDesc` is that opt-in, passed ONLY by caller 2: the "💬 Discuss"
  // popover shows the open page's first prose line as a question HINT, and the
  // single-page response is the only place the reader's own page arrives.
  // `pubDate` stays Atlas-only (`GET /api/wiki/atlas` reads it directly off the
  // index, never through here).
  const { desc, pubDate, ...rest } = meta;
  void pubDate;
  return {
    ...rest,
    ...(opts.includeDesc && desc ? { desc } : {}),
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
    // Is the wiki being rendered registered read-only? Keyed on the ROOT that
    // will actually be served — including the `WIKI_DIR` env-override shape,
    // where there is no entry at all and an `entry`-keyed read would render a
    // page whose client half thinks the wiki is writable while every route 403s.
    const readonlyWiki = isReadonlyWikiRoot(entry?.root ?? resolveWikiRoot(undefined));
    // Resolved synthesis bot for the Ask tab's "Answered by …" line — same
    // owner-routing the ask/digest handlers use, computed at render time so
    // the tab can say who will answer before a question is asked. Skipped on a
    // read-only wiki: nothing there will ever answer, so naming a bot (and a
    // "research-bot fallback" origin) describes a call that cannot happen.
    let askBot: { bot: string; connector: string; model: string; origin: "pinned" | "owner" | "fallback" } | null = null;
    if (entry && !readonlyWiki) {
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
        // Read from the ROOT, not `entry.readonly`: the render and the seams then
        // answer the same question the same way even if the memo were stale.
        readonlyWiki,
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
      // Wiki-readonly instance: refuse before the one-shot is even considered.
      // It drafts a PROPOSAL rather than a page, but a readonly instance must not
      // build a gate backlog it can never apply (nor spend the model call).
      const refused = readonlyRefusal(c);
      if (refused) return refused;
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
      // Per-wiki egress guard, BEFORE the overlay fetch and the drafting one-shot.
      // Collection-less today, so this route is unreachable for the memory wiki —
      // but it is the route a `collections` segment would light up, and the draft
      // it would persist is one the seam guard then refuses forever.
      const egress = egressRefusal(c, entry);
      if (egress) return egress;
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
    // Per-wiki egress guard: the digest is a `log.md` summarization one-shot on
    // the wiki's synthesis bot and is gated by NOTHING else (no collections
    // needed). A read-only root with a `log.md` would spend a model call on its
    // contents on the reader's first start-view load.
    //
    // The one refusal in this file that does NOT use the shared `error` key: the
    // What's-new card branches on `data.error` to mean "generation failed — keep
    // the old digest and offer a retry", and a policy refusal is not a failure.
    // `digest: null` with no `error` is the card's own "this wiki has none" state,
    // so it hides — while the 403 STATUS still makes the refusal observable, and
    // is what `wiki-start-cards.ts` keys its own suppression on.
    //
    // It goes through the shared `egressRefusal` with a body responder rather
    // than re-spelling the check: the decision, the root fallback and the log
    // line are the same on every route, only the body differs.
    const digestEgress = egressRefusal(c, entry, (_wiki, reason) =>
      c.json({ digest: null, readonly: true, reason }, 403),
    );
    if (digestEgress) return digestEgress;

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
    // Per-wiki egress guard. Reindexing ships every page BODY to huginn's
    // embedder — the one non-model way this wiki's content leaves the machine.
    // It is collection-gated today (a read-only root with no `wikiCollections`
    // returns the clean error below anyway), which is exactly why the guard is
    // worth stating: the gate is one `WIKI_EXTRA` third segment away from being
    // open, and that segment is a cosmetic-looking edit.
    const reindexEgress = egressRefusal(c, entry);
    if (reindexEgress) return reindexEgress;
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
      // The one caller that opts `desc` in — see `toListing`. Deliberately NOT
      // `listings()` below, whose arrays are the link-heavy pages' bulk.
      meta: toListing(index, meta, { includeDesc: true }),
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
    // Per-wiki egress guard, before bot resolution and the saved-notes lookup.
    // Collection-less today ⇒ this route already declines — but the decline is a
    // preflight message on a committed 200 stream, not a refusal, and a
    // `collections` segment would turn it into a real retrieval + synthesis run.
    const askEgress = egressRefusal(c, entry);
    if (askEgress) return askEgress;
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
    // Per-wiki egress guard — same reasoning as Ask, and Explain additionally
    // ships the reader's SELECTED passage into the prompt.
    const explainEgress = egressRefusal(c, entry);
    if (explainEgress) return explainEgress;
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
    // Per-wiki egress guard. THE critical one: fact-check is corpus-independent
    // (no collections gate) and its verify prompt instructs WebFetch + web search
    // per claim, so a claim extracted from a private memory page would leave the
    // machine as a search query. `DASHBOARD_HOST=127.0.0.1` does not bound that.
    const fcEgress = egressRefusal(c, entry);
    if (fcEgress) return fcEgress;
    // Owner-routing, identical to Ask/Explain.
    const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());

    // Preflight (never-5xx: app_error on the committed 200 stream). Fact-check
    // needs NO collections, so this chain omits Explain's collection check but
    // ADDS the web-tools connector check. Resolve index/meta only on the happy
    // path (unknown wiki short-circuits before any filesystem touch); the decision
    // chain itself is the pure `resolveFactcheckPreflight`, shared verbatim with
    // the claim-retry route below.
    let index: WikiIndex | null = null;
    let meta: WikiPageMeta | undefined;
    if (entry && !unknownWiki) {
      index = await getWikiIndex({ root: entry.root });
      if (index) meta = index.resolve(page);
    }
    const preflightError = resolveFactcheckPreflight({
      wiki,
      unknownWiki,
      entry,
      index,
      meta,
      page,
      botConfig,
    });

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
      baseHash,
      ...(bodyLen !== undefined ? { bodyLen } : {}),
      annotatable,
      // Same reader HTML pipeline as Ask/Explain (no citations — fact-check cites
      // raw URLs inline in the answer markdown, not numbered sources).
      renderAnswerHtml: (answer) => renderAskAnswerHtml(answer, []),
    });
  });

  // Wiki Fact check — RE-VERIFY ONE CLAIM (`GET /api/wiki/factcheck/claim`). The
  // server half of the reader's ↻ affordance on a claim that timed out, was
  // skipped, or crashed. Same SSE wire shape as the article route (heartbeat,
  // `app_error`, terminal `end`), same preflight chain, same web-tools connector
  // requirement — but ONE claim, no extraction phase, no fan-out, no compose.
  //
  // The claim text is CLIENT-SUPPLIED and re-extraction is not an option:
  // extraction is a model call and non-deterministic, so "claim 2" on a re-extract
  // need not be the claim that timed out. Every echoed field is therefore bounded
  // here (`title` truncated, `quote` dropped over-cap like `claimsEventPayload`,
  // `sel`/`ctx` on the article route's own caps, `index`/`total` small positive
  // integers). This is loopback-only and no worse than the existing integrate POST,
  // which accepts a whole client-posted answer — a stated decision: the bounds are
  // for accident and payload size, not trust.
  app.get("/api/wiki/factcheck/claim", async (c) => {
    const mode = c.req.query("mode") === "article" ? "article" : "sel";
    const page = c.req.query("page");
    if (!page) return c.json({ error: "Missing query parameter: page" }, 400);
    const sel = (c.req.query("sel") ?? "").trim().slice(0, FACTCHECK_SELECTION_MAX);
    if (mode === "sel" && !sel) return c.json({ error: "Missing query parameter: sel" }, 400);
    const ctx = (c.req.query("ctx") ?? "").trim().slice(0, FACTCHECK_HEADING_MAX) || undefined;

    // The claim itself, bounded AND shape-neutralized — two different jobs, stated
    // apart because they answer to different threats. BOUNDING (below) is for
    // accident and payload size, a non-trust decision this route makes explicitly.
    // SHAPE-NEUTRALIZING (`shapeClaimTitle` / `neutralizePromptFence`) protects the
    // verify prompt's DELIMITER CONTRACT: `buildClaimVerifyPrompt` writes the title
    // as one `CLAIM (n/m): …` line and fences the quote between `"""` markers, so a
    // raw newline or a client-supplied `"""` closes a block early and gets what
    // follows read as instruction rather than as quoted wiki text. The title's
    // newlines also reach the `/agents` run name, where they render a multi-line
    // card. Flatten BEFORE the length cap so the cap counts real content, and clip
    // surrogate-safely so an astral character can't be halved into a U+FFFD.
    //
    // `title` is presentation (it renders in the block heading), so an over-cap one
    // is TRUNCATED; `quote` is a RESOLUTION hint the model reads the claim's source
    // span from, so an over-cap one is DROPPED rather than truncated — the
    // `claimsEventPayload` rule, for the same reason. The quote's cap is tested on
    // the value the CLIENT sent (neutralizing only ever shortens), so the drop rule
    // stays keyed on the same number `claimsEventPayload` dropped on.
    const title = truncateUnits(shapeClaimTitle(c.req.query("title") ?? ""), CLAIM_TITLE_MAX);
    if (!title) return c.json({ error: "Missing query parameter: title" }, 400);
    const rawQuote = (c.req.query("quote") ?? "").trim();
    const quote =
      rawQuote && rawQuote.length <= CLAIM_QUOTE_MAX ? neutralizePromptFence(rawQuote) : undefined;

    const index1 = Number(c.req.query("index"));
    const total = Number(c.req.query("total"));
    const smallPositive = (n: number) => Number.isInteger(n) && n >= 1 && n <= CLAIM_INDEX_MAX;
    if (!smallPositive(index1) || !smallPositive(total) || index1 > total) {
      return c.json(
        { error: `index and total must be integers with 1 ≤ index ≤ total ≤ ${CLAIM_INDEX_MAX}` },
        400,
      );
    }

    const registry = getWikiRegistry();
    const { entry, unknownWiki, wiki } = resolveWikiRequest(
      registry,
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    // Per-wiki egress guard — same family, same web reach, one claim at a time.
    const claimEgress = egressRefusal(c, entry);
    if (claimEgress) return claimEgress;
    // Owner-routing, identical to the article fact-check route.
    const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());

    let index: WikiIndex | null = null;
    let meta: WikiPageMeta | undefined;
    if (entry && !unknownWiki) {
      index = await getWikiIndex({ root: entry.root });
      if (index) meta = index.resolve(page);
    }
    const preflightError = resolveFactcheckPreflight({
      wiki,
      unknownWiki,
      entry,
      index,
      meta,
      page,
      botConfig,
    });

    // sel-mode surrounding excerpt, located against the page AS IT IS NOW. The
    // persisted `sel` reconstructs the SELECTION, not the excerpt — so a page
    // edited since the original check can have moved or lost the passage, and the
    // locator degrades (to a nearby window, or to the head of the body). That is
    // acceptable and stated rather than papered over: the prompt frames this block
    // as "reference only", and the CLAIM being verified comes from the turn.
    let excerpt: string | undefined;
    if (!preflightError && index && meta && mode === "sel") {
      const raw = (await readWikiPage(index, meta)) ?? "";
      const text = meta.type === "explainer" ? htmlToText(raw) : raw;
      excerpt = locateExcerpt(stripFactcheckBlock(text), sel, ctx);
    }

    // Per-page single-flight. Bounding the INPUTS is not bounding the RATE: one GET
    // buys a tool-enabled 180s one-shot, so the page-scoped slot is the real spend
    // guard. An expired holder counts as free (evaluated lazily on this hit — no
    // sweeper to leak), and the 409 reports the holder's deadline so the client can
    // say when to try again. Only taken on the happy path: a preflight failure runs
    // no model call and must not wedge the page.
    let release: (() => void) | undefined;
    if (!preflightError && entry && meta) {
      const acquired = acquireClaimRetry(claimRetryKey(entry.name, meta.relPath));
      if (!acquired.ok) {
        return c.json({ state: "running", expiresAtMs: acquired.expiresAtMs }, 409);
      }
      release = acquired.release;
      log.info("Wiki factcheck retry: wiki={wiki} bot={bot} page={page} claim={index}/{total}", {
        wiki: entry.name,
        bot: botConfig?.name,
        page,
        index: index1,
        total,
      });
    }

    // The slot is handed over to the stream via `onSettled` — but only once
    // `streamFactcheckRetrySSE` has RETURNED a Response. A synchronous throw
    // between the acquire above and that return (a bad option shape, an OOM in
    // `streamSSE`'s own setup) would leave the callback unwired and wedge the page
    // for the full expiry with nothing running. Releasing here is safe precisely
    // because it is unreachable once the stream owns the slot: on the normal path
    // this `catch` never fires, and on the throwing path the scaffold's `finally`
    // never will. Release is identity-checked, so a double release is a no-op
    // anyway.
    try {
      return streamFactcheckRetrySSE(c, {
        config,
        botConfig: botConfig ?? null,
        preflightError,
        claim: { index: index1, total, title, ...(quote ? { quote } : {}) },
        meta: { title: meta?.title ?? page },
        wikiName: entry?.name ?? "",
        mode,
        ...(excerpt ? { excerpt } : {}),
        ...(mode === "sel" && ctx ? { ctx } : {}),
        ...(release ? { onSettled: release } : {}),
      });
    } catch (err) {
      release?.();
      throw err;
    }
  });

  // Share — the preset list the dialog's picker renders (`GET /api/wiki/share/presets`).
  //
  // Read-only and model-free. The presets are the SHIPPED set merged with the
  // resolved bot's own `prompts/share*.md` files, so the list is bot-dependent —
  // but a wiki with no resolvable bot still gets the shipped set and a `bot: null`
  // rather than an error: the picker and the editable prompt panel are useful
  // before Generate is ever pressed, and the bot-less case is reported where it
  // actually bites (an `app_error` on the generate stream).
  //
  // The preset CONTENT rides along because the dialog shows the prompt and lets
  // the reader edit it — that is the whole "visible/editable prompt panel", and
  // fetching one body per picker change would be a round-trip per click.
  app.get("/api/wiki/share/presets", (c) => {
    // `no-store`, for the same reason `/api/wiki/pages` carries it (see the note
    // there): with no freshness information at all a browser may heuristically
    // cache this (RFC 9111 §4.2.2). The failure is a closed loop — the dialog
    // renders a preset id from a stale list, the POST 400s "unknown share preset",
    // and a reload replays the same cached list. The list is bot-derived and
    // changes whenever a bot's `prompts/share*.md` files do.
    c.header("Cache-Control", "no-store");
    const { entry, unknownWiki, wiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki || !entry) {
      return c.json({ error: `No wiki configured for "${wiki || "(none)"}".` }, 404);
    }
    const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());
    return c.json({
      bot: botConfig?.name ?? null,
      presets: resolveSharePresets(botConfig?.prompts),
      langs: SHARE_LANGS,
    });
  });

  // Share — generate a pasteable post from one wiki page (`POST /api/wiki/share`, SSE).
  //
  // **POST, because the reader can EDIT the prompt** before pressing Generate, and
  // an edited preset does not belong in a query string. It is also the first
  // POST+SSE route in this family, which makes the ORDERING below load-bearing
  // rather than stylistic: every body check — missing fields, both text caps, an
  // unknown preset id — runs and returns a plain JSON 400 BEFORE
  // `streamShareSSE` is called. Once `streamSSE` has committed a 200 the only way
  // to report a validation failure is an `app_error` inside a successful response,
  // where no client can tell it from a model failure and no status code says the
  // request was malformed. The route tests pin each of these as a pre-commit 400.
  //
  // `page` is the page NAME, resolved with `index.resolve(page)` exactly as
  // `/api/wiki/explain`, `/factcheck` and `/similar` do — NOT a relPath (which
  // carries directories and an extension, and which the reader's client does not
  // hold for the page it has open).
  //
  // Over-cap text is a 400 and NEVER a truncation: a silently shortened prompt
  // changes what the model was asked without telling anyone, and the reader reads
  // the result as an answer to the instruction they wrote.
  app.post("/api/wiki/share", async (c) => {
    // Wrapped like `remember` / `factcheck/append` / `integrate`: an unexpected
    // throw anywhere below returns 500 JSON rather than an unhandled rejection.
    // The inner handover `catch` rethrows AFTER releasing the slot, so a throw on
    // that path still frees the page and lands here.
    try {
      type ShareBody = {
        wiki?: string;
        bot?: string;
        page?: string;
        preset?: string;
        lang?: string;
        promptOverride?: string;
        extra?: string;
      };
      const body = await c.req.json<ShareBody>().catch(() => ({}) as ShareBody);

      // Every body-shape check — the type-check loop (a non-string `wiki` used to
      // reach `rawWiki.trim()` inside `resolveWikiRequest` and 500), the required
      // fields, the language, both caps and the present-but-BLANK
      // `promptOverride` — is the shared `parseShareRequestBody`, so the
      // /summaries twin cannot answer the same malformed body differently.
      //
      // **The ordering rule for this route: BODY-SHAPE checks precede
      // RESOLUTION-DEPENDENT ones.** Everything in the parser needs nothing but
      // the body and is wrong under every wiki, while the unknown-preset check
      // below deliberately waits, because the valid preset set is a function of
      // the resolved wiki's bot. Both are still pre-`streamSSE`, which is the
      // invariant that actually matters.
      const parsed = parseShareRequestBody(body as Record<string, unknown>, {
        stringFields: ["wiki", "bot", "page", "preset", "promptOverride", "extra"],
        required: ["page", "preset"],
      });
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const page = parsed.body.values.page ?? "";
      const presetId = parsed.body.preset;
      const { lang, promptOverride, extra } = parsed.body;

      // The RAW `body.wiki`/`body.bot`, deliberately NOT the parser's trimmed
      // `parsed.body.values.*`: the parser only TYPE-checks these two (neither is
      // `required`), and `resolveWikiRequest` owns its own trimming and
      // absent-vs-blank rule. Feeding it the parser's values instead — where
      // absent arrives as `""` — is behaviour-identical only because that rule
      // treats both as unset; keeping the raw values means resolution does not
      // silently depend on the parser's normalization. Not an oversight.
      const { entry, unknownWiki, wiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki") ?? body.wiki,
        c.req.query("bot") ?? body.bot,
        process.env.WIKI_DIR,
      );
      // Per-wiki egress guard, before bot/preset resolution and well before the
      // single-flight slot. Share needs no collections either — one click turns a
      // whole page into distribution-ready text.
      const shareEgress = egressRefusal(c, entry);
      if (shareEgress) return shareEgress;
      // Owner-routing, identical to Ask / fact-check / integrate.
      const { bot: botConfig } = resolveWikiSynthesisBot(entry, discoverAllBots());

      let index: WikiIndex | null = null;
      let meta: WikiPageMeta | undefined;
      if (entry && !unknownWiki) {
        index = await getWikiIndex({ root: entry.root });
        if (index) meta = index.resolve(page);
      }
      let preflightError = resolveSharePreflight({ wiki, unknownWiki, entry, index, meta, page });

      // **Preset validation runs after the WIKI is resolved, and independently of
      // the bot** — the resolution-dependent half of the ordering rule stated at
      // the blank-`promptOverride` 400 above. Two orderings were wrong before:
      //   · preset-first reported `unknown share preset "…"` for a request whose
      //     real problem was an unknown WIKI — the reader picked a preset that is
      //     perfectly valid for the wiki they meant. The wiki's own failure is the
      //     one worth reporting, so a failed preflight skips this check and lets the
      //     stream say what is actually wrong.
      //   · gating on `botConfig` skipped it entirely on a zero-bot install, and the
      //     bogus id sailed past into a committed-200 app_error. A bot's
      //     `prompts/share*.md` files only override or EXTEND the shipped set, so
      //     `resolveSharePresets(undefined)` is a sound list to validate against
      //     whenever no bot resolved.
      let preset: SharePreset | undefined;
      if (!preflightError) {
        preset = findSharePreset(resolveSharePresets(botConfig?.prompts), presetId);
        if (!preset) return c.json({ error: `unknown share preset "${presetId}"` }, 400);
      }

      // Body prep — the intended (and only) consumer of PR A's `prepareShareBody`
      // dispatcher: the page's `type` picks the preparer, an explainer going through
      // the HTML reduction and everything else through the markdown strips.
      let systemPrompt = "";
      let userPrompt = "";
      if (!preflightError && entry && index && meta && preset) {
        const raw = (await readWikiPage(index, meta)) ?? "";
        const prepared = prepareShareBody(shareBodyKindForPageType(meta.type), raw);
        if (!prepared.trim()) {
          // Nothing to summarize. Reported before the slot is taken, so an empty
          // page can neither spend a model call nor wedge the page.
          preflightError = `"${meta.title}" has no text to summarize.`;
        } else {
          systemPrompt = buildShareSystemPrompt(entry.name);
          userPrompt = buildShareUserPrompt({
            // The reader's edit REPLACES the preset's instruction; the language
            // rider is appended after it either way (see `buildShareUserPrompt`).
            instruction: promptOverride.trim() || preset.content,
            lang,
            extra: extra.trim(),
            body: prepared,
            title: meta.title,
            wikiName: entry.name,
          });
        }
      }

      // Per-page single-flight. One POST buys a whole-page summarization (tens of
      // thousands of input tokens), and a double-click, a reload mid-stream or a
      // second tab each buy another — this is the only guard that survives all
      // three. Taken ONLY when a model call will actually run: `userPrompt` is
      // non-empty exactly when preflight, the page read and the body prep all
      // succeeded, and `botConfig` is what the scaffold needs to get past its
      // "no bots configured" app_error. Without the bot term a bot-less install
      // reserved the page for two minutes to emit a refusal.
      let release: (() => void) | undefined;
      if (botConfig && userPrompt && entry && meta) {
        const acquired = acquireShareFlight(shareFlightKey(entry.name, meta.relPath));
        if (!acquired.ok) {
          // `error` rides along with the machine-readable pair so a caller that
          // is not the dialog (curl, a future surface) gets a sentence rather
          // than having to know what `{state:"running"}` means. The dialog
          // ignores it — its own `shareConflictCopy` owns the countdown.
          return c.json(
            {
              state: "running",
              expiresAtMs: acquired.expiresAtMs,
              error: WIKI_SHARE_COPY.conflictLead,
            },
            409,
          );
        }
        release = acquired.release;
        log.info("Wiki share: wiki={wiki} bot={bot} page={page} preset={preset} lang={lang}", {
          wiki: entry.name,
          bot: botConfig.name,
          page,
          preset: presetId,
          lang,
        });
      }

      // The slot is handed to the stream via `onSettled` — but only once
      // `streamShareSSE` has RETURNED a Response. A synchronous throw before that
      // would leave the callback unwired and wedge the page for the full expiry with
      // nothing running; releasing here is safe precisely because it is unreachable
      // once the stream owns the slot (release is identity-checked anyway). The
      // claim-retry route's handover, verbatim.
      try {
        return streamShareSSE(c, {
          config,
          botConfig: botConfig ?? null,
          preflightError,
          systemPrompt,
          userPrompt,
          runName: `Share: ${meta?.title ?? page}`,
          // Test seam — production leaves it unset. Without it no route test can
          // reach `done`, so the prepareShareBody → buildShareUserPrompt →
          // streamShareSSE wiring had no coverage at all.
          ...(shareOneShot ? { oneShot: shareOneShot } : {}),
          ...(release ? { onSettled: release } : {}),
        });
      } catch (err) {
        release?.();
        throw err;
      }
    } catch (err) {
      log.error("Wiki share failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "share failed" }, 500);
    }
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

      // Per-wiki egress guard. `/remember` writes a Postgres row, not a file —
      // which is why the INSTANCE flag deliberately leaves it alone — but it
      // still spends a Haiku distill + an embedding on wiki-scoped text, so it is
      // on the egress list rather than the write list.
      const rememberEgress = egressRefusal(c, entry);
      if (rememberEgress) return rememberEgress;

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

  // Where would a chat escalation from this wiki LAND? Everything the reader's
  // escalation popover prefills from, in one fetch: the resolved bot, its users +
  // default-user mapping, and the connector choices with their web-search
  // capability already decided server-side.
  //
  // It exists because the reader client holds only `window.__WIKI_NAME__`: a wiki
  // name is not a bot name on standalone wikis, and the bot that ANSWERED the Ask
  // turn (`resolveWikiSynthesisBot`) can differ from the bot the chat lands on.
  // Resolution therefore has to happen server-side — through the same
  // `resolveAskChatTarget` the POST uses, so the popover can never prefill a
  // target the POST would reject.
  //
  // `?bot=` here is the CHAT-bot override (mirroring the POST's body field), not
  // the legacy wiki alias — the popover re-fetches with it whenever its bot picker
  // changes, since users/defaultUserId/botDefault are all bot-keyed. The legacy
  // wiki alias is unavailable on this route for that reason; `?wiki=` names the wiki.
  app.get("/api/wiki/chat-target", async (c) => {
    try {
      const { entry, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki"),
        undefined,
        process.env.WIKI_DIR,
      );
      if (unknownWiki || !entry) {
        return c.json({ error: "no wiki configured for that name" }, 404);
      }
      const wanted = (c.req.query("bot") ?? "").trim();
      // Connector rows are bot-INDEPENDENT, so the listing runs concurrently with
      // the (bot-keyed) target resolution rather than after it.
      const connectorsPromise = askChatDeps
        .listConnectors()
        .then((rows) => ({
          connectors: rows.map((row) => ({
            id: row.id,
            name: row.name,
            connectorType: row.connectorType,
            // Capability is flagged HERE, not in the browser: `connectorCapabilities`
            // can't run client-side, and re-deriving it from a second hardcoded list
            // of connector types is exactly the drift that makes a picker promise a
            // bot web search it doesn't have.
            supportsWebTools: capabilitiesForConnectorType(row.connectorType).supportsWebTools,
          })),
          connectorsError: undefined as string | undefined,
        }))
        .catch((err: unknown) => {
          // A dead connectors table must not cost the reader the whole popover —
          // "(bot default)" alone is a complete, working choice. The client RENDERS
          // this string, so the degrade is visible rather than a silently short list.
          const connectorsError = err instanceof Error ? err.message : String(err);
          log.warn("Wiki chat-target: connector listing failed: {error}", { error: connectorsError });
          return { connectors: [], connectorsError };
        });

      const target = await resolveAskChatTarget(entry, wanted, askChatDeps);
      if (!target.ok) {
        void connectorsPromise;
        // The reason rides through as the client's ONLY branch key — `needs_bot`
        // renders the popover's bot picker, the other two render the message.
        // `bots` is meaningful only here (the picker's options).
        return c.json({
          botName: null,
          reason: target.reason,
          error: askChatTargetErrorMessage(target.reason, entry.name, wanted),
          bots: target.bots,
        });
      }
      const { connectors, connectorsError } = await connectorsPromise;
      // The user+bot sidebar preference the popover would otherwise fetch in a
      // SECOND round-trip right after this one. Folded in for the user the client
      // would resolve WITHOUT a remembered override (the mapping, else a sole
      // user), and stamped with WHICH user it belongs to — a preference is per
      // user+bot, so a client that lands on a different user must still refetch
      // rather than silently apply someone else's model.
      const preferredForUserId =
        target.defaultUserId ?? (target.users.length === 1 ? target.users[0]!.id : null);
      let preferredConnectorId: string | null = null;
      if (preferredForUserId) {
        preferredConnectorId = await askChatDeps
          .getPreferredConnector(preferredForUserId, target.botConfig.name)
          .catch(() => null);
      }
      const botDefaultType = target.botConfig.connector ?? "claude-cli";
      return c.json({
        botName: target.botConfig.name,
        users: target.users,
        defaultUserId: target.defaultUserId,
        preferredForUserId,
        preferredConnectorId,
        connectors,
        connectorsError,
        botDefault: {
          connectorType: botDefaultType,
          model: target.botConfig.model,
          supportsWebTools: capabilitiesForConnectorType(botDefaultType).supportsWebTools,
        },
      });
    } catch (err) {
      log.error("Wiki chat-target: unexpected failure: {error}", {
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
        /** `"direct"` = the reader typed a question WITHOUT asking the wiki first,
         *  so there is no answer to quote. `"article"` = the same, but asked while
         *  reading ONE page, which the seed names and paths. An explicit
         *  discriminator, never an inference from a missing `answer`: a client bug
         *  that drops the answer must still 400 rather than silently escalate a
         *  context-free seed. */
        mode?: string;
        /** Article mode: which page the question is about. `relPath` is tried
         *  first (collision-proof, as on `GET /api/wiki/page`) and `page` — the
         *  page NAME — is the fallback when it resolves nothing, which is what a
         *  rename leaves an open tab holding. Error copy quotes whichever
         *  reference was actually sent, both when both were. */
        page?: string;
        relPath?: string;
        /** Direct mode only: this question reached chat from an Ask the wiki
         *  DECLINED, so the seed must not order the search that just failed. */
        askDeclined?: boolean;
        connectorId?: string;
        threadName?: string;
        existingThreadId?: string;
      };
      const body = await c.req.json<AskChatBody>().catch(() => ({}) as AskChatBody);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      const direct = body.mode === "direct";
      // Article mode is the "💬 Discuss" button on an open page: no Ask turn, no
      // answer — but a page whose title/path/summary the seed carries.
      const article = body.mode === "article";
      if (!question) return c.json({ error: "question is required" }, 400);
      if (!answer && !direct && !article) return c.json({ error: "answer is required" }, 400);
      // Body shape is client-controlled: a non-string `wiki` (or a citation whose
      // pageName is a number) reached string methods and 500'd. Everything the
      // route reads is therefore validated or coerced HERE, before any side effect.
      if (body.wiki !== undefined && typeof body.wiki !== "string") {
        return c.json({ error: "wiki must be a string" }, 400);
      }
      if (body.bot !== undefined && typeof body.bot !== "string") {
        return c.json({ error: "bot must be a string" }, 400);
      }
      if (body.userId !== undefined && typeof body.userId !== "string") {
        return c.json({ error: "userId must be a string" }, 400);
      }
      for (const field of [
        "connectorId", "threadName", "existingThreadId", "page", "relPath",
      ] as const) {
        if (body[field] !== undefined && typeof body[field] !== "string") {
          return c.json({ error: `${field} must be a string` }, 400);
        }
      }
      if (body.askDeclined !== undefined && typeof body.askDeclined !== "boolean") {
        return c.json({ error: "askDeclined must be a boolean" }, 400);
      }
      // Article mode needs a page REFERENCE, and its absence is a body-shape
      // problem like every other check in this block — so it is answered here,
      // beside them, rather than after bot resolution. A wiki whose bot is gone
      // used to answer a page-less article POST with "belongs to no bot", which
      // is true but not the thing the caller got wrong.
      const pageRef = typeof body.page === "string" ? body.page.trim() : "";
      const relPathRef = typeof body.relPath === "string" ? body.relPath.trim() : "";
      if (body.mode === "article" && !pageRef && !relPathRef) {
        return c.json({ error: "page is required in article mode" }, 400);
      }
      const connectorId = typeof body.connectorId === "string" ? body.connectorId.trim() : "";
      // A non-UUID reaching `getConnector`'s uuid-column WHERE is a Postgres error,
      // i.e. a 500 out of the blanket catch — every sibling route guards first.
      if (connectorId && !isValidUuid(connectorId)) {
        return c.json({ error: "connectorId must be a UUID" }, 400);
      }
      const rawCitations = Array.isArray(body.citations) ? body.citations : [];
      const badCitation = rawCitations.some(
        (ci) =>
          !ci ||
          typeof ci !== "object" ||
          (ci.pageName !== undefined && typeof ci.pageName !== "string") ||
          (ci.title !== undefined && typeof ci.title !== "string"),
      );
      if (badCitation) {
        return c.json({ error: "citations[].pageName and .title must be strings" }, 400);
      }
      // Entries carrying neither name are simply dropped (nothing to show).
      const citations: AskChatCitation[] = rawCitations.filter((ci) => ci.pageName || ci.title);

      const { entry, unknownWiki } = resolveWikiRequest(
        getWikiRegistry(),
        c.req.query("wiki") ?? body.wiki,
        c.req.query("bot"),
        process.env.WIKI_DIR,
      );
      if (unknownWiki || !entry) {
        return c.json({ error: "no wiki configured for that name" }, 404);
      }
      // Per-wiki egress guard, before the DB thread, the conversation shell and
      // the pending-message seed. ALL THREE modes, not just `article`: escalate
      // quotes an Ask answer over this wiki's pages, article carries the page's
      // relPath + summary, and direct seeds a bot told to search this wiki first.
      const chatEgress = egressRefusal(c, entry);
      if (chatEgress) return chatEgress;

      // Owning bot (or the explicit override), its users, and its default-user
      // mapping — the shared `resolveAskChatTarget`, so `GET /api/wiki/chat-target`
      // (which the popover prefills from) resolves through the SAME code. A
      // standalone `WIKI_EXTRA` wiki has no owner but MAY carry a synthesis-bot pin
      // (the 4th `WIKI_EXTRA` segment / `wikiSynthesisBot`), which is the operator
      // naming the bot that speaks for this wiki; without it the button is dead on
      // every standalone wiki (on this install: mimir and melosys-kode-wiki, i.e. 2
      // of 3). Only a wiki with NEITHER an owner nor a pin 400s rather than
      // silently picking a bot. The three failure reasons keep the messages this
      // route has always returned.
      const wanted = typeof body.bot === "string" ? body.bot.trim() : "";
      const target = await resolveAskChatTarget(entry, wanted, askChatDeps);
      if (!target.ok) {
        const error = askChatTargetErrorMessage(target.reason, entry.name, wanted);
        if (target.reason === "needs_bot") {
          return c.json({ error, needsBot: true, bots: target.bots }, 400);
        }
        return c.json({ error }, 400);
      }
      const botConfig = target.botConfig;

      // User resolution — explicit `userId` when the bot has more than one, so the
      // thread can never land on an arbitrary user (mirrors /api/research/chat).
      const botUsers = target.users;
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
        defaultUserId = target.defaultUserId;
        if (!defaultUserId) {
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

      // Effective connector of the thread being created — an explicitly chosen
      // connector row's type, else the bot's own default. This is what decides
      // whether the seed may name web search: `WebSearch` is a built-in of
      // claude-cli/claude-sdk only.
      let connectorType: ConnectorType = botConfig.connector ?? "claude-cli";
      if (connectorId) {
        const row = await askChatDeps.getConnector(connectorId);
        if (!row) return c.json({ error: `Unknown connector "${connectorId}"` }, 400);
        connectorType = row.connectorType;
      }
      const webSearch = capabilitiesForConnectorType(connectorType).supportsWebTools;
      // A collection-less wiki (a `WIKI_EXTRA` entry with no 3rd segment) cannot
      // have its "own notes" searched at all, so the direct seed must not open by
      // ordering one — observed producing an answer whose first paragraph
      // apologized for a search that could never have worked.
      const hasCollections = (entry.collections ?? []).length > 0;

      // Only meaningful in direct mode (the escalate seed quotes an answer the
      // wiki DID produce), so it is scoped to that branch rather than trusted
      // wherever the client happens to send it.
      const askDeclined = direct && body.askDeclined === true;

      // Article mode resolves the page SERVER-side against the wiki index rather
      // than trusting a client-posted title/path: the path is the part the seed
      // hands the bot to pull the real page with, and a page the index can't
      // resolve is a 404 the reader can act on — not a seed pointing at nothing.
      let articlePage: WikiPageMeta | undefined;
      if (article) {
        const index = await getWikiIndex({ root: entry.root });
        if (!index) return c.json({ error: "wiki directory not found" }, 404);
        // `relPath` wins (collision-proof, as on `GET /api/wiki/page`) — but it
        // FALLS BACK to the name, because the client's copy of the path goes stale
        // the moment a page is renamed or moved: the reader's open tab then posts
        // a path nothing resolves while the name beside it resolves fine, and the
        // Discuss button 404s on a page that is plainly there.
        articlePage =
          (relPathRef ? index.resolveRelPath(relPathRef) : undefined) ??
          (pageRef ? index.resolve(pageRef) : undefined);
        if (!articlePage) {
          // Quote whichever reference the caller actually sent — `relPath` is what
          // the reader's UI always sends, so naming `page` here described a
          // lookup that hadn't happened.
          const which = relPathRef
            ? `relPath "${relPathRef}"` + (pageRef ? ` or name "${pageRef}"` : "")
            : `name "${pageRef}"`;
          return c.json({ error: `no wiki page for ${which}` }, 404);
        }
      }

      const buildSeed = (canWebSearch: boolean): string => {
        if (article) {
          const meta = articlePage!;
          return buildArticleChatSeed({
            wikiName: entry.name,
            pageTitle: meta.title,
            pagePath: meta.relPath,
            question,
            // The page's own summary — the authored frontmatter `description`
            // when there is one, else the extracted first prose line. Both are
            // page-derived and index-resolved; neither is client-posted.
            description: meta.description || meta.desc,
            webSearch: canWebSearch,
            hasCollections,
          });
        }
        return direct
          ? buildDirectChatSeed({
              wikiName: entry.name,
              question,
              webSearch: canWebSearch,
              hasCollections,
              askDeclined,
            })
          : buildAskChatSeed({ wikiName: entry.name, question, answer, citations });
      };

      // Seed FIRST: everything that can still fail (string building over
      // client-posted citations included) must fail before a thread exists or is
      // written to, or a caller told "500" is left with a dead thread in their
      // sidebar. After this point only the conversation shell, the insert and the
      // handoff remain.
      const seed = buildSeed(webSearch);
      const pendingMeta = { title: question.slice(0, 80) };
      // `&src=wiki` tells the chat page this thread's connector was decided HERE,
      // so its sidebar preference must not stamp over it (see
      // `stampConnectorOnThread`). It is appended ONLY when the request actually
      // expressed a connector decision — direct mode, or any POST from the options
      // popover (which always sends `connectorId`, "" meaning "(bot default)").
      // The plain one-click "Continue in chat →" offers no such choice, and
      // flagging it would silently cost that path the sidebar stamping it has
      // always had.
      const connectorDecided = direct || article || body.connectorId !== undefined;
      const chatUrlFor = (threadId: string): string =>
        `/chat?bot=${encodeURIComponent(botConfig.name)}` +
        `&thread=${encodeURIComponent(threadId)}` +
        `&user=${encodeURIComponent(chatUser.id)}` +
        (connectorDecided ? "&src=wiki" : "");

      // "Send there →": seed the question onto a thread the caller already has
      // (the 409 they just got), instead of minting another one.
      const existingThreadId =
        typeof body.existingThreadId === "string" ? body.existingThreadId.trim() : "";
      if (existingThreadId) {
        if (!isValidUuid(existingThreadId)) {
          return c.json({ error: "existingThreadId must be a UUID" }, 400);
        }
        const thread = await askChatDeps.getThreadById(existingThreadId);
        if (!thread || thread.userId !== chatUser.id || thread.botName !== botConfig.name) {
          return c.json(
            { error: "That thread doesn't belong to this user and bot." },
            400,
          );
        }
        // Article mode re-verifies the thread's IDENTITY here, not just its
        // ownership: the id came back from a name collision, and a name is not an
        // article (13 colliding title groups over 30 mimir+jarvis pages; a plain
        // `/topic` thread can hold the name too). Without this, "Send there →"
        // cross-seeds a question about page A into a conversation about page B —
        // or into an ordinary chat thread. Same `nameTaken` answer the 409 path
        // gives, so the client walks the same "start a new thread" recovery.
        if (article && !articleThreadTagMatches(thread.description, entry.name, articlePage!.relPath)) {
          return c.json({
            nameTaken: true,
            error:
              "That chat thread isn't this article's discussion — start a new thread for it.",
          }, 409);
        }
        // Cheap fail-fast on the common case, so an "already queued" refusal costs
        // no connector stamp and no conversation shell. The narrow race it cannot
        // close is closed by the atomic write below.
        const queuedError = {
          alreadyQueued: true,
          error: "A question is already queued on that thread — open it first.",
          threadId: thread.id,
          chatUrl: chatUrlFor(thread.id),
        };
        if (askChatDeps.hasPendingMessage(thread.id)) return c.json(queuedError, 409);
        // A thread's OWN connector wins at processing time, so on reuse the seed's
        // capability claim must come from THAT row — not from the picked/bot-default
        // resolution above, which is only effective for a thread with an empty slot.
        // (Observed: a copilot-pinned thread seeded with a promise of web search.)
        let reuseSeed = seed;
        if (thread.connectorId) {
          const row = await askChatDeps.getConnector(thread.connectorId);
          // A thread pointing at a deleted connector row falls back to the bot's
          // own default, which is what resolution does at processing time too.
          const effectiveType = row?.connectorType ?? botConfig.connector ?? "claude-cli";
          reuseSeed = buildSeed(capabilitiesForConnectorType(effectiveType).supportsWebTools);
        }
        // An established thread keeps the model it has been answering with; the
        // chosen connector only fills an empty slot. When it doesn't, SAY so —
        // silently dropping the pick left the reader with a "sent" confirmation
        // and a thread answering on a different model than the one they picked.
        const connectorApplied = !!connectorId && !thread.connectorId;
        if (connectorApplied) {
          await askChatDeps.updateThreadConnector(thread.id, connectorId);
        }
        const conv = await askChatDeps.findOrCreateConversation({
          botName: botConfig.name,
          userId: chatUser.id,
          username: chatUser.name,
        });
        // Atomic set-if-absent: `setPendingMessage` is last-write-wins on a 5-min
        // TTL, so seeding over an unconsumed question would delete a question
        // nobody has seen yet and the caller would be told it succeeded. A
        // peek-then-write pair leaves that window open across the awaits above.
        if (!askChatDeps.setPendingMessageIfAbsent(thread.id, reuseSeed, pendingMeta)) {
          return c.json(queuedError, 409);
        }
        log.info("Wiki ask→chat (existing thread): wiki={wiki} bot={bot} thread={threadId}", {
          wiki: entry.name,
          bot: botConfig.name,
          threadId: thread.id,
        });
        return c.json({
          threadId: thread.id,
          conversationId: conv.id,
          chatUrl: chatUrlFor(thread.id),
          reusedThread: true,
          ...(connectorId
            ? { connectorApplied, ...(connectorApplied ? {} : { keptConnectorId: thread.connectorId }) }
            : {}),
        });
      }

      // Thread name derived from the question — or from an explicit `threadName`
      // the reader typed in the popover, through the SAME flatten/lowercase/≤50
      // pipeline (the `createThread` contract doesn't care where the name came
      // from). An existing thread of that name is a 409 the client retries with
      // `forceNew`, which timestamp-suffixes the name.
      // A typed name that FLATTENS to nothing (control characters only) must fall
      // back to the question, not to the generic "wiki ask" — `deriveAskThreadTitle`
      // alone can't express that difference, hence the `…OrNull` variant.
      // Article mode derives its default name from the PAGE, not the question —
      // and it does so HERE, not client-side: that is what makes an article
      // collect ONE discussion thread that every later question 409s onto, for
      // any caller. (The popover's preview runs the same two pure functions in the
      // same order, so what it shows is what `createThread` stores.) A page whose
      // title flattens to nothing falls back to the question rather than to the
      // generic `wiki ask`, exactly as a control-character `threadName` does.
      const derivedFallback =
        article
          ? (deriveAskThreadTitleOrNull(articlePage!.title) ?? deriveAskThreadTitle(question))
          : deriveAskThreadTitle(question);
      const title =
        deriveAskThreadTitleOrNull(typeof body.threadName === "string" ? body.threadName : "") ??
        derivedFallback;
      const existing = await askChatDeps.findThreadByName(chatUser.id, botConfig.name, title);
      // A collision on the NAME is not evidence the thread is this article's.
      // `findThreadByName` is (user, bot, name)-scoped, and article names are
      // page titles: mimir + jarvis carry 13 colliding title groups over 30 pages
      // (`architecture` ×3), two different wikis owned by one bot collide with
      // each other (`repos/huginn.md` vs `entities/Huginn.md`), and an ordinary
      // `/topic` chat thread can hold the name outright. So the thread's own
      // description is asked whether it is THIS article's (see
      // `buildArticleThreadDescription`); when it isn't, the answer is a DISTINCT
      // 409 whose only offered action is a new thread — "Send there →" on an
      // unrelated thread seeds a question about page A into a conversation about
      // something else entirely.
      if (
        article &&
        existing &&
        !body.forceNew &&
        !articleThreadTagMatches(existing.description, entry.name, articlePage!.relPath)
      ) {
        return c.json({
          nameTaken: true,
          error:
            `Another chat thread is already called "${title}" — start a new thread ` +
            "for this article.",
          existingThreadName: existing.name,
          userId: chatUser.id,
          botName: botConfig.name,
        }, 409);
      }
      if (existing && !body.forceNew) {
        return c.json({
          threadExists: true,
          existingThreadId: existing.id,
          existingThreadName: existing.name,
          userId: chatUser.id,
          botName: botConfig.name,
          // The deep link for that thread, built by the SAME `chatUrlFor` the 200
          // paths use — so the client never has to re-derive one (and can't get
          // the `&src=wiki` scoping wrong doing it).
          chatUrl: chatUrlFor(existing.id),
        }, 409);
      }
      // `forceNew`: the timestamp suffix is MINUTE-precision and `createThread` is
      // ON CONFLICT DO UPDATE, so a name collision would return the EXISTING thread
      // and `setPendingMessage` would clobber its unsent seed (measured: three
      // forceNew posts in one minute all resolved to one threadId). Walk
      // disambiguators until the name is genuinely free.
      let threadTitle = title;
      if (existing) {
        threadTitle = "";
        const now = new Date();
        for (let attempt = 1; attempt <= ASK_CHAT_NAME_ATTEMPTS; attempt++) {
          const candidate = uniqueAskThreadTitle(title, now, attempt);
          const clash = await askChatDeps.findThreadByName(
            chatUser.id,
            botConfig.name,
            candidate,
          );
          if (!clash) {
            threadTitle = candidate;
            break;
          }
        }
        if (!threadTitle) {
          return c.json(
            { error: "Too many chats already exist for this question — open one of them." },
            409,
          );
        }
      }

      // The web conversation shell for this user+bot, on its DETERMINISTIC id (see
      // `AskChatDeps.findOrCreateConversation`).
      const conversation = await askChatDeps.findOrCreateConversation({
        botName: botConfig.name,
        userId: chatUser.id,
        username: chatUser.name,
      });
      const conversationId = conversation.id;

      // One description per mode, and in article mode it is also the thread's
      // IDENTITY (`<wiki>:<relPath>`, parsed back by `articleThreadTagMatches`) —
      // which is why the title inside it is flattened and truncated rather than
      // interpolated raw, and why the tail is left intact.
      //
      // NB the "set once" property is NOT `createThread`'s COALESCE: that reads
      // `COALESCE(EXCLUDED.description, threads.description)`, i.e. a NEW non-null
      // description WINS on conflict. What actually keeps an article thread's tag
      // stable is that this route 409s before ever re-inserting over a colliding
      // name (only `forceNew` gets past, and it inserts under a fresh name). The
      // remaining overwrite path is a genuine race between two concurrent posts,
      // which is documented rather than locked.
      const threadDescription = article
        ? buildArticleThreadDescription({
            wikiName: entry.name,
            pageTitle: articlePage!.title,
            relPath: articlePage!.relPath,
          })
        : direct
          ? `Started from the ${entry.name} wiki`
          : `Continued from the ${entry.name} wiki Ask tab`;
      const thread = await askChatDeps.createThread(
        chatUser.id,
        botConfig.name,
        threadTitle,
        threadDescription,
        connectorId || undefined,
      );

      // Hand the seed to the chat page's deep-link handler, which consumes it from
      // `GET /chat/pending/:threadId` and sends it through the normal pipeline once
      // the WebSocket is up (5-min TTL, one-shot).
      askChatDeps.setPendingMessage(thread.id, seed, pendingMeta);

      log.info("Wiki ask→chat: wiki={wiki} bot={bot} user={user} thread={threadId}", {
        wiki: entry.name,
        bot: botConfig.name,
        user: chatUser.id,
        threadId: thread.id,
      });

      return c.json({
        threadId: thread.id,
        conversationId,
        chatUrl: chatUrlFor(thread.id),
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
      const annotatable = isAnnotatablePage(meta.relPath, meta.type);
      const block = annotatable
        ? buildFactcheckAppendix(answer, todayOslo(Date.now()))
        : buildFactcheckBlock(answer, todayOslo(Date.now()));

      // SUPERSEDE — the same rule the integrate routes run, for the same reason.
      // Claim numbering is PER RUN, and this route rebuilds the whole block: a
      // `<Fact n="2">` left over from an earlier integrate would keep pointing at
      // `#fc-claim-2`, which this run's appendix fills with an unrelated claim
      // (and, on a shorter run, does not contain at all). The CAS cannot catch it —
      // `baseHash` is computed over the raw file, marks included, so the page is
      // not "changed" in the sense it tests.
      //
      // UNCONDITIONAL, `.md` included. "A `.md` page never carries marks" is a real
      // invariant of the write paths (integrate only annotates `.mdx`) but nothing
      // enforces it on the FILE — a hand-edit, a rename from `.mdx`, or a page
      // written before the extension gate existed all produce a `.md` carrying
      // marks, and that page would otherwise be left with every chip dangling off a
      // rebuilt callout. A mark-free `.md` is unaffected: `stripFactWrappers` is
      // identity on a body with no tag, so the blockquote path stays byte-for-byte
      // what it was.
      //
      // The strip is zone-aware, so a `<Fact>` inside frontmatter, a fence or a
      // backtick span is documentation and survives. It runs on the freshly-read
      // body inside the write section (hence the `prepareBody` hook rather than a
      // pre-read here), and `stripSupersededMarks` takes the count off that SAME
      // pass — so the note reports the marks this write removed, byte-for-byte,
      // including any quoted inside the appendix region it is about to replace.
      let supersededWrappers = 0;
      const result = await appendBlockToPage({
        wikiDir: entry.root,
        relPath: meta.relPath,
        block,
        baseHash,
        collections: entry.collections ?? [],
        logTitle: meta.title,
        now: () => Date.now(),
        prepareBody: (current: string) => {
          const stripped = stripSupersededMarks(current);
          supersededWrappers = stripped.removed;
          return {
            body: stripped.body,
            // The log.md line and the commit subject say what the page LOST, not
            // just what it gained — this write removes marks the reader never
            // asked about, and the repo history is where that has to be findable.
            ...(supersededWrappers > 0
              ? {
                  note: `${supersededWrappers} prior mark${supersededWrappers === 1 ? "" : "s"} superseded`,
                }
              : {}),
          };
        },
        ...defaultPageWriteIo(entry.root),
        reindex: async (collection) => {
          await postCollectionUpdate(config.knowledgeApiUrl, collection);
        },
        commit: (paths, message) => commitWikiChange(entry.root, paths, message, { push }),
      });

      // Wiki-readonly instance — a refusal from the write seam, not a failure:
      // 403, and the page was never opened.
      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
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
      log.info("Wiki fact-check appended: wiki={wiki} page={page} superseded={superseded}", {
        wiki: entry.name,
        page: meta.relPath,
        superseded: supersededWrappers,
      });
      // Tail is written for BOTH branches — the `.mdx` appendix and the `.md`
      // callout are the same "fact-check block" from the reader's side, and the
      // hook now runs on both.
      const supersededNote = supersededMarksNote(
        supersededWrappers,
        "this action rebuilds the fact-check block and adds no new marks",
      );
      return c.json({
        written: true,
        page: meta.relPath,
        ...(supersededNote ? { supersededNote } : {}),
      });
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
      // Wiki-readonly instance: refuse first. This route writes nothing, but its
      // ONLY consumer is the sibling /apply, which this instance already 403s —
      // so the ~90s one-shot could only ever buy a preview nothing can commit.
      // Same reasoning as the guarded drafting / atlas draft-synthesis routes.
      const refused = readonlyRefusal(c);
      if (refused) return refused;
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

      // Per-wiki egress guard, before the page read and the ~90s editor one-shot.
      // The sibling `/apply` is covered by the `writeWikiPage` seam; this half
      // writes nothing but would ship the whole page into a model call whose only
      // possible commit target is a root that refuses forever.
      const integrateEgress = egressRefusal(c, entry);
      if (integrateEgress) return integrateEgress;

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
      // THIS run are reported as superseded, never silently vanished — and the
      // number is the one `stripSupersededMarks` takes off the strip ITSELF, i.e.
      // exactly what apply's `stripFactWrappers(raw)` will remove from the same
      // CAS-pinned bytes. That includes marks quoted inside the sentinel region:
      // the strip is whole-body, so they come off whether or not the region is
      // then replaced — and on apply's `!appendCallout && !wroteWrapper` branch the
      // region is NOT replaced, so the block survives with its quoted tags already
      // stripped out of it.
      const superseded = stripSupersededMarks(current);
      const supersededWrappers = superseded.removed;
      const editable = superseded.body;
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
      // The SUPERSEDE rule made visible (wording: `supersededMarksNote`). A RUN-level
      // note, deliberately not a blank row in `dropped` — that inflated the "N not
      // applied" count with an entry corresponding to no proposed edit.
      const supersededNote = supersededMarksNote(
        supersededWrappers,
        "this run re-marks the page from its own claims",
      );

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
        ...defaultPageWriteIo(entry.root),
        reindex: async (collection) => {
          await postCollectionUpdate(config.knowledgeApiUrl, collection);
        },
        commit: (paths, message) => commitWikiChange(entry.root, paths, message, { push }),
      });

      const droppedOf = (r: ReturnType<typeof applyEdits> | null) =>
        (r?.outcomes ?? [])
          .filter((o) => !o.applied)
          .map((o) => ({ edit: o.edit, reason: o.reason ?? "could not be placed" }));

      // Wiki-readonly instance — a refusal from the write seam (403), checked
      // before the outcome branches that describe an attempted write. The route
      // HAS already read the page (the cap check above), but the seam refused
      // before its own read and before the queue, so nothing was written, no
      // log.md exists, and the `transform` never ran — which is why
      // `budgetError`/`applyResult` are still untouched here.
      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
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
