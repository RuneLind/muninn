/**
 * `/models` runtime-chip merge — pure, DOM/DB-free matching of live agent runs
 * onto the page's pipeline-job rows (PR 4). The `/models` page client-fetches
 * BOTH `/api/models/overview` (the pipeline rows) and `/api/agents/overview`
 * (the live runtime), then merges them here per row:
 *   - `runningNow` — a matching non-completed run exists (pulsing chip),
 *   - `nextRunAt`  — the earliest matching `upNext` fire (`next: <time>` chip),
 *   - `lastDurationMs` — the newest matching finished run's duration.
 *
 * A row is matched by its additive `matchKind` (+`matchBot`/`matchName`) hints
 * from `models-overview.ts` — no brittle `job`-string parsing. Rows without a
 * `matchKind` never match (they map to no trackable AgentKind).
 *
 * Presentational only — it reads the two overview payloads, changes neither.
 * The client JS in `models-page.ts` is a hand-mirror of {@link
 * mergePipelineRuntime}; keep the two in sync (like the `agent-eta` mirror).
 */

import type { AgentKind } from "../observability/agent-status.ts";

/** The pipeline-row fields the merge reads (subset of `PipelineEntry`). */
export interface RuntimeMatchable {
  matchKind?: AgentKind;
  matchBot?: string;
  matchName?: string;
  /** Alternate name accepted alongside `matchName`. Watcher rows set this to the
   *  watcher TYPE: trace-sourced `recent[]` watcher entries are named by type
   *  (`watcher:<type>` spans), while running/upNext carry the display name —
   *  without this bridge the "last <dur>" chip never matches a watcher row. */
  matchRecentName?: string;
}

/** Live run (subset of `AgentRun`). */
export interface RuntimeRun {
  kind?: AgentKind;
  botName?: string;
  name?: string;
  completed?: boolean;
}

/** Up-next entry (subset of `UpNextEntry`). */
export interface RuntimeUpNext {
  kind: AgentKind;
  bot: string;
  name: string;
  nextRunAt: number;
}

/** Finished run (subset of `RecentEntry`). */
export interface RuntimeRecent {
  kind: AgentKind;
  bot: string | null;
  name: string;
  finishedAt: number;
  durationMs?: number;
}

export interface RuntimeAgents {
  running: RuntimeRun[];
  upNext: RuntimeUpNext[];
  recent: RuntimeRecent[];
}

export interface RowRuntime {
  runningNow: boolean;
  nextRunAt?: number;
  lastDurationMs?: number;
}

/** True when the row's hints match a candidate's kind/bot/name. `matchName` is
 *  only enforced when the row carries one (watcher rows do; others match on
 *  kind+bot). Bot is enforced when the row carries one. */
function rowMatches(
  row: RuntimeMatchable,
  kind: AgentKind | undefined,
  bot: string | null | undefined,
  name: string | undefined,
): boolean {
  if (!row.matchKind) return false;
  if ((kind ?? "chat") !== row.matchKind) return false;
  if (row.matchBot != null && (bot ?? "") !== row.matchBot) return false;
  if (row.matchName != null) {
    const n = name ?? "";
    if (n !== row.matchName && (row.matchRecentName == null || n !== row.matchRecentName)) return false;
  }
  return true;
}

/** Runtime state for one pipeline row. */
export function computeRowRuntime(row: RuntimeMatchable, agents: RuntimeAgents): RowRuntime {
  const out: RowRuntime = { runningNow: false };
  if (!row.matchKind) return out;

  out.runningNow = agents.running.some(
    (r) => !r.completed && rowMatches(row, r.kind, r.botName, r.name),
  );

  let earliest: number | undefined;
  for (const u of agents.upNext) {
    if (rowMatches(row, u.kind, u.bot, u.name) && (earliest == null || u.nextRunAt < earliest)) {
      earliest = u.nextRunAt;
    }
  }
  if (earliest != null) out.nextRunAt = earliest;

  let newest: RuntimeRecent | undefined;
  for (const rec of agents.recent) {
    if (rec.durationMs == null) continue;
    if (rowMatches(row, rec.kind, rec.bot, rec.name) && (newest == null || rec.finishedAt > newest.finishedAt)) {
      newest = rec;
    }
  }
  if (newest?.durationMs != null) out.lastDurationMs = newest.durationMs;

  return out;
}

/** Merge runtime state onto every pipeline row (index-aligned output). */
export function mergePipelineRuntime(
  rows: RuntimeMatchable[],
  agents: RuntimeAgents,
): RowRuntime[] {
  return rows.map((row) => computeRowRuntime(row, agents));
}
