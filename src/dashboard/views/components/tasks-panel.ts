/** Scheduled tasks panel */
export function tasksPanelStyles(): string {
  return `
    .task-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .task-item:hover { background: #ffffff06; }
    .task-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
      margin-top: 2px;
    }
    .task-badge.reminder { background: #1e3a5f; color: #60a5fa; }
    .task-badge.briefing { background: #2a1a3a; color: #c084fc; }
    .task-badge.custom { background: #2a2a1a; color: #facc15; }
    .task-badge.disabled { background: #1a1a1a; color: #555; }
    .task-info { flex: 1; min-width: 0; }
    .task-title { font-size: 13px; color: #ddd; margin-bottom: 4px; }
    .task-schedule { font-size: 11px; color: #555; }
  `;
}

export function tasksPanelHtml(): string {
  return `
      <div class="panel" id="tasksPanel">
        <div class="panel-header">
          Scheduled Tasks <span class="count" id="tasksCount">0</span>
        </div>
        <div class="panel-body" id="tasksList"></div>
      </div>`;
}

export function tasksPanelScript(): string {
  return `
    function renderTasks(tasks) {
      const el = document.getElementById('tasksList');
      document.getElementById('tasksCount').textContent = tasks.length;
      if (!tasks.length) { el.innerHTML = '<div class="panel-empty">No scheduled tasks</div>'; return; }
      el.innerHTML = tasks.map(t => {
        const badgeClass = t.enabled ? escapeAttr(t.taskType) : 'disabled';
        const nextRun = t.nextRunAt ? timeAgo(t.nextRunAt).replace(' ago', '').replace('just now', 'now') : '';
        const nextLabel = t.nextRunAt && t.nextRunAt > Date.now() ? 'next: ' + new Date(t.nextRunAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
        return '<div class="task-item">' +
          '<span class="task-badge ' + badgeClass + '">' + escapeHtml(t.taskType) + '</span>' +
          '<div class="task-info">' +
            '<div class="task-title">' + escapeHtml(t.title) + (!t.enabled ? ' <span style="color:#555">(disabled)</span>' : '') + '</div>' +
            '<div class="task-schedule">' + formatSchedule(t) + (nextLabel ? ' &middot; ' + nextLabel : '') + '</div>' +
          '</div></div>';
      }).join('');
    }
  `;
}
