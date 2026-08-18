/**
 * `/plans` — the read-only board over mimir's `plans/`, priced from the
 * claude-usage ledger, plus the JSON the page is rendered from.
 *
 * `GET /plans` embeds the payload inline and `GET /api/plans/board` serves the
 * SAME object, so a client can refresh without a reload and an operator can
 * diff what the page shows against what the assembly produced. Both go through
 * {@link assemblePlanBoard}; there is no second assembly path.
 *
 * **Neither route may 5xx.** Every degraded input on either side — mimir not
 * registered on this host, an unreachable or failed-rebuild ledger, a corpus
 * full of unparseable files — is a board STATE, rendered with a banner naming
 * the base URL it tried. A 500 here would take out the board for a plan file
 * with a broken frontmatter fence.
 *
 * The base URL idiom is `claude-usage-routes.ts`'s, on purpose: `config` reports
 * only whether the operator set `CLAUDE_USAGE_URL` (null ⇒ unset), and the
 * default is applied at this layer, where `urlConfigured` is derived from that
 * one fact.
 *
 * The two GETs never write. The two POSTs (PR 4) do, and both go through the
 * shared wiki write machinery rather than around it:
 *
 *   - `POST /api/plans/priority` edits one plan's frontmatter through
 *     `writeWikiPage` — readonly refusal, path confinement, per-wiki queue and
 *     `baseHash` CAS, in NO-LOG mode (a triage sitting is a burst of clicks, and
 *     a priority flip is metadata: no `log.md` line, no reindex).
 *   - `POST /api/plans/order` writes `plans/queue.yaml` through `writePlanQueue`
 *     (`src/plans/write.ts`), which `writeWikiPage` cannot carry — its path
 *     confinement admits `.md`/`.mdx` only.
 *
 * **Neither passes a `commit`.** mimir is in the repo-sync loop in `wiki` mode;
 * the sync loop is the committer, behind its 5-minute quiet period.
 *
 * **Both return the NEW sha256 in the 200 body, taken from the string that was
 * written** — never from a re-read after the write section released, which would
 * hand back a concurrent writer's bytes and arm the next edit to overwrite them.
 * Without it the second edit on one card 409s: the board captured its CAS once,
 * at render.
 */

import type { Context, Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { CLAUDE_USAGE_DEFAULT_URL } from "../claude-usage-overview.ts";
import { buildBoardPayload, type BoardPayload } from "../../plans/board.ts";
import {
  defaultPlanLedgerDeps,
  fetchPlanLedger,
  type PlanLedgerDeps,
  type PlanLedgerResult,
} from "../../plans/ledger.ts";
import {
  loadPlanSource,
  PLANS_WIKI_NAME,
  PLAN_PRIORITIES,
  type PlanPriority,
  type PlanSourceResult,
} from "../../plans/source.ts";
import { setPlanPriority } from "../../plans/frontmatter.ts";
import { writePlanQueue } from "../../plans/write.ts";
import { QUEUE_COLUMNS, serializeQueue, type QueueColumn, type QueueOrder } from "../../plans/queue.ts";
import { writeWikiPage } from "../../wiki/page-write.ts";
import { isWikiReadonly, WIKI_READONLY_REASON } from "../../wiki/readonly.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { sha256 } from "../../gardener/util.ts";
import { renderPlansPage } from "../views/plans-page.ts";

const log = getLog("dashboard", "plans");

/** Injectable seam: the tests drive the whole route without a mimir checkout
 *  and without a live claude-usage. `renderPage` is a seam too, so the "a page
 *  render that throws is still a 200" contract can be driven without breaking
 *  the bundler. */
export interface PlanBoardDeps {
  ledger: PlanLedgerDeps;
  loadSource: () => Promise<PlanSourceResult>;
  renderPage?: (payload: BoardPayload) => Promise<string>;
}

export function defaultPlanBoardDeps(config: Config): PlanBoardDeps {
  return {
    ledger: defaultPlanLedgerDeps(
      config.claudeUsageUrl ?? CLAUDE_USAGE_DEFAULT_URL,
      config.claudeUsageUrl != null,
    ),
    loadSource: () => loadPlanSource(),
  };
}

/** Warn-once per distinct source failure. `/plans` is polled by every open tab,
 *  and a mimir checkout that has gone missing writes the same line forever —
 *  the ledger card's `warnedX` idiom, for the same reason. Cleared wholesale
 *  past a sane size (same 100 as `warnedClaudeUsageErrors`) so a message
 *  carrying a varying detail — a path, an errno, a file name — cannot leak. */
const warnedSourceErrors = new Set<string>();

function warnSourceOnce(message: string): void {
  if (warnedSourceErrors.has(message)) {
    log.info("plan board: reading mimir's plans failed: {error}", { error: message });
    return;
  }
  if (warnedSourceErrors.size > 100) warnedSourceErrors.clear();
  warnedSourceErrors.add(message);
  log.error("plan board: reading mimir's plans failed: {error}", { error: message });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An empty corpus carrying the reason it is empty — the shape an unexpected
 *  filesystem failure degrades to, so the page still renders its columns. */
function failedSource(err: unknown): PlanSourceResult {
  return {
    root: null,
    plans: [],
    queue: { order: {}, hash: null },
    warnings: [`reading mimir's plans failed: ${err instanceof Error ? err.message : String(err)}`],
  };
}

/** The ledger side's own degrade, for the one case `fetchPlanLedger` cannot
 *  report itself: it threw. Same shape a refused payload produces. */
function failedLedger(deps: PlanBoardDeps, now: number, err: unknown): PlanLedgerResult {
  return {
    fetchedAt: now,
    baseUrl: deps.ledger.baseUrl,
    urlConfigured: deps.ledger.urlConfigured,
    ledgerConfigured: null,
    reachable: false,
    generatedAt: null,
    refreshedAt: null,
    plans: [],
    errors: [`reading the claude-usage ledger failed: ${errText(err)}`],
  };
}

/**
 * Read both sides in parallel and join them. The two reads are independent —
 * a dead ledger must not delay the wiki read, and neither may take the board
 * down — so they are genuinely SETTLED: `fetchPlanLedger` is written not to
 * reject, but "the comment says settled" is not the same as settled, and a
 * rejection on that arm would take out a board whose wiki read was fine.
 */
export async function assemblePlanBoard(
  deps: PlanBoardDeps,
  now: number = Date.now(),
): Promise<BoardPayload> {
  const [source, ledger] = await Promise.allSettled([
    deps.loadSource(),
    fetchPlanLedger(deps.ledger, now) as Promise<PlanLedgerResult>,
  ]);

  let sourceResult: PlanSourceResult;
  if (source.status === "fulfilled") {
    sourceResult = source.value;
  } else {
    warnSourceOnce(errText(source.reason));
    sourceResult = failedSource(source.reason);
  }

  let ledgerResult: PlanLedgerResult;
  if (ledger.status === "fulfilled") {
    ledgerResult = ledger.value;
  } else {
    log.error("plan board: the ledger read threw: {error}", { error: errText(ledger.reason) });
    ledgerResult = failedLedger(deps, now, ledger.reason);
  }

  return buildBoardPayload({ source: sourceResult, ledger: ledgerResult, now });
}

/**
 * The last resort: the whole assembly threw before it could produce a payload
 * (a dep that fails on access, a bug in the join). Neither route may 5xx, so
 * this is the state they degrade to — a board with no cards that SAYS why, in
 * the `warnings` the page already renders as a banner.
 */
function failedPayload(deps: PlanBoardDeps, now: number, err: unknown): BoardPayload {
  return buildBoardPayload({
    source: failedSource(err),
    ledger: failedLedger(deps, now, err),
    now,
  });
}

export function registerPlansRoutes(
  app: Hono,
  config: Config,
  deps: PlanBoardDeps = defaultPlanBoardDeps(config),
): void {
  const render = deps.renderPage ?? renderPlansPage;

  app.get("/plans", async (c) => {
    // TWO throwing surfaces, and the handler owns both: the assembly (which is
    // defensive per-input but can still fail whole) and the RENDER — a bundle
    // build failure is exactly the state where an unexplained Hono 500 is the
    // least useful thing the page could do.
    let payload: BoardPayload;
    try {
      payload = await assemblePlanBoard(deps);
    } catch (err) {
      log.error("plan board: assembling /plans failed: {error}", { error: errText(err) });
      payload = failedPayload(deps, Date.now(), err);
    }
    try {
      return c.html(await render(payload));
    } catch (err) {
      log.error("plan board: rendering /plans failed: {error}", { error: errText(err) });
      return c.html(renderPlansFallback(errText(err)), 200);
    }
  });

  app.get("/api/plans/board", async (c) => {
    try {
      return c.json(await assemblePlanBoard(deps));
    } catch (err) {
      log.error("plan board: assembling the board payload failed: {error}", { error: errText(err) });
      const payload = failedPayload(deps, Date.now(), err);
      return c.json({ ...payload, errors: payload.warnings });
    }
  });

  // ---- writes -------------------------------------------------------------

  app.post("/api/plans/priority", async (c) => {
    const refusal = readonlyRefusal(c);
    if (refusal) return refusal;
    try {
      const body = await c.req.json<{ slug?: unknown; priority?: unknown; baseHash?: unknown }>()
        .catch(() => ({}) as Record<string, unknown>);

      const slug = typeof body.slug === "string" ? body.slug.trim() : "";
      if (!slug) return c.json({ error: "slug is required" }, 400);
      // The enum runs BEFORE the transform, and an omitted or null `priority` is
      // a 400 rather than a clear: clearing has exactly one wire form, `"clear"`.
      // An absent field is what a buggy client sends, and an accidental clear
      // turns a fail-closed guard into silent data loss.
      const wanted = body.priority;
      if (!isPriorityInput(wanted)) {
        return c.json(
          { error: `priority must be one of ${PLAN_PRIORITIES.join(", ")} or "clear"` },
          400,
        );
      }
      const priority: PlanPriority | null = wanted === "clear" ? null : wanted;
      const baseHash = typeof body.baseHash === "string" ? body.baseHash.trim() : "";
      if (!baseHash) return c.json({ error: "baseHash is required" }, 400);

      const source = await deps.loadSource();
      const root = source.root;
      if (!root) return c.json({ error: unregisteredMessage() }, 404);
      const plan = source.plans.find((p) => p.slug === slug);
      if (!plan) return c.json({ error: `no plan named "${slug}"` }, 404);

      // The transform's own return value is what gets hashed — stashed here
      // rather than re-read afterwards (see the module doc).
      let written: string | null = null;
      const result = await writeWikiPage({
        wikiDir: root,
        relPath: plan.relPath,
        baseHash,
        staleReason: `${plan.relPath} changed since the board was loaded`,
        // No-log mode skips the reindex fan-out anyway; `[]` says the same thing
        // where the call is read.
        collections: [],
        logKind: null,
        now: () => Date.now(),
        transform: (raw) => {
          written = setPlanPriority(raw, priority);
          return written;
        },
        readFile: async (absPath) => {
          try {
            return await Bun.file(absPath).text();
          } catch {
            return null;
          }
        },
        writeFile: async (absPath, content) => {
          await Bun.write(absPath, content);
        },
        refreshIndex: async () => {
          await getWikiIndex({ root, refresh: true });
        },
        reindex: async () => {},
      });

      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      if (result.outcome === "error") {
        log.error("plan priority: write failed for {slug}: {error}", { slug, error: result.reason });
        return c.json({ error: result.reason }, 500);
      }
      // A `noop` — the same value already set, a clear on a plan carrying none,
      // or a fence this must not edit — echoes the UNCHANGED hash, which the CAS
      // just proved is what is on disk. Without it the card's next edit 409s.
      const hash = result.outcome === "written" && written !== null ? sha256(written) : baseHash;
      return c.json({
        slug,
        priority,
        hash,
        written: result.outcome === "written",
        relPath: plan.relPath,
      });
    } catch (err) {
      log.error("plan priority: unexpected failure: {error}", { error: errText(err) });
      return c.json({ error: "internal error" }, 500);
    }
  });

  app.post("/api/plans/order", async (c) => {
    const refusal = readonlyRefusal(c);
    if (refusal) return refusal;
    try {
      const body = await c.req.json<{ order?: unknown; baseHash?: unknown }>()
        .catch(() => ({}) as Record<string, unknown>);

      // `""` is a legal base (the file is absent) — so the check is on the TYPE,
      // never on truthiness, or the bootstrap write could never be made.
      if (typeof body.baseHash !== "string") {
        return c.json({ error: "baseHash is required (\"\" when queue.yaml does not exist yet)" }, 400);
      }
      const baseHash = body.baseHash;
      const parsed = parseOrderBody(body.order);
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);

      const source = await deps.loadSource();
      const root = source.root;
      if (!root) return c.json({ error: unregisteredMessage() }, 404);

      // The client only ever sends slugs it rendered, so an unknown one is a
      // stale client — refused rather than written as a rank for nothing.
      const known = new Set(source.plans.map((p) => p.slug));
      for (const slugs of Object.values(parsed.order)) {
        for (const slug of slugs ?? []) {
          if (!known.has(slug)) return c.json({ error: `no plan named "${slug}"` }, 400);
        }
      }

      let content: string;
      try {
        content = serializeQueue(parsed.order);
      } catch (err) {
        // `serializeQueue` throws on a slug outside the grammar mimir's own
        // parser shares — bytes that would take its every column down.
        return c.json({ error: errText(err) }, 400);
      }

      const result = await writePlanQueue({ wikiDir: root, baseHash, content });
      if (result.outcome === "forbidden") {
        return c.json({ error: result.reason, readonly: true }, 403);
      }
      if (result.outcome === "stale") {
        return c.json({ error: result.reason, stale: true }, 409);
      }
      if (result.outcome === "error") {
        log.error("plan order: write failed: {error}", { error: result.reason });
        return c.json({ error: result.reason }, 500);
      }
      return c.json({
        order: parsed.order,
        hash: result.hash,
        written: result.outcome !== "noop",
        deleted: result.outcome === "deleted",
      });
    } catch (err) {
      log.error("plan order: unexpected failure: {error}", { error: errText(err) });
      return c.json({ error: "internal error" }, 500);
    }
  });
}

/**
 * The wiki-readonly refusal, as the FIRST statement of both write routes
 * (`wiki-gardener-routes.ts`'s pattern). The write seams refuse on their own, so
 * this is not the only line of defence — it exists so the refusal costs no
 * filesystem read, and so it leaves a trace: a seam that is never reached warns
 * about nothing, and "why did the mini do nothing?" was otherwise unanswerable.
 */
function readonlyRefusal(c: Context) {
  if (!isWikiReadonly()) return null;
  log.info("Wiki-readonly instance refused {method} {path}", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });
  return c.json({ error: WIKI_READONLY_REASON, readonly: true }, 403);
}

function unregisteredMessage(): string {
  return `wiki "${PLANS_WIKI_NAME}" is not registered on this host — set WIKI_EXTRA=${PLANS_WIKI_NAME}=<path>`;
}

/** `"clear"` is the ONE wire form for clearing — see the route's comment. */
function isPriorityInput(v: unknown): v is PlanPriority | "clear" {
  return typeof v === "string" && (v === "clear" || (PLAN_PRIORITIES as readonly string[]).includes(v));
}

/**
 * Validate the posted `order` into the shape `serializeQueue` takes. Every
 * rejection is a 400: the ranking is machine-generated by the board, so an
 * off-shape body is a bug in a client, not a state to accommodate.
 *
 * A slug placed in two columns (or twice in one) is refused rather than written:
 * `parseQueueYaml` DROPS the later copy on the way back in, so those bytes would
 * read back as a different ordering than the one that was saved.
 */
function parseOrderBody(raw: unknown): { order: QueueOrder } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "order must be an object of column → slugs" };
  }
  const order: QueueOrder = {};
  const placed = new Set<string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(QUEUE_COLUMNS as readonly string[]).includes(key)) {
      return { error: `unknown column "${key}" — expected one of ${QUEUE_COLUMNS.join(", ")}` };
    }
    if (!Array.isArray(value)) return { error: `column "${key}" must be an array of slugs` };
    const slugs: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !entry.trim()) {
        return { error: `column "${key}" has a non-slug entry` };
      }
      const slug = entry.trim();
      if (placed.has(slug)) return { error: `"${slug}" is ranked more than once` };
      placed.add(slug);
      slugs.push(slug);
    }
    // Rule 2 of the grammar: an emptied column leaves no key behind.
    if (slugs.length > 0) order[key as QueueColumn] = slugs;
  }
  return { order };
}

/** The page the page degrades to: no styling, no bundle, one sentence naming
 *  the failure and the endpoint that still works. */
function renderPlansFallback(message: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Muninn - Plans</title></head>
<body>
  <h1>Plan board</h1>
  <p>The board could not be rendered: <code>${esc(message)}</code></p>
  <p>The payload itself is still served by <code>GET /api/plans/board</code>.</p>
</body></html>`;
}
