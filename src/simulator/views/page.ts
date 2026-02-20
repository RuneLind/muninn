import { SHARED_STYLES, renderNav } from "../../dashboard/views/shared-styles.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "../../dashboard/views/components/agent-status-ui.ts";
import { requestProgressStyles, requestProgressHtml, requestProgressScript } from "../../dashboard/views/components/request-progress-ui.ts";
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
    ${SIMULATOR_STYLES}
  </style>
</head>
<body>
  ${renderNav("chat", { headerLeftExtra: agentStatusHtml() })}
  ${requestProgressHtml()}

  <div class="sim-layout">
    <!-- Left: Conversations sidebar -->
    <div class="sim-sidebar">
      <div class="sidebar-header">
        <h3>Conversations</h3>
      </div>
      <div class="new-conv-buttons">
        <button class="new-conv-btn" data-type="telegram_dm" title="Telegram DM">TG DM</button>
        <button class="new-conv-btn" data-type="slack_dm" title="Slack DM">Slack DM</button>
        <button class="new-conv-btn" data-type="slack_channel" title="Slack Channel">Channel</button>
        <button class="new-conv-btn" data-type="slack_assistant" title="Slack Assistant">Assistant</button>
      </div>
      <div class="bot-selector">
        <label>Bot:</label>
        <select id="botSelect"></select>
      </div>
      <div class="user-config">
        <input id="simUserId" type="text" value="sim-user-1" placeholder="User ID" />
        <input id="simUsername" type="text" value="simulator" placeholder="Username" />
      </div>
      <div class="conv-list" id="convList">
        <div class="empty-state">No conversations yet</div>
      </div>
    </div>

    <!-- Center: Chat view -->
    <div class="sim-chat">
      <div class="chat-header" id="chatHeader">
        <span class="chat-title">Select a conversation</span>
        <span class="chat-status" id="chatStatus"></span>
      </div>
      <div class="chat-messages" id="chatMessages">
        <div class="empty-state">Start a conversation from the sidebar</div>
      </div>
      <div class="chat-input">
        <textarea id="chatInput" placeholder="Type a message..." rows="1" disabled></textarea>
        <button id="chatSend" disabled>Send</button>
      </div>
    </div>

    <!-- Right: Inspector -->
    <div class="sim-inspector">
      <h3>Inspector</h3>
      <div id="inspectorContent">
        <div class="inspector-section">
          <div class="inspector-label">Bot</div>
          <div class="inspector-value" id="insBotName">-</div>
        </div>
        <div class="inspector-section">
          <div class="inspector-label">Platform</div>
          <div class="inspector-value" id="insPlatform">-</div>
        </div>
        <div class="inspector-section">
          <div class="inspector-label">User</div>
          <div class="inspector-value" id="insUser">-</div>
        </div>
        <div class="inspector-section">
          <div class="inspector-label">Status</div>
          <div class="inspector-value" id="insStatus">idle</div>
        </div>
        <div class="inspector-section">
          <div class="inspector-label">Messages</div>
          <div class="inspector-value" id="insMsgCount">0</div>
        </div>
      </div>
      <h3 style="margin-top: 16px;">Activity Feed</h3>
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
      grid-template-columns: 260px 1fr 280px;
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
    }
    .sidebar-header h3 { font-size: 14px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .new-conv-buttons {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 8px 12px;
    }
    .new-conv-btn {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent-light);
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .new-conv-btn:hover {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .bot-selector, .user-config {
      padding: 6px 12px;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .bot-selector label { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
    .bot-selector select, .user-config input {
      flex: 1;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .user-config input { width: 0; }
    .conv-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .conv-item {
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
      margin-bottom: 2px;
    }
    .conv-item:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .conv-item.active { background: color-mix(in srgb, var(--accent) 15%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
    .conv-item-title { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
    .conv-item-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
    .conv-item-badge {
      display: inline-block;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      margin-right: 4px;
    }
    .badge-tg { background: var(--tint-info); color: var(--status-info); }
    .badge-slack { background: var(--tint-magenta); color: var(--status-magenta); }

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
    .msg-bot.telegram { font-family: inherit; }
    .msg-bot.slack { font-family: 'Slack-Lato', -apple-system, sans-serif; }
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

    /* Inspector */
    .sim-inspector {
      background: var(--bg-panel);
      border-left: 1px solid var(--border-primary);
      padding: 12px 16px;
      overflow-y: auto;
    }
    .sim-inspector h3 { font-size: 14px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .inspector-section { margin-bottom: 10px; }
    .inspector-label { font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.3px; }
    .inspector-value { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
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
  // State
  let conversations = {};
  let activeConvId = null;
  let bots = [];
  let ws = null;

  // DOM refs
  const botSelect = document.getElementById('botSelect');
  const convList = document.getElementById('convList');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSend = document.getElementById('chatSend');
  const chatHeader = document.getElementById('chatHeader');
  const chatStatus = document.getElementById('chatStatus');
  const activityFeed = document.getElementById('activityFeed');

  // Inspector refs
  const insBotName = document.getElementById('insBotName');
  const insPlatform = document.getElementById('insPlatform');
  const insUser = document.getElementById('insUser');
  const insStatus = document.getElementById('insStatus');
  const insMsgCount = document.getElementById('insMsgCount');

  // Load available bots
  async function loadBots() {
    const res = await fetch('/simulator/bots');
    const data = await res.json();
    bots = data.bots;
    botSelect.innerHTML = bots.map(b =>
      '<option value="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + '</option>'
    ).join('');
  }

  // WebSocket connection
  function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/simulator/ws');

    ws.onmessage = function(e) {
      try {
        const event = JSON.parse(e.data);
        handleWsEvent(event);
      } catch (err) {
        console.warn('Failed to parse WS message:', err);
      }
    };

    ws.onclose = function() {
      setTimeout(connectWs, 2000);
    };
  }

  function handleWsEvent(event) {
    if (event.type === 'snapshot') {
      // Initial state snapshot
      for (const conv of event.conversations) {
        conversations[conv.id] = conv;
      }
      renderConvList();
      if (activeConvId) renderChat();
      return;
    }

    if (event.type === 'conversation_created') {
      conversations[event.conversation.id] = event.conversation;
      renderConvList();
      return;
    }

    if (event.type === 'message') {
      const conv = conversations[event.conversationId];
      if (conv) {
        conv.messages.push(event.message);
        if (event.conversationId === activeConvId) {
          appendMessage(event.message, conv.type);
          updateInspector();
        }
        renderConvList();
        addActivityItem(event.message.sender === 'bot' ? 'bot_reply' : 'user_msg', event.message.text.slice(0, 80));
      }
      return;
    }

    if (event.type === 'status') {
      const conv = conversations[event.conversationId];
      if (conv) {
        conv.status = event.status;
        if (event.conversationId === activeConvId) {
          chatStatus.textContent = event.status || '';
          insStatus.textContent = event.status || 'idle';
          updateTypingIndicator(event.status);
        }
      }
      return;
    }
  }

  // Create conversation
  async function createConversation(type) {
    const botName = botSelect.value;
    const userId = document.getElementById('simUserId').value || 'sim-user-1';
    const username = document.getElementById('simUsername').value || 'simulator';

    const body = { type, botName, userId, username };

    // For channel type, prompt for name
    if (type === 'slack_channel') {
      const name = prompt('Channel name (e.g. #general):', '#general');
      if (!name) return;
      body.channelName = name.startsWith('#') ? name : '#' + name;
    }

    const res = await fetch('/simulator/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      conversations[data.conversation.id] = data.conversation;
      selectConversation(data.conversation.id);
      renderConvList();
    }
  }

  // Send message
  async function sendMessage() {
    if (!activeConvId || !chatInput.value.trim()) return;

    const text = chatInput.value.trim();
    chatInput.value = '';
    chatInput.style.height = 'auto';

    await fetch('/simulator/conversations/' + activeConvId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  // Select conversation
  function selectConversation(id) {
    activeConvId = id;
    chatInput.disabled = false;
    chatSend.disabled = false;
    renderConvList();
    renderChat();
    updateInspector();
  }

  // Render conversation list
  function renderConvList() {
    const convs = Object.values(conversations);
    if (convs.length === 0) {
      convList.innerHTML = '<div class="empty-state">No conversations yet</div>';
      return;
    }

    convList.innerHTML = convs.map(function(c) {
      const isActive = c.id === activeConvId;
      const isTg = c.type.startsWith('telegram');
      const badge = isTg
        ? '<span class="conv-item-badge badge-tg">TG</span>'
        : '<span class="conv-item-badge badge-slack">Slack</span>';
      const label = c.channelName || c.type.replace('_', ' ');
      const lastMsg = c.messages.length > 0
        ? c.messages[c.messages.length - 1].text.slice(0, 40) + (c.messages[c.messages.length - 1].text.length > 40 ? '...' : '')
        : 'No messages';

      return '<div class="conv-item' + (isActive ? ' active' : '') + '" data-id="' + c.id + '">'
        + '<div class="conv-item-title">' + badge + escapeHtml(c.botName) + '</div>'
        + '<div class="conv-item-sub">' + escapeHtml(label) + ' | ' + escapeHtml(lastMsg) + '</div>'
        + '</div>';
    }).join('');

    // Attach click handlers
    convList.querySelectorAll('.conv-item').forEach(function(el) {
      el.onclick = function() { selectConversation(el.dataset.id); };
    });
  }

  // Render full chat view
  function renderChat() {
    const conv = conversations[activeConvId];
    if (!conv) return;

    const isTg = conv.type.startsWith('telegram');
    const titlePrefix = isTg ? 'Telegram' : 'Slack';
    const titleSuffix = conv.channelName || conv.type.split('_').pop();
    chatHeader.querySelector('.chat-title').textContent = titlePrefix + ' | ' + conv.botName + ' | ' + titleSuffix;
    chatStatus.textContent = conv.status || '';

    chatMessages.innerHTML = '';
    for (const msg of conv.messages) {
      appendMessage(msg, conv.type);
    }
    updateTypingIndicator(conv.status);
    scrollToBottom();
  }

  // Append a single message to the chat
  function appendMessage(msg, convType) {
    // Remove typing indicator if present
    const existing = chatMessages.querySelector('.typing-indicator');
    if (existing && msg.sender === 'bot') existing.remove();

    const isTg = convType.startsWith('telegram');
    const div = document.createElement('div');
    div.className = 'msg msg-' + msg.sender + (msg.sender === 'bot' ? (isTg ? ' telegram' : ' slack') : '');

    // For bot messages: render HTML for telegram, render mrkdwn-ish for slack
    if (msg.sender === 'bot' && isTg) {
      div.innerHTML = sanitizeTelegramHtml(msg.text);
    } else if (msg.sender === 'bot') {
      div.innerHTML = renderSlackMrkdwn(msg.text);
    } else {
      div.textContent = msg.text;
    }

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString();
    div.appendChild(time);

    chatMessages.appendChild(div);
    scrollToBottom();
  }

  // Typing indicator
  function updateTypingIndicator(status) {
    const existing = chatMessages.querySelector('.typing-indicator');
    if (existing) existing.remove();

    if (status && status.length > 0) {
      const indicator = document.createElement('div');
      indicator.className = 'typing-indicator';
      indicator.innerHTML = '<span></span><span></span><span></span>';
      chatMessages.appendChild(indicator);
      scrollToBottom();
    }
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Update inspector panel
  function updateInspector() {
    const conv = conversations[activeConvId];
    if (!conv) return;
    insBotName.textContent = conv.botName;
    insPlatform.textContent = conv.type.replace(/_/g, ' ');
    insUser.textContent = conv.username + ' (' + conv.userId + ')';
    insStatus.textContent = conv.status || 'idle';
    insMsgCount.textContent = String(conv.messages.length);
  }

  // Activity feed
  function addActivityItem(type, text) {
    if (activityFeed.querySelector('.empty-state')) {
      activityFeed.innerHTML = '';
    }
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.innerHTML = '<span class="act-time">' + new Date().toLocaleTimeString() + '</span> '
      + '<span class="act-type">' + type + '</span> '
      + escapeHtml(text);
    activityFeed.insertBefore(div, activityFeed.firstChild);

    // Keep max 50 items
    while (activityFeed.children.length > 50) {
      activityFeed.removeChild(activityFeed.lastChild);
    }
  }

  // Minimal Slack mrkdwn renderer
  function renderSlackMrkdwn(text) {
    // Extract Slack links before HTML escaping (they use < > which escapeHtml converts)
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

  // Sanitize Telegram HTML — only allow safe tags and attributes
  function sanitizeTelegramHtml(html) {
    var allowedTags = ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'a', 'br', 'span'];
    var tmp = document.createElement('div');
    tmp.innerHTML = html;

    function walk(node) {
      var children = Array.from(node.childNodes);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 1) { // Element
          var tag = child.tagName.toLowerCase();
          if (allowedTags.indexOf(tag) === -1) {
            // Replace disallowed element with its text content
            var text = document.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
          } else {
            // Strip all attributes except href on <a> (http/https only) and class on <code>
            var attrs = Array.from(child.attributes);
            for (var j = 0; j < attrs.length; j++) {
              var attr = attrs[j];
              if (tag === 'a' && attr.name === 'href' && /^https?:\\/\\//.test(attr.value)) continue;
              if (tag === 'code' && attr.name === 'class') continue;
              child.removeAttribute(attr.name);
            }
            // Set target=_blank on links
            if (tag === 'a') child.setAttribute('target', '_blank');
            walk(child);
          }
        }
      }
    }
    walk(tmp);
    return tmp.innerHTML;
  }

  // Event listeners
  document.querySelectorAll('.new-conv-btn').forEach(function(btn) {
    btn.onclick = function() { createConversation(btn.dataset.type); };
  });

  chatSend.onclick = sendMessage;

  chatInput.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Auto-resize textarea
  chatInput.oninput = function() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  };

  // Init
  loadBots();
  connectWs();
})();
`;
