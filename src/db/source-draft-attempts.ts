import { getDb } from "./client.ts";
import { getLog } from "../logging.ts";

const log = getLog("db", "source-draft-attempts");

/**
 * The source drafter's attempt ledger — the answer to "why does this captured doc
 * still have no wiki page?".
 *
 * Three of the drafter's four outcomes (`covered`/`skipped`/`error`) persist
 * NOTHING: no `wiki_proposals` row, no gate entry, and the doc reappears in the
 * /wiki/gardener backlog looking exactly like one the drafter never ran on. Before
 * this table the reason lived only in a log line. One row per (bot, collection,
 * doc), LATEST attempt wins — a diagnosis surface, not an audit log, so it stays
 * bounded by the corpus and needs no pruning job.
 *
 * Every write is best-effort: recording a diagnosis must never fail the draft it
 * describes (the auto-trigger rides behind a capture job), so failures log and
 * return rather than throw.
 */

/** Mirrors `SourceDraftOutcome`'s discriminant. */
export type SourceDraftAttemptOutcome = "drafted" | "covered" | "skipped" | "error";

/** Which entry point ran the drafter — the four callers of `runSourceDraftForInput`. */
export type SourceDraftTrigger = "capture" | "run-now" | "backlog" | "doc";

export interface SourceDraftAttempt {
  collection: string;
  docId: string;
  outcome: SourceDraftAttemptOutcome;
  /** A skip that BURNED model calls, as opposed to a cheap deterministic guard. */
  degraded: boolean;
  reason: string | null;
  /** The title the drafter chose, or (on a collision) the page that owns the stem. */
  title: string | null;
  /** Wiki-relative path of the existing page that blocked this draft, when known. */
  collidingPath: string | null;
  /** The `wiki_proposals` row on a `drafted` outcome. */
  proposalId: string | null;
  trigger: SourceDraftTrigger;
  attemptedAt: number;
}

export interface RecordSourceDraftAttemptParams extends Omit<SourceDraftAttempt, "attemptedAt"> {
  botName: string;
}

/**
 * Upsert one attempt (latest wins). Never throws — a ledger write failing must not
 * turn a successful draft into a failed one, nor a diagnosed skip into an unlogged
 * crash. `attempted_at` is refreshed on conflict so the row always describes the
 * MOST RECENT run, including a retry that produced the same outcome.
 */
export async function recordSourceDraftAttempt(
  params: RecordSourceDraftAttemptParams,
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO source_draft_attempts
        (bot_name, collection, doc_id, outcome, degraded, reason, title, colliding_path,
         proposal_id, trigger_source, attempted_at)
      VALUES (${params.botName}, ${params.collection}, ${params.docId}, ${params.outcome},
              ${params.degraded}, ${params.reason}, ${params.title}, ${params.collidingPath},
              ${params.proposalId}, ${params.trigger}, now())
      ON CONFLICT (bot_name, collection, doc_id) DO UPDATE SET
        outcome        = EXCLUDED.outcome,
        degraded       = EXCLUDED.degraded,
        reason         = EXCLUDED.reason,
        title          = EXCLUDED.title,
        colliding_path = EXCLUDED.colliding_path,
        proposal_id    = EXCLUDED.proposal_id,
        trigger_source = EXCLUDED.trigger_source,
        attempted_at   = now()
    `;
  } catch (err) {
    log.warn("Failed to record source-draft attempt for {collection}/{id}: {error}", {
      collection: params.collection,
      id: params.docId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Every recorded attempt for one bot, keyed `<collection>/<docId>` — the shape the
 * backlog route joins onto its doc rows. Degrades to an EMPTY map (never throws):
 * a missing migration or an unreachable DB must leave the backlog rendering exactly
 * as it did before this feature, not 500 the whole strip.
 */
export async function getSourceDraftAttempts(
  botName: string,
): Promise<Map<string, SourceDraftAttempt>> {
  const byKey = new Map<string, SourceDraftAttempt>();
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT collection, doc_id, outcome, degraded, reason, title, colliding_path,
             proposal_id, trigger_source, attempted_at
        FROM source_draft_attempts
       WHERE bot_name = ${botName}
    `;
    for (const row of rows) {
      const collection = row.collection as string;
      const docId = row.doc_id as string;
      byKey.set(`${collection}/${docId}`, {
        collection,
        docId,
        outcome: row.outcome as SourceDraftAttemptOutcome,
        degraded: row.degraded === true,
        reason: (row.reason as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        collidingPath: (row.colliding_path as string | null) ?? null,
        proposalId: (row.proposal_id as string | null) ?? null,
        trigger: row.trigger_source as SourceDraftTrigger,
        attemptedAt: new Date(row.attempted_at as string | Date).getTime(),
      });
    }
  } catch (err) {
    log.warn("Failed to read source-draft attempts for {bot}: {error}", {
      bot: botName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return byKey;
}
