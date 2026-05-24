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
  /** Phase 6b — number of autonomous re-engage-on-red attempts spent on this run.
   *  Capped by claimForReengage at MAX_REENGAGE_ATTEMPTS. */
  reengageCount: number;
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

/**
 * One interim progress note a peer emitted WHILE working (Phase A). Append-only,
 * strictly non-terminal — recording an event NEVER recomputes run status, touches
 * the green gate, or reopens a terminal run. Drives the inspector Agents tab's
 * live discoveries timeline (and the guarded sent → working handoff bump).
 */
export interface DevRunEvent {
  id: string;
  runId: string;
  /** cwd-basename, same derivation as the handoff's peer_name. */
  peerName: string;
  /** build|test|orchestrate|review — best-effort from the matching handoff (may be undefined). */
  role?: string;
  /** discovery|decision|blocker|milestone. */
  kind: string;
  text: string;
  createdAt: number;
}

export type DevRunEventKind = "discovery" | "decision" | "blocker" | "milestone";

/** Per-run display cap on dev_run_events — the timeline keeps the last 100 to
 *  bound a chatty peer. Inserts stay append-only; only the read is capped. */
export const DEV_RUN_EVENTS_DISPLAY_CAP = 100;

/** Max length of a note's text (reply body minus marker). Metadata rides in the
 *  marker; the body is human text, same shape as the terminal markers. */
export const DEV_RUN_EVENT_TEXT_CAP = 500;

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
    reengageCount: Number(r.reengage_count ?? 0),
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

function rowToDevRunEvent(r: Record<string, unknown>): DevRunEvent {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    peerName: r.peer_name as string,
    role: (r.role as string) ?? undefined,
    kind: r.kind as string,
    text: r.text as string,
    createdAt: new Date(r.created_at as string).getTime(),
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
 * Atomic compare-and-swap claim for the v2 auto-orchestrate fire (Phase 6a).
 * Flips a run `ready_to_verify → verifying` only if it is *currently*
 * `ready_to_verify`, returning the updated row to the single winner. Concurrent
 * inbound-interpreter invocations (a build-done + a test-done marker arriving
 * together) race here; the loser gets null and must NOT fire a second
 * orchestrate turn. Returns null if the run is missing or already past the gate.
 */
export async function claimForVerify(runId: string): Promise<DevRun | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE dev_runs SET status = 'verifying', updated_at = now()
    WHERE id = ${runId} AND status = 'ready_to_verify'
    RETURNING *
  `;
  return row ? rowToDevRun(row) : null;
}

/**
 * Resolve the open run for an origin thread — the operative join for
 * delegate_task (later phase), since chat-started research has a synthetic
 * issue_key the model can't reproduce but the thread_id is always in hand.
 */
/**
 * Cap on autonomous re-engage-on-red attempts per run (Phase 6b). A red run is
 * re-opened and the build agent re-engaged from code; after this many attempts a
 * still-red run parks at `red` (the user takes over). ~2 keeps a genuine
 * build-fix loop short while not burning the user's patience (or CI minutes) on
 * a failure auto-re-engage can't fix — e.g. a test-spec drift the build-first
 * cut doesn't target (the build-vs-test classifier is the follow-up).
 */
export const MAX_REENGAGE_ATTEMPTS = 2;

/**
 * Atomic compare-and-swap claim for the v2 re-engage-on-red fire (Phase 6b).
 * Increments `reengage_count` and re-opens the run `red → building` only if it is
 * *currently* `red` AND still under the cap, returning the updated row to the
 * single winner. Two jobs in one statement:
 *   - **once-per-red:** the `status = 'red'` guard means a duplicate/flapping red
 *     marker (or two interpreter invocations racing) can't double-claim — after
 *     the first claim the run is `building`, not `red`, so the CAS misses.
 *   - **termination:** `reengage_count < maxAttempts` is the loop cap. When the
 *     cap is reached the CAS returns null and the run stays `red` (the caller
 *     surfaces an "exhausted — needs you" affordance).
 * Re-opening to `building` is what lets the re-engaged build agent's reply flow
 * back through the interpreter (the terminal guard ignores replies on a `red`
 * run); the caller then clears the stale orchestrate handoff so the run can roll
 * back up to `ready_to_verify` after the fix.
 */
export async function claimForReengage(
  runId: string,
  maxAttempts: number = MAX_REENGAGE_ATTEMPTS,
): Promise<DevRun | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE dev_runs
    SET reengage_count = reengage_count + 1, status = 'building', updated_at = now()
    WHERE id = ${runId} AND status = 'red' AND reengage_count < ${maxAttempts}
    RETURNING *
  `;
  return row ? rowToDevRun(row) : null;
}

/**
 * Delete a run's orchestrate handoffs (Phase 6b re-engage reset). On a red
 * re-engage the failed cross-repo e2e is abandoned: with the orchestrate handoff
 * gone, once the re-engaged build reports done the run rolls back up to
 * `ready_to_verify` (computeRunStatus sees build∧test done, no orchestrate) so a
 * FRESH e2e re-runs — instead of staying `red` forever pinned by the old failed
 * orchestrate row. Build/test/review rows are left intact (the build agent is
 * re-delegated; its reply rolls up the existing build row(s) by peer_name).
 * Returns the number of rows deleted.
 */
export async function clearOrchestrateHandoffs(runId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM dev_run_handoffs WHERE run_id = ${runId} AND role = 'orchestrate' RETURNING id
  `;
  return rows.length;
}

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

/**
 * Persist a recomputed run status, but **never downgrade a run that has already
 * moved past the verify gate** (Phase 6a). A late or duplicate build|test marker
 * recomputes `ready_to_verify` from the still-`done` handoffs; if auto-orchestrate
 * has already claimed the run (`verifying`) or it finished (`green`/`red`), that
 * recompute must NOT reopen the gate — it would re-fire orchestrate. Only the
 * `ready_to_verify` write is guarded (a conditional UPDATE); every other
 * transition persists normally, so v1's flow is unchanged (a `building → ready_to_verify`
 * first-arrival still lands). Returns the resulting run (the blocked case returns
 * the unchanged current row).
 */
export async function persistRunStatus(runId: string, status: string): Promise<DevRun | null> {
  if (status === "ready_to_verify") {
    const sql = getDb();
    const [row] = await sql`
      UPDATE dev_runs SET status = ${status}, updated_at = now()
      WHERE id = ${runId} AND status NOT IN ('verifying', 'green', 'red')
      RETURNING *
    `;
    return row ? rowToDevRun(row) : getDevRunById(runId);
  }
  return updateDevRun(runId, { status });
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

/**
 * Advance a research thread's dev_run `research_stage` (Phase 5). The chat drives
 * which research affordances to show off run state (research_stage + status)
 * instead of a positional client-side reply counter, so the analysis-phase prompt
 * markers (Investigate / Deep) write the stage here. Resolves the open run by
 * thread; returns null (no throw) when none exists — a stage write must never
 * block the chat turn.
 */
export async function setResearchStageByThread(
  threadId: string,
  stage: string,
): Promise<DevRun | null> {
  const run = await getDevRunByThreadId(threadId);
  if (!run) return null;
  return updateDevRun(run.id, { researchStage: stage });
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

/**
 * Append a non-terminal progress note to a run's timeline (Phase A). Append-only:
 * this NEVER recomputes run status, touches the green gate, or reopens a terminal
 * run — the interpreter's terminal-first parse + terminal-run bail decide whether
 * to even call this. text is capped defensively to DEV_RUN_EVENT_TEXT_CAP (the
 * interpreter caps it too). role is best-effort from the matching handoff.
 */
export async function insertDevRunEvent(input: {
  runId: string;
  peerName: string;
  kind: string;
  text: string;
  role?: string;
}): Promise<DevRunEvent> {
  const sql = getDb();
  const text = input.text.slice(0, DEV_RUN_EVENT_TEXT_CAP);
  const [row] = await sql`
    INSERT INTO dev_run_events (run_id, peer_name, role, kind, text)
    VALUES (${input.runId}, ${input.peerName}, ${input.role ?? null}, ${input.kind}, ${text})
    RETURNING *
  `;
  return rowToDevRunEvent(row!);
}

/**
 * The run's progress notes, chronological (oldest first) so the client can append
 * live events to the tail and reverse for a newest-first timeline. Bounded to the
 * last `limit` (default DEV_RUN_EVENTS_DISPLAY_CAP) — newest kept, then re-ordered
 * ascending — so a chatty peer can't blow up the hydration payload.
 */
export async function listDevRunEvents(
  runId: string,
  limit: number = DEV_RUN_EVENTS_DISPLAY_CAP,
): Promise<DevRunEvent[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM (
      SELECT * FROM dev_run_events WHERE run_id = ${runId}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}
    ) sub ORDER BY created_at ASC, id ASC
  `;
  return rows.map(rowToDevRunEvent);
}

/**
 * Guarded sent → working bump for a handoff (Phase A). The verified loop never set
 * `working` — handoffs went sent → done/failed directly. The FIRST progress note
 * from a peer flips its handoff to `working` so the agent reads as live. Strictly
 * `status = 'sent'` only: it NEVER downgrades a done/failed handoff, and is a
 * no-op once already working (or on a (run, peer_name) join miss). Returns the
 * number of rows updated (0 = nothing to bump, the common steady-state case).
 */
export async function markHandoffWorking(runId: string, peerName: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    UPDATE dev_run_handoffs SET status = 'working', updated_at = now()
    WHERE run_id = ${runId} AND peer_name = ${peerName} AND status = 'sent'
    RETURNING id
  `;
  return rows.length;
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
