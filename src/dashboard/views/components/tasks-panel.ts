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
    .task-badge.reminder { background: #1e3a5f; color: #60a5fa; }
    .task-badge.briefing { background: #2a1a3a; color: #c084fc; }
    .task-badge.custom { background: #2a2a1a; color: #facc15; }
    .task-badge.disabled { background: #1a1a1a; color: #555; }
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
