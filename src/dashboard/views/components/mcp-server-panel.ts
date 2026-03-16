/** MCP Debug — server panel: bot selector, server list, connect/disconnect */

export function mcpServerPanelStyles(): string {
  return `
    .mcp-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 0;
      height: calc(100vh - 57px);
    }

    /* Left panel */
    .left-panel {
      background: var(--bg-panel);
      border-right: 1px solid var(--border-primary);
      overflow-y: auto;
      padding: 16px;
    }

    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Bot selector */
    .bot-select {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .bot-select:focus { outline: none; border-color: var(--accent); }

    /* Server list */
    .server-item {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .server-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .server-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-disabled);
      flex-shrink: 0;
    }
    .server-status.connected { background: var(--status-success); }
    .server-status.connecting { background: var(--status-warning); animation: pulse 1s infinite; }
    .server-status.error { background: var(--status-error); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .btn {
      padding: 4px 10px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .btn-connect {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent-light);
    }
    .btn-connect:hover { background: color-mix(in srgb, var(--accent) 35%, transparent); }
    .btn-disconnect {
      background: color-mix(in srgb, var(--status-error) 15%, transparent);
      color: var(--status-error);
    }
    .btn-disconnect:hover { background: color-mix(in srgb, var(--status-error) 30%, transparent); }

    /* Server info badge */
    .server-info {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 2px;
    }

    /* Loading spinner */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
}

export function mcpServerPanelHtml(): string {
  return `
    <div class="left-panel">
      <div class="section-title">Bot</div>
      <select class="bot-select" id="botSelect" onchange="loadConfig()">
        <option value="">Select a bot...</option>
      </select>

      <div class="section-title">
        Servers
        <span id="serverCount" style="color: var(--text-disabled)"></span>
      </div>
      <div id="serverList"></div>
      <div id="serverError" style="color:var(--status-error);font-size:12px;padding:4px 0;display:none"></div>

      <div class="tool-list" id="toolSection" style="display:none">
        <div class="section-title">
          Tools
          <span id="toolCount" style="color: var(--text-disabled)"></span>
        </div>
        <div id="toolList"></div>
      </div>
    </div>`;
}

export function mcpServerPanelScript(): string {
  return `
    // State
    let currentBot = '';
    let mcpConfig = null;     // { mcpServers: { name: config } }
    let connectedServers = {};  // serverName -> { tools, serverInfo }
    let activeServer = null;
    let activeTool = null;

    // --- Init ---
    (async function init() {
      const res = await fetch('/api/mcp/bots');
      const { bots } = await res.json();
      const sel = document.getElementById('botSelect');
      bots.forEach(function(b) {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b.charAt(0).toUpperCase() + b.slice(1);
        sel.appendChild(opt);
      });
    })();

    // --- Load config ---
    async function loadConfig() {
      currentBot = document.getElementById('botSelect').value;
      mcpConfig = null;
      connectedServers = {};
      activeServer = null;
      activeTool = null;
      renderServers();
      renderTools();
      renderToolDetail();

      if (!currentBot) return;

      try {
        const res = await fetch('/api/mcp/config?bot=' + encodeURIComponent(currentBot));
        if (!res.ok) {
          document.getElementById('serverList').innerHTML =
            '<div style="color:var(--text-faint);font-size:12px;padding:8px">No .mcp.json found for this bot</div>';
          return;
        }
        mcpConfig = await res.json();
        renderServers();
      } catch (e) {
        console.error('Failed to load MCP config', e);
      }
    }

    // --- Render servers ---
    function renderServers() {
      var el = document.getElementById('serverList');
      var countEl = document.getElementById('serverCount');

      if (!mcpConfig || !mcpConfig.mcpServers) {
        el.innerHTML = '';
        countEl.textContent = '';
        return;
      }

      var names = Object.keys(mcpConfig.mcpServers);
      countEl.textContent = '(' + names.length + ')';

      el.innerHTML = names.map(function(name) {
        var isConnected = !!connectedServers[name];
        var statusClass = isConnected ? 'connected' : '';
        var btn = isConnected
          ? '<button class="btn btn-disconnect" data-server="' + esc(name) + '">Disconnect</button>'
          : '<button class="btn btn-connect" data-server="' + esc(name) + '">Connect</button>';
        var info = isConnected && connectedServers[name].serverInfo
          ? '<div class="server-info">' + esc(connectedServers[name].serverInfo.name) + ' v' + esc(connectedServers[name].serverInfo.version) + '</div>'
          : '';
        return '<div class="server-item" data-server-name="' + esc(name) + '">' +
          '<div class="server-status ' + statusClass + '"></div>' +
          '<div style="flex:1;overflow:hidden">' +
            '<div class="server-name">' + esc(name) + '</div>' +
            info +
          '</div>' +
          btn +
        '</div>';
      }).join('');
    }

    // Event delegation for connect/disconnect buttons
    document.getElementById('serverList').addEventListener('click', function(e) {
      var connectBtn = e.target.closest('.btn-connect');
      if (connectBtn) { connectServer(connectBtn.dataset.server); return; }
      var disconnectBtn = e.target.closest('.btn-disconnect');
      if (disconnectBtn) disconnect(disconnectBtn.dataset.server);
    });

    function showServerError(msg) {
      var el = document.getElementById('serverError');
      el.textContent = msg;
      el.style.display = msg ? 'block' : 'none';
    }

    // --- Connect ---
    async function connectServer(name) {
      showServerError('');
      // Show connecting state
      var item = document.querySelector('[data-server-name="' + name + '"]');
      if (item) {
        var dot = item.querySelector('.server-status');
        dot.className = 'server-status connecting';
        var btn = item.querySelector('.btn-connect');
        if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }
      }

      try {
        var res = await fetch('/api/mcp/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot: currentBot, server: name }),
        });
        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          throw new Error(errData.error || 'Connection failed');
        }
        var data = await res.json();
        connectedServers[name] = data;
        activeServer = name;
        activeTool = null;
        renderServers();
        renderTools();
        renderToolDetail();
      } catch (e) {
        console.error('Connect failed:', e);
        // Show error state briefly
        if (item) {
          var dot = item.querySelector('.server-status');
          dot.className = 'server-status error';
        }
        renderServers();
        showServerError('Failed to connect to ' + name + ': ' + e.message);
      }
    }

    // --- Disconnect ---
    async function disconnect(name) {
      try {
        await fetch('/api/mcp/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot: currentBot, server: name }),
        });
      } catch (e) {
        console.error('Disconnect error:', e);
      }
      delete connectedServers[name];
      if (activeServer === name) {
        activeServer = null;
        activeTool = null;
      }
      renderServers();
      renderTools();
      renderToolDetail();
    }
  `;
}
