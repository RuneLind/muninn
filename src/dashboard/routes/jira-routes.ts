/**
 * The Jira composer's HTTP surface — the registrar half of the house split
 * (`jira-sse.ts` owns the stream function, the way `share-sse.ts` /
 * `factcheck-sse.ts` are stream functions registered from `wiki-routes.ts`).
 *
 * The page and five endpoints — registered from ONE module the way
 * `plans-routes.ts` registers `/plans` beside `/api/plans/*`, because the page
 * and the endpoints it drives are one feature and one file to keep in step:
 *
 *   · `GET  /jira`                 — the composer page (`views/jira-page.ts`): a
 *     three-column shell the client bundle mounts into. Its one throwing surface
 *     is the bundle build, which falls back to a page that names the failure
 *     rather than an unexplained Hono 500.
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
import { stripCitationMarkers } from "../../jira/citation-markers.ts";
import { applyExclusions } from "../../jira/retrieval.ts";
import { verifyJiraKeys } from "../../jira/verify-keys.ts";
import { isValidUuid } from "./route-utils.ts";
import { renderJiraFallback, renderJiraPage } from "../views/jira-page.ts";
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

/**
 * CORS, advertised per route and ONLY for the method that actually carries it.
 *
 * One shared `GET, POST, PUT` header block advertised a cross-origin PUT that
 * emits no CORS headers at all — so the preflight invited a mutation the actual
 * request would then fail, and, worse, invited it in the first place: the
 * accepted-risk note in migration 070 covers a page READING a draft id it can
 * guess, not a page REWRITING one. The extension needs exactly two things: POST
 * the fire-and-forget start, and GET the result.
 */
const CORS_GET = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

const CORS_START = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

/**
 * What a 500 says to the caller.
 *
 * Never the exception's own text: an unexpected throw here is a postgres error
 * carrying a table name, a column type and a character offset, and one of these
 * routes is reachable cross-origin. The detail goes to the log.
 */
const GENERIC_500 = "Noe gikk galt på serveren. Se muninn-loggen for detaljer.";

function serverError(c: Context, where: string, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  log.error("Jira {where} failed: {error}", { where, error: message });
  return c.json({ error: GENERIC_500 }, 500);
}

/**
 * A draft id that cannot be a row.
 *
 * Checked BEFORE any DB call in all four handlers. `id` is a `UUID` column, so a
 * non-uuid reaches postgres as a CAST ERROR rather than an empty result — which
 * used to surface as a 500 carrying postgres's own message, and (on the two POST
 * paths) as a THROW past the single-flight release, wedging that key for the full
 * slot lifetime with nothing running. Two of the four handlers "handled" it by
 * regex-matching the pg message, which is the same check three layers too late.
 */
function unknownDraft(c: Context): Response {
  return c.json({ error: "ukjent utkast" }, 404);
}

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
): Promise<{ opts: JiraSseOptions; unknown?: true }> {
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
    ...(oneShotOverride ? { oneShot: oneShotOverride } : {}),
    ...(retrieveOverride ? { retrieve: retrieveOverride } : {}),
    ...(questionOverride ? { buildQuestion: questionOverride } : {}),
  };

  if (!body.draftId) return { opts: base };

  // Regenerate: load the stored hit set. The notes come from the ROW, always —
  // the page does not echo a 10 KB Slack thread back on every toggle click, and
  // `parseJiraDraftBody` refuses a regenerate that tries to supply new ones (the
  // stored hit set was retrieved for the originals).
  const stored = await getJiraDraft(body.draftId);
  // `unknownDraft` spells this 404, here as everywhere else. The id is NOT echoed:
  // `/draft/start` and the GET are CORS-open, so a page the browser visits can
  // drive them, and a second spelling that reflects the caller's own string back
  // is both a needless echo and a second sentence to keep in step with the first.
  if (!stored) return { opts: base, unknown: true };
  return {
    opts: {
      ...base,
      notes: stored.notes,
      storedCitations: stored.citations,
      storedExcludeDocIds: stored.excludeDocIds,
      existingDraftId: stored.draftId,
      storedRetrievalQuestion: stored.retrievalQuestion,
      // The RETRIEVAL verdict, never the view's derived `coverage` — that one is a
      // function of the last run's exclusion set, and feeding it back in is what
      // latched a draft to `no_hits` after one exclude-everything regenerate.
      ...(stored.retrievalCoverage ? { storedCoverage: stored.retrievalCoverage } : {}),
    },
  };
}

type Claimed =
  | { ok: true; opts: JiraSseOptions; release: () => void }
  | { ok: false; response: Response };

/**
 * Resolve the stored draft, then claim the single-flight slot — ONE sequence,
 * used by both POST paths.
 *
 * The two handlers had a copy each, and the copies were where three defects
 * lived: the key was computed from the REQUEST BODY's notes (empty on every
 * regenerate, so unrelated drafts collided in one slot), the id was handed
 * straight to postgres (a non-uuid threw a cast error out past the release,
 * wedging that key), and the release ordering existed twice.
 *
 * The order below is the fix, and it is deliberate: validate the id shape → read
 * the row → THEN key the slot on what actually resolved. It costs one DB read
 * before a 409 is detectable, which is the same read the run itself needs and is
 * bounded by a primary-key lookup.
 */
async function claimDraft(
  c: Context,
  config: Config,
  resolved: Extract<Resolved, { ok: true }>,
  conflictMessage: string,
): Promise<Claimed> {
  const { bot, body, instruction, mcpServers } = resolved;

  if (body.draftId && !isValidUuid(body.draftId)) {
    return { ok: false, response: unknownDraft(c) };
  }

  const { opts, unknown } = await buildSseOptions(config, bot, body, instruction, mcpServers);
  if (unknown) return { ok: false, response: unknownDraft(c) };

  // Keyed on the RESOLVED notes plus the draft id — see `jiraFlightKey`.
  const key = jiraFlightKey({
    notes: opts.notes,
    template: body.template,
    depth: body.depth,
    extra: body.extra,
    excludeDocIds: body.excludeDocIds,
    draftId: body.draftId,
  });
  const acquired = acquireJiraFlight(key, body.depth);
  if (!acquired.ok) {
    return {
      ok: false,
      response: c.json(
        { state: "running", expiresAtMs: acquired.expiresAtMs, error: conflictMessage },
        409,
      ),
    };
  }

  return { ok: true, opts: { ...opts, onSettled: acquired.release }, release: acquired.release };
}

export function registerJiraRoutes(app: Hono, config: Config): void {
  // ── The page ───────────────────────────────────────────────────────────────
  // Registered from the API's own module, the way `plans-routes.ts` registers
  // `/plans` beside `/api/plans/*` — the page and the endpoints it drives are one
  // feature and one file to keep in step.
  app.get("/jira", async (c) => {
    try {
      return c.html(await renderJiraPage());
    } catch (err) {
      // The one throwing surface is the RENDER, and a client-bundle build
      // failure is exactly the state where an unexplained Hono 500 is the least
      // useful thing this page could do — it has no server-rendered content to
      // fall back to.
      log.error("Jira page render failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html(renderJiraFallback(err instanceof Error ? err.message : String(err)), 200);
    }
  });

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
      const { bot, body } = resolved;

      // Claimed only once every pre-commit refusal is behind us, so a bad
      // template id cannot reserve a note for three minutes.
      const claim = await claimDraft(
        c, config, resolved,
        "Det skrives allerede et utkast for dette råmaterialet — vent til det er ferdig.",
      );
      if (!claim.ok) return claim.response;

      log.info("Jira draft: bot={bot} template={template} depth={depth} notes={notes} regen={regen}", {
        bot: bot.name,
        template: body.template,
        depth: body.depth,
        notes: claim.opts.notes.length,
        regen: !!body.draftId,
      });

      // The slot is handed to the stream via `onSettled` — but only once
      // `streamJiraSSE` has RETURNED a Response. A synchronous throw before that
      // would leave the callback unwired and wedge the note for the full expiry
      // with nothing running; releasing here is safe precisely because it is
      // unreachable once the stream owns the slot (release is identity-checked
      // anyway). The share/claim-retry handover, verbatim.
      try {
        return streamJiraSSE(c, claim.opts);
      } catch (err) {
        claim.release();
        throw err;
      }
    } catch (err) {
      return serverError(c, "draft route", err);
    }
  });

  // ── The extension's fire-and-forget start ──────────────────────────────────
  app.options("/api/jira/draft/start", (c) => new Response(null, { status: 204, headers: CORS_START }));

  app.post("/api/jira/draft/start", async (c) => {
    for (const [k, v] of Object.entries(CORS_START)) c.header(k, v);
    try {
      const resolved = await resolveDraftRequest(c);
      if (!resolved.ok) return resolved.response;
      const { bot, body } = resolved;

      const claim = await claimDraft(c, config, resolved, "Et likt utkast skrives allerede.");
      if (!claim.ok) return claim.response;

      // Everything from here to the detached hand-off runs under a claimed slot,
      // so every throw releases it: `createJiraDraft` can fail (a dead pool, a
      // migration not yet applied) and the key would otherwise stay held for its
      // full lifetime with nothing running behind it.
      try {
        // The row is created HERE, not inside the runner, so the id can be
        // returned before any expensive work starts — the popup gets it and closes.
        const draftId =
          claim.opts.existingDraftId ??
          (await createJiraDraft({
            botName: bot.name,
            template: body.template,
            depth: body.depth,
            notes: claim.opts.notes,
            extra: body.extra,
          }));

        // Detached on purpose: the caller is a popup that is about to die. Errors
        // land on the row (the runner owns that), so a rejection here would be
        // both impossible and unactionable — but it is caught anyway, because an
        // unhandled rejection from a detached promise takes the process with it.
        void runJiraDraftDetached({ ...claim.opts, existingDraftId: draftId }, bot).catch((err) => {
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
        claim.release();
        throw err;
      }
    } catch (err) {
      return serverError(c, "draft/start", err);
    }
  });

  // ── Read one draft (the page's poll, and PR 3's `?draft=<id>` landing) ─────
  app.options("/api/jira/draft/:id", (c) => new Response(null, { status: 204, headers: CORS_GET }));

  app.get("/api/jira/draft/:id", async (c) => {
    for (const [k, v] of Object.entries(CORS_GET)) c.header(k, v);
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return unknownDraft(c);
      const draft = await getJiraDraft(id);
      if (!draft) return unknownDraft(c);
      // A poll target must never be cached — the whole point is that `generating`
      // becomes `ready`.
      c.header("Cache-Control", "no-store");
      return c.json(draft);
    } catch (err) {
      return serverError(c, "draft read", err);
    }
  });

  // ── The reader's edit ──────────────────────────────────────────────────────
  app.put("/api/jira/draft/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return unknownDraft(c);
      const raw = await c.req.json<{ markdown?: unknown }>().catch(() => ({}) as { markdown?: unknown });
      // Norwegian, like the wire validator's: these land in the page's own
      // status line under a form whose fields are all Norwegian.
      if (typeof raw.markdown !== "string") return c.json({ error: "Utkastet må være en tekststreng." }, 400);
      if (!raw.markdown.trim()) return c.json({ error: "Utkastet er tomt." }, 400);
      if (raw.markdown.length > JIRA_MARKDOWN_MAX) {
        return c.json(
          { error: `Utkastet er ${raw.markdown.length} tegn — grensen er ${JIRA_MARKDOWN_MAX}.` },
          400,
        );
      }

      const existing = await getJiraDraft(id);
      if (!existing) return unknownDraft(c);

      const retained = applyExclusions(existing.citations, existing.excludeDocIds);
      // The SAME `[n]` repair the runner applies, over the edited text: an edit
      // that reintroduces a marker (a paste from an older draft, a hand-typed
      // `[2]`) would otherwise store a footnote number the unnumbered
      // `## Referanser` cannot resolve. Bounded by the RETAINED count — the
      // widest a marker could legitimately have referred to — so a literal
      // `[2024]` survives. The repaired text is what is stored AND what the
      // response returns, or the page would report "saved" over text that
      // differs from the row it just wrote.
      const markdown = stripCitationMarkers(raw.markdown, retained.length);

      // BOTH post-passes are re-run against the edited text and stored with it.
      // Leaving the old verdicts behind would leave the page asserting things
      // about text that no longer exists — a red row for a key the reader just
      // deleted, or no flag for the `- [ ]` they just typed.
      //
      // Verified against the RETAINED set, not the stored one: the stored
      // citations are deliberately the wide 24, and verifying against those made
      // a key the reader had toggled OFF read `verified` again the moment they
      // saved — the grounding claim silently reinstated by an edit that never
      // touched it. `checkJiraMarkdown` is sync and is simply called.
      const markdownFlags = checkJiraMarkdown(markdown);
      const keyVerdicts = await verifyJiraKeys({
        markdown,
        citations: retained,
        notes: existing.notes,
        knowledgeApiUrl: config.knowledgeApiUrl,
      });

      const written = await updateJiraDraftMarkdown(id, markdown, keyVerdicts, markdownFlags);
      if (!written) return unknownDraft(c);
      return c.json({ draftId: id, markdown, keyVerdicts, markdownFlags });
    } catch (err) {
      return serverError(c, "draft update", err);
    }
  });
}

/** Re-exported so the route test can drive the depth type without the wire import. */
export type { JiraDepth };
