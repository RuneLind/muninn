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
    let activeUserTab = 'messages';
    let userTabLoaded = {};

    function renderInlineUserDetail(u) {
      const content = document.getElementById('usersDetailContent');
      activeUserTab = 'messages';
      userTabLoaded = {};

      const initial = (u.username || u.userId || '?')[0].toUpperCase();
      const platform = u.platform || 'telegram';
      const platformClass = platform.replace(/[^a-z_]/g, '');

      const tabs = [
        { id: 'messages', label: 'Messages', count: u.messageCount || 0 },
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
            '<div>' +
              '<div class="detail-user-name">' + escapeHtml(u.username || u.userId) +
                ' <span class="user-platform-badge ' + escapeAttr(platformClass) + '" style="font-size:10px">' + escapeHtml(platform) + '</span>' +
              '</div>' +
              '<div class="detail-user-platform" style="font-family:monospace;font-size:11px;margin-top:2px;color:var(--text-dim)">' + escapeHtml(u.userId || '') + '</div>' +
            '</div>' +
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
            '<button class="md-detail-tab' + (t.id === 'messages' ? ' active' : '') + '" data-utab="' + t.id + '">' +
              t.label + (t.count ? '<span class="md-tab-count">' + t.count + '</span>' : '') +
            '</button>'
          ).join('') +
        '</div>' +
        '<div class="md-detail-body">' +
          tabs.map(t =>
            '<div class="md-detail-section' + (t.id === 'messages' ? ' active' : '') + '" data-utab-section="' + t.id + '">' +
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
      switchUserTab('messages');
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
          case 'messages': loadUserMessages(u); break;
          case 'memories': loadUserMemories(u); break;
          case 'goals': loadUserGoals(u); break;
          case 'threads': loadUserThreads(u); break;
          case 'tasks': loadUserTasks(u); break;
          case 'settings': loadUserSettings(u); break;
        }
      }
    }

    async function loadUserMessages(u) {
      const sec = document.querySelector('[data-utab-section="messages"]');
      try {
        const url = appendBot('/api/messages/' + encodeURIComponent(u.userId) + '?limit=30');
        const res = await fetch(url);
        const data = await res.json();
        const msgs = data.messages || [];
        if (!msgs.length) { sec.innerHTML = '<div class="detail-empty-hint">No messages yet</div>'; return; }
        sec.innerHTML = msgs.map(m => {
          const text = escapeHtml(m.text || '');
          const meta = (m.role === 'user' ? escapeHtml(m.username || 'User') : 'Bot') + ' &middot; ' + formatTime(m.timestamp);
          const tokens = m.inputTokens || m.outputTokens
            ? ' &middot; ' + fmtTokens((m.inputTokens || 0) + (m.outputTokens || 0)) + ' tok'
            : '';
          return '<div class="detail-msg role-' + m.role + '">' +
            '<div class="detail-msg-meta">' + meta + tokens + '</div>' + text + '</div>';
        }).join('');
        sec.scrollTop = sec.scrollHeight;
      } catch { sec.innerHTML = '<div class="detail-empty-hint">Failed to load messages</div>'; }
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
