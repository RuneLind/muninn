import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { docPanelHtml, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { clientSourcesJson } from "../../summaries/sources.ts";
import { sumSubmitFormStyles, sumSubmitFormHtml, sumSubmitFormScript } from "./components/sum-submit-form.ts";
import { sumJobCardStyles, sumJobCardHtml, sumJobCardScript } from "./components/sum-job-card.ts";
import { sumRecentlyAddedStyles, sumRecentlyAddedHtml, sumRecentlyAddedScript } from "./components/sum-recently-added.ts";
import { sumArticleLibraryStyles, sumArticleLibraryHtml, sumArticleLibraryScript } from "./components/sum-article-library.ts";

export async function renderSummariesPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Summaries</title>
  <style>
    ${SHARED_STYLES}

    .page-content {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    ${sumSubmitFormStyles()}
    ${sumJobCardStyles()}
    ${sumRecentlyAddedStyles()}
    ${sumArticleLibraryStyles()}

    .duplicate-banner {
      display: none;
      max-width: 960px;
      margin: 16px auto 0;
      padding: 12px 16px;
      background: var(--accent-dim, #2a2f3a);
      border-left: 3px solid var(--accent, #6c8aff);
      color: var(--text, #e6e6e6);
      border-radius: 4px;
      font-size: 14px;
    }
    .duplicate-banner.visible { display: block; }
  </style>
</head>
<body>
  ${renderNav("summaries")}

  <div class="error-banner" id="knowledgeBanner">
    Knowledge API is not available. Summarization requires an external knowledge/vector search server.
    Set <code>KNOWLEDGE_API_URL</code> in your <code>.env</code> file to connect.
  </div>

  <div class="duplicate-banner" id="duplicateBanner">
    This item has already been summarized — showing the existing summary.
  </div>

  <div class="page-content">
    <!-- Manual submit form (YouTube; X comes from the Chrome extension) -->
    ${sumSubmitFormHtml()}

    <!-- Active job card (hidden until a job is active) -->
    ${sumJobCardHtml()}

    <!-- Recently added (persistent, date-grouped, source-filterable) -->
    ${sumRecentlyAddedHtml()}

    <!-- Article Library -->
    ${sumArticleLibraryHtml()}
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    // Summary-source registry projection (from src/summaries/sources.ts).
    const SOURCES = ${clientSourcesJson()};
  </script>
  <script>
    ${helpers}
    ${sumJobCardScript()}
    ${sumRecentlyAddedScript()}
    ${sumArticleLibraryScript()}
    ${sumSubmitFormScript()}

    function showDuplicateBanner() {
      var el = document.getElementById('duplicateBanner');
      if (el) el.classList.add('visible');
    }

    // --- Init ---
    async function init() {
      // Check knowledge API availability
      try {
        var healthRes = await fetch('/api/search/health');
        if (!healthRes.ok) document.getElementById('knowledgeBanner').classList.add('visible');
      } catch (e) {
        document.getElementById('knowledgeBanner').classList.add('visible');
      }

      loadRecentlyAdded();
      loadLibrary();

      var params = new URLSearchParams(window.location.search);
      // Legacy deep links (/youtube?…, /x-articles?…) redirect here with ?source=.
      // Fall back to youtube so an old bookmark without a source still resolves.
      var source = params.get('source') || 'youtube';

      var deepLinkDoc = params.get('doc');
      if (deepLinkDoc) {
        if (params.get('duplicate') === '1') showDuplicateBanner();
        openSummaryDoc(deepLinkDoc, '', source);
      }

      var jobId = params.get('job');
      if (!jobId) return;

      // Fetch current job state from the source's job store
      try {
        var res = await fetch(docApiBase(source) + '/jobs');
        var data = await res.json();
        var job = (data.jobs || []).find(function(j) { return j.id === jobId; });
        if (!job) return;

        showJob(jobId, job.title || job.url, job.url, source);

        // Replay existing state
        if (job.text) {
          accumulatedText = job.text;
          updateSummaryArea();
        }
        if (job.category) showCategory(job.category);
        if (job.similar) renderSimilar(job.similar);
        if (job.error) showError(job.error);
        updateStatusBadge(job.status);

        // Connect SSE for live updates (unless terminal)
        if (!TERMINAL_STATES.includes(job.status)) {
          connectSSE(jobId, source);
        } else {
          finalizeSummary();
          // Fetch scored similar results for completed jobs
          loadJobSimilar(job.title || job.url);
        }
      } catch {
        // ignore — job may have expired
      }
    }

    init();
  </script>
</body>
</html>`;
}
