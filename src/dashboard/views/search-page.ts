import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { searchStatsStyles, searchStatsHtml, searchStatsScript } from "./components/search-stats.ts";
import { searchFormStyles, searchFormHtml, searchFormScript } from "./components/search-form.ts";
import { searchResultsStyles, searchResultsHtml, searchResultsScript } from "./components/search-results.ts";

export async function renderSearchPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>Muninn - Search</title>
  <style>
    ${SHARED_STYLES}
    ${searchStatsStyles()}
    ${searchFormStyles()}
    ${searchResultsStyles()}
    ${docPanelStyles()}
  </style>
</head>
<body>
  ${renderNav("search")}

  <div class="error-banner" id="errorBanner">
    Knowledge API is not available. This feature requires an external knowledge/vector search server.
    Set <code>KNOWLEDGE_API_URL</code> in your <code>.env</code> file to connect.
  </div>

  ${searchStatsHtml()}

  ${searchFormHtml()}

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}

  ${searchResultsHtml()}

  <script>
    ${helpers}
    ${searchResultsScript()}
    ${searchStatsScript()}
    ${searchFormScript()}
    ${docPanelScript()}

    // Delegated click handler for index links
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.index-link');
      if (link) {
        e.preventDefault();
        openDocPanel(link.dataset.collection, link.dataset.docid, link.dataset.url);
      }
    });

    // Init
    checkApiHealth().then(ok => {
      if (ok) loadCollections();
    });
  </script>
</body>
</html>`;
}
