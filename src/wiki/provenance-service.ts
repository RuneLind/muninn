/**
 * Resolving a page's provenance keys into an answer — the one place the session
 * ledger and the huginn Jira corpus are joined, shared by `GET /api/wiki/page`'s
 * `provenance` block and by the two reverse lookups
 * (`dashboard/routes/wiki-provenance.ts`).
 *
 * Both external reads are OPTIONAL and neither can fail the request:
 *
 *  - **claude-usage** (`session-ledger.ts`) is asked only when the page names a
 *    session AND this host is pointed at one. Unreachable, or an id this host's
 *    ledger does not hold, renders a bare chip; `ledger` on the payload says
 *    which of the three reasons applied.
 *  - **huginn's `jira-issues` listing** (`src/jira/verify-keys.ts`, a 10-minute
 *    TTL over a 271 KB fetch, with a 60 s negative cache on failure) is asked
 *    only when the page names a Jira key, and only to ADD the fact that huginn
 *    holds the issue. A degraded lookup drops the field; it never turns into
 *    "this key is fabricated", which is the verdict that file exists to get
 *    right.
 *
 * ── ONE deadline over the whole enrichment ──────────────────────────────────
 * The two reads run CONCURRENTLY under one {@link PROVENANCE_BUDGET_MS} signal,
 * batches included. Sequentially, with a per-call budget each, a page naming 600
 * sessions plus a Jira key could spend three ledger timeouts and then huginn's
 * fifteen seconds — a page open that hangs for half a minute while every fetch
 * is individually "bounded". A budget the page open can actually promise has to
 * be a budget over the page open.
 *
 * Neither read ships wiki page CONTENT anywhere, which is why these routes carry
 * no per-wiki egress prologue: the whole request is a list of session ids and
 * Jira keys going to a local ledger and a local knowledge API. A read-only
 * instance (`MUNINN_WIKI_READONLY=1`) and a read-only ROOT
 * (`WIKI_READONLY_ROOTS`) both answer them in full — the mini serves mimir that
 * way, and provenance is a READ.
 */

import type { WikiPageMeta } from "./store.ts";
import {
  costOfSessions,
  enrichSessions,
  hasProvenance,
  jiraRows,
  parsePrRef,
  LEDGER_NOT_ASKED,
  type ProvenanceLedgerState,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "./provenance.ts";
import { fetchSessionsById, type SessionLedgerDeps, type SessionLedgerResult } from "./session-ledger.ts";
import { loadJiraKeyIndex } from "../jira/verify-keys.ts";

/**
 * The WHOLE enrichment's budget, ledger batches and huginn together.
 *
 * The same 10 s every other claude-usage proxy uses, but spent over the whole
 * join rather than per call — a page open is an interactive request and the
 * number a reader waits is the one that has to be bounded. huginn's own
 * `loadJiraKeyIndex` carries a 15 s timeout of its own, which this deadline is
 * deliberately shorter than: a cold corpus fetch on a loaded machine must not be
 * able to hold a page open past this.
 */
export const PROVENANCE_BUDGET_MS = 10_000;

/** Everything the resolution needs from the process, injected so the whole join
 *  unit-tests with no live claude-usage and no live huginn. */
export interface ProvenanceContext {
  /**
   * The ledger client, and the ONE place "is a claude-usage configured on this
   * host" is recorded: `sessionLedger.urlConfigured`. FALSE ⇒ the ledger is
   * never fetched at all — not fetched-and-degraded. An instance nobody pointed
   * at a claude-usage would otherwise pay a connection refusal on the default
   * loopback port on every stamped page open, and report an "unreachable"
   * service it was never meant to run.
   *
   * A second `ledgerConfigured` field beside it was two sources of truth for one
   * fact, wired from one expression at the route and free to disagree anywhere
   * else — including in a test, where the disagreement is invisible.
   */
  sessionLedger: SessionLedgerDeps;
  /** huginn's base URL — `config.knowledgeApiUrl`. */
  knowledgeApiUrl: string;
  /** `CLAUDE_USAGE_PUBLIC_URL`, or null. The ONE claude-usage URL the browser
   *  ever sees; absent ⇒ the chips carry copyable ids and no link. */
  publicUrl: string | null;
  /** Test seam for the huginn corpus read. */
  loadJiraIndex?: typeof loadJiraKeyIndex;
  /** Test seam for the deadline, so a hanging-stub case costs milliseconds. */
  budgetMs?: number;
}

/** The session + Jira halves of an answer, before a caller adds its own fields. */
export interface ResolvedProvenance {
  sessions: ProvenanceSessionChip[];
  jira: ProvenancePayload["jira"];
  totalCost: number;
  costedSessions: number;
  ledger: ProvenanceLedgerState;
}

/**
 * Enrich one list of session refs and one list of Jira keys.
 *
 * `refs` are deduped by their BARE id: a page listing `claude-code:x` and a bare
 * `x` is one session, and pricing it twice would double the total.
 *
 * `costOver` narrows what `totalCost`/`costedSessions` are summed over — the
 * `?session=` lookup prices the ONE session asked about, not every session on
 * every page that matched it. Absent ⇒ every chip.
 */
export async function resolveProvenance(
  input: { refs: readonly string[]; keys: readonly string[]; costOver?: (chip: ProvenanceSessionChip) => boolean },
  ctx: ProvenanceContext,
): Promise<ResolvedProvenance> {
  const refs = dedupeSessionRefs(input.refs);
  const keys = [...new Set(input.keys)];

  const askLedger = refs.length > 0 && ctx.sessionLedger.urlConfigured;
  // ONE deadline, shared by both legs. Created only when something is actually
  // fetched, so a page with neither key does not arm a timer.
  const signal =
    askLedger || keys.length > 0 ? AbortSignal.timeout(ctx.budgetMs ?? PROVENANCE_BUDGET_MS) : undefined;

  // Concurrent: the two reads are independent services and running them in
  // sequence made the page open cost their SUM. `Promise.all` over two never-
  // throwing halves, so neither can reject the pair.
  const [ledgerResult, corpus] = await Promise.all([
    askLedger ? fetchSessionsById(ctx.sessionLedger, refs.map((r) => bareId(r)), signal) : null,
    keys.length ? loadCorpus(ctx, signal) : null,
  ]);

  // An UNASKED ledger leaves every chip `unresolved`, never `missing`: "the
  // ledger does not hold this session" is a claim, and a host that was never
  // pointed at a claude-usage is in no position to make it.
  const sessions = enrichSessions(
    refs,
    ledgerResult ?? { facts: new Map(), unresolved: new Set(refs.map((r) => bareId(r))) },
    ctx.publicUrl,
  );
  const { totalCost, costedSessions } = costOfSessions(
    input.costOver ? sessions.filter(input.costOver) : sessions,
  );

  return {
    sessions,
    jira: jiraRows(keys, corpus),
    totalCost,
    costedSessions,
    ledger: ledgerState(ledgerResult, ctx),
  };
}

/** The `ledger` block, with `asked` as the explicit third state. */
function ledgerState(
  result: SessionLedgerResult | null,
  ctx: ProvenanceContext,
): ProvenanceLedgerState {
  const configured = ctx.sessionLedger.urlConfigured;
  // Not configured ⇒ nothing was fetched and there is no endpoint to name.
  if (!configured) return LEDGER_NOT_ASKED;
  // Configured but nothing was SENT — either this page named no session at all
  // (a `jira`-only page, `result === null`), or every ref it named was refused
  // before batching as damage (`asked: false`). Both are "nobody asked", and
  // reporting the second as `reachable: false` put "claude-usage unreachable" on
  // a page whose only real problem was one mangled frontmatter line.
  if (!result || !result.asked) {
    return {
      asked: false,
      reachable: false,
      partial: false,
      configured,
      baseUrl: result?.baseUrl ?? ctx.sessionLedger.baseUrl,
    };
  }
  return {
    asked: true,
    reachable: result.reachable,
    partial: result.partial,
    configured,
    baseUrl: result.baseUrl,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.errors ? { errors: result.errors } : {}),
  };
}

/** The whole `provenance` block for one page, or null when it carries none. */
export async function pageProvenance(
  meta: WikiPageMeta,
  ctx: ProvenanceContext,
): Promise<ProvenancePayload | null> {
  // ONE gate, `hasProvenance` — the same predicate the store's own callers use,
  // so "does this page carry provenance" has a single answer.
  if (!hasProvenance(meta)) return null;
  const resolved = await resolveProvenance(
    { refs: meta.sessions ?? [], keys: meta.jira ?? [] },
    ctx,
  );
  return {
    ...resolved,
    prs: (meta.prs ?? []).map(parsePrRef),
    ...(meta.sessionsBackfilled ? { backfilled: meta.sessionsBackfilled } : {}),
  };
}

/**
 * First-wins dedup on the bare id, preserving the page's own order — with ONE
 * exception: a PREFIXED spelling replaces a bare one already kept.
 *
 * The reverse lookup puts the reader's query at the head of the list, and a
 * reader pastes the bare id as often as the prefixed one. Plain first-wins then
 * threw away the `provider:` the matched page carried, so the answer's own chip
 * for the session asked about was the one chip with no provider glyph. The
 * position is kept (the query still leads); only the spelling is upgraded.
 */
export function dedupeSessionRefs(refs: readonly string[]): string[] {
  const at = new Map<string, number>();
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const id = bareId(ref);
    const seen = at.get(id);
    if (seen === undefined) {
      at.set(id, out.length);
      out.push(ref);
      continue;
    }
    // A prefixed spelling is strictly more informative than a bare one; two
    // prefixed spellings of one id keep the first (the page's own order).
    if (out[seen] === id && ref !== id) out[seen] = ref;
  }
  return out;
}

function bareId(ref: string): string {
  const at = ref.indexOf(":");
  return at <= 0 || at === ref.length - 1 ? ref : ref.slice(at + 1);
}

/**
 * huginn's corpus, under the shared deadline.
 *
 * `fetchKnowledgeApi` takes a timeout, not a signal, so the deadline is applied
 * by RACING rather than by cancelling: past it this answers `null` (the same
 * degrade a failed lookup produces) and the underlying fetch runs on, bounded by
 * its own 15 s and negatively cached if it fails. That is deliberate — the fetch
 * populates a process-wide TTL cache, so letting it finish means the NEXT page
 * open is fast, while cancelling it would throw the work away and pay the wait
 * again. What the deadline has to bound is the page open, and it does.
 */
async function loadCorpus(
  ctx: ProvenanceContext,
  signal?: AbortSignal,
): Promise<Map<string, string | undefined> | null> {
  // `loadJiraKeyIndex` already swallows its own failures to null; the catch is
  // for the injected seam, so a throwing test double cannot 500 a route.
  const load = (async () => {
    try {
      return (await (ctx.loadJiraIndex ?? loadJiraKeyIndex)(ctx.knowledgeApiUrl))?.byKey ?? null;
    } catch {
      return null;
    }
  })();
  if (!signal) return await load;
  return await Promise.race([load, aborted(signal)]);
}

/** Resolves `null` when the shared deadline fires. */
function aborted(signal: AbortSignal): Promise<null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}
