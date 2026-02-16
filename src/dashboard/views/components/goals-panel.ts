/** Goals panel — active/completed goals list */
export function goalsPanelStyles(): string {
  return `
    .goal-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
    }
    .goal-item:hover { background: #ffffff06; }
    .goal-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
    }
    .goal-dot.active { background: #4ade80; }
    .goal-dot.completed { background: #6c63ff; }
    .goal-dot.cancelled { background: #666; }
    .goal-info { flex: 1; min-width: 0; }
    .goal-title { font-size: 13px; color: #ddd; margin-bottom: 4px; }
    .goal-item.done .goal-title { text-decoration: line-through; color: #555; }
    .goal-item.done { opacity: 0.5; }
    .goal-meta { font-size: 11px; color: #555; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  `;
}

export function goalsPanelHtml(): string {
  return `
      <div class="panel" id="goalsPanel">
        <div class="panel-header">
          Goals <span class="count" id="goalsCount">0</span>
        </div>
        <div class="panel-body" id="goalsList"></div>
      </div>`;
}

export function goalsPanelScript(): string {
  return `
    function renderGoals(goals) {
      const el = document.getElementById('goalsList');
      document.getElementById('goalsCount').textContent = goals.length;
      if (!goals.length) { el.innerHTML = '<div class="panel-empty">No goals yet</div>'; return; }
      el.innerHTML = goals.map(g => {
        const isDone = g.status === 'completed' || g.status === 'cancelled';
        const tags = (g.tags || []).map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join('');
        const dl = g.deadline && !isDone ? '<span>' + deadlineText(g.deadline) + '</span>' : '';
        const statusLabel = isDone ? '<span>' + escapeHtml(g.status) + '</span>' : '';
        return '<div class="goal-item' + (isDone ? ' done' : '') + '">' +
          '<div class="goal-dot ' + escapeAttr(g.status) + '"></div>' +
          '<div class="goal-info">' +
            '<div class="goal-title">' + escapeHtml(g.title) + '</div>' +
            '<div class="goal-meta">' + statusLabel + dl + tags + '</div>' +
          '</div></div>';
      }).join('');
    }
  `;
}
