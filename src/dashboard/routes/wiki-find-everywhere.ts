/**
 * `GET /api/wiki/find-everywhere?q=<text>&limit=<n>` — the find palette's
 * Everywhere section: every registered wiki through three legs (text, huginn,
 * claude-usage sessions), fused. The logic is `src/wiki/find-everywhere.ts`.
 *
 * Registered inside the `wiki` route group, so `MUNINN_PROFILE=nais` drops it
 * (it reads every registered wiki on this machine). Never a 5xx: a failing or
 * unconfigured leg is reported in `sources`.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { fetchKnowledgeApi } from "../../ai/knowledge-api-client.ts";
import { claudeUsageJson } from "../../utils/claude-usage-fetch.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import {
  findEverywhere,
  parseFindEverywhereLimit,
  type FindEverywhereDeps,
} from "../../wiki/find-everywhere.ts";

export function defaultFindEverywhereDeps(config: Config): FindEverywhereDeps {
  const usageRoot = config.claudeUsageUrl?.replace(/\/+$/, "") ?? null;
  return {
    wikis: () => getWikiRegistry(),
    index: (root) => getWikiIndex({ root }),
    huginn: config.knowledgeApiUrl
      ? (path, signal) => fetchKnowledgeApi(config.knowledgeApiUrl, path, { signal })
      : null,
    // `label: root` — the query rides the URL, and a log line should not grow
    // with what the reader typed.
    claudeUsage: usageRoot
      ? (path, signal) => claudeUsageJson(usageRoot, path, { signal, label: usageRoot })
      : null,
    now: () => Date.now(),
  };
}

let depsOverride: FindEverywhereDeps | null = null;

/** Test seam: the route's dependencies. No argument restores the defaults. */
export function __setFindEverywhereDepsForTest(deps?: FindEverywhereDeps): void {
  depsOverride = deps ?? null;
}

export function registerWikiFindEverywhereRoute(app: Hono, config: Config): void {
  app.get("/api/wiki/find-everywhere", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = parseFindEverywhereLimit(c.req.query("limit"));
    const body = await findEverywhere(q, limit, depsOverride ?? defaultFindEverywhereDeps(config));
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
