/**
 * `POST /api/wiki/discuss` — Discuss's wiki agent, the pane's entry point
 * (mimir plans muninn-wiki-discuss, muninn-wiki-discuss-v2). Body: the
 * handoff's (`{wiki, relPath, question, selection?, before?, after?, atStart?,
 * atEnd?, edge?, heading?}`) plus `discussionId?` (the page's live wiki
 * thread), `mode?` (`explore` | `edit`) and `userId?`, read by
 * `parseDiscussBody`. Answers an SSE stream: `turn`, `status`, `delta`,
 * `tool`, then `done` or `app_error`, then `end` (heartbeats between).
 *
 * The preflight and the turn are the Discuss engine's
 * (`src/wiki/discuss-engine.ts`), which /chat's send route runs too for a
 * `kind = 'wiki'` thread. Here: 403 role · 415 not JSON · 413 body too large ·
 * 400 a malformed body, then the engine's ladder, every refusal JSON before
 * the stream. The route builds the /chat mirror (`chatWikiMirror`), so a
 * popped-out /chat watches the pane's turn live.
 *
 * The turn runs to its end and is stored whether or not its reader is still
 * there: nothing in it reads the request's abort signal, and the stream's
 * writes are guarded. In the `wiki` route group, which `MUNINN_PROFILE=nais`
 * drops; admin-only by the zone model's default-deny too.
 *
 * Also here: «Continue in Claude Code» (`/api/wiki/discuss/continue`), the
 * page's thread read (`GET /api/wiki/discuss/thread`) and «Start over»
 * (`POST /api/wiki/discuss/thread/close`).
 */
import path from "node:path";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { discoverAllBots, resolveWikiSynthesisBot } from "../../bots/config.ts";
import {
  getDiscussTurn,
  listDiscussTurns,
  listPageOneShotTurns,
  listThreadMessagesWithTurns,
  markDiscussTurnHandedOver,
} from "../../db/wiki-discuss-turns.ts";
import { closeWikiThread, getLiveWikiThread, getThreadById, listClosedWikiThreads } from "../../db/threads.ts";
import { sha256 } from "../../utils/date-hash.ts";
import { HANDOFF_BODY_MAX } from "../../wiki/discuss-bounds.ts";
import { renderContinuePrompt } from "../../wiki/discuss-prompt.ts";
import {
  createDiscussEngine,
  parseDiscussBody,
  sharedDiscussEngine,
  type DiscussEngine,
  type DiscussEngineDeps,
  type DiscussMirrorFactory,
} from "../../wiki/discuss-engine.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { getWikiIndex, readWikiText, resolveWikiRoot } from "../../wiki/store.ts";
import { chatWikiMirror, chatUsersFor } from "../../chat/wiki-mirror.ts";
import { requireJsonRequest } from "./json-request.ts";
import { isValidUuid } from "./route-utils.ts";
import { egressRefusal } from "./wiki-egress.ts";

export {
  COPILOT_DISCUSS_TOOLS,
  copilotDiscussReach,
  DISCUSS_CONNECTOR_GRACE_MS,
  DISCUSS_HEARTBEAT_MS,
  DISCUSS_MAX_INFLIGHT,
  DISCUSS_STALE_RUNNING_MS,
  DISCUSS_SWEEP_MS,
  DiscussTurnTimeout,
  discussSurfaceKind,
  parseDiscussBody,
  startDiscussTurnSweep,
  stopDiscussTurnSweep,
  type DiscussBody,
  type DiscussStore,
} from "../../wiki/discuss-engine.ts";
export { wikiAgentRulesRefusal } from "../../wiki/discuss-agent.ts";

export const WIKI_DISCUSS_PATH = "/api/wiki/discuss";
/** «Continue in Claude Code» (P3): `{turnId}` → `{prompt, handedOverAt}`. */
export const WIKI_DISCUSS_CONTINUE_PATH = "/api/wiki/discuss/continue";
/** The page's wiki thread: `?wiki&relPath&userId?`. */
export const WIKI_DISCUSS_THREAD_PATH = "/api/wiki/discuss/thread";
/** «Start over»: `{threadId}` closes the live thread. */
export const WIKI_DISCUSS_THREAD_CLOSE_PATH = "/api/wiki/discuss/thread/close";

export interface DiscussRouteDeps extends DiscussEngineDeps {
  /** The engine; default a new one over these deps, or the process's shared
   *  engine when no deps are given (so the cap covers /chat's entry too). */
  engine?: DiscussEngine;
  /** The /chat mirror; default `chatWikiMirror()`, null for none. */
  mirror?: DiscussMirrorFactory | null;
  /** The continue route's reads and its one write; default the DB's. */
  continueStore?: { get: typeof getDiscussTurn; list: typeof listDiscussTurns; handedOver: typeof markDiscussTurnHandedOver };
}

export function registerWikiDiscussRoute(app: Hono, config: Config, deps: DiscussRouteDeps = {}): void {
  const log = deps.log ?? getLog("wiki", "discuss");
  const chatUsers = deps.chatUsers ?? chatUsersFor;
  const engine =
    deps.engine ?? (Object.keys(deps).length === 0 ? sharedDiscussEngine(config, { chatUsers }) : createDiscussEngine(config, { ...deps, chatUsers }));
  const mirror = deps.mirror === undefined ? chatWikiMirror() : deps.mirror;

  const admin = async (c: Context, next: Next) => {
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "Discuss's wiki agent is for admins" }, 403);
    await next();
  };
  const gate = async (c: Context, next: Next) => {
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "Discuss's wiki agent is for admins" }, 403);
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    await next();
  };
  const limit = bodyLimit({
    maxSize: HANDOFF_BODY_MAX,
    onError: (c) => c.json({ error: `request body is larger than ${HANDOFF_BODY_MAX} bytes`, code: "too_large" }, 413),
  });

  app.post(WIKI_DISCUSS_PATH, gate, limit, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body is not valid JSON" }, 400);
    }
    const body = parseDiscussBody(raw);
    if (typeof body === "string") return c.json({ error: body }, 400);

    const started = await engine.start({ role: c.get("role") ?? "admin", body, ...(mirror ? { mirror } : {}) });
    if (started.refused) return c.json(started.body, started.status);

    try {
      return streamSSE(c, async (stream) => {
        let gone = false;
        const emit = (event: string, data: unknown) => {
          if (gone) return;
          stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {
            gone = true;
          });
        };
        const heartbeat = setInterval(() => emit("heartbeat", {}), 30_000);
        try {
          stream.onAbort(() => {
            gone = true;
            clearInterval(heartbeat);
            started.readerLeft();
          });
          await started.run(emit);
          if (!gone) await stream.writeSSE({ event: "end", data: "{}" }).catch(() => {});
        } finally {
          started.release();
          clearInterval(heartbeat);
        }
      });
    } catch (err) {
      started.release();
      throw err;
    }
  });

  // «Continue in Claude Code» (P3): the prompt that takes the discussion on to
  // Claude Code up to this turn, and the turn's `handed_over_at`. No model is
  // called; it carries the discuss route's guards anyway (admin, JSON, the
  // wiki's egress prologue), since it marks a row and hands a model-written
  // answer on. Refusals: 403 role · 415 · 413 · 400 body · 404 unknown turn ·
  // 404 the turn's wiki is not configured here · 403 `readonly` · 409 the turn
  // is still running · 500. A trace turn (no page) gets a prompt with no page path.
  const contStore = deps.continueStore ?? { get: getDiscussTurn, list: listDiscussTurns, handedOver: markDiscussTurnHandedOver };
  const smallLimit = bodyLimit({
    maxSize: 1024,
    onError: (c) => c.json({ error: "request body is larger than 1024 bytes", code: "too_large" }, 413),
  });
  app.post(WIKI_DISCUSS_CONTINUE_PATH, gate, smallLimit, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body is not valid JSON" }, 400);
    }
    const turnId = (raw as { turnId?: unknown } | null)?.turnId;
    if (typeof turnId !== "string" || !isValidUuid(turnId)) return c.json({ error: "turnId must be a uuid" }, 400);
    try {
      const turn = await contStore.get(turnId.toLowerCase());
      if (!turn) return c.json({ error: "no discuss turn with that id", reason: "unknown-turn" }, 404);
      const { entry, unknownWiki } = resolveWikiRequest(getWikiRegistry(), turn.wiki, undefined, process.env.WIKI_DIR);
      if (unknownWiki) return c.json({ error: `no wiki configured for "${turn.wiki}"` }, 404);
      const egress = egressRefusal(c, entry, unknownWiki);
      if (egress) return egress;
      if (turn.endState === "running") return c.json({ error: "the turn is still running; hand it over once it has ended", reason: "running" }, 409);
      const turns = (await contStore.list(turn.discussionId)).filter((t) => t.seq <= turn.seq);
      const pagePath = turn.relPath === null ? null : path.join(path.resolve(resolveWikiRoot(entry?.root)), turn.relPath);
      // A turn's lines were placed on the page it was stored with: against
      // another text they would name other lines of the file the prompt points at.
      const live = pagePath === null ? null : await readWikiText(pagePath).then(sha256, () => null);
      const prompt = renderContinuePrompt({
        path: pagePath,
        turns: turns.map((t) => ({ seq: t.seq, selection: t.selection, location: t.location, question: t.question, answer: t.answer, endState: t.endState, pageChanged: live !== t.pageHash })),
      });
      const marked = await contStore.handedOver(turn.id);
      log.info("discuss turn handed over on {wiki} {relPath}", { wiki: turn.wiki, relPath: turn.relPath, turnId: turn.id, seq: turn.seq, chars: prompt.length });
      return c.json({ prompt, chars: prompt.length, handedOverAt: marked?.handedOverAt ?? null });
    } catch (err) {
      log.error("discuss continue failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not build the prompt" }, 500);
    }
  });

  // The page's wiki thread (PR 4's pane reads it): the live thread, its
  // messages each joined to its ledger row (so an edit card has its turn id),
  // the page's closed threads («Earlier discussions») and its old one-shot
  // turns (`thread_id IS NULL`, read-only). Calls no model, so no egress
  // prologue. Refusals: 403 role · 400 query · 404 unknown wiki or page · 503
  // `no-bot` · 422 `no-user` / `unknown-user` (the engine's user rule) · 500.
  app.get("/api/wiki/discuss/thread", admin, async (c) => {
    const relPathQ = c.req.query("relPath");
    if (!relPathQ?.trim() || relPathQ.length > 1024) return c.json({ error: "relPath is required" }, 400);
    const postedUser = c.req.query("userId");
    try {
      const { entry, unknownWiki, wiki } = resolveWikiRequest(getWikiRegistry(), c.req.query("wiki"), undefined, process.env.WIKI_DIR);
      if (unknownWiki) return c.json({ error: `no wiki configured for "${wiki || "(none)"}"` }, 404);
      const index = await getWikiIndex({ root: entry?.root });
      const meta = index?.resolveRelPath(relPathQ);
      if (!meta) return c.json({ error: `no wiki page for relPath "${relPathQ}"` }, 404);
      const { bot, origin } = resolveWikiSynthesisBot(entry, (deps.bots ?? discoverAllBots)());
      if (!bot || (entry?.synthesisBot && origin !== "pinned")) return c.json({ error: "no bot answers on this wiki here", reason: "no-bot" }, 503);
      const who = await engine.resolveUser(bot.name, postedUser || undefined);
      if ("refused" in who) return c.json(who.body, who.status);
      const wikiName = entry?.name ?? "";
      const thread = await getLiveWikiThread(who.userId, bot.name, wikiName, meta.relPath);
      const [messages, closed, oneShot] = await Promise.all([
        thread ? listThreadMessagesWithTurns(thread.id) : Promise.resolve([]),
        listClosedWikiThreads(who.userId, bot.name, wikiName, meta.relPath),
        listPageOneShotTurns(wikiName, meta.relPath),
      ]);
      return c.json({
        userId: who.userId,
        bot: bot.name,
        thread: thread ? { id: thread.id, name: thread.name, createdAt: thread.createdAt } : null,
        messages,
        closed: closed.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, closedAt: t.closedAt ?? null })),
        oneShot,
      });
    } catch (err) {
      log.error("discuss thread read failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not read the thread" }, 500);
    }
  });

  // «Start over»: close the page's live thread; it stays readable and
  // deletable under «Earlier discussions». Refusals: 403 role · 415 · 413 ·
  // 400 body · 404 not a live wiki thread · 500.
  app.post(WIKI_DISCUSS_THREAD_CLOSE_PATH, gate, smallLimit, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body is not valid JSON" }, 400);
    }
    const threadId = (raw as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== "string" || !isValidUuid(threadId)) return c.json({ error: "threadId must be a uuid" }, 400);
    try {
      const thread = await getThreadById(threadId.toLowerCase());
      if (!thread || thread.kind !== "wiki" || thread.closedAt !== undefined) return c.json({ error: "no live wiki thread with that id", reason: "unknown-thread" }, 404);
      const closed = await closeWikiThread(thread.id);
      log.info("discuss thread closed on {wiki} {relPath}", { wiki: thread.wiki, relPath: thread.relPath, threadId: thread.id, closed });
      return c.json({ closed });
    } catch (err) {
      log.error("discuss thread close failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not close the thread" }, 500);
    }
  });
}
