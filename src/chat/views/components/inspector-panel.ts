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
      html += '<div class="ins-tool-item">'
        + '<span class="ins-tool-name">' + escapeHtml(t.displayName) + '</span>'
        + '<span class="ins-tool-time">' + t.callCount + 'x &middot; ' + fmtToolTime(t.totalMs) + '</span>'
        + '</div>';
    }
    return html;
  }

  var aggregateToolUsage = null;

  function updateInspectorToolUsage(meta) {
    if (!inspectorToolUsage) return;

    var html = '';

    // Last response tools (aggregated by name)
    if (meta && meta.toolCalls && meta.toolCalls.length > 0) {
      var lastAgg = aggregateToolCalls(meta.toolCalls);
      html += '<hr class="ins-divider">'
        + '<div class="ins-section"><div class="ins-section-title">Last Response (' + meta.toolCalls.length + ' calls)</div>'
        + renderToolList(lastAgg) + '</div>';
    }

    // Aggregate tool usage (loaded from API)
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

    var html = '<div class="ins-info-row"><span class="ins-info-label">Context</span><span class="ins-info-value">' + escapeHtml(usage.label) + '</span></div>';

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
        var meta = activeConvId ? lastResponseMeta[activeConvId] : null;
        updateInspectorToolUsage(meta);
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
            durationMs: data.durationMs,
            costUsd: data.costUsd,
            model: data.model,
          };
          updateInspectorContextUsage(syntheticMeta);
        } else {
          updateInspectorContextUsage(null);
        }
      })
      .catch(function() {});
  }

  function isExpandable(s) {
    return s && s.status === 'ok' && (
      (s.collections && s.collections.length > 0) ||
      (s.tools && s.tools.length > 0)
    );
  }

  function defaultExpanded(s) {
    // Auto-expand any server that exposes collections (knowledge-capable).
    return !!(s && s.collections && s.collections.length > 0);
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
        : (s.errorMessage ? truncateMcpError(s.errorMessage) : 'down');
      var rowClass = 'ins-mcp-row' + (s.status === 'down' && s.critical ? ' critical' : '');
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
      + '<div class="ins-section-title ins-mcp-header">'
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
    if (s.length > 40) s = s.slice(0, 37) + '...';
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
      '<div class="ins-section"><div class="ins-section-title">Memories</div><div id="insMemories"><div class="ins-skeleton"></div><div class="ins-skeleton" style="width:70%"></div></div></div>'
      + '<div class="ins-section"><div class="ins-section-title">Goals</div><div id="insGoals"><div class="ins-skeleton"></div></div></div>'
      + '<div class="ins-section"><div class="ins-section-title">Tasks</div><div id="insTasks"><div class="ins-skeleton"></div></div></div>';

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
    if (effModel) html += '<div class="ins-info-row"><span class="ins-info-label">Model</span><span class="ins-info-value">' + escapeHtml(effModel) + '</span></div>';
    if (effBaseUrl) html += '<div class="ins-info-row"><span class="ins-info-label">Endpoint</span><span class="ins-info-value" style="font-size:10px">' + escapeHtml(effBaseUrl) + '</span></div>';

    html += '<div class="ins-info-row"><span class="ins-info-label">Thread</span><span class="ins-info-value">' + escapeHtml(activeThreadId ? (function() { var m = null; for (var i = 0; i < threads.length; i++) { if (threads[i].id === activeThreadId) { m = threads[i].name; break; } } return m || 'main'; })() : 'none') + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Status</span><span class="ins-info-value">' + escapeHtml(statusText || 'idle') + '</span></div>'
      + '<div id="insContextUsage"></div>'
      + '<hr class="ins-divider">';
    inspectorContent.innerHTML = html;

    // Restore response meta if we have stored data for this conversation
    if (activeConvId && lastResponseMeta[activeConvId]) {
      updateInspectorContextUsage(lastResponseMeta[activeConvId]);
      updateInspectorToolUsage(lastResponseMeta[activeConvId]);
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
  }
  `;
}
