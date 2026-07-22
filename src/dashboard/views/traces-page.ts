import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { buildHashMetaTag, getDashboardBuildHash } from "../dashboard-build-hash.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { tracesStatsStyles, tracesStatsHtml, tracesStatsScript } from "./components/traces-stats.ts";
import { tracesFiltersStyles, tracesFiltersHtml, tracesPaginationHtml, tracesFiltersScript } from "./components/traces-filters.ts";
import { tracesListStyles, tracesListHtml, tracesListScript } from "./components/traces-list.ts";
import {
  tracesWaterfallStyles,
  tracesWaterfallHtml,
  tracesWaterfallClientScript,
} from "./components/traces-waterfall.ts";
import { tracesPromptModalStyles, tracesPromptModalHtml, tracesPromptModalScript } from "./components/traces-prompt-modal.ts";
import { searchTraceDetailStyles, searchTraceDetailScript } from "./components/search-trace-detail.ts";
import { toolDetailRenderersStyles, toolDetailRenderersScript } from "./components/tool-detail-renderers.ts";

export async function renderTracesPage(): Promise<string> {
  const [helpers, waterfallScript, buildHash] = await Promise.all([
    helpersClientScript(),
    tracesWaterfallClientScript(),
    getDashboardBuildHash(),
  ]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${buildHashMetaTag(buildHash)}
  <title>Muninn - Traces</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}
    ${tracesStatsStyles()}
    ${tracesFiltersStyles()}
    ${tracesListStyles()}
    ${tracesWaterfallStyles()}
    ${tracesPromptModalStyles()}
    ${searchTraceDetailStyles()}
    ${toolDetailRenderersStyles()}
  </style>
</head>
<body>
  ${renderNav("traces", { headerLeftExtra: botSelectorHtml() })}

  ${tracesStatsHtml()}
  ${tracesFiltersHtml()}

  <div class="content">
    ${tracesWaterfallHtml()}
    ${tracesListHtml()}
    ${tracesPaginationHtml()}
  </div>

  ${tracesPromptModalHtml()}

  <script>
    ${helpers}
    ${tracesListScript()}
    ${tracesStatsScript()}
    ${tracesFiltersScript()}
    ${searchTraceDetailScript()}
    ${toolDetailRenderersScript()}
    ${waterfallScript}
    ${tracesPromptModalScript()}

    // --- Bot selector (synced with dashboard via localStorage) ---
    let selectedBot = '';
    (function initBotSelector() {
      try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}
      loadBotList();
    })();

    async function loadBotList() {
      try {
        const res = await fetch('/api/bots').then(r => r.json());
        const container = document.getElementById('botSelector');
        const bots = res.bots || [];
        container.innerHTML =
          '<button class="bot-pill' + (!selectedBot ? ' active' : '') + '" data-bot="">All Bots</button>' +
          bots.map(b =>
            '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + esc(b) + '">' + esc(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>'
          ).join('');
      } catch {}
    }

    function selectBot(name) {
      selectedBot = name;
      try { localStorage.setItem('muninn-selected-bot', name); } catch {}
      document.querySelectorAll('.bot-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.bot === name);
      });
      currentPage = 0;
      loadTraces();
      loadStats();
    }

    document.getElementById('botSelector').addEventListener('click', (e) => {
      const pill = e.target.closest('.bot-pill');
      if (pill) selectBot(pill.dataset.bot);
    });

    // Deep-link: /traces#<traceId> opens that trace's waterfall. loadWaterfall
    // fetches the trace by id directly, so it works even when the row isn't on
    // the loaded first page (placeWaterfallAfterRow then parks the panel at the
    // top); when the row IS present we also scroll it into view.
    function openTraceFromHash() {
      var id = (location.hash || '').replace(/^#/, '').trim();
      if (!id) return;
      loadWaterfall(id);
      var row = document.querySelector('tr[data-trace="' + id + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    }

    // Init
    loadFilters();
    loadStats();
    loadTraces().then(openTraceFromHash);
    startAutoRefresh();
    window.addEventListener('hashchange', openTraceFromHash);
  </script>
</body>
</html>`;
}
