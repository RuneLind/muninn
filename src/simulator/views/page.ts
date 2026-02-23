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
  ${requestProgressHtml()}

  <div class="sim-layout">
    <!-- Left: Conversations sidebar -->
    <div class="sim-sidebar">
      <div class="sidebar-header">
        <h3>Conversations</h3>
        <button class="new-chat-btn" id="newChatBtn">+ New</button>
      </div>
      <div class="new-chat-picker" id="newChatPicker">
        <select id="botSelect"></select>
        <button class="picker-start" id="newChatConfirm">Start</button>
        <button class="picker-cancel" id="newChatCancel">&times;</button>
      </div>
      <div class="conv-list" id="convList">
        <div class="empty-state">No conversations yet</div>
      </div>
    </div>

    <!-- Center: Chat view -->
    <div class="sim-chat">
      <div class="chat-header" id="chatHeader">
        <span class="chat-title">Select a conversation</span>
        <select class="thread-picker" id="threadPicker" style="display:none"></select>
        <span class="chat-status" id="chatStatus"></span>
      </div>
      <div class="chat-messages" id="chatMessages">
        <div class="empty-state">Select a conversation from the sidebar</div>
      </div>
      <div class="chat-input">
        <textarea id="chatInput" placeholder="Type a message..." rows="1" disabled></textarea>
        <button id="chatSend" disabled>Send</button>
      </div>
    </div>

    <!-- Right: Inspector -->
    <div class="sim-inspector">
      <div id="inspectorContent">
        <div class="empty-state">Select a conversation</div>
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
    .new-chat-btn {
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
    .new-chat-btn:hover { background: var(--accent-hover); }
    .new-chat-picker {
      display: none;
      padding: 8px 12px;
      gap: 6px;
      align-items: center;
      border-bottom: 1px solid var(--border-subtle);
    }
    .new-chat-picker select {
      flex: 1;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .picker-start {
      background: var(--accent);
      color: var(--text-primary);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .picker-start:hover { background: var(--accent-hover); }
    .picker-cancel {
      background: none;
      border: 1px solid var(--border-secondary);
      color: var(--text-muted);
      width: 24px;
      height: 24px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .picker-cancel:hover { border-color: var(--text-dim); }
    .conv-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .conv-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
      margin-bottom: 2px;
    }
    .conv-item:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .conv-item.active { background: color-mix(in srgb, var(--accent) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
    .conv-item-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      color: rgba(255,255,255,0.9);
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
      flex-shrink: 0;
    }
    .conv-item-content {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .conv-item-name {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .conv-item-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
    }
    .conv-item-preview {
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-faint);
    }
    .conv-item-time {
      font-size: 10px;
      color: var(--text-faint);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .conv-item-badge {
      display: inline-block;
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }
    .badge-tg { background: #1a2a3e; color: #54a9eb; }
    .badge-slack { background: #2a1a3e; color: #e0a0ff; }
    .badge-web { background: #1a3a2a; color: #54eb8a; }

    /* Chat */
    .sim-chat {
      display: flex;
      flex-direction: column;
      background: var(--bg-inset);
      overflow: hidden;
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
    .thread-picker {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      max-width: 180px;
    }
    .thread-picker:focus { border-color: var(--accent); outline: none; }
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
    .msg-bot.web h2, .msg-bot.web h3, .msg-bot.web h4, .msg-bot.web h5, .msg-bot.web h6 {
      margin: 0.6em 0 0.3em; font-weight: 600; line-height: 1.3;
    }
    .msg-bot.web h2 { font-size: 1.25em; }
    .msg-bot.web h3 { font-size: 1.15em; }
    .msg-bot.web h4 { font-size: 1.05em; }
    .msg-bot.web pre {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      margin: 8px 0;
      font-size: 13px;
      line-height: 1.4;
    }
    .msg-bot.web pre code { background: none; padding: 0; border-radius: 0; }
    .msg-bot.web code {
      background: var(--bg-surface);
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .msg-bot.web blockquote {
      border-left: 3px solid var(--accent);
      margin: 8px 0;
      padding: 4px 12px;
      color: var(--text-muted);
      white-space: normal;
    }
    .msg-bot.web ul, .msg-bot.web ol {
      margin: 6px 0;
      padding-left: 24px;
      white-space: normal;
    }
    .msg-bot.web li { margin: 2px 0; }
    .msg-bot.web hr {
      border: none;
      border-top: 1px solid var(--border-primary);
      margin: 12px 0;
    }
    .msg-bot.web table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 13px;
      width: 100%;
      white-space: normal;
    }
    .msg-bot.web th, .msg-bot.web td {
      border: 1px solid var(--border-secondary);
      padding: 5px 8px;
      text-align: left;
    }
    .msg-bot.web th {
      background: var(--bg-surface);
      font-weight: 600;
    }
    .msg-bot.web strong { font-weight: 600; }
    .msg-bot.web em { font-style: italic; }
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
    .msg-streaming.web h2, .msg-streaming.web h3, .msg-streaming.web h4, .msg-streaming.web h5, .msg-streaming.web h6 {
      margin: 0.6em 0 0.3em; font-weight: 600; line-height: 1.3;
    }
    .msg-streaming.web h2 { font-size: 1.25em; }
    .msg-streaming.web h3 { font-size: 1.15em; }
    .msg-streaming.web h4 { font-size: 1.05em; }
    .msg-streaming.web pre {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      white-space: pre;
      font-size: 13px;
      line-height: 1.4;
    }
    .msg-streaming.web pre code { background: none; padding: 0; border-radius: 0; }
    .msg-streaming.web code {
      background: var(--bg-surface);
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .msg-streaming.web blockquote {
      border-left: 3px solid var(--accent);
      margin: 8px 0;
      padding: 4px 12px;
      color: var(--text-muted);
      white-space: normal;
    }
    .msg-streaming.web ul, .msg-streaming.web ol {
      margin: 6px 0;
      padding-left: 24px;
      white-space: normal;
    }
    .msg-streaming.web li { margin: 2px 0; }
    .msg-streaming.web hr {
      border: none;
      border-top: 1px solid var(--border-primary);
      margin: 12px 0;
    }
    .msg-streaming.web table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 13px;
      width: 100%;
      white-space: normal;
    }
    .msg-streaming.web th, .msg-streaming.web td {
      border: 1px solid var(--border-secondary);
      padding: 5px 8px;
      text-align: left;
    }
    .msg-streaming.web th {
      background: var(--bg-surface);
      font-weight: 600;
    }
    .msg-streaming.web strong { font-weight: 600; }
    .msg-streaming.web em { font-style: italic; }
    .msg-streaming.web a { color: var(--accent-light); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent-light) 40%, transparent); }
    .msg-streaming.web a:hover { text-decoration-color: var(--accent-light); }

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
  function connectSSE() {
    var es = new EventSource('/api/events');

    es.addEventListener('agent_status', function(e) {
      updateAgentStatus(JSON.parse(e.data));
    });

    es.addEventListener('request_progress', function(e) {
      updateRequestProgress(JSON.parse(e.data));
    });

    es.onerror = function() {
      es.close();
      setTimeout(connectSSE, 3000);
    };
  }
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
  var conversations = {};
  var activeConvId = null;
  var activeThreadId = null;
  var activeThreads = [];
  var bots = [];
  var ws = null;
  var deepLinkHandled = false;
  var inspectorContextKey = null;
  var selectedBot = '';

  // Bot selector init (synced with dashboard/traces/logs via localStorage)
  try { selectedBot = localStorage.getItem('javrvis-selected-bot') || ''; } catch {}

  async function loadBotList() {
    try {
      var res = await fetch('/chat/bots').then(function(r) { return r.json(); });
      bots = res.bots || [];

      // Populate pill selector
      var container = document.getElementById('botSelector');
      var botNames = bots.map(function(b) { return b.name; });
      container.innerHTML =
        '<button class="bot-pill' + (!selectedBot ? ' active' : '') + '" data-bot="">All Bots</button>' +
        botNames.map(function(b) {
          return '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + escapeAttr(b) + '">' + escapeHtml(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>';
        }).join('');

      // Populate new-chat bot dropdown
      botSelect.innerHTML = bots.map(function(b) {
        return '<option value="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + '</option>';
      }).join('');
      if (selectedBot) botSelect.value = selectedBot;
    } catch {}
  }

  function selectBot(name) {
    selectedBot = name;
    try { localStorage.setItem('javrvis-selected-bot', name); } catch {}
    document.querySelectorAll('.bot-pill').forEach(function(p) {
      p.classList.toggle('active', p.dataset.bot === name);
    });
    renderConvList();
  }

  document.getElementById('botSelector').addEventListener('click', function(e) {
    var pill = e.target.closest('.bot-pill');
    if (pill) selectBot(pill.dataset.bot);
  });

  // DOM refs
  var convList = document.getElementById('convList');
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var chatHeader = document.getElementById('chatHeader');
  var chatStatus = document.getElementById('chatStatus');
  var activityFeed = document.getElementById('activityFeed');
  var inspectorContent = document.getElementById('inspectorContent');
  var inspectorContext = document.getElementById('inspectorContext');
  var botSelect = document.getElementById('botSelect');
  var newChatPicker = document.getElementById('newChatPicker');
  var threadPicker = document.getElementById('threadPicker');

  // Platform helpers
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

  function platformBadgeHtml(type) {
    if (type === 'web') return '<span class="conv-item-badge badge-web">Web</span>';
    if (type.startsWith('telegram')) return '<span class="conv-item-badge badge-tg">TG</span>';
    return '<span class="conv-item-badge badge-slack">Slack</span>';
  }

  // New Chat flow
  var pickerVisible = false;
  document.getElementById('newChatBtn').onclick = function() {
    pickerVisible = !pickerVisible;
    newChatPicker.style.display = pickerVisible ? 'flex' : 'none';
  };
  document.getElementById('newChatCancel').onclick = function() {
    pickerVisible = false;
    newChatPicker.style.display = 'none';
  };
  document.getElementById('newChatConfirm').onclick = async function() {
    var botName = botSelect.value;
    if (!botName) return;
    var res = await fetch('/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'web', botName: botName, userId: 'web-user', username: 'web-user' }),
    });
    if (res.ok) {
      var data = await res.json();
      conversations[data.conversation.id] = data.conversation;
      selectConversation(data.conversation.id);
      renderConvList();
    }
    pickerVisible = false;
    newChatPicker.style.display = 'none';
  };

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

  function handleWsEvent(event) {
    if (event.type === 'snapshot') {
      for (var i = 0; i < event.conversations.length; i++) {
        var conv = event.conversations[i];
        conversations[conv.id] = conv;
      }
      renderConvList();
      if (activeConvId) renderChat();
      if (!deepLinkHandled) {
        deepLinkHandled = true;
        handleDeepLink();
      }
      return;
    }

    if (event.type === 'conversation_created') {
      conversations[event.conversation.id] = event.conversation;
      renderConvList();
      return;
    }

    if (event.type === 'message') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.messages.push(event.message);
        if (event.conversationId === activeConvId) {
          // Only append if no thread filter is active, or the message belongs to the active thread
          var msgThread = event.message.threadId || null;
          if (!activeThreadId || msgThread === activeThreadId) {
            // Remove streaming bubble — final formatted message replaces it
            if (event.message.sender === 'bot') removeStreamingBubble();
            appendMessage(event.message, conv.type);
          }
          updateInspector();
        }
        renderConvList();
        addActivityItem(event.message.sender === 'bot' ? 'bot_reply' : 'user_msg', event.message.text.slice(0, 80));
      }
      return;
    }

    if (event.type === 'text_delta') {
      if (event.conversationId !== activeConvId) return;
      // Thread filtering: only show deltas for the active thread
      var deltaThread = event.threadId || null;
      if (activeThreadId && deltaThread !== activeThreadId) return;
      appendStreamingDelta(event.delta);
      return;
    }

    if (event.type === 'stream_clear') {
      if (event.conversationId !== activeConvId) return;
      removeStreamingBubble();
      return;
    }

    if (event.type === 'status') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.status = event.status;
        if (event.conversationId === activeConvId) {
          chatStatus.textContent = event.status || '';
          // Clear streaming bubble when status is cleared (safety net for errors)
          if (!event.status) removeStreamingBubble();
          updateTypingIndicator(event.status);
        }
      }
      return;
    }
  }

  // Deep-link from dashboard: /chat?user=<id>&bot=<name>&username=<name>&thread=<threadId>
  function handleDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var userId = params.get('user');
    var botName = params.get('bot');
    var username = params.get('username');
    var threadParam = params.get('thread');
    if (!userId || !botName) return;

    // Find existing conversation for this user+bot
    var convs = Object.values(conversations);
    var match = null;
    for (var i = 0; i < convs.length; i++) {
      if (convs[i].userId === userId && convs[i].botName === botName) {
        match = convs[i];
        break;
      }
    }
    if (match) {
      selectConversation(match.id, threadParam || undefined);
      return;
    }

    // Create a new web conversation
    fetch('/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'web', botName: botName, userId: userId, username: username || 'user' }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.conversation) {
        conversations[data.conversation.id] = data.conversation;
        selectConversation(data.conversation.id, threadParam || undefined);
        renderConvList();
      }
    });
  }

  // Send message
  async function sendMessage() {
    if (!activeConvId || !chatInput.value.trim()) return;
    var text = chatInput.value.trim();
    chatInput.value = '';
    chatInput.style.height = 'auto';
    var payload = { text: text };
    if (activeThreadId) payload.threadId = activeThreadId;
    await fetch('/chat/conversations/' + activeConvId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // Select conversation
  function selectConversation(id, preselectedThreadId) {
    activeConvId = id;
    activeThreadId = null;
    activeThreads = [];
    chatInput.disabled = false;
    chatSend.disabled = false;
    renderConvList();
    renderChat();
    updateInspector();
    loadThreadsForConv(preselectedThreadId);
  }

  // Load threads for the active conversation
  async function loadThreadsForConv(preselectedThreadId) {
    var conv = conversations[activeConvId];
    if (!conv) { threadPicker.style.display = 'none'; return; }
    try {
      var res = await fetch('/chat/threads/' + encodeURIComponent(conv.userId) + '/' + encodeURIComponent(conv.botName));
      var data = await res.json();
      activeThreads = data.threads || [];
    } catch {
      activeThreads = [];
    }

    if (activeThreads.length <= 1 && !preselectedThreadId) {
      // Single thread or no threads — no picker needed, but set activeThreadId if there's one
      threadPicker.style.display = 'none';
      if (activeThreads.length === 1) activeThreadId = activeThreads[0].id;
      return;
    }

    // Build picker options: "All messages" + each thread
    threadPicker.innerHTML = '<option value="">All messages</option>' +
      activeThreads.map(function(t) {
        var label = t.name || 'main';
        if (t.isActive) label += ' (active)';
        return '<option value="' + escapeAttr(t.id) + '">' + escapeHtml(label) + '</option>';
      }).join('');
    threadPicker.style.display = 'inline-block';

    // Pre-select thread if specified
    if (preselectedThreadId) {
      threadPicker.value = preselectedThreadId;
      activeThreadId = preselectedThreadId;
      loadThreadMessages(preselectedThreadId);
    }
  }

  // Load messages filtered by thread from DB
  async function loadThreadMessages(threadId) {
    if (!activeConvId) return;
    activeThreadId = threadId || null;
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

  // Thread picker change handler
  threadPicker.onchange = function() {
    var val = threadPicker.value;
    loadThreadMessages(val || null);
  };

  // Render conversation list (sorted by most recent message)
  function renderConvList() {
    var convs = Object.values(conversations);
    if (selectedBot) {
      convs = convs.filter(function(c) { return c.botName === selectedBot; });
    }
    if (convs.length === 0) {
      convList.innerHTML = '<div class="empty-state">' + (selectedBot ? 'No conversations for ' + escapeHtml(selectedBot) : 'No conversations yet') + '</div>';
      return;
    }

    convs.sort(function(a, b) {
      var aTime = a.messages.length > 0 ? a.messages[a.messages.length - 1].timestamp : 0;
      var bTime = b.messages.length > 0 ? b.messages[b.messages.length - 1].timestamp : 0;
      return bTime - aTime;
    });

    convList.innerHTML = convs.map(function(c) {
      var isActive = c.id === activeConvId;
      var initial = (c.username || c.userId || '?')[0].toUpperCase();
      var badge = platformBadgeHtml(c.type);
      var lastMsg = c.messages.length > 0
        ? c.messages[c.messages.length - 1].text.slice(0, 30)
        : '';
      var lastTime = c.messages.length > 0
        ? timeAgo(c.messages[c.messages.length - 1].timestamp)
        : '';

      var aName = c.username || c.userId || '?';
      return '<div class="conv-item' + (isActive ? ' active' : '') + '" data-id="' + c.id + '">'
        + '<div class="conv-item-avatar" style="' + avatarStyle(aName) + '">' + escapeHtml(initial) + '</div>'
        + '<div class="conv-item-content">'
          + '<div class="conv-item-name">' + escapeHtml(c.username || c.userId) + '</div>'
          + '<div class="conv-item-meta">'
            + badge
            + ' <span>' + escapeHtml(c.botName) + '</span>'
            + (lastMsg ? ' <span class="conv-item-preview">&middot; ' + escapeHtml(lastMsg) + '</span>' : '')
          + '</div>'
        + '</div>'
        + (lastTime ? '<div class="conv-item-time">' + escapeHtml(lastTime) + '</div>' : '')
        + '</div>';
    }).join('');

    convList.querySelectorAll('.conv-item').forEach(function(el) {
      el.onclick = function() { selectConversation(el.dataset.id); };
    });
  }

  // Render full chat view
  function renderChat() {
    var conv = conversations[activeConvId];
    if (!conv) return;

    chatHeader.querySelector('.chat-title').textContent = (conv.username || conv.userId) + ' \\u00b7 ' + conv.botName;
    chatStatus.textContent = conv.status || '';

    chatMessages.innerHTML = '';

    // Cross-platform banner for non-web conversations
    if (conv.type !== 'web') {
      var banner = document.createElement('div');
      banner.className = 'cross-platform-banner';
      banner.textContent = 'Conversation from ' + typePlatformLabel(conv.type) + ' \\u2014 replies sent via web';
      chatMessages.appendChild(banner);
    }

    for (var i = 0; i < conv.messages.length; i++) {
      appendMessage(conv.messages[i], conv.type);
    }
    updateTypingIndicator(conv.status);
    scrollToBottom();
  }

  // Append a single message to the chat
  function appendMessage(msg, convType) {
    var existing = chatMessages.querySelector('.typing-indicator');
    if (existing && msg.sender === 'bot') existing.remove();

    var isWeb = convType === 'web';
    var isTg = convType.startsWith('telegram');
    var platformClass = isWeb ? ' web' : (isTg ? ' telegram' : ' slack');
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

  function appendStreamingDelta(delta) {
    var bubble = chatMessages.querySelector('.msg-streaming');
    var conv = conversations[activeConvId];
    var isWeb = conv && conv.type === 'web';
    if (!bubble) {
      // Remove typing indicator — streaming text replaces it
      var typing = chatMessages.querySelector('.typing-indicator');
      if (typing) typing.remove();
      bubble = document.createElement('div');
      bubble.className = 'msg-streaming' + (isWeb ? ' web' : '');
      chatMessages.appendChild(bubble);
    }
    if (isWeb) {
      streamingRawText += delta;
      bubble.innerHTML = sanitizeHtml(formatWebHtml(streamingRawText), true);
    } else {
      bubble.textContent += delta;
    }
    scrollToBottom();
  }

  function removeStreamingBubble() {
    var bubble = chatMessages.querySelector('.msg-streaming');
    if (bubble) bubble.remove();
    streamingRawText = '';
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Update inspector panel
  function updateInspector() {
    var conv = conversations[activeConvId];
    if (!conv) return;

    var initial = (conv.username || conv.userId || '?')[0].toUpperCase();
    var badge = platformBadgeHtml(conv.type);
    var statusText = conv.status || 'idle';

    var aName = conv.username || conv.userId || '?';
    inspectorContent.innerHTML =
      '<div class="ins-user-header">'
        + '<div class="ins-user-avatar" style="' + avatarStyle(aName) + '">' + escapeHtml(initial) + '</div>'
        + '<div class="ins-user-info">'
          + '<div class="ins-user-name">' + escapeHtml(conv.username || conv.userId) + ' ' + badge + '</div>'
          + '<div class="ins-user-id">' + escapeHtml(conv.userId) + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Bot</span><span class="ins-info-value">' + escapeHtml(conv.botName) + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Messages</span><span class="ins-info-value">' + conv.messages.length + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Status</span><span class="ins-info-value">' + escapeHtml(statusText) + '</span></div>'
      + '<hr class="ins-divider">';

    // Load context sections if user changed
    var contextKey = conv.userId + ':' + conv.botName;
    if (inspectorContextKey !== contextKey) {
      inspectorContextKey = contextKey;
      loadInspectorContext(conv.userId, conv.botName);
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

  // Client-side markdown → HTML formatter for web chat (mirrors server-side web-format.ts)
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
  loadBotList();
  connectWs();
})();
`;
