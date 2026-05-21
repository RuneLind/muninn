/** Chat page styles — layout, sidebar, messages, inspector, modals */
export function chatStyles(): string {
  return `
    /* ── Chat-page-scoped refined palette (dark). chatStyles() is served only on
       /chat, so these :root overrides do NOT affect the dashboard. --bg-elevated
       is a NEW token (not in shared-styles); the rest override shared values.
       Promote both to shared-styles.ts in a later dashboard pass. ── */
    :root {
      --bg-page: #0b0b0f;
      --bg-panel: #101016;
      --bg-surface: #1e1e29;
      --bg-elevated: #282835;
      --bg-inset: #0e0e13;
      --border-primary: #2a2a38;
      --border-secondary: #353544;
      --border-subtle: #232330;
      --chat-assistant-text: #b4b4bf;
      --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    }
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
      position: relative;
      padding: 9px 11px;
      border-radius: 9px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
      margin-bottom: 3px;
    }
    .thread-item:hover { background: var(--bg-surface); }
    .thread-item.active { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
    .thread-item.active::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 99px; background: var(--accent); }
    .thread-item-top { display: flex; align-items: center; gap: 7px; }
    .thread-item-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      border: 1.5px solid var(--text-faint);
      box-sizing: border-box;
      flex-shrink: 0;
    }
    .thread-item.active .thread-item-dot { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
    .thread-item-dot.peer { border-color: var(--accent-light); }
    .thread-item-dot.paused { border-color: #f0883e; background: #f0883e; }
    .thread-item-name {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 500;
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thread-item-desc {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin: 3px 0 7px 14px;
    }
    .thread-item-chips { display: flex; gap: 5px; margin-left: 14px; flex-wrap: wrap; }
    .thread-chip {
      font-size: 10px;
      font-family: var(--mono);
      color: var(--text-muted);
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 1px 7px;
      white-space: nowrap;
    }
    .thread-chip.count { color: var(--text-faint); }
    .thread-item-time {
      font-size: 10.5px;
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
    .chat-header-pill {
      font-size: 11px;
      padding: 3px 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .chat-header-pill:hover { color: var(--text-primary); }
    .auto-respond-pill { border-radius: 999px; }
    .auto-respond-pill:hover { border-color: var(--accent, #58a6ff); }
    .auto-respond-pill.paused { color: #f0883e; border-color: #f0883e; }
    .auto-respond-pill[disabled] { opacity: 0.5; cursor: progress; }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .msg {
      align-self: stretch;
      max-width: none;
      padding: 16px 24px;
      border-radius: 0;
      font-size: 14px;
      line-height: 1.6;
      word-wrap: break-word;
    }
    /* Header band on every message (identity dot · name · model · time).
       The negative margin must equal .msg padding (16px 24px) so the band
       bleeds to the row edges; .msg-peer resets both for its card. */
    .msg-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: -16px -24px 14px;
      padding: 9px 24px;
      background: var(--bg-elevated);
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, var(--bg-page));
      font-size: 11.5px;
      color: var(--text-faint);
    }
    .msg-head-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .msg-head-name { font-size: 12.5px; font-weight: 650; color: var(--text-primary); }
    .msg-head-model { font-family: var(--mono); color: var(--text-soft); }
    .msg-head-sep { opacity: .4; }
    .msg-head-time { font-family: var(--mono); color: var(--text-faint); margin-left: auto; }
    .msg-body { white-space: pre-wrap; }
    .msg-user {
      color: var(--text-secondary);
    }
    .msg-prompt {
      background: color-mix(in srgb, var(--chat-user-bg) 50%, transparent);
      color: var(--text-muted);
      font-size: 12px;
      font-style: italic;
    }
    .msg-research-card {
      align-self: stretch;
      max-width: none;
      margin: 8px 24px;
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
      padding: 12px 24px 4px;
      align-self: stretch;
      max-width: none;
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
      color: var(--chat-assistant-text);
    }
    /* Peer (hivemind) messages keep their own labelled accent card */
    .msg-peer {
      margin: 8px 24px;
      padding: 0;
      background: color-mix(in srgb, var(--accent) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-primary));
      border-radius: 10px;
      color: var(--chat-assistant-text);
    }
    .msg-peer .msg-head {
      margin: 0;
      padding: 9px 14px;
      border-radius: 10px 10px 0 0;
      background: color-mix(in srgb, var(--accent) 9%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
      color: var(--accent-light);
    }
    .msg-peer .msg-head-name { color: var(--accent-light); }
    .msg-peer .msg-body { padding: 0 14px 12px; }
    .msg-peer-tag {
      font-family: var(--mono);
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--accent-light);
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .thread-item.paused .thread-item-name,
    .thread-item.paused .thread-item-desc { color: var(--text-muted); }
    .thread-item-tag {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      border-radius: 4px;
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      color: var(--accent-light, var(--accent));
      vertical-align: middle;
    }
    .msg-bot a { color: var(--accent-light); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent-light) 40%, transparent); }
    .msg-bot a:hover { text-decoration-color: var(--accent-light); }
    .msg-bot.telegram { font-family: inherit; }
    .msg-bot.slack { font-family: 'Slack-Lato', -apple-system, sans-serif; }
    /* Shared web rich-content styles (used by both .msg-bot.web and .msg-streaming.web)
       Since .msg-body uses white-space:pre-wrap, \\n\\n around block elements already adds a
       blank line. Use minimal/negative margins on blocks to avoid double-spacing. */
    .web-content h2, .web-content h3, .web-content h4, .web-content h5, .web-content h6 {
      margin: -0.2em 0 0; font-weight: 600; line-height: 1.3; color: var(--text-primary);
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
    .web-content strong { font-weight: 600; color: var(--text-primary); }
    .web-content em { font-style: italic; }
    .web-content a { color: var(--accent-light); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent-light) 40%, transparent); }
    .web-content a:hover { text-decoration-color: var(--accent-light); }
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
      margin: 8px 24px;
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
    .ins-info-value { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .ins-info-value-cache { color: var(--status-ok, #27ae60); }
    .ins-info-value-cost { color: var(--accent-light, #a8b4ff); }
    .ins-info-detail {
      color: var(--text-faint);
      font-size: 10px;
      margin-left: 2px;
      font-variant-numeric: tabular-nums;
    }
    .ins-divider { border: none; border-top: 1px solid var(--border-primary); margin: 10px 0; }
    .ins-context-bar {
      height: 4px;
      background: var(--bg-tertiary, #2a2a3a);
      border-radius: 2px;
      margin: 4px 0 2px;
      overflow: hidden;
    }
    .ins-context-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
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
    .ins-skip-extractions {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      text-transform: none;
      letter-spacing: 0;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
    }
    .ins-skip-extractions:hover { color: var(--text-primary); }
    .ins-skip-extractions input { margin: 0; cursor: pointer; }
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

    .ins-tool-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 0;
      font-size: 11px;
    }
    .ins-tool-name { color: var(--text-muted); }
    .ins-tool-time { color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .ins-tool-subhead {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      font-weight: 600;
      margin: 8px 0 4px;
      padding-bottom: 3px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .ins-section-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .ins-mcp-refresh {
      background: var(--bg-inset);
      border: 1px solid var(--border-primary);
      color: var(--text-secondary);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 13px;
      cursor: pointer;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      text-transform: none;
      letter-spacing: 0;
    }
    .ins-mcp-refresh:hover:not(:disabled) {
      color: var(--text-primary);
      background: var(--bg-surface);
      border-color: var(--accent, #7c6fe0);
    }
    .ins-mcp-refresh:disabled { opacity: 0.5; cursor: default; }
    .ins-mcp-row {
      font-size: 11px;
      color: var(--text-soft);
      border-radius: 4px;
      margin-bottom: 1px;
    }
    .ins-mcp-row.critical {
      background: rgba(231, 76, 60, 0.08);
      color: var(--status-error, #e74c3c);
    }
    .ins-mcp-row-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      border-radius: 4px;
    }
    .ins-mcp-row-header.expandable {
      cursor: pointer;
      user-select: none;
    }
    .ins-mcp-row-header.expandable:hover {
      background: var(--bg-inset);
    }
    .ins-mcp-caret {
      width: 10px;
      display: inline-block;
      color: var(--text-faint);
      font-size: 9px;
      transition: transform 0.1s ease;
      flex-shrink: 0;
    }
    .ins-mcp-caret.open { transform: rotate(90deg); }
    .ins-mcp-caret-spacer { width: 10px; display: inline-block; flex-shrink: 0; }
    .ins-mcp-name { flex: 1; }
    .ins-mcp-detail { color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .ins-mcp-row.critical .ins-mcp-detail { color: var(--status-error, #e74c3c); }
    .ins-mcp-detail-block {
      padding: 4px 6px 8px 28px;
      font-size: 11px;
    }
    .ins-mcp-subtitle {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      margin: 6px 0 3px;
    }
    .ins-mcp-subtitle:first-child { margin-top: 0; }
    .ins-mcp-subitem {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1px 0;
      color: var(--text-soft);
    }
    .ins-mcp-subname { flex: 1; }
    .ins-mcp-subcount {
      color: var(--text-faint);
      font-variant-numeric: tabular-nums;
      margin-left: 8px;
    }
    .ins-mcp-collerr {
      padding: 4px 6px;
      font-size: 11px;
      color: var(--status-warning, #f39c12);
      background: rgba(243, 156, 18, 0.08);
      border-radius: 4px;
      margin-bottom: 6px;
    }
    .ins-mcp-tool-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
    }
    .ins-mcp-tool-chip {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--bg-inset);
      color: var(--text-muted);
      border: 1px solid var(--border-subtle);
    }
    .ins-mcp-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--text-disabled);
    }
    .ins-mcp-dot.ok { background: var(--status-ok, #27ae60); }
    .ins-mcp-dot.down { background: var(--status-warning, #f39c12); }
    .ins-mcp-dot.down-critical { background: var(--status-error, #e74c3c); }
    .ins-mcp-dot.unknown { background: var(--text-disabled); }
    .ins-mcp-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid var(--text-faint);
      border-top-color: transparent;
      border-radius: 50%;
      display: inline-block;
      animation: ins-mcp-spin 0.8s linear infinite;
    }
    @keyframes ins-mcp-spin { to { transform: rotate(360deg); } }

    .empty-state { color: var(--text-disabled); font-size: 13px; text-align: center; padding: 24px 0; }

    /* Streaming bubble — full-width transient row */
    .msg-streaming {
      align-self: stretch;
      max-width: none;
      color: var(--chat-assistant-text);
      padding: 16px 24px;
      font-size: 14px;
      line-height: 1.6;
      word-wrap: break-word;
      white-space: pre-wrap;
      opacity: 0.85;
    }
    .msg-intermediate { white-space: pre-wrap; opacity: 0.92; }
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

    /* Tool activity container — sits between user query and bot response */
    .tool-activity {
      margin: 4px 0;
      padding: 0 12px;
      align-self: flex-start;
      max-width: 90%;
    }
    .tool-activity-header {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 12px;
      color: var(--text-muted);
      padding: 4px 12px;
      user-select: none;
    }
    .tool-activity-header:hover {
      color: var(--text-secondary);
    }
    .tool-activity-label {
      opacity: 0.7;
    }
    .tool-activity-toggle {
      background: none;
      border: none;
      color: inherit;
      font-size: 10px;
      cursor: pointer;
      padding: 0;
      transition: transform 0.15s ease;
    }
    .tool-activity.collapsed .tool-activity-toggle {
      transform: rotate(-90deg);
    }
    .tool-activity.collapsed .tool-activity-body {
      display: none;
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

    /* Jira issue-key links (MELOSYS-1234 → jira browse) */
    .issue-link {
      font-family: var(--mono);
      font-size: 0.92em;
      color: var(--accent-light);
      text-decoration: none;
      border-bottom: 1px solid color-mix(in srgb, var(--accent-light) 40%, transparent);
      white-space: nowrap;
    }
    .issue-link:hover { border-bottom-color: var(--accent-light); }

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
  `;
}
