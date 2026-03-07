# Knowledge Search System

The knowledge search system gives bots access to indexed company content (Notion pages, Confluence, etc.) via vector similarity search. Knowledge is accessed on-demand through MCP tools — the AI agent decides when to search based on the conversation.

## Architecture

```
User message
    │
    └─ MCP tool (knowledge_api_mcp_adapter.py)
        Claude calls search_knowledge / get_document / get_notion_page ──► Knowledge API
        └─ Claude uses results inline in its response
```

The Knowledge API Server (`http://localhost:8321`) runs as a separate process and manages vector indexing of content sources (Notion, Confluence, etc.).

## How It Works

Claude has access to knowledge search via MCP tools registered in each bot's `.mcp.json`. The AI decides when a search is relevant based on the user's question — there is no automatic injection into every prompt.

- **Adapter:** `knowledge_api_mcp_adapter.py` (Python, in documents-vector-search repo)
- **Tools:**
  - `search_knowledge(query, collection?, limit?, brief?)` — vector search with optional brief mode
  - `get_document(collection, doc_id)` — fetch full document content
  - `get_notion_page(notion_id, source?)` — fetch Notion page (live API or local index)
  - `list_collections()` — list loaded collections with stats
- **Collection scoping:** `KNOWLEDGE_COLLECTIONS` env var restricts which collections a bot can access

## Configuration

### Per-bot MCP setup

Add the knowledge MCP server to the bot's `.mcp.json` with `KNOWLEDGE_COLLECTIONS` to scope access:

```json
{
  "mcpServers": {
    "knowledge": {
      "type": "stdio",
      "command": "uv",
      "args": [
        "--directory", "/path/to/documents-vector-search",
        "run", "knowledge_api_mcp_adapter.py"
      ],
      "env": {
        "KNOWLEDGE_API_URL": "http://localhost:8321",
        "KNOWLEDGE_COLLECTIONS": "confluence-docs,jira-issues"
      }
    }
  }
}
```

### MCP discovery

Claude CLI discovers `.mcp.json` from the git root, not from `cwd`. Since bot dirs are subdirectories, the executor explicitly passes `--mcp-config` pointing to the bot's `.mcp.json` file.

### Environment

| Variable | Default | Description |
|---|---|---|
| `KNOWLEDGE_API_URL` | `http://localhost:8321` | Knowledge API server endpoint |
| `KNOWLEDGE_COLLECTIONS` | (all) | Comma-separated list of allowed collections |

## Formatting

Claude formats knowledge results freely in its response. Platform-specific formatting is applied:

- **Slack:** `formatSlackMrkdwn()` converts markdown tables to bullet lists, fixes links
- **Telegram:** `formatTelegramHtml()` converts to HTML tags

The bot's persona (`CLAUDE.md`) also instructs Claude to avoid markdown tables and empty bullets, providing defense-in-depth.

## Key Files

| File | Purpose |
|---|---|
| `bots/<name>/.mcp.json` | MCP server registration + collection scoping |
| `src/ai/executor.ts` | Passes `--mcp-config` to Claude CLI |
| `src/dashboard/routes.ts` | Dashboard proxy to Knowledge API (`/knowledge` page) |
| `src/dashboard/views/knowledge-page.ts` | Dashboard knowledge search UI |
| `src/slack/slack-format.ts` | Slack formatting (table conversion, link preservation) |

## Data Flow

1. User sends a message
2. Claude receives the prompt with memories, goals, tasks, and conversation history
3. Based on the question, Claude may call `search_knowledge` MCP tool
4. MCP adapter sends HTTP GET to Knowledge API with the query
5. Knowledge API performs hybrid vector + BM25 search across allowed collections
6. Claude uses results inline in its response
7. Response is formatted for the target platform (Slack mrkdwn or Telegram HTML)
