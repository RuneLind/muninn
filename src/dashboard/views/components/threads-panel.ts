/** Threads panel — master-detail layout with thread list and inline messages */
export function threadsPanelStyles(): string {
  return `
    .thread-user-label {
      padding: 8px 12px 4px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      font-weight: 600;
    }
  `;
}

export function threadsPanelHtml(): string {
  return `
      <div class="md-layout">
        <div class="md-master">
          <div class="md-master-header">
            Threads <span class="count" id="threadsCount">0</span>
          </div>
          <div class="md-master-body" id="threadsMasterList">
            <div class="panel-empty">Loading...</div>
          </div>
        </div>
        <div class="md-detail" id="threadsDetailPanel">
          <div class="md-detail-empty" id="threadsDetailEmpty">
            Select a thread to view messages
          </div>
          <div class="md-detail-content" id="threadsDetailContent" style="display:none"></div>
        </div>
      </div>`;
}

export function threadsPanelScript(): string {
  return `
    let threadsData = [];
    let selectedThreadId = null;

    function renderThreads(threads) {
      threadsData = threads;
      const el = document.getElementById('threadsMasterList');
      document.getElementById('threadsCount').textContent = threads.length;
      updateTabCount('threads', threads.length);
      if (!threads.length) {
        el.innerHTML = '<div class="panel-empty">No threads yet</div>';
        document.getElementById('threadsDetailEmpty').style.display = 'flex';
        document.getElementById('threadsDetailContent').style.display = 'none';
        selectedThreadId = null;
        return;
      }

      // Group by userId
      const grouped = {};
      threads.forEach(t => {
        if (!grouped[t.userId]) grouped[t.userId] = { username: t.username || t.userId, threads: [] };
        else if (t.username) grouped[t.userId].username = t.username;
        grouped[t.userId].threads.push(t);
      });

      el.innerHTML = Object.entries(grouped).map(([userId, group]) => {
        const rowsHtml = group.threads.map(t => {
          const activeDot = t.isActive ? '<span class="thread-active-dot" title="Active"></span>' : '';
          const msgBadge = t.messageCount != null ? '<span style="font-size:10px;color:var(--text-dim)">' + t.messageCount + '</span>' : '';
          return '<div class="md-row" data-thread-select="' + escapeAttr(t.id || '') + '">' +
            '<div class="thread-icon">#</div>' +
            '<div class="md-row-info">' +
              '<div class="md-row-name">' + activeDot + ' ' + escapeHtml(t.name || 'main') + '</div>' +
              '<div class="md-row-meta">' +
                msgBadge +
                (t.updatedAt ? '<span>' + timeAgo(t.updatedAt) + '</span>' : '') +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        return '<div class="thread-user-label">' + escapeHtml(group.username) + '</div>' + rowsHtml;
      }).join('');

      // Re-select previous thread or auto-select first
      const match = selectedThreadId && threads.find(t => t.id === selectedThreadId);
      selectThread(match ? selectedThreadId : threads[0].id);
    }

    function selectThread(threadId) {
      const t = threadsData.find(t => t.id === threadId);
      if (!t) return;
      selectedThreadId = threadId;

      // Highlight selected row
      document.querySelectorAll('#threadsMasterList .md-row').forEach(r => {
        r.classList.toggle('selected', r.dataset.threadSelect === threadId);
      });

      // Show detail content, hide empty
      document.getElementById('threadsDetailEmpty').style.display = 'none';
      const content = document.getElementById('threadsDetailContent');
      content.style.display = 'flex';

      // Render inline detail
      renderInlineThreadDetail(t);
    }

    function renderInlineThreadDetail(t) {
      const content = document.getElementById('threadsDetailContent');
      const activeBadge = t.isActive
        ? '<span class="detail-badge active" style="font-size:10px;margin-left:8px">Active</span>'
        : '<span class="detail-badge disabled" style="font-size:10px;margin-left:8px">Inactive</span>';

      content.innerHTML = '' +
        '<div class="md-detail-header">' +
          '<div class="thread-detail-info">' +
            '<div class="thread-detail-icon">#</div>' +
            '<div>' +
              '<div class="thread-detail-name">' + escapeHtml(t.name || 'main') + activeBadge + '</div>' +
              '<div class="thread-detail-user">' + escapeHtml(t.username || t.userId) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="detail-stat-row">' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (t.messageCount || 0) + '</div><div class="detail-stat-label">Messages</div></div>' +
            '<div class="detail-stat-box"><div class="detail-stat-num">' + (t.updatedAt ? timeAgo(t.updatedAt) : '—') + '</div><div class="detail-stat-label">Last Active</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="md-detail-body" id="threadDetailMessages">' +
          '<div class="detail-skeleton"></div><div class="detail-skeleton" style="width:70%"></div><div class="detail-skeleton" style="width:50%"></div>' +
        '</div>';

      loadThreadDetailMessages(t);
    }

    async function loadThreadDetailMessages(thread) {
      const body = document.getElementById('threadDetailMessages');
      if (!body) return;
      try {
        let url = '/api/messages/' + encodeURIComponent(thread.userId) + '?limit=50';
        if (thread.id) url += '&thread=' + encodeURIComponent(thread.id);
        if (thread.botName) url += '&bot=' + encodeURIComponent(thread.botName);
        else if (selectedBot) url += '&bot=' + encodeURIComponent(selectedBot);
        const res = await fetch(url);
        const data = await res.json();
        const msgs = data.messages || [];

        if (!msgs.length) {
          body.innerHTML = '<div class="detail-empty-hint">No messages in this thread</div>';
          return;
        }

        body.innerHTML = msgs.map(m => {
          const text = escapeHtml(m.text || '');
          const who = m.role === 'user' ? escapeHtml(m.username || 'User') : 'Bot';
          const tokens = m.inputTokens || m.outputTokens
            ? ' &middot; ' + fmtTokens((m.inputTokens || 0) + (m.outputTokens || 0)) + ' tok'
            : '';
          return '<div class="detail-msg role-' + m.role + '">' +
            '<div class="detail-msg-meta">' + who + ' &middot; ' + formatTime(m.timestamp) + tokens + '</div>' +
            text +
          '</div>';
        }).join('');

        body.scrollTop = body.scrollHeight;
      } catch {
        body.innerHTML = '<div class="detail-empty-hint">Failed to load messages</div>';
      }
    }
  `;
}
