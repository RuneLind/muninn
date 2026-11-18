/**
 * `POST /api/wiki/discuss/handoff` — Discuss's handoff (mimir plan
 * muninn-wiki-discuss, P1). Body `{wiki, relPath, question, selection?,
 * occurrence?, total?, heading?}`; answers `{prompt, chars, location}`: the
 * prompt the reader copies for Claude Code, built from the context pack
 * (`src/wiki/discuss-pack.ts`). No `selection` asks about the whole page.
 *
 * Refusals, in order: 403 role not admin (the prompt carries the page's
 * absolute path, as the Agent lens route's card does) · 415 not JSON · 400 a
 * malformed body · 400/404/503 the page ladder `/api/wiki/page` answers · 404
 * a wiki without `"discuss": {"handoff": true}` in its `.wiki-reader.json`.
 *
 * It calls no model and starts no process, so it carries no egress prologue
 * and a read-only wiki answers it. Each handoff it builds is logged with the
 * wiki and the page, never the question or the passage, so the use count has
 * something to count. In the `wiki` route group, which `MUNINN_PROFILE=nais` drops.
 */
import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { resolveServingProfile } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { buildHandoff, HANDOFF_QUESTION_MAX, planCardCommand } from "../../wiki/discuss-prompt.ts";
import { PACK_HEADING_MAX, PACK_PASSAGE_MAX } from "../../wiki/discuss-pack.ts";
import { planCardRoots, planCardTargetFor } from "../../wiki/plan-card.ts";
import { parseFrontmatter, readWikiPage, resolveWikiRoot } from "../../wiki/store.ts";
import { servesWikiReadSliceOnly } from "../route-groups.ts";
import { requireJsonRequest } from "./json-request.ts";
import { resolveScopedPage } from "./wiki-read-scope.ts";

const log = getLog("wiki", "discuss");

export const WIKI_DISCUSS_HANDOFF_PATH = "/api/wiki/discuss/handoff";

export interface DiscussHandoffDeps {
  /** plan-card's roots; default `planCardRoots()` from this process's env. */
  roots?: () => string[];
  env?: Record<string, string | undefined>;
}

interface HandoffBody {
  wiki?: string;
  relPath: string;
  question: string;
  selection?: string;
  occurrence?: number;
  total?: number;
  heading?: string;
}

/** The body, or the 400 message. Bounds are generous: the pack clamps again. */
export function parseHandoffBody(raw: unknown): HandoffBody | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  const str = (k: string, max: number, required = false): string | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null) return required ? null : undefined;
    if (typeof v !== "string" || v.length > max) return null;
    return v;
  };
  const count = (k: string): number | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null;
  };
  const relPath = str("relPath", 1024, true);
  if (!relPath || !relPath.trim()) return "relPath is required";
  const question = str("question", HANDOFF_QUESTION_MAX * 2, true);
  if (question === null || question === undefined || !question.trim()) return "question is required";
  const wiki = str("wiki", 200);
  const selection = str("selection", PACK_PASSAGE_MAX * 4);
  const heading = str("heading", PACK_HEADING_MAX * 4);
  const occurrence = count("occurrence");
  const total = count("total");
  if (wiki === null || selection === null || heading === null) return "wiki, selection and heading must be strings within their bounds";
  if (occurrence === null || total === null) return "occurrence and total must be whole numbers";
  return { wiki, relPath, question, selection, occurrence, total, heading };
}

export function registerWikiDiscussHandoffRoute(app: Hono, config: Config, deps: DiscussHandoffDeps = {}): void {
  app.post(WIKI_DISCUSS_HANDOFF_PATH, async (c) => {
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "Ask Claude Code is for admins" }, 403);
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
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
      const page = await resolveScopedPage(servesWikiReadSliceOnly(profile), { wiki: body.wiki, bot: undefined, relPath: body.relPath, name: undefined });
      if (!page.ok) return c.json({ error: page.error }, page.status);
      if (page.index.readerConfig?.discuss?.handoff !== true) {
        return c.json({ error: "this wiki does not offer Ask Claude Code", reason: "off" }, 404);
      }
      const markdown = await readWikiPage(page.index, page.meta);
      if (markdown === null) return c.json({ error: "page file unreadable" }, 503);
      const wikiDir = resolveWikiRoot(page.entry?.root);
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
        occurrence: body.occurrence,
        total: body.total,
        heading: body.heading,
        cardCommand: target ? planCardCommand(target.bin, target.abs) : null,
        question: body.question,
      });
      const loc = pack.location;
      log.info("discuss handoff on {wiki} {relPath}: {found}", {
        wiki: page.entry?.name ?? "",
        relPath: page.meta.relPath,
        found: loc ? loc.found : "page",
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
          ? { found: loc.found, tier: loc.tier, matches: loc.matches, fromLine: loc.fromLine, toLine: loc.toLine, ambiguous: loc.ambiguous }
          : null,
      });
    } catch (err) {
      log.error("discuss handoff failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not build the prompt" }, 500);
    }
  });
}
