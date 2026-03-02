import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { markdownContentStyles, docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { escScript } from "./components/helpers.ts";

export function renderResearchPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Research</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}

    .page-content {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    /* --- Browse mode --- */
    .collection-selector {
      margin-bottom: 16px;
    }
    .collection-selector select {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      min-width: 250px;
    }
    .collection-selector select:focus { outline: none; border-color: var(--accent); }

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

    .browse-empty {
      color: var(--text-dim);
      font-size: 14px;
      text-align: center;
      padding: 40px;
    }

    ${docPanelStyles("researchSlideIn")}
    ${markdownContentStyles(".doc-panel-body")}
  </style>
</head>
<body>
  ${renderNav("research", { headerLeftExtra: botSelectorHtml() })}

  <div class="page-content">
    <div class="collection-selector">
      <select id="collectionSelect" onchange="loadCollection(this.value)">
        <option value="">Select a collection...</option>
      </select>
    </div>
    <div class="category-chips" id="tagChips"></div>
    <div class="articles-grid" id="documentsGrid"></div>
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    ${escScript()}

    var collections = [];
    var botCollectionNames = [];
    var allDocuments = [];
    var allTags = [];
    var activeTag = null;
    var selectedBot = '';

    // === Bot selector ===

    async function loadBotList() {
      try {
        var res = await fetch('/api/research/bots');
        if (!res.ok) return;
        var data = await res.json();
        var bots = data.bots || [];

        // Restore from localStorage
        try { selectedBot = localStorage.getItem('javrvis-selected-bot') || ''; } catch {}

        var container = document.getElementById('botSelector');
        container.innerHTML = bots.map(function(b) {
          return '<button class="bot-pill' + (selectedBot === b.name ? ' active' : '') + '" data-bot="' + esc(b.name) + '">' + esc(b.name.charAt(0).toUpperCase() + b.name.slice(1)) + '</button>';
        }).join('');

        // If no bot selected but bots exist, auto-select the first
        if (!selectedBot && bots.length > 0) {
          selectedBot = bots[0].name;
          container.querySelector('[data-bot="' + selectedBot + '"]').classList.add('active');
        }

        container.addEventListener('click', function(e) {
          var pill = e.target.closest('.bot-pill');
          if (!pill) return;
          selectBot(pill.dataset.bot);
        });
      } catch (e) { console.error('Failed to load bot list', e); }
    }

    function selectBot(name) {
      selectedBot = name;
      try { localStorage.setItem('javrvis-selected-bot', name); } catch {}
      document.querySelectorAll('#botSelector .bot-pill').forEach(function(p) {
        p.classList.toggle('active', p.dataset.bot === name);
      });
      loadBotCollections();
    }

    async function loadBotCollections() {
      botCollectionNames = [];
      if (selectedBot) {
        try {
          var res = await fetch('/api/research/bot-collections?bot=' + encodeURIComponent(selectedBot));
          if (res.ok) {
            var data = await res.json();
            botCollectionNames = data.collections || [];
          }
        } catch (e) { console.error('Failed to load bot collections', e); }
      }
      await loadCollections();
    }

    // === Browse ===

    async function loadCollections() {
      try {
        var res = await fetch('/api/search/collections');
        if (!res.ok) return;
        var data = await res.json();
        collections = data.collections || [];

        // Filter by bot's KNOWLEDGE_COLLECTIONS if set
        var filtered = collections;
        if (botCollectionNames.length > 0) {
          filtered = collections.filter(function(c) {
            return botCollectionNames.indexOf(c.name) !== -1;
          });
        }

        var select = document.getElementById('collectionSelect');
        var prevVal = select.value;
        select.innerHTML = '<option value="">Select a collection...</option>';
        filtered.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name + ' (' + c.document_count + ' docs)';
          select.appendChild(opt);
        });
        if (prevVal) { select.value = prevVal; }
      } catch (e) { console.error('Failed to load collections', e); }
    }

    async function loadCollection(name) {
      if (!name) {
        document.getElementById('tagChips').innerHTML = '';
        document.getElementById('documentsGrid').innerHTML = '';
        return;
      }

      document.getElementById('tagChips').innerHTML = '<div style="color:var(--text-dim);font-size:13px;">Loading...</div>';
      document.getElementById('documentsGrid').innerHTML = '';
      activeTag = null;

      var [tagsRes, docsRes] = await Promise.all([
        fetch('/api/research/tags?collection=' + encodeURIComponent(name)).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
        fetch('/api/research/documents?collection=' + encodeURIComponent(name)).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
      ]);

      allTags = [];
      if (tagsRes) {
        var collTags = tagsRes[name];
        if (collTags && collTags.tags) {
          allTags = Object.entries(collTags.tags).map(function(entry) {
            return { name: entry[0], count: entry[1] };
          }).sort(function(a, b) { return b.count - a.count; });
        }
      }

      allDocuments = (docsRes && docsRes.documents) ? docsRes.documents : [];

      renderTags();
      renderDocuments();
    }

    function renderTags() {
      var el = document.getElementById('tagChips');
      if (allTags.length === 0) {
        el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">No tags available</div>';
        return;
      }
      el.innerHTML = allTags.map(function(t) {
        var active = activeTag === t.name ? ' active' : '';
        return '<span class="cat-chip' + active + '" onclick="toggleTag(this, \\'' + esc(t.name).replace(/'/g, "\\\\'") + '\\')">' + esc(t.name) + ' <span class="chip-count">' + t.count + '</span></span>';
      }).join('');
    }

    function toggleTag(chip, tag) {
      activeTag = activeTag === tag ? null : tag;
      renderTags();
      renderDocuments();
    }

    function renderDocuments() {
      var el = document.getElementById('documentsGrid');
      var docs = allDocuments;

      if (activeTag) {
        docs = docs.filter(function(d) {
          return d.id && d.id.toLowerCase().includes(activeTag.toLowerCase());
        });
      }

      if (docs.length === 0) {
        el.innerHTML = '<div class="browse-empty">No documents' + (activeTag ? ' for tag "' + esc(activeTag) + '"' : '') + '</div>';
        return;
      }

      var collection = document.getElementById('collectionSelect').value;
      el.innerHTML = docs.map(function(d) {
        var title = d.id.split('/').pop().replace(/\\.md$/, '');
        var externalUrl = d.url || '';
        var linkHtml = externalUrl ? '<a class="article-row-link" href="' + esc(externalUrl) + '" target="_blank" onclick="event.stopPropagation()">Open &rarr;</a>' : '';
        return '<div class="article-row" onclick="openDoc(\\'' + esc(collection) + '\\', \\'' + esc(d.id).replace(/'/g, "\\\\'") + '\\', \\'' + esc(externalUrl).replace(/'/g, "\\\\'") + '\\')">' +
          '<span class="article-row-title">' + esc(title) + '</span>' + linkHtml + '</div>';
      }).join('');
    }

    function openDoc(collection, docId, url) {
      openDocPanel(collection, docId, url || '');
    }

    // === Doc panel ===
    ${docPanelScript()}

    // === Init ===

    (async function() {
      await loadBotList();
      await loadBotCollections();

      var params = new URLSearchParams(window.location.search);
      if (params.get('collection')) {
        var select = document.getElementById('collectionSelect');
        select.value = params.get('collection');
        if (select.value) loadCollection(select.value);
      }
    })();
  </script>
</body>
</html>`;
}
