import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { memsearchStatsStyles, memsearchStatsHtml, memsearchStatsScript } from "./components/memsearch-stats.ts";
import { memsearchFormStyles, memsearchFormHtml, memsearchFormScript } from "./components/memsearch-form.ts";
import { memsearchResultsStyles, memsearchResultsHtml, memsearchResultsScript } from "./components/memsearch-results.ts";
import { memsearchModalStyles, memsearchModalHtml, memsearchModalScript } from "./components/memsearch-modal.ts";

export function renderMemsearchPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - MemSearch</title>
  <style>
    ${SHARED_STYLES}
    ${memsearchStatsStyles()}
    ${memsearchFormStyles()}
    ${memsearchResultsStyles()}
    ${memsearchModalStyles()}
  </style>
</head>
<body>
  ${renderNav("dashboard")}
  ${memsearchStatsHtml()}
  ${memsearchFormHtml()}
  ${memsearchResultsHtml()}
  ${memsearchModalHtml()}

  <script>
    ${memsearchFormScript()}
    ${memsearchResultsScript()}
    ${memsearchModalScript()}
    ${memsearchStatsScript()}

    // Init
    loadStats();
    loadBots();
  </script>
</body>
</html>`;
}
