import { SHARED_STYLES, renderNav } from "../../dashboard/views/shared-styles.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "../../dashboard/views/components/agent-status-ui.ts";
import { requestProgressStyles, requestProgressHtml, requestProgressScript } from "../../dashboard/views/components/request-progress-ui.ts";
import { botSelectorStyles, botSelectorHtml } from "../../dashboard/views/components/bot-selector.ts";
import { helpersScript } from "../../dashboard/views/components/helpers.ts";
import { docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "../../dashboard/views/components/doc-panel.ts";
import { chatStyles } from "./components/chat-styles.ts";
import { webFormatClientScript } from "./components/web-format-client.ts";
import { inspectorPanelScript } from "./components/inspector-panel.ts";

export function renderChatPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn Chat</title>
  <style>
    ${SHARED_STYLES}
    ${agentStatusStyles()}
    ${requestProgressStyles()}
    ${botSelectorStyles()}
    ${chatStyles()}
    ${docPanelStyles("docSlideIn")}
  </style>
</head>
<body>
  ${renderNav("chat", { headerLeftExtra: agentStatusHtml() + botSelectorHtml() })}

  <div class="sim-layout">
    <!-- Left: Threads sidebar -->
    <div class="sim-sidebar">
      <div class="sidebar-user-selector" id="userSelectorContainer" style="display:none">
        <label>User</label>
        <select id="userSelector"></select>
      </div>
      <div class="sidebar-connector" id="connectorSelector" style="display:none">
        <label>Model</label>
        <select id="connectorDropdown"></select>
      </div>
      <div class="sidebar-header">
        <h3>Threads</h3>
        <button class="new-thread-btn" id="newThreadBtn">+ New Thread</button>
      </div>
      <div class="thread-list" id="threadList">
        <div class="empty-state">Select a bot</div>
      </div>
    </div>

    <!-- Center: Chat view -->
    <div class="sim-chat">
      <div class="chat-header" id="chatHeader">
        <div class="chat-header-left">
          <span class="chat-title">Select a thread</span>
          <div class="chat-description" id="chatDescription"></div>
        </div>
        <span class="chat-status" id="chatStatus"></span>
      </div>
      <div class="chat-body">
        ${requestProgressHtml()}
        <div class="chat-messages" id="chatMessages">
          <div class="empty-state">Select a thread from the sidebar</div>
        </div>
      </div>
      <div class="chat-input">
        <textarea id="chatInput" placeholder="Type a message..." rows="1" disabled></textarea>
        <button id="chatSend" disabled>Send</button>
      </div>
    </div>

    <!-- Right: Inspector -->
    <div class="sim-inspector">
      <div id="inspectorContent">
        <div class="empty-state">Select a thread</div>
      </div>
      <div id="inspectorContext"></div>
      <div id="inspectorToolUsage"></div>
    </div>
  </div>

  <!-- Thread creation modal -->
  <div class="thread-modal-backdrop" id="threadModalBackdrop">
    <div class="thread-modal" onclick="event.stopPropagation()">
      <div class="thread-modal-header">
        <h3>New Thread</h3>
        <button class="thread-modal-close" id="threadModalClose">&times;</button>
      </div>
      <div class="thread-modal-body">
        <div class="thread-form-group">
          <label>Name *</label>
          <input type="text" id="threadModalName" placeholder="Thread name" maxlength="50">
        </div>
        <div class="thread-form-group">
          <label>Description</label>
          <input type="text" id="threadModalDesc" placeholder="Optional description">
        </div>
        <div class="thread-form-group">
          <label>Connector</label>
          <select id="threadModalConnector">
            <option value="">Bot default</option>
          </select>
          <div class="thread-form-hint" id="threadConnectorHint"></div>
        </div>
      </div>
      <div class="thread-modal-footer">
        <button class="thread-modal-cancel" id="threadModalCancel">Cancel</button>
        <button class="thread-modal-save" id="threadModalSave">Create</button>
      </div>
    </div>
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    ${helpersScript()}
    ${agentStatusScript()}
    ${requestProgressScript()}
    ${webFormatClientScript()}
    ${CHAT_SSE_SCRIPT}
    ${CHAT_SCRIPT}
  </script>
</body>
</html>`;
}

/** Minimal SSE connection — subscribes to agent_status + request_progress events */
const CHAT_SSE_SCRIPT = `
(function() {
  var autoDismissTimer = null;
  var autoDismissInner = null;

  function clearAutoDismissTimers() {
    clearTimeout(autoDismissTimer);
    clearTimeout(autoDismissInner);
    autoDismissTimer = null;
    autoDismissInner = null;
  }

  function connectSSE() {
    var es = new EventSource('/api/events');

    es.addEventListener('agent_status', function(e) {
      updateAgentStatus(JSON.parse(e.data));
    });

    es.addEventListener('request_progress', function(e) {
      var data = JSON.parse(e.data);
      updateRequestProgress(data);
      // Auto-dismiss completed progress after 8s
      if (data && data.completed) {
        clearAutoDismissTimers();
        autoDismissTimer = setTimeout(function() {
          var panel = document.getElementById('requestProgress');
          if (panel && panel.classList.contains('completed')) {
            panel.classList.add('auto-dismiss');
            autoDismissInner = setTimeout(function() {
              panel.classList.remove('visible', 'completed', 'auto-dismiss');
              panel.innerHTML = '';
            }, 350);
          }
        }, 8000);
      } else if (data) {
        clearAutoDismissTimers();
        var panel = document.getElementById('requestProgress');
        if (panel) panel.classList.remove('auto-dismiss');
      }
    });

    es.onerror = function() {
      es.close();
      setTimeout(connectSSE, 3000);
    };
  }

  // Wrap dismissRequestProgress to also clear auto-dismiss timers
  var _origDismiss = dismissRequestProgress;
  dismissRequestProgress = function() {
    clearAutoDismissTimers();
    _origDismiss();
  };

  connectSSE();
})();
`;

const CHAT_SCRIPT = `
(function() {
  // Avatar color from name
  var _avatarPalette = [
    '#6c63ff', '#7c6cef', '#5b8def', '#4da8da', '#4ade80',
    '#34d399', '#f59e0b', '#f97316', '#ef4444', '#ec4899',
    '#a78bfa', '#8b5cf6', '#06b6d4', '#14b8a6', '#84cc16',
  ];
  function avatarColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return _avatarPalette[Math.abs(h) % _avatarPalette.length];
  }
  function avatarStyle(name) {
    var c = avatarColor(name);
    return 'background:' + c + ';box-shadow:0 0 0 1px rgba(255,255,255,0.08),inset 0 1px 0 rgba(255,255,255,0.15)';
  }

  // State
  var conversations = {};       // Still needed for WS routing
  var activeConvId = null;      // 1:1 with selected user+bot binding
  var activeThreadId = null;    // Currently selected thread
  var isResearchThread = false; // True when active thread has a research card
  var researchBotReplies = 0;   // Counts bot replies in research thread (actions shown after first)
  var researchIssueKey = null;  // Extracted issue key (e.g. "MELOSYS-7546")
  var reportExists = false;     // Whether a saved report file exists for current issue
  var threads = [];             // Thread list for current user+bot
  var bots = [];
  // Suppress waterfall until we know the selected bot's config
  window._suppressWaterfall = true;
  var activeToolContainer = null;  // Current tool-activity container for live tool events
  var activeToolCount = 0;         // Tool count in the active container
  var connectors = [];  // Available connectors from DB
  var ws = null;
  var deepLinkHandled = false;
  var inspectorContextKey = null;
  var lastResponseMeta = {};    // Per-conversationId last response_meta
  var selectedBot = '';         // From bot pills (localStorage-synced)
  var selectedUserId = null;    // Resolved from config for selected bot
  var selectedUsername = null;   // Display name

  // Bot selector init (synced with dashboard/traces/logs via localStorage)
  try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}

  // DOM refs
  var threadList = document.getElementById('threadList');
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var chatHeader = document.getElementById('chatHeader');
  var chatStatus = document.getElementById('chatStatus');
  var inspectorToolUsage = document.getElementById('inspectorToolUsage');
  var inspectorContent = document.getElementById('inspectorContent');
  var inspectorContext = document.getElementById('inspectorContext');

  // ── Inspector panel functions (from inspector-panel.ts) ──
  ${inspectorPanelScript()}

  async function loadBotList() {
    try {
      var res = await fetch('/chat/bots').then(function(r) { return r.json(); });
      bots = res.bots || [];
      connectors = res.connectors || [];

      var container = document.getElementById('botSelector');
      var botNames = bots.map(function(b) { return b.name; });

      // No "All Bots" pill — a bot must always be selected
      container.innerHTML = bots.map(function(b) {
        var tip = b.connector || 'claude-cli';
        if (b.model) tip += ' · ' + b.model;
        return '<button class="bot-pill' + (selectedBot === b.name ? ' active' : '') + '" data-bot="' + escapeAttr(b.name) + '" title="' + escapeAttr(tip) + '">' + escapeHtml(b.name.charAt(0).toUpperCase() + b.name.slice(1)) + '</button>';
      }).join('');

      return botNames;
    } catch { return []; }
  }

  async function selectBot(name, autoSelectThreadId) {
    selectedBot = name;
    try { localStorage.setItem('muninn-selected-bot', name); } catch {}

    // Set global waterfall suppression flag for this bot
    var bot = bots.find(function(b) { return b.name === name; });
    window._suppressWaterfall = bot && bot.showWaterfall === false;
    // Dismiss any visible waterfall when switching to a no-waterfall bot
    if (window._suppressWaterfall) dismissRequestProgress();
    document.querySelectorAll('.bot-pill').forEach(function(p) {
      p.classList.toggle('active', p.dataset.bot === name);
    });

    // Load users for this bot and populate selector
    await loadUsersForBot(name);

    // Update connector dropdown (bot default label changes per bot)
    await populateConnectorDropdown();

    // Resolve or create conversation for this user+bot
    await resolveConversation();

    // Clear thread selection, load threads, clear chat
    activeThreadId = null;
    clearChat();
    await loadThreads(autoSelectThreadId);
  }

  async function loadUsersForBot(botName) {
    var container = document.getElementById('userSelectorContainer');
    var selector = document.getElementById('userSelector');

    // Fetch users from DB
    var merged = [];
    try {
      var res = await fetch('/api/users?bot=' + encodeURIComponent(botName));
      var data = await res.json();
      (data.users || []).forEach(function(u) {
        merged.push({ id: u.userId, name: u.username || u.userId });
      });
    } catch {}

    if (merged.length === 0) {
      container.style.display = 'none';
      selectedUserId = null;
      selectedUsername = null;
      return;
    }

    container.style.display = 'flex';

    // Restore last selected user for this bot
    var storedUserId = null;
    try { storedUserId = localStorage.getItem('muninn-chat-user-' + botName); } catch {}

    selector.innerHTML = merged.map(function(u) {
      return '<option value="' + escapeAttr(u.id) + '"' +
        (u.id === storedUserId ? ' selected' : '') +
        '>' + escapeHtml(u.name) + '</option>';
    }).join('');

    // Select stored or first
    var match = storedUserId && merged.find(function(u) { return u.id === storedUserId; });
    var active = match || merged[0];
    selector.value = active.id;
    selectedUserId = active.id;
    selectedUsername = active.name;
    try { localStorage.setItem('muninn-chat-user-' + botName, active.id); } catch {}
  }


  async function resolveConversation() {
    if (!selectedBot || !selectedUserId) {
      activeConvId = null;
      return;
    }
    // Always use a 'web' type conversation so messages get web HTML formatting.
    // Other platform conversations (telegram_dm, slack_*) may exist from hydration
    // but should not be used for the web chat UI.
    var convs = Object.values(conversations);
    for (var i = 0; i < convs.length; i++) {
      if (convs[i].userId === selectedUserId && convs[i].botName === selectedBot && convs[i].type === 'web') {
        activeConvId = convs[i].id;
        return;
      }
    }
    // Create a web conversation if not found
    activeConvId = null;
    try {
      var res = await fetch('/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'web', botName: selectedBot, userId: selectedUserId, username: selectedUsername || 'user' }),
      });
      var data = await res.json();
      if (data.conversation) {
        conversations[data.conversation.id] = data.conversation;
        activeConvId = data.conversation.id;
      }
    } catch {}
  }

  document.getElementById('botSelector').addEventListener('click', function(e) {
    var pill = e.target.closest('.bot-pill');
    if (pill) selectBot(pill.dataset.bot);
  });

  // Sync preferred connector to DB so extensions (Jira plugin) and page reloads get the same selection
  function syncPreferredConnector(userId, botName, connectorId) {
    if (!userId || !botName) return;
    fetch('/chat/preferences/' + encodeURIComponent(userId) + '/' + encodeURIComponent(botName) + '/connector', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectorId: connectorId || null }),
    }).catch(function() {});
  }

  // User selector change
  document.getElementById('userSelector').addEventListener('change', async function(e) {
    var userId = e.target.value;
    var opt = e.target.selectedOptions[0];
    selectedUserId = userId;
    selectedUsername = opt ? opt.textContent : userId;
    try { localStorage.setItem('muninn-chat-user-' + selectedBot, userId); } catch {}
    // Re-resolve conversation, threads, and connector preference for new user
    await resolveConversation();
    activeThreadId = null;
    clearChat();
    await loadThreads();
    await populateConnectorDropdown();
  });

  // New thread creation — modal
  var threadModal = document.getElementById('threadModalBackdrop');
  var threadModalName = document.getElementById('threadModalName');
  var threadModalDesc = document.getElementById('threadModalDesc');
  var threadModalConnector = document.getElementById('threadModalConnector');
  var threadConnectorHint = document.getElementById('threadConnectorHint');

  function openThreadModal() {
    if (!selectedBot || !selectedUserId) return;
    threadModalName.value = '';
    threadModalDesc.value = '';
    // Populate connector dropdown
    threadModalConnector.innerHTML = '<option value="">Bot default</option>';
    connectors.forEach(function(c) {
      var label = c.name;
      if (c.model) label += ' (' + c.model + ')';
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = label;
      threadModalConnector.appendChild(opt);
    });
    // Pre-fill from sidebar connector selection
    threadModalConnector.value = selectedConnectorId;
    threadModalConnector.dispatchEvent(new Event('change'));
    threadModal.classList.add('visible');
    threadModalName.focus();
  }

  function closeThreadModal() {
    threadModal.classList.remove('visible');
  }

  threadModalConnector.addEventListener('change', function() {
    var id = threadModalConnector.value;
    if (!id) { threadConnectorHint.textContent = ''; return; }
    var c = connectors.find(function(x) { return x.id === id; });
    if (c) {
      var hint = c.connectorType;
      if (c.model) hint += ' · ' + c.model;
      threadConnectorHint.textContent = hint;
    }
  });

  function submitThreadModal() {
    var name = threadModalName.value.trim();
    if (!name) { alert('Thread name is required'); return; }
    var desc = threadModalDesc.value.trim() || undefined;
    var connId = threadModalConnector.value || undefined;

    fetch('/chat/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: selectedUserId,
        botName: selectedBot,
        name: name,
        description: desc,
        connectorId: connId,
      }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) {
        alert('Failed to create thread: ' + data.error);
        return;
      }
      closeThreadModal();
      if (data.thread) {
        loadThreads(data.thread.id);
      }
    }).catch(function() { alert('Failed to create thread'); });
  }

  document.getElementById('newThreadBtn').onclick = openThreadModal;
  document.getElementById('threadModalClose').onclick = closeThreadModal;
  document.getElementById('threadModalCancel').onclick = closeThreadModal;
  document.getElementById('threadModalSave').onclick = submitThreadModal;
  threadModal.onclick = function(e) { if (e.target === threadModal) closeThreadModal(); };
  threadModalName.addEventListener('keydown', function(e) { if (e.key === 'Enter') submitThreadModal(); });

  // Thread list
  async function loadThreads(autoSelectThreadId) {
    if (!selectedUserId || !selectedBot) {
      threadList.innerHTML = '<div class="empty-state">Select a bot</div>';
      return;
    }

    try {
      var res = await fetch('/chat/threads/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(selectedBot));
      var data = await res.json();
      threads = data.threads || [];
    } catch {
      threads = [];
    }

    // DB sorts by last_activity DESC NULLS LAST — threads with
    // messages first (most recent activity on top), empty threads at bottom.

    // Threads should always exist (created during hydration), but handle edge case
    if (threads.length === 0) {
      threadList.innerHTML = '<div class="empty-state">No threads</div>';
      return;
    }

    // Auto-select (selectThread calls renderThreadList internally)
    if (autoSelectThreadId) {
      selectThread(autoSelectThreadId);
    } else if (!activeThreadId) {
      // Select the most recently active thread (first in the list, already sorted by activity)
      if (threads.length > 0) {
        selectThread(threads[0].id);
      } else {
        renderThreadList();
      }
    } else {
      renderThreadList();
    }
  }

  function renderThreadList() {
    if (threads.length === 0) {
      threadList.innerHTML = '<div class="empty-state">No threads</div>';
      return;
    }

    threadList.innerHTML = threads.map(function(t) {
      var isActive = t.id && t.id === activeThreadId;
      var icon = t.name === 'main' ? '#' : '&bull;';
      var meta = '';
      if (t.messageCount > 0) meta += t.messageCount + ' msgs';

      var deleteBtn = t.name !== 'main'
        ? '<button class="thread-item-delete" data-delete-id="' + escapeAttr(t.id || '') + '" title="Delete thread" tabindex="-1">&times;</button>'
        : '';

      return '<div class="thread-item' + (isActive ? ' active' : '') + '" data-id="' + escapeAttr(t.id || '') + '">'
        + '<div class="thread-item-icon">' + icon + '</div>'
        + '<div class="thread-item-content">'
          + '<div class="thread-item-name">' + escapeHtml(t.name) + '</div>'
          + (t.description ? '<div class="thread-item-desc">' + escapeHtml(t.description) + '</div>' : '')
          + (t.connectorName ? '<div class="thread-item-model">' + escapeHtml(t.connectorName) + '</div>' : '')
          + (meta ? '<div class="thread-item-meta">' + meta + '</div>' : '')
        + '</div>'
        + (t.updatedAt ? '<div class="thread-item-time">' + escapeHtml(timeAgo(t.updatedAt)) + '</div>' : '')
        + deleteBtn
        + '</div>';
    }).join('');

    threadList.querySelectorAll('.thread-item').forEach(function(el) {
      el.onclick = function() {
        var tid = el.dataset.id;
        if (tid) selectThread(tid);
      };
    });

    threadList.querySelectorAll('.thread-item-delete').forEach(function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        var threadId = btn.dataset.deleteId;
        if (!threadId) return;
        var threadName = '';
        for (var i = 0; i < threads.length; i++) {
          if (threads[i].id === threadId) { threadName = threads[i].name; break; }
        }
        if (!confirm('Delete thread "' + threadName + '" and all its messages?')) return;
        fetch('/chat/threads/' + encodeURIComponent(threadId), { method: 'DELETE' })
          .then(function(res) {
            if (!res.ok) throw new Error('Failed to delete');
            threads = threads.filter(function(t) { return t.id !== threadId; });
            if (activeThreadId === threadId) {
              var mainThread = threads.find(function(t) { return t.name === 'main'; });
              if (mainThread) { selectThread(mainThread.id); }
              else { clearChat(); renderThreadList(); }
            } else {
              renderThreadList();
            }
          })
          .catch(function() { alert('Could not delete thread'); });
      };
    });
  }

  function selectThread(threadId) {
    activeThreadId = threadId;

    // Update header
    var threadName = 'main';
    var threadDesc = '';
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId) { threadName = threads[i].name; threadDesc = threads[i].description || ''; break; }
    }
    chatHeader.querySelector('.chat-title').textContent =
      (selectedUsername || 'user') + ' \\u00b7 ' + selectedBot + ' \\u00b7 ' + threadName;
    document.getElementById('chatDescription').textContent = threadDesc;
    syncConnectorDropdown();

    // Highlight in sidebar
    renderThreadList();

    // Enable input
    chatInput.disabled = false;
    chatSend.disabled = false;

    // Load messages
    loadThreadMessages(threadId);

    // Update inspector
    updateInspector();
  }

  function clearChat() {
    chatMessages.innerHTML = '<div class="empty-state">Select a thread from the sidebar</div>';
    chatInput.disabled = true;
    chatSend.disabled = true;
    chatHeader.querySelector('.chat-title').textContent = 'Select a thread';
    document.getElementById('chatDescription').textContent = '';
    connectorDropdown.value = selectedConnectorId;
    setChatStatusText('');
    // Reset streaming state so stale text doesn't leak into next thread
    streamingRawText = '';
    streamingRafPending = false;
  }

  // WebSocket connection
  function connectWs() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/chat/ws');
    ws.onmessage = function(e) {
      try { handleWsEvent(JSON.parse(e.data)); }
      catch (err) { console.warn('Failed to parse WS message:', err); }
    };
    ws.onclose = function() { setTimeout(connectWs, 2000); };
  }

  async function handleWsEvent(event) {
    if (event.type === 'snapshot') {
      for (var i = 0; i < event.conversations.length; i++) {
        var conv = event.conversations[i];
        conversations[conv.id] = conv;
      }
      // After snapshot, resolve conversation if bot is selected
      if (selectedBot) await resolveConversation();
      if (!deepLinkHandled) {
        deepLinkHandled = true;
        await handleDeepLink();
      }
      return;
    }

    if (event.type === 'conversation_created') {
      conversations[event.conversation.id] = event.conversation;
      // If this matches our current user+bot, set as active
      if (event.conversation.userId === selectedUserId && event.conversation.botName === selectedBot) {
        activeConvId = event.conversation.id;
      }
      return;
    }

    if (event.type === 'message') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.messages.push(event.message);
        if (event.conversationId === activeConvId) {
          // Only append if the message belongs to the active thread
          var msgThread = event.message.threadId || null;
          if (!activeThreadId || msgThread === activeThreadId) {
            if (event.message.sender === 'bot') {
              collapseToolActivity();
              removeIntermediates();
              removeStreamingBubble();
              setChatStatusText('');
              conv.status = '';
            }
            appendMessage(event.message, conv.type);
          }
          updateInspector();
        }
        // Update in-memory thread message count so sidebar stays current
        var msgThreadId = event.message.threadId || null;
        var countTarget = msgThreadId;
        // Messages with null threadId belong to "main" thread
        if (!countTarget) {
          for (var mi = 0; mi < threads.length; mi++) {
            if (threads[mi].name === 'main') { countTarget = threads[mi].id; break; }
          }
        }
        if (countTarget) {
          for (var ti = 0; ti < threads.length; ti++) {
            if (threads[ti].id === countTarget) {
              threads[ti].messageCount = (threads[ti].messageCount || 0) + 1;
              break;
            }
          }
        }
        renderThreadList();
      }
      return;
    }

    if (event.type === 'text_delta') {
      if (event.conversationId !== activeConvId) return;
      var deltaThread = event.threadId || null;
      if (activeThreadId && deltaThread !== activeThreadId) return;
      // Dismiss waterfall when text is streaming — it slides back on next tool call
      dismissRequestProgress();
      appendStreamingDelta(event.delta);
      return;
    }

    if (event.type === 'stream_clear') {
      if (event.conversationId !== activeConvId) return;
      var clearThread = event.threadId || null;
      if (activeThreadId && clearThread !== activeThreadId) return;
      promoteStreamingBubble();
      return;
    }

    if (event.type === 'intent') {
      if (event.conversationId !== activeConvId) return;
      var intentThread = event.threadId || null;
      if (activeThreadId && intentThread !== activeThreadId) return;
      showIntentBubble(event.text);
      return;
    }

    if (event.type === 'tool_status') {
      if (event.conversationId !== activeConvId) return;
      var tsThread = event.threadId || null;
      if (activeThreadId && tsThread !== activeThreadId) return;
      appendToolStatus(event.text);
      return;
    }

    if (event.type === 'response_meta') {
      if (event.conversationId !== activeConvId) return;
      var rmThread = event.threadId || null;
      if (activeThreadId && rmThread !== activeThreadId) return;
      showResponseMeta(event);
      return;
    }

    if (event.type === 'status') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.status = event.status;
        if (event.conversationId === activeConvId) {
          setChatStatusText(event.status || '');
          if (!event.status) {
            collapseToolActivity();
            removeIntermediates();
            removeStreamingBubble();
            dismissRequestProgress();
          }
          updateTypingIndicator(event.status);
        }
      }
      return;
    }
  }

  // Deep-link: /chat?bot=jarvis&thread=<id>&user=<userId>
  async function handleDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var botName = params.get('bot');
    var threadParam = params.get('thread');
    var userParam = params.get('user');
    if (!botName) return;

    // If a user is specified in the URL, pre-set it before selectBot loads users
    if (userParam) {
      try { localStorage.setItem('muninn-chat-user-' + botName, userParam); } catch {}
    }

    await selectBot(botName, threadParam || undefined);

    // Check for pending research message (e.g. from Chrome extension)
    if (threadParam && activeConvId && activeThreadId) {
      // Stamp connector from sidebar selection if thread has none
      if (selectedConnectorId) {
        await stampConnectorOnThread(activeThreadId, selectedConnectorId);
      }
      try {
        var pendingRes = await fetch('/chat/pending/' + encodeURIComponent(threadParam));
        var pendingData = await pendingRes.json();
        if (pendingData.text) {
          chatInput.value = pendingData.text;
          sendMessage();
        }
      } catch {}
    }
  }

  // Send message (optional connector override for routing through a specific AI backend)
  var pendingConnector = null;
  async function sendMessage() {
    if (!activeConvId || !activeThreadId || !chatInput.value.trim()) return;

    // Dismiss research action buttons when sending any message
    var researchActions = chatMessages.querySelector('.research-actions');
    if (researchActions) researchActions.remove();

    // Stamp connector from sidebar selection if thread has none
    if (selectedConnectorId) {
      await stampConnectorOnThread(activeThreadId, selectedConnectorId);
    }

    var text = chatInput.value.trim();
    chatInput.value = '';
    chatInput.style.height = 'auto';
    var payload = { text: text, threadId: activeThreadId };
    if (pendingConnector) {
      payload.connector = pendingConnector;
      pendingConnector = null;
    }
    await fetch('/chat/conversations/' + activeConvId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // Load messages filtered by thread from DB
  async function loadThreadMessages(threadId) {
    if (!activeConvId) return;
    activeThreadId = threadId || null;
    // Reset streaming, research, and tool activity state when switching threads
    streamingRawText = '';
    streamingRafPending = false;
    activeToolContainer = null;
    activeToolCount = 0;
    isResearchThread = false;
    researchBotReplies = 0;
    researchIssueKey = null;
    reportExists = false;
    try {
      var url = '/chat/conversations/' + activeConvId + '/messages';
      if (threadId) url += '?thread=' + encodeURIComponent(threadId);
      var res = await fetch(url);
      var data = await res.json();
      var msgs = data.messages || [];

      var conv = conversations[activeConvId];
      chatMessages.innerHTML = '';

      // Cross-platform banner for non-web conversations
      if (conv && conv.type !== 'web') {
        var banner = document.createElement('div');
        banner.className = 'cross-platform-banner';
        banner.textContent = 'Conversation from ' + typePlatformLabel(conv.type) + ' \\u2014 replies sent via web';
        chatMessages.appendChild(banner);
      }

      for (var i = 0; i < msgs.length; i++) {
        appendMessage(msgs[i], conv ? conv.type : 'web');
      }
      scrollToBottom();
    } catch {
      chatMessages.innerHTML = '<div class="empty-state">Failed to load messages</div>';
    }
  }

  function typePlatformLabel(type) {
    switch(type) {
      case 'telegram_dm': return 'Telegram';
      case 'slack_dm': return 'Slack DM';
      case 'slack_channel': return 'Slack Channel';
      case 'slack_assistant': return 'Slack Assistant';
      case 'web': return 'Web';
      default: return type;
    }
  }

  // Append a single message to the chat
  var RESEARCH_MARKER = '<!-- research:jira -->';

  function parseResearchContent(text) {
    // Extract prompt instruction and Jira content, split by --- separator
    var parts = text.split('\\n---\\n');
    var promptInstruction = '';
    var jiraContent;
    if (parts.length > 1) {
      promptInstruction = parts[0].replace(RESEARCH_MARKER, '').trim();
      jiraContent = parts.slice(1).join('\\n---\\n').trim();
    } else {
      jiraContent = text.replace(RESEARCH_MARKER, '').trim();
    }
    // Extract issue key (e.g. "MELOSYS-7546") from content — may appear after # heading prefix
    var issueKey = null;
    var keyMatch = jiraContent.match(/^(?:#+ *)?([A-Z]+-\\d+)/);
    if (keyMatch) issueKey = keyMatch[1];
    // Extract title from first heading or line
    var lines = jiraContent.split('\\n');
    var title = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.startsWith('#')) { title = line.replace(/^#+\\s*/, ''); break; }
      if (line) { title = line.length > 80 ? line.slice(0, 77) + '...' : line; break; }
    }
    return { title: title || 'Jira Task', content: jiraContent, issueKey: issueKey, prompt: promptInstruction };
  }

  function renderResearchCard(parsed) {
    var renderedBody = sanitizeHtml(formatWebHtml(parsed.content), true);
    var titleHtml = parsed.title ? '<span class="research-card-title">' + escapeHtml(parsed.title) + '</span>' : '';
    var promptHtml = parsed.prompt ? '<div class="research-card-prompt">' + escapeHtml(parsed.prompt) + '</div>' : '';
    return '<div class="research-card-header">' +
      '<span class="research-card-label">Jira Research</span>' +
      titleHtml +
      '</div>' +
      promptHtml +
      '<div class="research-card-body web-content">' + renderedBody + '</div>';
  }

  function checkReportExists(botName, issueKey) {
    if (!botName || !issueKey || !selectedUserId) return;
    fetch('/chat/reports/' + encodeURIComponent(botName) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(issueKey), { method: 'HEAD' })
      .then(function(res) {
        reportExists = res.ok;
        // Refresh action buttons if they're currently showing
        var existing = chatMessages.querySelector('.research-actions');
        if (existing && reportExists) {
          var phase = researchBotReplies >= 2 ? 'investigation' : 'analysis';
          showResearchActions(phase);
        }
      })
      .catch(function() { reportExists = false; });
  }

  function showResearchActions(phase) {
    // Remove any existing action buttons
    var existing = chatMessages.querySelector('.research-actions');
    if (existing) existing.remove();

    var actions = document.createElement('div');
    actions.className = 'research-actions';

    // Phase 1 (after analysis): Investigate Code + Start Building + Save Report
    // Phase 2 (after investigation): Start Building + Save Report
    if (phase === 'analysis') {
      var investigateBtn = document.createElement('button');
      investigateBtn.innerHTML = '<span class="btn-icon">&#x1F50D;</span> Investigate Code';
      investigateBtn.onclick = function() {
        actions.classList.add('used');
        var bot = bots.find(function(b) { return b.name === selectedBot; });
        var defaultPrompt = 'Based on the Jira analysis above, investigate the relevant code in the codebase. Find the files and functions that would need to change, show the current implementation, and identify any potential challenges.';
        chatInput.value = '<!-- prompt:investigate -->' + ((bot && bot.prompts && bot.prompts.investigateCode) || defaultPrompt);
        sendMessage();
      };
      actions.appendChild(investigateBtn);
    }

    var buildBtn = document.createElement('button');
    buildBtn.innerHTML = '<span class="btn-icon">&#x1F680;</span> Start Building';
    buildBtn.onclick = async function() {
      actions.classList.add('used');
      if (!reportExists && researchIssueKey) {
        await saveResearchReport();
      }
      pendingConnector = 'copilot-sdk';
      var reportRef = researchIssueKey && selectedUserId ? './reports/' + selectedUserId + '/' + researchIssueKey + '.md' : '';
      chatInput.value = reportRef
        ? 'Read the research report at ' + reportRef + ' for full context. Then implement the changes step by step.'
        : 'Based on the analysis and code investigation above, start implementing this Jira task. Build the solution step by step, creating and modifying the necessary files.';
      sendMessage();
    };
    actions.appendChild(buildBtn);

    var saveBtn = document.createElement('button');
    saveBtn.innerHTML = '<span class="btn-icon">&#x1F4CB;</span> Create Workplan';
    saveBtn.onclick = function() {
      saveResearchReport();
    };
    actions.appendChild(saveBtn);

    if (reportExists && researchIssueKey) {
      var previewBtn = document.createElement('button');
      previewBtn.innerHTML = '<span class="btn-icon">&#x1F4C4;</span> Preview Workplan';
      previewBtn.onclick = function() {
        previewResearchReport();
      };
      actions.appendChild(previewBtn);
    }

    chatMessages.appendChild(actions);
    scrollToBottom();
  }

  async function saveResearchReport() {
    if (!activeConvId || !activeThreadId || !selectedBot || !selectedUserId) return;
    // Use issue key or fall back to thread-based name
    var issueKey = researchIssueKey || ('research-' + activeThreadId.slice(0, 8));

    // Fetch raw messages from DB (preserves markdown formatting, links, code blocks)
    var url = '/chat/conversations/' + activeConvId + '/messages?raw=true';
    if (activeThreadId) url += '&thread=' + encodeURIComponent(activeThreadId);
    var res = await fetch(url);
    var data = await res.json();
    var msgs = data.messages || [];

    // Separate into jira content, analysis response, investigation response
    var jiraContent = '';
    var analysisResponse = '';
    var investigationResponse = '';
    var botReplyCount = 0;
    var foundResearch = false;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.sender === 'user' && m.text.indexOf(RESEARCH_MARKER) === 0) {
        foundResearch = true;
        var parsed = parseResearchContent(m.text);
        jiraContent = parsed.content;
      } else if (foundResearch && m.sender === 'bot') {
        botReplyCount++;
        if (botReplyCount === 1) analysisResponse = m.text;
        else if (botReplyCount === 2) investigationResponse = m.text;
      }
    }

    // Extract title from jira content first line
    var titleLine = issueKey;
    if (jiraContent) {
      var lines = jiraContent.split('\\n');
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j].trim();
        if (ln.startsWith('#')) { titleLine = issueKey + ': ' + ln.replace(/^#+\\s*/, ''); break; }
        if (ln) { titleLine = ln.length > 100 ? ln.slice(0, 97) + '...' : ln; break; }
      }
    }

    // Resolve connector name for the active thread
    var reportConnector = '';
    if (activeThreadId) {
      for (var ci = 0; ci < threads.length; ci++) {
        if (threads[ci].id === activeThreadId && threads[ci].connectorName) {
          reportConnector = threads[ci].connectorName;
          break;
        }
      }
    }
    if (!reportConnector) {
      var bot = getBotInfo();
      if (bot) reportConnector = (bot.connector || 'claude-cli') + (bot.model ? ' ' + bot.model : '');
    }

    var now = new Date().toISOString().split('T')[0];
    var sections = [];
    sections.push('---');
    sections.push('issue: ' + issueKey);
    sections.push('bot: ' + selectedBot);
    sections.push('model: ' + reportConnector);
    sections.push('date: ' + now);
    sections.push('---');
    sections.push('');
    sections.push('# ' + titleLine);
    sections.push('');
    if (jiraContent) {
      sections.push('## Task Description');
      sections.push('');
      sections.push(jiraContent);
      sections.push('');
    }
    if (analysisResponse) {
      sections.push('## Research Findings');
      sections.push('');
      sections.push(analysisResponse);
      sections.push('');
    }
    if (investigationResponse) {
      sections.push('## Code Analysis');
      sections.push('');
      sections.push(investigationResponse);
      sections.push('');
    }
    sections.push('---');
    sections.push('**Issue:** ' + issueKey + ' | **Bot:** ' + selectedBot + ' | **Model:** ' + reportConnector + ' | **Generated:** ' + new Date().toISOString());

    var report = sections.join('\\n');

    // Save to backend
    try {
      var saveRes = await fetch('/chat/reports/' + encodeURIComponent(selectedBot) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(issueKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: report }),
      });
      if (saveRes.ok) {
        reportExists = true;
        // Update researchIssueKey if it was a fallback
        if (!researchIssueKey) researchIssueKey = issueKey;
        // Refresh action buttons to show Preview
        var phase = researchBotReplies >= 2 ? 'investigation' : 'analysis';
        showResearchActions(phase);
        // Brief visual feedback on the save button
        var btn = chatMessages.querySelector('.research-actions button:nth-child(' + (phase === 'analysis' ? '3' : '2') + ')');
        if (btn) {
          var orig = btn.innerHTML;
          btn.innerHTML = '<span class="btn-icon">&#x2705;</span> Saved!';
          setTimeout(function() { btn.innerHTML = orig; }, 2000);
        }
      }
    } catch (err) {
      console.error('Failed to save report:', err);
    }
  }

  function previewResearchReport() {
    if (!selectedBot || !selectedUserId || !researchIssueKey) return;
    var overlay = document.getElementById('docOverlay');
    var titleEl = document.getElementById('docPanelTitle');
    var linksEl = document.getElementById('docPanelLinks');
    var bodyEl = document.getElementById('docPanelBody');

    titleEl.textContent = researchIssueKey + ' Workplan';
    linksEl.innerHTML = '';
    bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading report...</div>';
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';

    fetch('/chat/reports/' + encodeURIComponent(selectedBot) + '/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(researchIssueKey))
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        bodyEl.innerHTML = renderMarkdown(data.content);
      })
      .catch(function(err) {
        bodyEl.innerHTML = '<div style="color:var(--status-error);padding:40px;text-align:center">Failed to load report: ' + esc(err.message) + '</div>';
      });
  }

  function appendMessage(msg, convType) {
    var existing = chatMessages.querySelector('.typing-indicator');
    if (existing && msg.sender === 'bot') existing.remove();

    var isWeb = convType === 'web';
    var isTg = convType.startsWith('telegram');
    var platformClass = isWeb ? ' web web-content' : (isTg ? ' telegram' : ' slack');
    var div = document.createElement('div');

    // Detect research card messages (marker survives DB round-trip)
    var isResearchMsg = msg.sender === 'user' && msg.text.indexOf(RESEARCH_MARKER) === 0;

    if (isResearchMsg) {
      isResearchThread = true;
      researchBotReplies = 0;
      div.className = 'msg msg-research-card';
      var parsed = parseResearchContent(msg.text);
      div.innerHTML = renderResearchCard(parsed);
      if (parsed.issueKey) {
        researchIssueKey = parsed.issueKey;
        checkReportExists(selectedBot, parsed.issueKey);
      }
    } else if (msg.sender === 'bot' && (isWeb || isTg)) {
      div.className = 'msg msg-bot' + platformClass;
      div.innerHTML = sanitizeHtml(msg.text, isWeb);
      augmentIndexLinks(div);
    } else if (msg.sender === 'bot') {
      div.className = 'msg msg-bot' + platformClass;
      div.innerHTML = renderSlackMrkdwn(msg.text);
    } else if (msg.sender === 'user' && msg.text.indexOf('<!-- prompt:') === 0) {
      div.className = 'msg msg-user msg-prompt';
      div.textContent = msg.text.replace(/^<!-- prompt:\\w+ -->/, '').trim();
    } else {
      div.className = 'msg msg-user';
      div.textContent = msg.text;
    }

    // Track bot replies in research thread
    if (isResearchThread && msg.sender === 'bot') {
      researchBotReplies++;
    }

    var time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString();
    div.appendChild(time);

    chatMessages.appendChild(div);

    // Load tool calls from trace for bots with showWaterfall=false
    if (msg.sender === 'bot' && msg.traceId) {
      var bot = bots.find(function(b) { return b.name === selectedBot; });
      if (bot && bot.showWaterfall === false) {
        loadToolCallsFromTrace(div, msg.traceId);
      }
    }

    // Show action buttons after bot replies in a research thread
    if (isResearchThread && msg.sender === 'bot') {
      if (researchBotReplies === 1) {
        showResearchActions('analysis');
      } else if (researchBotReplies === 2) {
        showResearchActions('investigation');
      }
    }

    scrollToBottom();
  }

  // Typing indicator
  function updateTypingIndicator(status) {
    var existing = chatMessages.querySelector('.typing-indicator');
    if (existing) existing.remove();
    if (status && status.length > 0) {
      var indicator = document.createElement('div');
      indicator.className = 'typing-indicator';
      indicator.innerHTML = '<span></span><span></span><span></span>';
      chatMessages.appendChild(indicator);
      scrollToBottom();
    }
  }

  // Streaming bubble helpers
  var streamingRawText = '';
  var streamingRafPending = false;

  function appendStreamingDelta(delta) {
    var bubble = chatMessages.querySelector('.msg-streaming');
    var conv = conversations[activeConvId];
    var isWeb = conv && conv.type === 'web';
    if (!bubble) {
      var typing = chatMessages.querySelector('.typing-indicator');
      if (typing) typing.remove();
      bubble = document.createElement('div');
      bubble.className = 'msg-streaming' + (isWeb ? ' web web-content' : '');
      chatMessages.appendChild(bubble);
    }
    if (isWeb) {
      streamingRawText += delta;
      if (!streamingRafPending) {
        streamingRafPending = true;
        requestAnimationFrame(function() {
          streamingRafPending = false;
          var b = chatMessages.querySelector('.msg-streaming');
          if (b) b.innerHTML = sanitizeHtml(formatWebHtml(streamingRawText), true);
          scrollToBottom();
        });
      }
    } else {
      streamingRawText += delta;
      bubble.textContent += delta;
      scrollToBottom();
    }
  }

  // Promote streaming bubble to a permanent intermediate message (kept visible during tool calls)
  function promoteStreamingBubble() {
    var bubble = chatMessages.querySelector('.msg-streaming');
    if (!bubble || !streamingRawText.trim()) {
      // Nothing meaningful to promote — just clean up
      if (bubble) bubble.remove();
      streamingRawText = '';
      streamingRafPending = false;
      return;
    }
    var conv = conversations[activeConvId];
    var isWeb = bubble.classList.contains('web');
    // Finalize HTML content
    if (isWeb) {
      bubble.innerHTML = sanitizeHtml(formatWebHtml(streamingRawText), true);
      augmentIndexLinks(bubble);
    }
    // Convert from streaming to permanent intermediate message with platform class
    bubble.classList.remove('msg-streaming');
    bubble.classList.add('msg', 'msg-bot', 'msg-intermediate');
    if (!isWeb && conv) {
      var isTg = conv.type.startsWith('telegram');
      bubble.classList.add(isTg ? 'telegram' : 'slack');
    }
    streamingRawText = '';
    streamingRafPending = false;
  }

  function removeStreamingBubble() {
    var bubble = chatMessages.querySelector('.msg-streaming');
    if (bubble) bubble.remove();
    streamingRawText = '';
    streamingRafPending = false;
  }

  // Create or get the active tool-activity container for live tool events
  function getOrCreateToolContainer() {
    if (activeToolContainer) return activeToolContainer;
    var container = document.createElement('div');
    container.className = 'tool-activity';
    var header = document.createElement('div');
    header.className = 'tool-activity-header';
    header.onclick = function() { toggleToolActivity(container); };
    var label = document.createElement('span');
    label.className = 'tool-activity-label';
    label.textContent = 'Working...';
    var toggle = document.createElement('span');
    toggle.className = 'tool-activity-toggle';
    toggle.textContent = '\\u25BC';
    header.appendChild(label);
    header.appendChild(toggle);
    var body = document.createElement('div');
    body.className = 'tool-activity-body';
    container.appendChild(header);
    container.appendChild(body);
    chatMessages.appendChild(container);
    activeToolContainer = container;
    activeToolCount = 0;
    return container;
  }

  function toggleToolActivity(container) {
    container.classList.toggle('collapsed');
    var toggle = container.querySelector('.tool-activity-toggle');
    if (toggle) toggle.textContent = container.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
  }

  function collapseToolActivity() {
    if (!activeToolContainer) return;
    activeToolContainer.classList.add('collapsed');
    var toggle = activeToolContainer.querySelector('.tool-activity-toggle');
    if (toggle) toggle.textContent = '\\u25B6';
    // Update label with summary
    var label = activeToolContainer.querySelector('.tool-activity-label');
    if (label) {
      label.textContent = 'Used ' + activeToolCount + ' tool' + (activeToolCount !== 1 ? 's' : '');
    }
    activeToolContainer = null;
    activeToolCount = 0;
  }

  // Show or update an intent bubble (what the AI plans to do)
  function showIntentBubble(text) {
    var container = getOrCreateToolContainer();
    var body = container.querySelector('.tool-activity-body');
    var existing = body.querySelector('.msg-intent');
    if (existing) {
      existing.textContent = text;
    } else {
      var bubble = document.createElement('div');
      bubble.className = 'msg-intent';
      bubble.textContent = text;
      body.appendChild(bubble);
    }
    scrollToBottom();
  }

  // Set the chat header status text with label/detail styling
  function setChatStatusText(text) {
    if (!text) {
      chatStatus.innerHTML = '';
      return;
    }
    var colonIdx = text.indexOf(': ');
    if (colonIdx > 0 && colonIdx < 60) {
      chatStatus.innerHTML =
        '<span class="status-label">' + escapeHtml(text.slice(0, colonIdx)) + ': </span>' +
        '<span class="status-detail">' + escapeHtml(text.slice(colonIdx + 2)) + '</span>';
    } else {
      chatStatus.textContent = text;
    }
  }

  // Append a tool status line to the active tool-activity container
  function appendToolStatus(text) {
    var container = getOrCreateToolContainer();
    var body = container.querySelector('.tool-activity-body');
    body.appendChild(createToolStatusLine(text));
    activeToolCount++;
    // Update header label with running count
    var label = container.querySelector('.tool-activity-label');
    if (label) label.textContent = 'Using ' + activeToolCount + ' tool' + (activeToolCount !== 1 ? 's' : '') + '...';
    scrollToBottom();
  }

  // Show response metadata (context usage) below the last bot message
  function showResponseMeta(meta) {
    // Store for inspector panel
    if (meta.conversationId) {
      lastResponseMeta[meta.conversationId] = meta;
      updateInspectorContextUsage(meta);
      updateInspectorToolUsage(meta);
      loadToolUsageStats(); // Refresh aggregate stats
    }

    // Find the last bot message to attach metadata to
    var msgs = chatMessages.querySelectorAll('.msg-bot');
    var lastBot = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    if (!lastBot) return;

    // Remove any existing meta bar on this message
    var existing = lastBot.querySelector('.msg-response-meta');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.className = 'msg-response-meta';

    var parts = [];

    // Context usage: prefer contextTokens (last turn) over inputTokens (cumulative)
    var ctxTokens = meta.contextTokens || meta.inputTokens;
    if (ctxTokens) {
      if (meta.contextWindow) {
        parts.push('ctx ' + fmtNum(ctxTokens) + ' / ' + fmtNum(meta.contextWindow));
      } else {
        parts.push(fmtNum(ctxTokens) + ' in');
      }
    }
    if (meta.outputTokens) {
      parts.push(fmtNum(meta.outputTokens) + ' out');
    }

    // Duration
    if (meta.durationMs) {
      var secs = meta.durationMs / 1000;
      parts.push(secs >= 10 ? Math.round(secs) + 's' : secs.toFixed(1) + 's');
    }

    // Cost (skip if zero — e.g. local models)
    if (meta.costUsd && meta.costUsd > 0) {
      parts.push('$' + meta.costUsd.toFixed(4));
    }

    bar.textContent = parts.join('  \u00b7  ');
    lastBot.appendChild(bar);
  }

  // Remove all intermediate messages (called before final message or on status clear)
  function removeIntermediates() {
    var intermediates = chatMessages.querySelectorAll('.msg-intermediate');
    for (var i = 0; i < intermediates.length; i++) {
      intermediates[i].remove();
    }
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // --- Connector dropdown ---
  var connectorDropdown = document.getElementById('connectorDropdown');
  var connectorSelector = document.getElementById('connectorSelector');
  var selectedConnectorId = '';  // '' = bot default

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

  // Stamp a connector on a thread (if it doesn't already have that connector)
  async function stampConnectorOnThread(threadId, connectorId) {
    if (!threadId || !connectorId) return;
    // Check if thread already has this connector
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId && threads[i].connectorId === connectorId) return;
    }
    try {
      await fetch('/chat/threads/' + encodeURIComponent(threadId) + '/connector', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorId: connectorId }),
      });
      // Update local thread data
      for (var j = 0; j < threads.length; j++) {
        if (threads[j].id === threadId) {
          threads[j].connectorId = connectorId;
          for (var k = 0; k < connectors.length; k++) {
            if (connectors[k].id === connectorId) { threads[j].connectorName = connectors[k].name; break; }
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
    // Stamp the new connector on the active thread immediately
    if (activeThreadId && selectedConnectorId) {
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

  // --- Knowledge Index Links ---
  var knowledgeUrlMap = {};

  function normalizeUrl(url) {
    try {
      var u = new URL(url);
      var normalized = u.hostname.replace(/^www\\./, '') + u.pathname.replace(/\\/$/, '');
      if (u.hostname.includes('youtube.com') && u.searchParams.has('v')) {
        normalized += '?v=' + u.searchParams.get('v');
      }
      if (u.hostname.includes('youtu.be')) {
        normalized = 'youtube.com/watch?v=' + u.pathname.slice(1);
      }
      return normalized;
    } catch { return url; }
  }

  async function loadKnowledgeUrlMaps() {
    try {
      var res = await fetch('/chat/knowledge-config');
      if (!res.ok) return;
      var cfg = await res.json();
      var cols = cfg.viewableCollections || [];
      await Promise.all(cols.map(function(col) {
        return fetch('/api/search/collection/' + encodeURIComponent(col) + '/documents')
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (!data) return;
            var docs = data.documents || [];
            for (var j = 0; j < docs.length; j++) {
              if (docs[j].url) {
                knowledgeUrlMap[normalizeUrl(docs[j].url)] = { collection: col, docId: docs[j].id };
              }
            }
          })
          .catch(function() {});
      }));
      // Re-augment any messages already rendered before the map was ready
      var msgs = document.querySelectorAll('.msg-bot');
      for (var k = 0; k < msgs.length; k++) augmentIndexLinks(msgs[k]);
    } catch {}
  }

  function augmentIndexLinks(container) {
    if (Object.keys(knowledgeUrlMap).length === 0) return;
    var links = container.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.nextElementSibling && a.nextElementSibling.classList.contains('index-link-inline')) continue;
      var match = knowledgeUrlMap[normalizeUrl(a.href)];
      if (match) {
        var btn = document.createElement('a');
        btn.className = 'index-link-inline';
        btn.href = '#';
        btn.textContent = 'Index';
        btn.dataset.collection = match.collection;
        btn.dataset.docid = match.docId;
        btn.dataset.url = a.href;
        btn.onclick = function(e) {
          e.preventDefault();
          openDocPanel(this.dataset.collection, this.dataset.docid, this.dataset.url);
        };
        a.parentNode.insertBefore(btn, a.nextSibling);
      }
    }
  }

  ${docPanelScript()}

  // Event listeners
  chatSend.onclick = sendMessage;
  chatInput.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  chatInput.oninput = function() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  };

  // Build a tool-status line DOM element from text
  function createToolStatusLine(text) {
    var line = document.createElement('div');
    line.className = 'msg-tool-status';
    var colonIdx = text.indexOf(': ');
    if (colonIdx > 0 && colonIdx < 60) {
      var labelSpan = document.createElement('span');
      labelSpan.className = 'tool-label';
      labelSpan.textContent = text.slice(0, colonIdx) + ': ';
      var detailSpan = document.createElement('span');
      detailSpan.className = 'tool-detail';
      detailSpan.textContent = text.slice(colonIdx + 2);
      line.appendChild(labelSpan);
      line.appendChild(detailSpan);
    } else {
      line.textContent = text;
    }
    return line;
  }

  // Load tool calls from a persisted trace and render as a collapsed tool-activity container
  function loadToolCallsFromTrace(messageDom, traceId) {
    fetch('/api/traces/' + traceId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var spans = data.spans || [];
        var toolSpans = spans.filter(function(s) {
          return s.parentId && s.attributes && s.attributes.toolName;
        });
        if (toolSpans.length === 0) return;

        // Build collapsed tool-activity container
        var container = document.createElement('div');
        container.className = 'tool-activity collapsed';
        var header = document.createElement('div');
        header.className = 'tool-activity-header';
        header.onclick = function() { toggleToolActivity(container); };
        var label = document.createElement('span');
        label.className = 'tool-activity-label';
        // Calculate total duration from root span
        var rootSpan = spans.find(function(s) { return !s.parentId; });
        var durText = rootSpan && rootSpan.durationMs ? ' \\u00b7 ' + fmtMs(rootSpan.durationMs) : '';
        label.textContent = 'Used ' + toolSpans.length + ' tool' + (toolSpans.length !== 1 ? 's' : '') + durText;
        var toggle = document.createElement('span');
        toggle.className = 'tool-activity-toggle';
        toggle.textContent = '\\u25B6';
        header.appendChild(label);
        header.appendChild(toggle);
        var body = document.createElement('div');
        body.className = 'tool-activity-body';

        for (var i = 0; i < toolSpans.length; i++) {
          var s = toolSpans[i];
          // Use human-friendly statusText if available, fall back to raw span name
          var text = (s.attributes && s.attributes.statusText) || s.name;
          if (s.durationMs) text += ' \\u00b7 ' + fmtMs(s.durationMs);
          body.appendChild(createToolStatusLine(text));
        }

        container.appendChild(header);
        container.appendChild(body);

        // Insert before the bot message (between user query and bot response)
        chatMessages.insertBefore(container, messageDom);
      })
      .catch(function() { /* silent — tool calls are supplementary */ });
  }

  // Init
  async function init() {
    var botNames = await loadBotList();
    connectWs();
    loadKnowledgeUrlMaps();

    // Auto-select: use stored bot if valid, otherwise first bot
    var initialBot = selectedBot && botNames.indexOf(selectedBot) !== -1 ? selectedBot : (botNames[0] || '');
    if (initialBot) selectBot(initialBot);
  }
  init();
})();
`;
