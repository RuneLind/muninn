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
  </style>
</head>
<body>
  ${renderNav("youtube")}

  <div class="error-banner" id="knowledgeBanner">
    Knowledge API is not available. Summarization requires an external knowledge/vector search server.
    Set <code>KNOWLEDGE_API_URL</code> in your <code>.env</code> file to connect.
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

      // Check for ?job= param
      var params = new URLSearchParams(window.location.search);
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
