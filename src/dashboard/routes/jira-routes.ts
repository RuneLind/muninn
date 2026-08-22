/**
 * The Jira composer's HTTP surface — the registrar half of the house split
 * (`jira-sse.ts` owns the stream function, the way `share-sse.ts` /
 * `factcheck-sse.ts` are stream functions registered from `wiki-routes.ts`).
 *
 * Five endpoints:
 *
 *   · `GET  /api/jira/templates`   — the picker's source. `/api/research/variants`
 *     is hardcoded to `jiraAnalysisVariants` and does not generalise.
 *   · `POST /api/jira/draft`       — SSE. The page's own path.
 *   · `POST /api/jira/draft/start` — plain JSON: creates the row, returns
 *     `{draftId}` immediately, generation continues server-side. This exists for
 *     the Chrome extension: an MV3 action popup is destroyed the moment it loses
 *     focus, taking an in-flight `fetch` and any SSE stream with it, and this
 *     feature's budget is 120–600 s. Waiting inside the popup cannot work.
 *   · `GET  /api/jira/draft/:id`   — status + the whole draft. **The page POLLS
 *     this**; it does not attach to the stream. There is nothing to attach to —
 *     the only SSE endpoint STARTS a generation, and re-POSTing identical content
 *     would hit the single-flight 409, which is exactly this case.
 *   · `PUT  /api/jira/draft/:id`   — the reader's edit. Design call 3 makes save
 *     load-bearing: after the Jira paste the markdown exists nowhere else.
 *
 * `GET`/`start` carry `Access-Control-Allow-Origin: *` with an `app.options`
 * preflight, matching `POST /api/research/chat`, which the extension already
 * calls. The consequence is stated in the migration and accepted: any page the
 * browser visits could read a draft id it can guess, bounded by `DASHBOARD_HOST`
 * defaulting to loopback.
 *
 * Deliberately **not** added to `openapi-spec.ts`: neither `POST /api/wiki/share`
 * nor `POST /api/research/ask` is there, so documenting these would be new scope,
 * not a convention being followed.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { getMcpStatus, findCriticalDown, type McpServerStatus } from "../../ai/mcp-status.ts";
import { jiraBotMissingMessage, resolveJiraBot } from "../../jira/bot.ts";
import { findJiraTemplate, resolveJiraTemplates } from "../../jira/templates.ts";
import { JIRA_FULL_MCP_SERVERS } from "../../jira/tool-fence.ts";
import { checkJiraMarkdown } from "../../jira/markdown-check.ts";
import { verifyJiraKeys } from "../../jira/verify-keys.ts";
import {
  JIRA_MARKDOWN_MAX,
  parseJiraDraftBody,
  type JiraDepth,
  type ParsedJiraDraftBody,
} from "../../jira/wire.ts";
import { createJiraDraft, getJiraDraft, updateJiraDraftMarkdown } from "../../db/jira-drafts.ts";
import {
  acquireJiraFlight,
  jiraFlightKey,
  runJiraDraftDetached,
  streamJiraSSE,
  type JiraSseOptions,
} from "./jira-sse.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "jira-routes");

/** Test seam for the model call — the `__setShareOneShotForTest` precedent, which
 *  exists specifically so a route's happy path is reachable without spending one. */
let oneShotOverride: JiraSseOptions["oneShot"] | undefined;
export function __setJiraOneShotForTest(fn: JiraSseOptions["oneShot"] | undefined): void {
  oneShotOverride = fn;
}
/** Test seams for the two huginn-backed steps. */
let retrieveOverride: JiraSseOptions["retrieve"] | undefined;
let questionOverride: JiraSseOptions["buildQuestion"] | undefined;
export function __setJiraRetrievalForTest(
  retrieve: JiraSseOptions["retrieve"] | undefined,
  buildQuestion?: JiraSseOptions["buildQuestion"],
): void {
  retrieveOverride = retrieve;
  questionOverride = buildQuestion;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

/**
 * Everything both POST paths must agree on, resolved once.
 *
 * Returns a `Response` on any refusal so the SSE route can return it BEFORE
 * `streamSSE` commits a 200 — the ordering contract this route family lives by.
 */
type Resolved =
  | { ok: true; bot: BotConfig; body: ParsedJiraDraftBody; instruction: string; mcpServers: McpServerStatus[] }
  | { ok: false; response: Response };

async function resolveDraftRequest(c: Context): Promise<Resolved> {
  const raw = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  // BODY-SHAPE checks first: they need nothing but the body and are wrong under
  // every bot. Resolution-dependent checks (the template id, the Full pre-flight)
  // wait, because their valid answers are a function of what resolved.
  const parsed = parseJiraDraftBody(raw);
  if (!parsed.ok) return { ok: false, response: c.json({ error: parsed.error }, 400) };

  const bot = resolveJiraBot(discoverAllBots());
  if (!bot) return { ok: false, response: c.json({ error: jiraBotMissingMessage() }, 503) };

  const template = findJiraTemplate(resolveJiraTemplates(bot.prompts), parsed.body.template);
  if (!template) {
    return { ok: false, response: c.json({ error: `ukjent mal "${parsed.body.template}"` }, 400) };
  }

  // The MCP probe. Run at EVERY depth, not just `Full`, because its result is
  // also what `buildDepthFence` enumerates for a connector with no `mcp:*`
  // wildcard — and it is cached (60 s TTL) so the tool-less depths pay nothing
  // in the common case. It never throws: `getMcpStatus` reports a dead server as
  // a `down` row.
  let mcpServers: McpServerStatus[] = [];
  try {
    mcpServers = await getMcpStatus(bot);
  } catch (err) {
    log.warn("jira MCP probe failed bot={bot} error={error}", {
      bot: bot.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (parsed.body.depth === "full") {
    // `Full`'s pre-flight is REACHABILITY, not capability. TikTok's
    // `supportsExtraDirs` check is the shape precedent but not the mechanism —
    // that is a static connector test. `code` (serena proxy) and `yggdrasil` are
    // the ONLY path to NAV source on a copilot bot, where the fenced runner
    // excludes Bash/Agent/Task, so a Full draft with them down is not a degraded
    // draft: it is a confident task about code nobody opened.
    const down = missingFullServers(mcpServers);
    if (down.length > 0) {
      return {
        ok: false,
        response: c.json(
          {
            error:
              `Full teknisk dybde krever kodeverktøyene, og disse er ikke tilgjengelige: ${down.join(", ")}. ` +
              `Start dem fra dashbordet (/serena og yggdrasil), eller velg dybde «Skisse».`,
            unreachableServers: down,
          },
          503,
        ),
      };
    }
  }

  return { ok: true, bot, body: parsed.body, instruction: template.content, mcpServers };
}

/**
 * Which of `code`/`yggdrasil` are not usable right now.
 *
 * A server ABSENT from the probe counts as missing, not as fine: the probe lists
 * every server in the bot's `.mcp.json`, so an absent name means the bot is not
 * configured with it at all — which for `Full` is the same outcome as down.
 * `findCriticalDown` is consulted too so a bot that marks these critical gets the
 * same verdict from either direction.
 */
export function missingFullServers(servers: McpServerStatus[]): string[] {
  const criticalDown = new Set(findCriticalDown(servers).map((s) => s.name));
  return JIRA_FULL_MCP_SERVERS.filter((name) => {
    const s = servers.find((x) => x.name === name);
    return !s || s.status === "down" || criticalDown.has(name);
  });
}

/** Build the SSE options shared by the streaming and the detached paths. */
async function buildSseOptions(
  config: Config,
  bot: BotConfig,
  body: ParsedJiraDraftBody,
  instruction: string,
  mcpServers: McpServerStatus[],
  release: (() => void) | undefined,
): Promise<{ opts: JiraSseOptions; error?: string }> {
  const base: JiraSseOptions = {
    config,
    botConfig: bot,
    instruction,
    template: body.template,
    depth: body.depth,
    notes: body.notes,
    extra: body.extra,
    excludeDocIds: body.excludeDocIds,
    mcpServers,
    ...(release ? { onSettled: release } : {}),
    ...(oneShotOverride ? { oneShot: oneShotOverride } : {}),
    ...(retrieveOverride ? { retrieve: retrieveOverride } : {}),
    ...(questionOverride ? { buildQuestion: questionOverride } : {}),
  };

  if (!body.draftId) return { opts: base };

  // Regenerate: load the stored hit set. The notes come from the row too — the
  // page does not echo a 10 KB Slack thread back on every toggle click.
  const stored = await getJiraDraft(body.draftId);
  if (!stored) return { opts: base, error: `ukjent utkast "${body.draftId}"` };
  return {
    opts: {
      ...base,
      notes: body.notes.trim() ? body.notes : stored.notes,
      storedCitations: stored.citations,
      existingDraftId: stored.draftId,
      storedRetrievalQuestion: stored.retrievalQuestion,
      ...(stored.coverage ? { storedCoverage: stored.coverage } : {}),
    },
  };
}

export function registerJiraRoutes(app: Hono, config: Config): void {
  // ── The picker's source ────────────────────────────────────────────────────
  app.get("/api/jira/templates", (c) => {
    const bot = resolveJiraBot(discoverAllBots());
    if (!bot) return c.json({ error: jiraBotMissingMessage() }, 503);
    const templates = resolveJiraTemplates(bot.prompts).map((t) => ({ id: t.id, label: t.label }));
    // `no-store` for the same reason `GET /api/wiki/share/presets` is: a
    // heuristically cached list makes the POST 400 for reasons the reader cannot
    // see (the picker offers an id the server no longer has).
    c.header("Cache-Control", "no-store");
    return c.json({ bot: bot.name, templates });
  });

  // ── The streaming draft ────────────────────────────────────────────────────
  app.post("/api/jira/draft", async (c) => {
    // Wrapped like `share` / `remember` / `factcheck/append`: an unexpected throw
    // anywhere below returns 500 JSON rather than an unhandled rejection.
    try {
      const resolved = await resolveDraftRequest(c);
      if (!resolved.ok) return resolved.response;
      const { bot, body, instruction, mcpServers } = resolved;

      // Single-flight on the CONTENT hash — see `jiraFlightKey`. Claimed only
      // once every pre-commit refusal is behind us, so a bad template id cannot
      // reserve a note for two minutes.
      const key = jiraFlightKey(body.notes, body.template, body.depth, body.excludeDocIds);
      const acquired = acquireJiraFlight(key, body.depth);
      if (!acquired.ok) {
        return c.json(
          {
            state: "running",
            expiresAtMs: acquired.expiresAtMs,
            error: "Det skrives allerede et utkast for dette råmaterialet — vent til det er ferdig.",
          },
          409,
        );
      }

      const { opts, error } = await buildSseOptions(
        config, bot, body, instruction, mcpServers, acquired.release,
      );
      if (error) {
        acquired.release();
        return c.json({ error }, 404);
      }

      log.info("Jira draft: bot={bot} template={template} depth={depth} notes={notes} regen={regen}", {
        bot: bot.name,
        template: body.template,
        depth: body.depth,
        notes: body.notes.length,
        regen: !!body.draftId,
      });

      // The slot is handed to the stream via `onSettled` — but only once
      // `streamJiraSSE` has RETURNED a Response. A synchronous throw before that
      // would leave the callback unwired and wedge the note for the full expiry
      // with nothing running; releasing here is safe precisely because it is
      // unreachable once the stream owns the slot (release is identity-checked
      // anyway). The share/claim-retry handover, verbatim.
      try {
        return streamJiraSSE(c, opts);
      } catch (err) {
        acquired.release();
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Jira draft route failed: {error}", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  // ── The extension's fire-and-forget start ──────────────────────────────────
  app.options("/api/jira/draft/start", (c) => new Response(null, { status: 204, headers: CORS_HEADERS }));

  app.post("/api/jira/draft/start", async (c) => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) c.header(k, v);
    try {
      const resolved = await resolveDraftRequest(c);
      if (!resolved.ok) return resolved.response;
      const { bot, body, instruction, mcpServers } = resolved;

      const key = jiraFlightKey(body.notes, body.template, body.depth, body.excludeDocIds);
      const acquired = acquireJiraFlight(key, body.depth);
      if (!acquired.ok) {
        return c.json(
          { state: "running", expiresAtMs: acquired.expiresAtMs, error: "Et likt utkast skrives allerede." },
          409,
        );
      }

      const { opts, error } = await buildSseOptions(
        config, bot, body, instruction, mcpServers, acquired.release,
      );
      if (error) {
        acquired.release();
        return c.json({ error }, 404);
      }

      // The row is created HERE, not inside the runner, so the id can be
      // returned before any expensive work starts — the popup gets it and closes.
      const draftId =
        opts.existingDraftId ??
        (await createJiraDraft({
          botName: bot.name,
          template: body.template,
          depth: body.depth,
          notes: opts.notes,
          extra: body.extra,
        }));

      // Detached on purpose: the caller is a popup that is about to die. Errors
      // land on the row (the runner owns that), so a rejection here would be
      // both impossible and unactionable — but it is caught anyway, because an
      // unhandled rejection from a detached promise takes the process with it.
      void runJiraDraftDetached({ ...opts, existingDraftId: draftId }, bot).catch((err) => {
        log.error("Detached Jira draft threw draft={draft}: {error}", {
          draft: draftId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      log.info("Jira draft started detached: bot={bot} draft={draft} depth={depth}", {
        bot: bot.name, draft: draftId, depth: body.depth,
      });
      return c.json({ draftId, status: "generating" satisfies "generating" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Jira draft/start failed: {error}", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  // ── Read one draft (the page's poll, and PR 3's `?draft=<id>` landing) ─────
  app.options("/api/jira/draft/:id", (c) => new Response(null, { status: 204, headers: CORS_HEADERS }));

  app.get("/api/jira/draft/:id", async (c) => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) c.header(k, v);
    try {
      const draft = await getJiraDraft(c.req.param("id"));
      if (!draft) return c.json({ error: "ukjent utkast" }, 404);
      // A poll target must never be cached — the whole point is that `generating`
      // becomes `ready`.
      c.header("Cache-Control", "no-store");
      return c.json(draft);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An invalid uuid reaches postgres as a cast error; report it as a 404
      // rather than a 500 — the client asked for an id that names nothing.
      if (/invalid input syntax for type uuid/i.test(message)) {
        return c.json({ error: "ukjent utkast" }, 404);
      }
      log.error("Jira draft read failed: {error}", { error: message });
      return c.json({ error: message }, 500);
    }
  });

  // ── The reader's edit ──────────────────────────────────────────────────────
  app.put("/api/jira/draft/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const raw = await c.req.json<{ markdown?: unknown }>().catch(() => ({}) as { markdown?: unknown });
      if (typeof raw.markdown !== "string") return c.json({ error: "markdown must be a string" }, 400);
      const markdown = raw.markdown;
      if (!markdown.trim()) return c.json({ error: "markdown is required" }, 400);
      if (markdown.length > JIRA_MARKDOWN_MAX) {
        return c.json({ error: `markdown is longer than ${JIRA_MARKDOWN_MAX} characters` }, 400);
      }

      const existing = await getJiraDraft(id);
      if (!existing) return c.json({ error: "ukjent utkast" }, 404);

      // BOTH post-passes are re-run against the edited text and stored with it.
      // Leaving the old verdicts behind would leave the page asserting things
      // about text that no longer exists — a red row for a key the reader just
      // deleted, or no flag for the `- [ ]` they just typed.
      const [keyVerdicts, markdownFlags] = await Promise.all([
        verifyJiraKeys({
          markdown,
          citations: existing.citations,
          notes: existing.notes,
          knowledgeApiUrl: config.knowledgeApiUrl,
        }),
        Promise.resolve(checkJiraMarkdown(markdown)),
      ]);

      const written = await updateJiraDraftMarkdown(id, markdown, keyVerdicts, markdownFlags);
      if (!written) return c.json({ error: "ukjent utkast" }, 404);
      return c.json({ draftId: id, keyVerdicts, markdownFlags });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/invalid input syntax for type uuid/i.test(message)) {
        return c.json({ error: "ukjent utkast" }, 404);
      }
      log.error("Jira draft update failed: {error}", { error: message });
      return c.json({ error: message }, 500);
    }
  });
}

/** Re-exported so the route test can drive the depth type without the wire import. */
export type { JiraDepth };
