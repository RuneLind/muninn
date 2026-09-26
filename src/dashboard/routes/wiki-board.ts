/**
 * `GET /wiki/issues?wiki=` — the issue board's page. Index-local: it reads the
 * wiki's tracker config and renders a shell, whose client makes the one
 * network-joined read (`GET /api/wiki/graph` with the board's opt-ins, on
 * `SIDE_EFFECTING_GETS`). This path fans out to nothing, so it is not listed.
 *
 * Registered inside the `wiki` route group. A wiki with no `trackers` block
 * answers 404 with a page that says so — the board is a tracker surface, and
 * the reader offers no link to it there.
 */

import type { Hono } from "hono";
import { getWikiIndex } from "../../wiki/store.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { trackerAdapter } from "../../wiki/trackers/index.ts";
import { renderWikiBoardPage } from "../views/wiki-board-page.ts";

export function registerWikiBoardRoute(app: Hono): void {
  app.get("/wiki/issues", async (c) => {
    const { wiki, entry, unknownWiki } = resolveWikiRequest(
      getWikiRegistry(),
      c.req.query("wiki"),
      c.req.query("bot"),
      process.env.WIKI_DIR,
    );
    const name = wiki || "";
    if (unknownWiki) {
      return c.html(await renderWikiBoardPage({ wiki: name, label: "Issue", refusal: "No wiki is configured for that name." }), 404);
    }
    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.html(await renderWikiBoardPage({ wiki: name, label: "Issue", refusal: "The wiki directory was not found." }), 503);
    const tracker = index.readerConfig?.trackers?.[0];
    if (!tracker) {
      return c.html(
        await renderWikiBoardPage({
          wiki: name,
          label: "Issue",
          refusal: "This wiki names no tracker in its .wiki-reader.json, so it has no issue board.",
        }),
        404,
      );
    }
    return c.html(await renderWikiBoardPage({ wiki: name, label: trackerAdapter(tracker.id)?.label ?? "Issue" }));
  });
}
