# Memory System Improvements Plan

**Status:** Roadmap — no improvements implemented yet (as of 2026-02-18)

Comparison of Muninn memory system with OpenClaw's approach, with concrete improvements identified.

## Current State: What Muninn Does Well

| Feature | Muninn | OpenClaw |
|---|---|---|
| **Extraction** | Async Haiku summarization per message | No extraction — indexes raw files |
| **Scope** | `personal` / `shared` classification | Single namespace |
| **Multi-bot** | Per-bot namespacing | Per-agent SQLite databases |
| **Search** | Reciprocal Rank Fusion (RRF) | Weighted blend (0.7 vec + 0.3 keyword) |
| **Storage** | PostgreSQL + pgvector (production-grade) | SQLite + sqlite-vec (local-only) |

Muninn's approach of *creating* memories from conversations is stronger than just chunking raw files — it distills signal from noise.

---

## Improvement 1: Memory Deduplication

**Priority**: High — prevents clutter, easy win

**Problem**: The same fact extracted from multiple conversations creates duplicate memories. No dedup exists today.

**Solution**: Before saving a new memory, check cosine similarity against existing memories for the same user/bot. If similarity > 0.92, skip or merge.

**Implementation**:
- In `src/memory/extractor.ts`, after generating the embedding and before `saveMemory()`:
  - Query top-1 most similar existing memory via `embedding <=> $1` in pgvector
  - If cosine similarity > 0.92, skip the save (or update the existing memory's timestamp)
- Add `findSimilarMemory(embedding, userId, botName, threshold)` to `src/db/memories.ts`

---

## Improvement 2: Active Memory Search Tool

**Priority**: High — biggest capability uplift

**Problem**: Muninn only *passively* injects the top 5 memories during prompt building. The bot can't search for something specific if the initial 5 don't cover it.

**Inspiration**: OpenClaw gives the AI agent `memory_search` and `memory_get` tools so it can actively query its memory mid-conversation.

**Solution**: Add a memory search MCP tool to each bot so Claude CLI can search memories on-demand.

**Implementation options**:
1. **Lightweight MCP server** — small Bun process that exposes `memory_search` and `memory_get` tools, connecting to the shared Postgres DB
2. **Prompt-based hint** — tell the bot in its persona that it can ask "search my memories for X" and handle it as a special command in the message processor
3. **Claude CLI tool_use** — add memory search as a bash tool in `.claude/settings.local.json`

Option 1 is cleanest. The MCP server would:
- Accept a query string
- Generate an embedding
- Run `searchMemoriesHybrid()`
- Return formatted results

---

## Improvement 3: Recency Weighting

**Priority**: Medium — better relevance with zero additional cost

**Problem**: A 6-month-old memory ranks the same as yesterday's. Neither Muninn nor OpenClaw has this.

**Solution**: Add a recency factor to the RRF score in `searchMemoriesHybrid()`.

**Implementation**:
```sql
-- Add recency boost: memories from last 7 days get up to 0.1 bonus
SELECT ...,
  (COALESCE(1.0/(60 + f.rank), 0) + COALESCE(1.0/(60 + v.rank), 0))
  * (1.0 + 0.1 * GREATEST(0, 1.0 - EXTRACT(EPOCH FROM now() - created_at) / (7 * 86400)))
  AS rrf_score
FROM ...
```

This gives a 10% boost to memories from the last week, decaying linearly to 0% at 7+ days. The boost is small enough to not override relevance but enough to break ties in favor of recent context.

---

## Improvement 4: Per-Bot Memory Config

**Priority**: Medium — fits existing config.json pattern

**Problem**: Memory retrieval parameters (limit, score threshold) are hardcoded. Different bots may need different settings.

**Inspiration**: OpenClaw has per-agent overrides for `maxResults`, `minScore`, hybrid weights, and chunk sizes.

**Solution**: Add memory config to per-bot `config.json`:

```json
{
  "model": "sonnet",
  "memory": {
    "maxResults": 5,
    "minScore": 0.35,
    "recencyBoostDays": 7,
    "recencyBoostFactor": 0.1
  }
}
```

**Implementation**:
- Extend `BotConfig` interface in `src/bots/config.ts`
- Pass config through to `searchMemoriesHybrid()` in prompt-builder
- Default to current values if not specified

---

## Improvement 5: Embedding Cache

**Priority**: Medium — performance optimization

**Problem**: Muninn recomputes the query embedding every time, even for repeated or similar queries.

**Inspiration**: OpenClaw caches computed embeddings by hash with LRU pruning.

**Solution**: Simple in-memory LRU cache for `generateEmbedding()` results.

**Implementation**:
- Add a `Map<string, number[]>` cache in `src/ai/embeddings.ts`
- Key: SHA256 hash of input text
- Max entries: 500 (384-dim * 4 bytes * 500 ≈ 750KB — negligible)
- Eviction: LRU (delete oldest entry when full)

---

## Improvement 6: Memory Consolidation Job

**Priority**: Low — nice-to-have for long-running bots

**Problem**: Over time, similar memories accumulate (e.g., "user prefers dark mode" + "user always enables dark theme").

**Solution**: Periodic background task (scheduler job) that merges semantically similar memories using Haiku.

**Implementation**:
1. Add a scheduler task type `memory-consolidation`
2. Runs weekly (or configurable)
3. For each user/bot combo:
   - Fetch all memories
   - Cluster by cosine similarity (> 0.85 threshold)
   - For each cluster with 2+ memories, call Haiku to produce a single consolidated summary
   - Replace cluster with consolidated memory, preserve oldest `created_at`

---

## What NOT to Borrow from OpenClaw

- **SQLite storage**: Postgres + pgvector is better for our multi-bot, multi-user setup
- **File watching**: OpenClaw watches MEMORY.md files, but our memories are extracted from conversations, not files
- **Multiple embedding providers**: Over-engineered for our use case — MiniLM-L6 works fine locally and is free
- **Atomic index swaps**: Not needed with Postgres (transactional writes)
- **Session transcript indexing**: We already store full `content` alongside `summary` in the memories table and both are FTS-indexed

---

## Implementation Order

| # | Improvement | Effort | Impact |
|---|---|---|---|
| 1 | Memory deduplication | Small | High — prevents clutter |
| 2 | Active memory search tool | Medium | High — biggest capability uplift |
| 3 | Recency weighting | Small | Medium — better relevance |
| 4 | Per-bot memory config | Small | Medium — flexibility |
| 5 | Embedding cache | Small | Medium — performance |
| 6 | Memory consolidation job | Large | Low — long-term hygiene |
