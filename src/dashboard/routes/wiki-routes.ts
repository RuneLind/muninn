import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import {
  buildWikiRegistry,
  listWikis,
  resolveWikiRequest,
  type WikiRegistryEntry,
} from "../../wiki/registry.ts";
import { enrichCitationsWithPages } from "../../wiki/citation-links.ts";
import { discoverAllBots, resolveResearchBot } from "../../bots/config.ts";
import { streamResearchSSE } from "./research-sse.ts";
import { parseResearchHistory } from "../../research/history-param.ts";
import { countDraftWikiProposals } from "../../db/wiki-proposals.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki");

/**
 * The wiki registry (bot wikis + `WIKI_EXTRA` standalone wikis) is static until
 * restart, so build it once and memoize — otherwise every /api/wiki request
 * re-runs bot discovery and re-logs config/env-validation warnings on each click.
 */
let cachedRegistry: WikiRegistryEntry[] | null = null;

/**
 * The full wiki registry (bot wikis + `WIKI_EXTRA` standalone wikis), memoized.
 * Exported so the gardener shares this one seam (filtering to `source === "bot"`)
 * instead of re-running bot discovery + env parsing behind a second memo.
 */
export function getWikiRegistry(): WikiRegistryEntry[] {
  return (cachedRegistry ??= buildWikiRegistry(discoverAllBots(), process.env.WIKI_EXTRA));
}

/** Test-only: drop the memoized registry so a test can re-derive it from a
 *  freshly-set `WIKI_EXTRA` (mirrors `__resetWikiCacheForTest` in the store). */
export function __resetWikiRegistryForTest(): void {
  cachedRegistry = null;
}

/** Listing shape sent to the client — meta plus connection counts for sorting. */
interface WikiPageListing extends WikiPageMeta {
  linkCount: number;
  backlinkCount: number;
}

function toListing(index: WikiIndex, meta: WikiPageMeta): WikiPageListing {
  return {
    ...meta,
    linkCount: index.outgoing.get(meta.name)?.length ?? 0,
    backlinkCount: index.backlinks.get(meta.name)?.length ?? 0,
  };
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
    return c.html(
      await renderWikiPage({
        wikis,
        selected,
        envOverride,
        unknownWiki,
        gardenerPending,
        gardener: isBotWiki,
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

    const listings = (names: string[] | undefined) =>
      (names ?? [])
        .map((n) => index.resolve(n))
        .filter((m): m is WikiPageMeta => m !== undefined)
        .map((m) => toListing(index, m));

    return c.json({
      meta: toListing(index, meta),
      html: renderWikiHtml(markdown, index.resolve, { stripTitle: meta.title }),
      outgoing: listings(index.outgoing.get(meta.name)),
      backlinks: listings(index.backlinks.get(meta.name)),
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
    const botConfig = resolveResearchBot(discoverAllBots());

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
      // Pin enrichment to the resolved wiki (not the whole registry) so a
      // collection shared by two wikis can't attribute a citation to the wrong
      // one. `entry` is guaranteed set whenever enrich runs (preflightError
      // covers the unknown-wiki case), so a missing entry disables enrichment.
      enrich: entry ? (citations) => enrichCitationsWithPages(citations, [entry]) : undefined,
    });
  });
}
