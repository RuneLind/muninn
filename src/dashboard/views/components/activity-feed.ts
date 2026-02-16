/** Activity feed — real-time event stream with show more/less */
export function activityFeedStyles(): string {
  return `
    .feed-panel .panel-body {
      max-height: none;
      flex: 1;
      min-height: 300px;
    }
    .feed-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .feed-hidden { display: none !important; }
    .feed-show-more {
      padding: 8px 16px;
      text-align: center;
      border-top: 1px solid #1e1e2e;
    }
    .feed-show-more button {
      background: none;
      border: 1px solid #2a2a3a;
      color: #888;
      padding: 6px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s;
    }
    .feed-show-more button:hover {
      border-color: #6c63ff;
      color: #ccc;
    }
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
  `;
}

export function activityFeedHtml(): string {
  return `
      <div class="panel feed-panel">
        <div class="panel-header">
          Activity Feed
          <div class="live-badge"><div class="live-dot"></div> Live</div>
        </div>
        <div class="feed-filter-bar" id="feedFilterBar">
          <span id="feedFilterLabel">Filtering...</span>
          <button class="feed-filter-clear" onclick="clearFeedFilter()">Clear filter</button>
        </div>
        <div class="panel-body" id="feed"></div>
        <div class="feed-show-more" id="feedShowMore" style="display:none">
          <button id="feedToggleBtn" onclick="toggleFeed()">Show all</button>
        </div>
      </div>`;
}

export function activityFeedScript(): string {
  return `
    const feed = document.getElementById('feed');
    const FEED_LIMIT = 10;
    let feedExpanded = false;
    let feedEventCount = 0;

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
      if (slackUserFilterActive) {
        pendingEvents.push(ev);
        return;
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

      div.innerHTML =
        '<span class="event-time">' + formatTime(ev.timestamp) + '</span>' +
        '<span class="event-badge">' + badgeLabel(ev.type) + '</span>' +
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
      feedEventCount++;
      updateFeedVisibility();
    }

    function updateFeedVisibility() {
      if (feedExpanded || feedEventCount <= FEED_LIMIT) {
        document.getElementById('feedShowMore').style.display = 'none';
        for (const child of feed.children) child.classList.remove('feed-hidden');
        return;
      }

      let count = 0;
      for (const child of feed.children) {
        if (child.dataset.feedEvent) count++;
        if (count > FEED_LIMIT) {
          child.classList.add('feed-hidden');
        } else {
          child.classList.remove('feed-hidden');
        }
      }

      const showMore = document.getElementById('feedShowMore');
      const hidden = feedEventCount - FEED_LIMIT;
      showMore.style.display = '';
      document.getElementById('feedToggleBtn').textContent = 'Show all (' + feedEventCount + ' events)';
    }

    function toggleFeed() {
      feedExpanded = !feedExpanded;
      if (feedExpanded) {
        for (const child of feed.children) child.classList.remove('feed-hidden');
        document.getElementById('feedToggleBtn').textContent = 'Show less';
        document.getElementById('feedShowMore').style.display = '';
      } else {
        updateFeedVisibility();
      }
    }
  `;
}
