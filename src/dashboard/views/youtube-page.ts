import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { docPanelHtml, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { escScript } from "./components/helpers.ts";
import { ytSubmitFormStyles, ytSubmitFormHtml, ytSubmitFormScript } from "./components/yt-submit-form.ts";
import { ytJobCardStyles, ytJobCardHtml, ytJobCardScript } from "./components/yt-job-card.ts";
import { ytRecentJobsStyles, ytRecentJobsHtml, ytRecentJobsScript } from "./components/yt-recent-jobs.ts";
import { ytArticleLibraryStyles, ytArticleLibraryHtml, ytArticleLibraryScript } from "./components/yt-article-library.ts";

export function renderYouTubePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - YouTube Summarizer</title>
  <style>
    ${SHARED_STYLES}

    .page-content {
      max-width: 960px;
      margin: 0 auto;
      padding: 24px;
    }

    ${ytSubmitFormStyles()}
    ${ytJobCardStyles()}
    ${ytRecentJobsStyles()}
    ${ytArticleLibraryStyles()}

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
  ${renderNav("youtube")}

  <div class="error-banner" id="knowledgeBanner">
    Knowledge API is not available. Summarization requires an external knowledge/vector search server.
    Set <code>KNOWLEDGE_API_URL</code> in your <code>.env</code> file to connect.
  </div>

  <div class="duplicate-banner" id="duplicateBanner">
    This video has already been summarized — showing the existing summary.
  </div>

  <div class="page-content">
    <!-- Manual submit form -->
    ${ytSubmitFormHtml()}

    <!-- Active job card (hidden until a job is active) -->
    ${ytJobCardHtml()}

    <!-- Recent jobs -->
    ${ytRecentJobsHtml()}

    <!-- Article Library -->
    ${ytArticleLibraryHtml()}
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    ${escScript()}
    ${ytJobCardScript()}
    ${ytRecentJobsScript()}
    ${ytArticleLibraryScript()}
    ${ytSubmitFormScript()}

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

      loadRecentJobs();
      loadLibrary();

      var params = new URLSearchParams(window.location.search);

      var deepLinkDoc = params.get('doc');
      if (deepLinkDoc) {
        if (params.get('duplicate') === '1') showDuplicateBanner();
        openYouTubeDoc(deepLinkDoc, '');
      }

      var jobId = params.get('job');
      if (!jobId) return;

      // Fetch current job state
      try {
        var res = await fetch('/api/youtube/jobs');
        var data = await res.json();
        var job = (data.jobs || []).find(function(j) { return j.id === jobId; });
        if (!job) return;

        showJob(jobId, job.title || job.url, job.url);

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
          connectSSE(jobId);
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
