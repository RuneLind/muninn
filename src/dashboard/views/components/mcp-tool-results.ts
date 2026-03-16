/** MCP Debug — tool call execution and result display */

export function mcpToolResultsStyles(): string {
  return `
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
  `;
}

export function mcpToolResultsHtml(): string {
  // HTML is embedded inside the tool detail panel
  return ``;
}

export function mcpToolResultsScript(): string {
  return `
    function switchResultTab(tab) {
      var tabs = document.querySelectorAll('.result-tab');
      tabs.forEach(function(t) { t.classList.toggle('active', t.textContent.toLowerCase().indexOf(tab) >= 0); });
      document.getElementById('resultFormatted').style.display = tab === 'formatted' ? '' : 'none';
      document.getElementById('resultJson').style.display = tab === 'raw' ? '' : 'none';
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
  `;
}
