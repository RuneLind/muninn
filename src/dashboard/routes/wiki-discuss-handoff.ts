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
import {
  HANDOFF_BODY_MAX,
  HANDOFF_CONTEXT_MAX,
  HANDOFF_HEADING_MAX,
  HANDOFF_QUESTION_MAX,
  HANDOFF_SELECTION_MAX,
} from "../../wiki/discuss-bounds.ts";
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

export interface HandoffBody {
  wiki?: string;
  relPath: string;
  question: string;
  selection?: string;
  before?: string;
  after?: string;
  atStart?: boolean;
  atEnd?: boolean;
  edge?: "added" | "reordered";
  heading?: string;
}

/** The body, or the 400 message. The bounds are `discuss-bounds.ts`'s, which
 *  the client and the pack use too; the heading alone is refused at four times
 *  its bound, and the pack cuts it to the bound. */
export function parseHandoffBody(raw: unknown): HandoffBody | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  const str = (k: string): string | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : null;
  };
  const flag = (k: string): boolean | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    return typeof v === "boolean" ? v : null;
  };
  const relPath = str("relPath");
  if (relPath === null) return "relPath must be a string";
  if (!relPath?.trim()) return "relPath is required";
  if (relPath.length > 1024) return "relPath is too long";
  const question = str("question");
  if (question === null) return "question must be a string";
  if (!question?.trim()) return "question is required";
  if (question.length > HANDOFF_QUESTION_MAX) return `question is too long (at most ${HANDOFF_QUESTION_MAX} characters)`;
  const selection = str("selection");
  if (selection === null) return "selection must be a string";
  if (selection !== undefined && !selection.trim()) return "selection is empty (leave it out to ask about the whole page)";
  if (selection !== undefined && selection.trim().length > HANDOFF_SELECTION_MAX) {
    return `selection is too long (at most ${HANDOFF_SELECTION_MAX} characters)`;
  }
  const wiki = str("wiki");
  const heading = str("heading");
  const before = str("before");
  const after = str("after");
  if (wiki === null || heading === null || before === null || after === null) return "wiki, heading, before and after must be strings";
  if ((wiki?.length ?? 0) > 200) return "wiki is too long";
  if ((heading?.length ?? 0) > HANDOFF_HEADING_MAX * 4) return "heading is too long";
  if ((before?.length ?? 0) > HANDOFF_CONTEXT_MAX || (after?.length ?? 0) > HANDOFF_CONTEXT_MAX) {
    return `before and after are at most ${HANDOFF_CONTEXT_MAX} characters`;
  }
  const atStart = flag("atStart");
  const atEnd = flag("atEnd");
  if (atStart === null || atEnd === null) return "atStart and atEnd must be true or false";
  const edge = b.edge;
  if (edge !== undefined && edge !== null && edge !== "added" && edge !== "reordered") return 'edge must be "added" or "reordered"';
  return {
    wiki,
    relPath,
    question,
    selection,
    before,
    after,
    atStart,
    atEnd,
    ...(edge === "added" || edge === "reordered" ? { edge } : {}),
    heading,
  };
}

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
