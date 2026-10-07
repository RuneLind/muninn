/**
 * The route GROUPS a serving profile can drop, and which ones `nais` drops.
 *
 * Its own module rather than a corner of `routes.ts` because the NAV needs it
 * too (`views/shared-styles.ts` — a link to a dropped group is a 404 on every
 * page that renders it), and a view importing the route factory would be a
 * cycle.
 */
import type { MuninnProfile } from "../config.ts";

/**
 * Every group, in registration order. The SOURCE of the union — spelling a
 * group here and forgetting it in `createDashboardRoutes`' list is a compile
 * error there (see the exhaustiveness tie), and a typo in the drop list below
 * is a compile error here.
 */
export const ROUTE_GROUPS = [
  "data", "traces", "memsearch", "logs", "search", "research", "tools",
  "summaries", "anthropic", "article", "youtube", "x-article", "tiktok",
  "vimeo", "sse", "graph", "wiki-read", "wiki", "wiki-answers", "wiki-gardener", "benchmark", "models",
  "indexing", "agents", "sync", "claude-usage", "plans", "jira",
] as const;

/** The name of a `register*` call, minus the ceremony. */
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

/**
 * What the `nais` profile does NOT register — **absent, not denied**: there is
 * no handler, so the answer is Hono's own 404 and the route cannot be reached
 * by a role check that someone later relaxes.
 *
 * Two things belong here and nothing else does:
 *
 *  - **Filesystem-bound surfaces.** `wiki`, `wiki-gardener`, `plans` and `sync`
 *    read and WRITE working trees (`WIKI_EXTRA` roots, mimir's `plans/`, the
 *    repo-sync checkouts) that exist on a laptop and on the mini and not in a
 *    pod; `claude-usage` proxies a launchd service on the mini's loopback.
 *    `wiki` here is everything on the wiki surface EXCEPT the read slice —
 *    Ask, Explain, fact-check, Similar, share, remember, Stamp, the series
 *    editor, atlas, digest, reindex — i.e. every wiki route that writes, spends
 *    a model call or sends a page's text to huginn.
 *    `logs` is here for a different reason with the same shape: `/logs` +
 *    `/api/logs*` serve the JSONL sink verbatim, and those lines carry other
 *    people's message previews.
 *  - **The yt-dlp/ffmpeg capture verticals** — `anthropic`, `article`,
 *    `youtube`, `x-article`, `tiktok`. The nais image ships neither binary
 *    (`WITH_MEDIA=false`), so registering them would answer 500 on a route that
 *    can never work. `benchmark` joins them: it spawns judge runs against the
 *    Claude CLI, which the nais image also drops (`WITH_CLI=false`). `vimeo`
 *    joins them for the same reason with a different binary: its capture
 *    launches a headless Chromium, and `bunx playwright install chromium` is an
 *    operator step on a laptop, never a build step in the image.
 *
 * **A dropped group takes its HTML surface with it** — which is why `summaries`
 * is here despite reading only the job store and huginn: every control on that
 * page POSTs to `/api/anthropic/*`, `/api/articles/summarize` or
 * `/api/wiki/share`, all dropped above, so the page renders and then 404s into a
 * generic error on the first click. The same rule is what removes the `/plans`,
 * `/logs` and `/benchmark` links from the nav; the nav's `/wiki` link maps to
 * `wiki-read`, so it stays.
 *
 * `wiki-read` STAYS: the reader page, the page listing, one page, its
 * provenance block, explainer HTML and graph mode. It never writes and never
 * spends a model call; provenance and graph make bounded GET fan-outs to huginn
 * (the jira-issues corpus, for a page or wiki with `jira:` keys) and to
 * claude-usage when `CLAUDE_USAGE_URL` is set. It serves only the read-only
 * roots the pod registers (a mirror, `WIKI_EXTRA` + `WIKI_READONLY_ROOTS`).
 * Its GET paths are the auth user zone's read-slice entries under this profile
 * only (`servesWikiReadSliceOnly`), and the reader hides every control that
 * would reach the dropped `wiki` group (`wikiToolsRegistered`).
 *
 * `wiki-answers` STAYS too (answer cards, D14): the answer store is a table,
 * not a working tree, and the pod is where colleagues answer. Its routes
 * resolve pages through the read slice's scope, check `WIKI_ANSWER_WIKIS` in
 * the handler, and are outside every user zone until answer cards PR 5.
 *
 * Everything else STAYS, deliberately: `data`, `traces`, `memsearch`, `sse`,
 * `models`, `agents`, `indexing` and `jira` are DB- or huginn-bound and are the
 * operator surface the zone model already closes to a role `user`; `search`,
 * `research` and `graph` are huginn HTTP clients; `tools` discovers Serena
 * instances from the bots' `.mcp.json` project paths and reports an EMPTY list
 * when there are none — which is what a pod has.
 */
export const NAIS_DROPPED_ROUTE_GROUPS: readonly RouteGroup[] = [
  "wiki", "wiki-gardener", "plans", "sync", "claude-usage", "benchmark", "logs",
  "summaries", "anthropic", "article", "youtube", "x-article", "tiktok",
  "vimeo",
];

/** The groups this profile does not register. Empty on `default`. */
export function droppedRouteGroups(profile: MuninnProfile): ReadonlySet<RouteGroup> {
  return profile === "nais" ? new Set(NAIS_DROPPED_ROUTE_GROUPS) : new Set();
}

/**
 * Is the full wiki tool surface registered? False under `nais`, where only the
 * `wiki-read` slice is. Three things key on it:
 *
 *  - the reader renders no Ask, Explain, fact-check, Share, Similar, Stamp or
 *    series control, since each would reach a route with no handler;
 *  - the worked-on ledger is never dialled — not at boot (`src/index.ts`) and
 *    not from an index build (`src/wiki/store.ts`): a pod's read-only mirror
 *    was written by no agent session, and the claude-usage it would dial is a
 *    launchd service on another machine's loopback;
 *  - {@link servesWikiReadSliceOnly} is its complement for the auth zone.
 *
 * Derived from `droppedRouteGroups` rather than from the profile name, so a
 * later profile that drops `wiki` follows without a second edit.
 */
export function wikiToolsRegistered(profile: MuninnProfile): boolean {
  return !droppedRouteGroups(profile).has("wiki");
}

/**
 * Is the wiki READ slice the whole wiki surface this profile serves — `wiki`
 * dropped, `wiki-read` kept? Only then are the slice's seven GET paths in the
 * auth user zone (`src/auth/zones.ts`, `WIKI_READ_SLICE_PATHS`), and only then
 * do the read routes serve read-only roots alone. On `default` the reader is
 * the operator's full surface and role `user` gets 403 on all of it.
 */
export function servesWikiReadSliceOnly(profile: MuninnProfile): boolean {
  const dropped = droppedRouteGroups(profile);
  return dropped.has("wiki") && !dropped.has("wiki-read");
}
