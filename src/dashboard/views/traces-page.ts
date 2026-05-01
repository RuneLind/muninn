import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { escScript, toolInputLabelScript, deriveSpanLabelScript } from "./components/helpers.ts";
import { tracesStatsStyles, tracesStatsHtml, tracesStatsScript } from "./components/traces-stats.ts";
import { tracesFiltersStyles, tracesFiltersHtml, tracesPaginationHtml, tracesFiltersScript } from "./components/traces-filters.ts";
import { tracesListStyles, tracesListHtml, tracesListScript } from "./components/traces-list.ts";
import { tracesWaterfallStyles, tracesWaterfallHtml, tracesWaterfallScript } from "./components/traces-waterfall.ts";
import { tracesPromptModalStyles, tracesPromptModalHtml, tracesPromptModalScript } from "./components/traces-prompt-modal.ts";
import { searchTraceDetailStyles, searchTraceDetailScript } from "./components/search-trace-detail.ts";

export function renderTracesPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    ${escScript()}
    ${toolInputLabelScript()}
    ${deriveSpanLabelScript()}
    ${tracesListScript()}
    ${tracesStatsScript()}
    ${tracesFiltersScript()}
    ${searchTraceDetailScript()}
    ${tracesWaterfallScript()}
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

    // Init
    loadFilters();
    loadStats();
    loadTraces();
    startAutoRefresh();
  </script>
</body>
</html>`;
}
