import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";

export function renderMcpDebugPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - MCP Debug</title>
  <style>
    ${SHARED_STYLES}

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
    .btn-call {
      background: var(--accent);
      color: var(--text-primary);
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
    }
    .btn-call:hover { background: var(--accent-hover); }
    .btn-call:disabled { opacity: 0.4; cursor: default; }

    /* Tool list */
    .tool-list {
      margin-top: 16px;
    }
    .tool-item {
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      color: var(--text-soft);
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-item:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--text-secondary); }
    .tool-item.active { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent-light); }
    .tool-item-name { font-weight: 500; }

    /* Right panel */
    .right-panel {
      overflow-y: auto;
      padding: 24px;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-faint);
      font-size: 14px;
    }

    .tool-detail h2 {
      font-size: 18px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .tool-mcp-name {
      font-size: 12px;
      color: var(--text-dim);
      font-family: 'SF Mono', 'Fira Code', monospace;
      margin-bottom: 16px;
    }
    .tool-description {
      color: var(--text-soft);
      font-size: 13px;
      margin-bottom: 20px;
      line-height: 1.5;
    }

    /* Schema section */
    .schema-toggle {
      font-size: 12px;
      color: var(--text-dim);
      cursor: pointer;
      user-select: none;
      margin-bottom: 8px;
    }
    .schema-toggle:hover { color: var(--accent-light); }
    .schema-content {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 20px;
      display: none;
    }
    .schema-content.visible { display: block; }
    .schema-content pre {
      font-size: 11px;
      line-height: 1.5;
      color: var(--text-tertiary);
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Input form */
    .input-section { margin-bottom: 20px; }
    .input-section h3 {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .form-field {
      margin-bottom: 12px;
    }
    .form-field label {
      display: block;
      font-size: 12px;
      color: var(--text-soft);
      margin-bottom: 4px;
    }
    .form-field label .required { color: var(--status-error); }
    .form-field label .type-hint { color: var(--text-faint); font-style: italic; }
    .form-field input,
    .form-field textarea,
    .form-field select {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
    }
    .form-field textarea {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px;
      min-height: 60px;
      resize: vertical;
    }
    .form-field input:focus,
    .form-field textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .form-field input[type="checkbox"] {
      width: auto;
    }
    .form-field .field-desc {
      font-size: 11px;
      color: var(--text-faint);
      margin-top: 2px;
    }

    /* Call section */
    .call-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .call-duration {
      font-size: 12px;
      color: var(--text-muted);
    }
    .call-error {
      font-size: 12px;
      color: var(--status-error);
      margin-top: 4px;
    }

    /* Result */
    .result-section { margin-top: 8px; }
    .result-section h3 {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .result-tabs {
      display: flex;
      gap: 0;
      margin-bottom: -1px;
      position: relative;
      z-index: 1;
    }
    .result-tab {
      padding: 6px 14px;
      font-size: 12px;
      color: var(--text-dim);
      background: none;
      border: 1px solid transparent;
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      transition: all 0.15s;
    }
    .result-tab:hover { color: var(--accent-light); }
    .result-tab.active {
      color: var(--text-secondary);
      background: var(--bg-panel);
      border-color: var(--border-primary);
    }
    .result-box {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 0 8px 8px 8px;
      padding: 14px;
      overflow-x: auto;
      max-height: 500px;
      overflow-y: auto;
    }
    .result-box pre {
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-tertiary);
      white-space: pre-wrap;
      word-break: break-word;
    }

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
  </style>
</head>
<body>
  ${renderNav("mcp-debug")}

  <div class="mcp-layout">
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
    </div>

    <div class="right-panel">
      <div class="empty-state" id="emptyState">
        Select a bot and connect to an MCP server to explore tools
      </div>
      <div class="tool-detail" id="toolDetail" style="display:none">
        <h2 id="toolName"></h2>
        <div class="tool-mcp-name" id="toolMcpName"></div>
        <div class="tool-description" id="toolDescription"></div>

        <div class="schema-toggle" id="schemaToggle" onclick="toggleSchema()">
          ▸ Input Schema
        </div>
        <div class="schema-content" id="schemaContent">
          <pre id="schemaJson"></pre>
        </div>

        <div class="input-section">
          <h3>Input</h3>
          <div id="inputForm"></div>
        </div>

        <div class="call-bar">
          <button class="btn btn-call" id="callBtn" onclick="callTool()">Call Tool</button>
          <span class="call-duration" id="callDuration"></span>
          <span id="callSpinner" style="display:none"><span class="spinner"></span></span>
        </div>
        <div class="call-error" id="callError"></div>

        <div class="result-section" id="resultSection" style="display:none">
          <div class="result-tabs">
            <button class="result-tab active" onclick="switchResultTab('formatted')">Formatted</button>
            <button class="result-tab" onclick="switchResultTab('raw')">Raw JSON</button>
          </div>
          <div class="result-box">
            <pre id="resultFormatted"></pre>
            <pre id="resultJson" style="display:none"></pre>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    ${escScript()}

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

    // --- Render tools ---
    function renderTools() {
      var section = document.getElementById('toolSection');
      var listEl = document.getElementById('toolList');
      var countEl = document.getElementById('toolCount');

      if (!activeServer || !connectedServers[activeServer]) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'block';
      var tools = connectedServers[activeServer].tools || [];
      countEl.textContent = '(' + tools.length + ')';

      listEl.innerHTML = tools.map(function(t) {
        var isActive = activeTool && activeTool.name === t.name;
        return '<div class="tool-item' + (isActive ? ' active' : '') + '" data-tool="' + esc(t.name) + '">' +
          '<span class="tool-item-name">' + esc(t.name) + '</span>' +
        '</div>';
      }).join('');
    }

    // Event delegation for tool clicks
    document.getElementById('toolList').addEventListener('click', function(e) {
      var item = e.target.closest('.tool-item');
      if (!item) return;
      var name = item.dataset.tool;
      var tools = connectedServers[activeServer].tools || [];
      activeTool = tools.find(function(t) { return t.name === name; }) || null;
      renderTools();
      renderToolDetail();
    });

    // --- Render tool detail ---
    function renderToolDetail() {
      var emptyEl = document.getElementById('emptyState');
      var detailEl = document.getElementById('toolDetail');

      if (!activeTool) {
        emptyEl.style.display = 'flex';
        detailEl.style.display = 'none';
        return;
      }

      emptyEl.style.display = 'none';
      detailEl.style.display = 'block';

      document.getElementById('toolName').textContent = activeTool.name;
      document.getElementById('toolMcpName').textContent = 'mcp__' + activeServer + '__' + activeTool.name;
      document.getElementById('toolDescription').textContent = activeTool.description || '(no description)';

      // Schema
      document.getElementById('schemaJson').textContent = JSON.stringify(activeTool.inputSchema, null, 2);
      document.getElementById('schemaContent').classList.remove('visible');
      document.getElementById('schemaToggle').textContent = '▸ Input Schema';

      // Build form
      buildInputForm(activeTool.inputSchema);

      // Reset result
      document.getElementById('resultSection').style.display = 'none';
      document.getElementById('callDuration').textContent = '';
      document.getElementById('callError').textContent = '';
    }

    function toggleSchema() {
      var el = document.getElementById('schemaContent');
      var toggle = document.getElementById('schemaToggle');
      var visible = el.classList.toggle('visible');
      toggle.textContent = (visible ? '▾' : '▸') + ' Input Schema';
    }

    function switchResultTab(tab) {
      var tabs = document.querySelectorAll('.result-tab');
      tabs.forEach(function(t) { t.classList.toggle('active', t.textContent.toLowerCase().indexOf(tab) >= 0); });
      document.getElementById('resultFormatted').style.display = tab === 'formatted' ? '' : 'none';
      document.getElementById('resultJson').style.display = tab === 'raw' ? '' : 'none';
    }

    // --- Build input form from JSON schema ---
    function buildInputForm(schema) {
      var formEl = document.getElementById('inputForm');
      if (!schema || !schema.properties) {
        formEl.innerHTML = '<div style="color:var(--text-faint);font-size:12px">(no parameters)</div>';
        return;
      }

      var required = schema.required || [];
      var props = schema.properties;
      var html = '';

      Object.keys(props).forEach(function(key) {
        var prop = props[key];
        var isRequired = required.indexOf(key) >= 0;
        var type = prop.type || 'string';
        var desc = prop.description || '';
        var defaultVal = prop.default !== undefined ? prop.default : '';
        var enumVals = prop.enum;

        var label = '<label>' + esc(key) +
          (isRequired ? ' <span class="required">*</span>' : '') +
          ' <span class="type-hint">(' + esc(type) + ')</span></label>';

        var input = '';
        if (enumVals) {
          input = '<select data-field="' + esc(key) + '">' +
            (!isRequired ? '<option value="">(none)</option>' : '') +
            enumVals.map(function(v) {
              var sel = String(v) === String(defaultVal) ? ' selected' : '';
              return '<option value="' + esc(String(v)) + '"' + sel + '>' + esc(String(v)) + '</option>';
            }).join('') +
          '</select>';
        } else if (type === 'boolean') {
          var checked = defaultVal === true ? ' checked' : '';
          input = '<input type="checkbox" data-field="' + esc(key) + '" data-type="boolean"' + checked + '>';
        } else if (type === 'number' || type === 'integer') {
          input = '<input type="number" data-field="' + esc(key) + '" data-type="number" value="' + esc(String(defaultVal)) + '" placeholder="' + esc(desc) + '">';
        } else if (type === 'array' || type === 'object') {
          var placeholder = type === 'array' ? '["item1", "item2"]' : '{"key": "value"}';
          input = '<textarea data-field="' + esc(key) + '" data-type="' + esc(type) + '" placeholder="' + esc(placeholder) + '">' + (defaultVal ? esc(JSON.stringify(defaultVal, null, 2)) : '') + '</textarea>';
        } else {
          input = '<input type="text" data-field="' + esc(key) + '" value="' + esc(String(defaultVal)) + '" placeholder="' + esc(desc) + '">';
        }

        var descHtml = desc ? '<div class="field-desc">' + esc(desc) + '</div>' : '';

        html += '<div class="form-field">' + label + input + descHtml + '</div>';
      });

      formEl.innerHTML = html;
    }

    // --- Collect form values ---
    function collectFormValues() {
      var args = {};
      var fields = document.querySelectorAll('#inputForm [data-field]');
      fields.forEach(function(field) {
        var key = field.dataset.field;
        var type = field.dataset.type || 'string';
        var val;

        if (type === 'boolean') {
          val = field.checked;
        } else if (type === 'number') {
          val = field.value === '' ? undefined : Number(field.value);
        } else if (type === 'array' || type === 'object') {
          if (field.value.trim() === '') {
            val = undefined;
          } else {
            try {
              val = JSON.parse(field.value);
            } catch (e) {
              val = field.value; // send raw if invalid JSON
            }
          }
        } else {
          val = field.value === '' ? undefined : field.value;
        }

        if (val !== undefined) {
          args[key] = val;
        }
      });
      return args;
    }

    // --- Call tool ---
    async function callTool() {
      if (!activeTool || !activeServer) return;

      var btn = document.getElementById('callBtn');
      var spinner = document.getElementById('callSpinner');
      var durationEl = document.getElementById('callDuration');
      var errorEl = document.getElementById('callError');
      var resultSection = document.getElementById('resultSection');
      var resultJson = document.getElementById('resultJson');

      btn.disabled = true;
      spinner.style.display = 'inline-block';
      durationEl.textContent = '';
      errorEl.textContent = '';

      var args = collectFormValues();
      var start = performance.now();

      try {
        var res = await fetch('/api/mcp/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bot: currentBot,
            server: activeServer,
            tool: activeTool.name,
            arguments: args,
          }),
        });

        var elapsed = Math.round(performance.now() - start);
        durationEl.textContent = elapsed + 'ms';

        if (!res.ok) {
          var errData = await res.json().catch(function() { return {}; });
          throw new Error(errData.error || 'Call failed with status ' + res.status);
        }

        var result = await res.json();

        // Formatted view: extract text content with real newlines
        var formattedEl = document.getElementById('resultFormatted');
        if (result.content && Array.isArray(result.content)) {
          var texts = result.content
            .filter(function(c) { return c.type === 'text' && c.text; })
            .map(function(c) { return c.text; });
          formattedEl.textContent = texts.join(String.fromCharCode(10) + '---' + String.fromCharCode(10));
        } else {
          formattedEl.textContent = JSON.stringify(result, null, 2);
        }

        // Raw JSON view
        resultJson.textContent = JSON.stringify(result, null, 2);
        resultSection.style.display = 'block';
        switchResultTab('formatted');
      } catch (e) {
        errorEl.textContent = e.message;
        resultSection.style.display = 'none';
      } finally {
        btn.disabled = false;
        spinner.style.display = 'none';
      }
    }

    // Keyboard shortcut: Ctrl+Enter to call tool
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && activeTool) {
        callTool();
      }
    });
  </script>
</body>
</html>`;
}
