import type { Hono } from "hono";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import { resolveBotWikiRoot, listWikiBots, resolveWikiRequest } from "../../wiki/bot-root.ts";
import { discoverAllBots, type BotConfig } from "../../bots/config.ts";

/**
 * Bot configs are static until restart, so discover once and memoize — otherwise
 * every /api/wiki request re-runs discovery and re-logs config-validation
 * warnings on each page click.
 */
let cachedBots: BotConfig[] | null = null;
function getBots(): BotConfig[] {
  return (cachedBots ??= discoverAllBots());
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

/** Dashboard /wiki reader: a bot's knowledge wiki as a browsable site.
 *  `?bot=<name>` selects which wiki; a bare `/wiki` renders the default wiki bot
 *  (jarvis if it has a wiki, else the first) — unless `WIKI_DIR` is set, which
 *  stays an explicit legacy override with no bot claimed in the picker. */
export function registerWikiRoutes(app: Hono): void {
  app.get("/wiki", async (c) => {
    const bots = getBots();
    const wikiBots = listWikiBots(bots);
    const { bot: selected, envOverride } = resolveWikiRequest(bots, c.req.query("bot"), process.env.WIKI_DIR);
    return c.html(await renderWikiPage({ wikiBots, selected, envOverride }));
  });

  // Full page listing — the client filters/sorts locally (712 pages ≈ trivial).
  app.get("/api/wiki/pages", async (c) => {
    const { root, unknownBot } = resolveBotWikiRoot(getBots(), c.req.query("bot"));
    if (unknownBot) {
      return c.json({ pages: [], scannedAt: null, error: "no wiki configured for that bot" });
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
    const { root, unknownBot } = resolveBotWikiRoot(getBots(), c.req.query("bot"));
    if (unknownBot) return c.json({ error: "no wiki configured for that bot" }, 404);
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
