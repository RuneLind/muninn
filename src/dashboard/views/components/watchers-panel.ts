/** Watchers panel — proactive monitors with detail popover + feed filter */
export function watchersPanelStyles(): string {
  return `
    .watcher-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      transition: background 0.15s;
      cursor: pointer;
      position: relative;
    }
    .watcher-item:hover { background: #ffffff06; }
    .watcher-item.active { background: rgba(108, 99, 255, 0.08); border: 1px solid rgba(108, 99, 255, 0.2); margin: -1px; }
    .watcher-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
      margin-top: 2px;
    }
    .watcher-badge.email { background: #1e3a5f; color: #60a5fa; }
    .watcher-badge.calendar { background: #2a1a3a; color: #c084fc; }
    .watcher-badge.github { background: #1a2a1a; color: #4ade80; }
    .watcher-badge.news { background: #2a2a1a; color: #facc15; }
    .watcher-badge.disabled { background: #1a1a1a; color: #555; }
    .watcher-info { flex: 1; min-width: 0; }
    .watcher-title { font-size: 13px; color: #ddd; margin-bottom: 4px; }
    .watcher-meta { font-size: 11px; color: #555; }

    /* Watcher detail popover */
    .watcher-detail {
      display: none;
      margin-top: 8px;
      padding: 10px 12px;
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      border-radius: 6px;
      font-size: 12px;
      color: #999;
      line-height: 1.8;
    }
    .watcher-item:hover .watcher-detail { display: block; }
    .watcher-detail .detail-row { display: flex; justify-content: space-between; gap: 16px; }
    .watcher-detail .detail-label { color: #666; }
    .watcher-detail .detail-value { color: #bbb; text-align: right; }
    .watcher-view-log {
      display: inline-block;
      margin-top: 6px;
      padding: 3px 10px;
      background: rgba(108, 99, 255, 0.1);
      border: 1px solid rgba(108, 99, 255, 0.25);
      border-radius: 4px;
      color: #a5a0ff;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .watcher-view-log:hover { background: rgba(108, 99, 255, 0.2); color: #c5c0ff; }

    /* Feed filter mode */
    .feed-filter-bar {
      display: none;
      padding: 8px 12px;
      background: rgba(108, 99, 255, 0.08);
      border-bottom: 1px solid rgba(108, 99, 255, 0.15);
      font-size: 12px;
      color: #a5a0ff;
      align-items: center;
      justify-content: space-between;
    }
    .feed-filter-bar.visible { display: flex; }
    .feed-filter-clear {
      background: none;
      border: 1px solid rgba(108, 99, 255, 0.25);
      color: #a5a0ff;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .feed-filter-clear:hover { background: rgba(108, 99, 255, 0.15); }
    .event.feed-dim { opacity: 0.15; }
  `;
}

export function watchersPanelHtml(): string {
  return `
      <div class="panel" id="watchersPanel">
        <div class="panel-header">
          Watchers <span class="count" id="watchersCount">0</span>
          <span id="watcherTokensBadge" style="font-size:10px;color:#facc15;font-weight:400;text-transform:none;letter-spacing:0"></span>
        </div>
        <div class="panel-body" id="watchersList"></div>
      </div>`;
}

export function watchersPanelScript(): string {
  return `
    function formatInterval(ms) {
      const mins = Math.round(ms / 60000);
      if (mins < 60) return 'every ' + mins + 'min';
      const hrs = mins / 60;
      if (hrs < 24) return 'every ' + hrs.toFixed(hrs % 1 ? 1 : 0) + 'h';
      return 'every ' + (hrs / 24).toFixed(0) + 'd';
    }

    function formatDate(ts) {
      return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function renderWatchers(watchers) {
      const el = document.getElementById('watchersList');
      document.getElementById('watchersCount').textContent = watchers.length;
      if (!watchers.length) { el.innerHTML = '<div class="panel-empty">No watchers configured</div>'; return; }
      el.innerHTML = watchers.map(w => {
        const badgeClass = w.enabled ? escapeAttr(w.type) : 'disabled';
        const lastRun = w.lastRunAt ? 'ran ' + timeAgo(w.lastRunAt) : 'never ran';
        const filter = w.config && w.config.filter ? ' &middot; ' + escapeHtml(String(w.config.filter)) : '';
        const configEntries = Object.entries(w.config || {});
        const configRows = configEntries.map(([k, v]) =>
          '<div class="detail-row"><span class="detail-label">' + escapeHtml(k) + '</span><span class="detail-value">' + escapeHtml(String(v)) + '</span></div>'
        ).join('');
        return '<div class="watcher-item" data-watcher-name="' + escapeAttr(w.name) + '">' +
          '<span class="watcher-badge ' + badgeClass + '">' + escapeHtml(w.type) + '</span>' +
          '<div class="watcher-info">' +
            '<div class="watcher-title">' + escapeHtml(w.name) + (!w.enabled ? ' <span style="color:#555">(disabled)</span>' : '') + '</div>' +
            '<div class="watcher-meta">' + formatInterval(w.intervalMs) + ' &middot; ' + lastRun + filter + '</div>' +
            '<div class="watcher-detail">' +
              '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' + (w.enabled ? '<span style="color:#4ade80">Active</span>' : '<span style="color:#666">Disabled</span>') + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">' + escapeHtml(w.type) + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Interval</span><span class="detail-value">' + formatInterval(w.intervalMs) + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Last run</span><span class="detail-value">' + (w.lastRunAt ? timeAgo(w.lastRunAt) : 'Never') + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Tracked IDs</span><span class="detail-value">' + (w.lastNotifiedIds ? w.lastNotifiedIds.length : 0) + '</span></div>' +
              '<div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">' + formatDate(w.createdAt) + '</span></div>' +
              configRows +
              '<span class="watcher-view-log" data-filter-watcher="' + escapeAttr(w.name) + '">View activity log</span>' +
            '</div>' +
          '</div></div>';
      }).join('');
    }

    // --- Feed Filter ---
    let currentFeedFilter = null;

    function filterFeedByWatcher(name) {
      currentFeedFilter = name;
      document.getElementById('feedFilterBar').classList.add('visible');
      document.getElementById('feedFilterLabel').textContent = 'Showing: Watcher "' + name + '"';

      document.querySelectorAll('.watcher-item').forEach(el => {
        el.classList.toggle('active', el.dataset.watcherName === name);
      });

      const feedEl = document.getElementById('feed');
      for (const child of feedEl.children) {
        const text = child.querySelector('.event-text');
        if (text && text.textContent.includes('Watcher "' + name + '"')) {
          child.classList.remove('feed-dim', 'feed-hidden');
        } else {
          child.classList.add('feed-dim');
        }
      }

      feedExpanded = true;
      document.getElementById('feedShowMore').style.display = 'none';

      document.querySelector('.feed-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function clearFeedFilter() {
      if (slackUserFilterActive) {
        clearSlackUserFilter();
        return;
      }

      currentFeedFilter = null;
      document.getElementById('feedFilterBar').classList.remove('visible');
      document.querySelectorAll('.watcher-item').forEach(el => el.classList.remove('active'));

      const feedEl = document.getElementById('feed');
      for (const child of feedEl.children) {
        child.classList.remove('feed-dim');
      }

      feedExpanded = false;
      updateFeedVisibility();
    }
  `;
}
