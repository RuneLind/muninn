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
        // Update overview recent activity
        recentEvents.push(ev);
        if (recentEvents.length > 50) recentEvents = recentEvents.slice(-50);
        updateRecentActivity(recentEvents.slice(-5).reverse());
      });

      es.addEventListener('stats', (e) => {
        const data = JSON.parse(e.data);
        const el = document.getElementById('metricMsgsToday');
        if (el) el.textContent = data.messagesToday;
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

        updateMetricsStrip(statsRes);

        // Store data in globals (order doesn't matter — just setters)
        renderGoals(goalsRes.goals || []);
        renderTasks(tasksRes.tasks || []);
        renderWatchers(watchersRes.watchers || []);
        renderMemories(memoriesRes.memories || []);

        // Render panels — each wrapped so one failure doesn't block others
        [
          () => renderSlackAnalytics(slackRes),
          () => renderUsers(usersRes.users || []),
          () => renderKnowledgePanel(),
          () => renderAutomationPanel(),
          () => initChart(statsRes.messagesByDay || [], statsRes.tokensByDay || []),
        ].forEach(fn => { try { fn(); } catch (e) { console.error('Render error:', e); } });

        // Activity feed + overview: recent activity
        let events = activityRes.events || [];
        if (selectedBot) {
          events = events.filter(ev => !ev.botName || ev.botName === selectedBot);
        }
        // Repopulate feed (events are oldest-first, addEvent prepends, so reverse to get chronological)
        events.slice().reverse().forEach(ev => addEvent(ev));
        recentEvents = events;
        updateRecentActivity(recentEvents.slice(-5).reverse());

        // Overview: upcoming
        updateUpcoming(goalsRes.goals || [], tasksRes.tasks || []);
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
        return '<div class="md-row" data-user-select="' + escapeAttr(u.userId) + '">' +
          '<div class="user-avatar">' + escapeHtml(initial) + '</div>' +
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
        updateMetricsStrip(stats);
        initChart(stats.messagesByDay || [], stats.tokensByDay || []);
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
