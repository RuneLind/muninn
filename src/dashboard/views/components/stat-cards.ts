/** Stats bar — 6 metric cards at the top of the dashboard */
export function statCardsStyles(): string {
  return `
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      padding: 16px 24px;
      background: #0a0a0f;
    }
    .stat-card {
      background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: box-shadow 0.2s;
    }
    .stat-card:hover {
      box-shadow: 0 0 20px rgba(108, 99, 255, 0.15);
    }
    .stat-icon { font-size: 18px; margin-bottom: 4px; }
    .stat-value { color: #fff; font-weight: 700; font-size: 24px; line-height: 1; }
    .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  `;
}

export function statCardsHtml(): string {
  return `
  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-icon">💬</div>
      <div class="stat-value" id="statMsgsToday">-</div>
      <div class="stat-label">Messages Today</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📊</div>
      <div class="stat-value" id="statTotalMsgs">-</div>
      <div class="stat-label">Total Messages</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🧠</div>
      <div class="stat-value" id="statMemories">-</div>
      <div class="stat-label">Memories</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🎯</div>
      <div class="stat-value" id="statGoals">-</div>
      <div class="stat-label">Active Goals</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">⏰</div>
      <div class="stat-value" id="statTasks">-</div>
      <div class="stat-label">Scheduled Tasks</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🔢</div>
      <div class="stat-value" id="statTokens">-</div>
      <div class="stat-label">Total Tokens</div>
    </div>
  </div>`;
}

export function statCardsScript(): string {
  return `
    function updateStatCards(stats) {
      document.getElementById('statMsgsToday').textContent = stats.messagesToday;
      document.getElementById('statTotalMsgs').textContent = stats.totalMessages;
      document.getElementById('statMemories').textContent = stats.memoriesCount;
      document.getElementById('statGoals').textContent = stats.activeGoalsCount;
      document.getElementById('statTasks').textContent = stats.scheduledTasksCount;
      document.getElementById('statTokens').textContent = fmtTokens(stats.totalTokens);

      const wb = document.getElementById('watcherTokensBadge');
      if (wb && stats.watcherTokensToday > 0) {
        wb.textContent = fmtTokens(stats.watcherTokensToday) + ' tok today';
      } else if (wb && stats.watcherTokensTotal > 0) {
        wb.textContent = fmtTokens(stats.watcherTokensTotal) + ' tok total';
      } else if (wb) {
        wb.textContent = '';
      }
    }
  `;
}
