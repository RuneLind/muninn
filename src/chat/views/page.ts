import { SHARED_STYLES, renderNav } from "../../dashboard/views/shared-styles.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "../../dashboard/views/components/agent-status-ui.ts";
import { requestProgressStyles, requestProgressHtml, requestProgressScript } from "../../dashboard/views/components/request-progress-ui.ts";
import { botSelectorStyles, botSelectorHtml } from "../../dashboard/views/components/bot-selector.ts";
import { helpersScript } from "../../dashboard/views/components/helpers.ts";
import { docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "../../dashboard/views/components/doc-panel.ts";

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
    ${CHAT_STYLES}
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
      <h3 class="ins-heading">Activity Feed</h3>
      <div class="activity-feed" id="activityFeed">
        <div class="empty-state">Waiting for events...</div>
      </div>
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
    ${CHAT_SSE_SCRIPT}
    ${CHAT_SCRIPT}
  </script>
</body>
</html>`;
}

const CHAT_STYLES = `
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
    .sidebar-user-selector {
      padding: 10px 16px 6px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sidebar-user-selector label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .sidebar-user-selector select {
      flex: 1;
      padding: 4px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      min-width: 0;
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
    .thread-item-desc {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
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
    .thread-item-delete {
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 14px;
      cursor: pointer;
      flex-shrink: 0;
      padding: 0;
      line-height: 1;
      transition: background 0.15s, color 0.15s;
    }
    .thread-item:hover .thread-item-delete { display: flex; }
    .thread-item:hover .thread-item-time { display: none; }
    .thread-item-delete:hover { background: color-mix(in srgb, #e53935 15%, transparent); color: #e53935; }

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
      gap: 12px;
      background: var(--bg-panel);
    }
    .chat-header-left { min-width: 0; }
    .chat-title { font-size: 14px; font-weight: 500; }
    .chat-description { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
    .chat-description:empty { display: none; }
    .sidebar-connector {
      padding: 8px 16px 6px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sidebar-connector label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    .sidebar-connector select {
      flex: 1;
      padding: 4px 6px;
      border: 1px solid var(--border-primary);
      border-radius: 4px;
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 12px;
      min-width: 0;
    }
    .sidebar-connector select:focus { outline: none; border-color: var(--accent); }
    .chat-status { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; max-width: 50%; }
    .chat-status:empty { display: none; }
    .chat-status .status-detail { color: var(--accent-light, #a8b4ff); }
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
    .msg-prompt {
      background: color-mix(in srgb, var(--chat-user-bg) 50%, transparent);
      color: var(--text-muted);
      font-size: 12px;
      font-style: italic;
    }
    .msg-research-card {
      align-self: stretch;
      max-width: 100%;
      background: var(--bg-card, var(--bg-surface));
      border: 1px solid var(--border-primary);
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      padding: 0;
      white-space: normal;
    }
    .research-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--border-primary);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .research-card-label { color: var(--accent-light, var(--accent)); }
    .research-card-title {
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      text-transform: none;
      letter-spacing: 0;
    }
    .research-card-prompt {
      padding: 8px 14px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border-primary);
      white-space: pre-wrap;
    }
    .research-card-body {
      padding: 10px 14px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary);
      max-height: 400px;
      overflow-y: auto;
    }
    .research-card-body h2, .research-card-body h3, .research-card-body h4 {
      color: var(--text-primary);
      margin: 12px 0 6px 0;
    }
    .research-card-body h2:first-child, .research-card-body h3:first-child { margin-top: 0; }
    .research-card-body ol, .research-card-body ul {
      margin: 6px 0;
      padding-left: 24px;
    }
    .research-card-body li { margin-bottom: 4px; }
    .research-card-body a { color: var(--accent-light); text-decoration: underline; }
    .research-actions {
      display: flex;
      gap: 8px;
      padding: 12px 0 4px;
      align-self: stretch;
      max-width: 100%;
    }
    .research-actions button {
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card, var(--bg-surface));
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .research-actions button:hover {
      background: var(--accent);
      color: var(--bg-primary);
      border-color: var(--accent);
    }
    .research-actions button .btn-icon { font-size: 14px; }
    .research-actions.used button { opacity: 0.5; pointer-events: none; }
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
    /* Shared web rich-content styles (used by both .msg-bot.web and .msg-streaming.web)
       Since .msg uses white-space:pre-wrap, \n\n around block elements already adds a
       blank line. Use minimal/negative margins on blocks to avoid double-spacing. */
    .web-content h2, .web-content h3, .web-content h4, .web-content h5, .web-content h6 {
      margin: -0.2em 0 0; font-weight: 600; line-height: 1.3;
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
      margin: 0;
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
      margin: 0;
      padding: 4px 12px;
      color: var(--text-muted);
      white-space: normal;
    }
    .web-content ul, .web-content ol {
      margin: 0;
      padding-left: 24px;
      white-space: normal;
    }
    .web-content li { margin: 2px 0; }
    .web-content hr {
      border: none;
      border-top: 1px solid var(--border-primary);
      margin: 0;
    }
    .web-content table {
      border-collapse: collapse;
      margin: 0;
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
    .web-content p { margin: 0; }
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

    /* Tool status line — each tool call gets its own line */
    .msg-tool-status {
      align-self: flex-start;
      max-width: 90%;
      padding: 3px 12px;
      font-size: 12px;
      font-style: italic;
      color: var(--text-muted);
      opacity: 0.7;
      line-height: 1.4;
    }
    .msg-tool-status .tool-label {
      color: var(--text-muted);
    }
    .msg-tool-status .tool-detail {
      color: var(--accent-light, #a8b4ff);
      font-style: normal;
      opacity: 0.9;
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

    /* Document overlay (knowledge index viewer) */
    ${docPanelStyles("docSlideIn")}

    /* Index link button appended next to matching URLs */
    .index-link-inline {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: 6px;
      padding: 1px 6px;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light) !important;
      font-size: 11px;
      border-radius: 3px;
      text-decoration: none !important;
      cursor: pointer;
      vertical-align: baseline;
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .index-link-inline:hover {
      background: color-mix(in srgb, var(--accent) 25%, transparent);
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    }

    /* Thread creation modal */
    .thread-modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .thread-modal-backdrop.visible { display: flex; }
    .thread-modal {
      background: var(--bg-panel);
      border: 1px solid var(--border-secondary);
      border-radius: 12px;
      width: 90vw;
      max-width: 420px;
    }
    .thread-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border-primary);
    }
    .thread-modal-header h3 { font-size: 14px; color: var(--text-primary); margin: 0; }
    .thread-modal-close {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      padding: 2px 6px;
    }
    .thread-modal-close:hover { color: var(--text-primary); }
    .thread-modal-body { padding: 14px 18px; }
    .thread-form-group { margin-bottom: 12px; }
    .thread-form-group label {
      display: block;
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .thread-form-group input,
    .thread-form-group select {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      color: var(--text-secondary);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
    }
    .thread-form-group input:focus,
    .thread-form-group select:focus { outline: none; border-color: var(--accent); }
    .thread-form-hint {
      font-size: 11px;
      color: var(--text-faint);
      margin-top: 4px;
    }
    .thread-form-hint:empty { display: none; }
    .thread-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 18px;
      border-top: 1px solid var(--border-primary);
    }
    .thread-modal-footer button {
      padding: 7px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border-secondary);
      transition: all 0.15s;
    }
    .thread-modal-cancel {
      background: var(--bg-surface);
      color: var(--text-secondary);
    }
    .thread-modal-save {
      background: var(--accent);
      color: var(--text-primary);
      border-color: var(--accent) !important;
    }
    .thread-modal-save:hover { background: var(--accent-hover); }

    /* Thread model label in sidebar */
    .thread-item-model {
      font-size: 10px;
      color: var(--accent-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
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
  var connectors = [];  // Available connectors from DB
  var ws = null;
  var deepLinkHandled = false;
  var inspectorContextKey = null;
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
  var activityFeed = document.getElementById('activityFeed');
  var inspectorContent = document.getElementById('inspectorContent');
  var inspectorContext = document.getElementById('inspectorContext');

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
    document.querySelectorAll('.bot-pill').forEach(function(p) {
      p.classList.toggle('active', p.dataset.bot === name);
    });

    // Load users for this bot and populate selector
    await loadUsersForBot(name);

    // Update connector dropdown (bot default label changes per bot)
    populateConnectorDropdown();

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

  // User selector change
  document.getElementById('userSelector').addEventListener('change', async function(e) {
    var userId = e.target.value;
    var opt = e.target.selectedOptions[0];
    selectedUserId = userId;
    selectedUsername = opt ? opt.textContent : userId;
    try { localStorage.setItem('muninn-chat-user-' + selectedBot, userId); } catch {}
    // Re-resolve conversation and threads for new user
    await resolveConversation();
    activeThreadId = null;
    clearChat();
    await loadThreads();
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
              removeIntermediates();
              removeStreamingBubble();
              setChatStatusText('');
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

    if (event.type === 'tool_status') {
      if (event.conversationId !== activeConvId) return;
      var tsThread = event.threadId || null;
      if (activeThreadId && tsThread !== activeThreadId) return;
      appendToolStatus(event.text);
      return;
    }

    if (event.type === 'status') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.status = event.status;
        if (event.conversationId === activeConvId) {
          setChatStatusText(event.status || '');
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
    // Reset streaming and research state when switching threads
    streamingRawText = '';
    streamingRafPending = false;
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

  // Append a tool status line (each tool gets its own line, not replaced)
  // Splits "Label: detail" into styled spans for visual distinction
  function appendToolStatus(text) {
    var line = document.createElement('div');
    line.className = 'msg-tool-status msg-intermediate';
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
    chatMessages.appendChild(line);
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
    var html =
      '<div class="ins-user-header">'
        + '<div class="ins-user-avatar" style="' + avatarStyle(aName) + '">' + escapeHtml(initial) + '</div>'
        + '<div class="ins-user-info">'
          + '<div class="ins-user-name">' + escapeHtml(selectedUsername || selectedUserId) + '</div>'
          + '<div class="ins-user-id">' + escapeHtml(selectedUserId) + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Bot</span><span class="ins-info-value">' + escapeHtml(selectedBot) + '</span></div>';

    var botInfo = getBotInfo();
    if (botInfo) {
      html += '<div class="ins-info-row"><span class="ins-info-label">Connector</span><span class="ins-info-value">' + escapeHtml(botInfo.connector) + '</span></div>';
      if (botInfo.model) html += '<div class="ins-info-row"><span class="ins-info-label">Model</span><span class="ins-info-value">' + escapeHtml(botInfo.model) + '</span></div>';
      if (botInfo.baseUrl) html += '<div class="ins-info-row"><span class="ins-info-label">Endpoint</span><span class="ins-info-value" style="font-size:10px">' + escapeHtml(botInfo.baseUrl) + '</span></div>';
    }

    html += '<div class="ins-info-row"><span class="ins-info-label">Thread</span><span class="ins-info-value">' + escapeHtml(activeThreadId ? (function() { var m = null; for (var i = 0; i < threads.length; i++) { if (threads[i].id === activeThreadId) { m = threads[i].name; break; } } return m || 'main'; })() : 'none') + '</span></div>'
      + '<div class="ins-info-row"><span class="ins-info-label">Status</span><span class="ins-info-value">' + escapeHtml(statusText || 'idle') + '</span></div>'
      + '<hr class="ins-divider">';
    inspectorContent.innerHTML = html;

    var contextKey = selectedUserId + ':' + selectedBot;
    if (inspectorContextKey !== contextKey) {
      inspectorContextKey = contextKey;
      loadInspectorContext(selectedUserId, selectedBot);
    }
  }

  function getBotInfo() {
    if (!selectedBot || !bots.length) return null;
    for (var i = 0; i < bots.length; i++) {
      if (bots[i].name === selectedBot) return bots[i];
    }
    return null;
  }

  // --- Connector dropdown ---
  var connectorDropdown = document.getElementById('connectorDropdown');
  var connectorSelector = document.getElementById('connectorSelector');
  var selectedConnectorId = '';  // '' = bot default

  function connectorStorageKey() {
    return 'muninn-connector-' + (selectedBot || 'default');
  }

  function populateConnectorDropdown() {
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

    // Restore per-bot selection; reset if stored ID no longer exists
    try { selectedConnectorId = localStorage.getItem(connectorStorageKey()) || ''; } catch {}
    connectorDropdown.value = selectedConnectorId;
    if (connectorDropdown.value !== selectedConnectorId) {
      selectedConnectorId = '';
      connectorDropdown.value = '';
      try { localStorage.removeItem(connectorStorageKey()); } catch {}
    }
  }

  connectorDropdown.addEventListener('change', function() {
    selectedConnectorId = connectorDropdown.value;
    try { localStorage.setItem(connectorStorageKey(), selectedConnectorId); } catch {}
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

    // Defensive normalization: Claude occasionally outputs Slack-style links (<url|text>)
    // instead of standard markdown. Not an intermediate Slack→HTML conversion — input is
    // always raw markdown from the AI connector.
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

    // Collapse blank lines around block-level elements — their CSS handles spacing,
    // and pre-wrap would otherwise render the \\n as extra visible line breaks.
    var blockRe = '(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)';
    result = result.replace(new RegExp('\\\\n+(</?' + blockRe + '[>\\\\s])', 'g'), '\\n$1');
    result = result.replace(new RegExp('(</' + blockRe + '>|<hr>)\\\\n+', 'g'), '$1\\n');

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
  var _webTags = _tgTags.concat(['h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'p', 'details', 'summary']);

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

  // Gate waterfall overlay on per-bot showWaterfall config
  var _origUpdateRP = updateRequestProgress;
  updateRequestProgress = function(progress) {
    if (progress && progress.botName) {
      var bot = bots.find(function(b) { return b.name === progress.botName; });
      if (bot && bot.showWaterfall === false) {
        // Still update agent status (connector + model) even when waterfall is hidden
        if (typeof updateAgentStatusFromProgress === 'function') {
          updateAgentStatusFromProgress(progress);
        }
        return;
      }
    }
    _origUpdateRP(progress);
  };

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
