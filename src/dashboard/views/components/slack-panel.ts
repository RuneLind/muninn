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

    /* Slack message conversation in detail panel */
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
    let slackAnalyticsData = null;

    async function showSlackUserMessages(userId, username) {
      // Open user detail panel instead of hijacking feed
      const user = slackAnalyticsData && slackAnalyticsData.users
        ? slackAnalyticsData.users.find(u => u.userId === userId)
        : null;

      openDetail('user', {
        userId: userId,
        username: username,
        platform: user ? user.primaryPlatform : 'slack',
        messageCount: user ? user.messageCount : 0,
        memoryCount: user ? (user.personalMemories + user.sharedMemories) : 0,
        threadCount: 0,
        lastActive: user ? user.lastSeen : null,
      });
    }

    // --- Slack Analytics Panel ---
    function renderSlackAnalytics(data) {
      slackAnalyticsData = data;
      const panel = document.getElementById('slackPanel');
      if (!data || data.totalMessages === 0) {
        panel.style.display = 'none';
        hideTab('slack');
        return;
      }
      panel.style.display = '';
      showTab('slack');
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
        const tipData = JSON.stringify({ type: 'user', platform: u.primaryPlatform || 'slack', messageCount: u.messageCount, lastActive: timeAgo(u.lastSeen) });
        return '<div class="slack-user-item" data-user-id="' + escapeAttr(u.userId) + '" data-username="' + escapeAttr(u.username) + '" data-tip=\\'' + escapeAttr(tipData) + '\\'>' +
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
