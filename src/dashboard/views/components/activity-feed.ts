/** Activity feed — fixed bottom drawer with collapsed/expanded states */
export function activityFeedStyles(): string {
  return `
    /* Activity Drawer */
    .activity-drawer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 50;
      background: #0f0f17;
      border-top: 1px solid #1e1e2e;
      transition: height 0.3s ease;
      display: flex;
      flex-direction: column;
    }
    .activity-drawer.collapsed {
      height: 44px;
    }
    .activity-drawer.expanded {
      height: 40vh;
    }

    .drawer-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      height: 44px;
      min-height: 44px;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .drawer-bar:hover {
      background: #ffffff04;
    }
    .drawer-bar-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .drawer-title {
      font-size: 12px;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .drawer-new-count {
      display: none;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(108, 99, 255, 0.2);
      color: #a5a0ff;
      font-weight: 500;
    }
    .drawer-new-count.has-new { display: inline-block; }
    .drawer-toggle {
      background: none;
      border: 1px solid #2a2a3a;
      color: #666;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      transition: all 0.15s;
    }
    .drawer-toggle:hover {
      border-color: #6c63ff;
      color: #ccc;
    }

    .drawer-content {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .activity-drawer.collapsed .drawer-content {
      display: none;
    }

    .feed-filter-bar {
      display: none;
      padding: 8px 12px;
      background: rgba(108, 99, 255, 0.08);
      border-bottom: 1px solid rgba(108, 99, 255, 0.15);
      font-size: 12px;
      color: #a5a0ff;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
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

    .feed-body {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px;
    }
    .feed-body::-webkit-scrollbar { width: 4px; }
    .feed-body::-webkit-scrollbar-track { background: transparent; }
    .feed-body::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }

    .live-badge {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #4ade80; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .live-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #4ade80;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.4); }
      50% { opacity: 0.6; box-shadow: 0 0 0 4px rgba(74, 222, 128, 0); }
    }

    /* Feed events */
    .event {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .event:hover { background: #ffffff06; }
    .event-time {
      color: #555;
      font-size: 12px;
      font-family: monospace;
      white-space: nowrap;
      min-width: 55px;
    }
    .event-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
      white-space: nowrap;
      min-width: 36px;
      text-align: center;
    }
    .event-text { flex: 1; word-break: break-word; white-space: pre-wrap; }
    .type-message_in .event-badge { background: #1e3a5f; color: #60a5fa; }
    .type-message_out .event-badge { background: #1a3a2a; color: #4ade80; }
    .type-error .event-badge { background: #3a1a1a; color: #f87171; }
    .type-system .event-badge { background: #2a2a1a; color: #facc15; }
    .event-meta {
      color: #555;
      font-size: 11px;
      white-space: nowrap;
    }
    .event-timing {
      margin-left: 79px;
      padding: 4px 8px;
      font-size: 11px;
      font-family: monospace;
      color: #666;
      background: #ffffff04;
      border-radius: 3px;
      line-height: 1.4;
    }
    .event-timing .t-label { color: #555; }
    .event-timing .t-val { color: #8b8bcd; }
    .event-bot {
      font-size: 10px;
      color: #555;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(251, 191, 36, 0.08);
      border: 1px solid rgba(251, 191, 36, 0.15);
      white-space: nowrap;
    }
  `;
}

export function activityFeedHtml(): string {
  return `
    <div class="activity-drawer collapsed" id="activityDrawer">
      <div class="drawer-bar" id="drawerBar">
        <div class="drawer-bar-left">
          <span class="drawer-title">Activity</span>
          <div class="live-badge"><div class="live-dot"></div> Live</div>
          <span class="drawer-new-count" id="drawerNewCount"></span>
        </div>
        <button class="drawer-toggle" id="drawerToggle">&#9650;</button>
      </div>
      <div class="drawer-content">
        <div class="feed-filter-bar" id="feedFilterBar">
          <span id="feedFilterLabel">Filtering...</span>
          <button class="feed-filter-clear" onclick="clearFeedFilter()">Clear filter</button>
        </div>
        <div class="feed-body" id="feed"></div>
      </div>
    </div>`;
}

export function activityFeedScript(): string {
  return `
    const feed = document.getElementById('feed');
    const drawer = document.getElementById('activityDrawer');
    let drawerExpanded = false;
    let newEventCount = 0;

    function clearFeed() {
      feed.innerHTML = '';
      newEventCount = 0;
      updateNewEventBadge();
    }

    function expandActivityDrawer() {
      drawerExpanded = true;
      drawer.classList.remove('collapsed');
      drawer.classList.add('expanded');
      document.getElementById('drawerToggle').innerHTML = '&#9660;';
      newEventCount = 0;
      updateNewEventBadge();
    }

    function collapseActivityDrawer() {
      drawerExpanded = false;
      drawer.classList.remove('expanded');
      drawer.classList.add('collapsed');
      document.getElementById('drawerToggle').innerHTML = '&#9650;';
    }

    function toggleActivityDrawer() {
      if (drawerExpanded) collapseActivityDrawer();
      else expandActivityDrawer();
    }

    function updateNewEventBadge() {
      const badge = document.getElementById('drawerNewCount');
      if (newEventCount > 0 && !drawerExpanded) {
        badge.textContent = newEventCount + ' new';
        badge.classList.add('has-new');
      } else {
        badge.classList.remove('has-new');
      }
    }

    document.getElementById('drawerBar').addEventListener('click', toggleActivityDrawer);

    // Keyboard: A to toggle drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && e.target === document.body) {
        e.preventDefault();
        toggleActivityDrawer();
      }
    });

    function badgeLabel(type) {
      switch (type) {
        case 'message_in': return 'IN';
        case 'message_out': return 'OUT';
        case 'error': return 'ERR';
        case 'system': return 'SYS';
        default: return type;
      }
    }

    function renderTiming(m) {
      const parts = [];
      if (m.startupMs > 500) parts.push('<span class="t-label">mcp:</span> <span class="t-val">' + fmtMs(m.startupMs) + '</span>');
      if (m.apiMs) parts.push('<span class="t-label">api:</span> <span class="t-val">' + fmtMs(m.apiMs) + '</span>');
      if (m.promptBuildMs > 50) parts.push('<span class="t-label">prompt:</span> <span class="t-val">' + fmtMs(m.promptBuildMs) + '</span>');
      if (m.sttMs) parts.push('<span class="t-label">stt:</span> <span class="t-val">' + fmtMs(m.sttMs) + '</span>');
      if (m.ttsMs) parts.push('<span class="t-label">tts:</span> <span class="t-val">' + fmtMs(m.ttsMs) + '</span>');
      if (m.inputTokens || m.outputTokens) parts.push('<span class="t-label">tok:</span> <span class="t-val">' + fmtTokens(m.inputTokens || 0) + ' in / ' + fmtTokens(m.outputTokens || 0) + ' out</span>');
      if (m.model) parts.push('<span class="t-label">' + escapeHtml(m.model) + '</span>');
      return parts.join(' &nbsp;&middot;&nbsp; ');
    }

    function addEvent(ev) {
      if (!drawerExpanded) {
        newEventCount++;
        updateNewEventBadge();
      }

      const fragment = document.createDocumentFragment();

      const div = document.createElement('div');
      div.className = 'event type-' + ev.type;
      div.dataset.feedEvent = 'true';

      let meta = '';
      if (ev.durationMs) meta += fmtMs(ev.durationMs);
      if (ev.metadata && (ev.metadata.inputTokens || ev.metadata.outputTokens)) {
        const total = (ev.metadata.inputTokens || 0) + (ev.metadata.outputTokens || 0);
        meta += (meta ? ' &middot; ' : '') + fmtTokens(total) + ' tok';
      }
      if (ev.username) meta += (meta ? ' &middot; ' : '') + '@' + escapeHtml(ev.username);

      const botBadge = (ev.botName && !selectedBot) ? '<span class="event-bot">' + escapeHtml(ev.botName) + '</span>' : '';

      div.innerHTML =
        '<span class="event-time">' + formatTime(ev.timestamp) + '</span>' +
        '<span class="event-badge">' + badgeLabel(ev.type) + '</span>' +
        botBadge +
        '<span class="event-text">' + escapeHtml(ev.text) + '</span>' +
        (meta ? '<span class="event-meta">' + meta + '</span>' : '');

      fragment.appendChild(div);

      if (ev.metadata && ev.type === 'message_out') {
        const timingDiv = document.createElement('div');
        timingDiv.className = 'event-timing';
        timingDiv.innerHTML = renderTiming(ev.metadata);
        fragment.appendChild(timingDiv);
      }

      if (currentFeedFilter) {
        const matches = ev.text && ev.text.includes('Watcher "' + currentFeedFilter + '"');
        if (!matches) div.classList.add('feed-dim');
      }

      feed.prepend(fragment);
    }
  `;
}
