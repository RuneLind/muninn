/** Detail panel — right-side slide-in panel for drill-down views */
export function detailPanelStyles(): string {
  return `
    .detail-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 100;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s;
    }
    .detail-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }
    .detail-panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 420px;
      max-width: 90vw;
      height: 100vh;
      background: var(--bg-deep);
      border-left: 1px solid var(--border-primary);
      z-index: 101;
      transform: translateX(100%);
      transition: transform 0.25s ease;
      display: flex;
      flex-direction: column;
    }
    .detail-panel.open {
      transform: translateX(0);
    }
    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-primary);
      flex-shrink: 0;
    }
    .detail-header h3 {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    .detail-close {
      background: none;
      border: 1px solid var(--border-secondary);
      color: var(--text-muted);
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: all 0.15s;
    }
    .detail-close:hover {
      border-color: var(--accent);
      color: var(--text-tertiary);
    }
    .detail-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
    }
    .detail-body::-webkit-scrollbar { width: 4px; }
    .detail-body::-webkit-scrollbar-track { background: transparent; }
    .detail-body::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }

    /* Detail content styles */
    .detail-field {
      margin-bottom: 14px;
    }
    .detail-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      margin-bottom: 4px;
    }
    .detail-value {
      font-size: 13px;
      color: var(--text-tertiary);
      line-height: 1.5;
    }
    .detail-badge {
      display: inline-block;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .detail-badge.active { background: var(--tint-success); color: var(--status-success); }
    .detail-badge.completed { background: var(--tint-purple); color: var(--accent); }
    .detail-badge.cancelled { background: var(--tint-neutral); color: var(--text-dim); }
    .detail-badge.enabled { background: var(--tint-success); color: var(--status-success); }
    .detail-badge.disabled { background: var(--tint-neutral); color: var(--text-dim); }
    .detail-badge.personal { background: var(--tint-purple); color: var(--accent); }
    .detail-badge.shared { background: var(--tint-success); color: var(--status-success); }

    .detail-tags {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .detail-divider {
      border: none;
      border-top: 1px solid var(--border-primary);
      margin: 16px 0;
    }

    /* Conversation messages in detail panel */
    .detail-msg {
      padding: 10px 12px;
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .detail-msg.role-user {
      background: var(--tint-info);
      color: var(--chat-user-text);
      margin-left: 32px;
      border-bottom-right-radius: 2px;
    }
    .detail-msg.role-assistant {
      background: var(--tint-success);
      color: var(--chat-assistant-text);
      margin-right: 32px;
      border-bottom-left-radius: 2px;
    }
    .detail-msg-meta {
      font-size: 10px;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    /* User profile in detail */
    .detail-user-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .detail-user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), var(--status-success));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
    }
    .detail-user-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .detail-chat-btn {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      background: var(--accent);
      color: var(--text-primary);
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .detail-chat-btn:hover { background: var(--accent-hover); }
    .detail-user-platform {
      font-size: 11px;
      color: var(--text-dim);
    }
    .detail-stat-row {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    .detail-stat-box {
      flex: 1;
      text-align: center;
      padding: 10px;
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
    }
    .detail-stat-num {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
    }
    .detail-stat-label {
      font-size: 10px;
      color: var(--text-faint);
      text-transform: uppercase;
      margin-top: 2px;
    }

    /* User detail enriched sections */
    .detail-section {
      margin-bottom: 16px;
    }
    .detail-section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      font-weight: 600;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .detail-timeline {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    .detail-timeline-item {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
    }
    .detail-timeline-item span:last-child { color: var(--text-tertiary); }
    .detail-mini-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .detail-mini-item {
      padding: 8px 10px;
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-soft);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .detail-mini-item .mini-badge {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 6px;
      font-weight: 600;
    }
    .detail-mini-item .mini-badge.deadline { background: #3a2a1a; color: #f0c060; }
    .detail-mini-item .mini-badge.msgs { background: var(--bg-surface); color: var(--accent-muted); }
    .detail-mini-item .mini-badge.quiet { background: #1a2a3e; color: #60b0f0; }
    .detail-mini-memory {
      padding: 8px 10px;
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-soft);
      line-height: 1.4;
    }
    .detail-mini-memory + .detail-mini-memory { margin-top: 4px; }
    .detail-mini-memory .detail-tags { margin-top: 4px; }
    /* Overview tab styles */
    .overview-chart {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 60px;
      padding: 0 2px;
      margin-bottom: 4px;
    }
    .overview-bar {
      flex: 1;
      min-width: 0;
      background: var(--accent);
      border-radius: 2px 2px 0 0;
      opacity: 0.8;
      transition: opacity 0.15s;
    }
    .overview-bar:hover { opacity: 1; }
    .overview-chart-labels {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: var(--text-disabled);
      margin-bottom: 12px;
    }
    .overview-model-bar {
      display: flex;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
      margin-bottom: 6px;
    }
    .overview-model-segment {
      height: 100%;
      min-width: 2px;
    }
    .overview-model-legend {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .overview-model-pill {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .overview-model-pill .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .overview-event {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 12px;
    }
    .overview-event:last-child { border-bottom: none; }
    .overview-event-time {
      flex-shrink: 0;
      width: 28px;
      font-size: 10px;
      color: var(--text-disabled);
      text-align: right;
    }
    .overview-event-badge {
      flex-shrink: 0;
      width: 30px;
      font-size: 9px;
      font-weight: 700;
      text-align: center;
      padding: 2px 0;
      border-radius: 3px;
      text-transform: uppercase;
    }
    .overview-event-badge.in { background: var(--tint-info); color: var(--status-info, #60a5fa); }
    .overview-event-badge.out { background: var(--tint-success); color: var(--status-success); }
    .overview-event-badge.err { background: var(--tint-error, #3a1a1a); color: var(--status-error, #f87171); }
    .overview-event-badge.sys { background: var(--tint-neutral); color: var(--text-dim); }
    .overview-event-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-soft);
    }
    .overview-event-meta {
      flex-shrink: 0;
      font-size: 10px;
      color: var(--text-dim);
      text-align: right;
    }

    .detail-skeleton {
      background: linear-gradient(90deg, var(--border-subtle) 25%, #22222e 50%, var(--border-subtle) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 6px;
      height: 32px;
      margin-bottom: 6px;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .detail-empty-hint {
      font-size: 11px;
      color: var(--text-disabled);
      font-style: italic;
      padding: 8px 0;
    }
  `;
}

export function detailPanelHtml(): string {
  return `
    <div class="detail-overlay" id="detailOverlay"></div>
    <div class="detail-panel" id="detailPanel">
      <div class="detail-header">
        <h3 id="detailTitle">Detail</h3>
        <button class="detail-close" id="detailClose">&times;</button>
      </div>
      <div class="detail-body" id="detailBody"></div>
    </div>`;
}

export function detailPanelScript(): string {
  return `
    let detailOpen = false;

    function openDetail(type, data) {
      detailOpen = true;
      document.getElementById('detailOverlay').classList.add('open');
      document.getElementById('detailPanel').classList.add('open');

      const body = document.getElementById('detailBody');
      const title = document.getElementById('detailTitle');

      switch (type) {
        case 'goal':
          // Redirect to inline knowledge panel
          closeDetail();
          switchSection('memories-goals');
          if (data && data.id) selectMgItem('goal', data.id);
          return;
        case 'memory':
          // Redirect to inline knowledge panel
          closeDetail();
          switchSection('memories-goals');
          if (data && data.id) selectMgItem('memory', data.id);
          return;
        case 'thread':
          // Redirect to inline threads panel instead of overlay
          closeDetail();
          switchSection('threads');
          if (data && data.id) selectThread(data.id);
          return;
        case 'user':
          // Redirect to inline users panel instead of overlay
          closeDetail();
          switchSection('users');
          if (data && data.userId) selectUser(data.userId);
          return;
        default:
          title.textContent = 'Detail';
          body.innerHTML = '<div class="panel-empty">Unknown detail type</div>';
      }
    }

    function closeDetail() {
      detailOpen = false;
      document.getElementById('detailOverlay').classList.remove('open');
      document.getElementById('detailPanel').classList.remove('open');
    }

    // Close on overlay click
    document.getElementById('detailOverlay').addEventListener('click', closeDetail);
    document.getElementById('detailClose').addEventListener('click', closeDetail);

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && detailOpen) {
        e.preventDefault();
        closeDetail();
      }
    });

    // --- Inline User Detail (master-detail panel) ---
    let activeUserTab = 'overview';
    let userTabLoaded = {};

    function renderInlineUserDetail(u) {
      const content = document.getElementById('usersDetailContent');
      activeUserTab = 'overview';
      userTabLoaded = {};

      const initial = (u.username || u.userId || '?')[0].toUpperCase();
      const platform = u.platform || 'telegram';
      const platformClass = platform.replace(/[^a-z_]/g, '');

      const tabs = [
        { id: 'overview', label: 'Overview', count: 0 },
        { id: 'memories', label: 'Memories', count: u.memoryCount || 0 },
        { id: 'goals', label: 'Goals', count: u.activeGoalCount || 0 },
        { id: 'threads', label: 'Threads', count: u.threadCount || 0 },
        { id: 'tasks', label: 'Tasks', count: u.scheduledTaskCount || 0 },
        { id: 'settings', label: 'Settings', count: 0 },
      ];

      content.innerHTML = '' +
        '<div class="md-detail-header">' +
          '<div class="detail-user-header">' +
            '<div class="detail-user-avatar" style="width:48px;height:48px;font-size:18px">' + escapeHtml(initial) + '</div>' +
            '<div style="flex:1">' +
              '<div class="detail-user-name">' + escapeHtml(u.username || u.userId) +
                ' <span class="user-platform-badge ' + escapeAttr(platformClass) + '" style="font-size:10px">' + escapeHtml(platform) + '</span>' +
              '</div>' +
              '<div class="detail-user-platform" style="font-family:monospace;font-size:11px;margin-top:2px;color:var(--text-dim)">' + escapeHtml(u.userId || '') + '</div>' +
            '</div>' +
            (selectedBot ? '<a class="detail-chat-btn" href="/chat?user=' + encodeURIComponent(u.userId) + '&bot=' + encodeURIComponent(selectedBot) + '&username=' + encodeURIComponent(u.username || u.userId) + '">Chat</a>' : '') +
          '</div>' +
          '<div class="detail-stat-row">' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (u.messageCount || 0) + '</div><div class="detail-stat-label">Messages</div></div>' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (u.memoryCount || 0) + '</div><div class="detail-stat-label">Memories</div></div>' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (u.threadCount || 0) + '</div><div class="detail-stat-label">Threads</div></div>' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (u.activeGoalCount || 0) + '</div><div class="detail-stat-label">Goals</div></div>' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (u.scheduledTaskCount || 0) + '</div><div class="detail-stat-label">Tasks</div></div>' +
          '</div>' +
          '<div class="detail-timeline">' +
            '<div class="detail-timeline-item"><span>First seen</span><span>' + (u.firstSeen ? timeAgo(u.firstSeen) : 'Unknown') + '</span></div>' +
            '<div class="detail-timeline-item"><span>Last active</span><span>' + (u.lastActive ? timeAgo(u.lastActive) : 'Unknown') + '</span></div>' +
            '<div class="detail-timeline-item"><span>Total tokens</span><span>' + fmtTokens(u.totalTokens || 0) + '</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="md-detail-tabs">' +
          tabs.map(t =>
            '<button class="md-detail-tab' + (t.id === 'overview' ? ' active' : '') + '" data-utab="' + t.id + '">' +
              t.label + (t.count ? '<span class="md-tab-count">' + t.count + '</span>' : '') +
            '</button>'
          ).join('') +
        '</div>' +
        '<div class="md-detail-body">' +
          tabs.map(t =>
            '<div class="md-detail-section' + (t.id === 'overview' ? ' active' : '') + '" data-utab-section="' + t.id + '">' +
              '<div class="detail-skeleton"></div><div class="detail-skeleton" style="width:70%"></div>' +
            '</div>'
          ).join('') +
        '</div>';

      // Tab click handler
      content.querySelector('.md-detail-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-utab]');
        if (btn) switchUserTab(btn.dataset.utab);
      });

      // Load initial tab
      switchUserTab('overview');
    }

    function switchUserTab(tabName) {
      activeUserTab = tabName;
      const content = document.getElementById('usersDetailContent');

      // Toggle tab buttons
      content.querySelectorAll('.md-detail-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.utab === tabName);
      });

      // Toggle sections
      content.querySelectorAll('.md-detail-section').forEach(sec => {
        sec.classList.toggle('active', sec.dataset.utabSection === tabName);
      });

      // Lazy-load if not yet loaded
      if (!userTabLoaded[tabName]) {
        const u = usersData.find(u => u.userId === selectedUserId);
        if (!u) return;
        userTabLoaded[tabName] = true;
        switch (tabName) {
          case 'overview': loadUserOverview(u); break;
          case 'memories': loadUserMemories(u); break;
          case 'goals': loadUserGoals(u); break;
          case 'threads': loadUserThreads(u); break;
          case 'tasks': loadUserTasks(u); break;
          case 'settings': loadUserSettings(u); break;
        }
      }
    }

    async function loadUserOverview(u) {
      const sec = document.querySelector('[data-utab-section="overview"]');
      try {
        const url = appendBot('/api/users/' + encodeURIComponent(u.userId) + '/overview');
        const res = await fetch(url);
        const data = await res.json();

        const msgsByDay = data.messagesByDay || [];
        const toksByDay = data.tokensByDay || [];
        const avgMs = data.avgResponseMs || 0;
        const models = data.modelDistribution || [];
        const activity = data.recentActivity || [];

        // Compute summary stats
        const totalMsgs = msgsByDay.reduce((s, d) => s + d.count, 0);
        const avgPerDay = msgsByDay.length ? (totalMsgs / msgsByDay.length).toFixed(1) : '0';
        const totalToks = toksByDay.reduce((s, d) => s + d.tokens, 0);

        // --- Stat cards ---
        let html = '<div class="detail-stat-row">' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + avgPerDay + '</div><div class="detail-stat-label">Msgs/day</div></div>' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + (avgMs > 0 ? (avgMs / 1000).toFixed(1) + 's' : '-') + '</div><div class="detail-stat-label">Avg Response</div></div>' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + fmtTokens(totalToks) + '</div><div class="detail-stat-label">Tokens (14d)</div></div>' +
        '</div>';

        // --- 14-day bar chart ---
        const maxCount = Math.max(...msgsByDay.map(d => d.count), 1);
        html += '<div class="detail-section"><div class="detail-section-title">Messages (14 days)</div>' +
          '<div class="overview-chart">' +
          msgsByDay.map(d => {
            const pct = Math.max((d.count / maxCount) * 100, d.count > 0 ? 4 : 0);
            return '<div class="overview-bar" style="height:' + pct + '%" title="' + escapeAttr(d.date) + ': ' + d.count + '"></div>';
          }).join('') +
          '</div>' +
          '<div class="overview-chart-labels"><span>' + (msgsByDay[0]?.date?.slice(5) || '') + '</span><span>' + (msgsByDay[msgsByDay.length - 1]?.date?.slice(5) || '') + '</span></div>' +
          '</div>';

        // --- Model distribution ---
        if (models.length) {
          const modelColors = ['var(--accent)', 'var(--status-success)', '#f0c060', 'var(--status-info, #60a5fa)', '#f87171'];
          const totalModel = models.reduce((s, m) => s + m.count, 0);
          html += '<div class="detail-section"><div class="detail-section-title">Models (30 days)</div>' +
            '<div class="overview-model-bar">' +
            models.map((m, i) => {
              const pct = (m.count / totalModel * 100).toFixed(1);
              return '<div class="overview-model-segment" style="width:' + pct + '%;background:' + modelColors[i % modelColors.length] + '"></div>';
            }).join('') +
            '</div>' +
            '<div class="overview-model-legend">' +
            models.map((m, i) => {
              const pct = (m.count / totalModel * 100).toFixed(0);
              return '<span class="overview-model-pill"><span class="dot" style="background:' + modelColors[i % modelColors.length] + '"></span>' + escapeHtml(m.model) + ' ' + pct + '%</span>';
            }).join('') +
            '</div></div>';
        }

        // --- Recent Activity ---
        html += '<div class="detail-section"><div class="detail-section-title">Recent Activity</div>';
        if (!activity.length) {
          html += '<div class="detail-empty-hint">No recent activity</div>';
        } else {
          const badgeMap = { message_in: 'in', message_out: 'out', error: 'err', system: 'sys', slack_channel_post: 'out' };
          const labelMap = { message_in: 'IN', message_out: 'OUT', error: 'ERR', system: 'SYS', slack_channel_post: 'OUT' };
          html += activity.map(e => {
            const cls = badgeMap[e.type] || 'sys';
            const label = labelMap[e.type] || e.type.slice(0, 3).toUpperCase();
            const meta = e.durationMs ? (e.durationMs / 1000).toFixed(1) + 's' :
              (e.inputTokens || e.outputTokens) ? fmtTokens((e.inputTokens || 0) + (e.outputTokens || 0)) : '';
            return '<div class="overview-event">' +
              '<span class="overview-event-time">' + shortTimeAgo(e.timestamp) + '</span>' +
              '<span class="overview-event-badge ' + cls + '">' + label + '</span>' +
              '<span class="overview-event-text">' + escapeHtml(e.text || '') + '</span>' +
              (meta ? '<span class="overview-event-meta">' + meta + '</span>' : '') +
            '</div>';
          }).join('');
        }
        html += '</div>';

        sec.innerHTML = html;
      } catch { sec.innerHTML = '<div class="detail-empty-hint">Failed to load overview</div>'; }
    }

    function shortTimeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'now';
      if (mins < 60) return mins + 'm';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h';
      const days = Math.floor(hrs / 24);
      return days + 'd';
    }

    async function loadUserMemories(u) {
      const sec = document.querySelector('[data-utab-section="memories"]');
      try {
        const url = appendBot('/api/memories/user/' + encodeURIComponent(u.userId) + '?limit=20');
        const res = await fetch(url);
        const data = await res.json();
        const memories = data.memories || [];
        if (!memories.length) { sec.innerHTML = '<div class="detail-empty-hint">No memories</div>'; return; }
        sec.innerHTML = memories.map(m => {
          const tags = (m.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
          const scope = '<span class="detail-badge ' + (m.scope || 'personal') + '" style="font-size:9px;margin-left:4px">' + escapeHtml(m.scope || 'personal') + '</span>';
          return '<div class="detail-mini-memory">' + escapeHtml(m.summary) + scope +
            (tags ? '<div class="detail-tags">' + tags + '</div>' : '') +
            '<div style="font-size:10px;color:var(--text-disabled);margin-top:4px">' + timeAgo(m.createdAt) + '</div>' +
          '</div>';
        }).join('');
      } catch { sec.innerHTML = '<div class="detail-empty-hint">Failed to load memories</div>'; }
    }

    async function loadUserGoals(u) {
      const sec = document.querySelector('[data-utab-section="goals"]');
      try {
        const url = appendBot('/api/goals/' + encodeURIComponent(u.userId));
        const res = await fetch(url);
        const data = await res.json();
        const goals = data.goals || [];
        if (!goals.length) { sec.innerHTML = '<div class="detail-empty-hint">No goals</div>'; return; }
        sec.innerHTML = '<div class="detail-mini-list">' + goals.map(g => {
          const dl = g.deadline ? ' <span class="mini-badge deadline">' + deadlineText(g.deadline) + '</span>' : '';
          const badge = '<span class="detail-badge ' + escapeAttr(g.status) + '" style="font-size:9px">' + escapeHtml(g.status) + '</span>';
          return '<div class="detail-mini-item"><span>' + escapeHtml(g.title) + ' ' + badge + '</span>' + dl + '</div>';
        }).join('') + '</div>';
      } catch { sec.innerHTML = '<div class="detail-empty-hint">Failed to load goals</div>'; }
    }

    function loadUserThreads(u) {
      const sec = document.querySelector('[data-utab-section="threads"]');
      const userThreads = (typeof threadsData !== 'undefined' ? threadsData : [])
        .filter(t => t.userId === u.userId);
      if (!userThreads.length) { sec.innerHTML = '<div class="detail-empty-hint">No threads</div>'; return; }
      sec.innerHTML = '<div class="detail-mini-list">' + userThreads.map(t => {
        const active = t.isActive ? ' <span class="mini-badge" style="background:var(--tint-success);color:var(--status-success)">active</span>' : '';
        return '<div class="detail-mini-item"><span>' + escapeHtml(t.name || 'main') + active + '</span><span class="mini-badge msgs">' + (t.messageCount || 0) + ' msgs</span></div>';
      }).join('') + '</div>';
    }

    async function loadUserTasks(u) {
      const sec = document.querySelector('[data-utab-section="tasks"]');
      try {
        const url = appendBot('/api/scheduled-tasks/' + encodeURIComponent(u.userId));
        const res = await fetch(url);
        const data = await res.json();
        const tasks = data.tasks || [];
        if (!tasks.length) { sec.innerHTML = '<div class="detail-empty-hint">No scheduled tasks</div>'; return; }
        sec.innerHTML = '<div class="detail-mini-list">' + tasks.map(t => {
          const badge = '<span class="detail-badge ' + (t.enabled ? 'enabled' : 'disabled') + '" style="font-size:9px">' + (t.enabled ? 'On' : 'Off') + '</span>';
          return '<div class="detail-mini-item"><span>' + escapeHtml(t.title) + ' ' + badge + '</span><span style="font-size:10px;color:var(--text-dim)">' + formatSchedule(t) + '</span></div>';
        }).join('') + '</div>';
      } catch { sec.innerHTML = '<div class="detail-empty-hint">Failed to load tasks</div>'; }
    }

    async function loadUserSettings(u) {
      const sec = document.querySelector('[data-utab-section="settings"]');
      try {
        const res = await fetch('/api/user-settings/' + encodeURIComponent(u.userId));
        const data = await res.json();
        const s = data.settings;
        if (!s) { sec.innerHTML = '<div class="detail-empty-hint">Default settings</div>'; return; }
        const tz = s.timezone || 'Not set';
        const quiet = (s.quietStart != null && s.quietEnd != null)
          ? String(s.quietStart).padStart(2, '0') + ':00 - ' + String(s.quietEnd).padStart(2, '0') + ':00'
          : 'Not configured';
        sec.innerHTML = '<div class="detail-mini-list">' +
          '<div class="detail-mini-item"><span>Timezone</span><span>' + escapeHtml(tz) + '</span></div>' +
          '<div class="detail-mini-item"><span>Quiet hours</span><span class="mini-badge quiet">' + escapeHtml(quiet) + '</span></div>' +
        '</div>';
      } catch { sec.innerHTML = '<div class="detail-empty-hint">Failed to load settings</div>'; }
    }
  `;
}
