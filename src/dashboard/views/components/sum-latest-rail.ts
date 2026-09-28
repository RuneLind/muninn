/** Summaries doc panel — the Latest rail (left column).
 *
 * The last 14 days of summaries, newest first, under day headings, with a
 * filter box, All / Unread / busiest-category chips, unread dots and `j`/`k`
 * stepping. The old category accordion stays one toggle away ("By category",
 * `renderArticleCategories` in sum-article-library.ts).
 *
 * The rail is built ONCE, when the panel first opens, and is not part of the
 * per-open rewrite: opening a summary only moves `.current`. It re-renders —
 * keeping `.current`, collapsed days, focus and scroll position — when the
 * listing memo is force-refreshed (a delete, a finished capture), a delete
 * pulls a row, or the domain filter changes. The pure logic lives in
 * src/summaries/latest-rail.ts and is injected here with `.toString()`, as
 * are the reader's shared key guards from wiki-panes.ts; this file is the DOM
 * half. It shares the page scope with sum-article-library.ts
 * (getSummaryDocuments, matchesDomain, docCategory, sourceBadge,
 * openSummaryDoc, renderArticleCategories, loadLibrary, docPanelOverlayOpen,
 * _docRequestId, SOURCES, esc) and sum-shelf.ts (isShelfDoc). */

import { RAIL_FUNCTIONS, RAIL_READ_STORAGE_KEY } from "../../../summaries/latest-rail.ts";
import { MODAL_SELECTOR, modalOpen, readerKeyRefused } from "./wiki-panes.ts";

export { RAIL_READ_STORAGE_KEY };

export function sumLatestRailStyles(): string {
  return `
    /* --- Latest rail (doc panel, left column) ---
       Small text uses --text-soft, not --text-muted, which is under AA on
       --bg-card in light (e2e-pinned contrast, both themes). */
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
    /* The second content value (alt text '') keeps the glyph out of the
       accessible name where the browser supports it. */
    .sum-latest-day > summary::before { content: '▸'; content: '▸' / ''; display: inline-block; width: 0.9em; }
    .sum-latest-day[open] > summary::before { content: '▾'; content: '▾' / ''; }
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
    /* --bg-hover, not --bg-surface: the column paints --bg-card, which is the
       same value as --bg-surface in both themes. */
    .sum-rail .sum-latest-row:hover { background: var(--bg-hover); color: var(--text-primary); text-decoration: none; }
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
    /* The shelf's status-coloured badge ink is under AA at 10px on its own
       tint in light; mixed toward --text-primary it passes in both themes
       (e2e-pinned: summaries-reader, "rail text and source badges"). */
    .sum-latest-meta .source-badge[data-source="youtube"] { color: color-mix(in srgb, var(--status-error) 70%, var(--text-primary)); }
    .sum-latest-meta .source-badge[data-source="x-article"] { color: color-mix(in srgb, var(--status-info) 70%, var(--text-primary)); }
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
    .sum-rail-toggle::before { content: '▸'; content: '▸' / ''; display: inline-block; width: 1.1em; }
    .sum-rail-toggle[aria-expanded="true"]::before { content: '▾'; content: '▾' / ''; }
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
    // The reader's shared key guards (wiki-panes.ts).
    var MODAL_SELECTOR = ${JSON.stringify(MODAL_SELECTOR)};
    var readerKeyRefused = ${readerKeyRefused.toString()};
    var modalOpen = ${modalOpen.toString()};

    var RAIL_READ_KEY = ${JSON.stringify(RAIL_READ_STORAGE_KEY)};
    var _railView = 'latest';     // 'latest' | 'category'
    var _railQuery = '';
    var _railChip = 'all';        // 'all' | 'unread' | 'cat:<path>'
    var _railCutoff = null;       // a "Show older" cutoff; null = the default 14 days
    var _railCollapsed = {};      // day -> true for a day group the reader closed
    var _railCurrent = '';        // railKey of the open summary
    var _railCurrentDoc = null;   // {docId, source} of the open summary
    var _railRead;                // undefined until loaded; null = storage failed
    var _railBuilt = false;       // wired and first render requested
    var _railLoadFailed = false;  // the first render's fetch failed: retry on the next open
    var _railDeleted = {};        // railKey -> the deleted row's modifiedTime; null until a listing shows it

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

    /** What storage holds NOW (another tab may have written), or null. */
    function railStoredReadState() {
      try { return railReadStateParse(localStorage.getItem(RAIL_READ_KEY)); } catch (e) { return null; }
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
      var base = railStoredReadState() || state;
      if (base.opened.indexOf(key) === -1) railWriteReadState(railMarkOpened(base, key));
      else _railRead = base;
      var rows = document.querySelectorAll('#sumRailList .sum-latest-row');
      Array.prototype.forEach.call(rows, function(row) {
        if (row.getAttribute('data-rail-key') !== key) return;
        var dot = row.querySelector('.sum-latest-dot');
        if (dot) dot.remove();
      });
    }

    /** Prunes the read state against a full listing, over what is stored NOW
     *  (another tab's reads survive), and returns the state to render with. */
    function railPruneReadState(docs) {
      var state = railReadState();
      if (!state) return null;
      var base = railStoredReadState() || state;
      var pruned = railPrune(base, docs);
      if (pruned !== base) railWriteReadState(pruned);
      else _railRead = base;
      return _railRead;
    }

    /** The rail column's markup — built once per page by openSummaryDoc. */
    function railScaffoldHtml() {
      return '<div class="sum-col-left sum-rail" id="sumLatestRail">' +
        '<button type="button" class="sum-rail-toggle" id="sumRailToggle" aria-expanded="false" aria-controls="sumRailBody" aria-label="Latest summaries">Latest</button>' +
        '<div class="sum-rail-collapsible" id="sumRailBody">' +
          '<div class="sum-rail-head">' +
            '<div class="sum-rail-views" role="group" aria-label="Rail view">' +
              '<button type="button" class="sum-rail-view" data-view="latest" aria-pressed="true">Latest</button>' +
              '<button type="button" class="sum-rail-view" data-view="category" aria-pressed="false">By category</button>' +
            '</div>' +
            '<div class="sum-rail-pane" data-pane="latest">' +
              '<input type="search" class="sum-rail-filter" id="sumRailFilter" placeholder="Filter" aria-label="Filter latest summaries" autocomplete="off">' +
            '</div>' +
            '<div class="sum-rail-chips sum-rail-pane" id="sumRailChips" data-pane="latest" role="group" aria-label="Show"></div>' +
          '</div>' +
          '<div class="sum-rail-pane" id="sumRailList" data-pane="latest"></div>' +
          '<div class="sum-rail-pane" id="sumCatPanel" data-pane="category" hidden></div>' +
        '</div>' +
      '</div>';
    }

    /** Below the breakpoint the rail is a collapsible block above the article. */
    function railNarrow() {
      return window.matchMedia('(max-width: 1000px)').matches;
    }

    function railSetOpen(open) {
      var rail = document.getElementById('sumLatestRail');
      var toggle = document.getElementById('sumRailToggle');
      if (!rail) return;
      rail.classList.toggle('open', open);
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    /** Wires the rail's controls once, by delegation, so a rebuild of the
     *  list never has to re-bind anything. */
    function railWire() {
      var rail = document.getElementById('sumLatestRail');
      if (!rail) return;
      rail.addEventListener('click', function(e) {
        var t = e.target;
        if (t.closest('#sumRailToggle')) {
          railSetOpen(!rail.classList.contains('open'));
          if (rail.classList.contains('open')) railReveal(railCurrentRow());
          return;
        }
        var view = t.closest('.sum-rail-view');
        if (view) { railSetView(view.getAttribute('data-view')); return; }
        var chip = t.closest('.sum-rail-chip');
        if (chip) { _railChip = chip.getAttribute('data-chip') || 'all'; railRefresh(); return; }
        var more = t.closest('.sum-rail-more');
        if (more) { _railCutoff = more.getAttribute('data-cutoff'); railRefresh(); return; }
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
      if (!input) return;
      input.addEventListener('input', function() { _railQuery = input.value; railRefresh(); });
      // Escape here clears the filter and stops: the panel's own Escape
      // listener is on the document and would close the panel.
      input.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (!input.value) return;
        input.value = '';
        _railQuery = '';
        railRefresh();
      });
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
      if (_railView === 'category') railRenderCategories(_docRequestId);
    }

    /** \`requestId\` is the open the render belongs to: a render that awaits the
     *  library bails when a newer open has taken the panel. */
    function railRenderCategories(requestId) {
      if (_railView !== 'category' || !_railCurrentDoc) return;
      renderArticleCategories(docCategory(_railCurrentDoc.docId), _railCurrentDoc.docId, requestId);
    }

    /**
     * Re-renders the rail. \`docs\` is a fresh listing (the memo's force-refresh
     * hook in getSummaryDocuments), or omitted to re-read the memo. In the By
     * category view, \`library\` is a docsByCategory rebuild already under way
     * (a promise), or true to start one.
     */
    function railRefresh(docs, library) {
      if (!document.getElementById('sumLatestRail')) return;
      if (docs) renderLatestRail(docs);
      else getSummaryDocuments().then(function(d) { renderLatestRail(d); }).catch(function() {});
      if (_railView === 'category' && library) {
        (library === true ? loadLibrary() : library).then(function() { railRenderCategories(_docRequestId); });
      }
    }

    /** Called by removeDocRows after a delete: the row goes, and the day
     *  counts with it, even while huginn's listing still lists the doc. The
     *  delete flow calls it again after its refetch; that call keeps the
     *  modifiedTime the first one's render recorded. */
    function railForgetDoc(docId, source) {
      var key = railKey({ source: source, id: docId });
      if (!Object.prototype.hasOwnProperty.call(_railDeleted, key)) _railDeleted[key] = null;
      railRefresh();
    }

    /**
     * Whether a listed row is a deleted doc that huginn still lists. The first
     * listing to show a deleted key records its modifiedTime: that is the
     * memo the delete's own re-render reads, so it is the deleted row. A later
     * listing with the same modifiedTime lags, and the row stays hidden; a
     * different one is a re-capture, so the row shows and the key goes. A key
     * never goes on absence: the documents route answers 200 when one source
     * fails, so an absent row does not prove huginn caught up.
     */
    function railHidesDeleted(d) {
      var key = railKey(d);
      if (!Object.prototype.hasOwnProperty.call(_railDeleted, key)) return false;
      var mtime = d.modifiedTime || null;
      if (_railDeleted[key] === null) _railDeleted[key] = mtime;
      if (_railDeleted[key] === mtime) return true;
      delete _railDeleted[key];
      return false;
    }

    /** What has focus inside the rail, as something a rebuild can find again. */
    function railFocusMark(chipsEl, list) {
      var ae = document.activeElement;
      if (!ae || ae === document.body) return null;
      if (chipsEl.contains(ae)) return { chip: ae.getAttribute('data-chip') };
      if (!list.contains(ae)) return null;
      if (ae.classList.contains('sum-rail-more')) return { day: ae.getAttribute('data-newest') };
      if (ae.classList.contains('sum-latest-row')) return { key: ae.getAttribute('data-rail-key') };
      var d = ae.closest('.sum-latest-day');
      return d ? { summary: d.getAttribute('data-day') } : null;
    }

    function railFocusRestore(mark, chipsEl, list) {
      if (!mark) return;
      var target = null;
      if (mark.chip) {
        target = Array.prototype.find.call(chipsEl.querySelectorAll('.sum-rail-chip'), function(c) {
          return c.getAttribute('data-chip') === mark.chip;
        }) || chipsEl.querySelector('.sum-rail-chip');
      } else if (mark.day) {
        // Show older: land on the first row of the day it revealed.
        target = list.querySelector('.sum-latest-day[data-day="' + mark.day + '"] .sum-latest-row') ||
          list.querySelector('.sum-rail-more');
      } else if (mark.key) {
        target = Array.prototype.find.call(list.querySelectorAll('.sum-latest-row'), function(r) {
          return r.getAttribute('data-rail-key') === mark.key;
        });
      } else if (mark.summary) {
        target = list.querySelector('.sum-latest-day[data-day="' + mark.summary + '"] > summary');
      }
      if (!target) return;
      // A rebuild keeps the column's scroll: only Show older, which asked
      // for a day, scrolls to the row it lands on.
      target.focus({ preventScroll: true });
      if (mark.day && target.classList.contains('sum-latest-row')) railReveal(target);
    }

    /** Builds the rail's chips and list from a listing. Keeps .current, the
     *  closed day groups, focus and the scroll position. */
    function renderLatestRail(allDocs, opts) {
      var rail = document.getElementById('sumLatestRail');
      var list = document.getElementById('sumRailList');
      var chipsEl = document.getElementById('sumRailChips');
      if (!rail || !list || !chipsEl) return;
      var shelfDocs = (allDocs || []).filter(isShelfDoc);
      var state = railPruneReadState(shelfDocs);
      var docs = shelfDocs.filter(function(d) { return !railHidesDeleted(d) && matchesDomain(d); });
      var today = railUtcDay(new Date());
      var initialCutoff = railWindowStart(today);
      var cutoff = _railCutoff && _railCutoff < initialCutoff ? _railCutoff : initialCutoff;
      var focus = railFocusMark(chipsEl, list);

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
          var t = railTitle(d.id);
          var href = '/summaries?doc=' + encodeURIComponent(d.id) + '&source=' + encodeURIComponent(d.source);
          return '<a class="sum-latest-row' + (cur ? ' current' : '') + '" href="' + esc(href) + '"' +
            (cur ? ' aria-current="true"' : '') + ' title="' + esc(t) + '"' +
            ' data-rail-key="' + esc(key) + '" data-doc-id="' + esc(d.id) + '" data-doc-url="' + esc(d.url || '') + '" data-source="' + esc(d.source) + '">' +
            '<span class="sum-latest-title">' +
              (railIsUnread(state, d) ? '<span class="sum-latest-dot" role="img" title="Unread" aria-label="Unread"></span>' : '') +
              esc(t) +
            '</span>' +
            '<span class="sum-latest-meta">' + sourceBadge(d.source) +
              '<span class="sum-latest-cat">' + esc(railCategoryLabel(railCategory(d.id))) + '</span>' +
            '</span>' +
          '</a>';
        }).join('');
        var label = railDayLabel(g.day, today);
        var n = g.docs.length;
        return '<details class="sum-latest-day" data-day="' + esc(g.day) + '"' + (_railCollapsed[g.day] ? '' : ' open') + '>' +
          '<summary aria-label="' + esc(label + ', ' + n + (n === 1 ? ' summary' : ' summaries')) + '">' +
            '<span>' + esc(label) + '</span><span class="sum-latest-day-count">' + n + '</span></summary>' +
          '<div class="sum-latest-rows">' + rows + '</div>' +
        '</details>';
      }).join('');
      if (win.newestHidden) {
        html += '<button type="button" class="sum-rail-more" data-cutoff="' + esc(railWindowStart(win.newestHidden)) + '"' +
          ' data-newest="' + esc(win.newestHidden) + '">Show older (' + win.hidden + ')</button>';
      }
      if (!html) html = '<div class="sum-rail-empty">No summaries match.</div>';

      // Only the list's children are replaced, so the column keeps its own
      // scrollTop (e2e-pinned) and the filter box keeps focus.
      list.innerHTML = html;
      railFocusRestore(focus, chipsEl, list);
      if (opts && opts.scrollToCurrent) railReveal(railCurrentRow());
    }

    /** Is the row on screen as far as layout goes? A collapsed narrow rail
     *  gives it no box; a closed day may still give it one (Chromium hides
     *  closed details content with content-visibility), so check both. */
    function railRowShown(row) {
      return !!row && row.getClientRects().length > 0 && !row.closest('details:not([open])');
    }

    function railCurrentRow() {
      return document.querySelector('#sumRailList .sum-latest-row.current');
    }

    /** Scrolls a row into view in whatever scrolls it: the column when wide,
     *  where the sticky head sits over the top of the scrollport; the panel
     *  body when narrow and open. A row that is not rendered (a collapsed
     *  narrow rail, a closed day) scrolls nothing, so an open never moves the
     *  panel body away from the article. */
    function railReveal(row) {
      var rail = document.getElementById('sumLatestRail');
      if (!rail || !railRowShown(row)) return;
      var head = rail.querySelector('.sum-rail-head');
      rail.style.scrollPaddingTop = head && getComputedStyle(head).position === 'sticky'
        ? (head.offsetHeight + 4) + 'px' : '';
      if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    }

    /** Called by openSummaryDoc: moves .current, marks the row read, and
     *  builds the rail the first time the panel opens. \`requestId\` is that
     *  open's, for the By category render. */
    function railOnOpen(docId, source, requestId) {
      _railCurrent = railKey({ source: source, id: docId });
      _railCurrentDoc = { docId: docId, source: source };
      if (SOURCES[source]) railMarkRead(source, docId);
      var rail = document.getElementById('sumLatestRail');
      // Narrow: an open from the expanded rail is a choice made — fold the
      // rail so the article, not the list, is what the reader sees.
      if (rail && railNarrow() && rail.classList.contains('open')) {
        var hadFocus = rail.contains(document.activeElement);
        railSetOpen(false);
        if (hadFocus) document.getElementById('sumRailToggle').focus({ preventScroll: true });
      }
      if (!_railBuilt || _railLoadFailed) {
        if (!_railBuilt) railWire();
        _railBuilt = true;
        _railLoadFailed = false;
        getSummaryDocuments().then(function(docs) {
          renderLatestRail(docs, { scrollToCurrent: true });
        }).catch(function(err) {
          _railLoadFailed = true;
          var list = document.getElementById('sumRailList');
          if (list) list.innerHTML = '<div class="sum-rail-empty">Failed to load: ' + esc(err.message || String(err)) + '</div>';
        });
      } else {
        document.querySelectorAll('#sumRailList .sum-latest-row').forEach(function(row) {
          var on = row.getAttribute('data-rail-key') === _railCurrent;
          row.classList.toggle('current', on);
          if (on) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
        });
        railReveal(railCurrentRow());
      }
      railRenderCategories(requestId);
    }

    // j / k: step through the rows the rail shows, opening each in place.
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'j' && e.key !== 'k') return;
      var overlay = document.getElementById('docOverlay');
      var t = e.target;
      var action = railKeyAction({
        key: e.key,
        refused: readerKeyRefused({
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          repeat: e.repeat,
          targetTag: t && t.tagName,
          targetEditable: !!(t && t.isContentEditable),
          targetInDialog: !!(t && t.closest && t.closest('[aria-modal="true"], dialog[open]')) || modalOpen(document),
        }),
        panelOpen: !!overlay && overlay.classList.contains('visible'),
        overlayOpen: docPanelOverlayOpen(),
      });
      if (!action || _railView !== 'latest') return;
      // Only rows that are rendered: a closed day or a collapsed narrow rail
      // hides its rows, and j must not open what the reader cannot see.
      var rows = Array.prototype.filter.call(document.querySelectorAll('#sumRailList .sum-latest-row'), railRowShown);
      var at = -1;
      rows.forEach(function(r, i) { if (r.classList.contains('current')) at = i; });
      var next = railStep(rows.length, at, action);
      if (next < 0) return;
      e.preventDefault();
      var row = rows[next];
      var ae = document.activeElement;
      var focusFollows = !!ae && !!ae.classList && ae.classList.contains('sum-latest-row');
      openSummaryDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'), row.getAttribute('data-source'));
      // Focus moves with .current, so Enter opens the row the reader is on.
      if (focusFollows && railRowShown(row)) row.focus({ preventScroll: true });
    });
  `;
}
