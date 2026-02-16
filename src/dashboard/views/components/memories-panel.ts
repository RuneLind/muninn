/** Memories panel — recent memories list + by-user view */
export function memoriesPanelStyles(): string {
  return `
    .memory-item {
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .memory-item:hover { background: #ffffff06; }
    .memory-summary { font-size: 13px; color: #ccc; margin-bottom: 6px; line-height: 1.4; }
    .memory-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

    /* Memory view toggle */
    .memory-toggle {
      display: flex;
      gap: 2px;
      background: #1a1a2e;
      border-radius: 6px;
      padding: 2px;
    }
    .memory-toggle-btn {
      background: none;
      border: none;
      color: #666;
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s;
    }
    .memory-toggle-btn.active {
      background: #2a2a3e;
      color: #ccc;
    }
    .memory-toggle-btn:hover:not(.active) { color: #999; }

    /* By-user view */
    .memory-user-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .memory-user-item:hover { background: #ffffff06; }
    .memory-user-item.expanded { background: rgba(108, 99, 255, 0.06); }
    .memory-user-name { font-size: 13px; color: #ddd; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .memory-user-counts { display: flex; gap: 6px; font-size: 11px; color: #555; align-items: center; }
    .memory-scope-bar {
      width: 40px;
      height: 4px;
      border-radius: 2px;
      background: #1a1a2e;
      overflow: hidden;
      display: flex;
    }
    .memory-scope-personal { background: #6c63ff; height: 100%; }
    .memory-scope-shared { background: #4ade80; height: 100%; }
    .memory-user-detail {
      display: none;
      padding: 4px 12px 8px 32px;
    }
    .memory-user-detail.visible { display: block; }
    .memory-user-detail .memory-item { padding: 6px 0; }
    .memory-user-detail .memory-summary { font-size: 12px; }
  `;
}

export function memoriesPanelHtml(): string {
  return `
      <div class="panel" id="memoriesPanel">
        <div class="panel-header">
          <span>Memories <span class="count" id="memoriesCount">0</span></span>
          <div class="memory-toggle">
            <button class="memory-toggle-btn active" data-memory-view="recent">Recent</button>
            <button class="memory-toggle-btn" data-memory-view="by-user">By User</button>
          </div>
        </div>
        <div class="panel-body" id="memoriesList"></div>
        <div class="panel-body" id="memoriesByUserList" style="display:none"></div>
      </div>`;
}

export function memoriesPanelScript(): string {
  return `
    let memoryView = 'recent';
    let memoriesByUserData = [];

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

    function renderMemoriesByUser(users) {
      memoriesByUserData = users;
      const el = document.getElementById('memoriesByUserList');
      if (!users.length) { el.innerHTML = '<div class="panel-empty">No memories yet</div>'; return; }
      el.innerHTML = users.map(u => {
        const total = u.totalCount;
        const personalPct = total > 0 ? Math.round((u.personalCount / total) * 100) : 0;
        const tags = (u.recentTags || []).slice(0, 3).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
        return '<div class="memory-user-item" data-memory-user-id="' + escapeAttr(u.userId) + '">' +
          '<span class="memory-user-name">' + escapeHtml(u.username || u.userId) + '</span>' +
          '<span class="memory-user-counts">' +
            u.personalCount + 'p / ' + u.sharedCount + 's' +
            ' <span class="memory-scope-bar"><span class="memory-scope-personal" style="width:' + personalPct + '%"></span><span class="memory-scope-shared" style="width:' + (100 - personalPct) + '%"></span></span>' +
          '</span>' +
        '</div>' +
        '<div class="memory-user-detail" data-memory-detail-id="' + escapeAttr(u.userId) + '">' +
          tags +
          '<div class="panel-empty" style="padding:8px;font-size:11px">Click to load memories</div>' +
        '</div>';
      }).join('');
    }

    async function toggleMemoryUserDetail(userId) {
      const detailEl = document.querySelector('[data-memory-detail-id="' + CSS.escape(userId) + '"]');
      const userItem = document.querySelector('[data-memory-user-id="' + CSS.escape(userId) + '"]');
      if (!detailEl) return;

      const isVisible = detailEl.classList.contains('visible');
      // Collapse all
      document.querySelectorAll('.memory-user-detail').forEach(el => el.classList.remove('visible'));
      document.querySelectorAll('.memory-user-item').forEach(el => el.classList.remove('expanded'));

      if (isVisible) return; // Was open, now closed

      detailEl.classList.add('visible');
      if (userItem) userItem.classList.add('expanded');

      // Load user memories
      detailEl.innerHTML = '<div class="panel-empty" style="padding:8px;font-size:11px">Loading...</div>';
      try {
        const res = await fetch('/api/memories/user/' + encodeURIComponent(userId) + '?limit=10');
        const data = await res.json();
        const memories = data.memories || [];
        if (!memories.length) {
          detailEl.innerHTML = '<div class="panel-empty" style="padding:8px;font-size:11px">No memories</div>';
          return;
        }
        detailEl.innerHTML = memories.map(m => {
          const tags = (m.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
          const scope = m.scope === 'shared' ? '<span class="tag" style="background:#1a3a2a;color:#4ade80;border-color:#2a3a2e">shared</span>' : '';
          return '<div class="memory-item">' +
            '<div class="memory-summary">' + escapeHtml(m.summary) + '</div>' +
            '<div class="memory-meta">' +
              '<span class="time-ago">' + timeAgo(m.createdAt) + '</span>' + scope + tags +
            '</div></div>';
        }).join('');
      } catch (err) {
        detailEl.innerHTML = '<div class="panel-empty" style="padding:8px;font-size:11px">Failed to load</div>';
      }
    }

    function switchMemoryView(view) {
      memoryView = view;
      document.querySelectorAll('.memory-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.memoryView === view);
      });
      document.getElementById('memoriesList').style.display = view === 'recent' ? '' : 'none';
      document.getElementById('memoriesByUserList').style.display = view === 'by-user' ? '' : 'none';
    }
  `;
}
