import type { Hono } from "hono";
import { renderWikiPage } from "../views/wiki-page.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { renderWikiHtml } from "../../wiki/render.ts";

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

/** Dashboard /wiki reader: the huginn-jarvis knowledge wiki as a browsable site. */
export function registerWikiRoutes(app: Hono): void {
  app.get("/wiki", (c) => c.html(renderWikiPage()));

  // Full page listing — the client filters/sorts locally (712 pages ≈ trivial).
  app.get("/api/wiki/pages", async (c) => {
    const index = await getWikiIndex({ refresh: c.req.query("refresh") === "1" });
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
    const index = await getWikiIndex();
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
