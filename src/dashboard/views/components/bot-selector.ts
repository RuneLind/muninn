/** Bot selector — pill-style filter in header area */
export function botSelectorStyles(): string {
  return `
    .bot-selector {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
    }
    .bot-pill {
      padding: 4px 12px;
      border-radius: 14px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-dim);
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
      user-select: none;
    }
    .bot-pill:hover {
      color: var(--accent-light);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      background: color-mix(in srgb, var(--accent) 6%, transparent);
    }
    .bot-pill.active {
      color: var(--text-primary);
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    }
  `;
}

export function botSelectorHtml(): string {
  return `
    <div class="bot-selector" id="botSelector">
      <button class="bot-pill active" data-bot="">All Bots</button>
    </div>`;
}

export function botSelectorScript(): string {
  return `
    let selectedBot = '';

    (function initBotSelector() {
      try {
        selectedBot = localStorage.getItem('muninn-selected-bot') || '';
      } catch {}
      loadBotList();
    })();

    async function loadBotList() {
      try {
        const res = await fetch('/api/bots').then(r => r.json());
        const container = document.getElementById('botSelector');
        const bots = res.bots || [];
        container.innerHTML =
          '<button class="bot-pill' + (!selectedBot ? ' active' : '') + '" data-bot="">All Bots</button>' +
          bots.map(b =>
            '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + escapeAttr(b) + '">' + escapeHtml(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>'
          ).join('');
      } catch {}
    }

    function selectBot(name) {
      selectedBot = name;
      try { localStorage.setItem('muninn-selected-bot', name); } catch {}
      document.querySelectorAll('.bot-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.bot === name);
      });
      loadDashboard();
    }

    document.getElementById('botSelector').addEventListener('click', (e) => {
      const pill = e.target.closest('.bot-pill');
      if (pill) selectBot(pill.dataset.bot);
    });
  `;
}
