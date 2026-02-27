import { SHARED_STYLES, renderNav } from "../../dashboard/views/shared-styles.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "../../dashboard/views/components/agent-status-ui.ts";
import { requestProgressStyles, requestProgressHtml, requestProgressScript } from "../../dashboard/views/components/request-progress-ui.ts";
import { botSelectorStyles, botSelectorHtml } from "../../dashboard/views/components/bot-selector.ts";
import { helpersScript } from "../../dashboard/views/components/helpers.ts";

export function renderSimulatorPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis Chat</title>
  <style>
    ${SHARED_STYLES}
    ${agentStatusStyles()}
    ${requestProgressStyles()}
    ${botSelectorStyles()}
    ${SIMULATOR_STYLES}
  </style>
</head>
<body>
  ${renderNav("chat", { headerLeftExtra: agentStatusHtml() + botSelectorHtml() })}

  <div class="sim-layout">
    <!-- Left: Threads sidebar -->
    <div class="sim-sidebar">
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
        <span class="chat-title">Select a thread</span>
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
      <h3 class="ins-heading">Activity Feed</h3>
      <div class="activity-feed" id="activityFeed">
        <div class="empty-state">Waiting for events...</div>
      </div>
    </div>
  </div>

  <script>
    ${helpersScript()}
    ${agentStatusScript()}
    ${requestProgressScript()}
    ${CHAT_SSE_SCRIPT}
    ${SIMULATOR_SCRIPT}
  </script>
</body>
</html>`;
}

const SIMULATOR_STYLES = `
    body {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .sim-layout {
      display: grid;
      grid-template-columns: 280px 1fr 280px;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* Sidebar */
    .sim-sidebar {
      background: var(--bg-panel);
      border-right: 1px solid var(--border-primary);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-header {
      padding: 12px 16px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sidebar-header h3 { font-size: 14px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0; }
    .new-thread-btn {
      background: var(--accent);
      color: var(--text-primary);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .new-thread-btn:hover { background: var(--accent-hover); }
    .thread-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .thread-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
      margin-bottom: 2px;
    }
    .thread-item:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .thread-item.active { background: color-mix(in srgb, var(--accent) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
    .thread-item-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .thread-item.active .thread-item-icon {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      border-color: var(--accent);
      color: var(--accent);
    }
    .thread-item-content {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .thread-item-name {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thread-item-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
    }
    .thread-item-time {
      font-size: 10px;
      color: var(--text-faint);
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* Chat */
    .sim-chat {
      display: flex;
      flex-direction: column;
      background: var(--bg-inset);
      overflow: hidden;
    }
    .chat-body {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Curtain request progress — overlays chat messages, slides down from header */
    .sim-chat .request-progress {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      z-index: 10;
      border-radius: 0;
      border: none;
      border-bottom: 1px solid var(--border-primary);
      backdrop-filter: blur(12px);
      background: color-mix(in srgb, var(--bg-panel) 82%, transparent);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      padding: 0 16px;
      transition: max-height 0.35s ease, opacity 0.3s ease, padding 0.35s ease;
    }
    .sim-chat .request-progress.visible {
      padding: 10px 16px;
    }
    .sim-chat .request-progress.completed {
      border-left: 3px solid var(--status-success);
    }
    .sim-chat .request-progress.auto-dismiss {
      opacity: 0;
      pointer-events: none;
    }
    .chat-header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg-panel);
    }
    .chat-title { font-size: 14px; font-weight: 500; }
    .chat-status { font-size: 12px; color: var(--accent); }
    .chat-status:empty { display: none; }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .msg-user {
      align-self: flex-end;
      background: var(--chat-user-bg);
      color: var(--chat-user-text);
      border-bottom-right-radius: 2px;
    }
    .msg-bot {
      align-self: flex-start;
      background: var(--chat-assistant-bg);
      color: var(--chat-assistant-text);
      border-bottom-left-radius: 2px;
      border: 1px solid var(--border-primary);
    }
    .msg-bot a { color: var(--accent-light); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent-light) 40%, transparent); }
    .msg-bot a:hover { text-decoration-color: var(--accent-light); }
    .msg-bot.telegram { font-family: inherit; }
    .msg-bot.slack { font-family: 'Slack-Lato', -apple-system, sans-serif; }
    /* Shared web rich-content styles (used by both .msg-bot.web and .msg-streaming.web) */
    .web-content h2, .web-content h3, .web-content h4, .web-content h5, .web-content h6 {
      margin: 0.6em 0 0.3em; font-weight: 600; line-height: 1.3;
    }
    .web-content h2 { font-size: 1.25em; }
    .web-content h3 { font-size: 1.15em; }
    .web-content h4 { font-size: 1.05em; }
    .web-content pre {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      white-space: pre;
      margin: 8px 0;
      font-size: 13px;
      line-height: 1.4;
    }
    .web-content pre code { background: none; padding: 0; border-radius: 0; }
    .web-content code {
      background: var(--bg-surface);
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .web-content blockquote {
      border-left: 3px solid var(--accent);
      margin: 8px 0;
      padding: 4px 12px;
      color: var(--text-muted);
      white-space: normal;
    }
    .web-content ul, .web-content ol {
      margin: 6px 0;
      padding-left: 24px;
      white-space: normal;
    }
    .web-content li { margin: 2px 0; }
    .web-content hr {
      border: none;
      border-top: 1px solid var(--border-primary);
      margin: 12px 0;
    }
    .web-content table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 13px;
      width: 100%;
      white-space: normal;
    }
    .web-content th, .web-content td {
      border: 1px solid var(--border-secondary);
      padding: 5px 8px;
      text-align: left;
    }
    .web-content th {
      background: var(--bg-surface);
      font-weight: 600;
    }
    .web-content strong { font-weight: 600; }
    .web-content em { font-style: italic; }
    .web-content a { color: var(--accent-light); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent-light) 40%, transparent); }
    .web-content a:hover { text-decoration-color: var(--accent-light); }
    .msg-time {
      font-size: 10px;
      color: var(--text-faint);
      margin-top: 4px;
    }
    .chat-input {
      padding: 12px 16px;
      border-top: 1px solid var(--border-primary);
      display: flex;
      gap: 8px;
      background: var(--bg-panel);
    }
    .chat-input textarea {
      flex: 1;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      resize: none;
      outline: none;
      max-height: 120px;
    }
    .chat-input textarea:focus { border-color: var(--accent); }
    .chat-input button {
      background: var(--accent);
      color: var(--text-primary);
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .chat-input button:hover:not(:disabled) { background: var(--accent-hover); }
    .chat-input button:disabled { background: var(--text-disabled); cursor: not-allowed; }

    /* Cross-platform banner */
    .cross-platform-banner {
      text-align: center;
      font-size: 11px;
      color: var(--text-dim);
      padding: 6px 12px;
      background: color-mix(in srgb, var(--accent) 5%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 15%, transparent);
      border-radius: 6px;
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    /* Inspector */
    .sim-inspector {
      background: var(--bg-panel);
      border-left: 1px solid var(--border-primary);
      padding: 12px 16px;
      overflow-y: auto;
    }
    .ins-heading {
      font-size: 14px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 16px 0 12px;
    }
    .ins-user-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .ins-user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 600;
      color: rgba(255,255,255,0.9);
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      flex-shrink: 0;
    }
    .ins-user-info { flex: 1; min-width: 0; }
    .ins-user-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .ins-user-id { font-size: 10px; color: var(--text-dim); font-family: monospace; margin-top: 2px; }
    .ins-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      font-size: 12px;
    }
    .ins-info-label { color: var(--text-faint); }
    .ins-info-value { color: var(--text-secondary); }
    .ins-divider { border: none; border-top: 1px solid var(--border-primary); margin: 10px 0; }
    .ins-section { margin-bottom: 12px; }
    .ins-section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      font-weight: 600;
      margin-bottom: 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .ins-mini-item {
      padding: 6px 8px;
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 11px;
      color: var(--text-soft);
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ins-mini-memory {
      padding: 6px 8px;
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 11px;
      color: var(--text-soft);
      line-height: 1.4;
      margin-bottom: 4px;
    }
    .ins-tags { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 3px; }
    .ins-tag {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--bg-surface);
      color: var(--accent-muted);
    }
    .ins-skeleton {
      background: linear-gradient(90deg, var(--border-subtle) 25%, #22222e 50%, var(--border-subtle) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 6px;
      height: 24px;
      margin-bottom: 4px;
    }
    .ins-empty-hint {
      font-size: 11px;
      color: var(--text-disabled);
      font-style: italic;
      padding: 4px 0;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .activity-feed {
      font-size: 12px;
      max-height: 400px;
      overflow-y: auto;
    }
    .activity-item {
      padding: 4px 0;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-muted);
    }
    .activity-item .act-type { color: var(--accent); font-weight: 500; }
    .activity-item .act-time { color: var(--text-faint); font-size: 10px; }

    .empty-state { color: var(--text-disabled); font-size: 13px; text-align: center; padding: 24px 0; }

    /* Streaming bubble */
    .msg-streaming {
      align-self: flex-start;
      background: var(--chat-assistant-bg);
      color: var(--chat-assistant-text);
      border: 1px solid var(--border-primary);
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 10px 10px 10px 2px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
      opacity: 0.85;
    }
    /* .msg-streaming.web inherits from .web-content — no duplicate rules needed */

    /* Intent bubble — shows what the AI plans to do */
    .msg-intent {
      align-self: flex-start;
      max-width: 85%;
      padding: 6px 12px;
      font-size: 12px;
      font-style: italic;
      color: var(--text-muted);
      background: color-mix(in srgb, var(--accent) 6%, transparent);
      border-left: 2px solid color-mix(in srgb, var(--accent) 40%, transparent);
      border-radius: 4px;
      line-height: 1.4;
    }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      gap: 4px;
      padding: 8px 12px;
      align-self: flex-start;
    }
    .typing-indicator span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      animation: typing 1.2s ease-in-out infinite;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing {
      0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
      30% { opacity: 1; transform: scale(1); }
    }
`;

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

const SIMULATOR_SCRIPT = `
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
  var chatConfig = null;        // { mode, users } from /chat/config
  var conversations = {};       // Still needed for WS routing
  var activeConvId = null;      // 1:1 with selected user+bot binding
  var activeThreadId = null;    // Currently selected thread
  var threads = [];             // Thread list for current user+bot
  var bots = [];
  var ws = null;
  var deepLinkHandled = false;
  var inspectorContextKey = null;
  var selectedBot = '';         // From bot pills (localStorage-synced)
  var selectedUserId = null;    // Resolved from config for selected bot
  var selectedUsername = null;   // Display name

  // Bot selector init (synced with dashboard/traces/logs via localStorage)
  try { selectedBot = localStorage.getItem('javrvis-selected-bot') || ''; } catch {}

  // DOM refs
  var threadList = document.getElementById('threadList');
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var chatHeader = document.getElementById('chatHeader');
  var chatStatus = document.getElementById('chatStatus');
  var activityFeed = document.getElementById('activityFeed');
  var inspectorContent = document.getElementById('inspectorContent');
  var inspectorContext = document.getElementById('inspectorContext');

  async function loadBotList() {
    try {
      var res = await fetch('/chat/bots').then(function(r) { return r.json(); });
      bots = res.bots || [];

      var container = document.getElementById('botSelector');
      var botNames = bots.map(function(b) { return b.name; });

      // No "All Bots" pill — a bot must always be selected
      container.innerHTML = botNames.map(function(b) {
        return '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + escapeAttr(b) + '">' + escapeHtml(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>';
      }).join('');

      return botNames;
    } catch { return []; }
  }

  async function selectBot(name, autoSelectThreadId) {
    selectedBot = name;
    try { localStorage.setItem('javrvis-selected-bot', name); } catch {}
    document.querySelectorAll('.bot-pill').forEach(function(p) {
      p.classList.toggle('active', p.dataset.bot === name);
    });

    // Resolve user for this bot from config
    resolveUserForBot(name);

    // Resolve or create conversation for this user+bot
    await resolveConversation();

    // Clear thread selection, load threads, clear chat
    activeThreadId = null;
    clearChat();
    await loadThreads(autoSelectThreadId);
  }

  function resolveUserForBot(botName) {
    selectedUserId = null;
    selectedUsername = null;
    if (!chatConfig || !chatConfig.users) return;
    for (var i = 0; i < chatConfig.users.length; i++) {
      if (chatConfig.users[i].bot === botName) {
        selectedUserId = chatConfig.users[i].id;
        selectedUsername = chatConfig.users[i].name;
        return;
      }
    }
  }

  async function resolveConversation() {
    if (!selectedBot || !selectedUserId) {
      activeConvId = null;
      return;
    }
    // Find existing conversation for this userId+botName
    var convs = Object.values(conversations);
    for (var i = 0; i < convs.length; i++) {
      if (convs[i].userId === selectedUserId && convs[i].botName === selectedBot) {
        activeConvId = convs[i].id;
        return;
      }
    }
    // Create one if not found
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

  // New thread creation
  document.getElementById('newThreadBtn').onclick = function() {
    if (!selectedBot || !selectedUserId) return;
    var name = prompt('Thread name:');
    if (!name || !name.trim()) return;
    fetch('/chat/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: selectedUserId, botName: selectedBot, name: name.trim() }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) {
        alert('Failed to create thread: ' + data.error);
        return;
      }
      if (data.thread) {
        loadThreads(data.thread.id);
      }
    }).catch(function() { alert('Failed to create thread'); });
  };

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

    // Sort by most recent activity
    threads.sort(function(a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

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

      return '<div class="thread-item' + (isActive ? ' active' : '') + '" data-id="' + escapeAttr(t.id || '') + '">'
        + '<div class="thread-item-icon">' + icon + '</div>'
        + '<div class="thread-item-content">'
          + '<div class="thread-item-name">' + escapeHtml(t.name) + '</div>'
          + (meta ? '<div class="thread-item-meta">' + meta + '</div>' : '')
        + '</div>'
        + (t.updatedAt ? '<div class="thread-item-time">' + escapeHtml(timeAgo(t.updatedAt)) + '</div>' : '')
        + '</div>';
    }).join('');

    threadList.querySelectorAll('.thread-item').forEach(function(el) {
      el.onclick = function() {
        var tid = el.dataset.id;
        if (tid) selectThread(tid);
      };
    });
  }

  function selectThread(threadId) {
    activeThreadId = threadId;

    // Update header
    var threadName = 'main';
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId) { threadName = threads[i].name; break; }
    }
    chatHeader.querySelector('.chat-title').textContent =
      (selectedUsername || 'user') + ' \\u00b7 ' + selectedBot + ' \\u00b7 ' + threadName;

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
    chatStatus.textContent = '';
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
              removeIntermediates();
              removeStreamingBubble();
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
        addActivityItem(event.message.sender === 'bot' ? 'bot_reply' : 'user_msg', event.message.text.slice(0, 80));
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

    if (event.type === 'status') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.status = event.status;
        if (event.conversationId === activeConvId) {
          chatStatus.textContent = event.status || '';
          if (!event.status) {
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

  // Deep-link: /chat?bot=jarvis&thread=<id>
  async function handleDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var botName = params.get('bot');
    var threadParam = params.get('thread');
    if (!botName) return;

    await selectBot(botName, threadParam || undefined);
  }

  // Send message
  async function sendMessage() {
    if (!activeConvId || !activeThreadId || !chatInput.value.trim()) return;

    var text = chatInput.value.trim();
    chatInput.value = '';
    chatInput.style.height = 'auto';
    var payload = { text: text, threadId: activeThreadId };
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
    // Reset streaming state when switching threads
    streamingRawText = '';
    streamingRafPending = false;
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
  function appendMessage(msg, convType) {
    var existing = chatMessages.querySelector('.typing-indicator');
    if (existing && msg.sender === 'bot') existing.remove();

    var isWeb = convType === 'web';
    var isTg = convType.startsWith('telegram');
    var platformClass = isWeb ? ' web web-content' : (isTg ? ' telegram' : ' slack');
    var div = document.createElement('div');
    div.className = 'msg msg-' + msg.sender + (msg.sender === 'bot' ? platformClass : '');

    if (msg.sender === 'bot' && (isWeb || isTg)) {
      div.innerHTML = sanitizeHtml(msg.text, isWeb);
    } else if (msg.sender === 'bot') {
      div.innerHTML = renderSlackMrkdwn(msg.text);
    } else {
      div.textContent = msg.text;
    }

    var time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString();
    div.appendChild(time);

    chatMessages.appendChild(div);
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

  // Show or update an intent bubble (what the AI plans to do)
  function showIntentBubble(text) {
    var existing = chatMessages.querySelector('.msg-intent');
    if (existing) {
      existing.textContent = text;
    } else {
      var bubble = document.createElement('div');
      bubble.className = 'msg-intent msg-intermediate';
      bubble.textContent = text;
      chatMessages.appendChild(bubble);
    }
    scrollToBottom();
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

  // Update inspector panel
  function updateInspector() {
    if (!selectedUserId || !selectedBot) return;

    var initial = (selectedUsername || selectedUserId || '?')[0].toUpperCase();
    var statusText = '';
    if (activeConvId) {
      var conv = conversations[activeConvId];
      if (conv) statusText = conv.status || 'idle';
    }

    var aName = selectedUsername || selectedUserId || '?';
    inspectorContent.innerHTML =
      '<div class="ins-user-header">'
        + '<div class="ins-user-avatar" style="' + avatarStyle(aName) + '">' + escapeHtml(initial) + '</div>'
        + '<div class="ins-user-info">'
          + '<div class="ins-user-name">' + escapeHtml(selectedUsername || selectedUserId) + '</div>'
          + '<div class="ins-user-id">' + escapeHtml(selectedUserId) + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Bot</span><span class="ins-info-value">' + escapeHtml(selectedBot) + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Thread</span><span class="ins-info-value">' + escapeHtml(activeThreadId ? (function() { var m = null; for (var i = 0; i < threads.length; i++) { if (threads[i].id === activeThreadId) { m = threads[i].name; break; } } return m || 'main'; })() : 'none') + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Status</span><span class="ins-info-value">' + escapeHtml(statusText || 'idle') + '</span></div>'
      + '<hr class="ins-divider">';

    var contextKey = selectedUserId + ':' + selectedBot;
    if (inspectorContextKey !== contextKey) {
      inspectorContextKey = contextKey;
      loadInspectorContext(selectedUserId, selectedBot);
    }
  }

  function loadInspectorContext(userId, botName) {
    var bp = encodeURIComponent(botName);
    var up = encodeURIComponent(userId);

    inspectorContext.innerHTML =
      '<div class="ins-section"><div class="ins-section-title">Memories</div><div id="insMemories"><div class="ins-skeleton"></div><div class="ins-skeleton" style="width:70%"></div></div></div>'
      + '<div class="ins-section"><div class="ins-section-title">Goals</div><div id="insGoals"><div class="ins-skeleton"></div></div></div>'
      + '<div class="ins-section"><div class="ins-section-title">Tasks</div><div id="insTasks"><div class="ins-skeleton"></div></div></div>';

    // Memories
    fetch('/api/memories/user/' + up + '?limit=5&bot=' + bp)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('insMemories');
        if (!el) return;
        var memories = data.memories || [];
        if (!memories.length) { el.innerHTML = '<div class="ins-empty-hint">No memories</div>'; return; }
        el.innerHTML = memories.map(function(m) {
          var tags = (m.tags || []).map(function(t) { return '<span class="ins-tag">' + escapeHtml(t) + '</span>'; }).join('');
          return '<div class="ins-mini-memory">' + escapeHtml(m.summary)
            + (tags ? '<div class="ins-tags">' + tags + '</div>' : '')
            + '</div>';
        }).join('');
      })
      .catch(function() {
        var el = document.getElementById('insMemories');
        if (el) el.innerHTML = '<div class="ins-empty-hint">Failed to load</div>';
      });

    // Goals
    fetch('/api/goals/' + up + '?bot=' + bp)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('insGoals');
        if (!el) return;
        var goals = (data.goals || []).filter(function(g) { return g.status === 'active'; });
        if (!goals.length) { el.innerHTML = '<div class="ins-empty-hint">No active goals</div>'; return; }
        el.innerHTML = goals.map(function(g) {
          return '<div class="ins-mini-item">' + escapeHtml(g.title) + '</div>';
        }).join('');
      })
      .catch(function() {
        var el = document.getElementById('insGoals');
        if (el) el.innerHTML = '<div class="ins-empty-hint">Failed to load</div>';
      });

    // Tasks
    fetch('/api/scheduled-tasks/' + up + '?bot=' + bp)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var el = document.getElementById('insTasks');
        if (!el) return;
        var tasks = data.tasks || [];
        if (!tasks.length) { el.innerHTML = '<div class="ins-empty-hint">No scheduled tasks</div>'; return; }
        el.innerHTML = tasks.map(function(t) {
          return '<div class="ins-mini-item">' + escapeHtml(t.title) + '</div>';
        }).join('');
      })
      .catch(function() {
        var el = document.getElementById('insTasks');
        if (el) el.innerHTML = '<div class="ins-empty-hint">Failed to load</div>';
      });
  }

  // Activity feed
  function addActivityItem(type, text) {
    if (activityFeed.querySelector('.empty-state')) {
      activityFeed.innerHTML = '';
    }
    var div = document.createElement('div');
    div.className = 'activity-item';
    div.innerHTML = '<span class="act-time">' + new Date().toLocaleTimeString() + '</span> '
      + '<span class="act-type">' + type + '</span> '
      + escapeHtml(text);
    activityFeed.insertBefore(div, activityFeed.firstChild);
    while (activityFeed.children.length > 50) {
      activityFeed.removeChild(activityFeed.lastChild);
    }
  }

  // Client-side markdown → HTML formatter for web chat.
  // IMPORTANT: This is a manual port of src/web/web-format.ts — keep both in sync.
  function formatWebHtml(text) {
    var result = text.replace(/\\r\\n/g, '\\n');

    // Preserve code blocks
    var codeBlocks = [];
    result = result.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
      var idx = codeBlocks.length;
      var langClass = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      codeBlocks.push('<pre><code' + langClass + '>' + escapeHtml(code.replace(/\\s+$/, '')) + '</code></pre>');
      return '\\x00CODEBLOCK' + idx + '\\x00';
    });

    // Preserve inline code
    var inlineCodes = [];
    result = result.replace(/\`([^\`]+)\`/g, function(_, code) {
      var idx = inlineCodes.length;
      inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
      return '\\x00INLINE' + idx + '\\x00';
    });

    // Convert Slack mrkdwn links <url|text> to markdown [text](url) before escaping
    result = result.replace(/<(https?:\\/\\/[^|>]+)\\|([^>]+)>/g, '[$2]($1)');
    result = result.replace(/<(https?:\\/\\/[^>]+)>/g, '[$1]($1)');

    // Escape HTML entities
    result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Tables
    result = result.replace(/^(\\|.+\\|)\\n(\\|[\\s\\-:|]+\\|)\\n((?:\\|.+\\|\\n?)+)/gm, function(_, headerLine, _sep, bodyLines) {
      var headers = headerLine.replace(/^\\||\\|$/g, '').split('|');
      var rows = bodyLines.replace(/\\s+$/, '').split('\\n');
      var thead = '<thead><tr>' + headers.map(function(h) { return '<th>' + h.trim() + '</th>'; }).join('') + '</tr></thead>';
      var tbody = '<tbody>' + rows.map(function(row) {
        var cells = row.replace(/^\\||\\|$/g, '').split('|');
        return '<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<table>' + thead + tbody + '</table>';
    });

    // Headings
    result = result.replace(/^(#{1,6})\\s+(.+)$/gm, function(_, hashes, content) {
      var level = Math.min(hashes.length + 1, 6);
      return '<h' + level + '>' + content + '</h' + level + '>';
    });

    // Horizontal rules
    result = result.replace(/^---+$/gm, '<hr>');

    // Blockquotes (> escaped to &gt;)
    var bqLines = result.split('\\n');
    var bqResult = [];
    var quoteLines = [];
    function flushQuote() {
      if (quoteLines.length > 0) {
        bqResult.push('<blockquote>' + quoteLines.join('<br>') + '</blockquote>');
        quoteLines = [];
      }
    }
    for (var bi = 0; bi < bqLines.length; bi++) {
      var bqMatch = bqLines[bi].match(/^&gt;\\s?(.*)/);
      if (bqMatch) { quoteLines.push(bqMatch[1]); }
      else { flushQuote(); bqResult.push(bqLines[bi]); }
    }
    flushQuote();
    result = bqResult.join('\\n');

    // Unordered lists
    var ulLines = result.split('\\n');
    var ulResult = [];
    var ulItems = [];
    function flushUl() {
      if (ulItems.length > 0) {
        ulResult.push('<ul>' + ulItems.map(function(item) { return '<li>' + item + '</li>'; }).join('') + '</ul>');
        ulItems = [];
      }
    }
    for (var ui = 0; ui < ulLines.length; ui++) {
      var ulMatch = ulLines[ui].match(/^[-*]\\s+(.*)/);
      if (ulMatch) { ulItems.push(ulMatch[1]); }
      else { flushUl(); ulResult.push(ulLines[ui]); }
    }
    flushUl();
    result = ulResult.join('\\n');

    // Ordered lists
    var olLines = result.split('\\n');
    var olResult = [];
    var olItems = [];
    function flushOl() {
      if (olItems.length > 0) {
        olResult.push('<ol>' + olItems.map(function(item) { return '<li>' + item + '</li>'; }).join('') + '</ol>');
        olItems = [];
      }
    }
    for (var oi = 0; oi < olLines.length; oi++) {
      var olMatch = olLines[oi].match(/^\\d+\\.\\s+(.*)/);
      if (olMatch) { olItems.push(olMatch[1]); }
      else { flushOl(); olResult.push(olLines[oi]); }
    }
    flushOl();
    result = olResult.join('\\n');

    // Bold
    result = result.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    // Italic *text*
    result = result.replace(/(?<!\\w)\\*([^*]+?)\\*(?!\\w)/g, '<em>$1</em>');
    // Italic _text_
    result = result.replace(/(?<!\\w)_([^_]+?)_(?!\\w)/g, '<em>$1</em>');
    // Strikethrough
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Links [text](url) — only http/https
    result = result.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(_, text, url) {
      if (/^https?:\\/\\//.test(url)) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + text + '</a>';
      }
      return text;
    });

    // Restore code blocks and inline codes
    for (var ci = 0; ci < codeBlocks.length; ci++) {
      result = result.replace('\\x00CODEBLOCK' + ci + '\\x00', codeBlocks[ci]);
    }
    for (var ii = 0; ii < inlineCodes.length; ii++) {
      result = result.replace('\\x00INLINE' + ii + '\\x00', inlineCodes[ii]);
    }

    // Clean up excessive blank lines
    result = result.replace(/\\n{3,}/g, '\\n\\n');

    return result.trim();
  }

  // Minimal Slack mrkdwn renderer
  function renderSlackMrkdwn(text) {
    var links = [];
    var t = text.replace(/<(https?:\\/\\/[^|>]+)\\|([^>]+)>/g, function(_, url, label) {
      links.push({url: url, label: label});
      return '%%SLINK' + (links.length - 1) + '%%';
    });
    t = escapeHtml(t)
      .replace(/\\*([^*]+)\\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/~([^~]+)~/g, '<del>$1</del>')
      .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\n/g, '<br>');
    for (var i = 0; i < links.length; i++) {
      t = t.replace('%%SLINK' + i + '%%',
        '<a href="' + escapeHtml(links[i].url) + '" target="_blank">' + escapeHtml(links[i].label) + '</a>');
    }
    return t;
  }

  // Sanitize HTML — allow safe tags and attributes
  var _tgTags = ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'a', 'br', 'span'];
  var _webTags = _tgTags.concat(['h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'p']);

  function sanitizeHtml(html, isWeb) {
    var allowedTags = isWeb ? _webTags : _tgTags;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;

    function walk(node) {
      var children = Array.from(node.childNodes);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 1) {
          var tag = child.tagName.toLowerCase();
          if (allowedTags.indexOf(tag) === -1) {
            var text = document.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
          } else {
            var attrs = Array.from(child.attributes);
            for (var j = 0; j < attrs.length; j++) {
              var attr = attrs[j];
              if (tag === 'a' && attr.name === 'href' && /^https?:\\/\\//.test(attr.value)) continue;
              if (tag === 'a' && (attr.name === 'target' || attr.name === 'rel')) continue;
              if (tag === 'code' && attr.name === 'class') continue;
              child.removeAttribute(attr.name);
            }
            if (tag === 'a') {
              child.setAttribute('target', '_blank');
              child.setAttribute('rel', 'noopener');
            }
            walk(child);
          }
        }
      }
    }
    walk(tmp);
    return tmp.innerHTML;
  }

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

  // Init
  async function init() {
    var botNames = await loadBotList();
    try {
      var res = await fetch('/chat/config');
      chatConfig = await res.json();
    } catch { chatConfig = { mode: 'discovery', users: [] }; }
    connectWs();

    // Auto-select: use stored bot if valid, otherwise first bot
    var initialBot = selectedBot && botNames.indexOf(selectedBot) !== -1 ? selectedBot : (botNames[0] || '');
    if (initialBot) selectBot(initialBot);
  }
  init();
})();
`;
