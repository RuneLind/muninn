/** Summaries doc panel — the Latest rail (left column).
 *
 * The last 14 days of summaries, newest first, under day headings, with a
 * filter box, All / Unread / busiest-category chips, unread dots and `j`/`k`
 * stepping. The old category accordion stays one toggle away ("By category",
 * `renderArticleCategories` in sum-article-library.ts).
 *
 * The rail is built ONCE, when the panel first opens, and is not part of the
 * per-open rewrite: opening a summary only moves `.current`. It re-renders —
 * keeping `.current`, collapsed days and scroll position — when the listing
 * memo is force-refreshed (a delete, a finished capture) or the domain filter
 * changes. The pure logic lives in src/summaries/latest-rail.ts and is
 * injected here with `.toString()`; this file is the DOM half. It shares the
 * page scope with sum-article-library.ts (getSummaryDocuments, matchesDomain,
 * docTitle, sourceBadge, openSummaryDoc, esc). */

import { RAIL_FUNCTIONS } from "../../../summaries/latest-rail.ts";
import { SHARE_DIALOG_ID } from "./wiki-share-dialog.ts";

/** The one localStorage key the rail's read state lives under. */
export const RAIL_READ_STORAGE_KEY = "muninn-summaries-read";

export function sumLatestRailStyles(): string {
  return `
    /* --- Latest rail (doc panel, left column) ---
       Small text uses --text-soft: on --bg-card, --text-muted measures 4.42:1
       in light (under AA at 11px); --text-soft measures 5.80:1 light, 7.34:1 dark. */
    .sum-rail { padding-top: 0; }
    .sum-rail-head {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--bg-card);
      padding: 14px 0 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .sum-rail-views { display: flex; gap: 4px; }
    .sum-rail-view {
      flex: 1;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-secondary);
      background: none;
      color: var(--text-soft);
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .sum-rail-view:hover { color: var(--text-primary); border-color: var(--accent); }
    .sum-rail-view[aria-pressed="true"] {
      color: var(--accent-light);
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .sum-rail-filter {
      width: 100%;
      box-sizing: border-box;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-secondary);
      background: var(--bg-panel);
      color: var(--text-primary);
      font: inherit;
      font-size: 12px;
    }
    .sum-rail-filter:focus { outline: none; border-color: var(--accent); }
    .sum-rail-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .sum-rail-chip {
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid var(--border-secondary);
      background: none;
      color: var(--text-soft);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sum-rail-chip:hover { color: var(--text-primary); border-color: var(--accent); }
    .sum-rail-chip[aria-pressed="true"] {
      color: var(--accent-light);
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .sum-rail-pane[hidden] { display: none; }
    .sum-latest-day { margin: 0 0 6px; }
    .sum-latest-day > summary {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 6px 2px 4px;
      cursor: pointer;
      list-style: none;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-soft);
    }
    .sum-latest-day > summary::-webkit-details-marker { display: none; }
    .sum-latest-day > summary::marker { content: ""; }
    .sum-latest-day > summary::before { content: '▸'; display: inline-block; width: 0.9em; }
    .sum-latest-day[open] > summary::before { content: '▾'; }
    .sum-latest-day > summary:hover { color: var(--text-primary); }
    .sum-latest-day-count { font-weight: 500; }
    .sum-latest-rows { display: flex; flex-direction: column; gap: 2px; }
    /* Scoped under .sum-rail: the panel's markdown rule .doc-panel-body a
       (accent colour, underline on hover) otherwise outranks a single class
       and paints every row as a link. */
    .sum-rail .sum-latest-row {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 5px 8px;
      border-radius: 6px;
      border-left: 2px solid transparent;
      text-decoration: none;
      color: var(--text-secondary);
    }
    .sum-rail .sum-latest-row:hover { background: var(--bg-surface); color: var(--text-primary); text-decoration: none; }
    .sum-rail .sum-latest-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .sum-rail .sum-latest-row.current {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-left-color: var(--accent);
      color: var(--accent-light);
    }
    .sum-latest-title {
      font-size: 12.5px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .sum-latest-row.current .sum-latest-title { font-weight: 600; }
    .sum-latest-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      margin: 0 5px 1px 0;
      border-radius: 50%;
      background: var(--accent);
      vertical-align: middle;
    }
    .sum-latest-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
      color: var(--text-soft);
    }
    .sum-latest-meta .source-badge { padding: 0 6px; font-size: 10px; }
    .sum-latest-cat { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sum-rail-more {
      display: block;
      width: 100%;
      margin: 8px 0 2px;
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-secondary);
      background: none;
      color: var(--text-secondary);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .sum-rail-more:hover { border-color: var(--accent); color: var(--text-primary); }
    .sum-rail-empty { font-size: 12px; color: var(--text-soft); padding: 6px 2px; }
    /* The narrow-layout toggle: only below the breakpoint, where the rail
       collapses to this one row above the article. */
    .sum-rail-toggle {
      display: none;
      width: 100%;
      padding: 0;
      border: none;
      background: none;
      color: var(--text-secondary);
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }
    .sum-rail-toggle::before { content: '▸'; display: inline-block; width: 1.1em; }
    .sum-rail-toggle[aria-expanded="true"]::before { content: '▾'; }
    @media (max-width: 1000px) {
      .sum-rail-toggle { display: block; }
      .sum-rail.open .sum-rail-toggle { margin-bottom: 4px; }
      .sum-rail:not(.open) .sum-rail-collapsible { display: none; }
      .sum-rail { padding-top: 14px; padding-bottom: 14px; }
      .sum-rail .sum-rail-head { position: static; }
    }
  `;
}

export function sumLatestRailScript(): string {
  return `
    // --- Latest rail: pure logic, injected from src/summaries/latest-rail.ts ---
    // --- rail-fns:start ---
${RAIL_FUNCTIONS.map((fn) => `    var ${fn.name} = ${fn.toString()};`).join("\n")}
    // --- rail-fns:end ---

    var RAIL_READ_KEY = ${JSON.stringify(RAIL_READ_STORAGE_KEY)};
    var _railView = 'latest';     // 'latest' | 'category'
    var _railQuery = '';
    var _railChip = 'all';        // 'all' | 'unread' | 'cat:<path>'
    var _railCutoff = null;       // a "Show older" cutoff; null = the default 14 days
    var _railCollapsed = {};      // day -> true for a day group the reader closed
    var _railCurrent = '';        // railKey of the open summary
    var _railCurrentDoc = null;   // {docId, source} of the open summary
    var _railRead;                // undefined until loaded; null = storage failed
    var _railBuilt = false;

    /** The read state, loaded once per page. Any storage failure is null, and
     *  null shows every row as read. */
    function railReadState() {
      if (_railRead !== undefined) return _railRead;
      try {
        var init = railReadStateInit(localStorage.getItem(RAIL_READ_KEY), railUtcDay(new Date()));
        if (init.write !== null) localStorage.setItem(RAIL_READ_KEY, init.write);
        _railRead = init.state;
      } catch (e) {
        _railRead = null;
      }
      return _railRead;
    }

    function railWriteReadState(state) {
      try {
        localStorage.setItem(RAIL_READ_KEY, JSON.stringify(state));
        _railRead = state;
      } catch (e) {
        _railRead = null;
      }
    }

    /** Marks a row read and drops its dot in place — no rebuild, so the row
     *  stays where it is while the reader steps through an Unread list. */
    function railMarkRead(source, docId) {
      var state = railReadState();
      if (!state) return;
      var key = railKey({ source: source, id: docId });
      // Merged over what is stored NOW, so a second tab's reads are kept.
      var stored = null;
      try { stored = railReadStateParse(localStorage.getItem(RAIL_READ_KEY)); } catch (e) {}
      var base = stored || state;
      if (base.opened.indexOf(key) === -1) railWriteReadState(railMarkOpened(base, key));
      var rows = document.querySelectorAll('#sumRailList .sum-latest-row');
      Array.prototype.forEach.call(rows, function(row) {
        if (row.getAttribute('data-rail-key') !== key) return;
        var dot = row.querySelector('.sum-latest-dot');
        if (dot) dot.remove();
      });
    }

    /** The rail column's markup — built once per page by openSummaryDoc. */
    function railScaffoldHtml() {
      return '<div class="sum-col-left sum-rail" id="sumLatestRail">' +
        '<button type="button" class="sum-rail-toggle" id="sumRailToggle" aria-expanded="false" aria-controls="sumRailBody">Latest</button>' +
        '<div class="sum-rail-collapsible" id="sumRailBody">' +
          '<div class="sum-rail-head">' +
            '<div class="sum-rail-views" role="group" aria-label="Rail view">' +
              '<button type="button" class="sum-rail-view" data-view="latest" aria-pressed="true">Latest</button>' +
              '<button type="button" class="sum-rail-view" data-view="category" aria-pressed="false">By category</button>' +
            '</div>' +
            '<div class="sum-rail-pane" data-pane="latest">' +
              '<input type="search" class="sum-rail-filter" id="sumRailFilter" placeholder="Filter" aria-label="Filter latest summaries" autocomplete="off">' +
            '</div>' +
            '<div class="sum-rail-chips sum-rail-pane" id="sumRailChips" data-pane="latest"></div>' +
          '</div>' +
          '<div class="sum-rail-pane" id="sumRailList" data-pane="latest"></div>' +
          '<div class="sum-rail-pane" id="sumCatPanel" data-pane="category" hidden></div>' +
        '</div>' +
      '</div>';
    }

    /** Wires the rail's controls once, by delegation, so a rebuild of the
     *  list never has to re-bind anything. */
    function railWire() {
      var rail = document.getElementById('sumLatestRail');
      if (!rail || rail.dataset.wired) return;
      rail.dataset.wired = '1';
      rail.addEventListener('click', function(e) {
        var t = e.target;
        var toggle = t.closest('#sumRailToggle');
        if (toggle) {
          var open = rail.classList.toggle('open');
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          return;
        }
        var view = t.closest('.sum-rail-view');
        if (view) { railSetView(view.getAttribute('data-view')); return; }
        var chip = t.closest('.sum-rail-chip');
        if (chip) { _railChip = chip.getAttribute('data-chip') || 'all'; railRebuild(); return; }
        var more = t.closest('.sum-rail-more');
        if (more) { _railCutoff = more.getAttribute('data-cutoff'); railRebuild(); return; }
        var row = t.closest('.sum-latest-row');
        if (row) {
          // A modified click keeps the link's own meaning (a new tab).
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          openSummaryDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'), row.getAttribute('data-source'));
        }
      });
      // toggle does not bubble; a capture listener still sees it.
      rail.addEventListener('toggle', function(e) {
        var d = e.target;
        if (!d.classList || !d.classList.contains('sum-latest-day')) return;
        var day = d.getAttribute('data-day');
        if (d.open) delete _railCollapsed[day]; else _railCollapsed[day] = true;
      }, true);
      var input = document.getElementById('sumRailFilter');
      if (input) input.addEventListener('input', function() { _railQuery = input.value; railRebuild(); });
    }

    function railSetView(view) {
      _railView = view === 'category' ? 'category' : 'latest';
      var rail = document.getElementById('sumLatestRail');
      if (!rail) return;
      rail.querySelectorAll('.sum-rail-view').forEach(function(b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-view') === _railView ? 'true' : 'false');
      });
      rail.querySelectorAll('.sum-rail-pane').forEach(function(p) {
        p.hidden = p.getAttribute('data-pane') !== _railView;
      });
      if (_railView === 'category') railRenderCategories();
    }

    function railRenderCategories() {
      if (_railView !== 'category' || !_railCurrentDoc) return;
      renderArticleCategories(docCategory(_railCurrentDoc.docId), _railCurrentDoc.docId);
    }

    /** Re-renders from the memo. Called on a domain-filter change. */
    function refreshLatestRail() {
      if (!document.getElementById('sumLatestRail')) return;
      getSummaryDocuments().then(function(docs) { renderLatestRail(docs); }).catch(function() {});
      if (_railView === 'category') loadLibrary().then(railRenderCategories);
    }

    /** The memo's force-refresh hook (sum-article-library's getSummaryDocuments):
     *  runs synchronously with the fresh listing, so a caller that awaits the
     *  refresh sees the rebuilt rail — the delete flow pulls rows after it. */
    function onSummaryListingRefreshed(docs) {
      if (!document.getElementById('sumLatestRail')) return;
      renderLatestRail(docs);
      if (_railView === 'category') loadLibrary().then(railRenderCategories);
    }

    function railRebuild() {
      getSummaryDocuments().then(function(docs) { renderLatestRail(docs); }).catch(function() {});
    }

    /** Builds the rail's chips and list from a listing. Keeps .current, the
     *  closed day groups and the scroll position. */
    function renderLatestRail(allDocs, opts) {
      var rail = document.getElementById('sumLatestRail');
      var list = document.getElementById('sumRailList');
      var chipsEl = document.getElementById('sumRailChips');
      if (!rail || !list || !chipsEl) return;
      _railBuilt = true;
      var shelfDocs = (allDocs || []).filter(function(d) {
        return d && d.id && d.id.indexOf('/') !== -1 && /\\.md$/.test(d.id);
      });
      var state = railReadState();
      if (state && shelfDocs.length) {
        var pruned = railPrune(state, shelfDocs);
        if (pruned !== state) railWriteReadState(pruned);
        state = _railRead;
      }
      var docs = shelfDocs.filter(matchesDomain);
      var today = railLocalDay(new Date());
      var initialCutoff = railInitialCutoff(today);
      var cutoff = _railCutoff && _railCutoff < initialCutoff ? _railCutoff : initialCutoff;

      // Chips: All, Unread (only with a read state), the four busiest
      // categories of the last 14 days. A chip that is gone resets to All.
      var cats = railBusiestCategories(docs, initialCutoff, 4);
      if (_railChip === 'unread' && !state) _railChip = 'all';
      if (_railChip.indexOf('cat:') === 0 && !cats.some(function(c) { return 'cat:' + c.key === _railChip; })) _railChip = 'all';
      var chips = [{ id: 'all', label: 'All', title: '' }];
      if (state) chips.push({ id: 'unread', label: 'Unread', title: '' });
      cats.forEach(function(c) { chips.push({ id: 'cat:' + c.key, label: c.label, title: c.key }); });
      chipsEl.innerHTML = chips.map(function(c) {
        return '<button type="button" class="sum-rail-chip" data-chip="' + esc(c.id) + '"' +
          (c.title ? ' title="' + esc(c.title) + '"' : '') +
          ' aria-pressed="' + (c.id === _railChip ? 'true' : 'false') + '">' + esc(c.label) + '</button>';
      }).join('');

      var win = railGroup(railFilter(docs, _railQuery, _railChip, state), cutoff);
      var html = win.days.map(function(g) {
        var rows = g.docs.map(function(d) {
          var key = railKey(d);
          var cur = key === _railCurrent;
          var href = '/summaries?doc=' + encodeURIComponent(d.id) + '&source=' + encodeURIComponent(d.source);
          return '<a class="sum-latest-row' + (cur ? ' current' : '') + '" href="' + esc(href) + '"' +
            (cur ? ' aria-current="true"' : '') +
            ' data-rail-key="' + esc(key) + '" data-doc-id="' + esc(d.id) + '" data-doc-url="' + esc(d.url || '') + '" data-source="' + esc(d.source) + '">' +
            '<span class="sum-latest-title">' +
              (railIsUnread(state, d) ? '<span class="sum-latest-dot" title="Unread" aria-label="Unread"></span>' : '') +
              esc(railTitle(d.id)) +
            '</span>' +
            '<span class="sum-latest-meta">' + sourceBadge(d.source) +
              '<span class="sum-latest-cat">' + esc(railCategoryLabel(railCategory(d.id))) + '</span>' +
            '</span>' +
          '</a>';
        }).join('');
        return '<details class="sum-latest-day" data-day="' + esc(g.day) + '"' + (_railCollapsed[g.day] ? '' : ' open') + '>' +
          '<summary><span>' + esc(railDayLabel(g.day, today)) + '</span>' +
          '<span class="sum-latest-day-count">' + g.docs.length + '</span></summary>' +
          '<div class="sum-latest-rows">' + rows + '</div>' +
        '</details>';
      }).join('');
      if (win.newestHidden) {
        html += '<button type="button" class="sum-rail-more" data-cutoff="' + esc(railNextCutoff(win.newestHidden)) + '">' +
          'Show older (' + win.hidden + ')</button>';
      }
      if (!html) html = '<div class="sum-rail-empty">No summaries match.</div>';

      // Only the list's children are replaced, so the column keeps its own
      // scrollTop (e2e-pinned) and the filter box keeps focus.
      list.innerHTML = html;
      if (opts && opts.scrollToCurrent) railScrollToCurrent();
    }

    function railScrollToCurrent() {
      var cur = document.querySelector('#sumRailList .sum-latest-row.current');
      if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
    }

    /** Called by openSummaryDoc: moves .current, marks the row read, and
     *  builds the rail the first time the panel opens. */
    function railOnOpen(docId, source) {
      _railCurrent = railKey({ source: source, id: docId });
      _railCurrentDoc = { docId: docId, source: source };
      if (SOURCES[source]) railMarkRead(source, docId);
      if (!_railBuilt) {
        railWire();
        getSummaryDocuments().then(function(docs) {
          renderLatestRail(docs, { scrollToCurrent: true });
        }).catch(function(err) {
          var list = document.getElementById('sumRailList');
          if (list) list.innerHTML = '<div class="sum-rail-empty">Failed to load: ' + esc(err.message || String(err)) + '</div>';
        });
      } else {
        document.querySelectorAll('#sumRailList .sum-latest-row').forEach(function(row) {
          var on = row.getAttribute('data-rail-key') === _railCurrent;
          row.classList.toggle('current', on);
          if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
        });
        railScrollToCurrent();
      }
      railRenderCategories();
    }

    // j / k: step through the rows the rail shows, opening each in place.
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'j' && e.key !== 'k') return;
      var overlay = document.getElementById('docOverlay');
      var ae = document.activeElement;
      var promptBackdrop = document.getElementById('promptModalBackdrop');
      var action = railKeyAction({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        panelOpen: !!overlay && overlay.classList.contains('visible'),
        editing: !!ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || !!ae.isContentEditable),
        dialogOpen: !!document.getElementById('${SHARE_DIALOG_ID}') ||
          (!!promptBackdrop && promptBackdrop.classList.contains('visible')) ||
          !!document.querySelector('dialog[open]'),
        menuOpen: Array.prototype.some.call(document.querySelectorAll('[role="menu"]'), function(m) {
          return !m.hidden && m.offsetParent !== null;
        }),
      });
      if (!action || _railView !== 'latest') return;
      var rows = Array.prototype.slice.call(document.querySelectorAll('#sumRailList details[open] .sum-latest-row'));
      var at = -1;
      rows.forEach(function(r, i) { if (r.classList.contains('current')) at = i; });
      var next = railStep(rows.length, at, action);
      if (next < 0) return;
      e.preventDefault();
      var row = rows[next];
      openSummaryDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'), row.getAttribute('data-source'));
    });
  `;
}
