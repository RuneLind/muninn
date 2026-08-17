/**
 * The money side of the `/plans` board — a read-only, server-side proxy of
 * claude-usage's `GET /api/plans`.
 *
 * Copied in shape from `src/dashboard/claude-usage-overview.ts`, and for the same
 * three reasons:
 *
 *   1. **The BROWSER never reaches port 8787.** The dashboard is viewed over the
 *      tailnet, where a client-side loopback fetch hits the viewer's own machine
 *      and a cross-host one is mixed content under `tailscale serve` HTTPS. So
 *      the fetch is server-side and the result NAMES the base URL it tried,
 *      because a degraded board has no honest URL to link to.
 *   2. **Bounded in time AND in bytes**, reusing the overview's own constants and
 *      bounded-read loop rather than a second copy of them. Measured 2026-08-17
 *      against the live service: **641 KB in ~0.45 s cold** for the whole corpus,
 *      well inside the 8 MB / 10 s envelope the overview established.
 *   3. **Never throws.** An unreachable / non-200 / timed-out / oversized /
 *      malformed service is a board state (`reachable: false` + `errors[]`), never
 *      a 5xx — and a persistently-down service warns once per distinct error and
 *      then drops to info, because the board is polled by every open tab.
 *
 * There is deliberately **no window parameter**: the bare `/api/plans` returns the
 * full corpus, and a board that priced only the last N days would silently change
 * its estimates as plans aged out of the window.
 */

import { getLog } from "../logging.ts";
import {
  readBounded,
  CLAUDE_USAGE_DEFAULT_URL,
  CLAUDE_USAGE_TIMEOUT_MS,
  CLAUDE_USAGE_MAX_BYTES,
} from "../dashboard/claude-usage-overview.ts";

const log = getLog("plans", "ledger");

export { CLAUDE_USAGE_DEFAULT_URL };

// ---- Raw claude-usage contract (only the fields the board consumes) --------
//
// The live payload carries ~35 fields per plan and ~18 per PR. Typing the whole
// thing would make every upstream addition a muninn compile error for no gain,
// so only what is READ is declared; the rest rides through untyped.

export interface LedgerPr {
  /** Repo the PR landed in. NOT clean — the live corpus carries
   *  `/Users/rune/source/private/claude-usage;` (trailing semicolon), bare
   *  `/Users/rune/source/private`, `/private/tmp` and short `RuneLind/muninn`
   *  forms. `estimate.ts` normalizes before bucketing. */
  repo?: string | null;
  prNumber?: number | null;
  subject?: string | null;
  mergedAt?: string | null;
  state?: string | null;
  url?: string | null;
  reviewed?: boolean | null;
}

export interface LedgerPlan {
  /** Plan filename stem — the join key against the mimir side. */
  slug: string;
  title?: string | null;
  planStatus?: string | null;
  relPath?: string | null;
  mtimeIso?: string | null;
  /** The PR numbers the plan DECLARES. `[]` when it declares none — in which
   *  case `total` is null and the estimate must assume a count. */
  slate?: number[] | null;
  /** Declared PR count. Null exactly when the plan declares no slate. */
  total?: number | null;
  costUSD?: number | null;
  totalTokens?: number | null;
  merges?: number | null;
  /** PRs the ledger knows LANDED — the divisor for $/PR. */
  landed?: number | null;
  findings?: number | null;
  prs?: LedgerPr[] | null;
}

export interface PlanLedgerPayload {
  generatedAt?: string | null;
  plans?: unknown;
}

export interface PlanLedgerResult {
  /** Muninn's fetch instant (epoch ms) — not claude-usage's `generatedAt`. */
  fetchedAt: number;
  /** The base URL actually tried, so a degraded board can name its endpoint. */
  baseUrl: string;
  /** True when `CLAUDE_USAGE_URL` was set explicitly (vs falling back to the
   *  default). Drives visibility the same way the Pipeline ledger card's does. */
  configured: boolean;
  reachable: boolean;
  /** claude-usage's own build instant, verbatim. */
  generatedAt: string | null;
  plans: LedgerPlan[];
  errors?: string[];
}

/** Injectable seam so tests drive the join without a live claude-usage. */
export interface PlanLedgerDeps {
  /** Must reject on timeout / non-200 / over-cap / malformed JSON. */
  fetchPlans: () => Promise<PlanLedgerPayload>;
  configured: boolean;
  baseUrl: string;
}

/**
 * Production deps hitting the live claude-usage. The bounds are parameters so
 * both are testable against a real socket, exactly as the overview's are.
 */
export function defaultPlanLedgerDeps(
  baseUrl: string,
  configured: boolean,
  timeoutMs: number = CLAUDE_USAGE_TIMEOUT_MS,
  maxBytes: number = CLAUDE_USAGE_MAX_BYTES,
): PlanLedgerDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    configured,
    baseUrl: root,
    fetchPlans: async () => {
      const url = `${root}/api/plans`;
      // Every failure names the URL — the operator's first question about a
      // degraded board is whether it was pointed at the right host at all.
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${url})`);
      }
      if (!res.ok) throw new Error(`claude-usage returned HTTP ${res.status} for ${url}`);
      let text: string;
      try {
        text = await readBounded(res, maxBytes, url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(msg.includes(url) ? msg : `${msg} (${url})`);
      }
      try {
        return JSON.parse(text) as PlanLedgerPayload;
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${url})`);
      }
    },
  };
}

/** Rows must carry a string slug — that is the whole join key, and a row without
 *  one can only attach money to the wrong card. */
function isLedgerPlan(v: unknown): v is LedgerPlan {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { slug?: unknown }).slug === "string" &&
    (v as { slug: string }).slug.trim() !== ""
  );
}

/** Errors already warned about, keyed by message — same reason as the overview's:
 *  a configured-but-down service is polled by every open tab, so the first
 *  sighting warns and repeats drop to info. */
const warnedLedgerErrors = new Set<string>();

/**
 * Fetch and shape the ledger. Pure over its injected `fetchPlans`; never throws.
 */
export async function fetchPlanLedger(
  deps: PlanLedgerDeps,
  now: number = Date.now(),
): Promise<PlanLedgerResult> {
  const errors: string[] = [];
  let payload: PlanLedgerPayload | null = null;
  try {
    const res = await deps.fetchPlans();
    // A JSON body that is not an object is a wrong service on the port, not an
    // empty ledger.
    if (res && typeof res === "object" && !Array.isArray(res)) payload = res;
    else errors.push("claude-usage plans: response was not a JSON object");
  } catch (err) {
    errors.push(`claude-usage plans: ${err instanceof Error ? err.message : String(err)}`);
  }

  let plans: LedgerPlan[] = [];
  let generatedAt: string | null = null;
  if (payload) {
    generatedAt = typeof payload.generatedAt === "string" ? payload.generatedAt : null;
    if (Array.isArray(payload.plans)) {
      plans = payload.plans.filter(isLedgerPlan);
      const dropped = payload.plans.length - plans.length;
      if (dropped > 0) errors.push(`claude-usage plans: ${dropped} row(s) carried no slug — dropped`);
    } else {
      errors.push("claude-usage plans: payload carried no `plans` array");
      // A payload we cannot read the plans out of is not a reachable ledger —
      // an empty board with no error would read as "no plans exist".
      payload = null;
    }
  }

  if (errors.length > 0) {
    const first = errors[0]!;
    if (warnedLedgerErrors.has(first)) {
      log.info("plan ledger still degraded: {error}", { error: first });
    } else {
      if (warnedLedgerErrors.size > 100) warnedLedgerErrors.clear();
      warnedLedgerErrors.add(first);
      log.warn("plan ledger degraded: {error}", { error: first });
    }
  }

  return {
    fetchedAt: now,
    baseUrl: deps.baseUrl,
    configured: deps.configured,
    reachable: payload != null,
    generatedAt,
    plans,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
