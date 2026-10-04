/**
 * `GET /api/wiki/find-everywhere?q=<text>&limit=<n>` — the find palette's
 * Everywhere section: every registered wiki through three legs (text, huginn,
 * claude-usage sessions), fused. The logic is `src/wiki/find-everywhere.ts`.
 *
 * Registered inside the `wiki` route group, so `MUNINN_PROFILE=nais` drops it
 * (it reads every registered wiki on this machine). Never a 5xx: a failing or
 * unconfigured leg is reported in `sources`. The request's own abort signal
 * reaches every upstream call, so a palette fetch the reader abandoned stops
 * the huginn and claude-usage reads behind it.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { readBounded } from "../../utils/bounded-fetch.ts";
import { sameWikiRoot } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import {
  HUGINN_MAX_BYTES,
  LegFetchError,
  findEverywhere,
  parseFindEverywhereLimit,
  type FindEverywhereDeps,
} from "../../wiki/find-everywhere.ts";

/**
 * The registry name find-everywhere gives the wiki a `/wiki` page serves: the
 * resolved entry's name, else (the `WIKI_DIR` override, which has no entry)
 * the entry whose root is the served root, else "". The page injects it as
 * `__WIKI_FIND_SELF__`, so the palette can tell its own wiki's rows apart.
 */
export function findSelfWikiName(
  registry: ReadonlyArray<{ name: string; root: string }>,
  entry: { name: string } | undefined,
  servedRoot: string | null,
): string {
  if (entry) return entry.name;
  if (servedRoot === null) return "";
  return registry.find((e) => sameWikiRoot(e.root, servedRoot))?.name ?? "";
}

/** claude-usage's search answers ~25 sessions with snippets; 2 MB is far past it. */
const USAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `GET url` parsed as JSON under `maxBytes`, every failure classified:
 * no answer ⇒ `unreachable`, non-2xx ⇒ the status, an over-cap or non-JSON
 * body ⇒ `bad response`. An abort is rethrown as is — the core names it
 * `timeout` or `aborted` from its own signals.
 */
export async function fetchLegJson(url: string, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new LegFetchError("unreachable");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new LegFetchError("http", res.status);
  }
  let text: string;
  try {
    text = await readBounded(res, maxBytes, url);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new LegFetchError(/cap/.test(err instanceof Error ? err.message : "") ? "bad response" : "unreachable");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LegFetchError("bad response");
  }
}

export function defaultFindEverywhereDeps(config: Config, signal?: AbortSignal): FindEverywhereDeps {
  const huginnRoot = config.knowledgeApiUrl.replace(/\/+$/, "");
  const usageRoot = config.claudeUsageUrl?.replace(/\/+$/, "") ?? null;
  return {
    wikis: () => getWikiRegistry(),
    index: (root) => getWikiIndex({ root }),
    huginn: (path, s) => fetchLegJson(`${huginnRoot}${path}`, s, HUGINN_MAX_BYTES),
    claudeUsage: usageRoot ? (path, s) => fetchLegJson(`${usageRoot}${path}`, s, USAGE_MAX_BYTES) : null,
    now: () => Date.now(),
    signal,
  };
}

let depsOverride: ((signal: AbortSignal) => FindEverywhereDeps) | null = null;

/** Test seam: the route's dependencies, built per request from its signal.
 *  No argument restores the defaults. */
export function __setFindEverywhereDepsForTest(deps?: FindEverywhereDeps | ((signal: AbortSignal) => FindEverywhereDeps)): void {
  depsOverride = deps === undefined ? null : typeof deps === "function" ? deps : (signal) => ({ ...deps, signal });
}

export function registerWikiFindEverywhereRoute(app: Hono, config: Config): void {
  app.get("/api/wiki/find-everywhere", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = parseFindEverywhereLimit(c.req.query("limit"));
    const signal = c.req.raw.signal;
    const body = await findEverywhere(q, limit, depsOverride ? depsOverride(signal) : defaultFindEverywhereDeps(config, signal));
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
