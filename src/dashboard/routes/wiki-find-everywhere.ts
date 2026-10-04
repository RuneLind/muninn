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
import { getLog } from "../../logging.ts";
import { BoundedReadCapError, readBounded } from "../../utils/bounded-fetch.ts";
import { ClaudeUsageHttpError, ClaudeUsageReadError, claudeUsageJson } from "../../utils/claude-usage-fetch.ts";
import { sameWikiRoot } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import {
  HUGINN_MAX_BYTES,
  LegFetchError,
  findEverywhere,
  parseFindEverywhereLimit,
  type FindEverywhereDeps,
  type FindEverywhereResponse,
  type FindEverywhereWiki,
} from "../../wiki/find-everywhere.ts";

const log = getLog("dashboard", "find-everywhere");

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

/**
 * One entry per ROOT, first wins — `findSelfWikiName`'s rule. `WIKI_EXTRA=a=/w,b=/w`,
 * or a bot's `wikiDir` registered again in `WIKI_EXTRA`, would otherwise list
 * every page of that root twice.
 */
export function uniqueWikiRoots<T extends { root: string }>(wikis: readonly T[]): T[] {
  const out: T[] = [];
  for (const w of wikis) if (!out.some((o) => sameWikiRoot(o.root, w.root))) out.push(w);
  return out;
}

/** claude-usage's search answers ~25 sessions with snippets; 2 MB is far past it. */
export const USAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `GET url` parsed as JSON under `maxBytes`, every failure classified:
 * no answer ⇒ `unreachable`, non-2xx ⇒ the status, an over-cap or non-JSON
 * body ⇒ `bad response`. An abort is rethrown as is — the core names it
 * `timeout` or `aborted` from its own signals. huginn only: `fetchKnowledgeApi`
 * reads unbounded and maps a bad body to "unreachable".
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
    throw new LegFetchError(err instanceof BoundedReadCapError ? "bad response" : "unreachable");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LegFetchError("bad response");
  }
}

/**
 * The sessions leg's read: `claudeUsageJson`, the one way muninn reads
 * claude-usage, its failures mapped onto the leg labels. The label is the
 * base URL, so no error message carries the reader's query.
 */
export async function usageLegJson(root: string, path: string, signal: AbortSignal): Promise<unknown> {
  try {
    return await claudeUsageJson(root, path, { signal, maxBytes: USAGE_MAX_BYTES, label: root });
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof ClaudeUsageHttpError) throw new LegFetchError("http", err.status);
    if (err instanceof ClaudeUsageReadError) {
      if (err.stage === "parse" || (err.stage === "body" && err.cause instanceof BoundedReadCapError)) {
        throw new LegFetchError("bad response");
      }
      throw new LegFetchError("unreachable");
    }
    throw err;
  }
}

export function defaultFindEverywhereDeps(config: Config, signal?: AbortSignal): FindEverywhereDeps {
  const huginnRoot = config.knowledgeApiUrl.replace(/\/+$/, "");
  const usageRoot = config.claudeUsageUrl?.replace(/\/+$/, "") ?? null;
  return {
    wikis: () => getWikiRegistry(),
    index: (root) => getWikiIndex({ root }),
    huginn: (path, s) => fetchLegJson(`${huginnRoot}${path}`, s, HUGINN_MAX_BYTES),
    claudeUsage: usageRoot ? (path, s) => usageLegJson(usageRoot, path, s) : null,
    now: () => Date.now(),
    signal,
  };
}

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** (leg, label, host) keys already warned about; capped like `claudeUsageWarnOnce`'s. */
const warnedLegs = new Set<string>();
const WARNED_LEGS_MAX = 100;

/** Test seam: forget which leg failures have warned. */
export function __resetFindEverywhereWarnsForTest(): void {
  warnedLegs.clear();
}

/**
 * Log each failed leg: the first sighting of a (leg, label, host) warns,
 * repeats log info — the palette asks on every keystroke pause. An `aborted`
 * leg is the reader moving on, not a failure. The query never reaches a log.
 */
export function logLegFailures(
  body: FindEverywhereResponse,
  hosts: { huginn: string; sessions: string },
  logger: { warn(msg: string, props: Record<string, unknown>): void; info(msg: string, props: Record<string, unknown>): void } = log,
): void {
  for (const leg of ["text", "huginn", "sessions"] as const) {
    const r = body.sources[leg];
    if (r.status !== "error" || r.error === "aborted") continue;
    const host = leg === "text" ? "local" : hosts[leg];
    const props = { leg, error: r.error ?? "failed", host };
    const key = `${leg}\0${props.error}\0${host}`;
    if (warnedLegs.has(key)) {
      logger.info("find-everywhere {leg} leg still failing: {error} ({host})", props);
      continue;
    }
    if (warnedLegs.size >= WARNED_LEGS_MAX) warnedLegs.clear();
    warnedLegs.add(key);
    logger.warn("find-everywhere {leg} leg failed: {error} ({host})", props);
  }
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
    const deps = depsOverride ? depsOverride(signal) : defaultFindEverywhereDeps(config, signal);
    const body = await findEverywhere(q, limit, {
      ...deps,
      wikis: (): FindEverywhereWiki[] => uniqueWikiRoots(deps.wikis()),
    });
    logLegFailures(body, { huginn: hostOf(config.knowledgeApiUrl), sessions: hostOf(config.claudeUsageUrl) });
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
