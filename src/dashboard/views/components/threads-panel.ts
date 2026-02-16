/** Threads panel — conversation threads grouped by user */
export function threadsPanelStyles(): string {
  return `
    .thread-user-group {
      padding: 4px 0;
    }
    .thread-user-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 12px;
      color: #888;
      font-weight: 500;
    }
    .thread-user-header .count {
      background: #1e1e2e;
      color: #666;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 400;
    }
    .thread-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px 8px 24px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .thread-item:hover { background: #ffffff06; }
    .thread-name { font-size: 13px; color: #ddd; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thread-active-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #4ade80;
      flex-shrink: 0;
    }
    .thread-msg-count {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: #1a1a2e;
      color: #8b8bcd;
      border: 1px solid #2a2a3e;
    }
    .thread-meta {
      font-size: 10px;
      color: #444;
      white-space: nowrap;
    }
  `;
}

export function threadsPanelHtml(): string {
  return `
      <div class="panel" id="threadsPanel">
        <div class="panel-header">
          Threads <span class="count" id="threadsCount">0</span>
        </div>
        <div class="panel-body" id="threadsList"></div>
      </div>`;
}

export function threadsPanelScript(): string {
  return `
    function renderThreads(threads) {
      const el = document.getElementById('threadsList');
      document.getElementById('threadsCount').textContent = threads.length;
      if (!threads.length) { el.innerHTML = '<div class="panel-empty">No threads yet</div>'; return; }

      // Group by userId
      const grouped = {};
      threads.forEach(t => {
        if (!grouped[t.userId]) grouped[t.userId] = { username: t.username || t.userId, threads: [] };
        else if (t.username) grouped[t.userId].username = t.username;
        grouped[t.userId].threads.push(t);
      });

      el.innerHTML = Object.entries(grouped).map(([userId, group]) => {
        const threadsHtml = group.threads.map(t => {
          const activeDot = t.isActive ? '<span class="thread-active-dot" title="Active"></span>' : '';
          const msgCount = t.messageCount != null ? '<span class="thread-msg-count">' + t.messageCount + '</span>' : '';
          const lastActivity = t.updatedAt ? '<span class="thread-meta">' + timeAgo(t.updatedAt) + '</span>' : '';
          return '<div class="thread-item">' +
            activeDot +
            '<span class="thread-name">' + escapeHtml(t.name) + '</span>' +
            msgCount +
            lastActivity +
          '</div>';
        }).join('');

        return '<div class="thread-user-group">' +
          '<div class="thread-user-header">' +
            escapeHtml(group.username) +
            ' <span class="count">' + group.threads.length + '</span>' +
          '</div>' +
          threadsHtml +
        '</div>';
      }).join('');
    }
  `;
}
