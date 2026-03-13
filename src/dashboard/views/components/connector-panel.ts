/** Connector admin panel — CRUD for AI connector configurations */

export function connectorPanelStyles(): string {
  return `
    .connectors-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }
    .connector-card {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
      transition: border-color 0.2s;
    }
    .connector-card:hover {
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .connector-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .connector-card-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .connector-card-actions {
      display: flex;
      gap: 4px;
    }
    .connector-card-actions button {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      transition: all 0.15s;
    }
    .connector-card-actions button:hover {
      color: var(--text-primary);
      background: var(--bg-surface);
    }
    .connector-card-actions button.delete-btn:hover {
      color: var(--status-error);
      background: color-mix(in srgb, var(--status-error) 10%, transparent);
    }
    .connector-card-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .connector-card-desc:empty { display: none; }
    .connector-type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .connector-type-badge.claude-cli {
      background: color-mix(in srgb, var(--status-info) 15%, transparent);
      color: var(--status-info);
    }
    .connector-type-badge.copilot-sdk {
      background: color-mix(in srgb, var(--status-magenta) 15%, transparent);
      color: var(--status-magenta);
    }
    .connector-type-badge.openai-compat {
      background: color-mix(in srgb, var(--status-success) 15%, transparent);
      color: var(--status-success);
    }
    .connector-card-fields {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      font-size: 12px;
      margin-top: 10px;
    }
    .connector-field-label {
      color: var(--text-dim);
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.5px;
    }
    .connector-field-value {
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .connector-field-value.empty { color: var(--text-faint); font-style: italic; }
    .connectors-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .connectors-toolbar h3 {
      font-size: 16px;
      color: var(--text-primary);
      font-weight: 600;
    }
    .connector-add-btn {
      background: var(--accent);
      color: var(--text-primary);
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .connector-add-btn:hover { background: var(--accent-hover); }

    /* Connector modal */
    .connector-modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .connector-modal-backdrop.visible { display: flex; }
    .connector-modal {
      background: var(--bg-panel);
      border: 1px solid var(--border-secondary);
      border-radius: 12px;
      width: 90vw;
      max-width: 480px;
      padding: 0;
    }
    .connector-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-primary);
    }
    .connector-modal-header h3 { font-size: 14px; color: var(--text-primary); }
    .connector-modal-close {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      padding: 4px 8px;
    }
    .connector-modal-close:hover { color: var(--text-primary); }
    .connector-modal-body {
      padding: 16px 20px;
    }
    .connector-form-group {
      margin-bottom: 12px;
    }
    .connector-form-group label {
      display: block;
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .connector-form-group input,
    .connector-form-group select,
    .connector-form-group textarea {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
    }
    .connector-form-group input:focus,
    .connector-form-group select:focus,
    .connector-form-group textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .connector-form-group textarea { resize: vertical; min-height: 40px; }
    .connector-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 20px;
      border-top: 1px solid var(--border-primary);
    }
    .connector-modal-footer button {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border-secondary);
      background: var(--bg-surface);
      color: var(--text-secondary);
      transition: all 0.15s;
    }
    .connector-modal-footer button:hover {
      background: var(--bg-panel);
    }
    .connector-modal-footer button.primary {
      background: var(--accent);
      color: var(--text-primary);
      border-color: var(--accent);
    }
    .connector-modal-footer button.primary:hover {
      background: var(--accent-hover);
    }
    .connector-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-faint);
      font-size: 14px;
    }
  `;
}

export function connectorPanelHtml(): string {
  return `
    <div class="connectors-toolbar">
      <h3>Connectors <span class="count" id="connectorCount">0</span></h3>
      <button class="connector-add-btn" onclick="openConnectorModal()">+ New Connector</button>
    </div>
    <div class="connectors-grid" id="connectorsGrid">
      <div class="connector-empty">Loading connectors...</div>
    </div>
    <div class="connector-modal-backdrop" id="connectorModalBackdrop" onclick="closeConnectorModal(event)">
      <div class="connector-modal" onclick="event.stopPropagation()">
        <div class="connector-modal-header">
          <h3 id="connectorModalTitle">New Connector</h3>
          <button class="connector-modal-close" onclick="closeConnectorModal()">&times;</button>
        </div>
        <div class="connector-modal-body">
          <input type="hidden" id="connectorEditId">
          <div class="connector-form-group">
            <label>Name *</label>
            <input type="text" id="connectorName" placeholder="e.g. Claude Opus, Ollama Qwen 3.5">
          </div>
          <div class="connector-form-group">
            <label>Description</label>
            <textarea id="connectorDesc" rows="2" placeholder="Optional description"></textarea>
          </div>
          <div class="connector-form-group">
            <label>Type *</label>
            <select id="connectorType">
              <option value="claude-cli">claude-cli</option>
              <option value="copilot-sdk">copilot-sdk</option>
              <option value="openai-compat">openai-compat</option>
            </select>
          </div>
          <div class="connector-form-group">
            <label>Model</label>
            <input type="text" id="connectorModel" placeholder="e.g. claude-sonnet-4-6, qwen3.5:35b">
          </div>
          <div class="connector-form-group">
            <label>Base URL</label>
            <input type="text" id="connectorBaseUrl" placeholder="e.g. http://localhost:11434/v1">
          </div>
          <div class="connector-form-group">
            <label>Thinking Max Tokens</label>
            <input type="number" id="connectorThinking" placeholder="0 = disable">
          </div>
          <div class="connector-form-group">
            <label>Timeout (ms)</label>
            <input type="number" id="connectorTimeout" placeholder="e.g. 120000">
          </div>
        </div>
        <div class="connector-modal-footer">
          <button onclick="closeConnectorModal()">Cancel</button>
          <button class="primary" onclick="saveConnector()">Save</button>
        </div>
      </div>
    </div>
  `;
}

export function connectorPanelScript(): string {
  return `
    var connectorsData = [];
    var connectorsLoaded = false;

    function typeClass(type) {
      return type.replace(/[^a-z-]/g, '');
    }

    async function loadConnectors() {
      try {
        var res = await fetch('/api/connectors');
        var data = await res.json();
        connectorsData = data.connectors || [];
        updateTabCount('connectors', connectorsData.length);
        document.getElementById('connectorCount').textContent = connectorsData.length;
        renderConnectors();
        connectorsLoaded = true;
      } catch (err) {
        document.getElementById('connectorsGrid').innerHTML =
          '<div class="connector-empty">Failed to load connectors</div>';
      }
    }

    function renderConnectors() {
      var grid = document.getElementById('connectorsGrid');
      if (connectorsData.length === 0) {
        grid.innerHTML = '<div class="connector-empty">No connectors configured. Click "+ New Connector" to create one.</div>';
        return;
      }

      grid.innerHTML = connectorsData.map(function(c) {
        var desc = c.description ? '<div class="connector-card-desc">' + esc(c.description) + '</div>' : '';
        var fields = '';
        if (c.model) fields += '<div class="connector-field-label">Model</div><div class="connector-field-value">' + esc(c.model) + '</div>';
        if (c.baseUrl) fields += '<div class="connector-field-label">URL</div><div class="connector-field-value">' + esc(c.baseUrl) + '</div>';
        if (c.thinkingMaxTokens != null) fields += '<div class="connector-field-label">Thinking</div><div class="connector-field-value">' + c.thinkingMaxTokens + '</div>';
        if (c.timeoutMs != null) fields += '<div class="connector-field-label">Timeout</div><div class="connector-field-value">' + c.timeoutMs + 'ms</div>';

        return '<div class="connector-card">'
          + '<div class="connector-card-header">'
            + '<div class="connector-card-name">' + esc(c.name) + '</div>'
            + '<div class="connector-card-actions">'
              + '<button onclick="editConnector(\\'' + c.id + '\\')">Edit</button>'
              + '<button class="delete-btn" onclick="deleteConnectorById(\\'' + c.id + '\\')">Delete</button>'
            + '</div>'
          + '</div>'
          + desc
          + '<span class="connector-type-badge ' + typeClass(c.connectorType) + '">' + esc(c.connectorType) + '</span>'
          + (fields ? '<div class="connector-card-fields">' + fields + '</div>' : '')
        + '</div>';
      }).join('');
    }

    function openConnectorModal(connector) {
      document.getElementById('connectorEditId').value = connector ? connector.id : '';
      document.getElementById('connectorName').value = connector ? connector.name : '';
      document.getElementById('connectorDesc').value = connector ? (connector.description || '') : '';
      document.getElementById('connectorType').value = connector ? connector.connectorType : 'claude-cli';
      document.getElementById('connectorModel').value = connector ? (connector.model || '') : '';
      document.getElementById('connectorBaseUrl').value = connector ? (connector.baseUrl || '') : '';
      document.getElementById('connectorThinking').value = connector && connector.thinkingMaxTokens != null ? connector.thinkingMaxTokens : '';
      document.getElementById('connectorTimeout').value = connector && connector.timeoutMs != null ? connector.timeoutMs : '';
      document.getElementById('connectorModalTitle').textContent = connector ? 'Edit Connector' : 'New Connector';
      document.getElementById('connectorModalBackdrop').classList.add('visible');
      document.getElementById('connectorName').focus();
    }

    function closeConnectorModal(event) {
      if (event && event.target !== event.currentTarget) return;
      document.getElementById('connectorModalBackdrop').classList.remove('visible');
    }

    function editConnector(id) {
      var c = connectorsData.find(function(x) { return x.id === id; });
      if (c) openConnectorModal(c);
    }

    async function saveConnector() {
      var editId = document.getElementById('connectorEditId').value;
      var name = document.getElementById('connectorName').value.trim();
      var desc = document.getElementById('connectorDesc').value.trim() || null;
      var connType = document.getElementById('connectorType').value;
      var model = document.getElementById('connectorModel').value.trim() || null;
      var baseUrl = document.getElementById('connectorBaseUrl').value.trim() || null;
      var thinking = document.getElementById('connectorThinking').value;
      var timeout = document.getElementById('connectorTimeout').value;

      if (!name) { alert('Name is required'); return; }

      var body = {
        name: name,
        description: desc,
        connectorType: connType,
        model: model,
        baseUrl: baseUrl,
        thinkingMaxTokens: thinking ? parseInt(thinking) : null,
        timeoutMs: timeout ? parseInt(timeout) : null,
      };

      try {
        var url = editId ? '/api/connectors/' + editId : '/api/connectors';
        var method = editId ? 'PUT' : 'POST';
        var res = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var data = await res.json();
        if (data.error) { alert(data.error); return; }
        closeConnectorModal();
        loadConnectors();
      } catch (err) {
        alert('Failed to save connector: ' + err.message);
      }
    }

    async function deleteConnectorById(id) {
      var c = connectorsData.find(function(x) { return x.id === id; });
      if (!c) return;
      if (!confirm('Delete connector "' + c.name + '"?')) return;
      try {
        var res = await fetch('/api/connectors/' + id, { method: 'DELETE' });
        var data = await res.json();
        if (data.error) { alert(data.error); return; }
        loadConnectors();
      } catch (err) {
        alert('Failed to delete connector: ' + err.message);
      }
    }

    // Escape key closes connector modal
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeConnectorModal();
    });

    // Lazy init: load connectors when tab is first activated
    onSectionActivate('connectors', function() {
      if (!connectorsLoaded) loadConnectors();
    });
  `;
}
