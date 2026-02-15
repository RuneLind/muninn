# Knowledge Search System

The knowledge search system gives bots access to indexed company content (currently Notion pages) via vector similarity search. Results reach the AI through two independent paths: auto-injection into the system prompt, and an MCP tool for on-demand searches.

## Architecture

```
User message
    │
    ├─ Auto-injection (prompt-builder.ts)
    │   searchKnowledge(query, collections) ──► Knowledge API ──► top 5 results
    │   └─ injected into system prompt before Claude sees the message
    │
    └─ MCP tool (knowledge-mcp.ts)
        Claude calls search_knowledge / get_notion_page ──► Knowledge API
        └─ Claude uses results inline in its response
```

Both paths call the same Knowledge API Server (`http://localhost:8321`), which runs as a separate process and manages vector indexing of Notion content.

## Search Paths

### 1. Auto-injection (passive)

Every incoming message triggers a knowledge search before the AI responds. Results are injected into the system prompt alongside memories, goals, and tasks.

- **File:** `src/ai/knowledge-search.ts`
- **Called from:** `src/ai/prompt-builder.ts` (parallel with memory/goal/task fetches)
- **Timeout:** 3 seconds (fails silently — knowledge is supplementary)
- **Results:** Top 5 matches, formatted as `- Title (url) — snippet`
- **Prompt section:** `Relevant company knowledge (from Notion):`

### 2. MCP tool (active)

Claude can call `search_knowledge` or `get_notion_page` during its response for deeper searches or fresh content. This is useful when the auto-injected results are insufficient or when Claude needs a specific page.

- **File:** `bots/capra/knowledge-mcp.ts`
- **Registered in:** `bots/capra/.mcp.json`
- **Tools:**
  - `search_knowledge(query, collection?, limit?)` — vector search, returns pages + snippets
  - `get_notion_page(notion_id)` — fetch fresh content from a specific Notion page

## Configuration

### Per-bot setup

Add `knowledgeCollections` to the bot's `config.json`:

```json
{
  "knowledgeCollections": ["capra-notion"]
}
```

This array is read by `discoverBots()` in `src/bots/config.ts` and passed to the prompt builder. Bots without this field (e.g. Jarvis) skip knowledge search entirely.

### MCP registration

Add the knowledge MCP server to the bot's `.mcp.json`:

```json
{
  "mcpServers": {
    "knowledge": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "knowledge-mcp.ts"],
      "env": { "KNOWLEDGE_API_URL": "http://localhost:8321" }
    }
  }
}
```

### Environment

| Variable | Default | Description |
|---|---|---|
| `KNOWLEDGE_API_URL` | `http://localhost:8321` | Knowledge API server endpoint |

## Formatting Pipeline

Knowledge results flow through a formatting pipeline depending on the platform:

```
Knowledge API response (JSON)
    │
    ├─ Auto-injection: formatKnowledgeResults() → plain text in system prompt
    │
    └─ MCP tool: Claude formats freely in its response
        │
        ├─ Telegram: formatTelegramHtml() (HTML tags)
        └─ Slack: formatSlackMrkdwn() (mrkdwn syntax)
```

### Slack formatting rules

The `formatSlackMrkdwn()` function in `src/slack/slack-format.ts` handles:

- **Markdown tables** → converted to labeled bullet lists (`• *Col:* value  *Col:* value`)
- **Links** `[text](url)` → `<url|text>` (preserved through HTML stripping via placeholder mechanism)
- **Empty bullet points** → stripped (common when Notion sections have no content)
- **Bold/italic/strike** → Slack mrkdwn equivalents
- **Code blocks** → preserved as-is

The bot's persona (`CLAUDE.md`) also instructs Claude to avoid markdown tables and empty bullets, providing defense-in-depth.

## Key Files

| File | Purpose |
|---|---|
| `src/ai/knowledge-search.ts` | HTTP client for Knowledge API, result formatting |
| `src/ai/knowledge-search.test.ts` | Tests for search client and formatting |
| `bots/capra/knowledge-mcp.ts` | MCP server with `search_knowledge` and `get_notion_page` tools |
| `bots/capra/config.json` | Per-bot knowledge collection config |
| `bots/capra/.mcp.json` | MCP server registration |
| `src/ai/prompt-builder.ts` | Injects knowledge results into system prompt |
| `src/bots/config.ts` | Bot discovery, reads `knowledgeCollections` |
| `src/slack/slack-format.ts` | Slack formatting (table conversion, link preservation) |
| `src/ai/embeddings.ts` | Local embedding generation (MiniLM, used by memory system) |

## Data Flow

1. User sends a message
2. `processMessage()` calls `buildPrompt()` which fetches knowledge in parallel with memories/goals/tasks
3. `searchKnowledge()` sends HTTP GET to Knowledge API with the user's message as query
4. Knowledge API performs vector similarity search across configured collections
5. Top 5 results (title, URL, best snippet) are formatted and added to the system prompt
6. Claude generates its response, seeing knowledge context alongside conversation history
7. During response, Claude may also call `search_knowledge` MCP tool for additional searches
8. Response is formatted for the target platform (Slack mrkdwn or Telegram HTML)
