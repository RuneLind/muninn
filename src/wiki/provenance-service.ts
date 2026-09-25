/**
 * Resolving a page's provenance keys into an answer — the one place the session
 * ledger and the huginn Jira corpus are joined, shared by
 * `GET /api/wiki/page/provenance` (the block the reader fetches AFTER the page
 * is on screen — `GET /api/wiki/page` only says whether there is one to fetch,
 * `provenancePending`) and by the two reverse lookups
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

import type { WikiIndex, WikiPageMeta } from "./store.ts";
import { trackerAdapter, relationsCount, type IssueFacts, type IssueLedgerView, type IssueRow, type TrackerAdapter, type TrackerConfig } from "./trackers/index.ts";
import { issueRowsFor, statusCategory } from "./trackers/rows.ts";
import {
  costOfSessions,
  enrichSessions,
  ghostCandidates,
  handoffLinks,
  hasProvenance,
  jiraRows,
  parsePrRef,
  stampRefFor,
  HANDOFF_READS_MAX,
  LEDGER_NOT_ASKED,
  LEG_NOT_ASKED,
  MERGES_NOT_ASKED,
  PR_READS_MAX,
  type ProvenanceHandoff,
  type ProvenanceLedgerState,
  type ProvenanceLegState,
  type ProvenanceMerge,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "./provenance.ts";
import {
  fetchHandoffs,
  fetchMergesForPrs,
  fetchMergesForSessions,
  fetchSessionsById,
  type SessionLedgerDeps,
  type SessionLedgerResult,
} from "./session-ledger.ts";
import { stampableFor, stampConfigFromEnv } from "./stamp-roots.ts";
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
  /**
   * May this instance offer a Stamp for a page in this wiki? The ONE predicate,
   * injected so a test drives it without the environment; production reads
   * `WIKI_STAMP_BIN`/`WIKI_STAMP_ROOTS` and both read-only guards through
   * `stampableFor`. A page with no wiki root in hand is never stampable.
   */
  stampable?: (wikiDir: string | undefined) => boolean;
  /** Test seam for the deadline, so a hanging-stub case costs milliseconds. */
  budgetMs?: number;
  /** Test seam for a tracker's issue lookup (`TrackerAdapter.lookup`). */
  lookupIssues?: (adapter: TrackerAdapter, knowledgeApiUrl: string) => Promise<Map<string, IssueFacts> | null>;
}

/** At most this many keys per page are priced through the session ledger —
 *  one call each, since `/api/jira` has no batch form. */
export const ISSUE_LEDGER_MAX = 8;
/** …and at most this many of those calls are in flight at once. */
export const ISSUE_LEDGER_CONCURRENCY = 4;

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
  /**
   * The deadline, when a CALLER owns one.
   *
   * `pageProvenance` runs a third leg (merges) beside these two and has to hold
   * the timer itself: a signal created down here and never returned would leave
   * that leg either unbounded or armed with a second timer of its own, and
   * awaiting this function before starting it would make the page open
   * sequential. Absent — the two reverse lookups — this creates its own, under
   * the same condition as before.
   */
  outerSignal?: AbortSignal,
): Promise<ResolvedProvenance> {
  const refs = dedupeSessionRefs(input.refs);
  const keys = [...new Set(input.keys)];

  const askLedger = refs.length > 0 && ctx.sessionLedger.urlConfigured;
  // ONE deadline, shared by every leg. Created only when something is actually
  // fetched, so a page with neither key does not arm a timer.
  const signal =
    outerSignal ??
    (askLedger || keys.length > 0 ? AbortSignal.timeout(ctx.budgetMs ?? PROVENANCE_BUDGET_MS) : undefined);

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

/**
 * The whole `provenance` block for one page, or null when it carries none.
 *
 * THREE legs, ONE deadline, all started together: the session facts and the
 * huginn corpus (inside `resolveProvenance`) and the merges route beside them.
 * The merges leg lives HERE rather than in `resolveProvenance` because the two
 * reverse lookups share that function over up to 1,000 refs — a fan-out there
 * would multiply the calls one GET buys, on a route that renders no merge.
 *
 * The timer is created here, once, and handed down. Creating one per leg is how
 * a page open whose legs are each "bounded at 10 s" comes to take thirty.
 */
export async function pageProvenance(
  meta: WikiPageMeta,
  ctx: ProvenanceContext,
  /** The wiki's resolved root — the ONE input `stampable` needs. Absent (a
   *  caller that has no root in hand) ⇒ no Stamp is offered. */
  wikiDir?: string,
  /** The wiki's index: its key map and its resolved tracker config feed the
   *  issue rows. Absent ⇒ no rows (a caller with no index in hand). */
  index?: WikiIndex,
): Promise<ProvenancePayload | null> {
  // ONE gate, `hasProvenance` — the same predicate the store's own callers use,
  // so "does this page carry provenance" has a single answer.
  if (!hasProvenance(meta)) return null;

  const refs = meta.sessions ?? [];
  const keys = meta.jira ?? [];
  // The DEDUPED list, which is exactly what `resolveProvenance` asks over — and
  // the reason the gate reads it rather than `refs.length`: `dedupeSessionRefs`
  // drops a blank entry, so a page whose only `sessions:` line is whitespace
  // reaches the ledger with nothing to ask while a raw-length gate arms a timer
  // and starts two legs for it.
  const askRefs = dedupeSessionRefs(refs).map((r) => bareId(r));
  // Exactly `resolveProvenance`'s own condition, hoisted: a page with nothing to
  // ask still arms no timer.
  const askLedger = askRefs.length > 0 && ctx.sessionLedger.urlConfigured;

  // Leg 3's own gate. A page past the cap reads NO handoff at all — rendering
  // the first ten silently would be a chain that is short for a reason nothing
  // states — and the footer says so instead.
  const handoffsCapped = askLedger && askRefs.length > HANDOFF_READS_MAX;
  const askHandoffs = askLedger && !handoffsCapped;

  // Leg 4's input: the page's OWN `prs:` list, filtered to the coordinate shape
  // (a malformed one is a 400 for the whole request upstream, so a typo in one
  // entry must not take the leg down) and capped client-side.
  const prRefs = (meta.prs ?? []).map(parsePrRef);
  const coordinates = prRefs.filter((pr) => pr.url !== null).map((pr) => pr.ref);
  const prsCapped = coordinates.length > PR_READS_MAX;
  const askPrs = ctx.sessionLedger.urlConfigured && coordinates.length > 0;

  // ONE timer for every leg, armed only when something is actually fetched — a
  // `prs:`-only page asks nothing of the ledger's session routes and everything
  // of `?prs=`, so that leg is part of the condition rather than riding a timer
  // armed for somebody else.
  // Leg 5's input: the page's issue rows, index-local half. `[]` on a wiki
  // with no tracker, which is every page there.
  const trackers = index?.readerConfig?.trackers ?? [];
  const baseRows = issueRowsFor(meta, index?.issueKeys, trackers);

  const signal =
    askLedger || askPrs || keys.length > 0 || baseRows.length > 0
      ? AbortSignal.timeout(ctx.budgetMs ?? PROVENANCE_BUDGET_MS)
      : undefined;

  // Legs 1-4, started together. Held as PROMISES rather than awaited in one
  // `Promise.all`, because the second hop must not wait on leg 1.
  const resolvedP = resolveProvenance({ refs, keys }, ctx, signal);
  // The SAME list the facts leg pages over — deduped, bare ids, since the
  // `provider:` prefix is muninn's and the ledger is keyed on neither.
  const mergeP = askLedger
    ? fetchMergesForSessions(ctx.sessionLedger, askRefs, signal)
    : Promise.resolve(null);
  const handoffP = askHandoffs ? fetchHandoffs(ctx.sessionLedger, askRefs, signal) : Promise.resolve(null);
  const prP = askPrs
    ? fetchMergesForPrs(ctx.sessionLedger, coordinates.slice(0, PR_READS_MAX), signal)
    : Promise.resolve(null);

  // ── The second hop: the ghosts legs 3 and 4 found ─────────────────────────
  //
  // ONE hop, deliberately: a ghost's own handoff is not read, so a chain of
  // ghosts shows its first link only. Reading further would make the page open's
  // depth a property of the corpus.
  //
  // IT HANGS OFF LEGS 3 AND 4 ONLY. An earlier cut awaited one `Promise.all`
  // over all four legs, which put leg 1 — the huginn Jira corpus, which gives up
  // only at the SHARED deadline — on the hop's critical path: on a page with a
  // `jira:` key and a slow corpus the ghost legs started on an already-aborted
  // signal and reported `reachable: false` against a claude-usage that was never
  // asked. Measured at a 300 ms corpus: the hop fired at 302 ms. The two legs it
  // actually needs are the two it now waits for.
  const ghostStageP = (async () => {
    const [handoffLeg, prLeg] = await Promise.all([handoffP, prP]);
    const handoffs: ProvenanceHandoff[] = handoffLinks(handoffLeg?.ranBy ?? new Map());
    const candidates = ghostCandidates({
      stampedIds: askRefs,
      prMerges: prLeg?.merges ?? [],
      handoffs,
    });
    const ghostIds = candidates.map((c) => c.id);
    const askGhosts = ghostIds.length > 0 && ctx.sessionLedger.urlConfigured;
    const [ghostFacts, ghostMerges] = await Promise.all([
      askGhosts ? fetchSessionsById(ctx.sessionLedger, ghostIds, signal) : null,
      askGhosts ? fetchMergesForSessions(ctx.sessionLedger, ghostIds, signal) : null,
    ]);
    return { handoffs, candidates, ghostIds, ghostFacts, ghostMerges };
  })();

  const issuesP = baseRows.length ? resolveIssueRows(baseRows, trackers, ctx, signal) : Promise.resolve([]);

  const [resolved, mergeResult, handoffResult, prResult, ghostStage, issues] = await Promise.all([
    resolvedP,
    mergeP,
    handoffP,
    prP,
    ghostStageP,
    issuesP,
  ]);
  const { handoffs, candidates, ghostIds, ghostFacts, ghostMerges } = ghostStage;
  const standardizedDate =
    mergeResult?.rulesStandardizedDate ??
    prResult?.rulesStandardizedDate ??
    ghostMerges?.rulesStandardizedDate;

  // A ghost with no facts is an id-only row — no cost, no title, a neutral
  // glyph and no Stamp, because there is no provider to map into a ref.
  const ghosts = enrichSessions(
    ghostIds,
    ghostFacts ?? { facts: new Map(), unresolved: new Set(ghostIds) },
    ctx.publicUrl,
  ).map((chip, i) => ({
    ...chip,
    ghost: {
      via: candidates[i]!.via,
      through: candidates[i]!.through,
      stampRef: stampRefFor(chip),
    },
  }));

  return {
    ...resolved,
    ...(issues.length ? { issues } : {}),
    ghosts,
    handoffs,
    stampable: (ctx.stampable ?? defaultStampable)(wikiDir),
    prs: prRefs,
    // Three sources, one spine: the stamped sessions' merges, the `?prs=` rows
    // and the ghosts' own. Deduped, because a PR the page names AND the ghost
    // merged is reported by two of them.
    // ORDER IS THE PRECEDENCE RULE, and it is `?sessions=` before `?prs=`.
    // Both `mergeResult` and `ghostMerges` are `?sessions=` reads; `prResult` is
    // the `?prs=` one. The two forms can DISAGREE about the same merge (the
    // `?prs=` side prefers the confirmed `merge-cmd` row where `?sessions=` may
    // answer the `squash-composed` one), and the disagreement is visible: on a
    // fixture where the forms differ the gate verdict read `✓ review floor` from
    // one and `no gate line` from the other. With the `?prs=` rows in the
    // middle, stamping a ghost MOVED its merge from third place to first and
    // flipped the rendered verdict — the same page, two answers, because of
    // which list a session happened to be on. Both `?sessions=` lists now sit
    // ahead of `?prs=`, so a stamp cannot change which row wins.
    merges: dedupeMerges([
      ...(mergeResult?.merges ?? []),
      ...(ghostMerges?.merges ?? []),
      ...(prResult?.merges ?? []),
    ]),
    mergesLedger: mergeResult
      ? {
          asked: mergeResult.asked,
          reachable: mergeResult.reachable,
          partial: mergeResult.partial,
          truncated: mergeResult.truncated,
          ...(mergeResult.limit !== undefined ? { limit: mergeResult.limit } : {}),
          ...(mergeResult.errors ? { errors: mergeResult.errors } : {}),
        }
      : MERGES_NOT_ASKED,
    links: {
      handoffs: legState(handoffResult),
      prs: legState(prResult),
      ghostFacts: legState(ghostFacts),
      ghostMerges: legState(ghostMerges),
      handoffsCapped,
      prsCapped,
      // The shared deadline fired while a leg was still in flight. Read off the
      // signal AFTER the awaits rather than raced per leg: one deadline, one
      // answer about it.
      timedOut: signal?.aborted === true,
    },
    // Whichever leg answered first. The date is upstream's own constant and is
    // the same on every envelope; carrying it rather than restating it is what
    // keeps muninn from holding a second spelling of it. Read ONCE into
    // `standardizedDate` above — the chain used to be written out twice, once as
    // the condition and once as the value, which is two places for the leg order
    // to drift.
    ...(standardizedDate ? { rulesStandardizedDate: standardizedDate } : {}),
    ...(meta.sessionsBackfilled ? { backfilled: meta.sessionsBackfilled } : {}),
  };
}

/**
 * The network-joined half of a page's issue rows: the tracker lookup (title,
 * status, epic, last-updated) and the session ledger's price. Both under the
 * page's ONE deadline, and neither can fail the payload:
 *
 *  - a lookup that degrades leaves the rows bare (no `category`, no `known`),
 *    which renders no status and never offers Draft plan;
 *  - the ledger is asked for at most {@link ISSUE_LEDGER_MAX} counting keys,
 *    {@link ISSUE_LEDGER_CONCURRENCY} at a time, in the page's own order
 *    (strongest relation first); every other row says why it has no price.
 */
export async function resolveIssueRows(
  base: readonly IssueRow[],
  trackers: readonly TrackerConfig[],
  ctx: ProvenanceContext,
  signal?: AbortSignal,
): Promise<IssueRow[]> {
  const configOf = new Map(trackers.map((t) => [t.id, t]));
  const ids = [...new Set(base.map((r) => r.tracker))];
  const lookups = new Map(
    await Promise.all(
      ids.map(async (id) => {
        const adapter = trackerAdapter(id);
        const load = (async () => {
          if (!adapter) return null;
          try {
            if (ctx.lookupIssues) return await ctx.lookupIssues(adapter, ctx.knowledgeApiUrl);
            return adapter.lookup ? await adapter.lookup(ctx.knowledgeApiUrl) : null;
          } catch {
            return null;
          }
        })();
        const facts = signal ? await Promise.race([load, aborted(signal)]) : await load;
        return [id, facts] as const;
      }),
    ),
  );

  // Which rows are asked about, and why the others are not.
  const ledger: (IssueLedgerView | "ask")[] = [];
  let asked = 0;
  for (const row of base) {
    const config = configOf.get(row.tracker);
    const adapter = trackerAdapter(row.tracker);
    const project = row.key.slice(0, row.key.indexOf("-"));
    if (!relationsCount(row.relations)) ledger.push({ state: "unpriced", reason: "demoted" });
    else if (!config || !config.ledgerProjects.includes(project)) ledger.push({ state: "not-tracked" });
    else if (!ctx.sessionLedger.urlConfigured || !ctx.sessionLedger.fetchIssueLedger || !adapter?.ledgerPath) {
      ledger.push({ state: "unpriced", reason: "not-configured" });
    } else if (asked >= ISSUE_LEDGER_MAX) ledger.push({ state: "unpriced", reason: "cap" });
    else {
      ledger.push("ask");
      asked++;
    }
  }
  await mapPool(
    base.map((row, i) => ({ row, i })).filter(({ i }) => ledger[i] === "ask"),
    ISSUE_LEDGER_CONCURRENCY,
    async ({ row, i }) => {
      ledger[i] = await priceIssue(row, ctx, signal);
    },
  );

  return base.map((row, i) => {
    const config = configOf.get(row.tracker);
    const facts = lookups.get(row.tracker);
    const fact = facts?.get(row.key);
    const out: IssueRow = { ...row, ledger: ledger[i] as IssueLedgerView };
    if (facts && config) {
      out.known = !!fact;
      out.category = statusCategory(fact?.status, config);
      if (fact?.title) out.title = fact.title;
      if (fact?.status) out.status = fact.status;
      if (fact?.updated) out.updated = fact.updated;
      if (fact?.epicLink) {
        out.epic = { key: fact.epicLink, ...(fact.epicSummary ? { summary: fact.epicSummary } : {}) };
      }
    }
    return out;
  });
}

/** One key's `/api/jira`-shaped answer: `{sessions[], totalCost,
 *  costedSessions, truncated}`. Never throws. */
async function priceIssue(row: IssueRow, ctx: ProvenanceContext, signal?: AbortSignal): Promise<IssueLedgerView> {
  const path = trackerAdapter(row.tracker)?.ledgerPath?.(row.key);
  if (!path || !ctx.sessionLedger.fetchIssueLedger) return { state: "unpriced", reason: "not-configured" };
  if (signal?.aborted) return { state: "unpriced", reason: "deadline" };
  try {
    // Raced as well as handed the signal: a fetch that ignored it would
    // otherwise hold the whole page open.
    const fetched = ctx.sessionLedger.fetchIssueLedger(path, signal);
    const raw = (signal ? await Promise.race([fetched, aborted(signal)]) : await fetched) as {
      sessions?: unknown;
      totalCost?: unknown;
      costedSessions?: unknown;
      truncated?: unknown;
    } | null;
    if (raw === null && signal?.aborted) return { state: "unpriced", reason: "deadline" };
    if (!raw || !Array.isArray(raw.sessions)) return { state: "unpriced", reason: "unreachable" };
    const total = typeof raw.totalCost === "number" && Number.isFinite(raw.totalCost) ? raw.totalCost : 0;
    return {
      state: "priced",
      sessions: raw.sessions.length,
      totalCost: Math.round(total * 100) / 100,
      costedSessions: typeof raw.costedSessions === "number" ? raw.costedSessions : 0,
      truncated: raw.truncated === true,
    };
  } catch {
    return { state: "unpriced", reason: signal?.aborted ? "deadline" : "unreachable" };
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** `stampable` for a page in this wiki, through the context's seam — the same
 *  answer the payload gives, for a caller that renders before it lands. */
export function ctxStampable(ctx: ProvenanceContext, wikiDir: string | undefined): boolean {
  return (ctx.stampable ?? defaultStampable)(wikiDir);
}

/** The production `stampable` predicate: the env, both read-only guards, and the
 *  equality rule — see `stamp-roots.ts`. */
function defaultStampable(wikiDir: string | undefined): boolean {
  return !!wikiDir && stampableFor({ wikiDir, config: stampConfigFromEnv() });
}

/** `{asked, reachable}` for a leg, or the frozen unasked state for one that did
 *  not run. */
function legState(result: { asked: boolean; reachable: boolean } | null): ProvenanceLegState {
  return result ? { asked: result.asked, reachable: result.reachable } : LEG_NOT_ASKED;
}

/**
 * One row per merge across the three sources that can report it.
 *
 * Keyed on (session, PR number, instant, repo) rather than on the whole row:
 * the `?prs=` form prefers the confirmed `merge-cmd` row where `?sessions=` may
 * answer the `squash-composed` one, so two reports of one merge can differ in
 * `mergeOk` while naming the same event. First wins, and the caller's order —
 * both `?sessions=` lists ahead of the `?prs=` one — is the precedence rule.
 *
 * `repo` is in the key because without it two BARE merges (`prNumber` null,
 * `mergedAt` null) from different repositories share one key and the second
 * disappears — a merge the page made, in a repository the reader never sees
 * named.
 *
 * `JSON.stringify` rather than a template with a separator: the separator was a
 * literal NUL, which made this line invisible to `grep`/`rg` and the whole file
 * read as `data` to `file(1)`. Any printable separator can in principle occur
 * inside `repo` (a checkout path); the array form cannot be ambiguous and can be
 * read.
 */
function dedupeMerges(merges: readonly ProvenanceMerge[]): ProvenanceMerge[] {
  const seen = new Set<string>();
  const out: ProvenanceMerge[] = [];
  for (const merge of merges) {
    const key = JSON.stringify([merge.sessionId, merge.prNumber, merge.mergedAt, merge.repo]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(merge);
  }
  return out;
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
