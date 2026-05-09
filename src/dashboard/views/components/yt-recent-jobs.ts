/** YouTube page — Recent summaries list */

export function ytRecentJobsStyles(): string {
  return `
    .recent-section {
      margin-top: 32px;
    }
    .recent-section h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px;
    }
    .recent-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .recent-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      text-decoration: none;
    }
    .recent-item:hover { border-color: var(--accent); }
    .recent-item-title {
      flex: 1;
      font-size: 14px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .recent-item-time {
      font-size: 12px;
      color: var(--text-dim);
      white-space: nowrap;
    }
  `;
}

export function ytRecentJobsHtml(): string {
  return `
    <div class="recent-section" id="recentSection">
      <h2>Recent Summaries</h2>
      <div class="recent-list" id="recentList">
        <div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">Loading...</div>
      </div>
    </div>`;
}

export function ytRecentJobsScript(): string {
  return `
    async function loadRecentJobs() {
      try {
        var res = await fetch('/api/youtube/jobs?limit=20');
        var data = await res.json();
        var list = document.getElementById('recentList');
        if (!data.jobs || data.jobs.length === 0) {
          list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">No summaries yet. Paste a YouTube URL above to get started.</div>';
          return;
        }
        list.innerHTML = data.jobs.map(function(job) {
          return '<a class="recent-item" href="/youtube?job=' + esc(job.id) + '">' +
            '<span class="status-badge status-' + job.status + '" style="font-size:10px;padding:2px 8px;">' +
              esc(STATUS_LABELS[job.status] || job.status) +
            '</span>' +
            '<span class="recent-item-title">' + esc(job.title || job.url || job.videoId) + '</span>' +
            (job.category ? '<span class="category-badge">' + esc(job.category) + '</span>' : '') +
            '<span class="recent-item-time">' + timeAgo(job.createdAt) + '</span>' +
          '</a>';
        }).join('');
      } catch (err) {
        console.error('loadRecentJobs failed:', err);
      }
    }
  `;
}
