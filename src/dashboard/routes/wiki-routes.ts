import type { Hono } from "hono";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";
import { resolveBotWikiRoot, listWikiBots } from "../../wiki/bot-root.ts";
import { discoverAllBots } from "../../bots/config.ts";

/** Default bot the bare `/wiki` (no `?bot=`) reader selects in its wiki picker. */
const DEFAULT_WIKI_BOT = "jarvis";

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
 *  `?bot=<name>` selects which wiki; a bare `/wiki` keeps the jarvis default. */
export function registerWikiRoutes(app: Hono): void {
  app.get("/wiki", async (c) => {
    const bots = discoverAllBots();
    const wikiBots = listWikiBots(bots);
    const selected = c.req.query("bot")?.trim() || DEFAULT_WIKI_BOT;
    return c.html(await renderWikiPage({ wikiBots, selected }));
  });

  // Lists the bots that expose a browsable wiki — backs the reader's picker.
  app.get("/api/wiki/wikis", (c) => {
    return c.json({ wikis: listWikiBots(discoverAllBots()), default: DEFAULT_WIKI_BOT });
  });

  // Full page listing — the client filters/sorts locally (712 pages ≈ trivial).
  app.get("/api/wiki/pages", async (c) => {
    const { root, unknownBot } = resolveBotWikiRoot(discoverAllBots(), c.req.query("bot"));
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
    const { root, unknownBot } = resolveBotWikiRoot(discoverAllBots(), c.req.query("bot"));
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
