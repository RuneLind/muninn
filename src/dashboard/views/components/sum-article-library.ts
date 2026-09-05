/** Summaries page — the 3-column doc panel + the shared doc helpers.
 *
 * Since the inbox-first redesign this component no longer renders a visible
 * "Article Library" section (category browsing moved onto the Shelf tab as a
 * filter — see sum-shelf.ts). It remains the home of the shared doc helpers
 * (getSummaryDocuments, docTitle, docCategory, matchesDomain, renderDomainFilter,
 * sourceBadge, sourceLink, openSummaryDoc) and the 3-column doc panel (article
 * text · category sidebar · similar), which the Shelf + candidate rows open into.
 * `loadLibrary` survives only to build `docsByCategory`, which the doc panel's
 * category sidebar (renderArticleCategories) reads; its old chip/grid DOM writes
 * are guarded no-ops now that the visible section is gone. Source-agnostic:
 * categories are computed from the merged /api/summaries/documents listing, and
 * each doc carries its `source` so opens/similar/original-link route to the right
 * collection (SOURCES[source].apiBase). */

import { docPanelStyles, DOC_PANEL_SHARE_BTN_ID, DOC_PANEL_DELETE_BTN_ID } from "./doc-panel.ts";
import { SHARE_DIALOG_ID, summaryShareTargetScript } from "./wiki-share-dialog.ts";

/** The whole /summaries share target as a browser expression — URLs, surface
 *  copy AND the two identity field NAMES, all emitted by the shared builder so
 *  the page script cannot spell a key the route does not read. Only the two
 *  VALUES are ours. */
const SUMMARY_SHARE_TARGET_JS = summaryShareTargetScript("_shareDoc.source", "_shareDoc.docId");

export function sumArticleLibraryStyles(): string {
  return `
    /* --- Article Library --- */
    .library-section {
      margin-top: 40px;
      border-top: 1px solid var(--border-primary);
      padding-top: 24px;
    }
    .library-header {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 16px;
    }
    .library-header h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    .library-header .count {
      font-size: 13px;
      color: var(--text-dim);
    }
    .category-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .cat-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card);
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .cat-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .cat-chip.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }
    .cat-chip .chip-count {
      font-size: 11px;
      color: var(--text-dim);
      font-weight: 600;
    }
    .cat-chip.active .chip-count { color: var(--accent-light); }

    .articles-grid {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 16px;
    }
    .article-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      text-decoration: none;
      transition: border-color 0.15s;
    }
    .article-row:hover { border-color: var(--accent); }
    .article-row-title {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .article-row-link {
      font-size: 12px;
      color: var(--text-dim);
      text-decoration: none;
      flex-shrink: 0;
    }
    .article-row-link:hover { color: var(--accent-light); }

    ${docPanelStyles("sumSlideIn")}

    /* --- Article view: 3-column layout (categories | text | similar) ---
       Scoped to this page only; overrides the shared single-column doc panel
       above. Wider panel so all three columns fit comfortably. */
    .doc-panel { width: 100vw; }
    .doc-panel-body {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 300px;
      gap: 24px;
      align-items: start;
    }
    /* min-width:0 lets code blocks shrink; cap + center the reading column so
       full-page width doesn't stretch lines uncomfortably wide */
    .sum-col-main { min-width: 0; max-width: 1000px; justify-self: center; }
    .sum-col-left, .sum-col-right {
      position: sticky;
      top: 0;
      align-self: start;
      max-height: calc(100vh - 96px);
      overflow-y: auto;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 14px;
    }
    .sum-side-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin: 0 0 10px;
    }
    .sum-cat-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .sum-cat-row:hover { background: var(--bg-surface); color: var(--text-primary); }
    .sum-cat-row.active { color: var(--accent-light); }
    .sum-cat-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sum-cat-count { font-size: 11px; color: var(--text-dim); font-weight: 600; }
    .sum-cat-articles { padding: 2px 0 8px 10px; display: flex; flex-direction: column; gap: 2px; }
    /* the [hidden] attribute's UA "display:none" loses to the rule above, so
       restate it with higher specificity — this is what actually collapses
       a category list (and makes the row-click toggle work) */
    .sum-cat-articles[hidden] { display: none; }
    .sum-cat-article {
      font-size: 12px;
      color: var(--text-dim);
      text-decoration: none;
      padding: 3px 6px;
      border-radius: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sum-cat-article:hover { color: var(--text-primary); background: var(--bg-surface); }
    .sum-cat-article.current { color: var(--accent-light); font-weight: 600; }

    /* Collapse to a single column on narrow viewports */
    @media (max-width: 1000px) {
      .doc-panel-body { grid-template-columns: 1fr; }
      .sum-col-left, .sum-col-right { position: static; max-height: none; }
    }

    .doc-similar { padding: 0; margin: 0; }
    .doc-similar h4 {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin: 0 0 10px;
    }
    .doc-similar-item {
      padding: 6px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border-primary) 50%, transparent);
    }
    .doc-similar-item:last-child { border-bottom: none; }
    .doc-similar-item a {
      font-size: 13px;
      color: var(--accent-light);
      text-decoration: none;
    }
    .doc-similar-item a:hover { text-decoration: underline; }
    .doc-similar-relevance {
      font-size: 11px;
      color: var(--text-dim);
      margin-left: 8px;
    }
  `;
}

export function sumArticleLibraryHtml(): string {
  // No visible section any more — category browsing lives on the Shelf tab now.
  // The doc panel scaffold comes from the page's docPanelHtml(); this component
  // only contributes styles + shared script.
  return "";
}

export function sumArticleLibraryScript(): string {
  return `
    // --- Shared doc helpers (used across all summaries components) ---

    function docTitle(docId) {
      // "ai/claude-code/Some Title.md" -> "Some Title"
      var parts = docId.split('/');
      var filename = parts[parts.length - 1] || docId;
      return filename.replace(/\\.md$/, '');
    }

    function docCategory(docId) {
      // "ai/claude-code/Some Title.md" -> "ai/claude-code"
      var parts = docId.split('/');
      if (parts.length >= 2) return parts.slice(0, -1).join('/');
      return 'uncategorized';
    }

    // --- Domain filter (AI vs Life) ---
    // Page-global filter derived from each doc's category. DOMAIN_MAP (injected
    // from src/summaries/domain.ts) maps a category's top segment to a domain;
    // this mirrors categoryToDomain: split on slash, look up the top segment,
    // default to ai. null activeDomain = show all domains. Composes with the
    // Recently Added source filter (both apply) and narrows the Article Library.
    var activeDomain = null;

    function docDomain(docId) {
      var top = docCategory(docId).split('/')[0];
      return DOMAIN_MAP[top] || 'ai';
    }

    function matchesDomain(doc) {
      return !activeDomain || docDomain(doc.id) === activeDomain;
    }

    // Render the All / AI / Life domain chips into #domainFilter (which sits
    // alongside the source chips in Recently Added). Counts come from the full
    // format-filtered archive. Clicking a chip sets activeDomain and re-renders
    // both the library and the recently-added list from cache.
    var DOMAIN_LABELS = { ai: 'AI', life: 'Life' };
    async function renderDomainFilter() {
      var el = document.getElementById('domainFilter');
      if (!el) return;
      var docs = (await getSummaryDocuments()).filter(function(d) {
        return d.id && d.id.includes('/') && d.id.endsWith('.md');
      });
      var counts = { ai: 0, life: 0 };
      docs.forEach(function(d) { counts[docDomain(d.id)]++; });
      var order = ['ai', 'life'];
      var chips = ['<span class="source-chip' + (activeDomain === null ? ' active' : '') +
        '" data-domain="">All <span class="chip-count">' + docs.length + '</span></span>'];
      order.forEach(function(id) {
        if (!counts[id]) return;  // skip an empty domain
        chips.push('<span class="source-chip' + (activeDomain === id ? ' active' : '') +
          '" data-domain="' + esc(id) + '">' + esc(DOMAIN_LABELS[id] || id) +
          ' <span class="chip-count">' + counts[id] + '</span></span>');
      });
      el.innerHTML = chips.join('');
      el.querySelectorAll('.source-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          var d = chip.getAttribute('data-domain');
          activeDomain = d || null;
          // Reset the source filter too: the previously-selected source may not
          // exist in the new domain, which would strand the list on an empty
          // result with no source chips to recover from.
          if (typeof activeSource !== 'undefined') activeSource = null;
          if (typeof activeShelfCategory !== 'undefined') activeShelfCategory = null;
          renderDomainFilter();
          loadLibrary();  // rebuild docsByCategory (doc-panel sidebar) for the new domain
          if (typeof loadShelf === 'function') loadShelf();
        });
      });
    }

    // Per-source API prefix lookup with a youtube fallback for legacy deep links.
    function docApiBase(source) {
      var s = SOURCES[source];
      return s ? s.apiBase : '/api/youtube';
    }

    function sourceBadge(sourceId) {
      var s = SOURCES[sourceId];
      var label = s ? s.badge : sourceId;
      return '<span class="source-badge" data-source="' + esc(sourceId || '') + '">' + esc(label || '') + '</span>';
    }

    // "Open original" anchor. cls picks the row style (recent vs library list).
    function sourceLink(doc, cls) {
      if (!doc.url) return '';
      var s = SOURCES[doc.source];
      var label = s ? s.linkLabel : 'Open ↗';
      return '<a class="' + (cls || 'recent-item-link') + '" href="' + esc(doc.url) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + '</a>';
    }

    // Single shared fetch of the merged document archive, used by the library,
    // the Recently Added list, and the doc panel's category sidebar. Memoized so
    // one page load doesn't pull the (date-enriched, read-every-file) listing
    // more than once; throws on an upstream error so callers show a failure
    // instead of a misleading empty state. Pass force=true to refresh after an
    // ingest completes.
    var _sumDocsPromise = null;
    function getSummaryDocuments(force) {
      if (force || !_sumDocsPromise) {
        _sumDocsPromise = fetch('/api/summaries/documents').then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function(data) {
          if (data && data.error) throw new Error(data.error);
          return (data && data.documents) || [];
        }).catch(function(err) {
          _sumDocsPromise = null;  // don't cache a failure — allow retry
          throw err;
        });
      }
      return _sumDocsPromise;
    }

    // --- Doc panel close/escape ---
    // Doc-panel request id. Bumped on every openSummaryDoc and on close; every
    // async continuation captures the id at entry and bails if it no longer
    // matches the current value. Stops a slow A response from overwriting a
    // newer B panel via the stable #sumArticleMain / #docSimilarPanel / #sumCatPanel
    // ids the scaffold reuses.
    var _docRequestId = 0;

    function closeDocPanel() {
      _docRequestId++;  // invalidate any in-flight openSummaryDoc/loadDocSimilar
      // The share dialog opens OVER this panel and its state is module-held —
      // leaving it up over a closed panel would name a document nothing is
      // showing, and Generate would still summarize it. Same seam (and same
      // reason) as the reader's closeShareDialogOnNavigate.
      if (typeof closeShareDialog === 'function') closeShareDialog();
      document.getElementById('docOverlay').classList.remove('visible');
      document.body.style.overflow = '';
    }
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      // The share dialog handles its OWN Escape (cancel a run, then close), and
      // both listeners sit on the document — without this guard one Escape closed
      // the dialog AND the panel behind it, throwing away an un-copied post. (The
      // dialog also calls stopImmediatePropagation, but THIS listener is wired at
      // page load and the dialog's lazily on first open, so ours runs first: the
      // guard is what actually holds today.)
      if (document.getElementById('${SHARE_DIALOG_ID}')) return;
      if (document.getElementById('docOverlay').classList.contains('visible')) {
        closeDocPanel();
      }
    });

    // --- 📤 Share (opt-in: only pages rendering docPanelHtml({share:true}) and
    // mounting the share-dialog bundle have the button and the global). The
    // panel is retargeted in place by the similar/category links, so the doc the
    // button acts on is held here rather than read off the DOM.
    var _shareDoc = null;
    (function() {
      var btn = document.getElementById('${DOC_PANEL_SHARE_BTN_ID}');
      if (!btn) return;
      btn.addEventListener('click', function() {
        // Resolved at CLICK time, not at wire time: the bundle publishing this
        // global is a separate <script>, and depending on tag order for a
        // silent no-op is the kind of thing that survives review.
        if (typeof openShareDialog !== 'function') {
          // A page that rendered the button without mounting
          // share-dialog-client.ts is a wiring mistake, not a state the reader
          // can cause — so it says so instead of dying quietly on every click.
          console.warn('[summaries] Share is unavailable: the share-dialog bundle is not loaded on this page.');
          return;
        }
        // No doc, or a doc whose source is not registered (see openSummaryDoc)
        // — the button is hidden in that case, so this is the belt to its braces.
        if (!_shareDoc) return;
        openShareDialog({
          // wiki/page are the /wiki surface's identity; this surface posts
          // {source, docId} to /api/summaries/share via the target below. page
          // still carries the doc id, so the dialog's own re-target comparison
          // keeps working.
          wiki: '',
          page: _shareDoc.docId,
          title: _shareDoc.title,
          openerIds: ['${DOC_PANEL_SHARE_BTN_ID}'],
          // Emitted WHOLE by the shared summaryShareTarget builder — endpoint,
          // presets URL, surface copy and both identity field NAMES. Only the
          // two values below are this page's.
          target: ${SUMMARY_SHARE_TARGET_JS},
        });
      });
    })();

    // --- 🗑 Delete (opt-in: docPanelHtml({remove:true}), /summaries only). Acts on
    // the same held doc as Share. Posts to the gardener's backlog-doc-delete route
    // against DELETE_TARGET.wiki — resolved server-side (summaries/delete-target.ts),
    // never inferred here. Success closes the panel and pulls the doc's rows off the
    // page at once; huginn's LISTING only drops it once its reindex lands, so the
    // shelf is refetched after the status poll goes terminal and the rows are pulled
    // again after that re-render. Every outcome, failure included, lands in the
    // page-level notice AFTER the panel is closed — the panel is a fixed scrim over
    // the page, so a notice written behind it is a notice nobody sees.
    (function() {
      var btn = document.getElementById('${DOC_PANEL_DELETE_BTN_ID}');
      if (!btn) return;
      btn.addEventListener('click', function() {
        if (!_shareDoc || btn.disabled) return;
        var doc = _shareDoc;
        var collection = SOURCES[doc.source].collection;
        if (!window.confirm('Delete "' + doc.title + '"?\\n\\nThis removes the summary from huginn (' + collection + ') and deletes the wiki draft written from it. An already-applied wiki page is kept.')) return;
        // Disabled for the POST only — the poll/refetch tail runs for up to two
        // minutes, and the panel (and this button) is reused for the next doc.
        btn.disabled = true;
        deleteSummaryDoc(collection, doc.docId, doc.source, doc.title, function() { btn.disabled = false; });
      });
      var notice = document.getElementById('deleteNotice');
      if (notice) notice.addEventListener('click', function() { notice.classList.remove('visible'); });
    })();

    function showDeleteNotice(text, tone) {
      var el = document.getElementById('deleteNotice');
      if (!el) return;
      el.textContent = text;
      el.classList.toggle('err', tone === 'err');
      el.classList.add('visible');
      el.scrollIntoView({ block: 'nearest' });
    }

    // Pull the doc's rows off the page: shelf rows and library rows carry BOTH
    // data-doc-id and data-source, and both must match — a doc id is
    // collection-relative, so the same id can exist in two verticals, and the
    // Candidates tab's cards carry a data-doc-id of their own that names a
    // candidate row, not a summary. (The panel's similar-items list carries no
    // data-source; the panel is closed by the time this runs.)
    function removeDocRows(docId, source) {
      document.querySelectorAll('[data-doc-id][data-source]').forEach(function(el) {
        if (el.getAttribute('data-doc-id') === docId && el.getAttribute('data-source') === source) el.remove();
      });
    }

    function deleteWikiUrl(path) {
      return path + (path.indexOf('?') === -1 ? '?' : '&') + 'wiki=' + encodeURIComponent(DELETE_TARGET.wiki);
    }

    async function deleteSummaryDoc(collection, docId, source, title, onPosted) {
      var body;
      try {
        var res = await fetch(deleteWikiUrl('/api/wiki/gardener/backlog-doc-delete'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collection: collection, id: docId }),
        });
        body = await res.json().catch(function() { return {}; });
        if (!res.ok) {
          closeDocPanel();
          showDeleteNotice('Delete failed: ' + (body.error || ('HTTP ' + res.status)), 'err');
          return;
        }
      } catch (err) {
        closeDocPanel();
        showDeleteNotice('Delete failed: could not reach the server', 'err');
        return;
      } finally {
        onPosted();
      }

      closeDocPanel();
      removeDocRows(docId, source);
      var proposals = body.proposals || { deleted: [], kept: [] };
      var parts = ['Deleted "' + title + '"'];
      if (proposals.deleted.length) parts.push('and ' + proposals.deleted.length + ' wiki draft' + (proposals.deleted.length === 1 ? '' : 's') + ' written from it');
      if (proposals.kept.length) parts.push('(kept the applied page' + (proposals.kept.length === 1 ? ' ' : 's ') + proposals.kept.map(function(p) { return p.targetPath; }).join(', ') + ')');
      showDeleteNotice(parts.join(' ') + '.', 'ok');

      // Wait for the reindex huginn started; then the listing is trustworthy again.
      var polling = Array.isArray(body.polling) ? body.polling : [];
      var skipped = Array.isArray(body.skipped) ? body.skipped : [];
      var unresolved = await waitForDeleteReindex(polling);
      var caveats = [];
      if (!polling.length && !skipped.length) caveats.push('huginn started no reindex');
      if (skipped.length) caveats.push('a reindex was already running for ' + skipped.join(', '));
      if (unresolved.length) caveats.push('the reindex for ' + unresolved.join(', ') + ' never reported finishing');
      if (caveats.length) {
        showDeleteNotice(parts.join(' ') + ' — but ' + caveats.join(' and ') + ', so it may reappear in the list until the next index run.', 'ok');
      }
      // Refetch ONCE through the memo (getSummaryDocuments(true) is the only call
      // that throws — loadShelf and loadLibrary each swallow their own failures
      // into their own "Failed to load…" element, so a catch around THEM is dead
      // code), then let both renderers ride on the fresh memo, AWAITED so the
      // re-render is done before the rows are pulled again — the doc is gone from
      // disk whatever the listing still says.
      try {
        await getSummaryDocuments(true);
        if (typeof loadShelf === 'function') await loadShelf();
        if (typeof loadLibrary === 'function') await loadLibrary();
        removeDocRows(docId, source);
      } catch (e) {
        showDeleteNotice(parts.join(' ') + ' — but the listing could not be reloaded: ' + (e && e.message ? e.message : e), 'err');
      }
    }

    // Poll each started collection's update-status until terminal. Same budget as
    // the gardener page's waitForReindex (REINDEX_POLL_MAX_MS 120 s / 2 s ticks /
    // 3 strikes on idle-or-unknown) — a reindex that page would still wait on must
    // not be reported here as never finishing.
    async function waitForDeleteReindex(collections) {
      var pending = collections.slice();
      var unresolved = [];
      var strikes = {};
      var deadline = Date.now() + 120000;
      while (pending.length && Date.now() < deadline) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        for (var i = pending.length - 1; i >= 0; i--) {
          var coll = pending[i];
          var status = 'unknown';
          try {
            var r2 = await fetch(deleteWikiUrl('/api/wiki/gardener/backlog-doc-delete-status?collection=' + encodeURIComponent(coll)));
            status = ((await r2.json()) || {}).status || 'unknown';
          } catch (e) { /* strike */ }
          if (status === 'succeeded' || status === 'failed') {
            pending.splice(i, 1);
          } else if (status === 'running') {
            strikes[coll] = 0;
          } else {
            strikes[coll] = (strikes[coll] || 0) + 1;
            if (strikes[coll] >= 3) { pending.splice(i, 1); unresolved.push(coll); }
          }
        }
      }
      return unresolved.concat(pending);
    }

    // --- Article Library ---
    var allDocuments = [];
    var docsByCategory = {};
    var activeCategory = null;

    async function loadLibrary() {
      try {
        var allDocs = await getSummaryDocuments();

        allDocuments = allDocs.filter(function(d) {
          // Skip non-summary files (chrome-extension etc)
          return d.id.includes('/') && d.id.endsWith('.md');
        });

        // Group docs by category (computed from the merged listing — categories
        // naturally merge across sources since they share the same taxonomy).
        // The active domain chip narrows which docs (and therefore which
        // category chips) are shown.
        docsByCategory = {};
        allDocuments.filter(matchesDomain).forEach(function(doc) {
          var cat = docCategory(doc.id);
          if (!docsByCategory[cat]) docsByCategory[cat] = [];
          docsByCategory[cat].push(doc);
        });

        // Sort docs within each category by title
        Object.values(docsByCategory).forEach(function(docs) {
          docs.sort(function(a, b) { return docTitle(a.id).localeCompare(docTitle(b.id)); });
        });

        // Count reflects the active domain (docsByCategory is already narrowed).
        // The visible library section is gone — these writes no-op unless a legacy
        // element is present (guarded), but docsByCategory is now built for the
        // doc-panel category sidebar.
        var visibleCount = Object.values(docsByCategory).reduce(function(n, ds) { return n + ds.length; }, 0);
        var libCountEl = document.getElementById('libraryCount');
        if (libCountEl) libCountEl.textContent = visibleCount + ' articles';

        // If the domain change dropped the open category, collapse its grid.
        if (activeCategory && !docsByCategory[activeCategory]) {
          activeCategory = null;
          var grid = document.getElementById('articlesGrid');
          if (grid) grid.innerHTML = '';
        }

        // Render category chips with counts (highest first) — guarded no-op now
        // that the visible library section is retired.
        var chipsEl = document.getElementById('categoryChips');
        if (chipsEl) {
          var chips = Object.keys(docsByCategory)
            .map(function(name) { return { name: name, count: docsByCategory[name].length }; })
            .sort(function(a, b) { return b.count - a.count; })
            .map(function(cat) {
              return '<span class="cat-chip" data-category="' + esc(cat.name) + '" onclick="toggleCategory(this)">' +
                esc(cat.name) +
                ' <span class="chip-count">' + cat.count + '</span>' +
              '</span>';
            }).join('');
          chipsEl.innerHTML = chips || '<div style="color:var(--text-dim);font-size:13px;">No categories found</div>';
        }
      } catch (err) {
        console.error('loadLibrary failed:', err);
        var failEl = document.getElementById('categoryChips');
        if (failEl) failEl.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">Failed to load library: ' + (err.message || err) + '</div>';
      }
    }

    function toggleCategory(chip) {
      var cat = chip.getAttribute('data-category');
      var grid = document.getElementById('articlesGrid');
      if (!grid) return;  // visible library section retired — nothing to expand into

      if (activeCategory === cat) {
        // Collapse
        activeCategory = null;
        chip.classList.remove('active');
        grid.innerHTML = '';
        return;
      }

      // Deactivate previous
      document.querySelectorAll('.cat-chip.active').forEach(function(c) { c.classList.remove('active'); });
      activeCategory = cat;
      chip.classList.add('active');

      // Find docs for this category
      var docs = docsByCategory[cat] || [];
      if (docs.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:12px 0;">No articles in this category</div>';
        return;
      }

      grid.innerHTML = docs.map(function(doc) {
        var title = docTitle(doc.id);
        return '<div class="article-row" data-doc-id="' + esc(doc.id) + '" data-doc-url="' + esc(doc.url || '') + '" data-source="' + esc(doc.source) + '">' +
          sourceBadge(doc.source) +
          '<span class="article-row-title">' + esc(title) + '</span>' +
          sourceLink(doc, 'article-row-link') +
        '</div>';
      }).join('');

      // Delegate clicks on article rows
      grid.querySelectorAll('.article-row').forEach(function(row) {
        row.addEventListener('click', function() {
          openSummaryDoc(row.getAttribute('data-doc-id'), row.getAttribute('data-doc-url'), row.getAttribute('data-source'));
        });
      });
    }

    /**
     * The video id in a Vimeo url — a CLIENT mirror of the host-gated rule in
     * src/vimeo/url.ts, kept to the two shapes the stored documents carry
     * (vimeo.com/<id> and player.vimeo.com/video/<id>, hash suffix or not).
     */
    function vimeoVideoIdFromUrl(url) {
      var m = /^https?:\\/\\/(?:www\\.)?(?:player\\.)?vimeo\\.com\\/(?:video\\/)?(\\d+)(?:[\\/?#]|$)/i.exec(String(url || '').trim());
      return m ? m[1] : null;
    }

    /**
     * Turn every \`[HH:MM:SS]\` / \`[MM:SS]\` in a Vimeo capture's markdown into a
     * link to that second of the video (\`vimeo.com/<id>#t=<sec>s\`, which the
     * Vimeo player honours) — the transcript's \`### [HH:MM:SS]\` window headings
     * and any timestamp the summary cites. Markdown in, markdown out: the label
     * keeps its brackets (\`[\\[00:12:00\\]](url)\`) so the page reads exactly as
     * before, only clickable. Fenced code is left alone (a timestamp inside a
     * quoted config is source text), and a bracket already followed by \`(\` is
     * an existing link. No id ⇒ the text is returned untouched.
     *
     * ⚠️ This lives inside a TEMPLATE LITERAL: every backslash below is written
     * doubled in the .ts source so the browser sees one. A regex that looks
     * right in the source and has a single backslash is a broken page script.
     */
    function linkVimeoTimestamps(markdown, videoUrl) {
      var id = vimeoVideoIdFromUrl(videoUrl);
      if (!id) return markdown;
      var base = 'https://vimeo.com/' + id + '#t=';
      var inFence = false;
      return String(markdown).split('\\n').map(function(line) {
        if (/^\\s*(\`\`\`|~~~)/.test(line)) { inFence = !inFence; return line; }
        if (inFence) return line;
        return line.replace(/\\[(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\](?!\\()/g, function(whole, a, b, c) {
          var sec = c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
          return '[\\\\[' + whole.slice(1, -1) + '\\\\]](' + base + sec + 's)';
        });
      }).join('\\n');
    }

    async function openSummaryDoc(docId, url, source) {
      // Take a new request id at the top so any earlier in-flight fetch (slow
      // article A while user clicks B) is invalidated — its post-await
      // continuations will see _docRequestId !== myRequest and bail before
      // overwriting the new panel's #sumArticleMain / #docSimilarPanel.
      var myRequest = ++_docRequestId;

      // The share dialog acts on the doc the panel is showing. Retargeting the
      // panel (a similar/category link) must therefore close it — an open dialog
      // naming the previous article would summarize a document the reader has
      // navigated away from. closeShareDialogOnNavigate, not a bare close, for
      // the reason the reader uses it: re-opening the SAME document (a category
      // link back to it, a repeat click) must not throw away a finished post the
      // reader hasn't copied yet.
      //
      // Shareable only when the source is REGISTERED: docApiBase falls back to
      // /api/youtube for an unknown one, so a hand-edited ?source=bogus deep link
      // would otherwise render a live button whose POST can only 400.
      _shareDoc = SOURCES[source]
        ? { docId: docId, source: source, title: docTitle(docId) }
        : null;
      var shareBtnEl = document.getElementById('${DOC_PANEL_SHARE_BTN_ID}');
      if (shareBtnEl) shareBtnEl.hidden = !_shareDoc;
      // Same doc, same gate: Delete needs the registered source's collection.
      var deleteBtnEl = document.getElementById('${DOC_PANEL_DELETE_BTN_ID}');
      if (deleteBtnEl) { deleteBtnEl.hidden = !_shareDoc; deleteBtnEl.disabled = false; }
      if (typeof closeShareDialogOnNavigate === 'function') closeShareDialogOnNavigate(docId);

      var overlay = document.getElementById('docOverlay');
      var titleEl = document.getElementById('docPanelTitle');
      var linksEl = document.getElementById('docPanelLinks');
      var bodyEl = document.getElementById('docPanelBody');
      var title = docTitle(docId);
      var cat = docCategory(docId);
      var src = SOURCES[source];
      var linkLabel = src ? src.linkLabel : 'Open ↗';

      titleEl.textContent = title;
      // Opt-in "Ask a follow-up" header action (Summaries shelf only — see
      // docPanelHtml({askFollowUp:true})). No-op if the button isn't rendered.
      var followEl = document.getElementById('docPanelFollowUp');
      if (followEl) followEl.href = '/research?q=' + encodeURIComponent(title);
      linksEl.innerHTML = url
        ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(linkLabel) + '</a>'
        : '';

      // 3-column article view: categories (left) | text (middle) | similar (right)
      bodyEl.innerHTML =
        '<div class="sum-col-left" id="sumCatPanel"></div>' +
        '<div class="sum-col-main" id="sumArticleMain">' +
          '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading...</div>' +
        '</div>' +
        '<div class="sum-col-right doc-similar" id="docSimilarPanel">' +
          '<h4>Similar Articles</h4>' +
          '<div style="color:var(--text-dim);font-size:12px;">Searching...</div>' +
        '</div>';
      overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';
      bodyEl.scrollTop = 0;

      // Left panel: browse categories without leaving the article
      renderArticleCategories(cat, docId, myRequest);

      try {
        var encodedId = docId.split('/').map(encodeURIComponent).join('/');
        var res = await fetch(docApiBase(source) + '/document/' + encodedId);
        if (myRequest !== _docRequestId) return;  // superseded
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var doc = await res.json();
        if (myRequest !== _docRequestId) return;  // superseded

        var text = doc.text || '';
        // Strip breadcrumb prefix [collection > path] and tags line
        var cleaned = text.replace(/^\\[.*?\\]\\n*/, '').replace(/^tags:.*\\n*/m, '');
        // A Vimeo capture's timestamps become clicks into the video.
        if (source === 'vimeo') cleaned = linkVimeoTimestamps(cleaned, url);
        var mainEl = document.getElementById('sumArticleMain');
        if (mainEl) mainEl.innerHTML = renderMarkdown(cleaned);

        // Right panel: other articles matching in relevance (within this source)
        loadDocSimilar(title, docId, myRequest, source);
      } catch (err) {
        if (myRequest !== _docRequestId) return;  // superseded
        var failEl = document.getElementById('sumArticleMain');
        if (failEl) failEl.innerHTML = '<div style="color:var(--status-error);padding:40px;text-align:center">Failed to load: ' + esc(err.message) + '</div>';
      }
    }

    // Left sidebar: every category sorted by recency (most-recent article first),
    // with the active category auto-expanded. Clicking a row selects it and is
    // single-expand — opens this category's article list and collapses every
    // other — so you can keep picking sibling articles under the selected
    // category. Reuses docsByCategory built by loadLibrary() — if the page
    // deep-linked straight into an article before the library loaded, fetch it
    // first.
    async function renderArticleCategories(activeCat, currentDocId, requestId) {
      var panel = document.getElementById('sumCatPanel');
      if (!panel) return;
      if (Object.keys(docsByCategory).length === 0) {
        panel.innerHTML = '<div class="sum-side-title">Categories</div>' +
          '<div style="color:var(--text-dim);font-size:12px;">Loading…</div>';
        try { await loadLibrary(); } catch {}
        if (requestId !== undefined && requestId !== _docRequestId) return;  // panel now belongs to a newer openSummaryDoc
        panel = document.getElementById('sumCatPanel');
        if (!panel) return;  // user already navigated elsewhere
      }
      // Per-category newest date for sorting. The doc date is "YYYY-MM-DD" (or
      // an ISO timestamp with the same prefix), so lexical max == chronological
      // max. Undated cats reduce to '' and sink to the bottom.
      var catMaxDate = {};
      Object.keys(docsByCategory).forEach(function(c) {
        catMaxDate[c] = (docsByCategory[c] || []).reduce(function(m, d) {
          var k = (d && d.date) || '';
          return k > m ? k : m;
        }, '');
      });
      var cats = Object.keys(docsByCategory).sort(function(a, b) {
        return catMaxDate[b].localeCompare(catMaxDate[a]);
      });
      if (cats.length === 0) {
        panel.innerHTML = '<div class="sum-side-title">Categories</div>' +
          '<div style="color:var(--text-dim);font-size:12px;">No categories</div>';
        return;
      }
      panel.innerHTML = '<div class="sum-side-title">Categories</div>' + cats.map(function(cat) {
        // Copy before sorting — docsByCategory is shared with the chip view
        // (sorted by title in loadLibrary); mutating it would break that.
        var docs = (docsByCategory[cat] || []).slice().sort(function(a, b) {
          return ((b && b.date) || '').localeCompare((a && a.date) || '');
        });
        var isActive = cat === activeCat;
        return '<div class="sum-cat">' +
          '<div class="sum-cat-row' + (isActive ? ' active' : '') + '">' +
            '<span class="sum-cat-name">' + esc(cat) + '</span>' +
            '<span class="sum-cat-count">' + docs.length + '</span>' +
          '</div>' +
          // Active category opens by default so the user can pick a sibling
          // straight away; the others stay collapsed until clicked.
          '<div class="sum-cat-articles"' + (isActive ? '' : ' hidden') + '>' +
            docs.map(function(d) {
              var cur = d.id === currentDocId;
              return '<a href="#" class="sum-cat-article' + (cur ? ' current' : '') + '" ' +
                'data-doc-id="' + esc(d.id) + '" data-doc-url="' + esc(d.url || '') + '" data-source="' + esc(d.source) + '">' +
                esc(docTitle(d.id)) + '</a>';
            }).join('') +
          '</div>' +
        '</div>';
      }).join('');

      // Select + single-expand with toggle-on-same-click: clicking a different
      // row clears every other .active + collapses their article lists, then
      // selects + opens this one. Clicking the already-active row collapses
      // it and deselects — so you can dismiss the open list and pick another
      // category cleanly.
      panel.querySelectorAll('.sum-cat-row').forEach(function(row) {
        row.addEventListener('click', function() {
          var list = row.parentElement.querySelector('.sum-cat-articles');
          if (row.classList.contains('active')) {
            row.classList.remove('active');
            if (list) list.hidden = true;
            return;
          }
          panel.querySelectorAll('.sum-cat-row.active').forEach(function(r) {
            r.classList.remove('active');
          });
          panel.querySelectorAll('.sum-cat-articles').forEach(function(l) {
            l.hidden = true;
          });
          row.classList.add('active');
          if (list) list.hidden = false;
        });
      });
      // Open another article in place
      panel.querySelectorAll('.sum-cat-article').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          openSummaryDoc(a.getAttribute('data-doc-id'), a.getAttribute('data-doc-url'), a.getAttribute('data-source'));
        });
      });
    }

    async function loadDocSimilar(title, currentDocId, requestId, source) {
      var panel = document.getElementById('docSimilarPanel');
      if (!panel) return;
      try {
        var res = await fetch(docApiBase(source) + '/similar?q=' + encodeURIComponent(title));
        if (requestId !== undefined && requestId !== _docRequestId) return;  // superseded by a newer open
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        if (requestId !== undefined && requestId !== _docRequestId) return;  // superseded by a newer open
        // The panel reference captured before the await may now be detached
        // (a newer openSummaryDoc rewrote bodyEl). Re-query by id to land on
        // the currently-mounted panel — guarded above so we only ever write
        // when we're still the active request.
        panel = document.getElementById('docSimilarPanel');
        if (!panel) return;
        var results = (data.results || []).filter(function(r) { return r.id !== currentDocId; }).slice(0, 5);
        if (results.length === 0) {
          panel.innerHTML = '<h4>Similar Articles</h4><div style="color:var(--text-dim);font-size:12px;">No similar articles found</div>';
          return;
        }
        panel.innerHTML = '<h4>Similar Articles</h4>' + results.map(function(r) {
          var pct = Math.round((r.relevance || 0) * 100);
          var rTitle = (r.title || r.id || '').replace(/\\.md$/, '');
          var rUrl = r.url || '#';
          return '<div class="doc-similar-item" data-doc-id="' + esc(r.id) + '" data-doc-url="' + esc(rUrl) + '">' +
            '<a href="#">' + esc(rTitle) + '</a>' +
            '<span class="doc-similar-relevance">' + pct + '%</span>' +
          '</div>';
        }).join('');
        // Wire up click handlers for similar items. With the 3-col layout the
        // panel re-renders in place, so we call openSummaryDoc directly. Similar
        // results live in the opened doc's source collection, so reuse source.
        panel.querySelectorAll('.doc-similar-item').forEach(function(item) {
          item.querySelector('a').addEventListener('click', function(e) {
            e.preventDefault();
            openSummaryDoc(item.getAttribute('data-doc-id'), item.getAttribute('data-doc-url'), source);
          });
        });
      } catch {
        if (requestId !== undefined && requestId !== _docRequestId) return;  // superseded by a newer open
        panel = document.getElementById('docSimilarPanel');
        if (panel) panel.innerHTML = '<h4>Similar Articles</h4><div style="color:var(--text-dim);font-size:12px;">Failed to load similar</div>';
      }
    }
  `;
}
