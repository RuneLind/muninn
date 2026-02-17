/** Automation panel — combined scheduled tasks + watchers master-detail */
export function automationPanelStyles(): string {
  return `
    /* Automation panel filters */
    .at-filters {
      padding: 8px 12px;
      border-bottom: 1px solid #1e1e2e;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .at-filter-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .at-pill {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 10px;
      background: #1a1a2e;
      color: #666;
      border: 1px solid #2a2a3e;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
      font-weight: 500;
    }
    .at-pill:hover { color: #999; border-color: #3a3a4e; }
    .at-pill.active {
      background: rgba(108, 99, 255, 0.15);
      color: #a5a0ff;
      border-color: rgba(108, 99, 255, 0.3);
    }
    .at-pill .at-pill-count {
      margin-left: 3px;
      opacity: 0.6;
    }

    /* Type icons in master list */
    .at-type-icon {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
    }
    .at-type-icon.task { background: #1e3a5f; }
    .at-type-icon.watcher { background: #2a1a3a; }

    /* Status dot */
    .at-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .at-status-dot.enabled { background: #4ade80; }
    .at-status-dot.disabled { background: #666; }

    /* Overview (default right panel state) */
    .at-overview {
      padding: 24px;
    }
    .at-overview-stats {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }

    /* Next-up schedule in overview */
    .at-next-up {
      margin-top: 16px;
    }
    .at-next-up-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #555;
      margin-bottom: 8px;
    }
    .at-next-up-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .at-next-up-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      background: #0d0d14;
      border: 1px solid #1a1a28;
      border-radius: 6px;
      font-size: 12px;
      color: #bbb;
    }
    .at-next-up-item .at-next-time {
      font-size: 11px;
      color: #666;
      font-family: monospace;
    }
  `;
}

export function automationPanelHtml(): string {
  return `
      <div class="md-layout">
        <div class="md-master">
          <div class="md-master-header">
            Automation <span class="count" id="automationCount">0</span>
          </div>
          <div class="at-filters" id="atFilters">
            <div class="at-filter-row" id="atTypeFilters"></div>
            <div class="at-filter-row" id="atStatusFilters"></div>
          </div>
          <div class="md-master-body" id="atMasterList">
            <div class="panel-empty">Loading...</div>
          </div>
        </div>
        <div class="md-detail" id="atDetailPanel">
          <div class="md-detail-empty" id="atDetailEmpty">
            <div class="at-overview" id="atOverview"></div>
          </div>
          <div class="md-detail-content" id="atDetailContent" style="display:none"></div>
        </div>
      </div>`;
}

export function automationPanelScript(): string {
  return `
    let atFilter = { type: 'all', status: 'all' };
    let selectedAtItem = null; // { kind, index }

    function renderAutomationPanel() {
      const tasks = tasksData || [];
      const watchers = watchersData || [];
      const total = tasks.length + watchers.length;

      document.getElementById('automationCount').textContent = total;
      updateTabCount('schedules-watchers', total);

      // Render filter pills
      renderAtTypeFilters(tasks.length, watchers.length);
      renderAtStatusFilters(tasks, watchers);

      // Render combined list
      renderAtCombinedList();

      // Show overview if nothing selected
      if (!selectedAtItem) {
        renderAtOverview(tasks, watchers);
      }
    }

    function renderAtTypeFilters(taskCount, watcherCount) {
      const total = taskCount + watcherCount;
      const el = document.getElementById('atTypeFilters');
      const pills = [
        { key: 'all', label: 'All', count: total },
        { key: 'task', label: 'Tasks', count: taskCount },
        { key: 'watcher', label: 'Watchers', count: watcherCount },
      ];
      el.innerHTML = pills.map(p =>
        '<span class="at-pill' + (atFilter.type === p.key ? ' active' : '') + '" data-at-type="' + p.key + '">' +
          p.label + '<span class="at-pill-count">' + p.count + '</span>' +
        '</span>'
      ).join('');
    }

    function renderAtStatusFilters(tasks, watchers) {
      let all;
      if (atFilter.type === 'task') all = tasks;
      else if (atFilter.type === 'watcher') all = watchers;
      else all = [...tasks, ...watchers];
      const enabled = all.filter(x => x.enabled).length;
      const disabled = all.length - enabled;
      const el = document.getElementById('atStatusFilters');
      const pills = [
        { key: 'all', label: 'All' },
        { key: 'enabled', label: 'Enabled', count: enabled },
        { key: 'disabled', label: 'Disabled', count: disabled },
      ];
      el.innerHTML = pills.map(p =>
        '<span class="at-pill' + (atFilter.status === p.key ? ' active' : '') + '" data-at-status="' + p.key + '">' +
          p.label + (p.count != null ? '<span class="at-pill-count">' + p.count + '</span>' : '') +
        '</span>'
      ).join('');
    }

    function renderAtCombinedList() {
      const el = document.getElementById('atMasterList');
      const tasks = tasksData || [];
      const watchers = watchersData || [];

      // Build combined items
      let items = [];
      if (atFilter.type === 'all' || atFilter.type === 'task') {
        tasks.forEach((t, i) => items.push({ kind: 'task', index: i, data: t }));
      }
      if (atFilter.type === 'all' || atFilter.type === 'watcher') {
        watchers.forEach((w, i) => items.push({ kind: 'watcher', index: i, data: w }));
      }

      // Apply status filter
      if (atFilter.status !== 'all') {
        const wantEnabled = atFilter.status === 'enabled';
        items = items.filter(item => item.data.enabled === wantEnabled);
      }

      if (!items.length) {
        el.innerHTML = '<div class="panel-empty">No items match filters</div>';
        return;
      }

      el.innerHTML = items.map(item => {
        const isSelected = selectedAtItem && selectedAtItem.kind === item.kind && selectedAtItem.index === item.index;
        if (item.kind === 'task') {
          return renderAtTaskRow(item.data, item.index, isSelected);
        } else {
          return renderAtWatcherRow(item.data, item.index, isSelected);
        }
      }).join('');
    }

    function renderAtTaskRow(t, index, isSelected) {
      const scheduleStr = formatSchedule(t);
      const nextLabel = t.nextRunAt && t.nextRunAt > Date.now()
        ? 'next: ' + new Date(t.nextRunAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
        : '';
      return '<div class="md-row' + (isSelected ? ' selected' : '') + '" data-at-select="task:' + index + '" style="' + (!t.enabled ? 'opacity:0.5' : '') + '">' +
        '<div class="at-type-icon task">&#128197;</div>' +
        '<div class="md-row-info">' +
          '<div class="md-row-name">' + escapeHtml(t.title) + '</div>' +
          '<div class="md-row-meta">' +
            '<span class="at-status-dot ' + (t.enabled ? 'enabled' : 'disabled') + '"></span>' +
            '<span class="task-badge ' + (t.enabled ? escapeAttr(t.taskType) : 'disabled') + '">' + escapeHtml(t.taskType) + '</span>' +
            '<span>' + scheduleStr + '</span>' +
            (nextLabel ? '<span>' + nextLabel + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function renderAtWatcherRow(w, index, isSelected) {
      const intervalStr = formatInterval(w.intervalMs);
      const lastRun = w.lastRunAt ? 'ran ' + timeAgo(w.lastRunAt) : 'never ran';
      return '<div class="md-row' + (isSelected ? ' selected' : '') + '" data-at-select="watcher:' + index + '" style="' + (!w.enabled ? 'opacity:0.5' : '') + '">' +
        '<div class="at-type-icon watcher">&#128065;</div>' +
        '<div class="md-row-info">' +
          '<div class="md-row-name">' + escapeHtml(w.name) + '</div>' +
          '<div class="md-row-meta">' +
            '<span class="at-status-dot ' + (w.enabled ? 'enabled' : 'disabled') + '"></span>' +
            '<span class="watcher-badge ' + (w.enabled ? escapeAttr(w.type) : 'disabled') + '">' + escapeHtml(w.type) + '</span>' +
            '<span>' + intervalStr + '</span>' +
            '<span>' + lastRun + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function selectAtItem(kind, index) {
      selectedAtItem = { kind: kind, index: parseInt(index, 10) };

      // Highlight row
      document.querySelectorAll('#atMasterList .md-row').forEach(r => {
        r.classList.toggle('selected', r.dataset.atSelect === kind + ':' + index);
      });

      // Show detail content, hide empty/overview
      document.getElementById('atDetailEmpty').style.display = 'none';
      const content = document.getElementById('atDetailContent');
      content.style.display = 'flex';

      if (kind === 'task') {
        const t = (tasksData || [])[selectedAtItem.index];
        if (t) renderInlineTaskDetail(t);
      } else {
        const w = (watchersData || [])[selectedAtItem.index];
        if (w) renderInlineWatcherDetail(w);
      }
    }

    function renderAtOverview(tasks, watchers) {
      const el = document.getElementById('atOverview');
      const enabledCount = [...tasks, ...watchers].filter(x => x.enabled).length;

      // Build next-up list from tasks with nextRunAt
      const upcoming = tasks
        .filter(t => t.enabled && t.nextRunAt && t.nextRunAt > Date.now())
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
        .slice(0, 5);

      const nextUpHtml = upcoming.length
        ? '<div class="at-next-up">' +
            '<div class="at-next-up-label">Next Up</div>' +
            '<div class="at-next-up-list">' +
              upcoming.map(t =>
                '<div class="at-next-up-item">' +
                  '<span>' + escapeHtml(t.title) + '</span>' +
                  '<span class="at-next-time">' + new Date(t.nextRunAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) + '</span>' +
                '</div>'
              ).join('') +
            '</div>' +
          '</div>'
        : '';

      el.innerHTML = '' +
        '<div class="at-overview-stats">' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + tasks.length + '</div><div class="detail-stat-label">Tasks</div></div>' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + watchers.length + '</div><div class="detail-stat-label">Watchers</div></div>' +
          '<div class="detail-stat-box"><div class="detail-stat-num">' + enabledCount + '</div><div class="detail-stat-label">Enabled</div></div>' +
        '</div>' +
        nextUpHtml;
    }

    function renderInlineTaskDetail(t) {
      const content = document.getElementById('atDetailContent');
      const username = resolveUsername(t.userId) || t.username || 'Unknown';
      const scheduleStr = formatSchedule(t);
      const nextLabel = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'N/A';

      content.innerHTML = '' +
        '<div class="md-detail-header" style="padding:20px 24px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
            '<div class="at-type-icon task" style="width:32px;height:32px;font-size:16px">&#128197;</div>' +
            '<div>' +
              '<div style="font-size:14px;font-weight:600;color:#fff">Scheduled Task</div>' +
              '<div style="font-size:11px;color:#666">' + escapeHtml(username) + '</div>' +
            '</div>' +
            '<span class="detail-badge ' + (t.enabled ? 'enabled' : 'disabled') + '" style="margin-left:auto">' + (t.enabled ? 'Enabled' : 'Disabled') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="md-detail-body">' +
          '<div class="detail-field">' +
            '<div class="detail-label">Title</div>' +
            '<div class="detail-value">' + escapeHtml(t.title) + '</div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="detail-label">Type</div>' +
            '<div class="detail-value"><span class="task-badge ' + (t.enabled ? escapeAttr(t.taskType) : 'disabled') + '">' + escapeHtml(t.taskType) + '</span></div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="detail-label">Schedule</div>' +
            '<div class="detail-value">' + escapeHtml(scheduleStr) + '</div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="detail-label">Next Run</div>' +
            '<div class="detail-value">' + nextLabel + '</div>' +
          '</div>' +
          (t.lastRunAt ? '<div class="detail-field"><div class="detail-label">Last Run</div><div class="detail-value">' + timeAgo(t.lastRunAt) + '</div></div>' : '') +
          (t.prompt ? '<div class="detail-field"><div class="detail-label">Prompt</div><div class="detail-value" style="font-family:monospace;font-size:12px;background:#12121a;padding:8px;border-radius:6px">' + escapeHtml(t.prompt) + '</div></div>' : '') +
          '<div class="detail-field"><div class="detail-label">User</div><div class="detail-value">' + escapeHtml(username) + '</div></div>' +
        '</div>';
    }

    function renderInlineWatcherDetail(w) {
      const content = document.getElementById('atDetailContent');
      const configEntries = Object.entries(w.config || {});
      const configHtml = configEntries.map(([k, v]) =>
        '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a2e"><span style="color:#666">' + escapeHtml(k) + '</span><span style="color:#bbb">' + escapeHtml(String(v)) + '</span></div>'
      ).join('');

      content.innerHTML = '' +
        '<div class="md-detail-header" style="padding:20px 24px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
            '<div class="at-type-icon watcher" style="width:32px;height:32px;font-size:16px">&#128065;</div>' +
            '<div>' +
              '<div style="font-size:14px;font-weight:600;color:#fff">Watcher</div>' +
              '<div style="font-size:11px;color:#666">' + escapeHtml(w.type) + '</div>' +
            '</div>' +
            '<span class="detail-badge ' + (w.enabled ? 'enabled' : 'disabled') + '" style="margin-left:auto">' + (w.enabled ? 'Active' : 'Disabled') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="md-detail-body">' +
          '<div class="detail-field">' +
            '<div class="detail-label">Name</div>' +
            '<div class="detail-value">' + escapeHtml(w.name) + '</div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="detail-label">Type</div>' +
            '<div class="detail-value"><span class="watcher-badge ' + escapeAttr(w.type) + '">' + escapeHtml(w.type) + '</span></div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="detail-label">Interval</div>' +
            '<div class="detail-value">' + formatInterval(w.intervalMs) + '</div>' +
          '</div>' +
          (w.lastRunAt ? '<div class="detail-field"><div class="detail-label">Last Run</div><div class="detail-value">' + timeAgo(w.lastRunAt) + '</div></div>' : '') +
          '<div class="detail-field"><div class="detail-label">Tracked IDs</div><div class="detail-value">' + (w.lastNotifiedIds ? w.lastNotifiedIds.length : 0) + '</div></div>' +
          '<div class="detail-field"><div class="detail-label">Created</div><div class="detail-value">' + new Date(w.createdAt).toLocaleDateString() + '</div></div>' +
          (configHtml ? '<hr class="detail-divider"><div class="detail-field"><div class="detail-label">Configuration</div><div class="detail-value">' + configHtml + '</div></div>' : '') +
          '<hr class="detail-divider">' +
          '<button data-at-watcher-filter="' + escapeAttr(w.name) + '" style="width:100%;padding:8px;background:rgba(108,99,255,0.1);border:1px solid rgba(108,99,255,0.25);border-radius:6px;color:#a5a0ff;cursor:pointer;font-size:12px">View Activity Log</button>' +
        '</div>';
    }

    function setAtFilter(key, value) {
      atFilter[key] = value;
      // Deselect current item when filters change
      selectedAtItem = null;
      document.getElementById('atDetailEmpty').style.display = 'flex';
      document.getElementById('atDetailContent').style.display = 'none';

      // Re-render
      renderAutomationPanel();
    }

    // --- Click handlers for automation panel ---
    document.getElementById('atFilters').addEventListener('click', (e) => {
      const typeEl = e.target.closest('[data-at-type]');
      if (typeEl) { setAtFilter('type', typeEl.dataset.atType); return; }

      const statusEl = e.target.closest('[data-at-status]');
      if (statusEl) { setAtFilter('status', statusEl.dataset.atStatus); return; }
    });

    document.getElementById('atMasterList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-at-select]');
      if (row) {
        const parts = row.dataset.atSelect.split(':');
        selectAtItem(parts[0], parts[1]);
      }
    });

    document.getElementById('atDetailPanel').addEventListener('click', (e) => {
      // Watcher filter button
      const filterBtn = e.target.closest('[data-at-watcher-filter]');
      if (filterBtn) {
        filterFeedByWatcher(filterBtn.dataset.atWatcherFilter);
        return;
      }
    });
  `;
}
