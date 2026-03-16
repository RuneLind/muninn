/** MCP Debug — tool detail panel: info, schema, input form, call button */

export function mcpToolDetailStyles(): string {
  return `
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
  `;
}

export function mcpToolDetailHtml(): string {
  return `
    <div class="right-panel">
      <div class="empty-state" id="emptyState">
        Select a bot and connect to an MCP server to explore tools
      </div>
      <div class="tool-detail" id="toolDetail" style="display:none">
        <h2 id="toolName"></h2>
        <div class="tool-mcp-name" id="toolMcpName"></div>
        <div class="tool-description" id="toolDescription"></div>

        <div class="schema-toggle" id="schemaToggle" onclick="toggleSchema()">
          &#9656; Input Schema
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
    </div>`;
}

export function mcpToolDetailScript(): string {
  return `
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
      document.getElementById('schemaToggle').textContent = '\\u25b8 Input Schema';

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
      toggle.textContent = (visible ? '\\u25be' : '\\u25b8') + ' Input Schema';
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
  `;
}
