/** Watchers panel — proactive monitors with tooltip + detail panel + feed filter */
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
    let watchersData = [];

    function formatInterval(ms) {
      const mins = Math.round(ms / 60000);
      if (mins < 60) return 'every ' + mins + 'min';
      const hrs = mins / 60;
      if (hrs < 24) return 'every ' + hrs.toFixed(hrs % 1 ? 1 : 0) + 'h';
      return 'every ' + (hrs / 24).toFixed(0) + 'd';
    }

    function renderWatchers(watchers) {
      watchersData = watchers;
      const el = document.getElementById('watchersList');
      document.getElementById('watchersCount').textContent = watchers.length;
      if (!watchers.length) { el.innerHTML = '<div class="panel-empty">No watchers configured</div>'; return; }
      el.innerHTML = watchers.map((w, i) => {
        const badgeClass = w.enabled ? escapeAttr(w.type) : 'disabled';
        const lastRun = w.lastRunAt ? 'ran ' + timeAgo(w.lastRunAt) : 'never ran';
        const filter = w.config && w.config.filter ? ' &middot; ' + escapeHtml(String(w.config.filter)) : '';
        const intervalStr = formatInterval(w.intervalMs);
        const tipData = JSON.stringify({ type: 'watcher', watcherType: w.type, interval: intervalStr, lastRun: w.lastRunAt ? timeAgo(w.lastRunAt) : 'Never' });
        return '<div class="watcher-item" data-watcher-name="' + escapeAttr(w.name) + '" data-tip=\\'' + escapeAttr(tipData) + '\\' data-detail-type="watcher" data-detail-index="' + i + '">' +
          '<span class="watcher-badge ' + badgeClass + '">' + escapeHtml(w.type) + '</span>' +
          '<div class="watcher-info">' +
            '<div class="watcher-title">' + escapeHtml(w.name) + (!w.enabled ? ' <span style="color:#555">(disabled)</span>' : '') + '</div>' +
            '<div class="watcher-meta">' + intervalStr + ' &middot; ' + lastRun + filter + '</div>' +
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
          child.classList.remove('feed-dim');
        } else {
          child.classList.add('feed-dim');
        }
      }

      expandActivityDrawer();
    }

    function clearFeedFilter() {
      currentFeedFilter = null;
      document.getElementById('feedFilterBar').classList.remove('visible');
      document.querySelectorAll('.watcher-item').forEach(el => el.classList.remove('active'));

      const feedEl = document.getElementById('feed');
      for (const child of feedEl.children) {
        child.classList.remove('feed-dim');
      }
    }
  `;
}
