/** Section tabs — horizontal pill-style tab navigation with hash routing */

const TABS = [
  { id: "overview", label: "Overview", hash: "#overview" },
  { id: "users", label: "Users", hash: "#users" },
  { id: "threads", label: "Threads", hash: "#threads" },
  { id: "memories-goals", label: "Memories & Goals", hash: "#memories-goals" },
  { id: "schedules-watchers", label: "Schedules & Watchers", hash: "#schedules-watchers" },
  { id: "slack", label: "Slack", hash: "#slack" },
] as const;

export function sectionTabsStyles(): string {
  return `
    .section-tabs {
      display: flex;
      gap: 4px;
      padding: 0 24px 12px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .section-tabs::-webkit-scrollbar { height: 0; }
    .section-tab {
      padding: 7px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-dim);
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
      user-select: none;
    }
    .section-tab:hover {
      color: var(--accent-light);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      background: color-mix(in srgb, var(--accent) 6%, transparent);
    }
    .section-tab.active {
      color: var(--text-primary);
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .section-tab .tab-count {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 400;
      background: var(--border-primary);
      color: var(--text-faint);
    }
    .section-tab.active .tab-count {
      background: color-mix(in srgb, var(--accent) 25%, transparent);
      color: var(--accent-light);
    }
    .section-content > [data-section] {
      display: none;
      padding: 0 24px 24px;
    }
    .section-content > [data-section].active {
      display: block;
    }
    .section-tab.tab-hidden { display: none; }
  `;
}

export function sectionTabsHtml(): string {
  return `
    <div class="section-tabs" id="sectionTabs">
      ${TABS.map((t, i) => `<button class="section-tab${i === 0 ? " active" : ""}${t.id === "slack" ? " tab-hidden" : ""}" data-tab="${t.id}" title="Alt+${i + 1}">${t.label}<span class="tab-count" id="tabCount-${t.id}"></span></button>`).join("\n      ")}
    </div>`;
}

export function sectionTabsScript(): string {
  return `
    const SECTION_TABS = ${JSON.stringify(TABS)};
    let activeSection = 'overview';

    function switchSection(sectionId) {
      const tab = SECTION_TABS.find(t => t.id === sectionId);
      if (!tab) return;

      activeSection = sectionId;

      // Update tab buttons
      document.querySelectorAll('.section-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === sectionId);
      });

      // Show/hide sections
      document.querySelectorAll('[data-section]').forEach(el => {
        el.classList.toggle('active', el.dataset.section === sectionId);
      });

      // Update hash without scroll
      history.replaceState(null, '', tab.hash);

      // Save to localStorage
      try { localStorage.setItem('javrvis-active-tab', sectionId); } catch {}
    }

    function initSectionTabs() {
      // Determine initial tab: hash > localStorage > default
      const hash = location.hash.replace('#', '');
      const saved = (() => { try { return localStorage.getItem('javrvis-active-tab'); } catch { return null; } })();
      const matchedHash = SECTION_TABS.find(t => t.id === hash);
      const matchedSaved = SECTION_TABS.find(t => t.id === saved);
      const initial = matchedHash ? hash : (matchedSaved ? saved : 'overview');
      switchSection(initial);

      // Tab click handlers
      document.getElementById('sectionTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.section-tab');
        if (btn && btn.dataset.tab) switchSection(btn.dataset.tab);
      });

      // Hash change (browser back/forward)
      window.addEventListener('hashchange', () => {
        const h = location.hash.replace('#', '');
        if (h && SECTION_TABS.find(t => t.id === h)) switchSection(h);
      });

      // Keyboard: Alt+1 through Alt+6
      document.addEventListener('keydown', (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          const idx = parseInt(e.key) - 1;
          if (idx >= 0 && idx < SECTION_TABS.length) {
            e.preventDefault();
            switchSection(SECTION_TABS[idx].id);
          }
        }
      });
    }

    function updateTabCount(tabId, count) {
      const el = document.getElementById('tabCount-' + tabId);
      if (el) el.textContent = count > 0 ? count : '';
    }

    function showTab(tabId) {
      const btn = document.querySelector('.section-tab[data-tab="' + tabId + '"]');
      if (btn) btn.classList.remove('tab-hidden');
    }

    function hideTab(tabId) {
      const btn = document.querySelector('.section-tab[data-tab="' + tabId + '"]');
      if (btn) btn.classList.add('tab-hidden');
    }
  `;
}
