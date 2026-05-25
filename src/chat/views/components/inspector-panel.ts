// Inspector panel helper functions — exported as TypeScript (for testing)
// AND as a JS string (for browser injection via inspectorPanelScript()).

// ── Types ──────────────────────────────────────────────────────────────

export interface ToolCallInput {
  name: string;
  displayName?: string;
  durationMs?: number;
  /** Approximate tokens added to the next turn's context by this call's result */
  tokensEstimate?: number;
}

export interface AggregatedTool {
  displayName: string;
  callCount: number;
  totalMs: number;
  /** Sum of tokensEstimate across all calls aggregated under this name */
  totalTokens: number;
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

export interface ResponseMetaInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  numTurns?: number;
  toolCalls?: { displayName: string; durationMs?: number }[];
}

export interface LastResponseRow {
  label: string;
  value: string;
  detail?: string;
  emphasis?: "cache" | "cost" | "warning";
  /** Fill percentage for an optional bar under the row (e.g. cache-hit bar). */
  barPct?: number;
}

// ── Pure functions ─────────────────────────────────────────────────────

/** Group tool calls by displayName (or name), summing call count, duration, and tokens. */
export function aggregateToolCalls(toolCalls: ToolCallInput[]): AggregatedTool[] {
  const map: Record<string, AggregatedTool> = {};
  for (const tc of toolCalls) {
    const key = tc.displayName || tc.name;
    if (!map[key]) map[key] = { displayName: key, callCount: 0, totalMs: 0, totalTokens: 0 };
    map[key].callCount++;
    map[key].totalMs += tc.durationMs || 0;
    map[key].totalTokens += tc.tokensEstimate || 0;
  }
  return Object.values(map).sort(
    (a, b) => b.callCount - a.callCount || b.totalTokens - a.totalTokens || b.totalMs - a.totalMs,
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

/** Format a duration in ms as "1.2s" or "12s" or "423ms". */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  const secs = ms / 1000;
  return secs >= 10 ? Math.round(secs) + "s" : secs.toFixed(1) + "s";
}

/** Build the rows shown in the inspector "Last response" card. Skips zero-value rows. */
export function computeLastResponseRows(meta: ResponseMetaInput | null): LastResponseRow[] {
  if (!meta) return [];

  const rows: LastResponseRow[] = [];
  const cacheRead = meta.cacheReadTokens ?? 0;
  const cacheCreate = meta.cacheCreationTokens ?? 0;
  const totalIn = meta.inputTokens ?? 0;
  // inputTokens is a sum that already includes both cache buckets — subtract
  // them out so the "Input" row shows only the fresh, billable input.
  const freshIn = Math.max(0, totalIn - cacheRead - cacheCreate);

  if (totalIn > 0) {
    rows.push({ label: "Input", value: fmtNum(freshIn) });
  }
  if (meta.outputTokens && meta.outputTokens > 0) {
    rows.push({ label: "Output", value: fmtNum(meta.outputTokens) });
  }
  if (cacheRead > 0) {
    const pct = Math.round((cacheRead / Math.max(1, totalIn)) * 100);
    rows.push({ label: "Cache hit", value: fmtNum(cacheRead), detail: pct + "%", emphasis: "cache", barPct: pct });
  }
  if (cacheCreate > 0) {
    rows.push({ label: "Cache write", value: fmtNum(cacheCreate) });
  }
  if (meta.durationMs && meta.durationMs > 0) {
    rows.push({ label: "Duration", value: fmtDuration(meta.durationMs) });
  }
  if (meta.costUsd && meta.costUsd > 0) {
    rows.push({ label: "Cost", value: "$" + meta.costUsd.toFixed(4), emphasis: "cost" });
  }
  if (meta.numTurns && meta.numTurns > 1) {
    rows.push({ label: "Turns", value: String(meta.numTurns) });
  }
  // Tool count is rendered as a subsection heading ("Tools (N calls)") so the
  // per-tool breakdown can sit directly under it — see renderLastResponseCard.
  return rows;
}

// ── Dev-run Agents tab (Phase C) ────────────────────────────────────────
// Pure helpers backing the inspector's Agents tab — the live discoveries
// timeline + per-agent latest note. Exported for tests and mirrored verbatim in
// the browser JS string below.

/**
 * Merge two dev_run_event lists, deduping by `id`, sorted oldest→newest
 * (tie-break by id for determinism). A note can land in BOTH the by-thread
 * hydrate payload and the live WS stream during the fetch window — id dedup
 * keeps it single. Already-stored events win over incoming duplicates.
 */
export function mergeDevRunEventsById<T extends { id: string; createdAt: number }>(
  existing: T[],
  incoming: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const e of existing || []) byId.set(e.id, e);
  for (const e of incoming || []) if (!byId.has(e.id)) byId.set(e.id, e);
  return Array.from(byId.values()).sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The most recent note attributed to a handoff — joined on `peerName`, the same
 * `(run_id, peer_name)` derivation the interpreter uses. Returns null when no
 * event matches (a note whose peer matches no handoff still shows in the
 * timeline, just not as a per-agent latest line).
 */
export function latestNoteForHandoff<T extends { peerName?: string; createdAt: number }>(
  events: T[],
  handoff: { peerName?: string } | null,
): T | null {
  if (!events || !handoff || !handoff.peerName) return null;
  let best: T | null = null;
  for (const e of events) {
    if (e.peerName && e.peerName === handoff.peerName && (!best || e.createdAt > best.createdAt)) {
      best = e;
    }
  }
  return best;
}

/** Normalize an event kind to a known timeline class (unknown → 'discovery'). */
export function devRunEventKindClass(kind: string): string {
  return kind === "discovery" || kind === "decision" || kind === "blocker" || kind === "milestone"
    ? kind
    : "discovery";
}

/** Emoji icon for an event kind (normalized via devRunEventKindClass). */
export function devRunEventIcon(kind: string): string {
  switch (devRunEventKindClass(kind)) {
    case "decision":
      return "🧭";
    case "blocker":
      return "⛔";
    case "milestone":
      return "✓";
    default:
      return "🔍";
  }
}

// ── Browser-injectable JS string ───────────────────────────────────────

/** Returns all inspector panel functions as a browser-compatible JS string.
 *  Injected INSIDE the CHAT_SCRIPT IIFE — has access to IIFE-scoped variables
 *  (selectedUserId, selectedBot, activeConvId, conversations, threads, connectors,
 *   bots, lastResponseMeta, inspectorContent, inspectorContext, inspectorToolUsage, etc.). */
export function inspectorPanelScript(): string {
  return `
  // ── Pure helpers ──────────────────────────────────────────────────────

  function aggregateToolCalls(toolCalls) {
    var map = {};
    for (var i = 0; i < toolCalls.length; i++) {
      var tc = toolCalls[i];
      var key = tc.displayName || tc.name;
      if (!map[key]) map[key] = { displayName: key, callCount: 0, totalMs: 0, totalTokens: 0 };
      map[key].callCount++;
      map[key].totalMs += tc.durationMs || 0;
      map[key].totalTokens += tc.tokensEstimate || 0;
    }
    var result = [];
    var keys = Object.keys(map);
    for (var j = 0; j < keys.length; j++) result.push(map[keys[j]]);
    result.sort(function(a, b) {
      return b.callCount - a.callCount || b.totalTokens - a.totalTokens || b.totalMs - a.totalMs;
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

  function fmtDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    var secs = ms / 1000;
    return secs >= 10 ? Math.round(secs) + 's' : secs.toFixed(1) + 's';
  }

  function computeLastResponseRows(meta) {
    if (!meta) return [];
    var rows = [];
    var cacheRead = meta.cacheReadTokens || 0;
    var cacheCreate = meta.cacheCreationTokens || 0;
    var totalIn = meta.inputTokens || 0;
    var freshIn = Math.max(0, totalIn - cacheRead - cacheCreate);

    if (totalIn > 0) rows.push({ label: 'Input', value: fmtNum(freshIn) });
    if (meta.outputTokens && meta.outputTokens > 0) rows.push({ label: 'Output', value: fmtNum(meta.outputTokens) });
    if (cacheRead > 0) {
      var pct = Math.round((cacheRead / Math.max(1, totalIn)) * 100);
      rows.push({ label: 'Cache hit', value: fmtNum(cacheRead), detail: pct + '%', emphasis: 'cache', barPct: pct });
    }
    if (cacheCreate > 0) rows.push({ label: 'Cache write', value: fmtNum(cacheCreate) });
    if (meta.durationMs && meta.durationMs > 0) rows.push({ label: 'Duration', value: fmtDuration(meta.durationMs) });
    if (meta.costUsd && meta.costUsd > 0) rows.push({ label: 'Cost', value: '$' + meta.costUsd.toFixed(4), emphasis: 'cost' });
    if (meta.numTurns && meta.numTurns > 1) rows.push({ label: 'Turns', value: String(meta.numTurns) });
    return rows;
  }

  // ── Dev-run Agents tab helpers (mirror of the TS exports above) ────────

  function mergeDevRunEventsById(existing, incoming) {
    var byId = {};
    var order = [];
    function add(e) { if (!Object.prototype.hasOwnProperty.call(byId, e.id)) { byId[e.id] = e; order.push(e.id); } }
    (existing || []).forEach(add);
    (incoming || []).forEach(add);
    return order.map(function(id) { return byId[id]; }).sort(function(a, b) {
      return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  function latestNoteForHandoff(events, handoff) {
    if (!events || !handoff || !handoff.peerName) return null;
    var best = null;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.peerName && e.peerName === handoff.peerName && (!best || e.createdAt > best.createdAt)) best = e;
    }
    return best;
  }

  function devRunEventKindClass(kind) {
    return (kind === 'discovery' || kind === 'decision' || kind === 'blocker' || kind === 'milestone') ? kind : 'discovery';
  }

  function devRunEventIcon(kind) {
    switch (devRunEventKindClass(kind)) {
      case 'decision': return '🧭';
      case 'blocker': return '⛔';
      case 'milestone': return '✓';
      default: return '🔍';
    }
  }

  // Per-run display cap on the live timeline — mirrors DEV_RUN_EVENTS_DISPLAY_CAP
  // in src/db/dev-runs.ts (the server read cap) so a chatty peer can't grow the
  // in-memory list (and the re-rendered innerHTML) unbounded in a long-lived tab.
  var DEV_RUN_EVENTS_DISPLAY_CAP = 100;

  // Merge a run's hydrated/live events into the per-run client list (keyed by
  // runId, kept SEPARATE from devRun — a dev_run roll-up replaces devRun with
  // {run,handoffs} and would drop a merged events field). Deduped by event.id,
  // trimmed to the newest CAP (merged is oldest→newest).
  function ingestDevRunEvents(runId, incoming) {
    if (!runId) return [];
    var merged = mergeDevRunEventsById(devRunEvents[runId] || [], incoming || []);
    if (merged.length > DEV_RUN_EVENTS_DISPLAY_CAP) merged = merged.slice(merged.length - DEV_RUN_EVENTS_DISPLAY_CAP);
    devRunEvents[runId] = merged;
    return merged;
  }

  function renderLastResponseCard(meta) {
    var container = document.getElementById('insLastResponse');
    if (!container) return;
    var rows = computeLastResponseRows(meta);
    var hasTools = !!(meta && meta.toolCalls && meta.toolCalls.length > 0);
    if (rows.length === 0 && !hasTools) { container.innerHTML = ''; return; }

    var html = '<div class="ins-section"><div class="ins-section-title">Last response</div>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var emph = r.emphasis ? ' ins-info-value-' + r.emphasis : '';
      var detail = r.detail ? '<span class="ins-info-detail">&nbsp;' + escapeHtml(r.detail) + '</span>' : '';
      html += '<div class="ins-info-row">'
        + '<span class="ins-info-label">' + escapeHtml(r.label) + '</span>'
        + '<span class="ins-info-value' + emph + '">' + escapeHtml(r.value) + detail + '</span>'
        + '</div>';
      // Cache-hit gets a thin accent fill bar (prototype look).
      if (r.emphasis === 'cache' && r.barPct != null) {
        html += '<div class="ins-context-bar"><div class="ins-context-fill" style="width:' + r.barPct + '%;background:var(--accent)"></div></div>';
      }
    }

    if (hasTools) {
      var n = meta.toolCalls.length;
      var title = 'Tools (' + n + ' call' + (n !== 1 ? 's' : '') + ')';
      html += '<div class="ins-tool-subhead">' + escapeHtml(title) + '</div>';
      html += renderToolList(aggregateToolCalls(meta.toolCalls));
    }

    html += '</div>';
    container.innerHTML = html;
  }

  // ── DOM helpers (need IIFE-scoped variables) ──────────────────────────

  function getBotInfo() {
    if (!selectedBot || !bots.length) return null;
    for (var i = 0; i < bots.length; i++) {
      if (bots[i].name === selectedBot) return bots[i];
    }
    return null;
  }

  function renderToolList(items) {
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var t = items[i];
      var detail = t.callCount + 'x';
      if (t.totalMs > 0) detail += ' · ' + fmtToolTime(t.totalMs);
      if (t.totalTokens > 0) detail += ' · ~' + fmtNum(t.totalTokens);
      html += '<div class="ins-tool-item">'
        + '<span class="ins-tool-name">' + escapeHtml(t.displayName) + '</span>'
        + '<span class="ins-tool-time">' + detail + '</span>'
        + '</div>';
    }
    return html;
  }

  var aggregateToolUsage = null;

  function updateInspectorToolUsage() {
    if (!inspectorToolUsage) return;

    var html = '';

    // Cumulative aggregate across all responses (loaded from API). The
    // last-response per-tool breakdown lives in the Last response card itself.
    if (aggregateToolUsage && aggregateToolUsage.length > 0) {
      var totalCalls = 0;
      for (var j = 0; j < aggregateToolUsage.length; j++) totalCalls += aggregateToolUsage[j].callCount;
      html += '<hr class="ins-divider">'
        + '<div class="ins-section"><div class="ins-section-title">All Tool Usage (' + totalCalls + ' calls)</div>'
        + renderToolList(aggregateToolUsage) + '</div>';
    }

    inspectorToolUsage.innerHTML = html;
  }

  function updateInspectorContextUsage(meta) {
    var container = document.getElementById('insContextUsage');
    if (!container) return;
    if (!meta) { container.innerHTML = ''; return; }

    var usage = computeContextUsage(meta);
    if (!usage) { container.innerHTML = ''; return; }

    var html = '<div class="ins-info-row"><span class="ins-info-label">Window</span><span class="ins-info-value">' + escapeHtml(usage.label) + '</span></div>';

    if (usage.hasBar) {
      var colorMap = { error: 'var(--status-error, #e74c3c)', warning: 'var(--status-warning, #f39c12)', accent: 'var(--accent, #7c6fe0)' };
      var barColor = colorMap[usage.barColor] || colorMap.accent;
      html += '<div class="ins-context-bar"><div class="ins-context-fill" style="width:' + usage.percentage + '%;background:' + barColor + '"></div></div>';
    }
    container.innerHTML = html;
  }

  function loadToolUsageStats() {
    if (!selectedUserId || !selectedBot) return;
    var url = '/chat/tool-usage/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(selectedBot);
    if (activeThreadId) url += '?thread=' + encodeURIComponent(activeThreadId);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        aggregateToolUsage = data.tools || [];
        updateInspectorToolUsage();
      })
      .catch(function() { aggregateToolUsage = null; });
  }

  function loadContextUsage() {
    if (!selectedUserId || !selectedBot) return;
    var url = '/chat/context-usage/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(selectedBot);
    if (activeThreadId) url += '?thread=' + encodeURIComponent(activeThreadId);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.inputTokens) {
          var syntheticMeta = {
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            contextTokens: data.contextTokens,
            contextWindow: data.contextWindow,
            cacheReadTokens: data.cacheReadTokens,
            cacheCreationTokens: data.cacheCreationTokens,
            durationMs: data.durationMs,
            costUsd: data.costUsd,
            model: data.model,
          };
          updateInspectorContextUsage(syntheticMeta);
          // Only populate the last-response card from API if the live event
          // hasn't already filled it for this conversation (avoid stomping on
          // fresher data with toolCalls / numTurns we don't persist).
          if (!activeConvId || !lastResponseMeta[activeConvId]) {
            renderLastResponseCard(syntheticMeta);
          }
        } else {
          updateInspectorContextUsage(null);
          renderLastResponseCard(null);
        }
      })
      .catch(function() {});
  }

  function isExpandable(s) {
    return s && s.status === 'ok' && (
      (s.collections && s.collections.length > 0) ||
      (s.tools && s.tools.length > 0) ||
      s.collectionsError
    );
  }

  function defaultExpanded(s) {
    // Auto-expand servers that have collections OR a collections-error so the
    // user immediately sees the inventory or the problem.
    return !!(s && ((s.collections && s.collections.length > 0) || s.collectionsError));
  }

  function isRowExpanded(s) {
    if (!isExpandable(s)) return false;
    var key = selectedBot + '::' + s.name;
    if (mcpExpandState[key] != null) return mcpExpandState[key];
    return defaultExpanded(s);
  }

  function fmtCount(n) {
    if (typeof n !== 'number') return '';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k docs';
    return n + ' docs';
  }

  function renderMcpStatus(servers, isLoading) {
    if (!inspectorMcpStatus) return;
    if (!servers || servers.length === 0) {
      inspectorMcpStatus.innerHTML = '';
      return;
    }
    var rows = servers.map(function(s, i) {
      var dotClass = 'ins-mcp-dot ' + (
        s.status === 'ok' ? 'ok' :
        s.status === 'down' ? (s.critical ? 'down-critical' : 'down') :
        'unknown'
      );
      var detail = s.status === 'ok'
        ? (s.toolCount != null ? s.toolCount + ' tools' : 'ok')
        : (s.status === 'down' ? 'down' : '');
      var rowClass = 'ins-mcp-row';
      var titleAttr = s.errorMessage ? ' title="' + escapeHtml(s.errorMessage) + '"' : '';
      var expandable = isExpandable(s);
      var expanded = isRowExpanded(s);
      var caret = expandable
        ? '<span class="ins-mcp-caret' + (expanded ? ' open' : '') + '" aria-hidden="true">&#x25B8;</span>'
        : '<span class="ins-mcp-caret-spacer" aria-hidden="true"></span>';
      var headerAttrs = expandable
        ? ' role="button" tabindex="0" data-mcp-toggle="' + i + '"'
        : '';
      var headerCls = 'ins-mcp-row-header' + (expandable ? ' expandable' : '');

      var html = '<div class="' + rowClass + '"' + titleAttr + '>'
        + '<div class="' + headerCls + '"' + headerAttrs + '>'
        + caret
        + '<span class="' + dotClass + '"></span>'
        + '<span class="ins-mcp-name">' + escapeHtml(s.displayName) + '</span>'
        + '<span class="ins-mcp-detail">' + escapeHtml(detail) + '</span>'
        + '</div>';

      // Down servers: surface the full connect error in a dedicated red block.
      if (s.status === 'down' && s.errorMessage) {
        html += '<div class="ins-mcp-error">' + escapeHtml(s.errorMessage) + '</div>';
      }

      if (expandable && expanded) {
        html += '<div class="ins-mcp-detail-block">';
        if (s.collections && s.collections.length > 0) {
          html += '<div class="ins-mcp-subtitle">Collections (' + s.collections.length + ')</div>';
          html += s.collections.map(function(c) {
            var cnt = c.documentCount != null ? fmtCount(c.documentCount) : '';
            return '<div class="ins-mcp-subitem">'
              + '<span class="ins-mcp-subname">' + escapeHtml(c.name) + '</span>'
              + (cnt ? '<span class="ins-mcp-subcount">' + escapeHtml(cnt) + '</span>' : '')
              + '</div>';
          }).join('');
        } else if (s.collectionsError) {
          html += '<div class="ins-mcp-subtitle">Collections</div>'
            + '<div class="ins-mcp-collerr" title="' + escapeHtml(s.collectionsError) + '">'
            + '⚠️ ' + escapeHtml(truncateMcpError(s.collectionsError))
            + '</div>';
        }
        if (s.tools && s.tools.length > 0) {
          html += '<div class="ins-mcp-subtitle">Tools (' + s.tools.length + ')</div>';
          html += '<div class="ins-mcp-tool-chips">'
            + s.tools.map(function(t) {
                var titleA = t.description ? ' title="' + escapeHtml(t.description) + '"' : '';
                return '<span class="ins-mcp-tool-chip"' + titleA + '>'
                  + escapeHtml(t.name) + '</span>';
              }).join('')
            + '</div>';
        }
        html += '</div>';
      }

      html += '</div>';
      return html;
    }).join('');
    var refreshIcon = isLoading
      ? '<span class="ins-mcp-spinner"></span>'
      : '<span aria-hidden="true">&#x21BB;</span>';
    var refreshLabel = isLoading ? 'Probing...' : 'Refresh';
    inspectorMcpStatus.innerHTML =
      '<div class="ins-section">'
      + '<div class="ins-section-title ins-section-title-row">'
      + '<span>MCP servers</span>'
      + '<button type="button" class="ins-mcp-refresh" id="insMcpRefresh" '
      + (isLoading ? 'disabled' : '') + ' aria-label="Refresh MCP status">'
      + refreshIcon + '<span>' + refreshLabel + '</span></button>'
      + '</div>'
      + rows
      + '</div>';
    var btn = document.getElementById('insMcpRefresh');
    if (btn) btn.onclick = refreshMcpStatus;

    // Wire up row toggles (delegated)
    var toggles = inspectorMcpStatus.querySelectorAll('[data-mcp-toggle]');
    for (var t = 0; t < toggles.length; t++) {
      (function(el) {
        var idx = parseInt(el.getAttribute('data-mcp-toggle'), 10);
        var fn = function(e) {
          if (e && e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
          if (e) e.preventDefault();
          var srv = (mcpStatusByBot[selectedBot] || [])[idx];
          if (!srv) return;
          var key = selectedBot + '::' + srv.name;
          var current = isRowExpanded(srv);
          mcpExpandState[key] = !current;
          renderMcpStatus(mcpStatusByBot[selectedBot] || [], false);
        };
        el.addEventListener('click', fn);
        el.addEventListener('keydown', fn);
      })(toggles[t]);
    }
  }

  function truncateMcpError(msg) {
    var s = String(msg).split('\\n')[0];
    if (s.length > 80) s = s.slice(0, 77) + '...';
    return s;
  }

  function loadMcpStatus() {
    if (!selectedBot) return;
    var cached = mcpStatusByBot[selectedBot];
    if (cached) {
      renderMcpStatus(cached, false);
      return;
    }
    renderMcpStatus([{
      name: '__loading', displayName: 'Probing...', status: 'unknown', critical: false,
    }], true);
    fetch('/chat/mcp-status/' + encodeURIComponent(selectedBot))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var servers = data.servers || [];
        mcpStatusByBot[selectedBot] = servers;
        renderMcpStatus(servers, false);
      })
      .catch(function() {
        renderMcpStatus([], false);
      });
  }

  function refreshMcpStatus() {
    if (!selectedBot || mcpStatusRefreshing) return;
    mcpStatusRefreshing = true;
    var existing = mcpStatusByBot[selectedBot] || [];
    renderMcpStatus(existing, true);
    fetch('/chat/mcp-status/' + encodeURIComponent(selectedBot) + '/refresh', {
      method: 'POST',
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var servers = data.servers || [];
        mcpStatusByBot[selectedBot] = servers;
        renderMcpStatus(servers, false);
      })
      .catch(function() {
        renderMcpStatus(existing, false);
      })
      .finally(function() { mcpStatusRefreshing = false; });
  }

  function loadInspectorContext(userId, botName) {
    var bp = encodeURIComponent(botName);
    var up = encodeURIComponent(userId);

    inspectorContext.innerHTML =
      '<div class="ins-section">'
        + '<div class="ins-section-title ins-section-title-row">'
          + '<span>Memories</span>'
          + '<label class="ins-skip-extractions" title="When on, this thread will not run memory_extraction, goal_detection, or schedule_detection — useful for testing without polluting personal memory.">'
            + '<input type="checkbox" id="skipExtractionsCheckbox">'
            + '<span>Skip extractions</span>'
          + '</label>'
        + '</div>'
        + '<div id="insMemories"><div class="ins-skeleton"></div><div class="ins-skeleton" style="width:70%"></div></div>'
      + '</div>'
      + '<div class="ins-section"><div class="ins-section-title">Goals</div><div id="insGoals"><div class="ins-skeleton"></div></div></div>'
      + '<div class="ins-section"><div class="ins-section-title">Tasks</div><div id="insTasks"><div class="ins-skeleton"></div></div></div>';

    var skipCb = document.getElementById('skipExtractionsCheckbox');
    if (skipCb) {
      skipCb.checked = getSkipExtractions();
      skipCb.addEventListener('change', function() { setSkipExtractions(skipCb.checked); });
    }

    // Memories
    fetch('/api/memories/user/' + up + '?limit=5&bot=' + bp)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('insMemories');
        if (!el) return;
        var memories = data.memories || [];
        if (!memories.length) { el.innerHTML = '<div class="ins-empty-hint">No memories</div>'; return; }
        el.innerHTML = memories.map(function(m) {
          var tags = (m.tags || []).map(function(t) { return '<span class="ins-tag">' + escapeHtml(t) + '</span>'; }).join('');
          return '<div class="ins-mini-memory">' + escapeHtml(m.summary)
            + (tags ? '<div class="ins-tags">' + tags + '</div>' : '')
            + '</div>';
        }).join('');
      })
      .catch(function() {
        var el = document.getElementById('insMemories');
        if (el) el.innerHTML = '<div class="ins-empty-hint">Failed to load</div>';
      });

    // Goals
    fetch('/api/goals/' + up + '?bot=' + bp)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('insGoals');
        if (!el) return;
        var goals = (data.goals || []).filter(function(g) { return g.status === 'active'; });
        if (!goals.length) { el.innerHTML = '<div class="ins-empty-hint">No active goals</div>'; return; }
        el.innerHTML = goals.map(function(g) {
          return '<div class="ins-mini-item">' + escapeHtml(g.title) + '</div>';
        }).join('');
      })
      .catch(function() {
        var el = document.getElementById('insGoals');
        if (el) el.innerHTML = '<div class="ins-empty-hint">Failed to load</div>';
      });

    // Tasks
    fetch('/api/scheduled-tasks/' + up + '?bot=' + bp)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('insTasks');
        if (!el) return;
        var tasks = data.tasks || [];
        if (!tasks.length) { el.innerHTML = '<div class="ins-empty-hint">No scheduled tasks</div>'; return; }
        el.innerHTML = tasks.map(function(t) {
          return '<div class="ins-mini-item">' + escapeHtml(t.title) + '</div>';
        }).join('');
      })
      .catch(function() {
        var el = document.getElementById('insTasks');
        if (el) el.innerHTML = '<div class="ins-empty-hint">Failed to load</div>';
      });
  }

  // ── Inspector tabs: Details / Agents (Phase C) ────────────────────────
  // The Agents tab appears only on a multi-agent thread (devRun has ≥1 handoff).
  // Default tab = Details; Agents auto-focuses the FIRST time it appears, unless
  // the user already picked a tab. Reads the IIFE-scoped devRun + devRunEvents +
  // the inspectorTab/inspectorUserPickedTab/inspectorAgentsAutoFocused/
  // inspectorAgentsHasNew flags (declared + reset on thread switch in page.ts).

  function switchInspectorTab(tab) {
    inspectorUserPickedTab = true;
    inspectorTab = tab;
    if (tab === 'agents') inspectorAgentsHasNew = false;
    renderInspectorTabs();
  }

  function renderInspectorTabs() {
    var tabsEl = document.getElementById('inspectorTabs');
    var detailsEl = document.getElementById('inspectorDetailsTab');
    var agentsEl = document.getElementById('inspectorAgents');
    if (!tabsEl || !detailsEl || !agentsEl) return;

    var handoffs = (devRun && devRun.handoffs) || [];
    var hasAgents = handoffs.length > 0;

    // No multi-agent run on this thread → no tab strip at all (the .ins-tabs:empty
    // rule hides it), so plain chats look exactly as before. Reset the auto-focus
    // latch so a LATER run on the same thread can auto-focus again.
    if (!hasAgents) {
      inspectorTab = 'details';
      inspectorAgentsAutoFocused = false;
      tabsEl.innerHTML = '';
      detailsEl.style.display = '';
      agentsEl.style.display = 'none';
      return;
    }

    // Agents tab auto-focuses the FIRST time it appears, unless the user picked one.
    if (!inspectorUserPickedTab && !inspectorAgentsAutoFocused) {
      inspectorTab = 'agents';
      inspectorAgentsAutoFocused = true;
    }
    if (inspectorTab === 'agents') inspectorAgentsHasNew = false;

    var newDot = (inspectorAgentsHasNew && inspectorTab !== 'agents') ? '<span class="ins-tab-new"></span>' : '';
    tabsEl.innerHTML =
      '<button type="button" class="ins-tab' + (inspectorTab === 'details' ? ' active' : '') + '" data-ins-tab="details">Details</button>'
      + '<button type="button" class="ins-tab' + (inspectorTab === 'agents' ? ' active' : '') + '" data-ins-tab="agents">'
      + 'Agents <span class="ins-tab-count">' + handoffs.length + '</span>' + newDot + '</button>';
    var btns = tabsEl.querySelectorAll('[data-ins-tab]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function() { switchInspectorTab(this.getAttribute('data-ins-tab')); });
    }

    var showAgents = inspectorTab === 'agents';
    detailsEl.style.display = showAgents ? 'none' : '';
    agentsEl.style.display = showAgents ? '' : 'none';
    if (showAgents) renderAgentsTab();
  }

  // Render the Agents tab body: run header + one row per handoff (role · peer ·
  // status · latest note) + the discoveries timeline (newest first). Reuses
  // runStatusMeta/specStatusLabel/handoffStatusMeta from research-card.ts (same
  // IIFE scope, hoisted). Reads devRun + devRunEvents[run.id].
  function renderAgentsTab() {
    var el = document.getElementById('inspectorAgents');
    if (!el) return;
    var run = devRun && devRun.run;
    var handoffs = (devRun && devRun.handoffs) || [];
    if (!run) { el.innerHTML = '<div class="ins-empty-hint">No active dev run.</div>'; return; }

    var events = devRunEvents[run.id] || [];

    var meta = runStatusMeta(run.status);
    var html = '<div class="agt-run-head">'
      + '<span class="agt-run-key">' + escapeHtml(run.issueKey || 'Dev Run') + '</span>'
      + '<span class="agt-badge agt-b-' + meta.cls + '">' + escapeHtml(meta.label) + '</span>'
      + '</div>';
    var specLabel = specStatusLabel(run);
    if (specLabel) {
      var specCls = specLabel === 'verified' ? 'green' : specLabel === 'approved' ? 'info' : 'neutral';
      html += '<p class="agt-run-title">Spec: <span class="agt-badge agt-b-' + specCls + '">' + escapeHtml(specLabel) + '</span></p>';
    }

    html += '<div class="ins-section-title">Agents</div>';
    for (var i = 0; i < handoffs.length; i++) {
      var h = handoffs[i];
      var hmeta = handoffStatusMeta(h.status);
      var working = h.status === 'working';
      var latest = latestNoteForHandoff(events, h);
      html += '<div class="agt-row">'
        + '<div class="agt-row-top">'
        + (working ? '<span class="agt-pip"></span>' : '')
        + '<span class="agt-role">' + escapeHtml(h.role || '?') + '</span>'
        + '<span class="agt-peer">' + escapeHtml(h.peerName || '?') + '</span>'
        + '<span class="agt-badge agt-b-' + hmeta.cls + '">' + escapeHtml(hmeta.label) + '</span>'
        + '</div>'
        + (latest
            ? '<div class="agt-latest">↳ ' + escapeHtml(latest.text) + '</div>'
            : (working ? '<div class="agt-latest muted">working…</div>' : ''))
        + '</div>';
    }

    html += '<div class="ins-section-title" style="margin-top:14px">Activity · ' + events.length + '</div>';
    html += '<div class="timeline">';
    if (!events.length) {
      html += '<div class="tl-empty">No updates yet.</div>';
    } else {
      var ordered = events.slice().sort(function(a, b) { return b.createdAt - a.createdAt; });
      for (var j = 0; j < ordered.length; j++) {
        var e = ordered[j];
        var kc = devRunEventKindClass(e.kind);
        html += '<div class="tl-item">'
          + '<div class="tl-icon tl-' + kc + '">' + devRunEventIcon(e.kind) + '</div>'
          + '<div><div class="tl-body"><span class="tl-kind tl-' + kc + '">' + escapeHtml(e.kind) + '</span>' + escapeHtml(e.text) + '</div>'
          + '<div class="tl-meta">' + escapeHtml(e.peerName || '?') + (e.role ? ' · ' + escapeHtml(e.role) : '') + '</div>'
          + '</div></div>';
      }
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function updateInspector() {
    if (!selectedUserId || !selectedBot) return;

    var initial = (selectedUsername || selectedUserId || '?')[0].toUpperCase();
    var statusText = '';
    if (activeConvId) {
      var conv = conversations[activeConvId];
      if (conv) statusText = conv.status || 'idle';
    }

    var aName = selectedUsername || selectedUserId || '?';
    var html =
      '<div class="ins-user-header">'
        + '<div class="ins-user-avatar" style="' + avatarStyle(aName) + '">' + escapeHtml(initial) + '</div>'
        + '<div class="ins-user-info">'
          + '<div class="ins-user-name">' + escapeHtml(selectedUsername || selectedUserId) + '</div>'
          + '<div class="ins-user-id">' + escapeHtml(selectedUserId) + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="ins-section">'
      + '<div class="ins-section-title">Context</div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Bot</span><span class="ins-info-value">' + escapeHtml(selectedBot) + '</span></div>';

    var botInfo = getBotInfo();
    // Resolve effective connector: thread/dropdown override > bot default
    var effConnectorId = connectorDropdown ? connectorDropdown.value : '';
    var effConnector = effConnectorId ? connectors.find(function(x) { return x.id === effConnectorId; }) : null;
    var effConnectorType = effConnector ? effConnector.connectorType : (botInfo ? botInfo.connector : '');
    var effModel = effConnector ? (effConnector.model || '') : (botInfo ? (botInfo.model || '') : '');
    var effBaseUrl = effConnector ? (effConnector.baseUrl || '') : (botInfo ? (botInfo.baseUrl || '') : '');

    if (effConnectorType) {
      html += '<div class="ins-info-row"><span class="ins-info-label">Connector</span><span class="ins-info-value">' + escapeHtml(effConnectorType) + '</span></div>';
    }
    if (effModel) html += '<div class="ins-info-row"><span class="ins-info-label">Model</span><span class="ins-info-value ins-info-value-mono">' + escapeHtml(effModel) + '</span></div>';
    if (effBaseUrl) html += '<div class="ins-info-row"><span class="ins-info-label">Endpoint</span><span class="ins-info-value" style="font-size:10px">' + escapeHtml(effBaseUrl) + '</span></div>';

    html += '<div class="ins-info-row"><span class="ins-info-label">Thread</span><span class="ins-info-value">' + escapeHtml(activeThreadId ? (function() { var m = null; for (var i = 0; i < threads.length; i++) { if (threads[i].id === activeThreadId) { m = threads[i].name; break; } } return m || 'main'; })() : 'none') + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Status</span><span class="ins-info-value">' + escapeHtml(statusText || 'idle') + '</span></div>'
      + '</div>'
      + '<div id="insContextUsage"></div>'
      + '<hr class="ins-divider">'
      + '<div id="insLastResponse"></div>';
    inspectorContent.innerHTML = html;

    // Restore response meta if we have stored data for this conversation
    if (activeConvId && lastResponseMeta[activeConvId]) {
      updateInspectorContextUsage(lastResponseMeta[activeConvId]);
      updateInspectorToolUsage();
      renderLastResponseCard(lastResponseMeta[activeConvId]);
    }

    var contextKey = selectedUserId + ':' + selectedBot;
    if (inspectorContextKey !== contextKey) {
      inspectorContextKey = contextKey;
      loadInspectorContext(selectedUserId, selectedBot);
    }
    // Always reload per-thread stats (tool usage + context usage)
    loadToolUsageStats();
    loadContextUsage();
    loadMcpStatus();

    // Keep the Details/Agents tab strip in sync with the current run state (the
    // strip lives outside inspectorContent, so the rebuild above doesn't touch it).
    renderInspectorTabs();
  }
  `;
}
