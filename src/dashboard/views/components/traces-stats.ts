/** Traces stats bar — 4 stat cards showing 24h summary */
export function tracesStatsStyles(): string {
  return `
    /* Stats Bar */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      padding: 16px 24px;
    }
    .stat-card {
      background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-gradient-end) 100%);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
    }
    .stat-value { color: var(--text-primary); font-weight: 700; font-size: 24px; }
    .stat-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  `;
}

export function tracesStatsHtml(): string {
  return `
  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Traces (24h)</div></div>
    <div class="stat-card"><div class="stat-value" id="statAvg">-</div><div class="stat-label">Avg Duration</div></div>
    <div class="stat-card"><div class="stat-value" id="statErrors">-</div><div class="stat-label">Errors (24h)</div></div>
    <div class="stat-card"><div class="stat-value" id="statByName">-</div><div class="stat-label">Trace Types</div></div>
  </div>`;
}

export function tracesStatsScript(): string {
  return `
    async function loadStats() {
      try {
        const bot = selectedBot;
        const params = bot ? '?bot=' + bot : '';
        const res = await fetch('/api/trace-stats' + params);
        const stats = await res.json();
        document.getElementById('statTotal').textContent = stats.totalTraces;
        document.getElementById('statAvg').textContent = fmtDuration(stats.avgDurationMs);
        document.getElementById('statErrors').textContent = stats.errorCount;
        const types = Object.keys(stats.byName || {}).length;
        document.getElementById('statByName').textContent = types;
      } catch (e) { console.error('Failed to load stats', e); }
    }
  `;
}
