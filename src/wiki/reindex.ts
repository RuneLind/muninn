/**
 * Wiki manual-reindex response assembly (pure / injectable).
 *
 * Wiki search collections are rebuilt nightly by huginn-side launchd jobs; muninn
 * also fires a reindex after a gardener approve. This module backs a MANUAL
 * trigger from the reader's Index card, fanning a bounded set of a wiki's backing
 * collections out to huginn's per-collection update seam and proxying its status.
 *
 * Huginn contract (verified):
 *  - `POST /api/collections/{name}/update` is CAS-guarded — **409** when a rebuild
 *    is already in flight (e.g. the nightly job). That is an HONEST state, NOT a
 *    failure: we map it to `already-running`, not `error`.
 *  - `GET /api/collections/{name}/update-status` → `{status, error?}` where status
 *    is `idle` | `running` | `succeeded` | `failed`.
 *
 * There is deliberately NO muninn-side mutex or run state — huginn's CAS is the
 * single serialization point. The route implements the HTTP posters/getters that
 * feed the injectable functions below; this module is pure over them so the 409
 * mapping, the unreachable→error entries, and the multi-collection fan-out shape
 * are unit-testable without a live huginn. Mirrors `buildIndexCoverageResponse`.
 */

/** Per-collection POST outcome, normalized from huginn's HTTP layer. */
export type PostOutcome =
  | { kind: "ok" }
  /** huginn 409 — a rebuild (nightly job or a prior trigger) is already in flight. */
  | { kind: "conflict" }
  | { kind: "error"; error: string };

/** State of a single collection's reindex trigger, as reported to the client. */
export type ReindexState = "started" | "already-running" | "error";

export interface ReindexCollectionResult {
  name: string;
  state: ReindexState;
  /** Present only for `state: "error"` — huginn's error / unreachable text. */
  error?: string;
}

export interface ReindexResponse {
  collections: ReindexCollectionResult[];
}

/** Per-collection `/update-status` outcome, normalized from huginn's HTTP layer. */
export type StatusOutcome =
  | { kind: "ok"; status: "idle" | "running" | "succeeded" | "failed"; error?: string }
  | { kind: "error"; error: string };

/** A status fetch that failed yields `unknown` (union extended past huginn's set). */
export type ReindexStatusValue = "idle" | "running" | "succeeded" | "failed" | "unknown";

export interface ReindexStatusCollectionResult {
  name: string;
  status: ReindexStatusValue;
  /** huginn's `failed` error text, or the fetch failure for an `unknown` entry. */
  error?: string;
}

export interface ReindexStatusResponse {
  collections: ReindexStatusCollectionResult[];
}

/** Map a POST outcome to its client-facing state. 409 ⇒ `already-running` (honest,
 *  not a failure); any other error ⇒ `error`. */
export function reindexStateFromOutcome(outcome: PostOutcome): ReindexState {
  if (outcome.kind === "ok") return "started";
  if (outcome.kind === "conflict") return "already-running";
  return "error";
}

/** Map a `/update-status` outcome to its client-facing entry. A failed status
 *  fetch degrades to `unknown` + the fetch error (never throws, never 5xx). */
export function statusResultFromOutcome(
  name: string,
  outcome: StatusOutcome,
): ReindexStatusCollectionResult {
  if (outcome.kind === "ok") {
    return outcome.error
      ? { name, status: outcome.status, error: outcome.error }
      : { name, status: outcome.status };
  }
  return { name, status: "unknown", error: outcome.error };
}

/**
 * Fan an injectable per-collection POST over a wiki's collections and assemble the
 * response. Sequential (never fan unbounded concurrency at huginn's Python server)
 * and total — every collection contributes exactly one entry, errors included.
 */
export async function buildReindexResponse(
  collections: string[],
  post: (collection: string) => Promise<PostOutcome>,
): Promise<ReindexResponse> {
  const results: ReindexCollectionResult[] = [];
  for (const name of collections) {
    const outcome = await post(name);
    const state = reindexStateFromOutcome(outcome);
    if (state === "error") {
      results.push({ name, state, error: outcome.kind === "error" ? outcome.error : undefined });
    } else {
      results.push({ name, state });
    }
  }
  return { collections: results };
}

/**
 * Fan an injectable per-collection status fetch over a wiki's collections and
 * assemble the status response. Sequential + total, same contract as above; a
 * failed fetch surfaces as an `unknown` entry rather than aborting the proxy.
 */
export async function buildReindexStatusResponse(
  collections: string[],
  getStatus: (collection: string) => Promise<StatusOutcome>,
): Promise<ReindexStatusResponse> {
  const results: ReindexStatusCollectionResult[] = [];
  for (const name of collections) {
    const outcome = await getStatus(name);
    results.push(statusResultFromOutcome(name, outcome));
  }
  return { collections: results };
}
