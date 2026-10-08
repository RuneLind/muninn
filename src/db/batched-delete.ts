import type { Sql } from "postgres";
import { withStatementTimeout, type StatementTimeoutOption } from "./statement-timeout.ts";

/** Rows per DELETE statement. Measured 2026-10-08 on a local test DB, 250k
 *  `traces` rows with 1 KB attributes: ~10 ms per 5 000-row batch, ~50 ms per 10 000. */
export const RETENTION_DELETE_BATCH_SIZE = 5_000;
/** Batches per delete per run (1M rows). The rest is left to the next hourly
 *  run, so one run cannot keep a pooled connection busy indefinitely. */
export const RETENTION_DELETE_MAX_BATCHES = 200;

export interface BatchedDeleteOption extends StatementTimeoutOption {
  batchSize?: number;
  maxBatches?: number;
  /** Checked before every batch: true ends the run with what is deleted so far. */
  shouldStop?: () => boolean;
}

/** A batch failed. The batches before it are committed; `deleted` counts them. */
export class BatchedDeleteError extends Error {
  constructor(
    readonly deleted: number,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BatchedDeleteError";
  }
}

/**
 * Run `batch` (a DELETE of at most `limit` rows) until it deletes fewer than
 * `limit`, the batch cap is reached or `shouldStop` says so. Each batch is its
 * own statement and transaction under the statement timeout, so a backlog too
 * large for one timeout still converges: a batch that fails keeps the batches
 * before it. Returns the total deleted.
 */
export async function deleteInBatches(
  opts: BatchedDeleteOption,
  batch: (sql: Sql, limit: number) => Promise<{ count: number }>,
): Promise<number> {
  const limit = opts.batchSize ?? RETENTION_DELETE_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? RETENTION_DELETE_MAX_BATCHES;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`deleteInBatches: batchSize must be a positive integer, got ${limit}`);
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new RangeError(`deleteInBatches: maxBatches must be a positive integer, got ${maxBatches}`);
  }
  let deleted = 0;
  for (let n = 0; n < maxBatches; n++) {
    if (opts.shouldStop?.()) break;
    let count: number;
    try {
      ({ count } = await withStatementTimeout(opts, (sql) => batch(sql, limit)));
    } catch (err) {
      throw new BatchedDeleteError(deleted, err);
    }
    deleted += count;
    if (count < limit) break;
  }
  return deleted;
}
