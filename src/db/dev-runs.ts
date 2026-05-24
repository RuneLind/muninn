import { getDb } from "./client.ts";

/**
 * Spec-driven dev loop — `dev_runs` (run aggregate) + `dev_run_handoffs`
 * (per-peer handoff rows). The run is born at research-thread creation and
 * spans analysis → spec → build+test → verify. `status` is a DERIVED rollup
 * (see computeRunStatus); the handoff rows are the source of truth.
 */

export interface DevRun {
  id: string;
  botName: string;
  userId: string;
  threadId?: string;
  issueKey: string;
  analysisTraceId?: string;
  specPath?: string;
  e2eSpecPath?: string;
  workplanPath?: string;
  status: string;
  researchStage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DevRunHandoff {
  id: string;
  runId: string;
  peerName: string;
  peerId?: string;
  role: string;
  correlationToken?: string;
  status: string;
  lastMessage?: string;
  createdAt: number;
  updatedAt: number;
}

function rowToDevRun(r: Record<string, unknown>): DevRun {
  return {
    id: r.id as string,
    botName: r.bot_name as string,
    userId: r.user_id as string,
    threadId: (r.thread_id as string) ?? undefined,
    issueKey: r.issue_key as string,
    analysisTraceId: (r.analysis_trace_id as string) ?? undefined,
    specPath: (r.spec_path as string) ?? undefined,
    e2eSpecPath: (r.e2e_spec_path as string) ?? undefined,
    workplanPath: (r.workplan_path as string) ?? undefined,
    status: r.status as string,
    researchStage: (r.research_stage as string) ?? undefined,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
  };
}

function rowToHandoff(r: Record<string, unknown>): DevRunHandoff {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    peerName: r.peer_name as string,
    peerId: (r.peer_id as string) ?? undefined,
    role: r.role as string,
    correlationToken: (r.correlation_token as string) ?? undefined,
    status: r.status as string,
    lastMessage: (r.last_message as string) ?? undefined,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
  };
}

/**
 * Birth (or refresh) the dev_run for a research thread. One row per
 * (bot_name, user_id, issue_key); re-running a research overwrites it like the
 * report file does — repoints it at the new thread and resets to 'analyzing'.
 */
export async function birthDevRun(input: {
  botName: string;
  userId: string;
  issueKey: string;
  threadId?: string;
  analysisTraceId?: string;
}): Promise<DevRun> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO dev_runs (bot_name, user_id, issue_key, thread_id, analysis_trace_id, status, research_stage)
    VALUES (
      ${input.botName}, ${input.userId}, ${input.issueKey},
      ${input.threadId ?? null}, ${input.analysisTraceId ?? null}, 'analyzing', 'analysis'
    )
    ON CONFLICT (bot_name, user_id, issue_key) DO UPDATE SET
      thread_id = COALESCE(EXCLUDED.thread_id, dev_runs.thread_id),
      analysis_trace_id = COALESCE(EXCLUDED.analysis_trace_id, dev_runs.analysis_trace_id),
      status = 'analyzing',
      research_stage = 'analysis',
      updated_at = now()
    RETURNING *
  `;
  return rowToDevRun(row!);
}

export async function getDevRunById(id: string): Promise<DevRun | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM dev_runs WHERE id = ${id}`;
  return row ? rowToDevRun(row) : null;
}

/**
 * Resolve the open run for an origin thread — the operative join for
 * delegate_task (later phase), since chat-started research has a synthetic
 * issue_key the model can't reproduce but the thread_id is always in hand.
 */
export async function getDevRunByThreadId(threadId: string): Promise<DevRun | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT * FROM dev_runs WHERE thread_id = ${threadId} ORDER BY updated_at DESC LIMIT 1
  `;
  return row ? rowToDevRun(row) : null;
}

export async function getDevRunByIdentity(
  botName: string,
  userId: string,
  issueKey: string,
): Promise<DevRun | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT * FROM dev_runs WHERE bot_name = ${botName} AND user_id = ${userId} AND issue_key = ${issueKey}
  `;
  return row ? rowToDevRun(row) : null;
}

/** Run statuses that are terminal — the loop is finished, don't reopen them. */
export const TERMINAL_RUN_STATUSES = new Set(["green", "red"]);

/**
 * Resolve dev_runs whose uuid starts with an 8-hex prefix — the in-marker
 * `run:<id>` a peer echoes (Phase 4 inbound interpreter). 8 hex is only 32 bits,
 * so the prefix is NOT collision-proof: this can return >1 row and the caller
 * MUST disambiguate (the routed thread, or the most-recently-updated open run).
 * Ordered most-recently-updated first so the caller's "newest open run" fallback
 * is just `find(open)`. `prefix` must be hex (the marker regex guarantees it);
 * non-hex input returns [] rather than risk a LIKE wildcard.
 */
export async function getDevRunsByIdPrefix(prefix: string): Promise<DevRun[]> {
  if (!/^[0-9a-f]+$/i.test(prefix)) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM dev_runs WHERE id::text LIKE ${prefix.toLowerCase() + "%"} ORDER BY updated_at DESC
  `;
  return rows.map(rowToDevRun);
}

export async function updateDevRun(
  id: string,
  fields: {
    threadId?: string;
    analysisTraceId?: string;
    specPath?: string;
    e2eSpecPath?: string;
    workplanPath?: string;
    status?: string;
    researchStage?: string;
  },
): Promise<DevRun | null> {
  const sql = getDb();
  const set: Record<string, unknown> = {};
  if (fields.threadId !== undefined) set.thread_id = fields.threadId;
  if (fields.analysisTraceId !== undefined) set.analysis_trace_id = fields.analysisTraceId;
  if (fields.specPath !== undefined) set.spec_path = fields.specPath;
  if (fields.e2eSpecPath !== undefined) set.e2e_spec_path = fields.e2eSpecPath;
  if (fields.workplanPath !== undefined) set.workplan_path = fields.workplanPath;
  if (fields.status !== undefined) set.status = fields.status;
  if (fields.researchStage !== undefined) set.research_stage = fields.researchStage;
  if (Object.keys(set).length === 0) return getDevRunById(id);
  const [row] = await sql`
    UPDATE dev_runs SET ${sql(set)}, updated_at = now() WHERE id = ${id} RETURNING *
  `;
  return row ? rowToDevRun(row) : null;
}

/**
 * Link a saved domain spec to its dev_run (Phase 1, Save Spec / approval gate).
 * Resolves the run by identity — the spec save endpoint only knows
 * (bot, user, issueKey), which is the same key the run was born with. Returns
 * null (no throw) when no run matches, so the spec save stays best-effort:
 * a spec can be saved even if the run row went missing.
 */
export async function linkSpecToDevRun(input: {
  botName: string;
  userId: string;
  issueKey: string;
  specPath: string;
  status: string;
}): Promise<DevRun | null> {
  const run = await getDevRunByIdentity(input.botName, input.userId, input.issueKey);
  if (!run) return null;
  // Don't regress an already-approved spec back to draft. The persistent "Save
  // Spec" button always posts spec_draft, so a click after the fagperson gate's
  // Approve would otherwise silently un-approve the run. The spec_path is still
  // refreshed either way.
  const status =
    run.status === "spec_approved" && input.status === "spec_draft" ? run.status : input.status;
  return updateDevRun(run.id, { specPath: input.specPath, status });
}

/** Insert a handoff row for a fan-out send. */
export async function insertHandoff(input: {
  runId: string;
  peerName: string;
  role: string;
  peerId?: string;
  correlationToken?: string;
  status?: string;
}): Promise<DevRunHandoff> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO dev_run_handoffs (run_id, peer_name, role, peer_id, correlation_token, status)
    VALUES (
      ${input.runId}, ${input.peerName}, ${input.role},
      ${input.peerId ?? null}, ${input.correlationToken ?? null}, ${input.status ?? "sent"}
    )
    RETURNING *
  `;
  return rowToHandoff(row!);
}

/**
 * Update a handoff's status from a peer reply. Joins on (run_id, peer_name) —
 * the in-marker run:<id> gives run_id exactly, peer_name picks the role's row.
 * Returns the number of rows updated.
 */
export async function updateHandoffStatus(input: {
  runId: string;
  peerName: string;
  status: string;
  lastMessage?: string;
}): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    UPDATE dev_run_handoffs
    SET status = ${input.status},
        last_message = COALESCE(${input.lastMessage ?? null}, last_message),
        updated_at = now()
    WHERE run_id = ${input.runId} AND peer_name = ${input.peerName}
    RETURNING id
  `;
  return rows.length;
}

export async function listHandoffs(runId: string): Promise<DevRunHandoff[]> {
  const sql = getDb();
  const rows = await sql`SELECT * FROM dev_run_handoffs WHERE run_id = ${runId} ORDER BY created_at`;
  return rows.map(rowToHandoff);
}

/** Handoff statuses that are still awaiting a terminal marker from the peer. */
export const PENDING_HANDOFF_STATUSES = ["sent", "working"] as const;

/**
 * A handoff is stale once it sits in a non-terminal status past this threshold —
 * the peer accepted the task then died or never emitted its terminal marker, so
 * the run would otherwise park forever (the 7-day TTL is on correlation tokens,
 * NOT on handoffs). 6h is long enough to cover a slow build/test/orchestrate run
 * but short enough to surface a dead peer the same working day.
 */
export const STALE_HANDOFF_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Stale handoffs across all non-terminal runs — pending (`sent`/`working`) rows
 * whose `updated_at` is older than `thresholdMs`, joined to their run so the
 * caller can surface a manual re-send / pick-another-peer affordance (Phase 5
 * UI). Detection lives here; the periodic sweep + re-send button are Phase 5.
 */
export async function listStaleHandoffs(
  thresholdMs: number = STALE_HANDOFF_THRESHOLD_MS,
): Promise<Array<{ run: DevRun; handoff: DevRunHandoff }>> {
  const sql = getDb();
  const cutoff = new Date(Date.now() - thresholdMs);
  const rows = await sql`
    SELECT h.*, row_to_json(r) AS run
    FROM dev_run_handoffs h
    JOIN dev_runs r ON r.id = h.run_id
    WHERE h.status IN ${sql(PENDING_HANDOFF_STATUSES)}
      AND h.updated_at < ${cutoff}
      AND r.status NOT IN ${sql([...TERMINAL_RUN_STATUSES])}
    ORDER BY h.updated_at
  `;
  return rows.map((r) => ({
    handoff: rowToHandoff(r),
    run: rowToDevRun(r.run as Record<string, unknown>),
  }));
}

/**
 * Derived rollup of a run's status from its handoff rows. building/testing are
 * concurrent, so this summarises them to a single label. The green gate is an
 * AND-of-roles: green only when build done ∧ test done ∧ orchestrate done
 * (review is NOT in the gate). Phase 4 refines the orchestrate verdict to the
 * CI-confirmed conclusion before the spec is flipped to `verified`.
 */
export async function computeRunStatus(runId: string): Promise<string> {
  const run = await getDevRunById(runId);
  if (!run) throw new Error(`dev_run ${runId} not found`);
  const handoffs = await listHandoffs(runId);
  if (handoffs.length === 0) return run.status; // pre-handoff: analyzing / spec_draft / spec_approved

  const ofRole = (role: string) => handoffs.filter((h) => h.role === role);
  const roleDone = (role: string) => {
    const rs = ofRole(role);
    return rs.length > 0 && rs.every((h) => h.status === "done");
  };
  const roleFailed = (role: string) => ofRole(role).some((h) => h.status === "failed");

  const buildDone = roleDone("build");
  const testDone = roleDone("test");
  const orch = ofRole("orchestrate");

  if (orch.length > 0) {
    if (orch.some((h) => h.status === "failed")) return "red";
    if (orch.every((h) => h.status === "done") && buildDone && testDone) return "green";
    return "verifying";
  }
  if (roleFailed("build") || roleFailed("test")) return "red";
  if (buildDone && testDone) return "ready_to_verify";
  return "building";
}
