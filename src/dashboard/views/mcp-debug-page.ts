import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { helpersClientScript } from "./components/helpers.ts";
import { mcpServerPanelStyles, mcpServerPanelHtml, mcpServerPanelScript } from "./components/mcp-server-panel.ts";
import { mcpToolListStyles, mcpToolListScript } from "./components/mcp-tool-list.ts";
import { mcpToolDetailStyles, mcpToolDetailHtml, mcpToolDetailScript } from "./components/mcp-tool-detail.ts";
import { mcpToolResultsStyles, mcpToolResultsScript } from "./components/mcp-tool-results.ts";

export async function renderMcpDebugPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - MCP Debug</title>
  <style>
    ${SHARED_STYLES}
    ${mcpServerPanelStyles()}
    ${mcpToolListStyles()}
    ${mcpToolDetailStyles()}
    ${mcpToolResultsStyles()}
  </style>
</head>
<body>
  ${renderNav("mcp-debug")}

  <div class="mcp-layout">
    ${mcpServerPanelHtml()}
    ${mcpToolDetailHtml()}
  </div>

  <script>
    ${helpers}
    ${mcpServerPanelScript()}
    ${mcpToolListScript()}
    ${mcpToolDetailScript()}
    ${mcpToolResultsScript()}
  </script>
</body>
</html>`;
}
