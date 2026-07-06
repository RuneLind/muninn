import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { docPanelHtml, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { clientSourcesJson } from "../../summaries/sources.ts";
import { clientDomainMapJson } from "../../summaries/domain.ts";
import { sumSubmitFormStyles, sumSubmitFormHtml, sumSubmitFormScript } from "./components/sum-submit-form.ts";
import { sumJobCardStyles, sumJobCardHtml, sumJobCardScript } from "./components/sum-job-card.ts";
import { sumCandidatesStyles, sumCandidatesHtml, sumCandidatesScript } from "./components/sum-candidates.ts";
import { sumRecentlyAddedStyles, sumRecentlyAddedHtml, sumRecentlyAddedScript } from "./components/sum-recently-added.ts";
import { sumArticleLibraryStyles, sumArticleLibraryHtml, sumArticleLibraryScript } from "./components/sum-article-library.ts";
import {
  sectionTabsStyles,
  sectionTabsHtml,
  sectionTabsScript,
  type SectionTabsConfig,
} from "./components/section-tabs.ts";

// The summaries page mounts its own tab bar (independent of the main dashboard's).
// Submit form + job card stay ABOVE the tabs — cross-cutting affordances a job can
// stream into regardless of which panel is active. `padded: false` because the tabs
// live inside the already-padded `.page-content` column.
const SUMMARIES_TABS: SectionTabsConfig = {
  tabs: [
    { id: "candidates", label: "Candidates" },
    { id: "recently", label: "Recently Added" },
    { id: "library", label: "Library" },
  ],
  storageKey: "muninn-active-tab-summaries",
  defaultTab: "candidates",
  contentSelector: ".sum-tab-content",
  padded: false,
};

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
    ${sectionTabsStyles(SUMMARIES_TABS)}
    ${sumCandidatesStyles()}
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

    <!-- Active job card (hidden until a job is active) — stays above the tabs so a
         job kicked from any panel (incl. a candidate row) streams in one shared card. -->
    ${sumJobCardHtml()}

    ${sectionTabsHtml(SUMMARIES_TABS)}
    <div class="sum-tab-content">
      <!-- Candidate inbox (anthropic tracker discoveries) -->
      <div data-section="candidates">${sumCandidatesHtml()}</div>

      <!-- Recently added (persistent, date-grouped, source-filterable) -->
      <div data-section="recently">${sumRecentlyAddedHtml()}</div>

      <!-- Article Library -->
      <div data-section="library">${sumArticleLibraryHtml()}</div>
    </div>
  </div>

  ${docPanelHtml({ askFollowUp: true })}

  ${MARKED_CDN_SCRIPT}
  <script>
    // Summary-source registry projection (from src/summaries/sources.ts).
    const SOURCES = ${clientSourcesJson()};
    // Category top-segment -> knowledge domain (from src/summaries/domain.ts).
    const DOMAIN_MAP = ${clientDomainMapJson()};
  </script>
  <script>
    ${helpers}
    ${sectionTabsScript(SUMMARIES_TABS)}
    ${sumJobCardScript()}
    ${sumCandidatesScript()}
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

      loadCandidates();
      loadRecentlyAdded();
      loadLibrary();
      renderDomainFilter();

      // Mount the tab bar (picks the initial tab from hash > localStorage > default).
      initSectionTabs();

      var params = new URLSearchParams(window.location.search);
      // Legacy deep links (/youtube?…, /x-articles?…) redirect here with ?source=.
      // Fall back to youtube so an old bookmark without a source still resolves.
      // NB: ?source= alone is NOT tab-affecting — the submit form rewrites the URL to
      // ?source=…&job=… via replaceState, so treating it as a tab switch would yank a
      // reload off the tab the user was on.
      var source = params.get('source') || 'youtube';

      var deepLinkDoc = params.get('doc');
      if (deepLinkDoc) {
        // A doc deep link lands on Recently Added (the doc panel overlays on top).
        // Deep link wins over the localStorage default.
        switchSection('recently');
        if (params.get('duplicate') === '1') showDuplicateBanner();
        openSummaryDoc(deepLinkDoc, '', source);
      }

      var jobId = params.get('job');
      if (!jobId) return;

      // A candidate-originated summarize rewrites the URL to source=anthropic&job=…;
      // land on Candidates so the originating row is in view. The job card itself is
      // above the tabs, so it streams regardless of which tab is active.
      if (source === 'anthropic') switchSection('candidates');

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
