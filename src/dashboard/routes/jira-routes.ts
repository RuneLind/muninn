/**
 * The Jira composer's HTTP surface — the registrar half of the house split
 * (`jira-sse.ts` owns the stream function, the way `share-sse.ts` /
 * `factcheck-sse.ts` are stream functions registered from `wiki-routes.ts`).
 *
 * The page and five endpoints — registered from ONE module the way
 * `plans-routes.ts` registers `/plans` beside `/api/plans/*`, because the page
 * and the endpoints it drives are one feature and one file to keep in step:
 *
 *   · `GET  /jira`                 — the read-only ARCHIVE (`views/jira-page.ts`):
 *     the saved drafts, `?all=1` for every attempt, `?draft=<id>` for one
 *     read-only render. Server-rendered; the DB read and the bundle build both
 *     fall back to a page that names the failure rather than a Hono 500.
 *   · `GET  /api/jira/archive`     — the same listing as JSON.
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
 *   · `GET  /api/jira/drafts?thread=` — the chat card's binding listing:
 *     `{messageId, draftId, status}` per draft on one thread, no content.
 *   · `POST /api/jira/draft/:id/save` — the card's «Lagre», stamping `saved_at`.
 *
 * `GET /api/jira/draft/:id` and `start` carry `Access-Control-Allow-Origin: *`
 * with an `app.options` preflight, matching `POST /api/research/chat`, which the
 * extension already calls. The consequence is stated in the migration and
 * accepted: any page the browser visits could read a draft id it can guess,
 * bounded by `DASHBOARD_HOST` defaulting to loopback.
 *
 * **The four newer endpoints deliberately carry NONE of that** — `from-thread`,
 * the thread listing, `save` and the archive listing. Two of them WRITE (a
 * conversation, a row), and the two listings hand over every draft id on a
 * thread — or in the whole table — at once, which is a strictly bigger lever
 * than guessing one. The two POSTs additionally require `application/json` and
 * 415 anything else: Hono parses any body whatever the header says, and a
 * `text/plain` POST is a CORS *simple* request that executes regardless of what
 * the response headers say.
 *
 * **`POST /api/jira/draft`, `/draft/start` and `PUT /api/jira/draft/:id` have no
 * UI driver as of the archive PR** — the composer's Regenerate and Lagre utkast
 * were the last ones. They are left standing here deliberately: the campaign's
 * next PRs refuse and then delete them, and the extension's `/draft/start` is
 * the one entry point nothing in this repo can see.
 *
 * Deliberately **not** added to `openapi-spec.ts`: neither `POST /api/wiki/share`
 * nor `POST /api/research/ask` is there, so documenting these would be new scope,
 * not a convention being followed.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { getMcpStatus, findCriticalDown, type McpServerStatus } from "../../ai/mcp-status.ts";
import { jiraBotMissingMessage, resolveJiraBotLive } from "../../jira/bot.ts";
import { findJiraTemplate, resolveJiraTemplates } from "../../jira/templates.ts";
import { JIRA_FULL_MCP_SERVERS } from "../../jira/tool-fence.ts";
import { checkJiraMarkdown } from "../../jira/markdown-check.ts";
import { applyExclusions } from "../../jira/retrieval.ts";
import { verifyJiraKeys } from "../../jira/verify-keys.ts";
import { isValidUuid } from "./route-utils.ts";
import { renderJiraFallback, renderJiraPage } from "../views/jira-page.ts";
import { parseArchiveAll } from "../views/components/jira-archive-pure.ts";
import {
  JIRA_DEPTHS,
  JIRA_EXTRA_MAX,
  JIRA_MARKDOWN_MAX,
  clampJiraArchiveLimit,
  isJiraDepth,
  parseJiraDraftBody,
  type JiraDepth,
  type ParsedJiraDraftBody,
} from "../../jira/wire.ts";
import {
  createJiraDraft,
  getJiraDraft,
  listJiraDrafts,
  listJiraDraftsForThread,
  saveJiraDraft,
  updateJiraDraftMarkdown,
} from "../../db/jira-drafts.ts";
import { getThreadById } from "../../db/threads.ts";
import {
  acquireJiraFlight,
  jiraFlightKey,
  runJiraDraftDetached,
  streamJiraSSE,
  threadFlightKey,
  JIRA_THREAD_FLIGHT_MESSAGE,
  type JiraSseOptions,
} from "./jira-sse.ts";
import {
  readThreadHistory,
  runJiraThreadDraft,
  type JiraThreadTurnRunner,
} from "./jira-thread-run.ts";
import { threadSeedLine } from "../../jira/thread-draft.ts";
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
/** Test seam for the THREAD turn — the same reason the one-shot has one: a chat
 *  turn is a real model call, and both from-thread paths are otherwise
 *  unreachable in a test. */
let threadTurnOverride: JiraThreadTurnRunner | undefined;
export function __setJiraThreadTurnForTest(fn: JiraThreadTurnRunner | undefined): void {
  threadTurnOverride = fn;
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

/** The same rule for a thread id: shape-checked before postgres sees it. */
function unknownThread(c: Context): Response {
  return c.json({ error: "ukjent samtale" }, 404);
}

/**
 * Is this a JSON POST?
 *
 * Only the from-thread route enforces it, and only because that route WRITES
 * into a conversation — see the comment at its handler. A `charset` parameter is
 * fine; anything else is not parsed at all.
 */
function isJsonRequest(c: Context): boolean {
  const ct = c.req.header("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(ct.trim());
}

/**
 * The `Full` pre-flight's 503 body. ONE spelling, because both POST paths refuse
 * the same state and a reader who hit it on the first draft must not read a
 * different sentence when they retry through the regenerate.
 */
function fullDepthUnavailable(down: string[]): { error: string; unreachableServers: string[] } {
  return {
    error:
      `Full teknisk dybde krever kodeverktøyene, og disse er ikke tilgjengelige: ${down.join(", ")}. ` +
      `Start dem fra dashbordet (/serena og yggdrasil), eller velg dybde «Skisse».`,
    unreachableServers: down,
  };
}

/** The validated `POST /api/jira/draft/from-thread` body. */
interface ParsedJiraThreadBody {
  threadId: string;
  template: string;
  depth: JiraDepth;
  extra: string;
}

/**
 * Validate the from-thread body.
 *
 * Kept HERE rather than in `src/jira/wire.ts` alongside `parseJiraDraftBody`,
 * because this shape has no browser consumer: the page's own regenerate goes
 * through the ordinary draft POST, and this endpoint is driven by the chat/reader
 * surface PR 5 builds. The wire module exists to keep the BUNDLED half dependency
 * -free; adding a validator only the server calls would grow it for nothing.
 *
 * Norwegian, and the same field labels the other validator uses — the messages
 * land verbatim in the page's status line.
 */
function parseJiraThreadDraftBody(
  body: Record<string, unknown>,
): { ok: true; body: ParsedJiraThreadBody } | { ok: false; error: string } {
  for (const [field, label] of [
    ["threadId", "Samtale-id-en"],
    ["template", "Malen"],
    ["extra", "Ekstra instruks"],
  ] as const) {
    const v = body[field];
    if (v !== undefined && typeof v !== "string") {
      return { ok: false, error: `${label} må være en tekststreng.` };
    }
  }

  const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId) return { ok: false, error: "Ingen samtale er valgt." };

  const template = typeof body.template === "string" ? body.template.trim() : "";
  if (!template) return { ok: false, error: "Ingen mal er valgt." };

  if (!isJiraDepth(body.depth)) {
    return {
      ok: false,
      error: `Teknisk dybde må være en av: ${JIRA_DEPTHS.map((d) => d.id).join(", ")}.`,
    };
  }

  const extra = typeof body.extra === "string" ? body.extra : "";
  if (extra.length > JIRA_EXTRA_MAX) {
    return { ok: false, error: `Ekstra instruks er ${extra.length} tegn — grensen er ${JIRA_EXTRA_MAX}.` };
  }

  return { ok: true, body: { threadId, template, depth: body.depth, extra } };
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

  const bot = resolveJiraBotLive();
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
      return { ok: false, response: c.json(fullDepthUnavailable(down), 503) };
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

  // THREAD-SOURCED: a regenerate is another turn in the same thread, not a
  // re-run of the one-shot over stored hits. Everything below (stored citations,
  // the retrieval verdict, the retrieval question) belongs to the notes path;
  // this row's hit set is re-derived from the conversation on every run, because
  // the conversation keeps retrieving between turns.
  if (stored.source === "thread" && stored.threadId) {
    // Deliberately NO `notes` here: `runJiraDraft` diverts on `threadRun` before
    // it reads them, and the flight key for this path is the thread
    // (`threadFlightKey`), not the content hash. Carrying them read as if the
    // one-shot could still run over them.
    //
    // **`existingDraftId` is NOT optional, though**, even though the RUNNER never
    // reads it on this path: `POST /api/jira/draft/start` — which is how the page
    // regenerates — creates a row when it is absent. Dropped, it minted a SECOND,
    // `notes`-sourced row with empty notes and handed the caller ITS id, while
    // the turn ran against `threadRun.draftId`; the page then polled a row
    // nothing would ever finish, to the 13-minute cap.
    return {
      opts: {
        ...base,
        existingDraftId: stored.draftId,
        threadRun: {
          config,
          botConfig: bot,
          draftId: stored.draftId,
          threadId: stored.threadId,
          threadName: stored.threadName ?? stored.threadId,
          instruction,
          template: body.template,
          depth: body.depth,
          extra: body.extra,
          excludeDocIds: body.excludeDocIds,
          storedCitations: stored.citations,
          storedExcludeDocIds: stored.excludeDocIds,
          regenerate: true,
          ...(threadTurnOverride ? { runTurn: threadTurnOverride } : {}),
        },
      },
    };
  }

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

  // Keyed on the RESOLVED notes plus the draft id — see `jiraFlightKey`. A
  // THREAD-sourced regenerate is keyed on the thread alone instead, sharing the
  // slot with `POST …/from-thread`: both write a turn into one conversation, and
  // two of those interleave whatever else about them differs.
  const key = opts.threadRun
    ? threadFlightKey(opts.threadRun.threadId)
    : jiraFlightKey({
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
        {
          state: "running",
          expiresAtMs: acquired.expiresAtMs,
          // A THREAD-sourced draft shares its slot with `POST …/from-thread`, so
          // it must share that route's sentence too: what is in flight is a turn
          // in a conversation, not a draft over this reader's raw material.
          error: opts.threadRun ? JIRA_THREAD_FLIGHT_MESSAGE : conflictMessage,
        },
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
      const draftId = (c.req.query("draft") ?? "").trim();
      if (draftId) {
        // The `unknownDraft` rule, in HTML: a non-uuid reaches postgres as a cast
        // error, not an empty result — and a stale link in someone's notes must
        // land on a page that says so, never on a 500.
        const draft = isValidUuid(draftId) ? await getJiraDraft(draftId) : null;
        if (!draft) {
          return c.html(await renderJiraPage({ kind: "missing", draftId }), 404);
        }
        return c.html(await renderJiraPage({ kind: "draft", draft }));
      }

      const savedOnly = !parseArchiveAll(c.req.query("all"));
      const limit = clampJiraArchiveLimit(c.req.query("limit"));
      const drafts = await listJiraDrafts({ savedOnly, limit });
      return c.html(await renderJiraPage({ kind: "list", drafts, savedOnly, limit }));
    } catch (err) {
      // Two throwing surfaces now — the DB read and the client-bundle build —
      // and an unexplained Hono 500 is the least useful thing either could
      // produce on a page whose whole job is to be readable.
      log.error("Jira page render failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html(renderJiraFallback(err instanceof Error ? err.message : String(err)), 200);
    }
  });

  // ── The archive listing ────────────────────────────────────────────────────
  // Corpus-wide, newest first, saved-only unless `?all=1` — the JSON behind the
  // page above, and the same rows.
  //
  // **Deliberately NO CORS headers**, like the thread listing beside it: a
  // corpus-wide listing hands over every draft id this install holds at once,
  // which is a strictly bigger lever than the migration-070 accepted risk of
  // GUESSING one. It carries no markdown either — a title, the verdict pair and
  // the binding — so the wide read stays `GET /api/jira/draft/:id`.
  app.get("/api/jira/archive", async (c) => {
    try {
      const savedOnly = !parseArchiveAll(c.req.query("all"));
      const limit = clampJiraArchiveLimit(c.req.query("limit"));
      const drafts = await listJiraDrafts({ savedOnly, limit });
      // `no-store` for the same reason the thread listing is: a draft saved
      // seconds ago must appear, and a heuristically cached listing would hide
      // it for reasons the reader cannot see.
      c.header("Cache-Control", "no-store");
      return c.json({ savedOnly, limit, drafts });
    } catch (err) {
      return serverError(c, "archive listing", err);
    }
  });

  // ── The picker's source ────────────────────────────────────────────────────
  app.get("/api/jira/templates", (c) => {
    const bot = resolveJiraBotLive();
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

  // ── The draft as a turn in the thread ──────────────────────────────────────
  // Fire-and-forget like `/draft/start`, and for a stronger reason: this run
  // spends a full chat turn on a thread whose history can be large. The page
  // polls `GET /api/jira/draft/:id` exactly as it does for a notes draft.
  //
  // Deliberately NO CORS headers: unlike `/draft/start` this endpoint WRITES into
  // a conversation — it appends two messages to a real thread. The extension's
  // accepted-risk note covers reading a draft id, not posting into someone's chat.
  app.post("/api/jira/draft/from-thread", async (c) => {
    try {
      // **`application/json` is REQUIRED.** Hono's `c.req.json()` parses any body
      // whatever the header says, and `text/plain` is a CORS *simple* request —
      // no preflight at all. Measured: a cross-origin `text/plain` POST landed
      // two messages in a thread; the missing CORS headers only stopped the page
      // reading the RESPONSE, which is not what this endpoint needs protecting.
      // 415 is the honest status, and it costs nothing: the page and the reader
      // surface both send JSON already.
      if (!isJsonRequest(c)) {
        return c.json(
          { error: "Forespørselen må sendes som application/json." },
          415,
        );
      }
      const raw = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const parsed = parseJiraThreadDraftBody(raw);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const { body } = parsed;

      // The id shape is checked BEFORE the DB call, the `unknownDraft` rule: a
      // non-uuid reaches postgres as a cast error, not an empty result.
      if (!isValidUuid(body.threadId)) return unknownThread(c);

      const bot = resolveJiraBotLive();
      if (!bot) return c.json({ error: jiraBotMissingMessage() }, 503);

      const template = findJiraTemplate(resolveJiraTemplates(bot.prompts), body.template);
      if (!template) return c.json({ error: `ukjent mal "${body.template}"` }, 400);

      const thread = await getThreadById(body.threadId);
      if (!thread) return unknownThread(c);
      // The bot is IMPLIED by the thread, and it must be the composer's bot. A
      // draft turn in a jarvis thread would be written by a bot whose collections
      // are the AI/tech shelf — the same wrong-corpus failure `resolveJiraBot`
      // has no fallback for, arrived at from the other direction.
      if (thread.botName.toLowerCase() !== bot.name.toLowerCase()) {
        return c.json(
          {
            error:
              `Samtalen tilhører boten "${thread.botName}", men Jira-komponisten kjører på "${bot.name}". ` +
              `Start samtalen i ${bot.name} for å lage en sak fra den.`,
          },
          400,
        );
      }

      // The `Full` pre-flight, exactly as the notes path runs it — and as the
      // REGENERATE of this very draft runs it. Without it a first from-thread
      // draft at `Full` was written with the code servers down, i.e. a confident
      // task about code nobody opened, and the reader's first regenerate then
      // 503'd on the draft they were already holding.
      let mcpServers: McpServerStatus[] = [];
      try {
        mcpServers = await getMcpStatus(bot);
      } catch (err) {
        log.warn("jira MCP probe failed bot={bot} error={error}", {
          bot: bot.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (body.depth === "full") {
        const down = missingFullServers(mcpServers);
        if (down.length > 0) return c.json(fullDepthUnavailable(down), 503);
      }

      // **Keyed on the THREAD ALONE.** Everything else that identifies a draft —
      // template, depth, extra — was in the key at first, and two concurrent
      // from-thread POSTs at different settings then ran two interleaved
      // `processChatMessage` turns in one conversation (measured: two user lines
      // 17 ms apart, then two replies). A turn is a message in a thread, not a
      // piece of work over stored hits; the regenerate path keys the same way.
      const acquired = acquireJiraFlight(threadFlightKey(body.threadId), body.depth);
      if (!acquired.ok) {
        return c.json(
          {
            state: "running",
            expiresAtMs: acquired.expiresAtMs,
            error: JIRA_THREAD_FLIGHT_MESSAGE,
          },
          409,
        );
      }

      try {
        // `notes` is NOT NULL and is what the page's «fra samtale» banner reads.
        // `retrieval_question` gets the same string: on this path nothing was
        // condensed into a search — the conversation IS the question.
        const seedLine = threadSeedLine(thread.name);
        const draftId = await createJiraDraft({
          botName: bot.name,
          template: body.template,
          depth: body.depth,
          notes: seedLine,
          extra: body.extra,
          source: "thread",
          threadId: body.threadId,
        });

        void runJiraThreadDraft(
          {
            config,
            botConfig: bot,
            draftId,
            threadId: body.threadId,
            threadName: thread.name,
            instruction: template.content,
            template: body.template,
            depth: body.depth,
            extra: body.extra,
            excludeDocIds: [],
            ...(threadTurnOverride ? { runTurn: threadTurnOverride } : {}),
          },
        )
          .catch((err) => {
            // `runJiraThreadDraft` reports its own failures onto the row, so this
            // is unreachable — but an unhandled rejection from a detached promise
            // takes the process with it.
            log.error("Detached Jira thread draft threw draft={draft}: {error}", {
              draft: draftId,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(acquired.release);

        log.info("Jira thread draft started: bot={bot} draft={draft} thread={thread} depth={depth}", {
          bot: bot.name, draft: draftId, thread: body.threadId, depth: body.depth,
        });
        return c.json({ draftId, status: "generating" satisfies "generating" });
      } catch (err) {
        acquired.release();
        throw err;
      }
    } catch (err) {
      return serverError(c, "draft/from-thread", err);
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

  // ── The chat card's binding listing ────────────────────────────────────────
  // Every draft on one thread, so the card's poller is keyed on the DRAFT rather
  // than on "this tab is the one that clicked". A from-thread turn runs 60–600 s
  // and broadcasts to every open tab, so reload, second tab and switch-away-and-
  // back are all ordinary — and none of them can be served by remembering a
  // click.
  //
  // **Deliberately NO CORS headers**, unlike the single `GET /api/jira/draft/:id`
  // beside it. Migration 070 accepts that a page the browser visits could read a
  // draft id it can GUESS; a thread-keyed listing hands over every id on the
  // thread at once, which is a different thing entirely. It carries no draft
  // content either — three fields, the binding — so the wide read stays the
  // per-card one the client makes once.
  app.get("/api/jira/drafts", async (c) => {
    try {
      const threadId = (c.req.query("thread") ?? "").trim();
      if (!threadId) return c.json({ error: "Mangler samtale-id." }, 400);
      // The `unknownDraft` rule, one column over: a non-uuid reaches postgres as
      // a cast error, not an empty result.
      if (!isValidUuid(threadId)) return unknownThread(c);
      const drafts = await listJiraDraftsForThread(threadId);
      // A poll target must never be cached — the whole point is that a row's
      // `message_id` fills in and its `generating` becomes `ready`.
      c.header("Cache-Control", "no-store");
      return c.json({ drafts });
    } catch (err) {
      return serverError(c, "draft listing", err);
    }
  });

  // ── «Lagre» ────────────────────────────────────────────────────────────────
  // Stamps `saved_at` so the card's «Lagret» survives a reload.
  //
  // Two refusals, and both are the from-thread route's rather than the GET's:
  // no CORS headers, and `application/json` REQUIRED (415 otherwise). This is a
  // WRITE, and a body-less or `text/plain` POST is a CORS *simple* request — it
  // executes whatever the response headers say, so the missing CORS headers
  // would only have stopped the attacker reading the answer. The card sends `{}`.
  app.post("/api/jira/draft/:id/save", async (c) => {
    try {
      if (!isJsonRequest(c)) {
        return c.json({ error: "Forespørselen må sendes som application/json." }, 415);
      }
      const id = c.req.param("id");
      if (!isValidUuid(id)) return unknownDraft(c);
      const saved = await saveJiraDraft(id);
      if (!saved) {
        // The write is gated on `status = 'ready'`, so "nothing kept" is two
        // different answers: the draft does not exist (404, as everywhere on
        // this router), or it exists and is not FINISHED — a row still being
        // written, or one that failed and has no text to keep. That is a
        // conflict with the row's state, not a missing row, and the card renders
        // the served sentence as it stands.
        const existing = await getJiraDraft(id);
        if (existing) {
          return c.json({ error: "Utkastet er ikke ferdig ennå — bare et ferdig utkast kan lagres." }, 409);
        }
        return unknownDraft(c);
      }
      // The whole view, so the card adopts exactly what the row now holds rather
      // than drawing a state the server might not have reached — the `PUT` rule.
      c.header("Cache-Control", "no-store");
      return c.json(saved);
    } catch (err) {
      return serverError(c, "draft save", err);
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
      // **The reader's text is stored VERBATIM.** The `[n]` repair is a safety net
      // over MODEL output and runs only in the SSE runner; running it here edited
      // what a human had typed, which is a bug however careful the pass is. It was
      // also bounded differently on this path — by the STORED hit set (up to 24)
      // where generation bounds by `citationsUsed` (6–8 on this corpus) — so
      // saving silently deleted every `[9]`–`[23]` the reader had been reading.
      // Measured on real drafts, it also ate `artikkel [13] i forordning
      // 883/2004`, `liste[2]` and the `[1]` of `[1](https://x.no)`.
      // The response still returns the markdown, so the page adopts exactly what
      // the row now holds.
      const markdown = raw.markdown;

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
      // The RAW MATERIAL is whatever the generation used, or the amber/red axis
      // moves under an edit that never touched a key. On a thread-sourced draft
      // that is the conversation's own user messages — `existing.notes` is the
      // `fra samtale: <name>` placeholder, and verifying against it called every
      // key the person had typed in chat a fabrication the moment they saved.
      const notes =
        existing.source === "thread" && existing.threadId
          ? (await readThreadHistory(existing.threadId)).userText
          : existing.notes;

      const markdownFlags = checkJiraMarkdown(markdown);
      const keyVerdicts = await verifyJiraKeys({
        markdown,
        citations: retained,
        notes,
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
