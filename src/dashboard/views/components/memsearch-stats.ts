/** MemSearch stats bar — 4 stat cards at the top of the page */

export function memsearchStatsStyles(): string {
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

export function memsearchStatsHtml(): string {
  return `
  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statTotal">-</div><div class="stat-label">Total Memories</div></div>
    <div class="stat-card"><div class="stat-value" id="statEmbedded">-</div><div class="stat-label">With Embeddings</div></div>
    <div class="stat-card"><div class="stat-value" id="statUsers">-</div><div class="stat-label">Users</div></div>
    <div class="stat-card"><div class="stat-value" id="statTags">-</div><div class="stat-label">Unique Tags</div></div>
  </div>`;
}

export function memsearchStatsScript(): string {
  return `
    // Load stats and bot filter
    async function loadStats() {
      try {
        const res = await fetch('/api/memsearch-stats');
        const stats = await res.json();
        document.getElementById('statTotal').textContent = stats.totalMemories;
        document.getElementById('statEmbedded').textContent = stats.withEmbeddings;
        document.getElementById('statUsers').textContent = stats.uniqueUsers;
        document.getElementById('statTags').textContent = stats.uniqueTags;
      } catch (e) { console.error('Failed to load search stats', e); }
    }
  `;
}
