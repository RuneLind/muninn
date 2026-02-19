/** Scheduled tasks panel — data setter only (rendering handled by automation-panel.ts) */
export function tasksPanelStyles(): string {
  return `
    .task-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .task-badge.reminder { background: var(--tint-info); color: var(--status-info); }
    .task-badge.briefing { background: var(--tint-magenta); color: var(--status-magenta); }
    .task-badge.custom { background: var(--tint-warning); color: var(--status-warning); }
    .task-badge.disabled { background: var(--tint-neutral); color: var(--text-faint); }
  `;
}

export function tasksPanelHtml(): string {
  return ``;
}

export function tasksPanelScript(): string {
  return `
    let tasksData = [];

    function renderTasks(tasks) {
      tasksData = tasks;
    }
  `;
}
