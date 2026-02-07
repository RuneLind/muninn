export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
    }
    header {
      background: #12121a;
      border-bottom: 1px solid #1e1e2e;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 {
      font-size: 20px;
      font-weight: 600;
      color: #fff;
    }
    header h1 span { color: #6c63ff; }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #888;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #444;
    }
    .status-dot.connected { background: #4ade80; }
    .stats-bar {
      display: flex;
      gap: 24px;
      padding: 12px 24px;
      background: #12121a;
      border-bottom: 1px solid #1e1e2e;
      font-size: 13px;
    }
    .stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { color: #fff; font-weight: 600; font-size: 16px; }
    .feed {
      padding: 16px 24px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 900px;
    }
    .event {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .event:hover { background: #ffffff06; }
    .event-time {
      color: #555;
      font-size: 12px;
      font-family: monospace;
      white-space: nowrap;
      min-width: 55px;
    }
    .event-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
      white-space: nowrap;
      min-width: 36px;
      text-align: center;
    }
    .event-text {
      flex: 1;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .type-message_in .event-badge { background: #1e3a5f; color: #60a5fa; }
    .type-message_out .event-badge { background: #1a3a2a; color: #4ade80; }
    .type-error .event-badge { background: #3a1a1a; color: #f87171; }
    .type-system .event-badge { background: #2a2a1a; color: #facc15; }
    .event-meta {
      color: #555;
      font-size: 11px;
      white-space: nowrap;
    }
    .event-timing {
      grid-column: 2 / -1;
      margin-left: 48px;
      padding: 4px 8px;
      font-size: 11px;
      font-family: monospace;
      color: #666;
      background: #ffffff04;
      border-radius: 3px;
      line-height: 1.4;
    }
    .event-timing span { color: #888; }
    .event-timing .t-label { color: #555; }
    .event-timing .t-val { color: #8b8bcd; }
  </style>
</head>
<body>
  <header>
    <h1><span>J</span>arvis</h1>
    <div class="status">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Connecting...</span>
    </div>
  </header>
  <div class="stats-bar">
    <div class="stat">
      <span class="stat-label">Messages Today</span>
      <span class="stat-value" id="messagesToday">0</span>
    </div>
    <div class="stat">
      <span class="stat-label">Avg Response</span>
      <span class="stat-value" id="avgResponse">—</span>
    </div>
    <div class="stat">
      <span class="stat-label">Total Cost</span>
      <span class="stat-value" id="totalCost">$0.00</span>
    </div>
  </div>
  <div class="feed" id="feed"></div>

  <script>
    const feed = document.getElementById('feed');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function badgeLabel(type) {
      switch (type) {
        case 'message_in': return 'IN';
        case 'message_out': return 'OUT';
        case 'error': return 'ERR';
        case 'system': return 'SYS';
        default: return type;
      }
    }

    function fmtMs(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
    }

    function fmtTokens(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : '' + n;
    }

    function renderTiming(m) {
      const parts = [];
      if (m.startupMs > 500) parts.push('<span class="t-label">mcp:</span> <span class="t-val">' + fmtMs(m.startupMs) + '</span>');
      if (m.apiMs) parts.push('<span class="t-label">api:</span> <span class="t-val">' + fmtMs(m.apiMs) + '</span>');
      if (m.promptBuildMs > 50) parts.push('<span class="t-label">prompt:</span> <span class="t-val">' + fmtMs(m.promptBuildMs) + '</span>');
      if (m.sttMs) parts.push('<span class="t-label">stt:</span> <span class="t-val">' + fmtMs(m.sttMs) + '</span>');
      if (m.ttsMs) parts.push('<span class="t-label">tts:</span> <span class="t-val">' + fmtMs(m.ttsMs) + '</span>');
      if (m.inputTokens || m.outputTokens) parts.push('<span class="t-label">tok:</span> <span class="t-val">' + fmtTokens(m.inputTokens || 0) + ' in / ' + fmtTokens(m.outputTokens || 0) + ' out</span>');
      if (m.model) parts.push('<span class="t-label">' + m.model + '</span>');
      return parts.join(' &nbsp;·&nbsp; ');
    }

    function addEvent(ev) {
      const div = document.createElement('div');
      div.className = 'event type-' + ev.type;

      let meta = '';
      if (ev.durationMs) meta += fmtMs(ev.durationMs);
      if (ev.costUsd) meta += (meta ? ' · ' : '') + '$' + ev.costUsd.toFixed(4);
      if (ev.username) meta += (meta ? ' · ' : '') + '@' + ev.username;

      div.innerHTML =
        '<span class="event-time">' + formatTime(ev.timestamp) + '</span>' +
        '<span class="event-badge">' + badgeLabel(ev.type) + '</span>' +
        '<span class="event-text">' + escapeHtml(ev.text) + '</span>' +
        (meta ? '<span class="event-meta">' + meta + '</span>' : '');

      feed.appendChild(div);

      if (ev.metadata && ev.type === 'message_out') {
        const timingDiv = document.createElement('div');
        timingDiv.className = 'event-timing';
        timingDiv.innerHTML = renderTiming(ev.metadata);
        feed.appendChild(timingDiv);
      }

      window.scrollTo(0, document.body.scrollHeight);
    }

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function updateStats(stats) {
      document.getElementById('messagesToday').textContent = stats.messagesToday;
      document.getElementById('avgResponse').textContent =
        stats.avgResponseTime > 0 ? (stats.avgResponseTime / 1000).toFixed(1) + 's' : '—';
      document.getElementById('totalCost').textContent = '$' + stats.totalCost.toFixed(4);
    }

    function connect() {
      const es = new EventSource('/api/events');

      es.onopen = () => {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Connected';
      };

      es.addEventListener('activity', (e) => {
        const data = JSON.parse(e.data);
        addEvent(data);
      });

      es.addEventListener('stats', (e) => {
        const data = JSON.parse(e.data);
        updateStats(data);
      });

      es.onerror = () => {
        statusDot.className = 'status-dot';
        statusText.textContent = 'Reconnecting...';
        es.close();
        setTimeout(connect, 3000);
      };
    }

    connect();
  </script>
</body>
</html>`;
}
