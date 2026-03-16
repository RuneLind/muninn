// Inspector panel helper functions — exported as TypeScript (for testing)
// AND as a JS string (for browser injection via inspectorPanelScript()).

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolCallInput {
  name: string;
  displayName?: string;
  durationMs?: number;
}

export interface AggregatedTool {
  displayName: string;
  callCount: number;
  totalMs: number;
}

export interface ContextMeta {
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface ContextUsageResult {
  label: string;
  percentage: number;
  barColor: "accent" | "warning" | "error";
  hasBar: boolean;
}

// ── Pure functions ─────────────────────────────────────────────────────

/** Group tool calls by displayName (or name), counting calls and summing duration. */
export function aggregateToolCalls(toolCalls: ToolCallInput[]): AggregatedTool[] {
  const map: Record<string, AggregatedTool> = {};
  for (const tc of toolCalls) {
    const key = tc.displayName || tc.name;
    if (!map[key]) map[key] = { displayName: key, callCount: 0, totalMs: 0 };
    map[key].callCount++;
    map[key].totalMs += tc.durationMs || 0;
  }
  return Object.values(map).sort(
    (a, b) => b.callCount - a.callCount || b.totalMs - a.totalMs,
  );
}

/** Format milliseconds as a compact duration string. */
export function fmtToolTime(ms: number): string {
  const secs = ms / 1000;
  if (secs >= 60) return Math.round(secs / 60) + "m";
  if (secs >= 1) return secs.toFixed(1) + "s";
  return ms + "ms";
}

/** Format a number with k/M suffixes. */
export function fmtNum(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/** Compute context usage label, percentage, and bar color from token metadata. */
export function computeContextUsage(
  meta: ContextMeta | null,
): ContextUsageResult | null {
  if (!meta) return null;
  const ctxTokens = meta.contextTokens ?? meta.inputTokens;
  if (!ctxTokens) return null;

  let label: string;
  let pct: number;
  if (meta.contextWindow) {
    pct = Math.min(100, Math.round((ctxTokens / meta.contextWindow) * 100));
    label = fmtNum(ctxTokens) + " / " + fmtNum(meta.contextWindow);
  } else {
    pct = 0;
    label = fmtNum(ctxTokens) + " in, " + fmtNum(meta.outputTokens || 0) + " out";
  }

  const barColor = pct > 80 ? "error" : pct > 60 ? "warning" : "accent";
  return { label, percentage: pct, barColor, hasBar: !!meta.contextWindow };
}

// ── Browser-injectable JS string ───────────────────────────────────────

/** Returns all inspector panel helper functions as a browser-compatible JS string.
 *  Phase 2 prep: will replace the duplicated inline functions in page.ts CHAT_SCRIPT IIFE. */
export function inspectorPanelScript(): string {
  return `
    function aggregateToolCalls(toolCalls) {
      var map = {};
      for (var i = 0; i < toolCalls.length; i++) {
        var tc = toolCalls[i];
        var key = tc.displayName || tc.name;
        if (!map[key]) map[key] = { displayName: key, callCount: 0, totalMs: 0 };
        map[key].callCount++;
        map[key].totalMs += tc.durationMs || 0;
      }
      var result = [];
      var keys = Object.keys(map);
      for (var j = 0; j < keys.length; j++) result.push(map[keys[j]]);
      result.sort(function(a, b) {
        return b.callCount - a.callCount || b.totalMs - a.totalMs;
      });
      return result;
    }

    function fmtToolTime(ms) {
      var secs = ms / 1000;
      if (secs >= 60) return Math.round(secs / 60) + 'm';
      if (secs >= 1) return secs.toFixed(1) + 's';
      return ms + 'ms';
    }

    function fmtNum(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    function computeContextUsage(meta) {
      if (!meta) return null;
      var ctxTokens = meta.contextTokens != null ? meta.contextTokens : meta.inputTokens;
      if (!ctxTokens) return null;
      var label, pct;
      if (meta.contextWindow) {
        pct = Math.min(100, Math.round((ctxTokens / meta.contextWindow) * 100));
        label = fmtNum(ctxTokens) + ' / ' + fmtNum(meta.contextWindow);
      } else {
        pct = 0;
        label = fmtNum(ctxTokens) + ' in, ' + fmtNum(meta.outputTokens || 0) + ' out';
      }
      var barColor = pct > 80 ? 'error' : pct > 60 ? 'warning' : 'accent';
      return { label: label, percentage: pct, barColor: barColor, hasBar: !!meta.contextWindow };
    }
  `;
}
