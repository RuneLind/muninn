import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { buildHashMetaTag, getDashboardBuildHash } from "../dashboard-build-hash.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { layoutStyles } from "./components/layout.ts";
import { connectionStyles, connectionStatusHtml, connectionScript } from "./components/connection.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "./components/agent-status-ui.ts";
import { botSelectorStyles, botSelectorHtml, botSelectorScript } from "./components/bot-selector.ts";
import { sectionTabsStyles, sectionTabsHtml, sectionTabsScript } from "./components/section-tabs.ts";
import { overviewSectionStyles, overviewSectionHtml, overviewSectionScript } from "./components/overview-section.ts";
import { detailPanelStyles, detailPanelHtml, detailPanelScript } from "./components/detail-panel.ts";
import { tooltipStyles, tooltipHtml, tooltipScript } from "./components/tooltip.ts";
import { goalsPanelStyles, goalsPanelHtml, goalsPanelScript } from "./components/goals-panel.ts";
import { tasksPanelStyles, tasksPanelHtml, tasksPanelScript } from "./components/tasks-panel.ts";
import { watchersPanelStyles, watchersPanelHtml, watchersPanelScript } from "./components/watchers-panel.ts";
import { memoriesPanelStyles, memoriesPanelHtml, memoriesPanelScript } from "./components/memories-panel.ts";
import { memoryPanelStyles, memoryPanelHtml, memoryPanelScript } from "./components/memory-panel.ts";
import { automationPanelStyles, automationPanelHtml, automationPanelScript } from "./components/automation-panel.ts";
import { slackPanelStyles, slackPanelHtml, slackPanelScript } from "./components/slack-panel.ts";
import { connectorPanelStyles, connectorPanelHtml, connectorPanelScript } from "./components/connector-panel.ts";
import { memsearchPanelStyles, memsearchPanelHtml, memsearchPanelScript } from "./components/memsearch-panel.ts";
import { usageChartStyles, usageChartScript } from "./components/usage-chart.ts";
import { summaryTilesStyles, summaryTilesScript } from "./components/summary-tiles.ts";
import { statusChipsStyles, statusChipsScript } from "./components/status-chips.ts";
import { requestProgressStyles, requestProgressHtml, requestProgressScript } from "./components/request-progress-ui.ts";

export async function renderDashboardPage(): Promise<string> {
  const helpers = await helpersClientScript();
  const buildHash = await getDashboardBuildHash();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${buildHashMetaTag(buildHash)}
  <title>Muninn Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ" crossorigin="anonymous"></script>
  <style>
    ${SHARED_STYLES}
    ${connectionStyles()}
    ${agentStatusStyles()}
    ${botSelectorStyles()}
    ${layoutStyles()}
    ${sectionTabsStyles()}
    ${overviewSectionStyles()}
    ${detailPanelStyles()}
    ${tooltipStyles()}
    ${goalsPanelStyles()}
    ${tasksPanelStyles()}
    ${watchersPanelStyles()}
    ${memoriesPanelStyles()}
    ${memoryPanelStyles()}
    ${automationPanelStyles()}
    ${slackPanelStyles()}
    ${connectorPanelStyles()}
    ${memsearchPanelStyles()}
    ${requestProgressStyles()}
    ${usageChartStyles()}
    ${summaryTilesStyles()}
    ${statusChipsStyles()}
  </style>
</head>
<body>
  ${renderNav("dashboard", { headerLeftExtra: botSelectorHtml() + agentStatusHtml(), headerRight: connectionStatusHtml() })}
  ${requestProgressHtml()}
  ${sectionTabsHtml()}
  <div class="section-content">
    ${overviewSectionHtml()}
    <div data-section="users">
      <div class="md-layout">
        <div class="md-master">
          <div class="md-master-header">
            Users <span class="count" id="usersCount">0</span>
            <button class="add-user-btn" id="addUserBtn" title="Create user">+</button>
          </div>
          <div class="md-master-body" id="usersMasterList">
            <div class="panel-empty">Loading...</div>
          </div>
        </div>
        <div class="md-detail" id="usersDetailPanel">
          <div class="md-detail-empty" id="usersDetailEmpty">
            Select a user to view details
          </div>
          <div class="md-detail-content" id="usersDetailContent" style="display:none"></div>
        </div>
      </div>
    </div>
    <div data-section="memories-goals">
      ${memoryPanelHtml()}
    </div>
    <div data-section="schedules-watchers">
      ${automationPanelHtml()}
    </div>
    <div data-section="connectors">
      ${connectorPanelHtml()}
    </div>
    <div data-section="memsearch">
      ${memsearchPanelHtml()}
    </div>
    <div data-section="slack">
      ${slackPanelHtml()}
    </div>
  </div>
  ${detailPanelHtml()}
  ${tooltipHtml()}
  <script>
    ${helpers}
    ${botSelectorScript()}
    ${sectionTabsScript()}
    ${overviewSectionScript()}
    ${detailPanelScript()}
    ${tooltipScript()}
    ${goalsPanelScript()}
    ${tasksPanelScript()}
    ${watchersPanelScript()}
    ${memoriesPanelScript()}
    ${memoryPanelScript()}
    ${automationPanelScript()}
    ${slackPanelScript()}
    ${connectorPanelScript()}
    ${memsearchPanelScript()}
    ${usageChartScript()}
    ${summaryTilesScript()}
    ${statusChipsScript()}
    ${requestProgressScript()}
    ${agentStatusScript()}
    ${connectionScript()}
  </script>
</body>
</html>`;
}
