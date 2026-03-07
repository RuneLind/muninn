import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";

export function renderSerenaPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Serena</title>
  <style>
    ${SHARED_STYLES}

    .serena-container {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .page-header h1 {
      font-size: 20px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .page-header p {
      font-size: 13px;
      color: var(--text-dim);
    }

    .actions-bar {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    .instance-card {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 16px;
      transition: border-color 0.2s;
    }
    .instance-card.running {
      border-color: color-mix(in srgb, var(--status-success) 40%, transparent);
    }
    .instance-card.error {
      border-color: color-mix(in srgb, var(--status-error) 40%, transparent);
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.stopped { background: var(--text-disabled); }
    .status-dot.starting, .status-dot.indexing { background: var(--status-warning); animation: pulse 1s infinite; }
    .status-dot.running { background: var(--status-success); }
    .status-dot.error { background: var(--status-error); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .instance-info {
      flex: 1;
      min-width: 0;
    }
    .instance-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-secondary);
    }
    .instance-name .dim {
      color: var(--text-dim);
      font-weight: 400;
      font-size: 12px;
    }
    .instance-path {
      font-size: 11px;
      color: var(--text-faint);
      font-family: 'SF Mono', 'Fira Code', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }
    .instance-meta {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 4px;
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .meta-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .status-badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-badge.stopped { background: color-mix(in srgb, var(--text-disabled) 20%, transparent); color: var(--text-dim); }
    .status-badge.starting { background: color-mix(in srgb, var(--status-warning) 20%, transparent); color: var(--status-warning); }
    .status-badge.indexing { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent-light); }
    .status-badge.running { background: color-mix(in srgb, var(--status-success) 20%, transparent); color: var(--status-success); }
    .status-badge.error { background: color-mix(in srgb, var(--status-error) 20%, transparent); color: var(--status-error); }

    .instance-link {
      color: var(--accent-light);
      text-decoration: none;
      font-size: 11px;
    }
    .instance-link:hover { text-decoration: underline; }

    .instance-error {
      font-size: 11px;
      color: var(--status-error);
      margin-top: 4px;
      max-width: 500px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .instance-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }

    .btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-start {
      background: color-mix(in srgb, var(--status-success) 20%, transparent);
      color: var(--status-success);
    }
    .btn-start:hover:not(:disabled) { background: color-mix(in srgb, var(--status-success) 35%, transparent); }
    .btn-stop {
      background: color-mix(in srgb, var(--status-error) 15%, transparent);
      color: var(--status-error);
    }
    .btn-stop:hover:not(:disabled) { background: color-mix(in srgb, var(--status-error) 30%, transparent); }
    .btn-index {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent-light);
    }
    .btn-index:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 35%, transparent); }
    .btn-all {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
      padding: 6px 16px;
    }
    .btn-all:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 30%, transparent); }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-faint);
      font-size: 14px;
    }

    .section-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  ${renderNav("serena")}

  <div class="serena-container">
    <div class="page-header">
      <div>
        <h1>Serena Code Analysis</h1>
        <p>Manage Serena MCP instances for code search and analysis</p>
      </div>
      <div class="actions-bar">
        <button class="btn btn-all" id="btnStartAll" onclick="startAll()" disabled>Start All</button>
        <button class="btn btn-all" id="btnStopAll" onclick="stopAll()" disabled>Stop All</button>
      </div>
    </div>

    <div class="section-label" id="sectionLabel"></div>
    <div id="instanceList">
      <div class="empty-state">Loading...</div>
    </div>
  </div>

  <script>
    ${escScript()}

    var instances = [];
    var refreshTimer = null;

    function formatUptime(startedAt) {
      if (!startedAt) return '';
      var s = Math.floor((Date.now() - startedAt) / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    function render() {
      var el = document.getElementById('instanceList');
      var label = document.getElementById('sectionLabel');
      var btnStart = document.getElementById('btnStartAll');
      var btnStop = document.getElementById('btnStopAll');

      if (instances.length === 0) {
        label.textContent = '';
        btnStart.disabled = true;
        btnStop.disabled = true;
        el.innerHTML = '<div class="empty-state">No Serena instances configured.<br>Add a <code>serena</code> array to a bot\\'s config.json.</div>';
        return;
      }

      var runningCount = instances.filter(function(i) { return i.status === 'running'; }).length;
      var stoppedCount = instances.filter(function(i) { return i.status === 'stopped'; }).length;
      label.textContent = 'Instances (' + runningCount + '/' + instances.length + ' running)';
      btnStart.disabled = stoppedCount === 0;
      btnStop.disabled = runningCount === 0;

      el.innerHTML = instances.map(function(inst) {
        var running = inst.status === 'running';
        var busy = inst.status === 'starting' || inst.status === 'indexing';
        var cardClass = 'instance-card' + (running ? ' running' : '') + (inst.status === 'error' ? ' error' : '');

        var metaItems = [];
        metaItems.push('<span class="status-badge ' + esc(inst.status) + '">' + esc(inst.status) + '</span>');
        metaItems.push('<span class="meta-item">port ' + inst.port + '</span>');
        if (inst.startedAt) metaItems.push('<span class="meta-item">up ' + formatUptime(inst.startedAt) + '</span>');
        metaItems.push('<span class="meta-item">bot: ' + esc(inst.botName) + '</span>');

        var links = '';
        if (running && inst.mcpUrl) {
          links += '<span class="meta-item"><a href="' + esc(inst.mcpUrl) + '" target="_blank" class="instance-link">MCP</a></span>';
        }
        if (running && inst.dashboardUrl) {
          links += '<span class="meta-item"><a href="' + esc(inst.dashboardUrl) + '" target="_blank" class="instance-link">Dashboard</a></span>';
        }

        var error = inst.error
          ? '<div class="instance-error" title="' + esc(inst.error) + '">' + esc(inst.error) + '</div>'
          : '';

        return '<div class="' + cardClass + '">' +
          '<div class="status-dot ' + esc(inst.status) + '"></div>' +
          '<div class="instance-info">' +
            '<div class="instance-name">' + esc(inst.displayName) + ' <span class="dim">(' + esc(inst.name) + ')</span></div>' +
            '<div class="instance-path">' + esc(inst.projectPath) + '</div>' +
            '<div class="instance-meta">' + metaItems.join('') + links + '</div>' +
            error +
          '</div>' +
          '<div class="instance-actions">' +
            (running
              ? '<button class="btn btn-stop" onclick="stopInstance(\\'' + esc(inst.name) + '\\')">Stop</button>'
              : '<button class="btn btn-start" onclick="startInstance(\\'' + esc(inst.name) + '\\')"' + (busy ? ' disabled' : '') + '>Start</button>') +
            '<button class="btn btn-index" onclick="indexInstance(\\'' + esc(inst.name) + '\\')"' + (running || busy ? ' disabled' : '') + '>Index</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function refresh() {
      try {
        var res = await fetch('/api/serena/instances');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        instances = await res.json();
        render();
      } catch (e) {
        console.error('Failed to refresh Serena instances', e);
      }
    }

    async function startInstance(name) {
      // Immediately update UI to show starting
      for (var i = 0; i < instances.length; i++) {
        if (instances[i].name === name) instances[i].status = 'starting';
      }
      render();

      try {
        await fetch('/api/serena/' + encodeURIComponent(name) + '/start', { method: 'POST' });
      } catch (e) {
        console.error('Start failed', e);
      }
      refresh();
    }

    async function stopInstance(name) {
      try {
        await fetch('/api/serena/' + encodeURIComponent(name) + '/stop', { method: 'POST' });
      } catch (e) {
        console.error('Stop failed', e);
      }
      refresh();
    }

    async function indexInstance(name) {
      // Immediately update UI to show indexing
      for (var i = 0; i < instances.length; i++) {
        if (instances[i].name === name) instances[i].status = 'indexing';
      }
      render();

      try {
        await fetch('/api/serena/' + encodeURIComponent(name) + '/index', { method: 'POST' });
      } catch (e) {
        console.error('Index failed', e);
      }
      setTimeout(refresh, 2000);
    }

    async function startAll() {
      // Immediately update UI
      for (var i = 0; i < instances.length; i++) {
        if (instances[i].status === 'stopped') instances[i].status = 'starting';
      }
      render();

      // Fire all start requests
      var promises = [];
      for (var i = 0; i < instances.length; i++) {
        if (instances[i].status === 'starting') {
          promises.push(
            fetch('/api/serena/' + encodeURIComponent(instances[i].name) + '/start', { method: 'POST' })
          );
        }
      }
      await Promise.allSettled(promises);
      refresh();
    }

    async function stopAll() {
      var promises = [];
      for (var i = 0; i < instances.length; i++) {
        if (instances[i].status === 'running') {
          promises.push(
            fetch('/api/serena/' + encodeURIComponent(instances[i].name) + '/stop', { method: 'POST' })
          );
        }
      }
      await Promise.allSettled(promises);
      refresh();
    }

    // Init + auto-refresh
    refresh();
    refreshTimer = setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
