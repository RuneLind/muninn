/** Shared document viewer panel — slide-in overlay for rendering markdown documents */

/** CSS for markdown-rendered content. Used by both the overlay panel and the standalone document page. */
export function markdownContentStyles(prefix: string): string {
  return `
    ${prefix} h1 { font-size: 28px; font-weight: 700; margin: 32px 0 16px; color: var(--text-primary); }
    ${prefix} h2 { font-size: 22px; font-weight: 600; margin: 28px 0 12px; color: var(--text-primary); border-bottom: 1px solid var(--border-primary); padding-bottom: 6px; }
    ${prefix} h3 { font-size: 18px; font-weight: 600; margin: 24px 0 10px; color: var(--text-primary); }
    ${prefix} h4 { font-size: 15px; font-weight: 600; margin: 20px 0 8px; color: var(--text-primary); }
    ${prefix} p { margin: 0 0 12px; }
    ${prefix} ul, ${prefix} ol { margin: 0 0 12px; padding-left: 24px; }
    ${prefix} li { margin-bottom: 4px; }
    ${prefix} a { color: var(--accent-light); text-decoration: none; }
    ${prefix} a:hover { text-decoration: underline; }
    ${prefix} code {
      background: var(--bg-surface);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: 'SF Mono', Menlo, monospace;
    }
    ${prefix} pre {
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      padding: 14px 18px;
      overflow-x: auto;
      margin: 0 0 16px;
    }
    ${prefix} pre code { background: none; padding: 0; font-size: 13px; }
    ${prefix} blockquote {
      border-left: 3px solid var(--accent);
      margin: 0 0 12px;
      padding: 8px 16px;
      color: var(--text-soft);
      background: color-mix(in srgb, var(--accent) 5%, transparent);
      border-radius: 0 6px 6px 0;
    }
    ${prefix} table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 14px; }
    ${prefix} th, ${prefix} td { border: 1px solid var(--border-primary); padding: 8px 12px; text-align: left; }
    ${prefix} th { background: var(--bg-surface); font-weight: 600; color: var(--text-primary); }
    ${prefix} hr { border: none; border-top: 1px solid var(--border-primary); margin: 24px 0; }
    ${prefix} img { max-width: 100%; border-radius: 6px; }
    ${prefix} strong { color: var(--text-primary); }
  `;
}

/** CSS for the slide-in doc panel overlay (includes markdown body styles) */
export function docPanelStyles(animationName = "slideIn"): string {
  return `
    .doc-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
    }
    .doc-overlay.visible { display: flex; }
    .doc-panel {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(800px, 90vw);
      background: var(--bg-page);
      border-left: 1px solid var(--border-primary);
      display: flex;
      flex-direction: column;
      animation: ${animationName} 0.2s ease-out;
    }
    @keyframes ${animationName} { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .doc-panel-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-primary);
      flex-shrink: 0;
    }
    .doc-panel-close {
      background: none;
      border: 1px solid var(--border-secondary);
      color: var(--text-dim);
      cursor: pointer;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .doc-panel-close:hover { border-color: var(--text-dim); color: var(--text-secondary); }
    .doc-panel-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .doc-panel-links {
      display: flex;
      gap: 10px;
      font-size: 12px;
    }
    .doc-panel-links a {
      color: var(--accent);
      text-decoration: none;
    }
    .doc-panel-links a:hover { text-decoration: underline; }
    .doc-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      color: var(--text-secondary);
      line-height: 1.7;
      font-size: 15px;
    }
    ${markdownContentStyles(".doc-panel-body")}
  `;
}

/** HTML markup for the slide-in doc panel overlay */
export function docPanelHtml(): string {
  return `
  <div class="doc-overlay" id="docOverlay" onclick="if(event.target===this)closeDocPanel()">
    <div class="doc-panel">
      <div class="doc-panel-header">
        <button class="doc-panel-close" onclick="closeDocPanel()">&larr; Back</button>
        <span class="doc-panel-title" id="docPanelTitle"></span>
        <div class="doc-panel-links" id="docPanelLinks"></div>
      </div>
      <div class="doc-panel-body" id="docPanelBody"></div>
    </div>
  </div>`;
}

/** Inline JS for opening/closing the doc panel. Requires esc() and marked.js to be available. */
export function docPanelScript(): string {
  return `
    function renderMarkdown(text) {
      if (typeof marked === 'undefined') return '<pre>' + esc(text) + '</pre>';
      // Configure marked to escape HTML in source (prevent XSS from untrusted markdown)
      if (typeof marked.use === 'function' && !marked.__sanitized) {
        marked.use({ renderer: { html: function(token) { return esc(token.raw || token.text || ''); } } });
        marked.__sanitized = true;
      }
      return marked.parse(text);
    }

    function openDocPanel(collection, docId, webUrl) {
      var overlay = document.getElementById('docOverlay');
      var titleEl = document.getElementById('docPanelTitle');
      var linksEl = document.getElementById('docPanelLinks');
      var bodyEl = document.getElementById('docPanelBody');

      titleEl.textContent = docId.replace(/\\.md$/, '').split('/').pop();
      linksEl.innerHTML = webUrl
        ? '<a href="' + esc(webUrl) + '" target="_blank" rel="noopener">Open source &rarr;</a>'
        : '';
      bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim)">Loading document...</div>';
      overlay.classList.add('visible');
      document.body.style.overflow = 'hidden';

      var encodedDocId = docId.split('/').map(encodeURIComponent).join('/');
      fetch('/api/knowledge/document/' + encodeURIComponent(collection) + '/' + encodedDocId)
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(doc) {
          titleEl.textContent = (doc.id || docId).replace(/\\.md$/, '').split('/').pop();
          if (doc.url) {
            linksEl.innerHTML = '<a href="' + esc(doc.url) + '" target="_blank" rel="noopener">Open source &rarr;</a>';
          }
          var text = doc.text || '';
          var cleaned = text.replace(/^\\[.*?\\]\\n*/, '');
          bodyEl.innerHTML = renderMarkdown(cleaned);
        })
        .catch(function(err) {
          bodyEl.innerHTML = '<div style="color:var(--status-error);padding:40px;text-align:center">Failed to load: ' + esc(err.message) + '</div>';
        });
    }

    function closeDocPanel() {
      document.getElementById('docOverlay').classList.remove('visible');
      document.body.style.overflow = '';
    }

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && document.getElementById('docOverlay').classList.contains('visible')) {
        closeDocPanel();
      }
    });
  `;
}

/** The marked.js CDN script tag */
export const MARKED_CDN_SCRIPT = '<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>';
