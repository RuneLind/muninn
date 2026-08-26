/**
 * The Jira composer's HTTP surface.
 *
 * **A Jira task is written as a TURN IN A CHAT THREAD.** The notes path — a
 * pasted block of raw material condensed into one retrieval question, drafted by
 * a fenced one-shot over stored hits, then regenerated behind an exclusion
 * column — is gone, and with it its SSE runner, its retrieval half and its three
 * write routes (`POST /api/jira/draft`, `POST …/draft/start`, `PUT …/draft/:id`).
 * A task is discussed in the melosys web chat first, which retrieves over the
 * same three collections, and condensing that conversation back into notes threw
 * away both the retrieval and every adjustment the person made.
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
 *   · `POST /api/jira/draft/from-thread` — the ONE write: run a draft turn in a
 *     thread. Fire-and-forget; the chat's card polls the row.
 *   · `GET  /api/jira/draft/:id`   — status + the whole draft. **Every reader
 *     POLLS this** — the card, the archive page's `?draft=` landing, a sweep.
 *   · `GET  /api/jira/drafts?thread=` — the chat card's binding listing:
 *     `{messageId, draftId, status}` per draft on one thread, no content.
 *   · `POST /api/jira/draft/:id/save` — the card's «Lagre», stamping `saved_at`.
 *
 * `GET /api/jira/draft/:id` carries an `Access-Control-Allow-Origin` header with
 * an `app.options` preflight, matching `POST /api/research/chat` — `*` with
 * `MUNINN_AUTH` off, and the allowlisted request origin (or nothing) in an
 * authenticating mode, per `src/auth/cors.ts`. The consequence is
 * stated in migration 070 and accepted: any page the browser visits could read a
 * draft id it can guess, bounded by `DASHBOARD_HOST` defaulting to loopback.
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
 * Deliberately **not** added to `openapi-spec.ts`: neither `POST /api/wiki/share`
 * nor `POST /api/research/ask` is there, so documenting these would be new scope,
 * not a convention being followed.
 */

import type { Hono } from "hono";
import type { Context } from "hono";
import type { Config } from "../../config.ts";
import { corsHeaders } from "../../auth/cors.ts";
import { getMcpStatus, findCriticalDown, type McpServerStatus } from "../../ai/mcp-status.ts";
import { jiraBotMissingMessage, resolveJiraBotLive } from "../../jira/bot.ts";
import { findJiraTemplate, resolveJiraTemplates } from "../../jira/templates.ts";
import { JIRA_FULL_MCP_SERVERS } from "../../jira/tool-fence.ts";
import { isValidUuid } from "./route-utils.ts";
import { renderJiraFallback, renderJiraPage } from "../views/jira-page.ts";
import { parseArchiveAll } from "../views/components/jira-archive-pure.ts";
import {
  JIRA_DEPTHS,
  JIRA_EXTRA_MAX,
  JIRA_ARCHIVE_LIMIT_DEFAULT,
  clampJiraArchiveLimit,
  isJiraDepth,
  type JiraDepth,
} from "../../jira/wire.ts";
import {
  createJiraDraft,
  getJiraDraft,
  listJiraDrafts,
  listJiraDraftsForThread,
  saveJiraDraft,
} from "../../db/jira-drafts.ts";
import { getThreadById } from "../../db/threads.ts";
import {
  acquireJiraFlight,
  threadFlightKey,
  JIRA_THREAD_FLIGHT_MESSAGE,
} from "./jira-flight.ts";
import { runJiraThreadDraft, type JiraThreadTurnRunner } from "./jira-thread-run.ts";
import { threadSeedLine } from "../../jira/thread-draft.ts";
import { getLog } from "../../logging.ts";
import { requireOwnedResource, decideResourceAccess } from "../../auth/resource-guard.ts";
import { sessionIdentity, sessionRole } from "../../auth/guard.ts";
import { pinnedLocalUserId } from "../../auth/policy.ts";

const log = getLog("dashboard", "jira-routes");

/** Test seam for the THREAD turn — the `__setShareOneShotForTest` precedent,
 *  which exists specifically so a route's happy path is reachable without
 *  spending a real model call. */
let threadTurnOverride: JiraThreadTurnRunner | undefined;
export function __setJiraThreadTurnForTest(fn: JiraThreadTurnRunner | undefined): void {
  threadTurnOverride = fn;
}

/**
 * CORS, advertised for the ONE method that actually carries it.
 *
 * A shared `GET, POST, PUT` header block advertised cross-origin mutations that
 * emit no CORS headers at all — so the preflight invited a write the actual
 * request would then fail, and, worse, invited it in the first place: the
 * accepted-risk note in migration 070 covers a page READING a draft id it can
 * guess, not a page WRITING one. Reading a finished draft is the whole of it.
 */
const CORS_GET_METHODS = {
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

/** `Access-Control-Allow-Origin` is a per-request answer now, so only the
 *  method/header half is a constant: `*` with `MUNINN_AUTH` off, the request's
 *  own origin when it is on `MUNINN_ALLOWED_ORIGINS`, and no header at all
 *  otherwise. See `src/auth/cors.ts` for why the disposition is mode-gated
 *  rather than dropped outright. */
const corsGet = (c: Context) => corsHeaders(c, CORS_GET_METHODS);

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
 * Checked BEFORE any DB call, on every handler that takes an id. `id` is a `UUID`
 * column, so a non-uuid reaches postgres as a CAST ERROR rather than an empty
 * result — which used to surface as a 500 carrying postgres's own message, and on
 * a POST path as a THROW past the single-flight release, wedging that key for the
 * full slot lifetime with nothing running. Handlers that "handled" it by
 * regex-matching the pg message were doing the same check three layers too late.
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
 * Both POSTs enforce it, because both WRITE — one into a conversation, one onto
 * a row — and a `text/plain` POST is a CORS *simple* request that executes
 * whatever the response headers say. A `charset` parameter is fine; anything else
 * is not parsed at all.
 */
function isJsonRequest(c: Context): boolean {
  const ct = c.req.header("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(ct.trim());
}

/**
 * The `Full` pre-flight's 503 body. Its own function because the sentence names
 * the two servers and the remedy, and it is the one refusal a reader is expected
 * to act on rather than report.
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
 * Kept HERE rather than in `src/jira/wire.ts`, because this shape has no browser
 * consumer worth a shared module: the chat's picker is its only caller. The wire
 * module exists to keep the BUNDLED half dependency-free; adding a validator only
 * the server calls would grow it for nothing.
 *
 * Norwegian, and the same field labels the rest of the surface uses — the
 * messages land verbatim in the picker's refusal line.
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

export function registerJiraRoutes(app: Hono, config: Config): void {
  // ── The page ───────────────────────────────────────────────────────────────
  // Registered from the API's own module, the way `plans-routes.ts` registers
  // `/plans` beside `/api/plans/*` — the page and the endpoints it drives are one
  // feature and one file to keep in step.
  app.get("/jira", async (c) => {
    // The list state, read once and carried by every link the page renders — the
    // toggle, each row and the draft page's back link — so a hand-typed
    // `?limit=200` survives one click. `limitParam` is null when the reader named
    // none: echoing the default into the url would pin a value they never chose.
    // A value that does not PARSE is not a limit the reader named either:
    // `clampJiraArchiveLimit("abc")` answers with the default, and adopting that
    // wrote `limit=50` into every link on the page — the pinning this null
    // exists to prevent. The listing still reads at the default; only the echo
    // is dropped.
    const all = parseArchiveAll(c.req.query("all"));
    const limitQuery = (c.req.query("limit") ?? "").trim();
    const limitParam =
      limitQuery && Number.isFinite(Number(limitQuery))
        ? clampJiraArchiveLimit(limitQuery)
        : null;
    const list = { all, limit: limitParam };
    try {
      const draftId = (c.req.query("draft") ?? "").trim();
      if (draftId) {
        // The `unknownDraft` rule, in HTML: a non-uuid reaches postgres as a cast
        // error, not an empty result — and a stale link in someone's notes must
        // land on a page that says so, never on a 500.
        const draft = isValidUuid(draftId) ? await getJiraDraft(draftId) : null;
        if (!draft) {
          return c.html(await renderJiraPage({ kind: "missing", draftId, list }), 404);
        }
        return c.html(await renderJiraPage({ kind: "draft", draft, list }));
      }

      const savedOnly = !all;
      const limit = limitParam ?? JIRA_ARCHIVE_LIMIT_DEFAULT;
      const { drafts, capped } = await listJiraDrafts({ savedOnly, limit });
      return c.html(
        await renderJiraPage({ kind: "list", drafts, savedOnly, limit, limitParam, capped }),
      );
    } catch (err) {
      // Two throwing surfaces — the DB read and the client-bundle build — and an
      // unexplained Hono 500 is the least useful thing either could produce on a
      // page whose whole job is to be readable. **The STATUS is still 500**: the
      // page reads the database now, so the commonest reason this renders is one
      // that is down, and answering 200 tells every caller (a monitor included)
      // that the archive is fine. The HTML renders either way.
      log.error("Jira page render failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html(renderJiraFallback(err instanceof Error ? err.message : String(err)), 500);
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
  //
  // **Who reads it:** nothing in this repo — the page renders its rows
  // server-side and issues no fetch. It exists for the scripted/external reader
  // (a `curl` over the archive, a one-off sweep) and for symmetry with the page,
  // the way `GET /api/jira/draft/:id` serves the card and the sweep alike.
  app.get("/api/jira/archive", async (c) => {
    try {
      const savedOnly = !parseArchiveAll(c.req.query("all"));
      const limit = clampJiraArchiveLimit(c.req.query("limit"));
      const { drafts, capped } = await listJiraDrafts({ savedOnly, limit });
      // `no-store` for the same reason the thread listing is: a draft saved
      // seconds ago must appear, and a heuristically cached listing would hide
      // it for reasons the reader cannot see.
      c.header("Cache-Control", "no-store");
      // `capped` is a row the read found PAST the limit, not `drafts.length ===
      // limit` — an exact fit is not a truncated page.
      return c.json({ savedOnly, limit, capped, drafts });
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

  // ── The draft as a turn in the thread ──────────────────────────────────────
  // The ONE write, and it is fire-and-forget: the run spends a full chat turn on
  // a thread whose history can be large, so the POST hands back the id and
  // leaves. Every reader — the chat card, the archive's `?draft=` landing —
  // polls `GET /api/jira/draft/:id`, and the row is the only record.
  //
  // Deliberately NO CORS headers: this endpoint WRITES into a conversation — it
  // appends two messages to a real thread. Migration 070's accepted-risk note
  // covers reading a draft id, not posting into someone's chat.
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
      // §4: structurally the same case as `POST /chat/conversations/:id/messages`
      // — it runs a turn in a thread and writes into it — and until PR D its
      // only identity check was that the thread's BOT matched the Jira bot;
      // `thread.userId` was never read. BEFORE the MCP probe and the flight
      // lock, so a refused caller spends neither.
      const owned = await requireOwnedResource(c, "thread", body.threadId);
      if (!owned.ok) return unknownThread(c);
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

      // The `Full` pre-flight. Every 🧾 click — first draft and re-run alike —
      // arrives here, so this is the ONE place it can be checked: without it a
      // `Full` draft was written with the code servers down, i.e. a confident
      // task about code nobody opened.
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
      // piece of work over stored hits — and since a re-run is another POST to
      // this same route, this key covers first drafts and re-runs alike.
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
  //
  // The preflight runs the SAME `isValidUuid` gate the GET does, and falls
  // through when it fails. Unguarded, `:id` matched every sibling path segment —
  // so `OPTIONS /api/jira/draft/start` answered a cheerful 204 advertising a
  // live cross-origin endpoint at an address PR 4 deleted. A preflight is a
  // promise about a request that follows; there is nothing here to promise
  // about a parameter that cannot be a draft id.
  app.options("/api/jira/draft/:id", (c, next) => {
    if (!isValidUuid(c.req.param("id"))) return next();
    return new Response(null, { status: 204, headers: corsGet(c) });
  });

  app.get("/api/jira/draft/:id", async (c) => {
    for (const [k, v] of Object.entries(corsGet(c)) as [string, string][]) c.header(k, v);
    try {
      const id = c.req.param("id");
      if (!isValidUuid(id)) return unknownDraft(c);
      const draft = await getJiraDraft(id);
      // The `jiraDraft` kind resolves `jira_drafts.thread_id → threads.user_id`,
      // which `getJiraDraft` has already joined — so the verdict is taken from
      // the row in hand rather than re-read. A `source = 'notes'` row (nothing
      // writes one any more) has no thread and so no owner: readable on a
      // `local` instance, admin-only otherwise.
      if (!draft || !ownsJiraDraft(c, draft)) return unknownDraft(c);
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
      // A thread-keyed listing hands over every draft id on the thread at once,
      // so it is guarded on the THREAD rather than per row.
      const owned = await requireOwnedResource(c, "thread", threadId);
      if (!owned.ok) return unknownThread(c);
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
      // BEFORE the write. `saveJiraDraft` stamps `saved_at`, so a guard placed
      // after it would answer 404 having already mutated someone else's row.
      const existingForOwner = await getJiraDraft(id);
      if (!existingForOwner || !ownsJiraDraft(c, existingForOwner)) return unknownDraft(c);
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
      // than drawing a state the server might not have reached.
      c.header("Cache-Control", "no-store");
      return c.json(saved);
    } catch (err) {
      return serverError(c, "draft save", err);
    }
  });
}

/** Re-exported so the route test can drive the depth type without the wire import. */
export type { JiraDepth };

/**
 * The `jiraDraft` owner verdict, over a row the caller already read.
 *
 * `requireOwnedResource(c, "jiraDraft", id)` would re-run the same query for an
 * answer that is in hand — `getJiraDraft` joins `threads.user_id` onto every row
 * for the archive's «Juster i samtalen» deep link — so the shared DECISION is
 * used and the lookup is not repeated.
 */
function ownsJiraDraft(c: Context, draft: { threadUserId: string | null }): boolean {
  return decideResourceAccess({
    sessionUserId: sessionIdentity(c)?.userId ?? null,
    role: sessionRole(c),
    owner: { found: true, userId: draft.threadUserId },
    nullOwnerAllowed: pinnedLocalUserId() !== null,
  }).ok;
}
