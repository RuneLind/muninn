/** MCP Debug — tool list sidebar */

export function mcpToolListStyles(): string {
  return `
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
  `;
}

export function mcpToolListScript(): string {
  return `
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
  `;
}
