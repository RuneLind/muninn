import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, normalizeRelPath, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { projectAtlas } from "../../wiki/atlas.ts";
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
  buildFactcheckBlock,
  FACTCHECK_SELECTION_MAX,
  FACTCHECK_HEADING_MAX,
} from "../../wiki/factcheck-context.ts";
import { appendBlockToPage } from "../../wiki/append-block.ts";
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
import { discoverAllBots, resolveWikiSynthesisBot } from "../../bots/config.ts";
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

/** Listing shape sent to the client — meta plus connection counts for sorting. */
interface WikiPageListing extends WikiPageMeta {
  linkCount: number;
  backlinkCount: number;
}

function toListing(index: WikiIndex, meta: WikiPageMeta): WikiPageListing {
  // `desc` + `pubDate` are Atlas-only fields (only `GET /api/wiki/atlas` reads
  // them); excluded here so they don't bloat this hot pages-listing payload
  // (~100 KB on jarvis). The listing type keeps them optional/undefined.
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
  app.get("/api/wiki/pages", async (c) => {
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
    const index = await getWikiIndex({ root: entry?.root, refresh: c.req.query("refresh") === "1" });
    if (!index) return emptyAtlas("wiki directory not found");
    return c.json(projectAtlas(index));
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

    return c.json(buildIndexCoverageResponse(collections, pageRelPaths, listings));
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
  app.get("/api/wiki/page", async (c) => {
    const name = c.req.query("name");
    if (!name) return c.json({ error: "name query param required" }, 400);
    const { entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    const meta = index.resolve(name);
    if (!meta) return c.json({ error: `no wiki page named "${name}"` }, 404);
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
    if (!preflightError && entry && index && meta) {
      // Explainers are HTML on disk; reduce to prose so claim extraction / the
      // locator see plain text. Markdown pages pass through verbatim. A missing/
      // unreadable file degrades to an empty body (no 500), like the explain branch.
      const raw = (await readWikiPage(index, meta)) ?? "";
      baseHash = createHash("sha256").update(raw).digest("hex");
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

      const block = buildFactcheckBlock(answer, todayOslo(Date.now()));
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
}
