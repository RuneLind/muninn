/**
 * The money side of the `/plans` board — a read-only, server-side proxy of
 * claude-usage's `GET /api/plans`.
 *
 * Copied in shape from `src/dashboard/claude-usage-overview.ts`, and for the same
 * first three reasons:
 *
 *   1. **The BROWSER never reaches port 8787.** The dashboard is viewed over the
 *      tailnet, where a client-side loopback fetch hits the viewer's own machine
 *      and a cross-host one is mixed content under `tailscale serve` HTTPS. So
 *      the fetch is server-side and the result NAMES the base URL it tried,
 *      because a degraded board has no honest URL to link to.
 *   2. **Bounded in time AND in bytes**, through the shared
 *      `src/utils/bounded-fetch.ts` rather than a second copy of either bound.
 *      Measured 2026-08-17 against the live service on this host: **643 KB in
 *      ~10 ms warm** for the whole corpus (185 plans), well inside the 8 MB /
 *      10 s envelope.
 *   3. **Never throws.** An unreachable / non-200 / timed-out / oversized /
 *      malformed service is a board state (`reachable: false` + `errors[]`), never
 *      a 5xx — and a persistently-down service warns once per distinct error and
 *      then drops to info, because the board is polled by every open tab.
 *   4. **A 200 is not health.** claude-usage answers 200 with an empty `plans`
 *      array in two states worth telling apart from "no plans exist": its rollup
 *      THREW on the last tick (`refreshError`, rows are the previous build's or
 *      none), and the host has no plans directory at all (`configured: false`).
 *      Both land in `errors[]`; neither flips `reachable`, because the service
 *      answered.
 *
 * There is deliberately **no window parameter**: the bare `/api/plans` returns the
 * full corpus, and a board that priced only the last N days would silently change
 * its estimates as plans aged out of the window.
 */

import { getLog } from "../logging.ts";
import {
  readBounded,
  BOUNDED_FETCH_TIMEOUT_MS,
  BOUNDED_FETCH_MAX_BYTES,
} from "../utils/bounded-fetch.ts";

const log = getLog("plans", "ledger");

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
  /** When upstream's warm rollup last finished REBUILDING (null when it never
   *  has). Not the same instant as `generatedAt`, which is when this response
   *  was assembled — the gap between them is the data's age. */
  refreshedAt?: string | null;
  /** Upstream's last rebuild threw, and this is the error. Its rows are then
   *  the previous build's, or none. */
  refreshError?: string | null;
  /** Upstream has a `planDir` configured. A CONFIG fact about claude-usage —
   *  emphatically not muninn's `urlConfigured`, which is about this end. */
  configured?: boolean | null;
  plans?: unknown;
}

export interface PlanLedgerResult {
  /** Muninn's fetch instant (epoch ms) — not claude-usage's `generatedAt`. */
  fetchedAt: number;
  /** The base URL actually tried, so a degraded board can name its endpoint. */
  baseUrl: string;
  /** True when `CLAUDE_USAGE_URL` was set explicitly on THIS host (vs falling
   *  back to the default). Drives visibility the same way the Pipeline ledger
   *  card's does. Named apart from {@link ledgerConfigured} on purpose: the two
   *  are different questions and upstream owns a field of the same name. */
  urlConfigured: boolean;
  /** claude-usage's own `configured` — it has a plans directory. Null when the
   *  payload did not say (an older service, or a body we rejected). */
  ledgerConfigured: boolean | null;
  reachable: boolean;
  /** claude-usage's own build instant, verbatim. Null whenever the payload was
   *  rejected — a build instant read out of a body we refused would date the
   *  board off something it did not accept. */
  generatedAt: string | null;
  /** claude-usage's last successful rollup rebuild, verbatim. The age of the
   *  rows, which `generatedAt` is not. */
  refreshedAt: string | null;
  plans: LedgerPlan[];
  errors?: string[];
}

/** Injectable seam so tests drive the join without a live claude-usage. */
export interface PlanLedgerDeps {
  /** Must reject on timeout / non-200 / over-cap / malformed JSON. */
  fetchPlans: () => Promise<PlanLedgerPayload>;
  /** `CLAUDE_USAGE_URL` is set on this host — see `PlanLedgerResult`. */
  urlConfigured: boolean;
  baseUrl: string;
}

/**
 * Production deps hitting the live claude-usage. The bounds are parameters so
 * both are testable against a real socket, exactly as the overview's are.
 */
export function defaultPlanLedgerDeps(
  baseUrl: string,
  urlConfigured: boolean,
  timeoutMs: number = BOUNDED_FETCH_TIMEOUT_MS,
  maxBytes: number = BOUNDED_FETCH_MAX_BYTES,
): PlanLedgerDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    urlConfigured,
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

/** Errors already warned about — same reason as the overview's: a
 *  configured-but-down service is polled by every open tab, so the first
 *  sighting warns and repeats drop to info. */
const warnedLedgerErrors = new Set<string>();

/** Marker after which a message is upstream's own words plus our timestamp tail
 *  — everything past it is normalized, see {@link ledgerWarnKey}. */
const REBUILD_FAILED = "rebuild failed:";
/** ISO-8601 instants, wherever they appear. A timestamp is never the condition. */
const ISO_INSTANT_RE = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g;

/**
 * The dedup key for one error message.
 *
 * Keying on the raw message defeats warn-once for any message carrying a
 * per-call VARIABLE: "3 row(s) carried no slug" and "4 row(s) carried no slug"
 * are the same condition, and a corpus in flux would warn on every poll. The
 * varying part still reaches the log — as the message, in the detail.
 *
 * Two things vary per tick and neither is a new condition:
 *
 *   - the row count (collapsed to `N row(s)`), and
 *   - anything inside a `rebuild failed:` message. That text is UPSTREAM's, so
 *     it can carry a retry counter, a pid or a duration, and we append
 *     `(rows are from <iso>)` — which moves on every rebuild. Everything after
 *     the marker therefore gets its digits collapsed, which keys the warning on
 *     the stable prefix + the root cause's WORDS. A genuinely different cause
 *     ("ENOENT reading plandir" vs "git pull timed out") still keys apart.
 *
 * Digits are NOT collapsed OUTSIDE the `rebuild failed:` tail: an `HTTP 503`
 * and an `HTTP 404` from the proxy itself key apart. Inside the tail they DO
 * collapse (`HTTP N`), so two upstream causes that differ only by a number
 * share one first warn — accepted, since the tail is free text we do not own.
 */
export function ledgerWarnKey(message: string): string {
  const collapsed = message.replace(/\b\d+ row\(s\)/, "N row(s)").replace(ISO_INSTANT_RE, "<iso>");
  const at = collapsed.indexOf(REBUILD_FAILED);
  if (at < 0) return collapsed;
  const cut = at + REBUILD_FAILED.length;
  return collapsed.slice(0, cut) + collapsed.slice(cut).replace(/\d+/g, "N");
}

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
    // empty ledger — and WHICH port is the operator's first question, so the
    // base URL rides along here exactly as it does on the fetch failures.
    if (res && typeof res === "object" && !Array.isArray(res)) payload = res;
    else errors.push(`claude-usage plans: response was not a JSON object (${deps.baseUrl})`);
  } catch (err) {
    errors.push(`claude-usage plans: ${err instanceof Error ? err.message : String(err)}`);
  }

  let plans: LedgerPlan[] = [];
  let generatedAt: string | null = null;
  let refreshedAt: string | null = null;
  let ledgerConfigured: boolean | null = null;
  if (payload) {
    generatedAt = typeof payload.generatedAt === "string" ? payload.generatedAt : null;
    refreshedAt = typeof payload.refreshedAt === "string" ? payload.refreshedAt : null;
    ledgerConfigured = typeof payload.configured === "boolean" ? payload.configured : null;
    if (Array.isArray(payload.plans)) {
      plans = payload.plans.filter(isLedgerPlan);
      const dropped = payload.plans.length - plans.length;
      if (dropped > 0) errors.push(`claude-usage plans: ${dropped} row(s) carried no slug — dropped`);
    } else {
      errors.push(`claude-usage plans: payload carried no \`plans\` array (${deps.baseUrl})`);
      // A payload we cannot read the plans out of is not a reachable ledger —
      // an empty board with no error would read as "no plans exist". Its dates
      // go with it: they described a body we just refused.
      payload = null;
      generatedAt = null;
      refreshedAt = null;
      ledgerConfigured = null;
    }
  }

  // Upstream's own two ways of answering 200 with nothing useful. Both are
  // sentences the board must be able to say; neither is an unreachable service.
  if (payload) {
    const refreshError =
      typeof payload.refreshError === "string" && payload.refreshError.trim()
        ? payload.refreshError.trim()
        : null;
    if (refreshError) {
      errors.push(
        `claude-usage plans: the ledger's last rebuild failed: ${refreshError}` +
          (refreshedAt ? ` (rows are from ${refreshedAt})` : " (no rows were ever built)"),
      );
    }
    if (ledgerConfigured === false) {
      errors.push(`claude-usage plans: claude-usage has no plans directory (${deps.baseUrl})`);
    }
  }

  if (errors.length > 0) {
    const first = errors[0]!;
    const key = ledgerWarnKey(first);
    if (warnedLedgerErrors.has(key)) {
      log.info("plan ledger still degraded: {error}", { error: first });
    } else {
      if (warnedLedgerErrors.size > 100) warnedLedgerErrors.clear();
      warnedLedgerErrors.add(key);
      log.warn("plan ledger degraded: {error}", { error: first });
    }
  }

  return {
    fetchedAt: now,
    baseUrl: deps.baseUrl,
    urlConfigured: deps.urlConfigured,
    ledgerConfigured,
    reachable: payload != null,
    generatedAt,
    refreshedAt,
    plans,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
