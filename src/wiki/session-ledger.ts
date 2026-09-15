/**
 * The claude-usage `GET /api/sessions-by-id` client — what turns the session ids
 * on a wiki page into "the N sessions that wrote this page cost $X in total".
 *
 * The third server-side proxy of that service, and it is deliberately built like
 * the first two (`dashboard/claude-usage-overview.ts`, `plans/ledger.ts`): the
 * BROWSER never reaches port 8787, because the dashboard is viewed over the
 * tailnet where a client-side loopback fetch hits the viewer's own machine and a
 * cross-host one is mixed content under `tailscale serve`. So the reader gets the
 * money from muninn, and the only thing it gets of claude-usage's own is the
 * optional `CLAUDE_USAGE_PUBLIC_URL` link.
 *
 * Reads go through `utils/bounded-fetch.ts` (10 s, 8 MiB) and NEVER throw: an
 * unreachable ledger is `{ reachable: false, errors: [...] }` and a page whose
 * chips carry no money, which is the plans board's degrade exactly.
 *
 * ── What "cost" means here, and what it does not ─────────────────────────────
 * `totalCost` is the sum over the sessions the ledger PRICED. It is not this
 * page's share of them: a session that wrote four pages cost what it cost, and
 * dividing it four ways would invent a number. `costedSessions` is the
 * denominator that says how much of the list the total is actually over — a
 * reaped id contributes nothing and is not a $0 session either.
 */

import { readBounded, BOUNDED_FETCH_TIMEOUT_MS, BOUNDED_FETCH_MAX_BYTES } from "../utils/bounded-fetch.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "session-ledger");

/** One session as claude-usage reports it (`factsBlock`, `src/routes.ts`). */
export interface LedgerSessionFacts {
  sessionId: string;
  title?: string | null;
  provider?: string | null;
  host?: string | null;
  hosts?: string[];
  first?: string | null;
  last?: string | null;
  cost?: number | null;
  messages?: number | null;
}

/** Upstream's own per-call id cap, mirrored so muninn pages rather than losing
 *  the tail silently. Upstream reports `truncated` when it had to cut. */
export const SESSION_IDS_PER_CALL = 200;

/**
 * A second, LOWER bound that is not ours and is quoted in BYTES: a request LINE
 * — method, path, query and HTTP version — of 16,321 bytes or more is answered
 * with an empty-bodied 431 before any handler runs (bisected upstream). The id
 * count is not the unit, because it moves with how long the ids happen to be, so
 * this budget is over the QUERY and is held well under the bound: 200 Claude
 * Code uuids are ~7.4 KiB, and a provider whose ids are three times longer would
 * reach the 431 on a full batch without it.
 */
export const SESSION_IDS_QUERY_MAX_BYTES = 12_000;

export interface SessionLedgerResult {
  /** The ledger answered with a readable payload. False ⇒ bare chips. */
  reachable: boolean;
  /** The base URL actually tried, so a degraded reader can name its endpoint. */
  baseUrl: string;
  /** `CLAUDE_USAGE_URL` was set explicitly on THIS host (vs the default). */
  urlConfigured: boolean;
  /** id → facts, for every id the ledger held. Keyed on the BARE id. */
  facts: Map<string, LedgerSessionFacts>;
  /** Upstream cut a batch at its own cap — should not happen, since we page at
   *  the same cap, but it is reported rather than assumed away. */
  truncated: boolean;
  errors?: string[];
}

/** Injectable seam so tests drive the join without a live claude-usage. */
export interface SessionLedgerDeps {
  /** Must reject on timeout / non-200 / over-cap / malformed JSON. */
  fetchSessions: (ids: string[]) => Promise<unknown>;
  urlConfigured: boolean;
  baseUrl: string;
}

/** Production deps hitting the live claude-usage. The bounds are parameters for
 *  the same reason the plans board's are: both are testable against a real socket. */
export function defaultSessionLedgerDeps(
  baseUrl: string,
  urlConfigured: boolean,
  timeoutMs: number = BOUNDED_FETCH_TIMEOUT_MS,
  maxBytes: number = BOUNDED_FETCH_MAX_BYTES,
): SessionLedgerDeps {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    urlConfigured,
    baseUrl: root,
    fetchSessions: async (ids) => {
      const url = `${root}/api/sessions-by-id?ids=${ids.map(encodeURIComponent).join(",")}`;
      // Every failure names the base URL — the operator's first question about a
      // degraded chip is whether this host was pointed at the right service. The
      // full URL carries the ids, so the SHORT form is what the message shows.
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${root})`);
      }
      if (!res.ok) throw new Error(`claude-usage returned HTTP ${res.status} (${root})`);
      let text: string;
      try {
        text = await readBounded(res, maxBytes, root);
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} (${root})`);
      }
    },
  };
}

/**
 * Split ids into calls that satisfy BOTH bounds — the 200-id cap and the query
 * byte budget. Pure, so the byte arithmetic is testable without a socket.
 */
export function batchSessionIds(
  ids: readonly string[],
  perCall: number = SESSION_IDS_PER_CALL,
  maxQueryBytes: number = SESSION_IDS_QUERY_MAX_BYTES,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    // `+ 1` for the comma this id needs once it is not the first.
    const cost = Buffer.byteLength(encodeURIComponent(id), "utf8") + 1;
    if (current.length > 0 && (current.length >= perCall || bytes + cost > maxQueryBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(id);
    bytes += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Errors already warned about. Same reason as the plans board's: a
 *  configured-but-down service is polled by every open reader tab. */
const warnedLedgerErrors = new Set<string>();

function warnOnce(message: string): void {
  if (warnedLedgerErrors.has(message)) {
    log.info("session ledger still degraded: {error}", { error: message });
    return;
  }
  if (warnedLedgerErrors.size > 100) warnedLedgerErrors.clear();
  warnedLedgerErrors.add(message);
  log.warn("session ledger degraded: {error}", { error: message });
}

/** Test-only: forget which errors have already warned. */
export function __resetSessionLedgerWarnsForTest(): void {
  warnedLedgerErrors.clear();
}

function isFacts(v: unknown): v is LedgerSessionFacts & { missing?: boolean } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { sessionId?: unknown }).sessionId === "string"
  );
}

/**
 * Look up every id, paged. Never throws; a batch that fails leaves its ids
 * unpriced and the reason in `errors`, while batches that answered still count.
 *
 * `ids` are BARE — the `provider:` prefix is muninn's, not the ledger's, and a
 * prefixed id would come back `missing` for every session that exists.
 */
export async function fetchSessionsById(
  deps: SessionLedgerDeps,
  ids: readonly string[],
): Promise<SessionLedgerResult> {
  const facts = new Map<string, LedgerSessionFacts>();
  const errors: string[] = [];
  let answered = false;
  let truncated = false;

  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return {
      reachable: false,
      baseUrl: deps.baseUrl,
      urlConfigured: deps.urlConfigured,
      facts,
      truncated: false,
    };
  }

  for (const batch of batchSessionIds(unique)) {
    let payload: unknown;
    try {
      payload = await deps.fetchSessions(batch);
    } catch (err) {
      errors.push(`claude-usage sessions: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      // A body that is not an object is a wrong service on the port, not an
      // empty ledger — and WHICH port is the operator's first question.
      errors.push(`claude-usage sessions: response was not a JSON object (${deps.baseUrl})`);
      continue;
    }
    const rows = (payload as { sessions?: unknown }).sessions;
    if (!Array.isArray(rows)) {
      errors.push(`claude-usage sessions: payload carried no \`sessions\` array (${deps.baseUrl})`);
      continue;
    }
    answered = true;
    if ((payload as { truncated?: unknown }).truncated === true) truncated = true;
    for (const row of rows) {
      // A `missing: true` row is the ledger saying it does not hold that id —
      // not a failure, and not a $0 session. It simply never enters the map.
      if (!isFacts(row) || row.missing === true) continue;
      facts.set(row.sessionId, row);
    }
  }

  if (errors.length > 0) warnOnce(errors[0]!);

  return {
    reachable: answered,
    baseUrl: deps.baseUrl,
    urlConfigured: deps.urlConfigured,
    facts,
    truncated,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
