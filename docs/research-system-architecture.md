# Research & Knowledge System — Technical Documentation

Technical documentation for the YouTube research and knowledge system spanning three repositories: **muninn** (research workbench + AI orchestration), **documents-vector-search** (Knowledge API + vector indexing), and **youtube-transcripts** (transcript collection + Chrome extension).

---

## System Overview

```
┌──────────────────────────┐      ┌─────────────────────────────────┐      ┌──────────────────────────┐
│  youtube-transcripts      │      │  documents-vector-search         │      │  muninn                  │
│                           │      │  (Knowledge API)                 │      │  (AI Agent + Dashboard)   │
│  • 238 markdown summaries │      │                                  │      │                           │
│  • 13 categories          │◀────▶│  • FastAPI on :8321              │◀────▶│  • Research workbench     │
│  • Chrome extension       │      │  • FAISS + BM25 hybrid search   │      │  • SSE streaming          │
│  • YAML frontmatter       │      │  • Cross-encoder reranking      │      │  • Multi-bot support      │
│                           │      │  • 13 collections, 10k+ docs    │      │  • Claude AI connectors   │
└──────────────────────────┘      └─────────────────────────────────┘      └──────────────────────────┘
```

### Repository Locations

| Repo | Path | Language | Purpose |
|------|------|----------|---------|
| muninn | `~/source/private/muninn` | TypeScript (Bun) | AI agent, dashboard, research workbench |
| documents-vector-search | `~/source/private/documents-vector-search` | Python (FastAPI) | Vector indexing, search API, collection management |
| youtube-transcripts | `~/source/private/youtube-transcripts` | Markdown + JS | Transcript storage, Chrome extension |

---

## 1. youtube-transcripts

### Transcript Storage

238 markdown files organized in hierarchical categories:

```
youtube-transcripts/
├── ai/
│   ├── claude-code/       (101 files)
│   ├── general/           (44 files)
│   ├── openclaw/          (12 files)
│   ├── claude/            (11 files)
│   └── rag/               (4 files)
├── career/                (11 files)
├── coding/                (1 file)
├── entertainment/         (3 files)
├── health/                (16 files)
├── parenting/             (5 files)
├── tech/                  (16 files)
├── project-notes/         (12 files)
└── chrome-extension/
```

### File Format

Each transcript is a markdown file with YAML frontmatter:

```markdown
---
date: 2026-01-13
url: https://www.youtube.com/watch?v=r65rR5AIwcg
category: ai/general
tags: "ai, general"
---

### Section Title

Content with **bold key terms**, emoji bullets, and structured headings...
```

Fields:
- `date` — creation/ingest date (YYYY-MM-DD)
- `url` — YouTube video URL
- `category` — hierarchical path matching directory (e.g., `ai/claude-code`)
- `tags` — comma-separated, derived from category path

### Chrome Extension

**Location:** `youtube-transcripts/chrome-extension/`

Manifest V3 extension targeting YouTube.com and localhost:3010.

**Files:**
- `manifest.json` — MV3 config
- `content.js` — detects YouTube video pages, extracts videoId + title
- `background.js` — service worker, submits videos to muninn, opens dashboard
- `popup.html/js` — "Summarize" button UI
- `options.html/js` — settings page (muninn URL, default `http://localhost:3010`)

**Flow:**
```
content.js detects video → stores {videoId, url, title} in tabState
  → popup.js shows "Summarize" button
  → click → background.js POST to muninn /api/youtube/summarize
  → response: {job_id, dashboard_url}
  → chrome.tabs.create opens dashboard to stream progress
```

Transcript fetching is done server-side (not in the extension) to avoid adblocker interference.

### Preprocessing

`fix_metadata.py` — one-time cleanup script:
- Adds `category` from directory path if missing
- Adds `tags` derived from category (`ai/claude-code` → `"ai, claude-code"`)
- Extracts missing URLs from body text
- Rebuilds frontmatter in consistent order

---

## 2. documents-vector-search (Knowledge API)

### Architecture

```
Raw Documents (Confluence/Notion/Jira/YouTube/Files)
  ↓ Reader (fetches documents from source)
  ↓ Converter (chunks + metadata extraction)
  ↓ Indexers (FAISS vector + BM25 keyword)
  ↓ Persister (writes to ./data/collections/)
  ↓ Knowledge API Server (HTTP search + document retrieval)
  ↓ Consumers (muninn research, MCP tools, Chrome extension)
```

### Knowledge API Server

**File:** `knowledge_api_server.py`
**Port:** 8321 (configurable)
**Framework:** FastAPI + uvicorn

Loads embedding model and FAISS indexes once at startup. Search latency <50ms after warmup.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/search?q=...&collection=...&limit=10` | Vector search with optional reranking |
| `GET` | `/api/document/{collection}/{doc_id}` | Full document content |
| `GET` | `/api/collections` | List loaded collections with stats |
| `GET` | `/api/tags?collection=...` | Tag distribution per collection |
| `GET` | `/api/collection/{name}/documents` | List documents in collection |
| `GET` | `/api/graph/{node_id}` | Knowledge graph node |
| `GET` | `/api/notion/page/{notion_id}` | Notion page content (API with local fallback) |
| `POST` | `/api/collections/{name}/update` | Trigger background incremental update |

**Search response format:**
```json
{
  "results": [
    {
      "title": "Document Name",
      "id": "doc-id",
      "url": "https://...",
      "relevance": 0.997,
      "matchedChunks": [{ "content": "..." }]
    }
  ]
}
```

### Search Pipeline

```
Query
  ├─ Embedding (multilingual-e5-base, 768 dims)
  ├─ FAISS search (semantic similarity, L2 distance)
  ├─ BM25 search (keyword matching)
  ├─ Reciprocal Rank Fusion (RRF): score = Σ 1/(k + rank)
  ├─ Cross-encoder reranking (bge-reranker-v2-m3, ~1500ms)
  ├─ Title/path boost (matching filenames)
  ├─ Deduplication (MD5 hash)
  ├─ Confidence filtering (remove noise)
  └─ Result: sorted list with 0-1 relevance scores
```

**Why hybrid search:**
- FAISS catches semantic similarity (synonyms, cross-lingual)
- BM25 catches exact terms (identifiers like "A008", "artikkel 13")
- RRF merges ranked lists — documents scoring high in both rank highest
- Cross-encoder reranking removes false positives with precise scoring

**Embedding model:** `intfloat/multilingual-e5-base` (768 dimensions, 100+ languages). Shared across all collections (~180 MB RAM savings per collection).

### Collections

**Storage:** `./data/collections/{name}/`
```
{name}/
├── documents/{id}.json        — document content + metadata
├── indexes/
│   ├── indexer_FAISS_.../indexer   — binary FAISS index
│   ├── indexer_BM25/indexer       — binary BM25 state
│   └── index_document_mapping.json — chunk ID → doc metadata
└── manifest.json              — collection metadata + last update time
```

**Active collections (13):**

| Collection | Docs | Source | Update Strategy |
|-----------|------|--------|-----------------|
| `youtube-summaries` | 238 | Chrome ext → Claude → MD | Manual (one-click) |
| `notion-docs` | 8,425 | Notion API | Incremental |
| `confluence-docs` | 289 | Confluence API | Incremental |
| `claude-sessions` | 1,220 | Claude Code session logs | Batch |
| `anthropic-docs` | — | GitHub/docs | Batch |
| `jira-issues` | — | Jira API | Incremental |

### Collection Creation & Update

**Adapters:**

| Adapter | File | Purpose |
|---------|------|---------|
| Files | `files_collection_create_cmd_adapter.py` | Index local markdown/files |
| Notion | `notion_collection_create_cmd_adapter.py` | Fetch + index Notion pages |
| Update | `collection_update_cmd_adapter.py` | Incremental update (since manifest timestamp) |
| YouTube fetch | `youtube_fetch_cmd_adapter.py` | Download transcripts via yt-dlp |
| YouTube preprocess | `youtube_preprocess_md.py` | Clean transcript → markdown |

**Creation pipeline:**
```
Reader → Converter → Indexers (FAISS + BM25) → Persister
```

- Reader fetches raw documents (Notion API, local files, etc.)
- Converter chunks documents (MarkdownHeadingSplitter ~65 chunks/doc, or SessionMarkdownSplitter ~3 chunks/session)
- Tags injected into embeddings for search boost
- Indexes written to disk as binary files

**Incremental updates:** Reads `manifest.json` for last update timestamp, fetches only new/modified documents (with 1-day buffer), removes old chunks, indexes new ones.

### MCP Adapters

Three MCP interfaces for different consumers:

| Adapter | File | Memory | Use Case |
|---------|------|--------|----------|
| Single collection | `collection_search_mcp_stdio_adapter.py` | ~200MB | One collection per process |
| Multi collection | `multi_collection_search_mcp_adapter.py` | ~200MB shared | Multiple collections, shared embedder |
| HTTP client | `knowledge_api_mcp_adapter.py` | ~0 | Thin wrapper over Knowledge API |

The HTTP client adapter (`knowledge_api_mcp_adapter.py`) is preferred — near-zero memory, delegates to running server. Exposes tools: `search_knowledge`, `get_document`, `get_graph_node`, `get_notion_page`, `list_collections`, `list_tags`.

---

## 3. muninn Research Module

The research module uses a **chat-based approach** — instead of a custom agent pipeline, the Chrome extension creates a named chat thread and sends the Jira ticket as the first message. The bot responds using its full MCP tools (knowledge search, etc.) and the user can continue chatting for follow-ups.

### Key Files

| File | Purpose |
|------|---------|
| `src/dashboard/views/research-page.ts` | Research page UI — browse mode (collection picker, tags, documents) |
| `src/dashboard/routes.ts` | Research API endpoints (browse proxies + chat creation) |
| `src/chat/pending-messages.ts` | Temporary store for pending research messages |
| `src/chat/routes.ts` | GET /pending/:threadId endpoint |
| `src/chat/views/page.ts` | Chat page with deep-link and auto-send support |
| `src/config.ts` | `knowledgeApiUrl` config |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/research/chat` | Create thread + store pending message `{bot?, title?, text, userId?, forceNew?}` → `{threadId, chatUrl}` / `409 {threadExists}` / `400 {needsUser, users[]}` |
| `GET` | `/api/research/bots` | List available bots |
| `GET` | `/api/research/bot-collections?bot=<name>` | Collections from bot's `.mcp.json` |
| `GET` | `/api/research/tags?collection=<name>` | Proxy to Knowledge API |
| `GET` | `/api/research/documents?collection=<name>` | Proxy to Knowledge API |
| `GET` | `/api/research/document/:collection/*` | Proxy to Knowledge API |
| `GET` | `/api/research/similar?collection=<name>&q=<query>` | Proxy to Knowledge API |
| `GET` | `/chat/pending/:threadId` | Consume pending message (one-time use) |

### Research Chat Flow

```
Chrome extension (on Jira page)
  → Extract ticket: title, description, comments
  → POST /api/research/chat { bot, title, text }
  → Response: { threadId, chatUrl }
  → Open chatUrl in browser

Chat page loads:
  → WebSocket connects, snapshot received
  → handleDeepLink() selects bot + thread
  → Fetches GET /chat/pending/{threadId}
  → Pending text found → sets in input → sendMessage()
  → Message sent through normal chat pipeline
  → Bot responds with full MCP tools, streamed via WebSocket
  → User can continue chatting for follow-ups
```

### Dashboard UI

**File:** `src/dashboard/views/research-page.ts`

**Browse mode:**
- Collection selector dropdown (filtered by selected bot's KNOWLEDGE_COLLECTIONS)
- Category/tag chips for filtering
- Articles grid with document listing
- Side panel for full document view
- Bot selector in header

### Multi-Bot Integration

- Bot selector in UI auto-discovers bots from `bots/` folders
- Selecting a bot loads collections from its `.mcp.json` (`KNOWLEDGE_COLLECTIONS` env var)
- Bot's persona (from `CLAUDE.md`) provides domain knowledge for analysis
- Bot uses its full MCP tools for knowledge search

### Configuration

```typescript
// src/config.ts
knowledgeApiUrl: optionalEnv("KNOWLEDGE_API_URL", "http://localhost:8321")
```

---

## End-to-End Data Flows

### Flow 1: YouTube Capture

```
Chrome extension detects YouTube video
  → User clicks "Summarize"
  → POST /api/youtube/summarize { title, url, video_id }
  → Muninn fetches transcript (youtube-transcript-api)
  → Claude summarizes + categorizes
  → Markdown saved to youtube-transcripts/{category}/{filename}.md
  → POST to Knowledge API for indexing (FAISS + BM25)
  → Dashboard opens with streaming summary
  → Similar videos returned after indexing
```

### Flow 2: Jira Research (Chat-Based)

```
Chrome extension detects Jira ticket
  → User clicks "Analyze"
  → POST /api/research/chat { bot, title, text, userId?, forceNew? }
  → If multiple users and no userId: 400 { needsUser, users[] } → extension shows picker
  → If thread exists and no forceNew: 409 { threadExists } → extension asks reuse/new
  → Success: { threadId, chatUrl }
  → Opens /chat?bot=jira-assistant&thread={threadId}
  → Chat page loads, WebSocket connects
  → handleDeepLink() picks up pending message → auto-sends
  → Bot responds using MCP tools (knowledge search, etc.)
  → User can continue chatting for follow-ups
```

### Flow 3: Browse/Search

```
User selects collection in browse mode
  → GET /api/research/tags?collection=... (tag chips)
  → GET /api/research/documents?collection=... (document list)
  → Click document → GET /api/research/document/:collection/:docId
  → Or search → GET /api/research/similar?collection=...&q=...
```

---

## Development & Running

### Prerequisites

- Knowledge API running: `cd /path/to/documents-vector-search && uv run knowledge_api_server.py --collections youtube-summaries confluence-docs jira-issues --port 8321`
- Muninn database: `bun run db:up`

### Starting Research

```bash
# Start Knowledge API (separate terminal)
cd ~/source/private/documents-vector-search
uv run knowledge_api_server.py --collections youtube-summaries confluence-docs jira-issues --port 8321

# Start muninn with dashboard
cd ~/source/private/muninn
bun run dev

# Open research page
open http://localhost:3010/research
```

### Git Branch

Research feature developed on `feature/research-page`. Key commits:

```
220ba8c Replace term extraction with LLM-generated search queries
9323cdb Show relevance scores with one decimal place
a9b23a2 Use bot connector and persona in research agent
0e68708 Auto-resolve collections from bot config and populate form on job load
19ebc9f Add debug logging to research analyze endpoint
4dd8177 Add CORS support for research analyze endpoint
df68d5c Move bot selector to header bar, matching other pages
003b498 Add bot selector to research page with per-bot collection filtering
8c21398 Add research page with multi-source agent workbench
```

---

## Roadmap

Documented in `youtube-transcripts/KNOWLEDGE_SYSTEM_PLAN.md`:

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Add Anthropic Docs collection (RAG over Claude Code docs) | Planned |
| 2 | Build unified knowledge graph across collections | Planned |
| 3 | Muninn knowledge dashboard (search + graph visualization) | Partially done (research page) |
| 4 | On-demand indexing (Jira, Confluence, web pages from Chrome) | Planned |
| 5 | Auto-indexing pipeline (watch for new updates) | Planned |
