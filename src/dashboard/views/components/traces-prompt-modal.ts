/** Traces prompt modal — full prompt snapshot viewer with system/user tabs and collapsible sections */
export function tracesPromptModalStyles(): string {
  return `
    /* Prompt Modal */
    .prompt-modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .prompt-modal-backdrop.visible { display: flex; }
    .prompt-modal {
      background: var(--bg-panel);
      border: 1px solid var(--border-secondary);
      border-radius: 12px;
      width: 90vw;
      max-width: 900px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }
    .prompt-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-primary);
    }
    .prompt-modal-header h3 { font-size: 14px; color: var(--text-primary); }
    .prompt-modal-close {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      padding: 4px 8px;
    }
    .prompt-modal-close:hover { color: var(--text-primary); }
    .prompt-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border-primary);
    }
    .prompt-tab {
      padding: 10px 20px;
      font-size: 13px;
      color: var(--text-muted);
      background: none;
      border: none;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }
    .prompt-tab:hover { color: var(--accent-light); }
    .prompt-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .prompt-tab .char-count {
      font-size: 10px;
      color: var(--text-faint);
      margin-left: 6px;
    }
    .prompt-modal-body {
      flex: 1;
      overflow: auto;
      padding: 16px 20px;
    }
    .prompt-modal-body pre {
      background: var(--bg-page);
      padding: 14px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--text-tertiary);
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }
    .prompt-unavailable {
      color: var(--text-faint);
      text-align: center;
      padding: 40px;
      font-size: 14px;
    }

    /* Prompt Stats Pills */
    .prompt-stats {
      display: flex;
      gap: 8px;
      padding: 10px 20px;
      flex-wrap: wrap;
      border-bottom: 1px solid var(--border-primary);
    }
    .prompt-stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 11px;
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--text-muted);
    }
    .prompt-stat-pill .stat-val { font-weight: 600; color: var(--text-secondary); }
    .prompt-stat-pill.clickable { cursor: pointer; transition: all 0.15s; }
    .prompt-stat-pill.clickable:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--text-secondary); }

    /* Section highlight flash */
    .section-highlight { animation: sectionFlash 1.5s ease-out; }
    @keyframes sectionFlash {
      0% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent); }
      100% { box-shadow: 0 0 0 2px transparent; }
    }

    /* Prompt Sections */
    .prompt-section {
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .prompt-section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }
    .prompt-section-header:hover { background: color-mix(in srgb, white 3%, transparent); }
    .prompt-section-chevron {
      transition: transform 0.2s;
      font-size: 10px;
      color: var(--text-dim);
    }
    .prompt-section-chevron.collapsed { transform: rotate(-90deg); }
    .prompt-section-title { font-size: 12px; font-weight: 600; }
    .prompt-section-meta { font-size: 10px; color: var(--text-faint); margin-left: auto; }
    .prompt-section-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 500;
      background: color-mix(in srgb, white 6%, transparent);
      color: var(--text-soft);
    }
    .prompt-section-body {
      padding: 8px 12px;
      border-top: 1px solid var(--border-primary);
      font-size: 12px;
      line-height: 1.6;
      color: var(--text-tertiary);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .prompt-section-body.hidden { display: none; }

    /* Section color themes */
    .section-persona .prompt-section-title { color: #c084fc; }
    .section-persona { border-color: rgba(192,132,252,0.2); }
    .section-persona .prompt-section-header { background: rgba(192,132,252,0.05); }

    .section-identity .prompt-section-title { color: #4ade80; }
    .section-identity { border-color: rgba(74,222,128,0.2); }
    .section-identity .prompt-section-header { background: rgba(74,222,128,0.05); }

    .section-restrictions .prompt-section-title { color: #f87171; }
    .section-restrictions { border-color: rgba(248,113,113,0.2); }
    .section-restrictions .prompt-section-header { background: rgba(248,113,113,0.05); }

    .section-memories .prompt-section-title { color: #60a5fa; }
    .section-memories { border-color: rgba(96,165,250,0.2); }
    .section-memories .prompt-section-header { background: rgba(96,165,250,0.05); }

    .section-goals .prompt-section-title { color: #fbbf24; }
    .section-goals { border-color: rgba(251,191,36,0.2); }
    .section-goals .prompt-section-header { background: rgba(251,191,36,0.05); }

    .section-tasks .prompt-section-title { color: #2dd4bf; }
    .section-tasks { border-color: rgba(45,212,191,0.2); }
    .section-tasks .prompt-section-header { background: rgba(45,212,191,0.05); }

    .section-alerts .prompt-section-title { color: #f59e0b; }
    .section-alerts { border-color: rgba(245,158,11,0.2); }
    .section-alerts .prompt-section-header { background: rgba(245,158,11,0.05); }

    .section-knowledge .prompt-section-title { color: #8b5cf6; }
    .section-knowledge { border-color: rgba(139,92,246,0.2); }
    .section-knowledge .prompt-section-header { background: rgba(139,92,246,0.05); }

    .section-slack .prompt-section-title { color: #22d3ee; }
    .section-slack { border-color: rgba(34,211,238,0.2); }
    .section-slack .prompt-section-header { background: rgba(34,211,238,0.05); }

    .section-history .prompt-section-title { color: #94a3b8; }
    .section-history { border-color: rgba(148,163,184,0.2); }
    .section-history .prompt-section-header { background: rgba(148,163,184,0.05); }

    /* Conversation messages */
    .conv-message {
      margin-bottom: 6px;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .conv-message-user { border-left: 3px solid #60a5fa; background: rgba(96,165,250,0.05); }
    .conv-message-assistant { border-left: 3px solid #c084fc; background: rgba(192,132,252,0.05); }
    .conv-message-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .conv-message-user .conv-message-label { color: #60a5fa; }
    .conv-message-assistant .conv-message-label { color: #c084fc; }

    /* Current message highlight */
    .current-message-wrapper { margin-top: 8px; }
    .current-message-label { font-size: 11px; font-weight: 600; color: var(--status-success); margin-bottom: 6px; }
    .current-message {
      border: 1px solid color-mix(in srgb, var(--status-success) 30%, transparent);
      background: color-mix(in srgb, var(--status-success) 5%, transparent);
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-secondary);
    }
  `;
}

export function tracesPromptModalHtml(): string {
  return `
  <div class="prompt-modal-backdrop" id="promptModalBackdrop" onclick="closePromptModal(event)">
    <div class="prompt-modal" onclick="event.stopPropagation()">
      <div class="prompt-modal-header">
        <h3>Prompt Snapshot</h3>
        <button class="prompt-modal-close" onclick="closePromptModal()">&times;</button>
      </div>
      <div class="prompt-stats" id="promptStats"></div>
      <div class="prompt-tabs">
        <button class="prompt-tab" id="tabSystem" onclick="switchPromptTab('system')">System Prompt <span class="char-count" id="systemCharCount"></span></button>
        <button class="prompt-tab active" id="tabUser" onclick="switchPromptTab('user')">User Prompt <span class="char-count" id="userCharCount"></span></button>
      </div>
      <div class="prompt-modal-body">
        <div id="promptContent"></div>
      </div>
    </div>
  </div>`;
}

export function tracesPromptModalScript(): string {
  return `
    let promptCache = {};  // traceId -> { systemPrompt, userPrompt } | null
    let activePromptTab = 'system';

    async function openPromptModal() {
      if (!currentWaterfallTraceId) return;
      const backdrop = document.getElementById('promptModalBackdrop');
      const contentEl = document.getElementById('promptContent');
      contentEl.innerHTML = '<div class="prompt-unavailable">Loading...</div>';
      backdrop.classList.add('visible');
      activePromptTab = 'user';
      document.getElementById('tabSystem').classList.remove('active');
      document.getElementById('tabUser').classList.add('active');
      renderPromptStats();

      try {
        if (!promptCache[currentWaterfallTraceId]) {
          const res = await fetch('/api/prompts/' + currentWaterfallTraceId);
          if (res.status === 404) {
            promptCache[currentWaterfallTraceId] = null;
          } else {
            promptCache[currentWaterfallTraceId] = await res.json();
          }
        }
        const data = promptCache[currentWaterfallTraceId];
        if (!data) {
          contentEl.innerHTML = '<div class="prompt-unavailable">Prompt snapshot not available (expired or not captured)</div>';
          document.getElementById('systemCharCount').textContent = '';
          document.getElementById('userCharCount').textContent = '';
          return;
        }
        document.getElementById('systemCharCount').textContent = '(' + fmtCharCount(data.systemPrompt.length) + ')';
        document.getElementById('userCharCount').textContent = '(' + fmtCharCount(data.userPrompt.length) + ')';
        renderPromptTab(data);
      } catch (e) {
        contentEl.innerHTML = '<div class="prompt-unavailable">Failed to load prompt snapshot</div>';
        console.error('Failed to load prompt', e);
      }
    }

    function renderPromptTab(data) {
      const contentEl = document.getElementById('promptContent');
      if (activePromptTab === 'system') {
        renderSystemPrompt(data.systemPrompt, contentEl);
      } else {
        renderUserPrompt(data.userPrompt, contentEl);
      }
    }

    function renderPromptStats() {
      const el = document.getElementById('promptStats');
      if (!el) return;
      const buildSpan = waterfallSpans.find(function(s) { return s.name === 'prompt_build'; });
      if (!buildSpan || !buildSpan.attributes) { el.innerHTML = ''; return; }
      var a = buildSpan.attributes;
      var stats = [
        { value: a.messagesCount, label: 'Messages', section: 'history', tab: 'user' },
        { value: a.memoriesCount, label: 'Memories', section: 'personal-memories', tab: 'system' },
        { value: a.goalsCount, label: 'Goals', section: 'goals', tab: 'system' },
        { value: a.scheduledTasksCount, label: 'Tasks', section: 'tasks', tab: 'system' },
        { value: a.alertsCount, label: 'Alerts', section: 'alerts', tab: 'system' },
      ].filter(function(s) { return s.value != null; });
      el.innerHTML = stats.map(function(s) {
        var clickable = s.value > 0;
        var cls = 'prompt-stat-pill' + (clickable ? ' clickable' : '');
        var attrs = clickable ? ' data-section="' + s.section + '" data-tab="' + s.tab + '"' : '';
        return '<div class="' + cls + '"' + attrs + '><span class="stat-val">' + s.value + '</span> ' + s.label + '</div>';
      }).join('');
      // Attach click handlers via event delegation
      el.querySelectorAll('.prompt-stat-pill.clickable').forEach(function(pill) {
        pill.addEventListener('click', function() {
          jumpToSection(pill.dataset.section, pill.dataset.tab);
        });
      });
    }

    function jumpToSection(sectionKey, tab) {
      if (activePromptTab !== tab) {
        switchPromptTab(tab);
      }
      // Small delay to let DOM render after tab switch
      setTimeout(function() {
        var section = document.querySelector('[data-section="' + sectionKey + '"]');
        if (!section) return;
        // Expand if collapsed
        var body = section.querySelector('.prompt-section-body');
        var chevron = section.querySelector('.prompt-section-chevron');
        if (body && body.classList.contains('hidden')) {
          body.classList.remove('hidden');
          if (chevron) chevron.classList.remove('collapsed');
        }
        // Scroll into view and flash highlight
        section.scrollIntoView({ behavior: 'smooth', block: 'center' });
        section.classList.add('section-highlight');
        setTimeout(function() { section.classList.remove('section-highlight'); }, 1500);
      }, 50);
    }

    function parseSystemSections(text) {
      var markers = [
        { key: 'identity', label: 'User Identity', marker: 'You are currently talking to:', color: 'identity' },
        { key: 'restrictions', label: 'Tool Restrictions', marker: '## Verkt\\u00f8yrestriksjoner', color: 'restrictions' },
        { key: 'personal-memories', label: 'Personal Memories', marker: 'Your memories about this user:', color: 'memories' },
        { key: 'shared-memories', label: 'Shared Memories', marker: 'Shared team knowledge:', color: 'memories' },
        { key: 'goals', label: 'Goals', marker: "User's active goals:", color: 'goals' },
        { key: 'tasks', label: 'Scheduled Tasks', marker: "User's scheduled tasks:", color: 'tasks' },
        { key: 'alerts', label: 'Alerts', marker: 'Recent watcher alerts sent to user (last 24h):', color: 'alerts' },
        { key: 'knowledge', label: 'Knowledge', marker: 'Relevant company knowledge (from Notion):', color: 'knowledge' },
        { key: 'slack-post', label: 'Slack Posting', marker: '## Slack Channel Posting', color: 'slack' },
        { key: 'channel-context', label: 'Channel Context', marker: '## Channel Context', color: 'slack' },
      ];
      var found = [];
      for (var i = 0; i < markers.length; i++) {
        var idx = text.indexOf(markers[i].marker);
        if (idx >= 0) {
          found.push({ key: markers[i].key, label: markers[i].label, marker: markers[i].marker, color: markers[i].color, pos: idx });
        }
      }
      found.sort(function(a, b) { return a.pos - b.pos; });
      var sections = [];
      var firstPos = found.length > 0 ? found[0].pos : text.length;
      var personaText = text.slice(0, firstPos).trim();
      if (personaText) {
        sections.push({ key: 'persona', label: 'Persona', color: 'persona', content: personaText, collapsed: true });
      }
      for (var i = 0; i < found.length; i++) {
        var start = found[i].pos;
        var end = i + 1 < found.length ? found[i + 1].pos : text.length;
        var content = text.slice(start, end).trim();
        sections.push({ key: found[i].key, label: found[i].label, color: found[i].color, content: content, collapsed: false });
      }
      return sections;
    }

    function parseUserSections(text) {
      var sections = [];
      var histStart = text.indexOf('<conversation_history>');
      var histEnd = text.indexOf('</conversation_history>');
      if (histStart >= 0 && histEnd >= 0) {
        var histContent = text.slice(histStart + '<conversation_history>'.length, histEnd).trim();
        var currentMsg = text.slice(histEnd + '</conversation_history>'.length).trim();
        var messages = parseConversationMessages(histContent);
        sections.push({ key: 'history', label: 'Conversation History', color: 'history', messages: messages, collapsed: messages.length > 10 });
        if (currentMsg) {
          sections.push({ key: 'current', label: 'Current Message', color: 'current', content: currentMsg, collapsed: false });
        }
      } else {
        sections.push({ key: 'current', label: 'Current Message', color: 'current', content: text.trim(), collapsed: false });
      }
      return sections;
    }

    function parseConversationMessages(text) {
      var re = /\\[(user\\/[^\\]]+|assistant)\\]\\s*/g;
      var messages = [];
      var match;
      var starts = [];
      while ((match = re.exec(text)) !== null) {
        starts.push({ label: match[1], pos: match.index, textStart: match.index + match[0].length });
      }
      for (var i = 0; i < starts.length; i++) {
        var end = i + 1 < starts.length ? starts[i + 1].pos : text.length;
        var content = text.slice(starts[i].textStart, end).trim();
        var role = starts[i].label.startsWith('user') ? 'user' : 'assistant';
        messages.push({ role: role, label: starts[i].label, content: content });
      }
      return messages;
    }

    function countItems(content) {
      var matches = content.match(/^- /gm);
      return matches ? matches.length : 0;
    }

    function renderSystemPrompt(text, container) {
      var sections = parseSystemSections(text);
      if (sections.length === 0) {
        container.innerHTML = '<pre>' + esc(text) + '</pre>';
        return;
      }
      container.innerHTML = sections.map(function(s) {
        var items = countItems(s.content);
        var badge = items > 0 ? '<span class="prompt-section-badge">' + items + ' items</span>' : '';
        var meta = fmtCharCount(s.content.length);
        var bodyClass = s.collapsed ? 'prompt-section-body hidden' : 'prompt-section-body';
        var chevClass = s.collapsed ? 'prompt-section-chevron collapsed' : 'prompt-section-chevron';
        return '<div class="prompt-section section-' + s.color + '" data-section="' + s.key + '">' +
          '<div class="prompt-section-header" onclick="toggleSection(this)">' +
            '<span class="' + chevClass + '">\\u25BC</span>' +
            '<span class="prompt-section-title">' + esc(s.label) + '</span>' +
            badge +
            '<span class="prompt-section-meta">' + meta + '</span>' +
          '</div>' +
          '<div class="' + bodyClass + '">' + esc(s.content) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderUserPrompt(text, container) {
      var sections = parseUserSections(text);
      if (sections.length === 0) {
        container.innerHTML = '<pre>' + esc(text) + '</pre>';
        return;
      }
      container.innerHTML = sections.map(function(s) {
        if (s.key === 'history') {
          var msgCount = s.messages.length;
          var badge = '<span class="prompt-section-badge">' + msgCount + ' messages</span>';
          var chevClass = s.collapsed ? 'prompt-section-chevron collapsed' : 'prompt-section-chevron';
          var bodyClass = s.collapsed ? 'prompt-section-body hidden' : 'prompt-section-body';
          return '<div class="prompt-section section-history" data-section="history">' +
            '<div class="prompt-section-header" onclick="toggleSection(this)">' +
              '<span class="' + chevClass + '">\\u25BC</span>' +
              '<span class="prompt-section-title">' + esc(s.label) + '</span>' +
              badge +
            '</div>' +
            '<div class="' + bodyClass + '" style="padding:6px 8px">' +
              s.messages.map(function(m) {
                var cls = m.role === 'user' ? 'conv-message conv-message-user' : 'conv-message conv-message-assistant';
                return '<div class="' + cls + '">' +
                  '<div class="conv-message-label">' + esc(m.label) + '</div>' +
                  esc(m.content) +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>';
        } else {
          return '<div class="current-message-wrapper">' +
            '<div class="current-message-label">Current Message</div>' +
            '<div class="current-message">' + esc(s.content) + '</div>' +
          '</div>';
        }
      }).join('');
    }

    function toggleSection(headerEl) {
      var body = headerEl.nextElementSibling;
      var chevron = headerEl.querySelector('.prompt-section-chevron');
      body.classList.toggle('hidden');
      chevron.classList.toggle('collapsed');
    }

    function switchPromptTab(tab) {
      activePromptTab = tab;
      document.getElementById('tabSystem').classList.toggle('active', tab === 'system');
      document.getElementById('tabUser').classList.toggle('active', tab === 'user');
      const data = promptCache[currentWaterfallTraceId];
      if (data) renderPromptTab(data);
    }

    function closePromptModal(event) {
      if (event && event.target !== event.currentTarget) return;
      document.getElementById('promptModalBackdrop').classList.remove('visible');
    }

    function fmtCharCount(n) {
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k chars';
      return n + ' chars';
    }

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePromptModal();
    });
  `;
}
