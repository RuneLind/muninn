import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, normalizeRelPath, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import {
  listWikis,
  resolveWikiRequest,
  type WikiRegistryEntry,
} from "../../wiki/registry.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { enrichCitationsWithPages } from "../../wiki/citation-links.ts";
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
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { listCollections } from "../../summaries/list-collections.ts";
import {
  buildIndexCoverageResponse,
  type CollectionPatterns,
  type CoverageListing,
  type IndexCoverageResponse,
} from "../../wiki/index-coverage.ts";
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

/** Listing shape sent to the client — meta plus connection counts for sorting. */
interface WikiPageListing extends WikiPageMeta {
  linkCount: number;
  backlinkCount: number;
}

function toListing(index: WikiIndex, meta: WikiPageMeta): WikiPageListing {
  return {
    ...meta,
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
      // No log.md — fall back to the newest page date from the index.
      const index = await getWikiIndex({ root: entry.root });
      if (!index) return;
      let newest = "";
      for (const p of index.pages) {
        const d = p.updated || p.created || "";
        if (d > newest) newest = d;
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
    });
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
    return new Response(file, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  // Wiki Ask tab: research-style cited Q&A scoped to a single wiki's search
  // collections. Mirrors /api/research/ask (SSE over GET, bounded `history`
  // replayed from the client) but pins the corpus to the selected wiki's
  // `collections` and enriches each citation with the matched wiki page name so
  // the reader can open it in-place. A wiki with no collections (or an unknown
  // name) returns a clean app_error instead of searching the whole corpus.
  app.get("/api/wiki/ask", (c) => {
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

    return streamResearchSSE(c, {
      question,
      config,
      botConfig: botConfig ?? null,
      history,
      collections,
      preflightError,
      // Per-wiki framing so the answer is scoped to this wiki's corpus. The same
      // line is used on owner- and fallback-routed wikis (no "for its owner"
      // phrasing — an owner claim would be false on a fallback/standalone wiki).
      systemPrompt: entry
        ? buildSynthesisSystemPrompt(
            `You answer questions about the "${entry.name}" knowledge wiki, using ONLY the numbered sources provided in the user message.`,
          )
        : undefined,
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
}
