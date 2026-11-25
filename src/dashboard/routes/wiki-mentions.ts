/**
 * `GET /api/wiki/mentions?wiki=&key=` — where a key is mentioned in one wiki
 * (Discuss v2 PR 2): its files and lines, the commits that changed it, its
 * `log.md` entries and the PRs those lines name. The builder is
 * `src/wiki/mentions.ts`; this is a thin caller. No model call: it is the
 * source of a key's hover peek (D5) and the Trace view (D4, PR 6).
 *
 * In the `wiki` tool group, which `MUNINN_PROFILE=nais` drops, and 404 on any
 * instance where `MUNINN_AUTH` is not `off`: the pod is a non-goal. It spawns
 * `git grep` and `git log` per request, and a cache miss starts one background
 * `gh` flight, so it is on `SIDE_EFFECTING_GETS`. A read-only root is answered
 * from the caches alone, as the work map's check never reaches `gh` there.
 *
 * Answers in this order: 404 auth on · 400 no wiki · 400 a bad key · 404 an
 * unknown wiki · 500 a git failure · 200 the body.
 */

import type { Hono } from "hono";
import { authMode } from "../../auth/policy.ts";
import { getLog } from "../../logging.ts";
import { buildMentions, parseMentionKey, type MentionsDeps } from "../../wiki/mentions.ts";
import { isReadonlyWikiRoot } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest, type WikiRegistryEntry } from "../../wiki/registry.ts";
import { getWikiIndex, type WikiIndex } from "../../wiki/store.ts";
import { realGhCheckDeps, type GhCheckDeps } from "../../wiki/work-map/gh-check.ts";

const log = getLog("dashboard", "wiki-mentions");

export const WIKI_MENTIONS_PATH = "/api/wiki/mentions";

export interface WikiMentionsRouteDeps {
  registry: () => readonly WikiRegistryEntry[];
  index: (root: string) => Promise<WikiIndex | null>;
  gh: () => Pick<GhCheckDeps, "runGh" | "disabled">;
  isReadonlyRoot: (root: string) => boolean;
  now: () => number;
  git?: MentionsDeps["git"];
  authMode: () => string;
}

export function realWikiMentionsDeps(): WikiMentionsRouteDeps {
  let gh: GhCheckDeps | undefined;
  return {
    registry: getWikiRegistry,
    index: (root) => getWikiIndex({ root }),
    gh: () => (gh ??= realGhCheckDeps()),
    isReadonlyRoot: isReadonlyWikiRoot,
    now: Date.now,
    authMode,
  };
}

export function registerWikiMentionsRoute(app: Hono, deps: WikiMentionsRouteDeps = realWikiMentionsDeps()): void {
  app.get(WIKI_MENTIONS_PATH, async (c) => {
    // Absent on an authenticating instance, the same 404 a dropped group gives.
    if (deps.authMode() !== "off") return c.notFound();
    if (!c.req.query("wiki")?.trim()) return c.json({ error: "wiki is required" }, 400);
    const parsed = parseMentionKey(c.req.query("key"));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { entry } = resolveWikiRequest([...deps.registry()], c.req.query("wiki"), undefined, undefined);
    if (!entry) return c.json({ error: "no wiki configured for that name" }, 404);
    try {
      const index = await deps.index(entry.root);
      const res = await buildMentions(
        { wiki: entry.name, root: entry.root, key: parsed.key, index },
        { git: deps.git, gh: deps.isReadonlyRoot(entry.root) ? null : deps.gh(), now: deps.now },
      );
      if (!res.ok) {
        log.warn("Mentions for a key in {wiki} failed: {error}", { wiki: entry.name, error: res.error });
        return c.json({ error: "the search failed" }, 500);
      }
      return c.json(res.body);
    } catch (err) {
      log.warn("Mentions for a key in {wiki} failed: {error}", { wiki: entry.name, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the search failed" }, 500);
    }
  });
}
