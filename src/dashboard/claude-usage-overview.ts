/**
 * claude-usage ledger overview — the `/models` **Pipeline ledger** card.
 *
 * The Mac mini hosts the claude-usage dashboard (launchd, port 8787), which
 * aggregates pipeline-compliance data across machines. Muninn reads it over ONE
 * seam: `GET {claudeUsageUrl}/api/pipeline?days=N`. It must NEVER re-derive from
 * claude-usage's sqlite file — that is a 145 MB synchronous `bun:sqlite` read on
 * the event loop against a schema muninn does not own.
 *
 * Two rules the shape encodes:
 *   1. **The fetch is bounded.** Measured worst case for the unclamped (90-day)
 *      query is 802 KB / 1.4 s, so the 10 s budget is ~7× the floor the clamp
 *      allows. An unbounded fetch is a hang, not a card.
 *   2. **The BROWSER never talks to :8787.** The dashboard is viewed over the
 *      tailnet; a client-side fetch of a loopback port hits the viewer's own
 *      machine, and over `tailscale serve` HTTPS it is also mixed content. So
 *      the fetch is server-side and the card renders NO external link — the
 *      port is named in prose instead (there is no honest URL to build: the
 *      viewer's host is not this host).
 *
 * Never throws: an unreachable / non-200 / timed-out / malformed claude-usage
 * lands in `errors[]` on a 200 payload with `reachable: false`, exactly like the
 * `indexing-overview.ts` / `models-overview.ts` family.
 */

import { getLog } from "../logging.ts";

const log = getLog("dashboard", "claude-usage");

/** Window default, mirroring claude-usage's own `?days` default. */
export const CLAUDE_USAGE_DEFAULT_DAYS = 14;
/** claude-usage clamps `?days` to this range; muninn clamps identically so a
 *  bad query is answered here rather than silently re-interpreted upstream. */
export const CLAUDE_USAGE_MIN_DAYS = 1;
export const CLAUDE_USAGE_MAX_DAYS = 90;
/** Fetch budget. Sized on the 90-day worst case (802 KB / 1.4 s measured), not
 *  on the 14-day common case — the clamp FLOOR is what the timeout must
 *  tolerate, or the widest legal query becomes a false "unreachable". */
export const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

// ---- Raw claude-usage contract (only the fields the card reads) ------------

/** Compliance counters. Every field optional — this is another service's
 *  payload and a missing counter must degrade to "—", never to a wrong number. */
export interface PipelineCompliance {
  merges?: number;
  landed?: number;
  merged?: number;
  mergeUnconfirmed?: number;
  reviewed?: number;
  unreviewed?: number;
  silentUnreviewed?: number;
  reviewFloorStated?: number;
  reviewFloorSkipped?: number;
  splitCheckStated?: number;
  sessionsPast2ndPR?: number;
  sessionsWithSplitCheck?: number;
  campaignLanded?: number;
  campaignGateStated?: number;
}

export interface PipelinePayload {
  generatedAt?: string | null;
  since?: string | null;
  windowSec?: number | null;
  precisionBarMet?: boolean | null;
  markersVersion?: { events?: number; runs?: number; current?: number } | null;
  compliance?: PipelineCompliance | null;
  campaigns?: unknown[] | null;
  merges?: unknown[] | null;
}

// ---- Display model ---------------------------------------------------------

/** One rendered card row. `tone` drives the value/note color; absent ⇒ quiet. */
export interface ClaudeUsageRow {
  label: string;
  value: string;
  note?: string;
  tone?: "warning" | "success" | "error";
}

export interface ClaudeUsageOverview {
  /** Muninn's assembly instant (epoch ms) — not claude-usage's `generatedAt`. */
  assembledAt: number;
  /** The window actually requested (post-clamp). */
  days: number;
  /** True when `CLAUDE_USAGE_URL` is set explicitly. Drives card visibility
   *  together with `reachable`: an instance that neither configured it nor can
   *  reach it is simply not a claude-usage host and hides the card, rather than
   *  showing every muninn install a permanent error about a service it was
   *  never meant to have. */
  configured: boolean;
  /** True when the ledger fetch produced a usable payload. */
  reachable: boolean;
  /** Rendered rows (empty when unreachable). */
  rows: ClaudeUsageRow[];
  /** claude-usage's own build instant (epoch ms), null when absent/garbage. */
  ledgerGeneratedAt: number | null;
  errors?: string[];
}

/** Injectable seam so tests drive the assembly without a live claude-usage. */
export interface ClaudeUsageDeps {
  /** Must reject on timeout / non-200 / malformed JSON. */
  fetchPipeline: (days: number) => Promise<PipelinePayload>;
  /** Whether `CLAUDE_USAGE_URL` was set explicitly (vs falling back). */
  configured: boolean;
}

/**
 * Production deps hitting the live claude-usage. `timeoutMs` is a parameter so
 * the timeout path itself is testable against a real hanging socket rather than
 * only against a fabricated rejection.
 */
export function defaultClaudeUsageDeps(
  baseUrl: string,
  configured: boolean,
  timeoutMs: number = CLAUDE_USAGE_TIMEOUT_MS,
): ClaudeUsageDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    configured,
    fetchPipeline: async (days: number) => {
      const url = `${root}/api/pipeline?days=${days}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        throw new Error(`claude-usage returned HTTP ${res.status} for /api/pipeline`);
      }
      // A non-JSON body (an HTML error page from something else on the port) must
      // read as a degraded source, not as an empty ledger.
      return (await res.json()) as PipelinePayload;
    },
  };
}

// ---- Pure helpers (exported for unit tests) --------------------------------

/** Clamp a `?days` query to claude-usage's own accepted range. Garbage ⇒ default. */
export function clampDays(raw: string | undefined | null): number {
  if (raw == null || raw.trim() === "") return CLAUDE_USAGE_DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return CLAUDE_USAGE_DEFAULT_DAYS;
  return Math.min(CLAUDE_USAGE_MAX_DAYS, Math.max(CLAUDE_USAGE_MIN_DAYS, n));
}

/** Parse an ISO timestamp to epoch ms, or null on missing/garbage. */
export function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** "just now" / "12m ago" / "3h ago" / "2d ago". Null when the instant is unknown. */
export function formatAge(then: number | null, now: number): string | null {
  if (then == null) return null;
  const mins = Math.floor(Math.max(0, now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** A count that may be absent. Renders "—" rather than "0" for missing data —
 *  "0 unreviewed" and "we don't know" are different operational statements. */
function num(n: number | undefined | null): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
}

/** Array length when it really is an array; null otherwise (absent ≠ empty). */
export function lenOf(v: unknown[] | null | undefined): number | null {
  return Array.isArray(v) ? v.length : null;
}

/**
 * Build the compact card rows from one payload. Deliberately a SUMMARY, not the
 * payload: the live 14-day response is ~170 KB (130 merges + 31 campaigns with
 * per-agent census rows) and the card's job is the headline.
 */
export function buildRows(payload: PipelinePayload, days: number, now: number): ClaudeUsageRow[] {
  const c = payload.compliance ?? {};
  const rows: ClaudeUsageRow[] = [];

  const since = parseTs(payload.since);
  const ledgerAt = parseTs(payload.generatedAt);
  const ledgerAge = formatAge(ledgerAt, now);
  rows.push({
    label: "Window",
    value: `${days}d`,
    note: [
      since ? `since ${new Date(since).toISOString().slice(0, 10)}` : null,
      ledgerAge ? `ledger built ${ledgerAge}` : "ledger build time unknown",
    ].filter(Boolean).join(" · "),
  });

  const merges = lenOf(payload.merges) ?? c.merges ?? null;
  rows.push({
    label: "Merges",
    value: num(merges),
    note: [`${num(c.landed)} landed`, `${num(c.mergeUnconfirmed)} unconfirmed`].join(" · "),
  });

  // The review floor is the number that matters: a SILENT unreviewed merge is
  // the violation the whole ledger exists to catch, so it drives the tone.
  const unreviewed = c.unreviewed;
  rows.push({
    label: "Reviewed",
    value: `${num(c.reviewed)} / ${num(c.merges ?? merges)}`,
    note: `${num(unreviewed)} unreviewed · ${num(c.silentUnreviewed)} silent · floor stated ${num(c.reviewFloorStated)}, skipped ${num(c.reviewFloorSkipped)}`,
    ...(typeof unreviewed === "number" && unreviewed > 0 ? { tone: "warning" as const } : {}),
  });

  rows.push({
    label: "Split checks",
    value: `${num(c.sessionsWithSplitCheck)} / ${num(c.sessionsPast2ndPR)}`,
    note: "sessions that stated one, of sessions past their 2nd PR",
  });

  rows.push({
    label: "Campaigns",
    value: num(lenOf(payload.campaigns)),
    note: `${num(c.campaignLanded)} campaign merges · ${num(c.campaignGateStated)} gate lines stated`,
  });

  // `precisionBarMet` is claude-usage's own self-assessment of whether the
  // parse is precise enough to be believed — a false bar makes every number
  // above provisional, so it is a row rather than a footnote.
  const bar = payload.precisionBarMet;
  rows.push({
    label: "Precision bar",
    value: bar == null ? "—" : bar ? "met" : "NOT met",
    note: bar === false ? "ledger numbers are provisional" : `markers v${num(payload.markersVersion?.current)}`,
    ...(bar === false ? { tone: "error" as const } : bar === true ? { tone: "success" as const } : {}),
  });

  return rows;
}

/**
 * Assemble the overview. Pure over its injected `fetchPipeline` — the route
 * wires the HTTP-backed default, the test wires a fabricated one. Never throws.
 */
export async function assembleClaudeUsageOverview(
  deps: ClaudeUsageDeps,
  days: number = CLAUDE_USAGE_DEFAULT_DAYS,
  now: number = Date.now(),
): Promise<ClaudeUsageOverview> {
  const errors: string[] = [];
  let payload: PipelinePayload | null = null;
  try {
    const res = await deps.fetchPipeline(days);
    // A JSON body that is not an object (null, an array, a bare string) is a
    // wrong service on the port, not an empty ledger — treat it as degraded.
    if (res && typeof res === "object" && !Array.isArray(res)) payload = res;
    else errors.push("claude-usage pipeline: response was not a JSON object");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`claude-usage pipeline: ${message}`);
  }

  if (errors.length > 0) {
    log.warn("claude-usage overview degraded: {error}", { error: errors[0] });
  }

  return {
    assembledAt: now,
    days,
    configured: deps.configured,
    reachable: payload != null,
    rows: payload ? buildRows(payload, days, now) : [],
    ledgerGeneratedAt: payload ? parseTs(payload.generatedAt) : null,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
