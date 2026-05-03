// Connector selector functions — exported as a JS string for browser injection
// via connectorSelectorScript(). Injected INSIDE the CHAT_SCRIPT IIFE so it has
// access to IIFE-scoped variables (selectedBot, bots, threads, connectors,
// selectedUserId, activeThreadId, renderThreadList, updateInspector, escapeHtml,
// getBotInfo, etc.).

/** Returns all connector selector functions as a browser-compatible JS string. */
export function connectorSelectorScript(): string {
  return `
  // ── Connector dropdown ──────────────────────────────────────────────────

  var connectorDropdown = document.getElementById('connectorDropdown');
  var connectorSelector = document.getElementById('connectorSelector');
  var selectedConnectorId = '';  // '' = bot default

  // Sync preferred connector to DB so extensions (Jira plugin) and page reloads get the same selection
  function syncPreferredConnector(userId, botName, connectorId) {
    if (!userId || !botName) return;
    fetch('/chat/preferences/' + encodeURIComponent(userId) + '/' + encodeURIComponent(botName) + '/connector', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorId: connectorId || null }),
    }).catch(function() {});
  }

  function connectorStorageKey() {
    return 'muninn-connector-' + (selectedBot || 'default');
  }

  async function populateConnectorDropdown() {
    var bot = getBotInfo();
    var defaultLabel = 'Bot default';
    if (bot) {
      var dl = bot.connector || 'claude-cli';
      if (bot.model) dl += ' \\u00b7 ' + bot.model;
      defaultLabel = dl;
    }
    connectorDropdown.innerHTML = '<option value="">' + escapeHtml(defaultLabel) + '</option>';
    connectors.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      connectorDropdown.appendChild(opt);
    });
    connectorSelector.style.display = connectors.length > 0 ? '' : 'none';

    // Restore from DB (single source of truth), fall back to localStorage for migration
    selectedConnectorId = '';
    if (selectedUserId && selectedBot) {
      try {
        var prefRes = await fetch('/chat/preferences/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(selectedBot));
        if (prefRes.ok) {
          var prefData = await prefRes.json();
          if (prefData.connectorId) selectedConnectorId = prefData.connectorId;
        }
      } catch {}
    }
    // Fall back to localStorage if DB has no preference yet, and migrate to DB
    if (!selectedConnectorId) {
      try { selectedConnectorId = localStorage.getItem(connectorStorageKey()) || ''; } catch {}
      if (selectedConnectorId) {
        syncPreferredConnector(selectedUserId, selectedBot, selectedConnectorId);
      }
    }
    connectorDropdown.value = selectedConnectorId;
    if (connectorDropdown.value !== selectedConnectorId) {
      selectedConnectorId = '';
      connectorDropdown.value = '';
    }
  }

  // Stamp a connector on a thread (connectorId '' or null clears it → bot default).
  // When onlyIfEmpty=true, never overwrites an existing connector — used by the
  // deep-link and send-message paths so the Jira plugin's chosen connector
  // (already stamped on the thread) survives the sidebar's preferred-connector
  // default. The dropdown-change path passes onlyIfEmpty=false to allow the
  // user's explicit pick to override.
  async function stampConnectorOnThread(threadId, connectorId, onlyIfEmpty) {
    if (!threadId) return;
    var effectiveId = connectorId || null;
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId) {
        var current = threads[i].connectorId || null;
        if (current === effectiveId) return;
        if (onlyIfEmpty && current) return;
        break;
      }
    }
    try {
      await fetch('/chat/threads/' + encodeURIComponent(threadId) + '/connector', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId: effectiveId }),
      });
      // Update local thread data
      for (var j = 0; j < threads.length; j++) {
        if (threads[j].id === threadId) {
          threads[j].connectorId = effectiveId;
          threads[j].connectorName = null;
          if (effectiveId) {
            for (var k = 0; k < connectors.length; k++) {
              if (connectors[k].id === effectiveId) { threads[j].connectorName = connectors[k].name; break; }
            }
          }
          break;
        }
      }
      renderThreadList();
    } catch {}
  }

  connectorDropdown.addEventListener('change', function() {
    selectedConnectorId = connectorDropdown.value;
    try { localStorage.setItem(connectorStorageKey(), selectedConnectorId); } catch {}
    syncPreferredConnector(selectedUserId, selectedBot, selectedConnectorId);
    // Stamp the new connector on the active thread (or clear it if "Bot default")
    if (activeThreadId) {
      stampConnectorOnThread(activeThreadId, selectedConnectorId);
    }
    updateInspector();
  });

  function syncConnectorDropdown() {
    if (!connectors.length) return;

    // If active thread has its own connector, show that; otherwise show the sidebar selection
    var threadConnId = '';
    if (activeThreadId) {
      for (var i = 0; i < threads.length; i++) {
        if (threads[i].id === activeThreadId && threads[i].connectorId) {
          threadConnId = threads[i].connectorId;
          break;
        }
      }
    }

    if (threadConnId) {
      connectorDropdown.value = threadConnId;
    } else {
      connectorDropdown.value = selectedConnectorId;
    }
  }
  `;
}
