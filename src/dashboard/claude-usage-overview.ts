/**
 * claude-usage ledger overview — the `/models` **Pipeline ledger** card.
 *
 * The Mac mini hosts the claude-usage dashboard (launchd, port 8787 by default),
 * which aggregates pipeline-compliance data across machines. Muninn reads it over
 * ONE seam: `GET {claudeUsageUrl}/api/pipeline?days=N`. It must NEVER re-derive
 * from claude-usage's sqlite file — that is a 145 MB synchronous `bun:sqlite`
 * read on the event loop against a schema muninn does not own.
 *
 * Three rules the shape encodes:
 *   1. **The fetch is bounded, in time AND in bytes.** The unclamped (90-day)
 *      query measures 640 KB / ~0.2 s (2026-08-13, live service); the 10 s budget
 *      is deliberate slack for a cold ledger on a loaded mini, not a tight fit.
 *      The byte cap is the other half: that 145 MB sqlite arrives over HTTP here,
 *      and a chunked response declares no length at all.
 *   2. **The BROWSER never talks to the ledger port.** The dashboard is viewed
 *      over the tailnet; a client-side fetch of a loopback port hits the viewer's
 *      own machine, and over `tailscale serve` HTTPS it is also mixed content. So
 *      the fetch is server-side and the card renders NO external link — the
 *      effective base URL is echoed in the payload and named in prose instead
 *      (there is no honest URL to build: the viewer's host is not this host).
 *   3. **Every number is the one upstream would report.** The denominators, the
 *      `?days=` clamp and the caveats are mirrored from claude-usage rather than
 *      re-invented — a ledger card that quietly divides by a different total is
 *      worse than no card.
 *
 * Never throws: an unreachable / non-200 / timed-out / oversized / malformed
 * claude-usage lands in `errors[]` on a 200 payload with `reachable: false`,
 * exactly like the `indexing-overview.ts` / `models-overview.ts` family.
 */

import { getLog } from "../logging.ts";
import { formatRelative, parseTs } from "./indexing-overview.ts";

const log = getLog("dashboard", "claude-usage");

/** Where claude-usage listens when `CLAUDE_USAGE_URL` says nothing. The default
 *  lives HERE, not in `config.ts`: the config layer reports only whether the
 *  operator set the variable (see `claudeUsageUrl`, nullable), and this module
 *  owns what "the ledger service" means when they did not. */
export const CLAUDE_USAGE_DEFAULT_URL = "http://127.0.0.1:8787";

/** Window default, mirroring claude-usage's own `?days` default. */
export const CLAUDE_USAGE_DEFAULT_DAYS = 14;
/** claude-usage clamps `?days` to this range; muninn clamps identically so a
 *  bad query is answered here rather than silently re-interpreted upstream. */
const CLAUDE_USAGE_MIN_DAYS = 1;
const CLAUDE_USAGE_MAX_DAYS = 90;
/** Fetch budget, sized on the 90-day clamp FLOOR rather than the 14-day common
 *  case — the widest legal query must not become a false "unreachable". Measured
 *  2026-08-13 against the live service: 640 KB in ~0.2 s for `?days=90`. */
const CLAUDE_USAGE_TIMEOUT_MS = 10_000;
/** Body cap. Two orders of magnitude above the measured 640 KB worst case, and
 *  far below the 145 MB the sqlite behind this endpoint would be — the point is
 *  that a wrong service on the port cannot stream the dashboard out of memory. */
const CLAUDE_USAGE_MAX_BYTES = 8 * 1024 * 1024;

// ---- Raw claude-usage contract (only the fields the card reads) ------------

/** Compliance counters. Every field optional — this is another service's
 *  payload and a missing counter must degrade to "—", never to a wrong number. */
export interface PipelineCompliance {
  /** ALL merges in the window — the one authoritative total. Deliberately not
   *  derived from the payload's `merges` ARRAY, which is a detail list. */
  merges?: number;
  /** Merges the ledger knows LANDED. Upstream's own words: "the DENOMINATOR for
   *  every review number below it" — a composition nobody confirmed cannot be
   *  reviewed-or-not, and counting it understates every review figure. */
  landed?: number;
  mergeUnconfirmed?: number;
  composedUnconfirmed?: number;
  reviewed?: number;
  unreviewed?: number;
  silentUnreviewed?: number;
  reviewFloorStated?: number;
  reviewFloorSkipped?: number;
  sessionsPast2ndPR?: number;
  sessionsWithSplitCheck?: number;
  campaignLanded?: number;
  campaignGateStated?: number;
}

export interface PipelinePayload {
  generatedAt?: string | null;
  since?: string | null;
  precisionBarMet?: boolean | null;
  /** True when the window reaches back past the day the gate phrases were
   *  standardized — i.e. some of these merges are scored against rules that did
   *  not exist when they happened. Live at `?days=90`. */
  preStandardization?: boolean | null;
  /** ...and the local date it is the start of, for the sentence that says it. */
  rulesStandardizedDate?: string | null;
  markersVersion?: { current?: number } | null;
  /** Upstream's own sentence about rows extracted by an older marker version;
   *  null when every sink is current. Rendered verbatim — the panel and the CLI
   *  report must not paraphrase each other. */
  markersVersionCaveat?: string | null;
  /** What an "unconfirmed" merge does and does not mean (confirmations are read
   *  from the local checkout without fetching). Standing, not an anomaly. */
  confirmCaveat?: string | null;
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
  /** A second note line carrying an upstream CAVEAT — always upstream's own
   *  words, on the row whose numbers it qualifies. */
  caveat?: string;
  tone?: "warning" | "success" | "error";
  /** Tone for the caveat line alone. Absent ⇒ quiet: a caveat that explains a
   *  term (`confirmCaveat`) is not a report that something is wrong, and
   *  painting both amber teaches the reader to skip both. */
  caveatTone?: "warning";
}

export interface ClaudeUsageOverview {
  /** Muninn's assembly instant (epoch ms) — not claude-usage's `generatedAt`. */
  assembledAt: number;
  /** The window actually requested (post-clamp). Unread by the card, which
   *  renders the server-built rows — it is the echo that makes the curl-only
   *  `?days=` debug axis checkable against the live service. */
  days: number;
  /** The base URL actually fetched, so the card can NAME its endpoint instead of
   *  hardcoding a port that a re-pointed `CLAUDE_USAGE_URL` makes a lie. */
  baseUrl: string;
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
  errors?: string[];
}

/** Injectable seam so tests drive the assembly without a live claude-usage. */
export interface ClaudeUsageDeps {
  /** Must reject on timeout / non-200 / over-cap / malformed JSON. */
  fetchPipeline: (days: number) => Promise<PipelinePayload>;
  /** Whether `CLAUDE_USAGE_URL` was set explicitly (vs falling back). */
  configured: boolean;
  /** The base URL `fetchPipeline` talks to, for the card's sub-line. */
  baseUrl: string;
}

/**
 * Read a response body without buffering more than `maxBytes`. The declared
 * `content-length` is the cheap check; the read loop is the guarantee, because a
 * chunked response declares no length at all — and the service behind this
 * endpoint is backed by a 145 MB sqlite file.
 */
async function readBounded(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `claude-usage body is ${declared} bytes, over the ${maxBytes}-byte cap (${url})`,
    );
  }
  const body = res.body;
  if (!body) return await res.text(); // no stream to bound (empty body)
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`claude-usage body exceeded the ${maxBytes}-byte cap (${url})`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the socket on the over-cap path; a no-op once the stream is done.
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/**
 * Production deps hitting the live claude-usage. `timeoutMs` and `maxBytes` are
 * parameters so both bounds are testable against a real socket rather than only
 * against a fabricated rejection.
 */
export function defaultClaudeUsageDeps(
  baseUrl: string,
  configured: boolean,
  timeoutMs: number = CLAUDE_USAGE_TIMEOUT_MS,
  maxBytes: number = CLAUDE_USAGE_MAX_BYTES,
): ClaudeUsageDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    configured,
    baseUrl: root,
    fetchPipeline: async (days: number) => {
      const url = `${root}/api/pipeline?days=${days}`;
      // Every failure names the URL: the operator's first question about a
      // degraded card is whether it was even pointed at the right host, and
      // "fetch failed" alone cannot answer it.
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${url})`);
      }
      if (!res.ok) {
        throw new Error(`claude-usage returned HTTP ${res.status} for ${url}`);
      }
      const text = await readBounded(res, maxBytes, url);
      // A non-JSON body (an HTML error page from something else on the port) must
      // read as a degraded source, not as an empty ledger.
      try {
        return JSON.parse(text) as PipelinePayload;
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${url})`);
      }
    },
  };
}

// ---- Pure helpers (exported for unit tests) --------------------------------

/**
 * Clamp a `?days` query to claude-usage's own accepted range, by claude-usage's
 * own rules. This is a MIRROR of upstream `clampInt` (claude-usage
 * `src/http.ts`): `Number(raw)`, then `Math.round`, then clamp — deliberately not
 * `parseInt`, which reads `1e2` as 1, `12abc` as 12 and truncates `7.9` to 7, i.e.
 * answers a different window than the service would for the same query string.
 */
export function clampDays(raw: string | undefined | null): number {
  if (raw == null || raw.trim() === "") return CLAUDE_USAGE_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CLAUDE_USAGE_DEFAULT_DAYS;
  return Math.min(CLAUDE_USAGE_MAX_DAYS, Math.max(CLAUDE_USAGE_MIN_DAYS, Math.round(n)));
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

/** `YYYY-MM-DD` in the SERVER's local zone. Deliberately not `toISOString()`:
 *  measured at 00:41 CEST, the UTC slice named the previous day and the card
 *  reported a window starting a day before the one it asked for. */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Attach a caveat to a row only when upstream actually sent one. */
function withCaveat(
  row: ClaudeUsageRow,
  caveat: string | null | undefined,
  tone?: "warning",
): ClaudeUsageRow {
  const text = typeof caveat === "string" ? caveat.trim() : "";
  if (!text) return row;
  return { ...row, caveat: text, ...(tone ? { caveatTone: tone } : {}) };
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
  const ledgerAge = formatRelative(parseTs(payload.generatedAt), now);
  rows.push({
    label: "Window",
    value: `${days}d`,
    note: [
      since ? `since ${localDay(since)}` : null,
      ledgerAge ? `ledger built ${ledgerAge}` : "ledger build time unknown",
    ].filter(Boolean).join(" · "),
  });

  // ONE authoritative denominator: `compliance.merges`. The payload's `merges`
  // ARRAY is the per-merge detail list — truncatable, filterable, absent on a
  // degraded read — and rendering its length as the total made the card disagree
  // with its own Reviewed row.
  const mergeParts = [
    `${num(c.landed)} landed`,
    `${num(c.mergeUnconfirmed)} merged (unconfirmed)`,
    `${num(c.composedUnconfirmed)} composed (unconfirmed)`,
  ];
  // The three states above are upstream's whole vocabulary for a merge row, so
  // they should add up. If a future state appears, SAY the remainder rather than
  // rendering a total the note silently fails to explain.
  const accounted = [c.landed, c.mergeUnconfirmed, c.composedUnconfirmed];
  if (typeof c.merges === "number" && accounted.every((n) => typeof n === "number")) {
    const rest = c.merges - (accounted as number[]).reduce((a, b) => a + b, 0);
    if (rest > 0) mergeParts.push(`+${rest} unaccounted`);
  }
  rows.push(
    withCaveat(
      { label: "Merges", value: num(c.merges), note: mergeParts.join(" · ") },
      payload.confirmCaveat,
    ),
  );

  // The review floor is the number that matters: a SILENT unreviewed merge is
  // the violation the whole ledger exists to catch, so it drives the tone. The
  // denominator is LANDED merges, upstream's own choice for every review figure —
  // dividing by all merges rendered "418 / 732" beside "232 unreviewed", a pair
  // no arithmetic can produce.
  const unreviewed = c.unreviewed;
  rows.push(
    withCaveat(
      {
        label: "Reviewed",
        value: `${num(c.reviewed)} / ${num(c.landed)}`,
        note: `of landed merges · ${num(unreviewed)} unreviewed · ${num(c.silentUnreviewed)} silent · floor stated ${num(c.reviewFloorStated)}, skipped ${num(c.reviewFloorSkipped)}`,
        ...(typeof unreviewed === "number" && unreviewed > 0 ? { tone: "warning" as const } : {}),
      },
      payload.preStandardization
        ? `Window opens before ${payload.rulesStandardizedDate ?? "the rules were standardized"} — merges from before then are scored against rules that did not exist yet.`
        : null,
      "warning",
    ),
  );

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
  rows.push(
    withCaveat(
      {
        label: "Precision bar",
        value: bar == null ? "—" : bar ? "met" : "NOT met",
        note: bar === false ? "ledger numbers are provisional" : `markers v${num(payload.markersVersion?.current)}`,
        ...(bar === false ? { tone: "error" as const } : bar === true ? { tone: "success" as const } : {}),
      },
      payload.markersVersionCaveat,
      "warning",
    ),
  );

  return rows;
}

/**
 * Errors already warned about, keyed by message. A configured-but-down service
 * is polled every 5 minutes by every open `/models` tab, so the same sentence
 * would otherwise fill the log forever. First sighting warns, repeats drop to
 * info — the `warnedEnvFlagValues` pattern in `config.ts`. Cleared wholesale
 * past a sane size so a message carrying a varying detail cannot leak.
 */
const warnedClaudeUsageErrors = new Set<string>();

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
    const first = errors[0]!;
    if (warnedClaudeUsageErrors.has(first)) {
      log.info("claude-usage overview still degraded: {error}", { error: first });
    } else {
      if (warnedClaudeUsageErrors.size > 100) warnedClaudeUsageErrors.clear();
      warnedClaudeUsageErrors.add(first);
      log.warn("claude-usage overview degraded: {error}", { error: first });
    }
  }

  return {
    assembledAt: now,
    days,
    baseUrl: deps.baseUrl,
    configured: deps.configured,
    reachable: payload != null,
    rows: payload ? buildRows(payload, days, now) : [],
    ...(errors.length > 0 ? { errors } : {}),
  };
}
