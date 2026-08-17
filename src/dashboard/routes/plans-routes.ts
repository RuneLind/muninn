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
 *  and without a live claude-usage. */
export interface PlanBoardDeps {
  ledger: PlanLedgerDeps;
  loadSource: () => Promise<PlanSourceResult>;
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

/**
 * Read both sides in parallel and join them. The two reads are independent —
 * a dead ledger must not delay the wiki read, and neither may take the board
 * down — so they are settled, not awaited in sequence.
 */
export async function assemblePlanBoard(
  deps: PlanBoardDeps,
  now: number = Date.now(),
): Promise<BoardPayload> {
  const [sourceResult, ledgerResult] = await Promise.all([
    deps.loadSource().catch((err): PlanSourceResult => {
      log.error("plan board: reading mimir's plans failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return failedSource(err);
    }),
    fetchPlanLedger(deps.ledger, now) as Promise<PlanLedgerResult>,
  ]);
  return buildBoardPayload({ source: sourceResult, ledger: ledgerResult, now });
}

export function registerPlansRoutes(
  app: Hono,
  config: Config,
  deps: PlanBoardDeps = defaultPlanBoardDeps(config),
): void {
  app.get("/plans", async (c) => {
    return c.html(await renderPlansPage(await assemblePlanBoard(deps)));
  });

  app.get("/api/plans/board", async (c) => {
    return c.json(await assemblePlanBoard(deps));
  });
}
