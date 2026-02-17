/** Overview section — metrics strip + recent activity + upcoming + chart */
export function overviewSectionStyles(): string {
  return `
    .metrics-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      padding: 10px 16px;
      margin-bottom: 16px;
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 10px;
    }
    .metric-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: #888;
      white-space: nowrap;
    }
    .metric-item .metric-icon { font-size: 14px; }
    .metric-item .metric-value {
      font-weight: 700;
      color: #fff;
      font-size: 15px;
    }
    .metric-item .metric-label {
      font-size: 11px;
      color: #666;
    }

    .overview-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    @media (max-width: 900px) {
      .overview-columns { grid-template-columns: 1fr; }
    }

    .overview-mini-panel {
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      overflow: hidden;
    }
    .overview-mini-header {
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #1e1e2e;
    }
    .overview-mini-body {
      padding: 4px 0;
      max-height: 240px;
      overflow-y: auto;
    }
    .overview-mini-body::-webkit-scrollbar { width: 3px; }
    .overview-mini-body::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }

    .overview-mini-empty {
      padding: 16px 14px;
      font-size: 12px;
      color: #444;
      text-align: center;
    }

    /* Recent activity mini-feed items */
    .mini-event {
      display: flex;
      gap: 8px;
      padding: 6px 14px;
      font-size: 12px;
      align-items: flex-start;
    }
    .mini-event:hover { background: #ffffff04; }
    .mini-event-time {
      color: #555;
      font-family: monospace;
      font-size: 11px;
      min-width: 44px;
      white-space: nowrap;
    }
    .mini-event-badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      white-space: nowrap;
      min-width: 28px;
      text-align: center;
    }
    .mini-event-badge.in { background: #1e3a5f; color: #60a5fa; }
    .mini-event-badge.out { background: #1a3a2a; color: #4ade80; }
    .mini-event-badge.err { background: #3a1a1a; color: #f87171; }
    .mini-event-badge.sys { background: #2a2a1a; color: #facc15; }
    .mini-event-text {
      flex: 1;
      color: #aaa;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Upcoming items */
    .upcoming-item {
      display: flex;
      gap: 8px;
      padding: 6px 14px;
      font-size: 12px;
      align-items: flex-start;
    }
    .upcoming-item:hover { background: #ffffff04; }
    .upcoming-type {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      white-space: nowrap;
      min-width: 36px;
      text-align: center;
    }
    .upcoming-type.goal { background: #1a2e3a; color: #38bdf8; }
    .upcoming-type.task { background: #2a2a1a; color: #facc15; }
    .upcoming-info {
      flex: 1;
      min-width: 0;
    }
    .upcoming-title {
      color: #ccc;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .upcoming-when {
      font-size: 11px;
      color: #555;
      margin-top: 1px;
    }

    .overview-chart-wrap {
      margin-top: 8px;
    }
  `;
}

export function overviewSectionHtml(): string {
  return `
    <div data-section="overview" class="active">
      <div class="metrics-strip" id="metricsStrip">
        <div class="metric-item"><span class="metric-icon">&#x1F4AC;</span><span class="metric-value" id="metricMsgsToday">-</span><span class="metric-label">Today</span></div>
        <div class="metric-item"><span class="metric-icon">&#x1F4CA;</span><span class="metric-value" id="metricTotalMsgs">-</span><span class="metric-label">Total</span></div>
        <div class="metric-item"><span class="metric-icon">&#x1F9E0;</span><span class="metric-value" id="metricMemories">-</span><span class="metric-label">Memories</span></div>
        <div class="metric-item"><span class="metric-icon">&#x1F3AF;</span><span class="metric-value" id="metricGoals">-</span><span class="metric-label">Goals</span></div>
        <div class="metric-item"><span class="metric-icon">&#x23F0;</span><span class="metric-value" id="metricTasks">-</span><span class="metric-label">Tasks</span></div>
        <div class="metric-item"><span class="metric-icon">&#x1F522;</span><span class="metric-value" id="metricTokens">-</span><span class="metric-label">Tokens</span></div>
      </div>

      <div class="overview-columns">
        <div class="overview-mini-panel">
          <div class="overview-mini-header">Recent Activity</div>
          <div class="overview-mini-body" id="overviewRecentActivity">
            <div class="overview-mini-empty">Loading...</div>
          </div>
        </div>
        <div class="overview-mini-panel">
          <div class="overview-mini-header">Upcoming</div>
          <div class="overview-mini-body" id="overviewUpcoming">
            <div class="overview-mini-empty">Loading...</div>
          </div>
        </div>
      </div>

      <div class="overview-chart-wrap">
        <div class="panel">
          <div class="panel-header">Usage (7 Days)</div>
          <div class="chart-container">
            <canvas id="usageChart"></canvas>
          </div>
        </div>
      </div>
    </div>`;
}

export function overviewSectionScript(): string {
  return `
    let recentEvents = [];

    function updateMetricsStrip(stats) {
      document.getElementById('metricMsgsToday').textContent = stats.messagesToday;
      document.getElementById('metricTotalMsgs').textContent = stats.totalMessages;
      document.getElementById('metricMemories').textContent = stats.memoriesCount;
      document.getElementById('metricGoals').textContent = stats.activeGoalsCount;
      document.getElementById('metricTasks').textContent = stats.scheduledTasksCount;
      document.getElementById('metricTokens').textContent = fmtTokens(stats.totalTokens);
    }

    function miniBadgeClass(type) {
      switch (type) {
        case 'message_in': return 'in';
        case 'message_out': return 'out';
        case 'error': return 'err';
        case 'system': return 'sys';
        default: return 'sys';
      }
    }

    function miniBadgeLabel(type) {
      switch (type) {
        case 'message_in': return 'IN';
        case 'message_out': return 'OUT';
        case 'error': return 'ERR';
        case 'system': return 'SYS';
        default: return type;
      }
    }

    function updateRecentActivity(events) {
      const el = document.getElementById('overviewRecentActivity');
      if (!events.length) {
        el.innerHTML = '<div class="overview-mini-empty">No recent activity</div>';
        return;
      }
      el.innerHTML = events.map(ev =>
        '<div class="mini-event">' +
          '<span class="mini-event-time">' + formatTime(ev.timestamp) + '</span>' +
          '<span class="mini-event-badge ' + miniBadgeClass(ev.type) + '">' + miniBadgeLabel(ev.type) + '</span>' +
          '<span class="mini-event-text">' + escapeHtml(ev.text) + '</span>' +
        '</div>'
      ).join('');
    }

    function updateUpcoming(goals, tasks) {
      const items = [];

      // Active goals with deadlines
      (goals || []).forEach(g => {
        if (g.status === 'active' && g.deadline) {
          items.push({ type: 'goal', title: g.title, time: g.deadline, when: deadlineText(g.deadline) });
        }
      });

      // Enabled tasks with nextRunAt
      (tasks || []).forEach(t => {
        if (t.enabled && t.nextRunAt && t.nextRunAt > Date.now()) {
          const timeStr = new Date(t.nextRunAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
          items.push({ type: 'task', title: t.title, time: t.nextRunAt, when: timeStr + ' ' + formatSchedule(t) });
        }
      });

      // Sort by time ascending, take first 8
      items.sort((a, b) => a.time - b.time);
      const top = items.slice(0, 8);

      const el = document.getElementById('overviewUpcoming');
      if (!top.length) {
        el.innerHTML = '<div class="overview-mini-empty">No upcoming items</div>';
        return;
      }
      el.innerHTML = top.map(item =>
        '<div class="upcoming-item">' +
          '<span class="upcoming-type ' + item.type + '">' + (item.type === 'goal' ? 'GOAL' : 'TASK') + '</span>' +
          '<div class="upcoming-info">' +
            '<div class="upcoming-title">' + escapeHtml(item.title) + '</div>' +
            '<div class="upcoming-when">' + escapeHtml(item.when) + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
    }
  `;
}
