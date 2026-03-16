// Knowledge links helper functions — exported as TypeScript (for testing)
// AND as a JS string (for browser injection via knowledgeLinksScript()).

// ── Pure functions ─────────────────────────────────────────────────────

/** Normalize a URL for comparison: strip www, trailing slash, handle YouTube variants. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    let normalized = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    if (u.hostname.includes('youtube.com') && u.searchParams.has('v')) {
      normalized += '?v=' + u.searchParams.get('v');
    }
    if (u.hostname.includes('youtu.be')) {
      normalized = 'youtube.com/watch?v=' + u.pathname.slice(1);
    }
    return normalized;
  } catch { return url; }
}

// ── Browser-injectable JS string ───────────────────────────────────────

/** Returns all knowledge-link functions as a browser-compatible JS string.
 *  Injected INSIDE the CHAT_SCRIPT IIFE — has access to IIFE-scoped variables
 *  (openDocPanel from docPanelScript, etc.). */
export function knowledgeLinksScript(): string {
  return `
  // --- Knowledge Index Links ---
  var knowledgeUrlMap = {};

  function normalizeUrl(url) {
    try {
      var u = new URL(url);
      var normalized = u.hostname.replace(/^www\\./, '') + u.pathname.replace(/\\/$/, '');
      if (u.hostname.includes('youtube.com') && u.searchParams.has('v')) {
        normalized += '?v=' + u.searchParams.get('v');
      }
      if (u.hostname.includes('youtu.be')) {
        normalized = 'youtube.com/watch?v=' + u.pathname.slice(1);
      }
      return normalized;
    } catch { return url; }
  }

  async function loadKnowledgeUrlMaps() {
    try {
      var res = await fetch('/chat/knowledge-config');
      if (!res.ok) return;
      var cfg = await res.json();
      var cols = cfg.viewableCollections || [];
      await Promise.all(cols.map(function(col) {
        return fetch('/api/search/collection/' + encodeURIComponent(col) + '/documents')
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (!data) return;
            var docs = data.documents || [];
            for (var j = 0; j < docs.length; j++) {
              if (docs[j].url) {
                knowledgeUrlMap[normalizeUrl(docs[j].url)] = { collection: col, docId: docs[j].id };
              }
            }
          })
          .catch(function() {});
      }));
      // Re-augment any messages already rendered before the map was ready
      var msgs = document.querySelectorAll('.msg-bot');
      for (var k = 0; k < msgs.length; k++) augmentIndexLinks(msgs[k]);
    } catch {}
  }

  function augmentIndexLinks(container) {
    if (Object.keys(knowledgeUrlMap).length === 0) return;
    var links = container.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.nextElementSibling && a.nextElementSibling.classList.contains('index-link-inline')) continue;
      var match = knowledgeUrlMap[normalizeUrl(a.href)];
      if (match) {
        var btn = document.createElement('a');
        btn.className = 'index-link-inline';
        btn.href = '#';
        btn.textContent = 'Index';
        btn.dataset.collection = match.collection;
        btn.dataset.docid = match.docId;
        btn.dataset.url = a.href;
        btn.onclick = function(e) {
          e.preventDefault();
          openDocPanel(this.dataset.collection, this.dataset.docid, this.dataset.url);
        };
        a.parentNode.insertBefore(btn, a.nextSibling);
      }
    }
  }
  `;
}
