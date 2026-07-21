/** Section tabs — horizontal pill-style tab navigation with hash routing.
 *
 * Parameterized via a SectionTabsConfig so multiple pages can each mount an
 * independent tab bar with its own tab set, localStorage key, default tab, and
 * content-wrapper selector. The main dashboard uses the built-in DASHBOARD_TABS
 * default (call sites pass no args); the summaries page passes its own config. */

export interface SectionTabDef {
  id: string;
  label: string;
  /** Hash written to the URL on activation; defaults to "#<id>". */
  hash?: string;
  /** Start hidden (revealed later via the client-side showTab helper). */
  hidden?: boolean;
}

export interface SectionTabsConfig {
  tabs: readonly SectionTabDef[];
  /** localStorage key for the last-active tab. */
  storageKey: string;
  /** Tab id shown when neither the hash nor localStorage matches. */
  defaultTab: string;
  /** CSS selector of the wrapper holding the `[data-section]` panels. */
  contentSelector?: string;
  /** Horizontal 24px gutter on the tab bar + panels (full-width pages like the
   *  main dashboard). Set false for pages that already pad their own content
   *  column (e.g. summaries lives inside a padded `.page-content`). */
  padded?: boolean;
  /** Retired tab ids → surviving tab id, for continuity when tabs are merged.
   *  A stored/hash id matching an alias resolves to its target at init time (and
   *  on hashchange), so a returning browser lands where its content moved rather
   *  than falling through to the default tab. Only affects INITIAL resolution —
   *  `switchSection` is always called with a live id. */
  aliases?: Record<string, string>;
}

/** The main dashboard's tab set — kept as the default so page.ts call sites stay
 *  argument-free and behaviorally identical. */
const DASHBOARD_TABS: SectionTabsConfig = {
  tabs: [
    { id: "overview", label: "Overview" },
    { id: "users", label: "Users" },
    { id: "memories-goals", label: "Memories & Goals" },
    { id: "schedules-watchers", label: "Schedules & Watchers" },
    { id: "connectors", label: "Connectors" },
    { id: "memsearch", label: "MemSearch" },
    { id: "slack", label: "Slack", hidden: true },
  ],
  storageKey: "muninn-active-tab",
  defaultTab: "overview",
  contentSelector: ".section-content",
  padded: true,
};

export function sectionTabsStyles(config: SectionTabsConfig = DASHBOARD_TABS): string {
  const sel = config.contentSelector ?? ".section-content";
  const padX = config.padded === false ? "0" : "24px";
  return `
    .section-tabs {
      display: flex;
      gap: 4px;
      padding: 0 ${padX} 12px;
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
    ${sel} > [data-section] {
      display: none;
      padding: 0 ${padX} 24px;
    }
    ${sel} > [data-section].active {
      display: block;
    }
    .section-tab.tab-hidden { display: none; }
  `;
}

export function sectionTabsHtml(config: SectionTabsConfig = DASHBOARD_TABS): string {
  return `
    <div class="section-tabs" id="sectionTabs">
      ${config.tabs
        .map((t, i) => {
          const hidden = t.hidden ? " tab-hidden" : "";
          return `<button class="section-tab${i === 0 ? " active" : ""}${hidden}" data-tab="${t.id}" title="Alt+${i + 1}">${t.label}<span class="tab-count" id="tabCount-${t.id}"></span></button>`;
        })
        .join("\n      ")}
    </div>`;
}

export function sectionTabsScript(config: SectionTabsConfig = DASHBOARD_TABS): string {
  const tabs = config.tabs.map((t) => ({ id: t.id, label: t.label, hash: t.hash ?? `#${t.id}` }));
  const contentSelector = config.contentSelector ?? ".section-content";
  return `
    const SECTION_TABS = ${JSON.stringify(tabs)};
    const SECTION_STORAGE_KEY = ${JSON.stringify(config.storageKey)};
    const SECTION_DEFAULT_TAB = ${JSON.stringify(config.defaultTab)};
    const SECTION_CONTENT_SELECTOR = ${JSON.stringify(contentSelector)};
    const SECTION_ALIASES = ${JSON.stringify(config.aliases ?? {})};
    let activeSection = SECTION_DEFAULT_TAB;

    // Resolve a stored/hash id through the merge aliases (retired-id → surviving-id),
    // so a returning browser lands on the tab its content moved to. A live id (no
    // alias entry) passes through unchanged.
    function resolveSectionAlias(id) {
      return (id && SECTION_ALIASES[id]) ? SECTION_ALIASES[id] : id;
    }

    var sectionActivateCallbacks = {};

    function onSectionActivate(sectionId, callback) {
      sectionActivateCallbacks[sectionId] = callback;
    }

    // opts.persist=false skips the localStorage write — deep-link activations
    // (e.g. opening a bookmarked ?doc= URL) must not permanently overwrite the
    // user's saved default tab. User-driven switches (clicks, Alt+N, hashchange)
    // use the default (persist).
    function switchSection(sectionId, opts) {
      const tab = SECTION_TABS.find(t => t.id === sectionId);
      if (!tab) return;

      activeSection = sectionId;

      // Update tab buttons
      document.querySelectorAll('.section-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === sectionId);
      });

      // Show/hide sections (scoped to this page's content wrapper)
      document.querySelectorAll(SECTION_CONTENT_SELECTOR + ' > [data-section]').forEach(el => {
        el.classList.toggle('active', el.dataset.section === sectionId);
      });

      // Update hash without scroll (bare fragment — keeps path + query intact)
      history.replaceState(null, '', tab.hash);

      // Save to localStorage
      if (!opts || opts.persist !== false) {
        try { localStorage.setItem(SECTION_STORAGE_KEY, sectionId); } catch {}
      }

      // Call activate callback if registered
      if (sectionActivateCallbacks[sectionId]) {
        sectionActivateCallbacks[sectionId]();
      }
    }

    function initSectionTabs() {
      // Determine initial tab: hash > localStorage > default (each resolved through
      // the merge aliases so a retired-tab id lands on its surviving tab).
      const hash = resolveSectionAlias(location.hash.replace('#', ''));
      const saved = resolveSectionAlias((() => { try { return localStorage.getItem(SECTION_STORAGE_KEY); } catch { return null; } })());
      const matchedHash = SECTION_TABS.find(t => t.id === hash);
      const matchedSaved = SECTION_TABS.find(t => t.id === saved);
      const initial = matchedHash ? hash : (matchedSaved ? saved : SECTION_DEFAULT_TAB);
      switchSection(initial);

      // Tab click handlers
      document.getElementById('sectionTabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.section-tab');
        if (btn && btn.dataset.tab) switchSection(btn.dataset.tab);
      });

      // Hash change (browser back/forward) — alias-resolved like the initial pick.
      window.addEventListener('hashchange', () => {
        const h = resolveSectionAlias(location.hash.replace('#', ''));
        if (h && SECTION_TABS.find(t => t.id === h)) switchSection(h);
      });

      // Keyboard: Alt+1 through Alt+N — but not while typing in a field. On macOS
      // Alt+digit types characters, and some pages (summaries) have a prominent
      // URL input, so skip the shortcut when focus is inside an editable element.
      document.addEventListener('keydown', (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          if (!(e.target instanceof Element) || e.target.closest('input, textarea, select, [contenteditable]')) return;
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
