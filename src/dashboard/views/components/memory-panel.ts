/** Memory panel — combined memories + goals master-detail with tag navigation */
export function memoryPanelStyles(): string {
  return `
    /* Memory panel filters */
    .mg-filters {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .mg-filter-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .mg-pill {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 10px;
      background: var(--bg-surface);
      color: var(--text-dim);
      border: 1px solid var(--border-secondary);
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
      font-weight: 500;
    }
    .mg-pill:hover { color: var(--text-soft); border-color: var(--border-secondary); }
    .mg-pill.active {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .mg-pill .mg-pill-count {
      margin-left: 3px;
      opacity: 0.6;
    }

    /* Type icons in master list */
    .mg-type-icon {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
    }
    .mg-type-icon.memory { background: var(--tint-purple); }
    .mg-type-icon.goal { background: var(--tint-success); }

    /* Scope dot */
    .mg-scope-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .mg-scope-dot.personal { background: var(--accent); }
    .mg-scope-dot.shared { background: var(--status-success); }

    /* Overview (default right panel state) */
    .mg-overview {
      padding: 24px;
    }
    .mg-overview-stats {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }
    .mg-scope-bar-container {
      margin-bottom: 20px;
    }
    .mg-scope-bar-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      margin-bottom: 6px;
    }
    .mg-scope-bar {
      display: flex;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      background: var(--bg-surface);
    }
    .mg-scope-bar-personal { background: var(--accent); height: 100%; transition: width 0.3s; }
    .mg-scope-bar-shared { background: var(--status-success); height: 100%; transition: width 0.3s; }
    .mg-scope-bar-legend {
      display: flex;
      gap: 16px;
      margin-top: 6px;
      font-size: 10px;
      color: var(--text-dim);
    }
    .mg-scope-bar-legend span::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 4px;
    }
    .mg-scope-bar-legend .legend-personal::before { background: var(--accent); }
    .mg-scope-bar-legend .legend-shared::before { background: var(--status-success); }

    /* Tag cloud in overview */
    .mg-tag-cloud-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
      margin-bottom: 8px;
    }
    .mg-tag-cloud {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .mg-tag-cloud .mg-pill {
      font-size: 11px;
      padding: 4px 10px;
    }

    /* Goal status dot in master list */
    .mg-goal-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .mg-goal-dot.active { background: var(--status-success); }
    .mg-goal-dot.completed { background: var(--accent); }
    .mg-goal-dot.cancelled { background: var(--text-dim); }
  `;
}

export function memoryPanelHtml(): string {
  return `
      <div class="md-layout">
        <div class="md-master">
          <div class="md-master-header">
            Memory <span class="count" id="memoryCount">0</span>
          </div>
          <div class="mg-filters" id="mgFilters">
            <div class="mg-filter-row" id="mgTypeFilters"></div>
            <div class="mg-filter-row" id="mgScopeFilters"></div>
            <div class="mg-filter-row" id="mgTagFilters"></div>
          </div>
          <div class="md-master-body" id="mgMasterList">
            <div class="panel-empty">Loading...</div>
          </div>
        </div>
        <div class="md-detail" id="mgDetailPanel">
          <div class="md-detail-empty" id="mgDetailEmpty">
            <div class="mg-overview" id="mgOverview"></div>
          </div>
          <div class="md-detail-content" id="mgDetailContent" style="display:none"></div>
        </div>
      </div>`;
}

export function memoryPanelScript(): string {
  return `
    let mgFilter = { type: 'all', scope: 'all', tag: null };
    let selectedMgItem = null; // { kind, id }

    function renderMemoryPanel() {
      const memories = memoriesData || [];
      const goals = goalsData || [];
      const total = memories.length + goals.length;

      document.getElementById('memoryCount').textContent = total;
      updateTabCount('memories-goals', total);

      // Compute tag counts from both
      const tagCounts = {};
      memories.forEach(m => (m.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
      goals.forEach(g => (g.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

      // Render filter pills
      renderMgTypeFilters(memories.length, goals.length);
      renderMgScopeFilters(memories);
      renderMgTagPills(tagCounts);

      // Render combined list
      renderCombinedList();

      // Show overview if nothing selected
      if (!selectedMgItem) {
        renderMgOverview(tagCounts, memories, goals);
      }
    }

    function renderMgTypeFilters(memCount, goalCount) {
      const total = memCount + goalCount;
      const el = document.getElementById('mgTypeFilters');
      const pills = [
        { key: 'all', label: 'All', count: total },
        { key: 'memory', label: 'Memories', count: memCount },
        { key: 'goal', label: 'Goals', count: goalCount },
      ];
      el.innerHTML = pills.map(p =>
        '<span class="mg-pill' + (mgFilter.type === p.key ? ' active' : '') + '" data-mg-type="' + p.key + '">' +
          p.label + '<span class="mg-pill-count">' + p.count + '</span>' +
        '</span>'
      ).join('');
    }

    function renderMgScopeFilters(memories) {
      const el = document.getElementById('mgScopeFilters');
      const personal = memories.filter(m => (m.scope || 'personal') === 'personal').length;
      const shared = memories.filter(m => m.scope === 'shared').length;
      const pills = [
        { key: 'all', label: 'All scopes' },
        { key: 'personal', label: 'Personal', count: personal },
        { key: 'shared', label: 'Shared', count: shared },
      ];
      el.innerHTML = pills.map(p =>
        '<span class="mg-pill' + (mgFilter.scope === p.key ? ' active' : '') + '" data-mg-scope="' + p.key + '">' +
          p.label + (p.count != null ? '<span class="mg-pill-count">' + p.count + '</span>' : '') +
        '</span>'
      ).join('');
    }

    function renderMgTagPills(tagCounts) {
      const el = document.getElementById('mgTagFilters');
      const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (!sorted.length) { el.innerHTML = ''; return; }
      el.innerHTML = sorted.map(([tag, count]) =>
        '<span class="mg-pill' + (mgFilter.tag === tag ? ' active' : '') + '" data-mg-tag="' + escapeAttr(tag) + '">' +
          escapeHtml(tag) + '<span class="mg-pill-count">' + count + '</span>' +
        '</span>'
      ).join('');
    }

    function renderCombinedList() {
      const el = document.getElementById('mgMasterList');
      const memories = memoriesData || [];
      const goals = goalsData || [];

      // Build combined items
      let items = [];
      if (mgFilter.type === 'all' || mgFilter.type === 'memory') {
        memories.forEach(m => items.push({ kind: 'memory', id: m.id, data: m, ts: m.createdAt }));
      }
      if (mgFilter.type === 'all' || mgFilter.type === 'goal') {
        goals.forEach(g => items.push({ kind: 'goal', id: g.id, data: g, ts: g.createdAt }));
      }

      // Apply scope filter (memories only, goals always pass)
      if (mgFilter.scope !== 'all') {
        items = items.filter(item => {
          if (item.kind === 'goal') return true;
          return (item.data.scope || 'personal') === mgFilter.scope;
        });
      }

      // Apply tag filter
      if (mgFilter.tag) {
        items = items.filter(item => {
          const tags = item.data.tags || [];
          return tags.includes(mgFilter.tag);
        });
      }

      // Sort by creation time descending
      items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      if (!items.length) {
        el.innerHTML = '<div class="panel-empty">No items match filters</div>';
        return;
      }

      el.innerHTML = items.map(item => {
        const isSelected = selectedMgItem && selectedMgItem.kind === item.kind && selectedMgItem.id === item.id;
        if (item.kind === 'memory') {
          return renderMemoryRow(item.data, isSelected);
        } else {
          return renderGoalRow(item.data, isSelected);
        }
      }).join('');
    }

    function renderMemoryRow(m, isSelected) {
      const scope = m.scope || 'personal';
      const text = (m.summary || '').length > 80 ? m.summary.slice(0, 80) + '...' : (m.summary || '');
      const tags = (m.tags || []).slice(0, 2).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
      return '<div class="md-row' + (isSelected ? ' selected' : '') + '" data-mg-select="memory:' + escapeAttr(String(m.id)) + '">' +
        '<div class="mg-type-icon memory">&#129504;</div>' +
        '<div class="md-row-info">' +
          '<div class="md-row-name">' + escapeHtml(text) + '</div>' +
          '<div class="md-row-meta">' +
            '<span class="mg-scope-dot ' + escapeAttr(scope) + '" title="' + escapeAttr(scope) + '"></span>' +
            '<span>' + escapeHtml(scope) + '</span>' +
            tags +
            '<span>' + timeAgo(m.createdAt) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function renderGoalRow(g, isSelected) {
      const isDone = g.status === 'completed' || g.status === 'cancelled';
      const text = (g.title || '').length > 80 ? g.title.slice(0, 80) + '...' : (g.title || '');
      const dl = g.deadline && !isDone ? deadlineText(g.deadline) : '';
      const tags = (g.tags || []).slice(0, 2).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
      return '<div class="md-row' + (isSelected ? ' selected' : '') + (isDone ? ' done' : '') + '" data-mg-select="goal:' + escapeAttr(String(g.id)) + '" style="' + (isDone ? 'opacity:0.5' : '') + '">' +
        '<div class="mg-type-icon goal">&#127919;</div>' +
        '<div class="md-row-info">' +
          '<div class="md-row-name">' + escapeHtml(text) + '</div>' +
          '<div class="md-row-meta">' +
            '<span class="mg-goal-dot ' + escapeAttr(g.status) + '"></span>' +
            '<span>' + escapeHtml(g.status) + '</span>' +
            (dl ? '<span>' + dl + '</span>' : '') +
            tags +
            '<span>' + timeAgo(g.createdAt) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function selectMgItem(kind, id) {
      selectedMgItem = { kind: kind, id: id };

      // Highlight row
      document.querySelectorAll('#mgMasterList .md-row').forEach(r => {
        r.classList.toggle('selected', r.dataset.mgSelect === kind + ':' + id);
      });

      // Show detail content, hide empty/overview
      document.getElementById('mgDetailEmpty').style.display = 'none';
      const content = document.getElementById('mgDetailContent');
      content.style.display = 'flex';

      if (kind === 'memory') {
        const m = (memoriesData || []).find(m => String(m.id) === String(id));
        if (m) renderInlineMemoryDetail(m);
      } else {
        const g = (goalsData || []).find(g => String(g.id) === String(id));
        if (g) renderInlineGoalDetail(g);
      }
    }

    function renderMgOverview(tagCounts, memories, goals) {
      const el = document.getElementById('mgOverview');
      const personal = memories.filter(m => (m.scope || 'personal') === 'personal').length;
      const shared = memories.filter(m => m.scope === 'shared').length;
      const totalMem = memories.length;
      const activeGoals = goals.filter(g => g.status === 'active').length;
      const uniqueTags = Object.keys(tagCounts).length;
      const personalPct = totalMem > 0 ? Math.round((personal / totalMem) * 100) : 50;

      const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
      const cloudHtml = sorted.length ? sorted.map(([tag, count]) =>
        '<span class="mg-pill" data-mg-cloud-tag="' + escapeAttr(tag) + '">' +
          escapeHtml(tag) + '<span class="mg-pill-count">' + count + '</span>' +
        '</span>'
      ).join('') : '<span style="color:var(--text-disabled);font-size:12px">No tags yet</span>';

      el.innerHTML = '' +
        '<div class="mg-overview-stats">' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + totalMem + '</div><div class="detail-stat-label">Memories</div></div>' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + activeGoals + '</div><div class="detail-stat-label">Active Goals</div></div>' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + uniqueTags + '</div><div class="detail-stat-label">Tags</div></div>' +
        '</div>' +
        (totalMem > 0 ? '' +
          '<div class="mg-scope-bar-container">' +
            '<div class="mg-scope-bar-label">Scope Distribution</div>' +
            '<div class="mg-scope-bar">' +
              '<div class="mg-scope-bar-personal" style="width:' + personalPct + '%"></div>' +
              '<div class="mg-scope-bar-shared" style="width:' + (100 - personalPct) + '%"></div>' +
            '</div>' +
            '<div class="mg-scope-bar-legend">' +
              '<span class="legend-personal">Personal ' + personal + '</span>' +
              '<span class="legend-shared">Shared ' + shared + '</span>' +
            '</div>' +
          '</div>'
        : '') +
        '<div class="mg-tag-cloud-label">Tags</div>' +
        '<div class="mg-tag-cloud">' + cloudHtml + '</div>';
    }

    function renderInlineMemoryDetail(m) {
      const content = document.getElementById('mgDetailContent');
      const scope = m.scope || 'personal';
      const tags = (m.tags || []).map(t =>
        '<span class="tag" style="cursor:pointer" data-mg-detail-tag="' + escapeAttr(t) + '">' + escapeHtml(t) + '</span>'
      ).join('');
      const username = resolveUsername(m.userId);

      content.innerHTML = '' +
        '<div class="md-detail-header" style="padding:20px 24px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
            '<div class="mg-type-icon memory" style="width:32px;height:32px;font-size:16px">&#129504;</div>' +
            '<div>' +
              '<div style="font-size:14px;font-weight:600;color:var(--text-primary)">Memory</div>' +
              '<div style="font-size:11px;color:var(--text-dim)">' + escapeHtml(username) + '</div>' +
            '</div>' +
            '<span class="detail-badge ' + escapeAttr(scope) + '" style="margin-left:auto">' + escapeHtml(scope) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="md-detail-body">' +
          '<div class="detail-field">' +
            '<div class="detail-label">Summary</div>' +
            '<div class="detail-value">' + escapeHtml(m.summary) + '</div>' +
          '</div>' +
          (tags ? '<div class="detail-field"><div class="detail-label">Tags</div><div class="detail-tags">' + tags + '</div></div>' : '') +
          '<div class="detail-field"><div class="detail-label">Created</div><div class="detail-value">' + timeAgo(m.createdAt) + ' &middot; ' + new Date(m.createdAt).toLocaleString() + '</div></div>' +
          '<div class="detail-field"><div class="detail-label">User</div><div class="detail-value">' + escapeHtml(username) + '</div></div>' +
        '</div>';
    }

    function renderInlineGoalDetail(g) {
      const content = document.getElementById('mgDetailContent');
      const tags = (g.tags || []).map(t =>
        '<span class="tag" style="cursor:pointer" data-mg-detail-tag="' + escapeAttr(t) + '">' + escapeHtml(t) + '</span>'
      ).join('');
      const username = resolveUsername(g.userId) || g.username || 'Unknown';

      content.innerHTML = '' +
        '<div class="md-detail-header" style="padding:20px 24px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
            '<div class="mg-type-icon goal" style="width:32px;height:32px;font-size:16px">&#127919;</div>' +
            '<div>' +
              '<div style="font-size:14px;font-weight:600;color:var(--text-primary)">Goal</div>' +
              '<div style="font-size:11px;color:var(--text-dim)">' + escapeHtml(username) + '</div>' +
            '</div>' +
            '<span class="detail-badge ' + escapeAttr(g.status) + '" style="margin-left:auto">' + escapeHtml(g.status) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="md-detail-body">' +
          '<div class="detail-field">' +
            '<div class="detail-label">Title</div>' +
            '<div class="detail-value">' + escapeHtml(g.title) + '</div>' +
          '</div>' +
          (g.description ? '<div class="detail-field"><div class="detail-label">Description</div><div class="detail-value">' + escapeHtml(g.description) + '</div></div>' : '') +
          (g.deadline ? '<div class="detail-field"><div class="detail-label">Deadline</div><div class="detail-value">' + new Date(g.deadline).toLocaleDateString() + ' (' + deadlineText(g.deadline) + ')</div></div>' : '') +
          (tags ? '<div class="detail-field"><div class="detail-label">Tags</div><div class="detail-tags">' + tags + '</div></div>' : '') +
          '<div class="detail-field"><div class="detail-label">Created</div><div class="detail-value">' + timeAgo(g.createdAt) + ' &middot; ' + new Date(g.createdAt).toLocaleString() + '</div></div>' +
          '<div class="detail-field"><div class="detail-label">User</div><div class="detail-value">' + escapeHtml(username) + '</div></div>' +
        '</div>';
    }

    function resolveUsername(userId) {
      if (!userId) return 'Unknown';
      const u = (usersData || []).find(u => u.userId === userId);
      return u ? (u.username || u.userId) : userId;
    }

    function setMgFilter(key, value) {
      if (key === 'tag') {
        // Toggle tag — click again to deselect
        mgFilter.tag = mgFilter.tag === value ? null : value;
      } else {
        mgFilter[key] = value;
      }
      // Deselect current item when filters change
      selectedMgItem = null;
      document.getElementById('mgDetailEmpty').style.display = 'flex';
      document.getElementById('mgDetailContent').style.display = 'none';

      // Re-render
      renderMemoryPanel();
    }

    // --- Click handlers for memory panel ---
    document.getElementById('mgFilters').addEventListener('click', (e) => {
      const typeEl = e.target.closest('[data-mg-type]');
      if (typeEl) { setMgFilter('type', typeEl.dataset.mgType); return; }

      const scopeEl = e.target.closest('[data-mg-scope]');
      if (scopeEl) { setMgFilter('scope', scopeEl.dataset.mgScope); return; }

      const tagEl = e.target.closest('[data-mg-tag]');
      if (tagEl) { setMgFilter('tag', tagEl.dataset.mgTag); return; }
    });

    document.getElementById('mgMasterList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-mg-select]');
      if (row) {
        const parts = row.dataset.mgSelect.split(':');
        selectMgItem(parts[0], parts.slice(1).join(':'));
      }
    });

    document.getElementById('mgDetailPanel').addEventListener('click', (e) => {
      // Cloud tag click in overview
      const cloudTag = e.target.closest('[data-mg-cloud-tag]');
      if (cloudTag) { setMgFilter('tag', cloudTag.dataset.mgCloudTag); return; }

      // Tag click in detail view
      const detailTag = e.target.closest('[data-mg-detail-tag]');
      if (detailTag) { setMgFilter('tag', detailTag.dataset.mgDetailTag); return; }
    });
  `;
}
