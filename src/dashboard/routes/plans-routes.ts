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
 * PR 2 is READ-ONLY: no POST, no writes. Priorities and hand orders set in the
 * browser live in a `localStorage` draft the page labels as unsaved, and the
 * server's values win on every load.
 */

import type { Hono } from "hono";
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
import { loadPlanSource, type PlanSourceResult } from "../../plans/source.ts";
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
