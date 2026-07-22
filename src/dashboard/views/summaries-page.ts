import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { docPanelHtml, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { clientSourcesJson } from "../../summaries/sources.ts";
import { clientDomainMapJson } from "../../summaries/domain.ts";
import { getAuthorTierThresholds } from "../../summaries/author-scores.ts";
import { sumSubmitFormStyles, sumSubmitFormHtml, sumSubmitFormScript } from "./components/sum-submit-form.ts";
import { sumJobCardStyles, sumJobCardHtml, sumJobCardScript } from "./components/sum-job-card.ts";
import { sumCandidatesStyles, sumCandidatesHtml, sumCandidatesScript } from "./components/sum-candidates.ts";
import { sumOutcomesStyles, sumOutcomesHtml, sumOutcomesScript } from "./components/sum-outcomes.ts";
import { sumStatsStyles, sumStatsHtml, sumStatsScript } from "./components/sum-stats.ts";
import { sumShelfStyles, sumShelfHtml, sumShelfScript } from "./components/sum-shelf.ts";
import { sumArticleLibraryStyles, sumArticleLibraryHtml, sumArticleLibraryScript } from "./components/sum-article-library.ts";
import { agentPresenceStyles, agentPresenceHtml, agentPresenceScript } from "./components/agent-presence.ts";
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
    { id: "candidates", label: "Inbox" },
    { id: "shelf", label: "Shelf" },
    { id: "calibration", label: "Calibration" },
    { id: "stats", label: "Stats" },
  ],
  storageKey: "muninn-active-tab-summaries",
  defaultTab: "candidates",
  contentSelector: ".sum-tab-content",
  padded: false,
  // The old Recently Added + Library tabs merged into Shelf — a returning browser
  // whose saved/hash tab was one of those lands on Shelf, not the default.
  aliases: { recently: "shelf", library: "shelf" },
};

export async function renderSummariesPage(): Promise<string> {
  const helpers = await helpersClientScript();
  // Percentile cuts on the CURRENT huginn author ranking, computed once at render and
  // embedded — the page is fully server-rendered, so the X author tier badges + "Top
  // authors" filter read these directly (no extra endpoint). null when the scores file
  // is unavailable, which the client treats as "no author tiers".
  const authorTiers = await getAuthorTierThresholds();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
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
    ${sumShelfStyles()}
    ${sumArticleLibraryStyles()}
    ${sumOutcomesStyles()}
    ${sumStatsStyles()}
    ${agentPresenceStyles()}

    /* Page head: title + live presence + the collapsed paste-article affordance. */
    .sum-page-head {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .sum-page-head h2 {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }
    .sum-page-head .sum-presence-slot { display: inline-flex; }
    .paste-toggle {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 14px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--accent-light);
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .paste-toggle:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }
    #pasteFormWrap[hidden] { display: none; }

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
    <!-- Page head: title, live presence (capture job / gardener drain), and the
         "+ Paste article" toggle that reveals the collapsed submit form. -->
    <div class="sum-page-head">
      <h2>Summaries</h2>
      <span class="sum-presence-slot">${agentPresenceHtml("sumPresence")}</span>
      <button class="paste-toggle" id="pasteToggleBtn" type="button" aria-expanded="false" aria-controls="pasteFormWrap">+ Paste article</button>
    </div>

    <!-- Manual submit form (pasted article text; YouTube/X come from the Chrome
         extension) — collapsed behind the toggle above so the inbox leads. -->
    <div id="pasteFormWrap" hidden>${sumSubmitFormHtml()}</div>

    <!-- Active job card (hidden until a job is active) — stays above the tabs so a
         job kicked from any panel (incl. a candidate row) streams in one shared card. -->
    ${sumJobCardHtml()}

    ${sectionTabsHtml(SUMMARIES_TABS)}
    <div class="sum-tab-content">
      <!-- Candidate inbox (anthropic tracker discoveries) — the page lead -->
      <div data-section="candidates">${sumCandidatesHtml()}</div>

      <!-- Shelf: recency-first archive (date buckets) + category/source/domain filters
           (merged Recently Added + Library) -->
      <div data-section="shelf">${sumShelfHtml()}</div>

      <!-- Gate-outcome calibration (display-only) -->
      <div data-section="calibration">${sumOutcomesHtml()}</div>

      <!-- Ingest volume + gardener coverage (display-only) -->
      <div data-section="stats">${sumStatsHtml()}</div>
    </div>
  </div>

  ${docPanelHtml({ askFollowUp: true })}

  ${MARKED_CDN_SCRIPT}
  <script>
    // Summary-source registry projection (from src/summaries/sources.ts).
    const SOURCES = ${clientSourcesJson()};
    // Category top-segment -> knowledge domain (from src/summaries/domain.ts).
    const DOMAIN_MAP = ${clientDomainMapJson()};
    // Percentile cuts on huginn's X author ranking (top 1% / top 5%), or null when the
    // scores file was unavailable at render. Drives the X author tier badge + filter.
    const AUTHOR_TIERS = ${JSON.stringify(authorTiers)};
  </script>
  <script>
    ${helpers}
    ${sectionTabsScript(SUMMARIES_TABS)}
    ${sumJobCardScript()}
    ${sumCandidatesScript()}
    ${sumShelfScript()}
    ${sumArticleLibraryScript()}
    ${sumOutcomesScript()}
    ${sumStatsScript()}
    ${sumSubmitFormScript()}

    function showDuplicateBanner() {
      var el = document.getElementById('duplicateBanner');
      if (el) el.classList.add('visible');
    }

    // "+ Paste article" toggle: reveal/collapse the submit form + focus the textarea.
    (function() {
      var btn = document.getElementById('pasteToggleBtn');
      var wrap = document.getElementById('pasteFormWrap');
      if (!btn || !wrap) return;
      btn.addEventListener('click', function() {
        var open = wrap.hasAttribute('hidden');
        if (open) {
          wrap.removeAttribute('hidden');
          btn.setAttribute('aria-expanded', 'true');
          var ta = document.getElementById('articleText');
          if (ta) ta.focus();
        } else {
          wrap.setAttribute('hidden', '');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
    })();

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
      loadShelf();
      loadOutcomes();
      renderDomainFilter();

      // Stats is heavier (hits huginn per collection + the proposals table), so
      // load it lazily the first time its tab is opened rather than on page load.
      onSectionActivate('stats', function() { loadStats(); });

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
        // A doc deep link lands on the Shelf (the doc panel overlays on top).
        // Deep link wins over the localStorage default for THIS view, but doesn't
        // persist — a bookmarked URL must not rewrite the user's saved default tab.
        switchSection('shelf', { persist: false });
        if (params.get('duplicate') === '1') showDuplicateBanner();
        openSummaryDoc(deepLinkDoc, '', source);
      }

      var jobId = params.get('job');
      if (!jobId) return;

      // A candidate-originated summarize rewrites the URL to source=anthropic&job=…;
      // land on Candidates so the originating row is in view. The job card itself is
      // above the tabs, so it streams regardless of which tab is active.
      if (source === 'anthropic') switchSection('candidates', { persist: false });

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
  <script>
    ${agentPresenceScript("sumPresence", { kinds: ["capture", "gardener_drain"] })}
  </script>
</body>
</html>`;
}
