/** Watchers panel — data setter only (rendering handled by automation-panel.ts) + feed filter */
export function watchersPanelStyles(): string {
  return `
    .watcher-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .watcher-badge.email { background: #1e3a5f; color: #60a5fa; }
    .watcher-badge.calendar { background: #2a1a3a; color: #c084fc; }
    .watcher-badge.github { background: #1a2a1a; color: #4ade80; }
    .watcher-badge.news { background: #2a2a1a; color: #facc15; }
    .watcher-badge.disabled { background: #1a1a1a; color: #555; }
  `;
}

export function watchersPanelHtml(): string {
  return ``;
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
    }

    // --- Feed Filter ---
    let currentFeedFilter = null;

    function filterFeedByWatcher(name) {
      currentFeedFilter = name;
      document.getElementById('feedFilterBar').classList.add('visible');
      document.getElementById('feedFilterLabel').textContent = 'Showing: Watcher "' + name + '"';

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

      const feedEl = document.getElementById('feed');
      for (const child of feedEl.children) {
        child.classList.remove('feed-dim');
      }
    }
  `;
}
