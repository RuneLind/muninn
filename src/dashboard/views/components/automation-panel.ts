import { DEFAULT_X_PROMPT } from "../../../watchers/x.ts";
import { DEFAULT_EMAIL_PROMPT } from "../../../watchers/email.ts";

/** Automation panel — combined scheduled tasks + watchers master-detail */
export function automationPanelStyles(): string {
  return `
    /* Automation panel filters */
    .at-filters {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-primary);
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
      background: var(--bg-surface);
      color: var(--text-dim);
      border: 1px solid var(--border-secondary);
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
      font-weight: 500;
    }
    .at-pill:hover { color: var(--text-soft); border-color: var(--border-secondary); }
    .at-pill.active {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
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
    .at-type-icon.task { background: var(--tint-info); }
    .at-type-icon.watcher { background: var(--tint-magenta); }

    /* Status dot */
    .at-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .at-status-dot.enabled { background: var(--status-success); }
    .at-status-dot.disabled { background: var(--text-dim); }

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
      color: var(--text-faint);
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
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-soft);
    }
    .at-next-up-item .at-next-time {
      font-size: 11px;
      color: var(--text-dim);
      font-family: monospace;
    }

    /* Detail tabs */
    .at-detail-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border-primary);
      padding: 0 24px;
      flex-shrink: 0;
    }
    .at-detail-tab {
      padding: 8px 14px;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-dim);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }
    .at-detail-tab:hover { color: var(--text-soft); }
    .at-detail-tab.active {
      color: var(--accent-light);
      border-bottom-color: var(--accent);
    }

    /* Run now button */
    .at-run-btn {
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--accent-light);
      cursor: pointer;
      transition: all 0.15s;
      margin-left: auto;
    }
    .at-run-btn:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
    .at-run-btn:disabled { opacity: 0.5; cursor: default; }

    /* Toggle button in header */
    .at-toggle-btn {
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 10px;
      border: 1px solid;
      cursor: pointer;
      transition: all 0.15s;
    }
    .at-toggle-btn.enabled {
      background: color-mix(in srgb, var(--status-success) 15%, transparent);
      border-color: color-mix(in srgb, var(--status-success) 30%, transparent);
      color: var(--status-success);
    }
    .at-toggle-btn.disabled {
      background: var(--bg-surface);
      border-color: var(--border-secondary);
      color: var(--text-dim);
    }
    .at-toggle-btn:hover { opacity: 0.8; }

    /* Embedded activity feed */
    .at-activity-feed {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 16px 24px;
      overflow-y: auto;
      flex: 1;
    }
    .at-activity-event {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      font-size: 12px;
    }
    .at-activity-time {
      color: var(--text-faint);
      font-family: monospace;
      font-size: 10px;
      white-space: nowrap;
      flex-shrink: 0;
      padding-top: 1px;
    }
    .at-activity-text {
      color: var(--text-soft);
      line-height: 1.4;
      word-break: break-word;
    }
    .at-activity-empty {
      padding: 24px;
      text-align: center;
      color: var(--text-faint);
      font-size: 12px;
    }

    /* Edit form */
    .at-edit-form {
      padding: 16px 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
      flex: 1;
    }
    .at-edit-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .at-edit-group label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-faint);
    }
    .at-edit-group input,
    .at-edit-group select,
    .at-edit-group textarea {
      background: var(--bg-inset);
      border: 1px solid var(--border-secondary);
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--text-primary);
      font-size: 12px;
      font-family: inherit;
    }
    .at-edit-group input:focus,
    .at-edit-group select:focus,
    .at-edit-group textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .at-edit-group textarea {
      min-height: 80px;
      resize: vertical;
    }
    .at-edit-row {
      display: flex;
      gap: 10px;
    }
    .at-edit-row .at-edit-group { flex: 1; }
    .at-edit-actions {
      display: flex;
      gap: 8px;
      padding-top: 8px;
    }
    .at-edit-actions button {
      padding: 6px 16px;
      font-size: 12px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
      border: 1px solid;
      transition: all 0.15s;
    }
    .at-save-btn {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--accent-light);
    }
    .at-save-btn:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }
    .at-cancel-btn {
      background: var(--bg-surface);
      border-color: var(--border-secondary);
      color: var(--text-dim);
    }
    .at-edit-msg {
      font-size: 11px;
      padding: 4px 0;
    }
    .at-edit-msg.success { color: var(--status-success); }
    .at-edit-msg.error { color: var(--status-error); }

    /* Days checkbox row */
    .at-days-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .at-day-check {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 11px;
      color: var(--text-soft);
    }
    .at-day-check input { width: 14px; height: 14px; }
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
    function fmtHM(h, m) { return String(h).padStart(2,'0') + ':' + String(m || 0).padStart(2,'0'); }

    let atFilter = { type: 'all', status: 'all' };
    let selectedAtItem = null; // { kind, index }
    let atDetailTab = 'details';

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
      const intervalStr = w.config && w.config.hour != null
        ? 'daily ' + fmtHM(w.config.hour, w.config.minute)
        : formatInterval(w.intervalMs);
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
      atDetailTab = 'details';

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

    // --- Detail tabs ---

    function renderDetailTabs(activeTab) {
      return '<div class="at-detail-tabs">' +
        ['details', 'activity', 'edit'].map(tab =>
          '<span class="at-detail-tab' + (activeTab === tab ? ' active' : '') + '" data-at-tab="' + tab + '">' +
            tab.charAt(0).toUpperCase() + tab.slice(1) +
          '</span>'
        ).join('') +
      '</div>';
    }

    function switchAtTab(tab) {
      atDetailTab = tab;
      if (!selectedAtItem) return;
      if (selectedAtItem.kind === 'task') {
        var t = (tasksData || [])[selectedAtItem.index];
        if (t) renderInlineTaskDetail(t);
      } else {
        var w = (watchersData || [])[selectedAtItem.index];
        if (w) renderInlineWatcherDetail(w);
      }
    }

    // --- Detail header ---

    function renderDetailHeader(icon, iconClass, label, sublabel, item, kind) {
      return '<div class="md-detail-header" style="padding:16px 24px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div class="at-type-icon ' + iconClass + '" style="width:32px;height:32px;font-size:16px">' + icon + '</div>' +
          '<div>' +
            '<div style="font-size:14px;font-weight:600;color:var(--text-primary)">' + escapeHtml(label) + '</div>' +
            '<div style="font-size:11px;color:var(--text-dim)">' + escapeHtml(sublabel) + '</div>' +
          '</div>' +
          '<button class="at-run-btn" data-at-trigger="' + kind + '" title="Run now">&#9654; Run</button>' +
          '<button class="at-toggle-btn ' + (item.enabled ? 'enabled' : 'disabled') + '" data-at-toggle="' + kind + '">' +
            (item.enabled ? 'Enabled' : 'Disabled') +
          '</button>' +
        '</div>' +
      '</div>';
    }

    // --- Task Detail ---

    function renderInlineTaskDetail(t) {
      const content = document.getElementById('atDetailContent');
      const username = resolveUsername(t.userId) || t.username || 'Unknown';

      var body = '';
      if (atDetailTab === 'details') {
        body = renderTaskDetailsTab(t, username);
      } else if (atDetailTab === 'activity') {
        body = '<div class="at-activity-feed" id="atActivityFeed"><div class="at-activity-empty">Loading...</div></div>';
      } else if (atDetailTab === 'edit') {
        body = renderTaskEditTab(t);
      }

      content.innerHTML =
        renderDetailHeader('&#128197;', 'task', t.title, username, t, 'task') +
        renderDetailTabs(atDetailTab) +
        body;

      if (atDetailTab === 'activity') loadJobActivity('task', t);
    }

    function renderTaskDetailsTab(t, username) {
      var scheduleStr = formatSchedule(t);
      var nextLabel = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'N/A';
      var lastLabel = t.lastRunAt ? timeAgo(t.lastRunAt) + ' (' + new Date(t.lastRunAt).toLocaleString() + ')' : 'Never';

      return '<div class="md-detail-body">' +
        '<div class="detail-field"><div class="detail-label">Type</div>' +
          '<div class="detail-value"><span class="task-badge ' + (t.enabled ? escapeAttr(t.taskType) : 'disabled') + '">' + escapeHtml(t.taskType) + '</span></div></div>' +
        '<div class="detail-field"><div class="detail-label">Schedule</div><div class="detail-value">' + escapeHtml(scheduleStr) + '</div></div>' +
        '<div class="detail-field"><div class="detail-label">Next Run</div><div class="detail-value">' + nextLabel + '</div></div>' +
        '<div class="detail-field"><div class="detail-label">Last Run</div><div class="detail-value">' + lastLabel + '</div></div>' +
        (t.prompt ? '<div class="detail-field"><div class="detail-label">Prompt</div><div class="detail-value" style="font-family:monospace;font-size:12px;background:var(--bg-panel);padding:8px;border-radius:6px;white-space:pre-wrap">' + escapeHtml(t.prompt) + '</div></div>' : '') +
        '<div class="detail-field"><div class="detail-label">Timezone</div><div class="detail-value">' + escapeHtml(t.timezone || 'Europe/Oslo') + '</div></div>' +
        '<div class="detail-field"><div class="detail-label">Created</div><div class="detail-value">' + new Date(t.createdAt).toLocaleDateString() + '</div></div>' +
      '</div>';
    }

    function renderTaskEditTab(t) {
      var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var daysHtml = dayNames.map(function(d, i) {
        var checked = !t.scheduleDays || t.scheduleDays.includes(i) ? ' checked' : '';
        return '<label class="at-day-check"><input type="checkbox" name="atEditDay" value="' + i + '"' + checked + '>' + d + '</label>';
      }).join('');

      return '<div class="at-edit-form">' +
        '<div class="at-edit-group"><label>Title</label><input type="text" id="atEditTitle" value="' + escapeAttr(t.title) + '"></div>' +
        (t.scheduleIntervalMs
          ? '<div class="at-edit-group"><label>Interval (minutes)</label><input type="number" id="atEditIntervalMin" value="' + Math.round(t.scheduleIntervalMs / 60000) + '" min="1"></div>'
          : '<div class="at-edit-row">' +
              '<div class="at-edit-group"><label>Hour (0-23)</label><input type="number" id="atEditHour" value="' + t.scheduleHour + '" min="0" max="23"></div>' +
              '<div class="at-edit-group"><label>Minute (0-59)</label><input type="number" id="atEditMinute" value="' + t.scheduleMinute + '" min="0" max="59"></div>' +
            '</div>' +
            '<div class="at-edit-group"><label>Days</label><div class="at-days-row">' + daysHtml + '</div></div>'
        ) +
        '<div class="at-edit-group"><label>Prompt</label><textarea id="atEditPrompt">' + escapeHtml(t.prompt || '') + '</textarea></div>' +
        '<div id="atEditMsg"></div>' +
        '<div class="at-edit-actions">' +
          '<button class="at-save-btn" data-at-save="task">Save</button>' +
          '<button class="at-cancel-btn" data-at-tab="details">Cancel</button>' +
        '</div>' +
      '</div>';
    }

    // --- Watcher Detail ---

    function renderInlineWatcherDetail(w) {
      const content = document.getElementById('atDetailContent');

      var body = '';
      if (atDetailTab === 'details') {
        body = renderWatcherDetailsTab(w);
      } else if (atDetailTab === 'activity') {
        body = '<div class="at-activity-feed" id="atActivityFeed"><div class="at-activity-empty">Loading...</div></div>';
      } else if (atDetailTab === 'edit') {
        body = renderWatcherEditTab(w);
      }

      content.innerHTML =
        renderDetailHeader('&#128065;', 'watcher', w.name, w.type, w, 'watcher') +
        renderDetailTabs(atDetailTab) +
        body;

      if (atDetailTab === 'activity') loadJobActivity('watcher', w);
    }

    var WATCHER_DEFAULT_PROMPTS = {
      x: ${JSON.stringify(DEFAULT_X_PROMPT)},
      email: ${JSON.stringify(DEFAULT_EMAIL_PROMPT)},
      news: '',
    };

    function getWatcherPrompt(w) {
      return (w.config && w.config.prompt) || WATCHER_DEFAULT_PROMPTS[w.type] || '';
    }

    function renderWatcherDetailsTab(w) {
      // Filter out prompt/hour/minute from config display (shown as dedicated fields)
      var configEntries = Object.entries(w.config || {}).filter(function(entry) {
        return entry[0] !== 'prompt' && entry[0] !== 'hour' && entry[0] !== 'minute';
      });
      var configHtml = configEntries.map(function(entry) {
        return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--bg-surface)"><span style="color:var(--text-dim)">' + escapeHtml(entry[0]) + '</span><span style="color:var(--text-soft)">' + escapeHtml(String(entry[1])) + '</span></div>';
      }).join('');

      var hasSchedule = w.config && w.config.hour != null;
      var intervalLabel = hasSchedule
        ? 'Daily at ' + fmtHM(w.config.hour, w.config.minute)
        : formatInterval(w.intervalMs);
      var nextRun = w.lastRunAt
        ? new Date(w.lastRunAt + w.intervalMs).toLocaleString()
        : 'Pending';
      var lastLabel = w.lastRunAt ? timeAgo(w.lastRunAt) + ' (' + new Date(w.lastRunAt).toLocaleString() + ')' : 'Never';

      // Warn if interval < 24h but time-of-day is set (time-of-day wins)
      var conflictWarning = '';
      if (hasSchedule && w.intervalMs < 86400000) {
        conflictWarning = '<div style="margin-top:8px;padding:8px 10px;background:color-mix(in srgb, var(--status-warning) 10%, transparent);border:1px solid color-mix(in srgb, var(--status-warning) 25%, transparent);border-radius:6px;font-size:11px;color:var(--status-warning)">' +
          'Run-at time (' + fmtHM(w.config.hour, w.config.minute) + ') overrides the ' + formatInterval(w.intervalMs) + ' interval. This watcher runs once daily. Clear the run-at time in Edit to use the interval instead.' +
        '</div>';
      }

      var prompt = getWatcherPrompt(w);
      var isDefault = !(w.config && w.config.prompt);
      var promptHtml = prompt
        ? '<div class="detail-field"><div class="detail-label">Prompt' + (isDefault ? ' <span style="opacity:0.5">(default)</span>' : '') + '</div><div class="detail-value" style="font-family:monospace;font-size:12px;background:var(--bg-panel);padding:8px;border-radius:6px;white-space:pre-wrap">' + escapeHtml(prompt) + '</div></div>'
        : '';

      return '<div class="md-detail-body">' +
        '<div class="detail-field"><div class="detail-label">Type</div>' +
          '<div class="detail-value"><span class="watcher-badge ' + escapeAttr(w.type) + '">' + escapeHtml(w.type) + '</span></div></div>' +
        '<div class="detail-field"><div class="detail-label">Schedule</div><div class="detail-value">' + intervalLabel + '</div></div>' +
        '<div class="detail-field"><div class="detail-label">Next Run</div><div class="detail-value">' + nextRun + '</div></div>' +
        '<div class="detail-field"><div class="detail-label">Last Run</div><div class="detail-value">' + lastLabel + '</div></div>' +
        promptHtml +
        '<div class="detail-field"><div class="detail-label">Tracked IDs</div><div class="detail-value">' + (w.lastNotifiedIds ? w.lastNotifiedIds.length : 0) + '</div></div>' +
        '<div class="detail-field"><div class="detail-label">Created</div><div class="detail-value">' + new Date(w.createdAt).toLocaleDateString() + '</div></div>' +
        conflictWarning +
        (configHtml.length ? '<hr class="detail-divider"><div class="detail-field"><div class="detail-label">Configuration</div><div class="detail-value">' + configHtml + '</div></div>' : '') +
      '</div>';
    }

    function renderWatcherEditTab(w) {
      var hasSchedule = w.config && w.config.hour != null;
      var intervalMin = Math.round(w.intervalMs / 60000);

      var scheduleHint = hasSchedule
        ? '<div style="font-size:10px;color:var(--status-warning);margin-top:4px">Run-at time overrides interval (runs once daily). Clear hour to use interval instead.</div>'
        : '<div style="font-size:10px;color:var(--text-faint);margin-top:4px">Set run-at time for daily scheduling, or leave empty to use interval.</div>';

      return '<div class="at-edit-form">' +
        '<div class="at-edit-group"><label>Name</label><input type="text" id="atEditName" value="' + escapeAttr(w.name) + '"></div>' +
        '<div class="at-edit-row">' +
          '<div class="at-edit-group"><label>Interval (minutes)</label><input type="number" id="atEditIntervalMin" value="' + intervalMin + '" min="1"></div>' +
        '</div>' +
        '<div class="at-edit-row">' +
          '<div class="at-edit-group"><label>Run at hour (0-23, optional)</label><input type="number" id="atEditHour" value="' + (hasSchedule ? w.config.hour : '') + '" min="0" max="23" placeholder="—"></div>' +
          '<div class="at-edit-group"><label>Run at minute</label><input type="number" id="atEditMinute" value="' + (hasSchedule ? (w.config.minute || 0) : '') + '" min="0" max="59" placeholder="0"></div>' +
        '</div>' +
        scheduleHint +
        (w.config && w.config.filter != null ? '<div class="at-edit-group"><label>Filter</label><input type="text" id="atEditFilter" value="' + escapeAttr(w.config.filter || '') + '"></div>' : '') +
        '<div class="at-edit-group"><label>Prompt</label><textarea id="atEditPrompt">' + escapeHtml(getWatcherPrompt(w)) + '</textarea></div>' +
        '<div id="atEditMsg"></div>' +
        '<div class="at-edit-actions">' +
          '<button class="at-save-btn" data-at-save="watcher">Save</button>' +
          '<button class="at-cancel-btn" data-at-tab="details">Cancel</button>' +
        '</div>' +
      '</div>';
    }

    // --- Activity feed loading ---

    async function loadJobActivity(kind, item) {
      var el = document.getElementById('atActivityFeed');
      if (!el) return;
      try {
        var url = '/api/activity/job/' + item.id + '?name=' + encodeURIComponent(item.name || item.title) + '&limit=30';
        var res = await fetch(url);
        var data = await res.json();
        if (!data.events || !data.events.length) {
          el.innerHTML = '<div class="at-activity-empty">No activity recorded yet</div>';
          return;
        }
        el.innerHTML = data.events.map(function(ev) {
          return '<div class="at-activity-event">' +
            '<span class="at-activity-time">' + formatTime(ev.timestamp) + '</span>' +
            '<span class="at-activity-text">' + escapeHtml(ev.text) + '</span>' +
          '</div>';
        }).join('');
      } catch (err) {
        el.innerHTML = '<div class="at-activity-empty">Failed to load activity</div>';
      }
    }

    // --- Save handlers ---

    async function saveWatcherEdit(w) {
      var msgEl = document.getElementById('atEditMsg');
      var body = {};
      var nameVal = document.getElementById('atEditName');
      if (nameVal) body.name = nameVal.value;
      var intVal = document.getElementById('atEditIntervalMin');
      if (intVal && intVal.value) body.intervalMs = parseInt(intVal.value, 10) * 60000;
      var hourVal = document.getElementById('atEditHour');
      var minVal = document.getElementById('atEditMinute');
      var config = Object.assign({}, w.config || {});
      if (hourVal && hourVal.value !== '') {
        config.hour = parseInt(hourVal.value, 10);
        config.minute = minVal && minVal.value !== '' ? parseInt(minVal.value, 10) : 0;
      } else {
        delete config.hour;
        delete config.minute;
      }
      var filterVal = document.getElementById('atEditFilter');
      if (filterVal) config.filter = filterVal.value || undefined;
      var promptVal = document.getElementById('atEditPrompt');
      if (promptVal) config.prompt = promptVal.value || undefined;
      body.config = config;

      try {
        var res = await fetch('/api/watchers/' + w.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var data = await res.json();
        if (!res.ok) { msgEl.innerHTML = '<div class="at-edit-msg error">' + escapeHtml(data.error || 'Failed') + '</div>'; return; }
        // Update local data
        var idx = watchersData.findIndex(function(x) { return x.id === w.id; });
        if (idx >= 0) watchersData[idx] = data.watcher;
        msgEl.innerHTML = '<div class="at-edit-msg success">Saved</div>';
        renderAtCombinedList();
        setTimeout(function() { atDetailTab = 'details'; selectAtItem('watcher', idx >= 0 ? idx : selectedAtItem.index); }, 600);
      } catch (err) {
        msgEl.innerHTML = '<div class="at-edit-msg error">Network error</div>';
      }
    }

    async function saveTaskEdit(t) {
      var msgEl = document.getElementById('atEditMsg');
      var body = {};
      var titleVal = document.getElementById('atEditTitle');
      if (titleVal) body.title = titleVal.value;
      var intVal = document.getElementById('atEditIntervalMin');
      if (intVal) body.scheduleIntervalMs = parseInt(intVal.value, 10) * 60000;
      var hourVal = document.getElementById('atEditHour');
      if (hourVal) body.scheduleHour = parseInt(hourVal.value, 10);
      var minVal = document.getElementById('atEditMinute');
      if (minVal) body.scheduleMinute = parseInt(minVal.value, 10);
      var promptVal = document.getElementById('atEditPrompt');
      if (promptVal) body.prompt = promptVal.value || null;
      // Days
      var dayChecks = document.querySelectorAll('input[name="atEditDay"]');
      if (dayChecks.length) {
        var days = [];
        dayChecks.forEach(function(cb) { if (cb.checked) days.push(parseInt(cb.value, 10)); });
        body.scheduleDays = days.length === 7 ? null : days;
      }

      try {
        var res = await fetch('/api/tasks/' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var data = await res.json();
        if (!res.ok) { msgEl.innerHTML = '<div class="at-edit-msg error">' + escapeHtml(data.error || 'Failed') + '</div>'; return; }
        var idx = tasksData.findIndex(function(x) { return x.id === t.id; });
        if (idx >= 0) tasksData[idx] = data.task;
        msgEl.innerHTML = '<div class="at-edit-msg success">Saved</div>';
        renderAtCombinedList();
        setTimeout(function() { atDetailTab = 'details'; selectAtItem('task', idx >= 0 ? idx : selectedAtItem.index); }, 600);
      } catch (err) {
        msgEl.innerHTML = '<div class="at-edit-msg error">Network error</div>';
      }
    }

    // --- Toggle enabled/disabled ---

    async function toggleAtItem(kind) {
      if (!selectedAtItem) return;
      var item = kind === 'watcher'
        ? (watchersData || [])[selectedAtItem.index]
        : (tasksData || [])[selectedAtItem.index];
      if (!item) return;
      var url = '/api/' + (kind === 'watcher' ? 'watchers' : 'tasks') + '/' + item.id;
      try {
        var res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !item.enabled }) });
        var data = await res.json();
        if (res.ok) {
          var updated = data.watcher || data.task;
          if (kind === 'watcher') {
            var idx = watchersData.findIndex(function(x) { return x.id === item.id; });
            if (idx >= 0) watchersData[idx] = updated;
          } else {
            var idx = tasksData.findIndex(function(x) { return x.id === item.id; });
            if (idx >= 0) tasksData[idx] = updated;
          }
          renderAtCombinedList();
          selectAtItem(kind, selectedAtItem.index);
        }
      } catch (err) { /* ignore */ }
    }

    // --- Trigger manual run ---

    async function triggerAtItem(kind, btn) {
      if (!selectedAtItem) return;
      var item = kind === 'watcher'
        ? (watchersData || [])[selectedAtItem.index]
        : (tasksData || [])[selectedAtItem.index];
      if (!item) return;
      var url = '/api/' + (kind === 'watcher' ? 'watchers' : 'tasks') + '/' + item.id + '/trigger';
      btn.disabled = true;
      btn.textContent = 'Running...';
      try {
        var res = await fetch(url, { method: 'POST' });
        if (res.ok) {
          btn.textContent = '✓ Done';
          // Refresh activity tab if visible
          if (atDetailTab === 'activity') loadJobActivity(kind, item);
          // Refresh data to get updated lastRunAt
          try {
            var refreshRes = await fetch('/api/' + (kind === 'watcher' ? 'watchers' : 'tasks'));
            var refreshData = await refreshRes.json();
            if (kind === 'watcher') { watchersData = refreshData.watchers; }
            else { tasksData = refreshData.tasks; }
            renderAtCombinedList();
          } catch (e) {}
        } else {
          var errData = await res.json().catch(function() { return {}; });
          btn.textContent = errData.error || 'Failed';
        }
      } catch (err) {
        btn.textContent = 'Error';
      }
      setTimeout(function() { btn.disabled = false; btn.innerHTML = '&#9654; Run'; }, 3000);
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
      // Tab switching
      var tabEl = e.target.closest('[data-at-tab]');
      if (tabEl) { switchAtTab(tabEl.dataset.atTab); return; }

      // Trigger manual run
      var triggerEl = e.target.closest('[data-at-trigger]');
      if (triggerEl) { triggerAtItem(triggerEl.dataset.atTrigger, triggerEl); return; }

      // Toggle enabled/disabled
      var toggleEl = e.target.closest('[data-at-toggle]');
      if (toggleEl) { toggleAtItem(toggleEl.dataset.atToggle); return; }

      // Save buttons
      var saveEl = e.target.closest('[data-at-save]');
      if (saveEl) {
        if (saveEl.dataset.atSave === 'watcher') {
          var w = (watchersData || [])[selectedAtItem.index];
          if (w) saveWatcherEdit(w);
        } else {
          var t = (tasksData || [])[selectedAtItem.index];
          if (t) saveTaskEdit(t);
        }
        return;
      }

      // Legacy watcher filter (keep for backward compat)
      var filterBtn = e.target.closest('[data-at-watcher-filter]');
      if (filterBtn) {
        filterFeedByWatcher(filterBtn.dataset.atWatcherFilter);
        return;
      }
    });
  `;
}
