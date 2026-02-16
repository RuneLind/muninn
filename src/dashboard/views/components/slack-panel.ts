/** Slack analytics panel — message stats, platform breakdown, user drill-down */
export function slackPanelStyles(): string {
  return `
    .slack-summary {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      padding: 12px;
    }
    .slack-stat {
      text-align: center;
      padding: 8px;
      background: #1a1a2e;
      border-radius: 6px;
    }
    .slack-stat-value { font-size: 20px; font-weight: 700; color: #fff; }
    .slack-stat-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .slack-section-title {
      font-size: 11px;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 12px 4px;
    }
    .slack-breakdown {
      padding: 0 12px 8px;
    }
    .slack-breakdown-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 12px;
      border-bottom: 1px solid #1a1a2e;
    }
    .slack-breakdown-row:last-child { border-bottom: none; }
    .slack-platform-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .slack-platform-badge.slack_dm { background: #1e3a5f; color: #60a5fa; }
    .slack-platform-badge.slack_channel { background: #1a3a2a; color: #4ade80; }
    .slack-platform-badge.slack_assistant { background: #2a1a3a; color: #c084fc; }
    .slack-user-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      transition: background 0.15s;
      cursor: pointer;
    }
    .slack-user-item:hover { background: #ffffff0a; }
    .slack-user-item:active { background: #ffffff12; }
    .slack-user-item.active { background: rgba(108, 99, 255, 0.08); border: 1px solid rgba(108, 99, 255, 0.2); margin: -1px; }
    .slack-user-name { font-size: 13px; color: #ddd; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .slack-user-meta { font-size: 11px; color: #555; display: flex; gap: 8px; align-items: center; }

    /* Slack message conversation in feed */
    .slack-msg {
      padding: 10px 14px;
      border-radius: 8px;
      margin: 4px 8px;
      max-width: 85%;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .slack-msg.role-user {
      background: #1e3a5f;
      color: #c8ddf5;
      align-self: flex-end;
      margin-left: auto;
      border-bottom-right-radius: 2px;
    }
    .slack-msg.role-assistant {
      background: #1a3a2a;
      color: #c8f5d8;
      align-self: flex-start;
      margin-right: auto;
      border-bottom-left-radius: 2px;
    }
    .slack-msg-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .slack-msg-role {
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
    }
    .role-user .slack-msg-role { background: #1e3a5f; color: #60a5fa; }
    .role-assistant .slack-msg-role { background: #1a3a2a; color: #4ade80; }
    .slack-msg-time { color: #555; font-family: monospace; font-size: 11px; }
    .slack-msg-model { color: #666; font-size: 10px; }
    .slack-msg-content { overflow: hidden; }
    .slack-msg-content.collapsed { max-height: 120px; }
    .slack-msg-expand {
      display: inline-block;
      margin-top: 4px;
      color: #6c63ff;
      font-size: 11px;
      cursor: pointer;
    }
    .slack-msg-expand:hover { color: #a5a0ff; }
    .slack-convo-container {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 0;
    }
  `;
}

export function slackPanelHtml(): string {
  return `
      <div class="panel" id="slackPanel" style="display:none">
        <div class="panel-header">
          Slack Analytics <span class="count" id="slackMsgCount">0</span>
        </div>
        <div id="slackContent"></div>
      </div>`;
}

export function slackPanelScript(): string {
  return `
    // --- Slack User Message History ---
    let slackUserFilterActive = false;
    let cachedFeedHtml = '';
    let pendingEvents = [];

    async function showSlackUserMessages(userId, username) {
      const feedEl = document.getElementById('feed');
      const filterBar = document.getElementById('feedFilterBar');
      const showMore = document.getElementById('feedShowMore');
      const liveBadge = document.querySelector('.live-badge');

      document.querySelectorAll('.slack-user-item').forEach(el => {
        el.classList.toggle('active', el.dataset.userId === userId);
      });

      if (!slackUserFilterActive) {
        cachedFeedHtml = feedEl.innerHTML;
      }
      slackUserFilterActive = true;

      filterBar.classList.add('visible');
      document.getElementById('feedFilterLabel').textContent = 'Messages from @' + username;
      showMore.style.display = 'none';
      if (liveBadge) liveBadge.style.display = 'none';

      document.querySelector('.feed-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

      feedEl.innerHTML = '<div class="panel-empty">Loading messages...</div>';

      try {
        const res = await fetch('/api/messages/' + encodeURIComponent(userId) + '?limit=100');
        const data = await res.json();
        const msgs = data.messages || [];

        if (!msgs.length) {
          feedEl.innerHTML = '<div class="panel-empty">No messages found for @' + escapeHtml(username) + '</div>';
          return;
        }

        const convo = document.createElement('div');
        convo.className = 'slack-convo-container';

        msgs.forEach(m => {
          const div = document.createElement('div');
          div.className = 'slack-msg role-' + m.role;

          const time = formatTime(m.timestamp);
          const roleLabel = m.role === 'user' ? 'YOU' : 'BOT';
          const modelInfo = m.model ? ' &middot; <span class="slack-msg-model">' + escapeHtml(m.model) + '</span>' : '';
          const content = escapeHtml(m.text || '');
          const isLong = content.length > 500;

          div.innerHTML =
            '<div class="slack-msg-header">' +
              '<span class="slack-msg-role">' + roleLabel + '</span>' +
              '<span class="slack-msg-time">' + time + '</span>' +
              modelInfo +
            '</div>' +
            '<div class="slack-msg-content' + (isLong ? ' collapsed' : '') + '">' + content + '</div>' +
            (isLong ? '<span class="slack-msg-expand">Show more</span>' : '');

          convo.appendChild(div);
        });

        feedEl.innerHTML = '';
        feedEl.appendChild(convo);

        feedEl.scrollTop = feedEl.scrollHeight;
      } catch (err) {
        console.error('Failed to load user messages:', err);
        feedEl.innerHTML = '<div class="panel-empty">Failed to load messages</div>';
      }
    }

    function clearSlackUserFilter() {
      if (!slackUserFilterActive) return;
      slackUserFilterActive = false;

      const feedEl = document.getElementById('feed');
      const filterBar = document.getElementById('feedFilterBar');
      const liveBadge = document.querySelector('.live-badge');

      document.querySelectorAll('.slack-user-item').forEach(el => el.classList.remove('active'));

      feedEl.innerHTML = cachedFeedHtml;
      cachedFeedHtml = '';

      filterBar.classList.remove('visible');
      if (liveBadge) liveBadge.style.display = '';

      const eventsToReplay = pendingEvents.slice();
      pendingEvents = [];
      eventsToReplay.forEach(ev => addEvent(ev));

      feedExpanded = false;
      updateFeedVisibility();
    }

    // --- Slack Analytics Panel ---
    function renderSlackAnalytics(data) {
      const panel = document.getElementById('slackPanel');
      if (!data || data.totalMessages === 0) { panel.style.display = 'none'; return; }
      panel.style.display = '';
      document.getElementById('slackMsgCount').textContent = data.totalMessages;

      const platformLabel = { slack_dm: 'DM', slack_channel: 'Channel', slack_assistant: 'Assistant' };
      const breakdownHtml = data.platformBreakdown.map(b =>
        '<div class="slack-breakdown-row">' +
          '<span class="slack-platform-badge ' + escapeAttr(b.platform) + '">' + escapeHtml(platformLabel[b.platform] || b.platform) + '</span>' +
          '<span style="color:#aaa">' + escapeHtml(String(b.messages)) + ' msgs</span>' +
          '<span style="color:#666">' + escapeHtml(String(b.users)) + ' users</span>' +
        '</div>'
      ).join('');

      const usersHtml = data.users.map(u => {
        const memCount = u.personalMemories + u.sharedMemories;
        const badge = u.primaryPlatform ? '<span class="slack-platform-badge ' + escapeAttr(u.primaryPlatform) + '" style="font-size:9px">' + escapeHtml(platformLabel[u.primaryPlatform] || u.primaryPlatform) + '</span>' : '';
        return '<div class="slack-user-item" data-user-id="' + escapeAttr(u.userId) + '" data-username="' + escapeAttr(u.username) + '">' +
          '<span class="slack-user-name">' + escapeHtml(u.username) + '</span>' +
          '<span class="slack-user-meta">' +
            u.messageCount + ' msgs' +
            (memCount > 0 ? ' &middot; ' + memCount + ' mem' : '') +
            ' &middot; ' + badge +
          '</span>' +
        '</div>';
      }).join('');

      document.getElementById('slackContent').innerHTML =
        '<div class="slack-summary">' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.totalMessages + '</div><div class="slack-stat-label">Messages</div></div>' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.uniqueUsers + '</div><div class="slack-stat-label">Users</div></div>' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.totalPersonalMemories + '</div><div class="slack-stat-label">Personal Mem</div></div>' +
          '<div class="slack-stat"><div class="slack-stat-value">' + data.totalSharedMemories + '</div><div class="slack-stat-label">Shared Mem</div></div>' +
        '</div>' +
        (breakdownHtml ? '<div class="slack-section-title">Platform Breakdown</div><div class="slack-breakdown">' + breakdownHtml + '</div>' : '') +
        (usersHtml ? '<div class="slack-section-title">Users</div><div class="panel-body">' + usersHtml + '</div>' : '');
    }
  `;
}
