/**
 * Home "Attention" assembler — the "what needs you" surface on the dashboard
 * home page (`GET /api/attention`). Mirrors the injectable-assembler pattern of
 * `assembleAgentsOverview` / `assembleIndexingOverview` / `assembleModelsOverview`:
 * pure over its injected deps (the route wires DB/registry defaults, the test
 * wires fabricated ones), and **never 5xx** — a degraded source lands in
 * `errors[]` rather than failing the page.
 *
 * Three sources, per the dashboard-ux-w2 plan slice:
 *   1. Stale watchers      — an enabled watcher that should have run but hasn't.
 *   2. Gardener drafts     — pending `wiki_proposals` awaiting the review gate.
 *   3. Failed recent runs  — trace-sourced chat/watcher spans with a non-ok
 *                            status in the last 24h (the only Recent source that
 *                            carries a real status — ring/extractor rows don't).
 */

import type { Watcher } from "../types.ts";
import { getAllWatchers } from "../db/watchers.ts";
import { countDraftWikiProposals } from "../db/wiki-proposals.ts";
import { discoverAllBots } from "../bots/config.ts";
import { getRecentAgentTraces, type RecentTraceRow } from "../db/agent-activity.ts";
import { getLog } from "../logging.ts";

const log = getLog("dashboard", "attention");

export type AttentionTone = "error" | "warning" | "info";

/** A single "needs you" row. `kind` is a stable key for the client + tests. */
export interface AttentionItem {
  kind: "stale_watcher" | "gardener_drafts" | "failed_run";
  tone: AttentionTone;
  /** One-line human summary. Plain text — the client escapes it. */
  text: string;
  actionLabel: string;
  actionHref: string;
}

export interface AttentionOverview {
  generatedAt: number;
  items: AttentionItem[];
  errors?: string[];
}

/** Injectable seams so the route test drives assembly without a live DB. */
export interface AttentionDeps {
  getWatchers: () => Promise<Watcher[]>;
  /** Draft-proposal counts per bot (only bots with a wiki-gardener surface). */
  getDraftCounts: () => Promise<{ bot: string; count: number }[]>;
  /** Recent trace rows (chat roots + watcher spans) within the failure window. */
  getRecentTraces: () => Promise<RecentTraceRow[]>;
}

/** Default draft-count source: enumerate discovered bots, count each bot's
 *  pending proposals. A bot with no gardener simply returns 0 (dropped below). */
async function defaultDraftCounts(): Promise<{ bot: string; count: number }[]> {
  const bots = discoverAllBots();
  return Promise.all(
    bots.map(async (b) => ({ bot: b.name, count: await countDraftWikiProposals(b.name) })),
  );
}

export const DEFAULT_ATTENTION_DEPS: AttentionDeps = {
  getWatchers: () => getAllWatchers(),
  getDraftCounts: () => defaultDraftCounts(),
  // 24h failure window; the Recent trace source already excludes no-op skip spans.
  getRecentTraces: () => getRecentAgentTraces(40, 24),
};

const ONE_DAY_MS = 86_400_000;
const MAX_FAILED_ITEMS = 5;
const MAX_ITEMS = 12;
/** Failed runs older than this are no longer actionable "attention". */
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is an enabled watcher overdue enough to flag?
 *
 * The plan's baseline is `lastRunAt + 2×intervalMs < now`. That is correct for
 * **pure-interval** watchers (email, x-highlights) — exactly the class most prone
 * to silent failure. But several real watchers are **hour-gated** with a short
 * interval floor (e.g. "X Daily Digest": intervalMs = 5min, config.hour = 12) —
 * for those the interval is only a floor and the true cadence is daily/weekly at
 * a fixed hour, so `2×intervalMs` (10min) would flag a perfectly healthy watcher
 * as stale on every load. So for hour-gated watchers we floor the effective
 * interval at one day before applying the same 2× rule. Verified against the live
 * DB (2026-07-21): the naive rule false-positives on X Daily Digest; this one
 * flags none of the 9 healthy watchers while still catching a truly-dead one.
 */
export function isWatcherStale(
  w: Pick<Watcher, "enabled" | "lastRunAt" | "intervalMs" | "config">,
  now: number,
): boolean {
  if (!w.enabled || w.lastRunAt == null || w.intervalMs <= 0) return false;
  const hourGated = (w.config as { hour?: number } | undefined)?.hour != null;
  const effectiveInterval = hourGated ? Math.max(w.intervalMs, ONE_DAY_MS) : w.intervalMs;
  return w.lastRunAt + 2 * effectiveInterval < now;
}

/** "26h" / "3d" / "45m" — coarse overdue duration for the stale-watcher text. */
function coarseAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/** Humanize a trace span NAME into a run label (mirror of `traceToRecent`). */
function failedRunLabel(name: string): string {
  if (name.startsWith("watcher:")) return `Watcher ${name.slice("watcher:".length)}`;
  return "Chat turn";
}

const TONE_RANK: Record<AttentionTone, number> = { error: 0, warning: 1, info: 2 };

/**
 * Assemble the attention overview. Pure over its injected deps; each async source
 * is caught independently so one degraded source lands in `errors[]` rather than
 * failing the whole page (never a 5xx).
 */
export async function assembleAttention(
  deps: AttentionDeps = DEFAULT_ATTENTION_DEPS,
  now: number = Date.now(),
): Promise<AttentionOverview> {
  const errors: string[] = [];

  const [watchers, draftCounts, traces] = await Promise.all([
    deps.getWatchers().catch((err) => {
      errors.push(`watchers: ${err instanceof Error ? err.message : String(err)}`);
      return [] as Watcher[];
    }),
    deps.getDraftCounts().catch((err) => {
      errors.push(`drafts: ${err instanceof Error ? err.message : String(err)}`);
      return [] as { bot: string; count: number }[];
    }),
    deps.getRecentTraces().catch((err) => {
      errors.push(`traces: ${err instanceof Error ? err.message : String(err)}`);
      return [] as RecentTraceRow[];
    }),
  ]);

  const items: AttentionItem[] = [];

  // 1. Stale watchers ---------------------------------------------------------
  for (const w of watchers) {
    if (!isWatcherStale(w, now)) continue;
    const overdue = w.lastRunAt != null ? coarseAge(now - w.lastRunAt) : "";
    const label = w.name || w.type;
    items.push({
      kind: "stale_watcher",
      tone: "warning",
      text: `Watcher "${label}" (${w.botName})${overdue ? ` hasn't run in ${overdue}` : " is overdue"}`,
      actionLabel: "Configure →",
      actionHref: "/#schedules-watchers",
    });
  }

  // 2. Pending gardener drafts ------------------------------------------------
  const draftBots = draftCounts.filter((d) => d.count > 0);
  const multiBot = draftBots.length > 1;
  for (const d of draftBots) {
    const who = multiBot ? `${d.bot} gardener` : "Gardener";
    items.push({
      kind: "gardener_drafts",
      tone: "info",
      text: `${who} has ${d.count} draft${d.count === 1 ? "" : "s"} waiting for review`,
      actionLabel: "Review →",
      // The gate is per-bot via `?bot=`; qualify the href only where the text is.
      actionHref: multiBot ? `/wiki/gardener?bot=${d.bot}` : "/wiki/gardener",
    });
  }

  // 3. Failed recent runs (trace-sourced only) --------------------------------
  const failed = traces
    .filter((t) => {
      const status = (t.status || "").toLowerCase();
      if (!status || status === "ok") return false;
      return now - t.startedAt <= FAILED_WINDOW_MS;
    })
    .slice(0, MAX_FAILED_ITEMS);
  for (const t of failed) {
    const label = failedRunLabel(t.name);
    items.push({
      kind: "failed_run",
      tone: "error",
      text: `${label}${t.botName ? ` (${t.botName})` : ""} failed`,
      actionLabel: "Trace →",
      actionHref: `/traces#${t.traceId}`,
    });
  }

  // Severity order (error → warning → info), stable within a tone.
  items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);

  if (errors.length > 0) {
    log.warn("attention assembled with {count} degraded source(s)", { count: errors.length });
  }

  return {
    generatedAt: now,
    items: items.slice(0, MAX_ITEMS),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
