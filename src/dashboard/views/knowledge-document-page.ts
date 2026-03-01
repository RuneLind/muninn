import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";
import { markdownContentStyles, docPanelScript, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";

export function renderKnowledgeDocumentPage(collection: string, docId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis - Document</title>
  <style>
    ${SHARED_STYLES}

    .doc-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .doc-header a {
      color: var(--accent);
      text-decoration: none;
      font-size: 13px;
    }
    .doc-header a:hover { text-decoration: underline; }
    .doc-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-left: auto;
      font-size: 12px;
      color: var(--text-dim);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .badge-collection { background: color-mix(in srgb, var(--status-cyan) 15%, transparent); color: var(--status-cyan); }

    .doc-content {
      max-width: 800px;
      margin: 0 auto;
      padding: 24px;
      color: var(--text-secondary);
      line-height: 1.7;
      font-size: 15px;
    }

    ${markdownContentStyles(".doc-content")}
    .doc-content li > ul, .doc-content li > ol { margin-top: 4px; margin-bottom: 0; }

    .loading {
      text-align: center;
      padding: 60px;
      color: var(--text-dim);
    }
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-secondary);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .error-msg {
      text-align: center;
      padding: 60px;
      color: var(--status-error);
      font-size: 14px;
    }
  </style>
</head>
<body>
  ${renderNav("knowledge")}

  <div class="doc-header">
    <a href="/knowledge">&larr; Back to search</a>
    <div class="doc-meta">
      <span class="badge badge-collection" id="docCollection"></span>
      <span id="docUrl"></span>
    </div>
  </div>

  <div class="doc-content" id="docContent">
    <div class="loading"><span class="spinner"></span>Loading document...</div>
  </div>

  ${MARKED_CDN_SCRIPT}
  <script>
    ${escScript()}
    ${docPanelScript()}

    const collection = ${JSON.stringify(collection)};
    const docId = ${JSON.stringify(docId)};

    document.getElementById('docCollection').textContent = collection;

    async function loadDocument() {
      const el = document.getElementById('docContent');
      try {
        const encodedDocId = docId.split('/').map(encodeURIComponent).join('/');
        const res = await fetch('/api/knowledge/document/' + encodeURIComponent(collection) + '/' + encodedDocId);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          el.innerHTML = '<div class="error-msg">Failed to load document: ' + esc(data.error || res.statusText) + '</div>';
          return;
        }
        const doc = await res.json();

        document.title = 'Jarvis - ' + (doc.id || docId).replace(/\\.md$/,'');

        if (doc.url && /^https?:\\/\\//i.test(doc.url)) {
          document.getElementById('docUrl').innerHTML = '<a href="' + esc(doc.url) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-size:12px">Open web page &rarr;</a>';
        }

        const text = doc.text || '';
        // Strip leading breadcrumb line (e.g. "[Page Title]")
        const cleaned = text.replace(/^\\[.*?\\]\\n*/, '');
        el.innerHTML = renderMarkdown(cleaned);
      } catch (err) {
        el.innerHTML = '<div class="error-msg">Failed to load document: ' + esc(err.message) + '</div>';
      }
    }

    loadDocument();
  </script>
</body>
</html>`;
}
