export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
    }

    /* Header */
    header {
      background: #12121a;
      border-bottom: 1px solid #1e1e2e;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { font-size: 20px; font-weight: 600; color: #fff; }
    header h1 span { color: #6c63ff; }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #888;
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #444;
    }
    .status-dot.connected { background: #4ade80; }
    .header-left { display: flex; align-items: center; gap: 16px; }

    /* Agent Status */
    .agent-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #555;
      padding: 4px 10px;
      border-radius: 6px;
      background: transparent;
      transition: all 0.3s ease;
    }
    .agent-status.working {
      background: rgba(108, 99, 255, 0.1);
      border: 1px solid rgba(108, 99, 255, 0.2);
      color: #a5a0ff;
    }
    .agent-spinner {
      width: 14px; height: 14px;
      border: 2px solid transparent;
      border-top-color: #6c63ff;
      border-radius: 50%;
      display: none;
    }
    .agent-status.working .agent-spinner {
      display: block;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .agent-phase { font-weight: 500; }
    .agent-user { color: #666; }

    /* Stats Bar */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      padding: 16px 24px;
      background: #0a0a0f;
    }
    .stat-card {
      background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: box-shadow 0.2s;
    }
    .stat-card:hover {
      box-shadow: 0 0 20px rgba(108, 99, 255, 0.15);
    }
    .stat-icon { font-size: 18px; margin-bottom: 4px; }
    .stat-value { color: #fff; font-weight: 700; font-size: 24px; line-height: 1; }
    .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Main Grid */
    .main-grid {
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 16px;
      padding: 0 24px 24px;
      min-height: calc(100vh - 200px);
    }

    /* Panels */
    .panel {
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      overflow: hidden;
    }
    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid #1e1e2e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: #ccc;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .panel-header .count {
      background: #1e1e2e;
      color: #888;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }
    .panel-body {
      padding: 8px;
      max-height: 320px;
      overflow-y: auto;
    }
    .panel-body::-webkit-scrollbar { width: 4px; }
    .panel-body::-webkit-scrollbar-track { background: transparent; }
    .panel-body::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
    .panel-empty {
      padding: 24px;
      text-align: center;
      color: #444;
      font-size: 13px;
    }

    /* Left column stacking */
    .left-col { display: flex; flex-direction: column; gap: 16px; }
    .right-col { display: flex; flex-direction: column; gap: 16px; }

    /* Goal items */
    .goal-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .goal-item:hover { background: #ffffff06; }
    .goal-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
    }
    .goal-dot.active { background: #4ade80; }
    .goal-dot.completed { background: #6c63ff; }
    .goal-dot.cancelled { background: #666; }
    .goal-info { flex: 1; min-width: 0; }
    .goal-title { font-size: 13px; color: #ddd; margin-bottom: 4px; }
    .goal-item.done .goal-title { text-decoration: line-through; color: #555; }
    .goal-item.done { opacity: 0.5; }
    .goal-meta { font-size: 11px; color: #555; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    /* Task items */
    .task-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .task-item:hover { background: #ffffff06; }
    .task-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
      margin-top: 2px;
    }
    .task-badge.reminder { background: #1e3a5f; color: #60a5fa; }
    .task-badge.briefing { background: #2a1a3a; color: #c084fc; }
    .task-badge.custom { background: #2a2a1a; color: #facc15; }
    .task-badge.disabled { background: #1a1a1a; color: #555; }
    .task-info { flex: 1; min-width: 0; }
    .task-title { font-size: 13px; color: #ddd; margin-bottom: 4px; }
    .task-schedule { font-size: 11px; color: #555; }

    /* Watcher items */
    .watcher-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
      cursor: pointer;
      position: relative;
    }
    .watcher-item:hover { background: #ffffff06; }
    .watcher-item.active { background: rgba(108, 99, 255, 0.08); border: 1px solid rgba(108, 99, 255, 0.2); margin: -1px; }
    .watcher-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
      margin-top: 2px;
    }
    .watcher-badge.email { background: #1e3a5f; color: #60a5fa; }
    .watcher-badge.calendar { background: #2a1a3a; color: #c084fc; }
    .watcher-badge.github { background: #1a2a1a; color: #4ade80; }
    .watcher-badge.news { background: #2a2a1a; color: #facc15; }
    .watcher-badge.disabled { background: #1a1a1a; color: #555; }
    .watcher-info { flex: 1; min-width: 0; }
    .watcher-title { font-size: 13px; color: #ddd; margin-bottom: 4px; }
    .watcher-meta { font-size: 11px; color: #555; }

    /* Watcher detail popover */
    .watcher-detail {
      display: none;
      margin-top: 8px;
      padding: 10px 12px;
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      border-radius: 6px;
      font-size: 12px;
      color: #999;
      line-height: 1.8;
    }
    .watcher-item:hover .watcher-detail { display: block; }
    .watcher-detail .detail-row { display: flex; justify-content: space-between; gap: 16px; }
    .watcher-detail .detail-label { color: #666; }
    .watcher-detail .detail-value { color: #bbb; text-align: right; }
    .watcher-view-log {
      display: inline-block;
      margin-top: 6px;
      padding: 3px 10px;
      background: rgba(108, 99, 255, 0.1);
      border: 1px solid rgba(108, 99, 255, 0.25);
      border-radius: 4px;
      color: #a5a0ff;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .watcher-view-log:hover { background: rgba(108, 99, 255, 0.2); color: #c5c0ff; }

    /* Feed filter mode */
    .feed-filter-bar {
      display: none;
      padding: 8px 12px;
      background: rgba(108, 99, 255, 0.08);
      border-bottom: 1px solid rgba(108, 99, 255, 0.15);
      font-size: 12px;
      color: #a5a0ff;
      align-items: center;
      justify-content: space-between;
    }
    .feed-filter-bar.visible { display: flex; }
    .feed-filter-clear {
      background: none;
      border: 1px solid rgba(108, 99, 255, 0.25);
      color: #a5a0ff;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .feed-filter-clear:hover { background: rgba(108, 99, 255, 0.15); }
    .event.feed-dim { opacity: 0.15; }

    /* Memory items */
    .memory-item {
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .memory-item:hover { background: #ffffff06; }
    .memory-summary { font-size: 13px; color: #ccc; margin-bottom: 6px; line-height: 1.4; }
    .memory-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

    /* Tags */
    .tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: #1a1a2e;
      color: #8b8bcd;
      border: 1px solid #2a2a3e;
    }
    .time-ago { font-size: 10px; color: #444; }

    /* Chart */
    .chart-container {
      padding: 16px;
      height: 260px;
    }

    /* Activity Feed */
    .feed-panel .panel-body {
      max-height: none;
      flex: 1;
      min-height: 300px;
    }
    .feed-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .feed-hidden { display: none !important; }
    .feed-show-more {
      padding: 8px 16px;
      text-align: center;
      border-top: 1px solid #1e1e2e;
    }
    .feed-show-more button {
      background: none;
      border: 1px solid #2a2a3a;
      color: #888;
      padding: 6px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s;
    }
    .feed-show-more button:hover {
      border-color: #6c63ff;
      color: #ccc;
    }
    .live-badge {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #4ade80; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .live-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #4ade80;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.4); }
      50% { opacity: 0.6; box-shadow: 0 0 0 4px rgba(74, 222, 128, 0); }
    }

    /* Feed events */
    .event {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .event:hover { background: #ffffff06; }
    .event-time {
      color: #555;
      font-size: 12px;
      font-family: monospace;
      white-space: nowrap;
      min-width: 55px;
    }
    .event-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
      white-space: nowrap;
      min-width: 36px;
      text-align: center;
    }
    .event-text { flex: 1; word-break: break-word; white-space: pre-wrap; }
    .type-message_in .event-badge { background: #1e3a5f; color: #60a5fa; }
    .type-message_out .event-badge { background: #1a3a2a; color: #4ade80; }
    .type-error .event-badge { background: #3a1a1a; color: #f87171; }
    .type-system .event-badge { background: #2a2a1a; color: #facc15; }
    .event-meta {
      color: #555;
      font-size: 11px;
      white-space: nowrap;
    }
    .event-timing {
      margin-left: 79px;
      padding: 4px 8px;
      font-size: 11px;
      font-family: monospace;
      color: #666;
      background: #ffffff04;
      border-radius: 3px;
      line-height: 1.4;
    }
    .event-timing .t-label { color: #555; }
    .event-timing .t-val { color: #8b8bcd; }

    /* Slack Analytics */
    .slack-summary {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      padding: 12px;
    }
    .slack-stat {
      text-align: center;
      padding: 8px;
      background: #1a1a2e;
      border-radius: 6px;
    }
    .slack-stat-value { font-size: 20px; font-weight: 700; color: #fff; }
    .slack-stat-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .slack-section-title {
      font-size: 11px;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 12px 4px;
    }
    .slack-breakdown {
      padding: 0 12px 8px;
    }
    .slack-breakdown-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 12px;
      border-bottom: 1px solid #1a1a2e;
    }
    .slack-breakdown-row:last-child { border-bottom: none; }
    .slack-platform-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .slack-platform-badge.slack_dm { background: #1e3a5f; color: #60a5fa; }
    .slack-platform-badge.slack_channel { background: #1a3a2a; color: #4ade80; }
    .slack-platform-badge.slack_assistant { background: #2a1a3a; color: #c084fc; }
    .slack-user-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      transition: background 0.15s;
      cursor: pointer;
    }
    .slack-user-item:hover { background: #ffffff0a; }
    .slack-user-item:active { background: #ffffff12; }
    .slack-user-item.active { background: rgba(108, 99, 255, 0.08); border: 1px solid rgba(108, 99, 255, 0.2); margin: -1px; }
    .slack-user-name { font-size: 13px; color: #ddd; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .slack-user-meta { font-size: 11px; color: #555; display: flex; gap: 8px; align-items: center; }

    /* Slack message conversation in feed */
    .slack-msg {
      padding: 10px 14px;
      border-radius: 8px;
      margin: 4px 8px;
      max-width: 85%;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .slack-msg.role-user {
      background: #1e3a5f;
      color: #c8ddf5;
      align-self: flex-end;
      margin-left: auto;
      border-bottom-right-radius: 2px;
    }
    .slack-msg.role-assistant {
      background: #1a3a2a;
      color: #c8f5d8;
      align-self: flex-start;
      margin-right: auto;
      border-bottom-left-radius: 2px;
    }
    .slack-msg-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .slack-msg-role {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
    }
    .role-user .slack-msg-role { background: #1e3a5f; color: #60a5fa; }
    .role-assistant .slack-msg-role { background: #1a3a2a; color: #4ade80; }
    .slack-msg-time { color: #555; font-family: monospace; font-size: 11px; }
    .slack-msg-model { color: #666; font-size: 10px; }
    .slack-msg-content { overflow: hidden; }
    .slack-msg-content.collapsed { max-height: 120px; }
    .slack-msg-expand {
      display: inline-block;
      margin-top: 4px;
      color: #6c63ff;
      font-size: 11px;
      cursor: pointer;
    }
    .slack-msg-expand:hover { color: #a5a0ff; }
    .slack-convo-container {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 0;
    }

    /* Responsive */
    @media (max-width: 900px) {
      .stats-bar { grid-template-columns: repeat(3, 1fr); }
      .main-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 500px) {
      .stats-bar { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <h1><span>J</span>arvis</h1>
      <div class="agent-status" id="agentStatus">
        <div class="agent-spinner"></div>
        <span class="agent-phase" id="agentPhase">Idle</span>
        <span class="agent-user" id="agentUser"></span>
      </div>
    </div>
    <div class="status">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Connecting...</span>
    </div>
  </header>

  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-icon">💬</div>
      <div class="stat-value" id="statMsgsToday">-</div>
      <div class="stat-label">Messages Today</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📊</div>
      <div class="stat-value" id="statTotalMsgs">-</div>
      <div class="stat-label">Total Messages</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🧠</div>
      <div class="stat-value" id="statMemories">-</div>
      <div class="stat-label">Memories</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🎯</div>
      <div class="stat-value" id="statGoals">-</div>
      <div class="stat-label">Active Goals</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">⏰</div>
      <div class="stat-value" id="statTasks">-</div>
      <div class="stat-label">Scheduled Tasks</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🔢</div>
      <div class="stat-value" id="statTokens">-</div>
      <div class="stat-label">Total Tokens</div>
    </div>
  </div>

  <div class="main-grid">
    <div class="left-col">
      <div class="panel" id="goalsPanel">
        <div class="panel-header">
          Goals <span class="count" id="goalsCount">0</span>
        </div>
        <div class="panel-body" id="goalsList"></div>
      </div>

      <div class="panel" id="tasksPanel">
        <div class="panel-header">
          Scheduled Tasks <span class="count" id="tasksCount">0</span>
        </div>
        <div class="panel-body" id="tasksList"></div>
      </div>

      <div class="panel" id="watchersPanel">
        <div class="panel-header">
          Watchers <span class="count" id="watchersCount">0</span>
          <span id="watcherTokensBadge" style="font-size:10px;color:#facc15;font-weight:400;text-transform:none;letter-spacing:0"></span>
        </div>
        <div class="panel-body" id="watchersList"></div>
      </div>

      <div class="panel" id="memoriesPanel">
        <div class="panel-header">
          Recent Memories <span class="count" id="memoriesCount">0</span>
        </div>
        <div class="panel-body" id="memoriesList"></div>
      </div>

      <div class="panel" id="slackPanel" style="display:none">
        <div class="panel-header">
          Slack Analytics <span class="count" id="slackMsgCount">0</span>
        </div>
        <div id="slackContent"></div>
      </div>
    </div>

    <div class="right-col">
      <div class="panel">
        <div class="panel-header">Usage (7 Days)</div>
        <div class="chart-container">
          <canvas id="usageChart"></canvas>
        </div>
      </div>

      <div class="panel feed-panel">
        <div class="panel-header">
          Activity Feed
          <div class="live-badge"><div class="live-dot"></div> Live</div>
        </div>
        <div class="feed-filter-bar" id="feedFilterBar">
          <span id="feedFilterLabel">Filtering...</span>
          <button class="feed-filter-clear" onclick="clearFeedFilter()">Clear filter</button>
        </div>
        <div class="panel-body" id="feed"></div>
        <div class="feed-show-more" id="feedShowMore" style="display:none">
          <button id="feedToggleBtn" onclick="toggleFeed()">Show all</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // --- Helpers ---
    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return new Date(ts).toLocaleDateString();
    }

    function deadlineText(ts) {
      if (!ts) return '';
      const diff = ts - Date.now();
      const days = Math.floor(diff / 86400000);
      if (days < 0) return Math.abs(days) + 'd overdue';
      if (days === 0) return 'due today';
      if (days === 1) return 'due tomorrow';
      return 'in ' + days + 'd';
    }

    function fmtMs(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
    }

    function fmtTokens(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : '' + n;
    }

    function formatSchedule(task) {
      if (task.scheduleIntervalMs) {
        const mins = Math.round(task.scheduleIntervalMs / 60000);
        if (mins < 60) return 'Every ' + mins + 'min';
        return 'Every ' + (mins / 60).toFixed(1) + 'h';
      }
      const h = String(task.scheduleHour).padStart(2, '0');
      const m = String(task.scheduleMinute).padStart(2, '0');
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      let days = '';
      if (task.scheduleDays && task.scheduleDays.length < 7) {
        days = ' on ' + task.scheduleDays.map(d => dayNames[d]).join(', ');
      }
      return h + ':' + m + days;
    }

    // --- Stat Cards ---
    function updateStatCards(stats) {
      document.getElementById('statMsgsToday').textContent = stats.messagesToday;
      document.getElementById('statTotalMsgs').textContent = stats.totalMessages;
      document.getElementById('statMemories').textContent = stats.memoriesCount;
      document.getElementById('statGoals').textContent = stats.activeGoalsCount;
      document.getElementById('statTasks').textContent = stats.scheduledTasksCount;
      document.getElementById('statTokens').textContent = fmtTokens(stats.totalTokens);

      // Watcher tokens badge
      const wb = document.getElementById('watcherTokensBadge');
      if (wb && stats.watcherTokensToday > 0) {
        wb.textContent = fmtTokens(stats.watcherTokensToday) + ' tok today';
      } else if (wb && stats.watcherTokensTotal > 0) {
        wb.textContent = fmtTokens(stats.watcherTokensTotal) + ' tok total';
      } else if (wb) {
        wb.textContent = '';
      }
    }

    // --- Goals Panel ---
    function renderGoals(goals) {
      const el = document.getElementById('goalsList');
      document.getElementById('goalsCount').textContent = goals.length;
      if (!goals.length) { el.innerHTML = '<div class="panel-empty">No goals yet</div>'; return; }
      el.innerHTML = goals.map(g => {
        const isDone = g.status === 'completed' || g.status === 'cancelled';
        const tags = (g.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
        const dl = g.deadline && !isDone ? '<span>' + deadlineText(g.deadline) + '</span>' : '';
        const statusLabel = isDone ? '<span>' + g.status + '</span>' : '';
        return '<div class="goal-item' + (isDone ? ' done' : '') + '">' +
          '<div class="goal-dot ' + g.status + '"></div>' +
          '<div class="goal-info">' +
            '<div class="goal-title">' + escapeHtml(g.title) + '</div>' +
            '<div class="goal-meta">' + statusLabel + dl + tags + '</div>' +
          '</div></div>';
      }).join('');
    }

    // --- Tasks Panel ---
    function renderTasks(tasks) {
      const el = document.getElementById('tasksList');
      document.getElementById('tasksCount').textContent = tasks.length;
      if (!tasks.length) { el.innerHTML = '<div class="panel-empty">No scheduled tasks</div>'; return; }
      el.innerHTML = tasks.map(t => {
        const badgeClass = t.enabled ? t.taskType : 'disabled';
        const nextRun = t.nextRunAt ? timeAgo(t.nextRunAt).replace(' ago', '').replace('just now', 'now') : '';
        const nextLabel = t.nextRunAt && t.nextRunAt > Date.now() ? 'next: ' + new Date(t.nextRunAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
        return '<div class="task-item">' +
          '<span class="task-badge ' + badgeClass + '">' + t.taskType + '</span>' +
          '<div class="task-info">' +
            '<div class="task-title">' + escapeHtml(t.title) + (!t.enabled ? ' <span style="color:#555">(disabled)</span>' : '') + '</div>' +
            '<div class="task-schedule">' + formatSchedule(t) + (nextLabel ? ' &middot; ' + nextLabel : '') + '</div>' +
          '</div></div>';
      }).join('');
    }

    // --- Watchers Panel ---
    function formatInterval(ms) {
      const mins = Math.round(ms / 60000);
      if (mins < 60) return 'every ' + mins + 'min';
      const hrs = mins / 60;
      if (hrs < 24) return 'every ' + hrs.toFixed(hrs % 1 ? 1 : 0) + 'h';
      return 'every ' + (hrs / 24).toFixed(0) + 'd';
    }

    function formatDate(ts) {
      return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function renderWatchers(watchers) {
      const el = document.getElementById('watchersList');
      document.getElementById('watchersCount').textContent = watchers.length;
      if (!watchers.length) { el.innerHTML = '<div class="panel-empty">No watchers configured</div>'; return; }
      el.innerHTML = watchers.map(w => {
        const badgeClass = w.enabled ? w.type : 'disabled';
        const lastRun = w.lastRunAt ? 'ran ' + timeAgo(w.lastRunAt) : 'never ran';
        const filter = w.config && w.config.filter ? ' &middot; ' + escapeHtml(String(w.config.filter)) : '';
        const configEntries = Object.entries(w.config || {});
        const configRows = configEntries.map(([k, v]) =>
          '<div class="detail-row"><span class="detail-label">' + escapeHtml(k) + '</span><span class="detail-value">' + escapeHtml(String(v)) + '</span></div>'
        ).join('');
        return '<div class="watcher-item" data-watcher-name="' + escapeHtml(w.name) + '">' +
          '<span class="watcher-badge ' + badgeClass + '">' + w.type + '</span>' +
          '<div class="watcher-info">' +
            '<div class="watcher-title">' + escapeHtml(w.name) + (!w.enabled ? ' <span style="color:#555">(disabled)</span>' : '') + '</div>' +
            '<div class="watcher-meta">' + formatInterval(w.intervalMs) + ' &middot; ' + lastRun + filter + '</div>' +
            '<div class="watcher-detail">' +
              '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' + (w.enabled ? '<span style="color:#4ade80">Active</span>' : '<span style="color:#666">Disabled</span>') + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">' + w.type + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Interval</span><span class="detail-value">' + formatInterval(w.intervalMs) + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Last run</span><span class="detail-value">' + (w.lastRunAt ? timeAgo(w.lastRunAt) : 'Never') + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Tracked IDs</span><span class="detail-value">' + (w.lastNotifiedIds ? w.lastNotifiedIds.length : 0) + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">' + formatDate(w.createdAt) + '</span></div>' +
              configRows +
              '<span class="watcher-view-log" data-filter-watcher="' + escapeHtml(w.name) + '">View activity log</span>' +
            '</div>' +
          '</div></div>';
      }).join('');
    }

    // --- Feed Filter ---
    let currentFeedFilter = null;

    function filterFeedByWatcher(name) {
      currentFeedFilter = name;
      document.getElementById('feedFilterBar').classList.add('visible');
      document.getElementById('feedFilterLabel').textContent = 'Showing: Watcher "' + name + '"';

      // Highlight active watcher
      document.querySelectorAll('.watcher-item').forEach(el => {
        el.classList.toggle('active', el.dataset.watcherName === name);
      });

      // Dim non-matching feed events
      const feedEl = document.getElementById('feed');
      for (const child of feedEl.children) {
        const text = child.querySelector('.event-text');
        if (text && text.textContent.includes('Watcher "' + name + '"')) {
          child.classList.remove('feed-dim', 'feed-hidden');
        } else {
          child.classList.add('feed-dim');
        }
      }

      // Expand feed to show all matches
      feedExpanded = true;
      document.getElementById('feedShowMore').style.display = 'none';

      // Scroll to feed
      document.querySelector('.feed-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function clearFeedFilter() {
      // If viewing slack user messages, use dedicated restore
      if (slackUserFilterActive) {
        clearSlackUserFilter();
        return;
      }

      currentFeedFilter = null;
      document.getElementById('feedFilterBar').classList.remove('visible');
      document.querySelectorAll('.watcher-item').forEach(el => el.classList.remove('active'));

      const feedEl = document.getElementById('feed');
      for (const child of feedEl.children) {
        child.classList.remove('feed-dim');
      }

      feedExpanded = false;
      updateFeedVisibility();
    }

    // --- Slack User Message History ---
    let slackUserFilterActive = false;
    let cachedFeedHtml = '';
    let pendingEvents = [];

    async function showSlackUserMessages(userId, username) {
      const feedEl = document.getElementById('feed');
      const filterBar = document.getElementById('feedFilterBar');
      const showMore = document.getElementById('feedShowMore');
      const liveBadge = document.querySelector('.live-badge');

      // Highlight active user row
      document.querySelectorAll('.slack-user-item').forEach(el => {
        el.classList.toggle('active', el.dataset.userId === userId);
      });

      // Cache current feed content for restoration
      if (!slackUserFilterActive) {
        cachedFeedHtml = feedEl.innerHTML;
      }
      slackUserFilterActive = true;

      // Show filter bar
      filterBar.classList.add('visible');
      document.getElementById('feedFilterLabel').textContent = 'Messages from @' + username;
      showMore.style.display = 'none';
      if (liveBadge) liveBadge.style.display = 'none';

      // Scroll to feed panel
      document.querySelector('.feed-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Show loading state
      feedEl.innerHTML = '<div class="panel-empty">Loading messages...</div>';

      try {
        const res = await fetch('/api/messages/' + encodeURIComponent(userId) + '?limit=100');
        const data = await res.json();
        const msgs = data.messages || [];

        if (!msgs.length) {
          feedEl.innerHTML = '<div class="panel-empty">No messages found for @' + escapeHtml(username) + '</div>';
          return;
        }

        const convo = document.createElement('div');
        convo.className = 'slack-convo-container';

        msgs.forEach(m => {
          const div = document.createElement('div');
          div.className = 'slack-msg role-' + m.role;

          const time = formatTime(m.timestamp);
          const roleLabel = m.role === 'user' ? 'YOU' : 'BOT';
          const modelInfo = m.model ? ' &middot; <span class="slack-msg-model">' + escapeHtml(m.model) + '</span>' : '';
          const content = escapeHtml(m.text || '');
          const isLong = content.length > 500;

          div.innerHTML =
            '<div class="slack-msg-header">' +
              '<span class="slack-msg-role">' + roleLabel + '</span>' +
              '<span class="slack-msg-time">' + time + '</span>' +
              modelInfo +
            '</div>' +
            '<div class="slack-msg-content' + (isLong ? ' collapsed' : '') + '">' + content + '</div>' +
            (isLong ? '<span class="slack-msg-expand">Show more</span>' : '');

          convo.appendChild(div);
        });

        feedEl.innerHTML = '';
        feedEl.appendChild(convo);

        // Scroll to bottom of conversation
        feedEl.scrollTop = feedEl.scrollHeight;
      } catch (err) {
        console.error('Failed to load user messages:', err);
        feedEl.innerHTML = '<div class="panel-empty">Failed to load messages</div>';
      }
    }

    function clearSlackUserFilter() {
      if (!slackUserFilterActive) return;
      slackUserFilterActive = false;

      const feedEl = document.getElementById('feed');
      const filterBar = document.getElementById('feedFilterBar');
      const liveBadge = document.querySelector('.live-badge');

      // Remove active state from user rows
      document.querySelectorAll('.slack-user-item').forEach(el => el.classList.remove('active'));

      // Restore cached feed
      feedEl.innerHTML = cachedFeedHtml;
      cachedFeedHtml = '';

      // Hide filter bar, show live badge
      filterBar.classList.remove('visible');
      if (liveBadge) liveBadge.style.display = '';

      // Replay any events that arrived while viewing user messages
      const eventsToReplay = pendingEvents.slice();
      pendingEvents = [];
      eventsToReplay.forEach(ev => addEvent(ev));

      feedExpanded = false;
      updateFeedVisibility();
    }

    // --- Memories Panel ---
    function renderMemories(memories) {
      const el = document.getElementById('memoriesList');
      document.getElementById('memoriesCount').textContent = memories.length;
      if (!memories.length) { el.innerHTML = '<div class="panel-empty">No memories yet</div>'; return; }
      el.innerHTML = memories.map(m => {
        const tags = (m.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
        return '<div class="memory-item">' +
          '<div class="memory-summary">' + escapeHtml(m.summary) + '</div>' +
          '<div class="memory-meta">' +
            '<span class="time-ago">' + timeAgo(m.createdAt) + '</span>' + tags +
          '</div></div>';
      }).join('');
    }

    // --- Chart ---
    let usageChart = null;
    function initChart(messagesByDay, tokensByDay) {
      if (typeof Chart === 'undefined') return;
      const ctx = document.getElementById('usageChart');
      if (!ctx) return;

      const labels = messagesByDay.map(d => {
        const date = new Date(d.date + 'T00:00:00');
        return date.toLocaleDateString('en-US', { weekday: 'short' });
      });

      if (usageChart) usageChart.destroy();
      usageChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Messages',
              data: messagesByDay.map(d => d.count),
              backgroundColor: 'rgba(108, 99, 255, 0.6)',
              borderColor: 'rgba(108, 99, 255, 1)',
              borderWidth: 1,
              borderRadius: 4,
              yAxisID: 'y',
              order: 2,
            },
            {
              label: 'Claude Tokens',
              data: tokensByDay.map(d => d.mainTokens),
              type: 'line',
              borderColor: 'rgba(74, 222, 128, 0.8)',
              backgroundColor: 'rgba(74, 222, 128, 0.1)',
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: 'rgba(74, 222, 128, 1)',
              tension: 0.3,
              fill: true,
              yAxisID: 'y1',
              order: 1,
            },
            {
              label: 'Haiku Tokens',
              data: tokensByDay.map(d => d.haikuTokens),
              type: 'line',
              borderColor: 'rgba(250, 204, 21, 0.8)',
              backgroundColor: 'rgba(250, 204, 21, 0.08)',
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: 'rgba(250, 204, 21, 1)',
              tension: 0.3,
              fill: true,
              yAxisID: 'y1',
              order: 0,
            },
            {
              label: 'Watcher Tokens',
              data: tokensByDay.map(d => d.watcherTokens),
              type: 'line',
              borderColor: 'rgba(248, 113, 113, 0.8)',
              backgroundColor: 'rgba(248, 113, 113, 0.08)',
              borderWidth: 2,
              borderDash: [4, 3],
              pointRadius: 3,
              pointBackgroundColor: 'rgba(248, 113, 113, 1)',
              tension: 0.3,
              fill: false,
              yAxisID: 'y1',
              order: -1,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              labels: { color: '#888', font: { size: 11 }, boxWidth: 12 }
            }
          },
          scales: {
            x: {
              ticks: { color: '#555' },
              grid: { color: '#1e1e2e' }
            },
            y: {
              position: 'left',
              ticks: { color: '#6c63ff', stepSize: 1 },
              grid: { color: '#1e1e2e' },
              title: { display: true, text: 'Messages', color: '#555', font: { size: 11 } }
            },
            y1: {
              position: 'right',
              ticks: { color: '#4ade80', callback: v => fmtTokens(v) },
              grid: { drawOnChartArea: false },
              title: { display: true, text: 'Tokens', color: '#555', font: { size: 11 } }
            }
          }
        }
      });
    }

    // --- Activity Feed ---
    const feed = document.getElementById('feed');
    const FEED_LIMIT = 10;
    let feedExpanded = false;
    let feedEventCount = 0;

    function badgeLabel(type) {
      switch (type) {
        case 'message_in': return 'IN';
        case 'message_out': return 'OUT';
        case 'error': return 'ERR';
        case 'system': return 'SYS';
        default: return type;
      }
    }

    function renderTiming(m) {
      const parts = [];
      if (m.startupMs > 500) parts.push('<span class="t-label">mcp:</span> <span class="t-val">' + fmtMs(m.startupMs) + '</span>');
      if (m.apiMs) parts.push('<span class="t-label">api:</span> <span class="t-val">' + fmtMs(m.apiMs) + '</span>');
      if (m.promptBuildMs > 50) parts.push('<span class="t-label">prompt:</span> <span class="t-val">' + fmtMs(m.promptBuildMs) + '</span>');
      if (m.sttMs) parts.push('<span class="t-label">stt:</span> <span class="t-val">' + fmtMs(m.sttMs) + '</span>');
      if (m.ttsMs) parts.push('<span class="t-label">tts:</span> <span class="t-val">' + fmtMs(m.ttsMs) + '</span>');
      if (m.inputTokens || m.outputTokens) parts.push('<span class="t-label">tok:</span> <span class="t-val">' + fmtTokens(m.inputTokens || 0) + ' in / ' + fmtTokens(m.outputTokens || 0) + ' out</span>');
      if (m.model) parts.push('<span class="t-label">' + m.model + '</span>');
      return parts.join(' &nbsp;&middot;&nbsp; ');
    }

    function addEvent(ev) {
      // Buffer events while viewing slack user messages
      if (slackUserFilterActive) {
        pendingEvents.push(ev);
        return;
      }

      const fragment = document.createDocumentFragment();

      const div = document.createElement('div');
      div.className = 'event type-' + ev.type;
      div.dataset.feedEvent = 'true';

      let meta = '';
      if (ev.durationMs) meta += fmtMs(ev.durationMs);
      if (ev.metadata && (ev.metadata.inputTokens || ev.metadata.outputTokens)) {
        const total = (ev.metadata.inputTokens || 0) + (ev.metadata.outputTokens || 0);
        meta += (meta ? ' &middot; ' : '') + fmtTokens(total) + ' tok';
      }
      if (ev.username) meta += (meta ? ' &middot; ' : '') + '@' + ev.username;

      div.innerHTML =
        '<span class="event-time">' + formatTime(ev.timestamp) + '</span>' +
        '<span class="event-badge">' + badgeLabel(ev.type) + '</span>' +
        '<span class="event-text">' + escapeHtml(ev.text) + '</span>' +
        (meta ? '<span class="event-meta">' + meta + '</span>' : '');

      fragment.appendChild(div);

      if (ev.metadata && ev.type === 'message_out') {
        const timingDiv = document.createElement('div');
        timingDiv.className = 'event-timing';
        timingDiv.innerHTML = renderTiming(ev.metadata);
        fragment.appendChild(timingDiv);
      }

      // Apply feed filter dimming if active
      if (currentFeedFilter) {
        const matches = ev.text && ev.text.includes('Watcher "' + currentFeedFilter + '"');
        if (!matches) div.classList.add('feed-dim');
      }

      feed.prepend(fragment);
      feedEventCount++;
      updateFeedVisibility();
    }

    function updateFeedVisibility() {
      if (feedExpanded || feedEventCount <= FEED_LIMIT) {
        document.getElementById('feedShowMore').style.display = 'none';
        for (const child of feed.children) child.classList.remove('feed-hidden');
        return;
      }

      let count = 0;
      for (const child of feed.children) {
        if (child.dataset.feedEvent) count++;
        if (count > FEED_LIMIT) {
          child.classList.add('feed-hidden');
        } else {
          child.classList.remove('feed-hidden');
        }
      }

      const showMore = document.getElementById('feedShowMore');
      const hidden = feedEventCount - FEED_LIMIT;
      showMore.style.display = '';
      document.getElementById('feedToggleBtn').textContent = 'Show all (' + feedEventCount + ' events)';
    }

    function toggleFeed() {
      feedExpanded = !feedExpanded;
      if (feedExpanded) {
        for (const child of feed.children) child.classList.remove('feed-hidden');
        document.getElementById('feedToggleBtn').textContent = 'Show less';
        document.getElementById('feedShowMore').style.display = '';
      } else {
        updateFeedVisibility();
      }
    }

    // --- Slack Analytics Panel ---
    function renderSlackAnalytics(data) {
      const panel = document.getElementById('slackPanel');
      if (!data || data.totalMessages === 0) { panel.style.display = 'none'; return; }
      panel.style.display = '';
      document.getElementById('slackMsgCount').textContent = data.totalMessages;

      const platformLabel = { slack_dm: 'DM', slack_channel: 'Channel', slack_assistant: 'Assistant' };
      const breakdownHtml = data.platformBreakdown.map(b =>
        '<div class="slack-breakdown-row">' +
          '<span class="slack-platform-badge ' + b.platform + '">' + (platformLabel[b.platform] || b.platform) + '</span>' +
          '<span style="color:#aaa">' + b.messages + ' msgs</span>' +
          '<span style="color:#666">' + b.users + ' users</span>' +
        '</div>'
      ).join('');

      const usersHtml = data.users.map(u => {
        const memCount = u.personalMemories + u.sharedMemories;
        const badge = u.primaryPlatform ? '<span class="slack-platform-badge ' + u.primaryPlatform + '" style="font-size:9px">' + (platformLabel[u.primaryPlatform] || u.primaryPlatform) + '</span>' : '';
        return '<div class="slack-user-item" data-user-id="' + escapeHtml(u.userId) + '" data-username="' + escapeHtml(u.username) + '">' +
          '<span class="slack-user-name">' + escapeHtml(u.username) + '</span>' +
          '<span class="slack-user-meta">' +
            u.messageCount + ' msgs' +
            (memCount > 0 ? ' &middot; ' + memCount + ' mem' : '') +
            ' &middot; ' + badge +
          '</span>' +
        '</div>';
      }).join('');

      document.getElementById('slackContent').innerHTML =
        '<div class="slack-summary">' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.totalMessages + '</div><div class="slack-stat-label">Messages</div></div>' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.uniqueUsers + '</div><div class="slack-stat-label">Users</div></div>' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.totalPersonalMemories + '</div><div class="slack-stat-label">Personal Mem</div></div>' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.totalSharedMemories + '</div><div class="slack-stat-label">Shared Mem</div></div>' +
        '</div>' +
        (breakdownHtml ? '<div class="slack-section-title">Platform Breakdown</div><div class="slack-breakdown">' + breakdownHtml + '</div>' : '') +
        (usersHtml ? '<div class="slack-section-title">Users</div><div class="panel-body">' + usersHtml + '</div>' : '');
    }

    // --- Agent Status ---
    const phaseLabels = {
      idle: 'Idle',
      receiving: 'Receiving message',
      transcribing: 'Transcribing voice',
      building_prompt: 'Building prompt',
      calling_claude: 'Calling Claude',
      saving_response: 'Saving response',
      sending_telegram: 'Sending to Telegram',
      synthesizing_voice: 'Synthesizing voice',
      running_task: 'Running scheduled task',
      checking_goals: 'Checking goals',
      running_watcher: 'Running watcher',
    };

    function updateAgentStatus(status) {
      const el = document.getElementById('agentStatus');
      const phaseEl = document.getElementById('agentPhase');
      const userEl = document.getElementById('agentUser');

      if (status.phase === 'idle') {
        el.classList.remove('working');
        phaseEl.textContent = 'Idle';
        userEl.textContent = '';
      } else {
        el.classList.add('working');
        phaseEl.textContent = phaseLabels[status.phase] || status.phase;
        userEl.textContent = status.username ? '(@' + status.username + ')' : '';
      }
    }

    // --- SSE Connection ---
    function connect() {
      const es = new EventSource('/api/events');
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');

      es.onopen = () => {
        statusDot.className = 'status-dot connected';
        statusText.textContent = 'Connected';
      };

      es.addEventListener('activity', (e) => {
        addEvent(JSON.parse(e.data));
      });

      es.addEventListener('stats', (e) => {
        const data = JSON.parse(e.data);
        document.getElementById('statMsgsToday').textContent = data.messagesToday;
      });

      es.addEventListener('agent_status', (e) => {
        updateAgentStatus(JSON.parse(e.data));
      });

      es.onerror = () => {
        statusDot.className = 'status-dot';
        statusText.textContent = 'Reconnecting...';
        es.close();
        setTimeout(connect, 3000);
      };
    }

    // --- Data Loading ---
    async function loadDashboard() {
      try {
        const [statsRes, goalsRes, tasksRes, watchersRes, memoriesRes, slackRes] = await Promise.all([
          fetch('/api/stats').then(r => r.json()),
          fetch('/api/goals').then(r => r.json()),
          fetch('/api/tasks').then(r => r.json()),
          fetch('/api/watchers').then(r => r.json()),
          fetch('/api/memories').then(r => r.json()),
          fetch('/api/slack-analytics').then(r => r.json()).catch(() => null),
        ]);

        updateStatCards(statsRes);
        renderGoals(goalsRes.goals || []);
        renderTasks(tasksRes.tasks || []);
        renderWatchers(watchersRes.watchers || []);
        renderMemories(memoriesRes.memories || []);
        renderSlackAnalytics(slackRes);
        initChart(statsRes.messagesByDay || [], statsRes.tokensByDay || []);
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      }
    }

    // --- Periodic Refresh ---
    async function refreshStats() {
      try {
        const stats = await fetch('/api/stats').then(r => r.json());
        updateStatCards(stats);
        initChart(stats.messagesByDay || [], stats.tokensByDay || []);
      } catch (err) {
        console.error('Failed to refresh stats:', err);
      }
    }

    // --- Init ---
    loadDashboard();
    connect();
    setInterval(refreshStats, 60000);

    // Event delegation for watcher log buttons and slack user clicks
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter-watcher]');
      if (btn) {
        e.stopPropagation();
        filterFeedByWatcher(btn.dataset.filterWatcher);
        return;
      }

      const userItem = e.target.closest('.slack-user-item[data-user-id]');
      if (userItem) {
        e.stopPropagation();
        showSlackUserMessages(userItem.dataset.userId, userItem.dataset.username);
        return;
      }

      const expandBtn = e.target.closest('.slack-msg-expand');
      if (expandBtn) {
        const content = expandBtn.previousElementSibling;
        content.classList.toggle('collapsed');
        expandBtn.textContent = content.classList.contains('collapsed') ? 'Show more' : 'Show less';
      }
    });
  </script>
</body>
</html>`;
}
