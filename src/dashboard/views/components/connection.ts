/** SSE connection, data loading, periodic refresh, and event delegation */
export function connectionStyles(): string {
  return `
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--text-disabled);
    }
    .status-dot.connected { background: var(--status-success); }
  `;
}

export function connectionStatusHtml(): string {
  return `
    <div class="status">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Connecting...</span>
    </div>`;
}

export function connectionScript(): string {
  return `
    // --- Avatar color from name ---
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

    // --- Bot param helpers ---
    function botParam() {
      return selectedBot ? '?bot=' + encodeURIComponent(selectedBot) : '';
    }
    function appendBot(url) {
      if (!selectedBot) return url;
      return url + (url.includes('?') ? '&' : '?') + 'bot=' + encodeURIComponent(selectedBot);
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
        const ev = JSON.parse(e.data);
        // Client-side bot filter for SSE events
        if (selectedBot && ev.botName && ev.botName !== selectedBot) return;
        addEvent(ev);
      });

      es.addEventListener('stats', (e) => {
        const data = JSON.parse(e.data);
        // Live "messages today" — patch it onto the cached stats + re-tile.
        if (lastStats && data && data.messagesToday != null) {
          lastStats.messagesToday = data.messagesToday;
          renderOverviewTiles();
        }
      });

      // Live agent runs (running zone) for the home Now card. Refetch the overview
      // only when the RUNNING set changes (a start/finish can shift up-next), not
      // on every ~1/s progress snapshot.
      es.addEventListener('agent_runs', (e) => {
        try {
          nowRuns = JSON.parse(e.data) || [];
          renderNow();
          const key = runningKey(nowRuns);
          if (key !== lastRunningKey) { lastRunningKey = key; loadNowOverview(); }
        } catch (err) {}
      });

      es.addEventListener('agent_status', (e) => {
        updateAgentStatus(JSON.parse(e.data));
      });

      es.addEventListener('request_progress', (e) => {
        const progress = JSON.parse(e.data);
        updateRequestProgress(progress);
      });

      es.onerror = () => {
        statusDot.className = 'status-dot';
        statusText.textContent = 'Reconnecting...';
        es.close();
        setTimeout(connect, 3000);
      };
    }

    // --- Data Loading ---
    let usersData = [];

    // Signature of the currently-running runs so we only refetch the overview
    // (up-next) when a run actually starts/finishes — mirrors the /agents page.
    let lastRunningKey = '';
    function runningKey(runs) {
      return (runs || []).filter(r => !r.completed).map(r => r.requestId).sort().join(',');
    }

    // Home "Now" card: up-next comes from the shared agents overview (running
    // arrives live over the agent_runs SSE event). Monotonic seq guard so a slow
    // earlier response can't overwrite a newer one.
    let nowOverviewSeq = 0;
    async function loadNowOverview() {
      const mySeq = ++nowOverviewSeq;
      try {
        const data = await fetch('/api/agents/overview').then(r => r.json());
        if (mySeq !== nowOverviewSeq) return;
        nowUpNext = data.upNext || [];
        renderNow();
      } catch (err) { /* Now card degrades to running-only */ }
    }

    // Home "Attention" card.
    async function loadAttention() {
      try {
        const data = await fetch('/api/attention').then(r => r.json());
        renderAttention(data);
      } catch (err) {
        renderAttention({ items: [], errors: ['request failed'] });
      }
    }

    async function loadDashboard() {
      try {
        clearFeed();
        const bp = botParam();
        const memUrl = '/api/memories' + bp + (bp ? '&' : '?') + 'limit=50';
        const [statsRes, goalsRes, tasksRes, watchersRes, memoriesRes, slackRes, usersRes, activityRes] = await Promise.all([
          fetch('/api/stats' + bp).then(r => r.json()),
          fetch('/api/goals' + bp).then(r => r.json()),
          fetch('/api/tasks' + bp).then(r => r.json()),
          fetch('/api/watchers' + bp).then(r => r.json()),
          fetch(memUrl).then(r => r.json()),
          fetch('/api/slack-analytics' + bp).then(r => r.json()).catch(() => null),
          fetch('/api/users' + bp).then(r => r.json()).catch(() => ({ users: [] })),
          fetch('/api/activity').then(r => r.json()).catch(() => ({ events: [] })),
        ]);

        lastStats = statsRes;
        renderOverviewTiles();
        renderSlimChart(statsRes);

        // Store data in globals (order doesn't matter — just setters)
        renderGoals(goalsRes.goals || []);
        renderTasks(tasksRes.tasks || []);
        renderWatchers(watchersRes.watchers || []);
        renderMemories(memoriesRes.memories || []);

        // Render panels — each wrapped so one failure doesn't block others
        [
          () => renderSlackAnalytics(slackRes),
          () => renderUsers(usersRes.users || []),
          () => renderMemoryPanel(),
          () => renderAutomationPanel(),
        ].forEach(fn => { try { fn(); } catch (e) { console.error('Render error:', e); } });

        // Activity feed
        let events = activityRes.events || [];
        if (selectedBot) {
          events = events.filter(ev => !ev.botName || ev.botName === selectedBot);
        }
        // Repopulate feed (events are oldest-first, addEvent prepends, so reverse to get chronological)
        events.slice().reverse().forEach(ev => addEvent(ev));

        // Home cards: Now (up-next) + Attention
        loadNowOverview();
        loadAttention();
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
      }
    }

    // --- Users Rendering ---
    let selectedUserId = null;

    function renderUsers(users) {
      usersData = users;
      const el = document.getElementById('usersMasterList');
      document.getElementById('usersCount').textContent = users.length;
      updateTabCount('users', users.length);
      if (!users.length) {
        el.innerHTML = '<div class="panel-empty">No users yet</div>';
        document.getElementById('usersDetailEmpty').style.display = 'flex';
        document.getElementById('usersDetailContent').style.display = 'none';
        selectedUserId = null;
        return;
      }
      el.innerHTML = users.map(u => {
        const initial = (u.username || u.userId || '?')[0].toUpperCase();
        const platform = u.platform || 'telegram';
        const platformClass = platform.replace(/[^a-z_]/g, '');
        var aName = u.username || u.userId || '?';
        return '<div class="md-row" data-user-select="' + escapeAttr(u.userId) + '">' +
          '<div class="user-avatar" style="' + avatarStyle(aName) + '">' + escapeHtml(initial) + '</div>' +
          '<div class="md-row-info">' +
            '<div class="md-row-name">' + escapeHtml(u.username || u.userId) + '</div>' +
            '<div class="md-row-meta">' +
              '<span class="user-platform-badge ' + escapeAttr(platformClass) + '">' + escapeHtml(platform) + '</span>' +
              '<span>' + (u.messageCount || 0) + ' msgs</span>' +
              '<span>' + (u.lastActive ? timeAgo(u.lastActive) : '') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      // Re-select previous user or auto-select first
      const match = selectedUserId && users.find(u => u.userId === selectedUserId);
      selectUser(match ? selectedUserId : users[0].userId);
    }

    function selectUser(userId) {
      const u = usersData.find(u => u.userId === userId);
      if (!u) return;
      selectedUserId = userId;

      // Highlight selected row
      document.querySelectorAll('#usersMasterList .md-row').forEach(r => {
        r.classList.toggle('selected', r.dataset.userSelect === userId);
      });

      // Show detail content, hide empty
      document.getElementById('usersDetailEmpty').style.display = 'none';
      const content = document.getElementById('usersDetailContent');
      content.style.display = 'flex';

      // Render inline detail
      renderInlineUserDetail(u);
    }

    // --- Periodic Refresh ---
    async function refreshStats() {
      try {
        const stats = await fetch('/api/stats' + botParam()).then(r => r.json());
        lastStats = stats;
        renderOverviewTiles();
        renderSlimChart(stats);
        if (uchartFullShown && typeof initChart === 'function') {
          initChart(stats.messagesByDay || [], stats.tokensByDay || []);
        }
        loadAttention();
      } catch (err) {
        console.error('Failed to refresh stats:', err);
      }
    }

    // --- Init ---
    initSectionTabs();
    loadDashboard();
    connect();
    setInterval(refreshStats, 60000);

    // One-time click handlers for master-detail lists (avoids listener leak on re-render)
    document.getElementById('usersMasterList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-user-select]');
      if (row) selectUser(row.dataset.userSelect);
    });

    // Create user button
    document.getElementById('addUserBtn').addEventListener('click', () => {
      const existing = document.getElementById('createUserForm');
      if (existing) { existing.remove(); return; }
      const form = document.createElement('div');
      form.id = 'createUserForm';
      form.className = 'create-user-form';
      form.innerHTML = '<input id="newUserId" placeholder="User ID (e.g. Slack ID)" />' +
        '<input id="newUserName" placeholder="Display name" />' +
        '<input id="newUserBot" placeholder="Bot name" value="' + escapeAttr(selectedBot || '') + '" />' +
        '<div class="form-actions">' +
          '<button class="btn-cancel" id="cancelCreateUser">Cancel</button>' +
          '<button class="btn-create" id="confirmCreateUser">Create</button>' +
        '</div>';
      const header = document.querySelector('[data-section="users"] .md-master-header');
      header.after(form);
      document.getElementById('newUserId').focus();
      document.getElementById('cancelCreateUser').addEventListener('click', () => form.remove());
      document.getElementById('confirmCreateUser').addEventListener('click', async () => {
        const userId = document.getElementById('newUserId').value.trim();
        const username = document.getElementById('newUserName').value.trim();
        const botName = document.getElementById('newUserBot').value.trim();
        if (!userId || !username || !botName) return;
        try {
          const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, username, botName }),
          });
          if (!res.ok) { const err = await res.json(); alert(err.error || 'Failed'); return; }
          form.remove();
          // Refresh users list
          const usersRes = await fetch('/api/users' + botParam()).then(r => r.json()).catch(() => ({ users: [] }));
          renderUsers(usersRes.users || []);
          selectUser(userId);
        } catch (err) { alert('Failed to create user: ' + err.message); }
      });
    });
    // --- Event Delegation ---
    document.addEventListener('click', (e) => {
      // Slack user clicks
      const userItem = e.target.closest('.slack-user-item[data-user-id]');
      if (userItem) {
        e.stopPropagation();
        showSlackUserMessages(userItem.dataset.userId, userItem.dataset.username);
        return;
      }

      // Slack message expand
      const expandBtn = e.target.closest('.slack-msg-expand');
      if (expandBtn) {
        const content = expandBtn.previousElementSibling;
        content.classList.toggle('collapsed');
        expandBtn.textContent = content.classList.contains('collapsed') ? 'Show more' : 'Show less';
      }
    });
  `;
}
