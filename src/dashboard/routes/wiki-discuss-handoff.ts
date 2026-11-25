/**
 * `POST /api/wiki/discuss/handoff` — Discuss's handoff (mimir plan
 * muninn-wiki-discuss, P1). Body `{wiki, relPath, question, selection?,
 * before?, after?, atStart?, atEnd?, edge?, heading?}`; answers `{prompt,
 * chars, location}`: the prompt the reader copies for Claude Code, built from
 * the context pack (`src/wiki/discuss-pack.ts`). No `selection` key asks about
 * the whole page; a `selection` that is blank is a 400, never a silent
 * whole-page prompt.
 *
 * Refusals, in order: 403 role not admin (the prompt carries the page's
 * absolute path, as the Agent lens route's card does) · 415 not JSON · 413 a
 * body over `HANDOFF_BODY_MAX` · 400 a malformed body or a field past its
 * bound (`discuss-bounds.ts`, the client's bounds too) · 400/404/503 the page
 * ladder `/api/wiki/page` answers · 404 a wiki without
 * `"discuss": {"handoff": true}` in its `.wiki-reader.json`.
 *
 * It calls no model and starts no process, so it carries no egress prologue
 * and a read-only wiki answers it. Each handoff it builds is logged with the
 * wiki and the page, never the question or the passage, so the use count has
 * something to count. In the `wiki` route group, which `MUNINN_PROFILE=nais` drops.
 */
import path from "node:path";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "../../config.ts";
import { resolveServingProfile } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { HANDOFF_BODY_MAX } from "../../wiki/discuss-bounds.ts";
import { parseHandoffBody } from "../../wiki/discuss-body.ts";
import { buildHandoff, planCardCommand } from "../../wiki/discuss-prompt.ts";
import { planCardRoots, planCardTargetFor } from "../../wiki/plan-card.ts";
import { parseFrontmatter, readWikiPage, resolveWikiRoot } from "../../wiki/store.ts";
import { servesWikiReadSliceOnly } from "../route-groups.ts";
import { requireJsonRequest } from "./json-request.ts";
import { resolveScopedPage } from "./wiki-read-scope.ts";

export const WIKI_DISCUSS_HANDOFF_PATH = "/api/wiki/discuss/handoff";

export interface DiscussHandoffDeps {
  /** plan-card's roots; default `planCardRoots()` from this process's env. */
  roots?: () => string[];
  env?: Record<string, string | undefined>;
  /** The page resolver; default `resolveScopedPage`. A seam for the refusal-order tests. */
  resolvePage?: typeof resolveScopedPage;
  /** The logger; default `["muninn","wiki","discuss"]`. A seam for the no-question-in-the-log test. */
  log?: { info(msg: string, props: Record<string, unknown>): void; error(msg: string, props: Record<string, unknown>): void };
}

export { parseHandoffBody, type HandoffBody } from "../../wiki/discuss-body.ts";

export function registerWikiDiscussHandoffRoute(app: Hono, config: Config, deps: DiscussHandoffDeps = {}): void {
  const log = deps.log ?? getLog("wiki", "discuss");
  const resolvePage = deps.resolvePage ?? resolveScopedPage;
  // The cheap refusals run before the body is read: role, then content type,
  // then the body's size, streamed (`bodyLimit` stops reading past the bound).
  const gate = async (c: Context, next: Next) => {
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "Ask Claude Code is for admins" }, 403);
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    await next();
  };
  const limit = bodyLimit({
    maxSize: HANDOFF_BODY_MAX,
    onError: (c) => c.json({ error: `request body is larger than ${HANDOFF_BODY_MAX} bytes`, code: "too_large" }, 413),
  });
  app.post(WIKI_DISCUSS_HANDOFF_PATH, gate, limit, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body is not valid JSON" }, 400);
    }
    const body = parseHandoffBody(raw);
    if (typeof body === "string") return c.json({ error: body }, 400);
    try {
      const profile = config.profile ?? resolveServingProfile();
      const page = await resolvePage(servesWikiReadSliceOnly(profile), { wiki: body.wiki, bot: undefined, relPath: body.relPath, name: undefined });
      if (!page.ok) return c.json({ error: page.error }, page.status);
      if (page.index.readerConfig?.discuss?.handoff !== true) {
        return c.json({ error: "this wiki does not offer Ask Claude Code", reason: "off" }, 404);
      }
      const markdown = await readWikiPage(page.index, page.meta);
      if (markdown === null) return c.json({ error: "page file unreadable" }, 503);
      // Resolved: `resolveWikiRoot` returns a `WIKI_DIR` root as written, which may be relative, and the prompt promises an absolute path.
      const wikiDir = path.resolve(resolveWikiRoot(page.entry?.root));
      const target = planCardTargetFor({
        env: deps.env ?? process.env,
        roots: (deps.roots ?? (() => planCardRoots()))(),
        wikiDir,
        relPath: page.meta.relPath,
        hasPlanStatus: parseFrontmatter(markdown).plan_status !== undefined,
      });
      const { pack, prompt } = buildHandoff({
        wiki: page.entry?.name ?? "",
        relPath: page.meta.relPath,
        title: page.meta.title,
        absPath: target?.abs ?? path.join(wikiDir, page.meta.relPath),
        raw: markdown,
        selection: body.selection,
        before: body.before,
        after: body.after,
        atStart: body.atStart,
        atEnd: body.atEnd,
        edge: body.edge,
        heading: body.heading,
        cardCommand: target ? planCardCommand(target.bin, target.abs) : null,
        question: body.question,
      });
      const loc = pack.location;
      // Never the question, the passage or its context.
      log.info("discuss handoff on {wiki} {relPath}: {found}", {
        wiki: page.entry?.name ?? "",
        relPath: page.meta.relPath,
        found: loc ? loc.found : "page",
        reason: loc?.reason ?? null,
        tier: loc?.tier ?? null,
        matches: loc?.matches ?? null,
        fromLine: loc?.fromLine ?? null,
        toLine: loc?.toLine ?? null,
        card: pack.cardCommand !== null,
        chars: prompt.length,
      });
      return c.json({
        prompt,
        chars: prompt.length,
        location: loc
          ? { found: loc.found, reason: loc.reason, tier: loc.tier, matches: loc.matches, fromLine: loc.fromLine, toLine: loc.toLine, ambiguous: loc.ambiguous }
          : null,
      });
    } catch (err) {
      log.error("discuss handoff failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not build the prompt" }, 500);
    }
  });
}
