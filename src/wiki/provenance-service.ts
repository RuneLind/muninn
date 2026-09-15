/**
 * Resolving a page's provenance keys into an answer — the one place the session
 * ledger and the huginn Jira corpus are joined, shared by `GET /api/wiki/page`'s
 * `provenance` block and by the two reverse lookups
 * (`dashboard/routes/wiki-provenance.ts`).
 *
 * Both external reads are OPTIONAL and neither can fail the request:
 *
 *  - **claude-usage** (`session-ledger.ts`) is asked only when the page names a
 *    session. Unreachable, or an id this host's ledger does not hold, renders a
 *    bare chip and `ledger.reachable: false` says which.
 *  - **huginn's `jira-issues` listing** (`src/jira/verify-keys.ts`, a 10-minute
 *    TTL over a 271 KB fetch) is asked only when the page names a Jira key, and
 *    only to ADD the issue's own URL. A degraded lookup drops the field; it never
 *    turns into "this key is fabricated", which is the verdict that file exists
 *    to get right.
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
  jiraRows,
  parsePrRef,
  type ProvenanceLedgerState,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "./provenance.ts";
import { fetchSessionsById, type SessionLedgerDeps } from "./session-ledger.ts";
import { loadJiraKeyIndex } from "../jira/verify-keys.ts";

/** Everything the resolution needs from the process, injected so the whole join
 *  unit-tests with no live claude-usage and no live huginn. */
export interface ProvenanceContext {
  sessionLedger: SessionLedgerDeps;
  /** huginn's base URL — `config.knowledgeApiUrl`. */
  knowledgeApiUrl: string;
  /** `CLAUDE_USAGE_PUBLIC_URL`, or null. The ONE claude-usage URL the browser
   *  ever sees; absent ⇒ the chips carry copyable ids and no link. */
  publicUrl: string | null;
  /** Test seam for the huginn corpus read. */
  loadJiraIndex?: typeof loadJiraKeyIndex;
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
 */
export async function resolveProvenance(
  input: { refs: readonly string[]; keys: readonly string[] },
  ctx: ProvenanceContext,
): Promise<ResolvedProvenance> {
  const refs = dedupeSessionRefs(input.refs);
  const keys = [...new Set(input.keys)];

  const ledgerResult = refs.length
    ? await fetchSessionsById(ctx.sessionLedger, refs.map((r) => bareId(r)))
    : null;
  const corpus = keys.length ? await loadCorpus(ctx) : null;

  const sessions = enrichSessions(
    refs,
    ledgerResult ?? { facts: new Map() },
    ctx.publicUrl,
  );
  const { totalCost, costedSessions } = costOfSessions(sessions);

  return {
    sessions,
    jira: jiraRows(keys, corpus),
    totalCost,
    costedSessions,
    ledger: {
      // A page naming NO session was never asked about — "unreachable" would be
      // a claim about a call that did not happen, so it reports the honest
      // false with no errors beside it and the reader shows no ledger state.
      reachable: ledgerResult?.reachable ?? false,
      configured: ctx.sessionLedger.urlConfigured,
      baseUrl: ctx.sessionLedger.baseUrl,
      ...(ledgerResult?.errors ? { errors: ledgerResult.errors } : {}),
    },
  };
}

/** The whole `provenance` block for one page, or null when it carries none. */
export async function pageProvenance(
  meta: WikiPageMeta,
  ctx: ProvenanceContext,
): Promise<ProvenancePayload | null> {
  const refs = meta.sessions ?? [];
  const keys = meta.jira ?? [];
  const prs = meta.prs ?? [];
  if (refs.length === 0 && keys.length === 0 && prs.length === 0) return null;
  const resolved = await resolveProvenance({ refs, keys }, ctx);
  return {
    ...resolved,
    prs: prs.map(parsePrRef),
    ...(meta.sessionsBackfilled ? { backfilled: meta.sessionsBackfilled } : {}),
  };
}

/** First-wins dedup on the bare id, preserving the page's own order. */
export function dedupeSessionRefs(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const id = bareId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(ref);
  }
  return out;
}

function bareId(ref: string): string {
  const at = ref.indexOf(":");
  return at <= 0 || at === ref.length - 1 ? ref : ref.slice(at + 1);
}

async function loadCorpus(ctx: ProvenanceContext): Promise<Map<string, string | undefined> | null> {
  try {
    const index = await (ctx.loadJiraIndex ?? loadJiraKeyIndex)(ctx.knowledgeApiUrl);
    return index?.byKey ?? null;
  } catch {
    // `loadJiraKeyIndex` already swallows its own failures to null; this catch
    // is for the injected seam, so a throwing test double cannot 500 a route.
    return null;
  }
}
