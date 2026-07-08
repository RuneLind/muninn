import type { Hono } from "hono";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import {
  buildWikiRegistry,
  resolveWikiRoot,
  listWikis,
  resolveWikiRequest,
  type WikiRegistryEntry,
} from "../../wiki/registry.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { countDraftWikiProposals } from "../../db/wiki-proposals.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki");

/**
 * The wiki registry (bot wikis + `WIKI_EXTRA` standalone wikis) is static until
 * restart, so build it once and memoize — otherwise every /api/wiki request
 * re-runs bot discovery and re-logs config/env-validation warnings on each click.
 */
let cachedRegistry: WikiRegistryEntry[] | null = null;
function getRegistry(): WikiRegistryEntry[] {
  return (cachedRegistry ??= buildWikiRegistry(discoverAllBots(), process.env.WIKI_EXTRA));
}

/** The requested wiki name: `?wiki=` wins, `?bot=` is the legacy alias. */
function requestedWiki(wiki: string | undefined, bot: string | undefined): string | undefined {
  return wiki?.trim() ? wiki : bot;
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
export function registerWikiRoutes(app: Hono): void {
  app.get("/wiki", async (c) => {
    const registry = getRegistry();
    const wikis = listWikis(registry);
    const { wiki: selected, envOverride } = resolveWikiRequest(
      registry,
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    // The gardener is a bot feature — only bot-source wikis carry proposals.
    const isBotWiki =
      registry.find((e) => e.name.toLowerCase() === selected.toLowerCase())?.source === "bot";
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
      await renderWikiPage({ wikis, selected, envOverride, gardenerPending, gardener: isBotWiki }),
    );
  });

  // Full page listing — the client filters/sorts locally (712 pages ≈ trivial).
  app.get("/api/wiki/pages", async (c) => {
    const { root, unknownWiki } = resolveWikiRoot(
      getRegistry(),
      requestedWiki(c.req.query("wiki"), c.req.query("bot")),
    );
    if (unknownWiki) {
      return c.json({ pages: [], scannedAt: null, error: "no wiki configured for that name" });
    }
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
    const { root, unknownWiki } = resolveWikiRoot(
      getRegistry(),
      requestedWiki(c.req.query("wiki"), c.req.query("bot")),
    );
    if (unknownWiki) return c.json({ error: "no wiki configured for that name" }, 404);
    const index = await getWikiIndex({ root });
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
}
