/** Traces list — table of trace rows with status badges and token info */
export function tracesListStyles(): string {
  return `
    /* Trace List */
    .content { padding: 0 24px 24px; }
    .trace-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .trace-table th {
      text-align: left;
      padding: 10px 12px;
      color: var(--text-dim);
      font-weight: 500;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border-primary);
    }
    .trace-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-subtle);
      white-space: nowrap;
    }
    .trace-table tr { cursor: pointer; transition: background 0.15s; }
    .trace-table tr:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
    .trace-table tr.expanded { background: color-mix(in srgb, var(--accent) 8%, transparent); }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-ok { background: color-mix(in srgb, var(--status-success) 15%, transparent); color: var(--status-success); }
    .badge-error { background: color-mix(in srgb, var(--status-error) 15%, transparent); color: var(--status-error); }
    .badge-name { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent-light); }
    .badge-bot { background: color-mix(in srgb, var(--status-warning) 15%, transparent); color: var(--status-warning); }

    .tokens { color: var(--text-muted); font-size: 12px; }
    .badge-tools { background: color-mix(in srgb, var(--status-tool) 15%, transparent); color: var(--status-tool); margin-left: 6px; }

    .empty { color: var(--text-faint); text-align: center; padding: 40px; font-size: 14px; }
  `;
}

export function tracesListHtml(): string {
  return `
    <table class="trace-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Name</th>
          <th>Bot</th>
          <th>User</th>
          <th>Duration</th>
          <th>Status</th>
          <th>Tools</th>
          <th>Tokens</th>
        </tr>
      </thead>
      <tbody id="traceList"></tbody>
    </table>`;
}

export function tracesListScript(): string {
  return `
    function fmtTime(epochMs) {
      return new Date(epochMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    function fmtDate(epochMs) {
      const d = new Date(epochMs);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) return fmtTime(epochMs);
      return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + fmtTime(epochMs);
    }
    function fmtDuration(ms) {
      if (ms == null) return '-';
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
    }
    function fmtTokens(attrs) {
      const input = attrs?.inputTokens || attrs?.input_tokens || 0;
      const output = attrs?.outputTokens || attrs?.output_tokens || 0;
      if (!input && !output) return '';
      const fmt = n => n >= 1000 ? (n/1000).toFixed(1) + 'k' : n;
      return fmt(input) + ' / ' + fmt(output);
    }

    async function loadTraces() {
      try {
        const name = document.getElementById('filterName').value;
        const bot = selectedBot;
        const params = new URLSearchParams();
        params.set('limit', PAGE_SIZE);
        params.set('offset', currentPage * PAGE_SIZE);
        if (name) params.set('name', name);
        if (bot) params.set('bot', bot);

        const res = await fetch('/api/traces?' + params);
        const { traces } = await res.json();
        renderTraceList(traces);
        document.getElementById('pageInfo').textContent = 'Page ' + (currentPage + 1);
        document.getElementById('prevBtn').disabled = currentPage === 0;
        document.getElementById('nextBtn').disabled = traces.length < PAGE_SIZE;
      } catch (e) { console.error('Failed to load traces', e); }
    }

    function renderTraceList(traces) {
      const tbody = document.getElementById('traceList');
      if (traces.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">No traces found</td></tr>';
        return;
      }
      tbody.innerHTML = traces.map(t => {
        // Find token info from child spans' attributes
        const tokens = fmtTokens(t.attributes);
        const toolCount = t.attributes?.toolCount || 0;
        const toolsBadge = toolCount > 0
          ? '<span class="badge badge-tools">' + toolCount + '</span>'
          : '<span style="color:var(--text-disabled)">-</span>';
        return '<tr onclick="loadWaterfall(\\'' + t.traceId + '\\')" data-trace="' + t.traceId + '">' +
          '<td>' + fmtDate(t.startedAt) + '</td>' +
          '<td><span class="badge badge-name">' + esc(t.name) + '</span></td>' +
          '<td>' + (t.botName ? '<span class="badge badge-bot">' + esc(t.botName) + '</span>' : '-') + '</td>' +
          '<td>' + (t.username || t.userId || '-') + '</td>' +
          '<td>' + fmtDuration(t.durationMs) + '</td>' +
          '<td><span class="badge badge-' + t.status + '">' + t.status + '</span></td>' +
          '<td>' + toolsBadge + '</td>' +
          '<td class="tokens">' + tokens + '</td>' +
          '</tr>';
      }).join('');
    }
  `;
}
