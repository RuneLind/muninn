/**
 * The claude-usage `GET /api/sessions-by-id` client — what turns the session ids
 * on a wiki page into "the N sessions that wrote this page cost $X in total".
 *
 * The third server-side proxy of that service, and it shares the ONE fetch
 * helper with the other two (`utils/claude-usage-fetch.ts`, used by
 * `dashboard/claude-usage-overview.ts` and `plans/ledger.ts`): the BROWSER never
 * reaches port 8787, because the dashboard is viewed over the tailnet where a
 * client-side loopback fetch hits the viewer's own machine and a cross-host one
 * is mixed content under `tailscale serve`. So the reader gets the money from
 * muninn, and the only thing it gets of claude-usage's own is the optional
 * `CLAUDE_USAGE_PUBLIC_URL` link.
 *
 * Reads are bounded (`utils/bounded-fetch.ts`, 8 MiB) and NEVER throw: an
 * unreachable ledger is `{ reachable: false, errors: [...] }` and a page whose
 * chips carry no money, which is the plans board's degrade exactly.
 *
 * ── Four states, not two ────────────────────────────────────────────────────
 * A chip is bare for FOUR different reasons and they are not interchangeable:
 * the ledger answered and does not hold the id (`missing`), a batch failed so
 * nobody ever asked (`unresolved`), the id could never be asked about at all
 * (`invalid`), or the whole enrichment was never attempted. Collapsing the
 * second into the first is how a partial outage renders as "these sessions were
 * reaped" — the reader's conclusion is the opposite of the truth, and
 * `totalCost` silently under-reports beside it.
 *
 * ── What "cost" means here, and what it does not ─────────────────────────────
 * `totalCost` is the sum over the sessions the ledger PRICED. It is not this
 * page's share of them: a session that wrote four pages cost what it cost, and
 * dividing it four ways would invent a number. `costedSessions` is the
 * denominator that says how much of the list the total is actually over — a
 * reaped id contributes nothing and is not a $0 session either.
 */

import { BOUNDED_FETCH_TIMEOUT_MS, BOUNDED_FETCH_MAX_BYTES } from "../utils/bounded-fetch.ts";
import { claudeUsageJson, claudeUsageWarnOnce } from "../utils/claude-usage-fetch.ts";
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
 * A second, LOWER bound that is not ours and is quoted in BYTES.
 *
 * claude-usage is a `Bun.serve()`, and Bun refuses a request whose whole HEADER
 * BLOCK — request line plus every header plus the terminating CRLFs — reaches
 * **16,385 bytes**, answering an empty-bodied 431 before any handler runs. So
 * the limit is exactly 16 KiB of headers. Bisected 2026-09-15 against a local
 * `Bun.serve()` on bun 1.3.10 with raw sockets (`fetch` will not build a request
 * line that long): with a `Host:` and a `Connection:` header the largest request
 * LINE answered is 16,338 bytes and 16,339 is refused — and the line figure
 * moves with whatever other headers the caller and any proxy add, which is
 * precisely why the budget below is not set at it.
 *
 * The id COUNT is not the unit either, because it moves with how long the ids
 * happen to be. So this budget is over the QUERY and is held well under the
 * bound: 200 Claude Code uuids are ~7.4 kB (200 × 37 bytes with commas), and a
 * provider whose ids are three times longer would reach the 431 on a full batch
 * without it. The remaining ~4 kB of headroom is what absorbs the headers this
 * process does not choose.
 */
export const SESSION_IDS_QUERY_MAX_BYTES = 12_000;

/**
 * The longest session id muninn will ask about. A longer value on a page cannot
 * BE a session id, and sending it is how ONE malformed frontmatter entry takes
 * out the whole batch it rides in (a 431 has no body naming the offender).
 *
 * 128 because that is the cap the WRITER enforces: claude-usage's `wiki-stamp`
 * only ever stamps a ref matching `SESSION_REF_RE`
 * (`/^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,128}$/`, `src/wiki-stamp.ts:47`), so no
 * id that pipeline put on a page can exceed it. It is NOT a storage limit —
 * every `session_id` column in claude-usage's sqlite schema (`src/store.ts`) is
 * a bare `TEXT`, which sqlite does not bound — so a longer value is refused
 * here as frontmatter damage, not because the ledger could not hold it.
 */
export const SESSION_ID_MAX_CHARS = 128;

/**
 * The characters a session id is made of, across every provider that stamps
 * one: Claude Code uuids, opencode's `ses_…`, and anything else built from the
 * same alphabet. Anything outside it — a space, a slash, a `%` — is frontmatter
 * damage rather than an id, and refusing it here is what keeps a query string
 * from carrying something that is not one.
 */
export const SESSION_ID_SHAPE = /^[A-Za-z0-9._-]+$/;

/** Is this a value claude-usage could hold at all? */
export function isSessionIdShape(id: string): boolean {
  return id.length > 0 && id.length <= SESSION_ID_MAX_CHARS && SESSION_ID_SHAPE.test(id);
}

export interface SessionLedgerResult {
  /**
   * At least one request was SENT. False when every id on the page was refused
   * before batching, which is the one way this returns having asked nothing —
   * and the reason it is a field rather than `result !== null` at the caller:
   * `reachable: false` beside `asked: false` is "nobody asked", while beside
   * `asked: true` it is "the ledger is down", and a page whose only session line
   * is damaged reported the second.
   */
  asked: boolean;
  /** At least one batch answered with a readable payload. */
  reachable: boolean;
  /** Some batch answered and some did not — the total is over a SUBSET. */
  partial: boolean;
  /** The base URL actually tried, so a degraded reader can name its endpoint. */
  baseUrl: string;
  /** `CLAUDE_USAGE_URL` was set explicitly on THIS host (vs the default). */
  urlConfigured: boolean;
  /** id → facts, for every id the ledger held. Keyed on the BARE id. */
  facts: Map<string, LedgerSessionFacts>;
  /** Bare ids whose batch never answered. NOT missing — nobody asked. */
  unresolved: Set<string>;
  /** Bare ids refused before batching (too long, or not an id shape). */
  invalid: Set<string>;
  /** Upstream cut a batch at its own cap — should not happen, since we page at
   *  the same cap, but it is reported rather than assumed away. */
  truncated: boolean;
  errors?: string[];
}

/** Injectable seam so tests drive the join without a live claude-usage. */
export interface SessionLedgerDeps {
  /** Must reject on timeout / non-200 / over-cap / malformed JSON. */
  fetchSessions: (ids: string[], signal?: AbortSignal) => Promise<unknown>;
  /**
   * `GET /api/merges?sessions=` — same contract, same bounds, same rejection
   * rules as `fetchSessions`.
   *
   * REQUIRED rather than optional on purpose: an absent leg would be
   * indistinguishable from a leg that answered nothing, so a wiring mistake
   * would render as "these sessions merged nothing" on every page. Every
   * construction site states what its merges leg does, and the compiler is what
   * enforces it.
   */
  fetchMerges: (ids: string[], signal?: AbortSignal) => Promise<unknown>;
  urlConfigured: boolean;
  baseUrl: string;
}

/**
 * Production deps hitting the live claude-usage. The bounds are parameters for
 * the same reason the plans board's are: both are testable against a real socket.
 *
 * A `signal` handed to `fetchSessions` REPLACES the per-call timeout — the
 * caller owns a deadline over the whole enrichment, and two budgets on one fetch
 * means the looser one never applies (see `provenance-service.ts`).
 */
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
    fetchSessions: (ids, signal) =>
      claudeUsageJson(root, `/api/sessions-by-id?ids=${ids.map(encodeURIComponent).join(",")}`, {
        timeoutMs,
        maxBytes,
        signal,
        // The full URL carries every id, so the SHORT form is what a log line
        // and a degrade message name. The operator's first question about a
        // degraded chip is whether this host was pointed at the right service.
        label: root,
      }),
    // `?sessions=`, not `?ids=` — this route names the parameter after what it
    // is keyed on, and the wrong name is a 400 saying `sessions is required`.
    fetchMerges: (ids, signal) =>
      claudeUsageJson(root, `/api/merges?sessions=${ids.map(encodeURIComponent).join(",")}`, {
        timeoutMs,
        maxBytes,
        signal,
        label: root,
      }),
  };
}

/**
 * Split ids into calls that satisfy BOTH bounds — the 200-id cap and the query
 * byte budget. Pure, so the byte arithmetic is testable without a socket.
 *
 * Every id reaching here has already passed {@link isSessionIdShape}, so no
 * single id can exceed the budget on its own; the caller is what guarantees it,
 * because a batch carrying one over-long id fails as a whole and takes every
 * legitimate id beside it down with it.
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

/** Test-only: forget which errors have already warned. */
export { __resetClaudeUsageWarnsForTest as __resetSessionLedgerWarnsForTest } from "../utils/claude-usage-fetch.ts";

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
 * `unresolved` and the reason in `errors`, while batches that answered still
 * count — and `partial` is what says the total is over a subset.
 *
 * `ids` are BARE — the `provider:` prefix is muninn's, not the ledger's, and a
 * prefixed id would come back `missing` for every session that exists.
 *
 * `signal` is a deadline over the WHOLE lookup, batches included. Without it a
 * page naming 600 sessions could spend three sequential per-call budgets.
 */
export async function fetchSessionsById(
  deps: SessionLedgerDeps,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<SessionLedgerResult> {
  const facts = new Map<string, LedgerSessionFacts>();
  const unresolved = new Set<string>();
  const invalid = new Set<string>();
  const errors: string[] = [];
  let answered = false;
  let failed = false;
  let truncated = false;

  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const askable: string[] = [];
  for (const id of unique) {
    if (isSessionIdShape(id)) askable.push(id);
    else invalid.add(id);
  }
  if (invalid.size > 0) {
    log.debug("{n} session id(s) on a page are not askable — refused before batching", {
      n: invalid.size,
    });
  }

  if (askable.length === 0) {
    return {
      asked: false,
      reachable: false,
      partial: false,
      baseUrl: deps.baseUrl,
      urlConfigured: deps.urlConfigured,
      facts,
      unresolved,
      invalid,
      truncated: false,
    };
  }

  for (const batch of batchSessionIds(askable)) {
    const fail = (reason: string) => {
      failed = true;
      for (const id of batch) unresolved.add(id);
      errors.push(`claude-usage sessions: ${reason}`);
    };
    let payload: unknown;
    try {
      payload = await deps.fetchSessions(batch, signal);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      // A body that is not an object is a wrong service on the port, not an
      // empty ledger — and WHICH port is the operator's first question.
      fail(`response was not a JSON object (${deps.baseUrl})`);
      continue;
    }
    const rows = (payload as { sessions?: unknown }).sessions;
    if (!Array.isArray(rows)) {
      fail(`payload carried no \`sessions\` array (${deps.baseUrl})`);
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

  // EVERY distinct error warns, not only the first: with several batches the
  // first failure is not in general the only condition, and a warn-once keyed on
  // the message already stops a repeating one from filling the log.
  for (const error of new Set(errors)) {
    claudeUsageWarnOnce({ log, baseUrl: deps.baseUrl, key: error, error, what: "session ledger" });
  }

  return {
    // Unconditionally true HERE, and provably so: the `askable.length === 0`
    // early return above is the only path that sends nothing, and
    // `batchSessionIds` of a non-empty list always yields at least one batch.
    // A counter would read as a condition and could not be made to fail.
    asked: true,
    reachable: answered,
    partial: answered && failed,
    baseUrl: deps.baseUrl,
    urlConfigured: deps.urlConfigured,
    facts,
    unresolved,
    invalid,
    truncated,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ── The merges leg ──────────────────────────────────────────────────────────

/** One `/api/merges` row, as muninn keeps it. Mirrors the route's own shape;
 *  the payload type the reader renders is `ProvenanceMerge`. */
export interface LedgerMerge {
  sessionId: string;
  repo: string;
  prNumber: number | null;
  url: string | null;
  subject: string | null;
  mergedAt: string | null;
  mergeOk: boolean;
}

export interface MergeLedgerResult {
  /** At least one request was SENT — false when every id was refused first. */
  asked: boolean;
  /** At least one batch answered with a readable payload. */
  reachable: boolean;
  /**
   * Some batches answered and some did not, so `merges` is a SUBSET of what the
   * service holds for these sessions.
   *
   * The same third state the facts leg carries, and it exists for the same
   * reason: with more than one batch, `reachable` alone reports a half-answer as
   * a whole one — measured on 250 ids (batches of 200 + 50, the second
   * throwing), which rendered one merge under a footer that said nothing.
   */
  partial: boolean;
  merges: LedgerMerge[];
  /** Upstream cut a batch at its own cap. */
  truncated: boolean;
  /** The cap upstream reports alongside `truncated` — its number, not ours. */
  limit?: number;
  errors?: string[];
}

/**
 * A row, defensively.
 *
 * `sessionId` is the only field a row cannot be rendered without — it is the
 * join back onto a chip — so a row missing it is dropped rather than shown as a
 * merge belonging to nothing. Everything else degrades to its own null.
 *
 * `mergeOk` is read as "false only when explicitly false": an older ledger that
 * does not send the field must not turn every merge on the page into
 * `merge unconfirmed`, which is a claim about the merge, not about the payload.
 */
function toMerge(v: unknown): LedgerMerge | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const row = v as Record<string, unknown>;
  if (typeof row.sessionId !== "string" || !row.sessionId) return null;
  return {
    sessionId: row.sessionId,
    repo: typeof row.repo === "string" ? row.repo : "",
    prNumber: typeof row.prNumber === "number" ? row.prNumber : null,
    url: typeof row.url === "string" ? row.url : null,
    subject: typeof row.subject === "string" ? row.subject : null,
    mergedAt: typeof row.mergedAt === "string" ? row.mergedAt : null,
    mergeOk: row.mergeOk !== false,
  };
}

/**
 * Every merge the given sessions made, paged by the SAME two bounds the facts
 * leg pages by — the 200-id cap and the query byte budget, both of which are
 * properties of the service and of Bun's 16 KiB header block, not of a route.
 *
 * Never throws. A failed batch leaves its rows out and the reason in `errors`,
 * and — when another batch DID answer — sets `partial`, which is the difference
 * between "no merges" and "some of the merges". The reader's degrade is one
 * footer line, and the page's cost sentence — which is about the FACTS leg — is
 * untouched either way.
 *
 * `signal` is the caller's deadline over the whole page open, shared with the
 * facts leg. Two budgets on one page open means the looser one never applies.
 */
export async function fetchMergesForSessions(
  deps: SessionLedgerDeps,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<MergeLedgerResult> {
  const merges: LedgerMerge[] = [];
  const errors: string[] = [];
  let answered = false;
  let failed = false;
  let truncated = false;
  let limit: number | undefined;

  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const askable = unique.filter((id) => isSessionIdShape(id));
  if (askable.length === 0) {
    return { asked: false, reachable: false, partial: false, merges, truncated: false };
  }

  for (const batch of batchSessionIds(askable)) {
    const fail = (reason: string) => {
      failed = true;
      errors.push(`claude-usage merges: ${reason}`);
    };
    let payload: unknown;
    try {
      payload = await deps.fetchMerges(batch, signal);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      fail(`response was not a JSON object (${deps.baseUrl})`);
      continue;
    }
    const rows = (payload as { merges?: unknown }).merges;
    if (!Array.isArray(rows)) {
      // A payload with no `merges` array is a wrong service or a route that
      // answered an error body — NOT a session that merged nothing.
      fail(`payload carried no \`merges\` array (${deps.baseUrl})`);
      continue;
    }
    answered = true;
    if ((payload as { truncated?: unknown }).truncated === true) {
      truncated = true;
      // Upstream's OWN cap, carried rather than re-stated here: `truncated` is
      // `ids.length > SESSION_IDS_MAX` per CALL over there, and a number typed
      // into a note on this side is a second spelling of a constant that lives
      // in another repo.
      const l = (payload as { limit?: unknown }).limit;
      if (typeof l === "number" && Number.isFinite(l) && l > 0) limit = l;
    }
    for (const row of rows) {
      const merge = toMerge(row);
      if (merge) merges.push(merge);
    }
  }

  for (const error of new Set(errors)) {
    claudeUsageWarnOnce({ log, baseUrl: deps.baseUrl, key: error, error, what: "merge ledger" });
  }

  return {
    asked: true,
    reachable: answered,
    partial: answered && failed,
    merges,
    truncated,
    ...(limit !== undefined ? { limit } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
