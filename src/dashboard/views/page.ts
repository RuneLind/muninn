import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { helpersScript } from "./components/helpers.ts";
import { layoutStyles } from "./components/layout.ts";
import { connectionStyles, connectionStatusHtml, connectionScript } from "./components/connection.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "./components/agent-status-ui.ts";
import { statCardsStyles, statCardsHtml, statCardsScript } from "./components/stat-cards.ts";
import { goalsPanelStyles, goalsPanelHtml, goalsPanelScript } from "./components/goals-panel.ts";
import { tasksPanelStyles, tasksPanelHtml, tasksPanelScript } from "./components/tasks-panel.ts";
import { watchersPanelStyles, watchersPanelHtml, watchersPanelScript } from "./components/watchers-panel.ts";
import { memoriesPanelStyles, memoriesPanelHtml, memoriesPanelScript } from "./components/memories-panel.ts";
import { threadsPanelStyles, threadsPanelHtml, threadsPanelScript } from "./components/threads-panel.ts";
import { slackPanelStyles, slackPanelHtml, slackPanelScript } from "./components/slack-panel.ts";
import { usageChartStyles, usageChartHtml, usageChartScript } from "./components/usage-chart.ts";
import { activityFeedStyles, activityFeedHtml, activityFeedScript } from "./components/activity-feed.ts";

export function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    ${SHARED_STYLES}
    ${connectionStyles()}
    ${agentStatusStyles()}
    ${statCardsStyles()}
    ${layoutStyles()}
    ${goalsPanelStyles()}
    ${tasksPanelStyles()}
    ${watchersPanelStyles()}
    ${memoriesPanelStyles()}
    ${threadsPanelStyles()}
    ${slackPanelStyles()}
    ${usageChartStyles()}
    ${activityFeedStyles()}
  </style>
</head>
<body>
  ${renderNav("dashboard", { headerLeftExtra: agentStatusHtml(), headerRight: connectionStatusHtml() })}
  ${statCardsHtml()}
  <div class="main-grid">
    <div class="left-col">
      ${goalsPanelHtml()}
      ${tasksPanelHtml()}
      ${watchersPanelHtml()}
      ${memoriesPanelHtml()}
      ${threadsPanelHtml()}
      ${slackPanelHtml()}
    </div>
    <div class="right-col">
      ${usageChartHtml()}
      ${activityFeedHtml()}
    </div>
  </div>
  <script>
    ${helpersScript()}
    ${statCardsScript()}
    ${goalsPanelScript()}
    ${tasksPanelScript()}
    ${watchersPanelScript()}
    ${memoriesPanelScript()}
    ${threadsPanelScript()}
    ${slackPanelScript()}
    ${usageChartScript()}
    ${activityFeedScript()}
    ${agentStatusScript()}
    ${connectionScript()}
  </script>
</body>
</html>`;
}
