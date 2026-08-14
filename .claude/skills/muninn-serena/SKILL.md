---
name: muninn-serena
description: Manage muninn's Serena MCP code-analysis instances — the persistent HTTP servers started from the /serena dashboard page. Use when configuring a serena block in a bot's config.json, wiring the matching .mcp.json http entry, starting an instance manually with uvx, pre-indexing a project, or debugging why a bot can't reach find_symbol / search_for_pattern.
---

# Serena Code Analysis (MCP Proxy)

Serena provides code search and analysis tools (find_symbol, search_for_pattern, etc.) for large codebases. Instead of spawning Serena per chat session, instances run as persistent HTTP servers managed from the dashboard.

## How it works

1. Open the **Serena** page in the dashboard (`/serena`)
2. Click **Start** on the instances you need (or **Start All**)
3. Each instance spawns Serena with `--transport streamable-http` on a dedicated port
4. The bot's `.mcp.json` has `type: "http"` entries pointing directly to these ports
5. The copilot-sdk connects to Serena over HTTP — no proxy, no per-session spawning
6. Click **Stop** when done to free resources

## Configuration

Serena instances are defined in the bot's `config.json` under a `serena` key:

```json
{
  "serena": [
    { "name": "serena-api", "displayName": "Backend API", "projectPath": "/path/to/project", "port": 9121 }
  ]
}
```

The matching `.mcp.json` entry points to the instance's HTTP endpoint:

```json
{
  "serena-api": { "type": "http", "url": "http://127.0.0.1:9121/mcp" }
}
```

## Manual usage

Start an instance outside muninn:

```bash
uvx --from "git+https://github.com/oraios/serena" serena start-mcp-server \
  --transport streamable-http --port 9121 --host 127.0.0.1 \
  --context claude-code --project /path/to/project --open-web-dashboard False
```

Pre-index for faster startup: `… serena project index /path/to/project --timeout 300`.

Implementation lives in `src/serena/` (manager + config) and `src/dashboard/views/serena-page.ts`; the MCP debug client that speaks both stdio and HTTP is `src/ai/mcp-tool-caller.ts`.
