/** SSE connection, data loading, periodic refresh, and event delegation */
export function connectionStyles(): string {
  return `
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
        const [statsRes, goalsRes, tasksRes, watchersRes, memoriesRes, slackRes, memByUserRes, threadsRes] = await Promise.all([
          fetch('/api/stats').then(r => r.json()),
          fetch('/api/goals').then(r => r.json()),
          fetch('/api/tasks').then(r => r.json()),
          fetch('/api/watchers').then(r => r.json()),
          fetch('/api/memories').then(r => r.json()),
          fetch('/api/slack-analytics').then(r => r.json()).catch(() => null),
          fetch('/api/memories/by-user').then(r => r.json()).catch(() => ({ users: [] })),
          fetch('/api/threads').then(r => r.json()).catch(() => ({ threads: [] })),
        ]);

        updateStatCards(statsRes);
        renderGoals(goalsRes.goals || []);
        renderTasks(tasksRes.tasks || []);
        renderWatchers(watchersRes.watchers || []);
        renderMemories(memoriesRes.memories || []);
        renderSlackAnalytics(slackRes);
        renderMemoriesByUser(memByUserRes.users || []);
        renderThreads(threadsRes.threads || []);
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

    // Event delegation for watcher log buttons, slack user clicks, memory user clicks, and message expand
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

      const memUserItem = e.target.closest('.memory-user-item[data-memory-user-id]');
      if (memUserItem) {
        e.stopPropagation();
        toggleMemoryUserDetail(memUserItem.dataset.memoryUserId);
        return;
      }

      const memToggle = e.target.closest('.memory-toggle-btn[data-memory-view]');
      if (memToggle) {
        e.stopPropagation();
        switchMemoryView(memToggle.dataset.memoryView);
        return;
      }

      const expandBtn = e.target.closest('.slack-msg-expand');
      if (expandBtn) {
        const content = expandBtn.previousElementSibling;
        content.classList.toggle('collapsed');
        expandBtn.textContent = content.classList.contains('collapsed') ? 'Show more' : 'Show less';
      }
    });
  `;
}
