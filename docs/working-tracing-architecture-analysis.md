# Working doc — Connector tracing architecture analysis

**Branch:** `feature/connector-tracing-parity` (PR #81)
**Status:** Phase 2 landed via trace-id pointer pattern — verified end-to-end on jarvis. Original "kill Phase 2" verdict (below) was reversed once we measured the actual trace size and realized the divert was a functional bug, not just complexity.

This is a working document. It captures (1) the connector parity state, (2) why the "tool result is in context twice" claim from the bot was a red herring, (3) the dead-end exploration of MCP `_meta` as a side-channel, and (4) how we got out the other side with the pointer pattern that actually shipped.

## 1. The two channels (the principle)

When a bot calls `search_knowledge` (or any MCP tool), there are **two independent things** that should happen:

| Channel | Carries | Audience |
|---|---|---|
| **Tool result → LLM context** | The text the model needs to answer (search hits, document content) | The LLM, via the `tool_result` mechanism the agent loop already manages |
| **Trace → dashboard** | Per-stage timing, scores, candidate ranks (debug metadata) | Operators in `/traces` waterfall — never the LLM |

**Invariant:** The tracing layer must observe, not manipulate. Anything tracing-only (search-stage scores, RRF ranks, CE deltas) must travel on a side-channel — not bolted onto the same text the model reads.

Today this invariant is **mostly held**, but in two places it's bent:

- The Huginn fence (` ```huginn-trace ` block) **is** glued onto the same text channel; we strip it on the way in. Until it's stripped, any non-stripping consumer leaks ~14 KB of trace JSON into model context.
- For `claude-cli`, when the result exceeds `MAX_MCP_OUTPUT_TOKENS`, Muninn rewrites the file the CLI saved to disk. This is technically prompt-manipulation, not pure observation.

## 2. Where each connector stands today

| Connector | Agent loop owner | Model sees | Span sees | Tracing modifies model context? |
|---|---|---|---|---|
| `claude-cli` | Claude CLI | Inline path: full tool_result **with** fence (CLI feeds the model directly). Divert path: ~200-byte placeholder pointing at a file. | Cleaned text + `searchTrace` pinned to span | **Yes — divert path only.** `recoverOversizedClaudeCliToolResult` rewrites the saved file with the fence stripped, so a later `Read` returns ~196 KB instead of ~210 KB. |
| `copilot-sdk` | SDK | What SDK chooses to feed it (SDK has its own oversized-divert) | Cleaned text + `searchTrace` extracted from `result.contents[]` | No. Pure observation. |
| `openai-compat` | **Muninn** | Cleaned text — fence stripped before push to `messages` | Same cleaned text + `searchTrace` | Yes — but at the tool-result boundary, which is the right place. The LLM never asked for trace JSON, and Muninn is the agent loop owner here. |

Span-attribute writes (`message-processor.ts:181-208`) only land in the `traces` table. There is **no code path** from `traces` back into `prompt-builder.ts`. Tool outputs do not get re-injected into prompts.

## 3. Debunking the "210k chars in context twice" report

The melosys bot self-reported (paraphrased): *"the search ran, result is 210k chars in my context, that's a lot of the context window."*

What actually happened on the divert path:

1. Huginn returns ~210 KB (with fence inside).
2. Claude CLI sees `> MAX_MCP_OUTPUT_TOKENS`, writes the payload to `~/.claude/projects/<id>/tool-results/<uuid>.txt`, and hands the model a **placeholder** like:
   > `Error: result (210,xxx characters) exceeds maximum allowed tokens. Output has been saved to /Users/.../uuid.txt. Format: JSON with schema: {result: string}`
3. Muninn's `stream-parser.handleUser` catches this in `recoverOversizedClaudeCliToolResult`: reads the file, peels the trace off, rewrites the file with `result` set to the fence-stripped text.
4. `searchTrace` is set on the span; the span output stays as the placeholder text so the inspector shows "diverted to file".

So at this point, the model has **~200 chars of placeholder** in its context, not 210 KB. The "210k chars" number it cited comes from parsing the placeholder string itself ("Error: result (210,xxx characters)…"). It's confabulation: the model read a number from text it can see and wove a story about its own context window.

If the model later fires `Read /path/to/uuid.txt`, *then* ~196 KB lands in context — but only if the rewrite worked, that 196 KB is search results, not trace JSON. Either way, no double-injection.

**Lesson:** treat LLM self-introspection about its own context as fiction. Use the SQL queries below to ground-truth what's actually in spans.

## 4. The four moving parts of trace handling today

This is the surface area Phase 2 should aim to collapse:

| # | Where | What it does | Why it has to exist today |
|---|---|---|---|
| 1 | `huginn/knowledge_api_mcp_adapter.py:292-293` | Appends ` ```huginn-trace\n…\n``` ` fence to the tool result text | MCP-stdio adapter only knows how to return strings; no out-of-band channel |
| 2 | `muninn/src/ai/stream-parser.ts:178-200` | `parseHuginnTrace` runs **before** `truncateOutput` so the closing fence isn't cut off | 16 KB cap would otherwise drop the closing ``` and leave trace stuck in the visible text |
| 3 | `muninn/src/ai/huginn-trace.ts:192-241` | Reads the saved-to-disk file, peels trace, rewrites file fence-free | Otherwise the model's `Read` pulls trace JSON back into context |
| 4 | `muninn/src/ai/connectors/openai-compat.ts:217-248` | Strips fence from text before pushing to `messages` | Otherwise local-model contexts (e.g. qwen3-35B) get polluted with debug JSON |

Three of these (#2, #3, #4) only exist because of #1. Fix the source and the rest can go.

## 5. Phase 2 — out-of-band trace channel via MCP `_meta`

The MCP spec already has the right primitive: `CallToolResult` carries a `_meta: object | undefined` field that all SDKs preserve through the wire. **Move the trace there** instead of fencing it into the text:

```python
# huginn/knowledge_api_mcp_adapter.py — instead of fencing
return CallToolResult(
    content=[TextContent(type="text", text=text)],
    _meta={"huginn.trace": data["trace"]} if TRACE_DEFAULT and data.get("trace") else None,
)
```

```ts
// muninn/src/ai/connectors/openai-compat.ts — instead of parseHuginnTrace
const meta = (rawResult as { _meta?: Record<string, unknown> })._meta;
const searchTrace = meta?.["huginn.trace"];
const cleanedText = extractMcpResultText(rawResult);   // unchanged
```

What this buys us:

- **#2 disappears** — no fence in text means no `parseHuginnTrace`, no parse-before-truncate dance.
- **#3 disappears** — the diverted file no longer contains trace JSON, so no rewrite needed.
- **#4 disappears** — the model never sees the trace, so there's nothing to strip at the boundary.
- **The invariant from §1 is restored** — tracing reads `_meta`, never touches text.

### What was verified (this session)

| Layer | Result |
|---|---|
| **MCP spec** (`spec.types.d.ts:Result`) | `_meta?: { [key: string]: unknown }` is on the base `Result` type that `CallToolResult` extends. ✅ |
| **TS SDK client** (`@modelcontextprotocol/sdk`) | `client.callTool()` preserves top-level `_meta`. ✅ |
| **Python SDK server** (`mcp.types.CallToolResult` extends `Result`) | `meta: dict[str, Any] \| None = Field(alias="_meta")` — serializes to wire `_meta`. ✅ |
| **FastMCP tool returns** | `if isinstance(result, CallToolResult): return result` — passes `_meta` through. ✅ |
| **Muninn's openai-compat path** (`mcp-client.ts:148`) | Raw SDK result returned; reading `_meta` is trivial. ✅ |
| **Claude CLI NDJSON** | **`_meta` is fully stripped.** Probe `scripts/probe-claude-cli-meta.ts` set `_meta` on a `CallToolResult`; the marker `META_PROBE_MARKER_42` appeared **nowhere** in NDJSON output (3 runs, with and without `--include-partial-messages`). ❌ |
| **Claude CLI structuredContent** | Surfaced — but **as model-facing tool result content**, not as a side-channel. Marker reached the model and `event.tool_use_result.structuredContent` carries the same payload that's also serialized into `message.content[].content`. ⚠️ Not usable for trace data the model shouldn't see. |
| **Copilot SDK** | Not probed yet, but irrelevant — that connector already extracts trace from `result.contents[]` (the existing `extractMcpResultText` path), so even if `_meta` worked, the existing path is sufficient. |

### Verdict — Phase 2 as designed is dead

Claude CLI's NDJSON deliberately exposes only what the model is meant to see. `_meta` exists in the MCP wire format but is filtered out before reaching the orchestrator. There is no out-of-band channel through claude-cli — anything we want to surface to Muninn-the-trace-collector must travel through the same text channel the LLM reads.

This kills "out-of-band via `_meta`" as a clean architectural win. It does **not** kill the goal, but the realistic options change shape:

| Option | What | Pros | Cons |
|---|---|---|---|
| **A. Keep current architecture** | Three strip paths (fence/divert-rewrite/openai-strip) stay as-is. Document the "why" so future readers don't mistake the complexity for accident. | Verified working in prod; tested; bug surface is bounded. | Future readers will be tempted to "clean it up" without realizing claude-cli forces the design. |
| **B. Trace-id pointer + Huginn store** | Huginn writes a single short line (`huginn-trace-id: <uuid>`) to the tool result text and stores the trace JSON behind a `GET /api/trace/<id>` endpoint. Muninn strips the line and fetches the trace via HTTP. | One unified strip path (regex one line, not 14 KB JSON). If strip ever fails, only ~50 bytes of pollution reach the model — harmless. Same pattern across all 3 connectors. | Requires Huginn-side trace store (in-memory + TTL is fine) + HTTP endpoint. Adds a localhost round-trip per search. |
| **C. Two-channel split** | `_meta` for openai-compat, keep fence for claude-cli, copilot-sdk uses existing `contents[]` path. | Simplifies 1/3 connectors. | Increases connector divergence; the win doesn't justify the change. |

**Original recommendation (later reversed): Option A.** The reasoning at the time was that the existing architecture works, is tested, and the "210k twice" panic was confabulation rather than a real bug. With `_meta` ruled out, the cleanup payoff seemed too small to justify the change.

**What actually happened: we did Option B.** A follow-up search on melosys produced a 232 KB tool result that *did* trip Claude CLI's divert — and DB inspection showed the trace alone was 188 KB (Huginn's hybrid indexer overfetches `fetch_k * 3` from each of FAISS and BM25, and the trace records every candidate). That made Phase 2 a functional bugfix, not just complexity-removal: the model was getting a 1 KB error placeholder instead of the actual hits and confabulating answers from nothing. We coordinated with the huginn peer to ship the trace-id pointer pattern (Huginn `feature/search-trace-pointer`, Muninn PR #81). Pipeline verified end-to-end on jarvis 2026-05-02. See `wiki/muninn/tracing.md` § *Phase 2 — out-of-band trace via pointer URL* for the canonical design.

## 6. Open questions / TODO

- [x] **Verify divert-recovery actually works in production** — **Confirmed working** for the relevant case. For jarvis (the only Muninn-spawned claude-cli bot today), 0/7 of the saved tool-result files contain the trace fence. The 5/12 fence-bearing files in `bots-melosys` come from interactive `claude` sessions Rune ran from the bot directory, **not** from Muninn — melosys is configured `connector: copilot-sdk`, so Muninn's stream-parser was never in that loop. Probe of `recoverOversizedClaudeCliToolResult` against an actual fence-bearing file successfully extracted the trace, so the regex and recovery logic are sound. Capra has no diverted files at all (small results).
- [x] **Probe `_meta` end-to-end for claude-cli** — done. `scripts/probe-meta-mcp-server.py` + `scripts/probe-claude-cli-meta.ts`. Result: `_meta` is stripped, `structuredContent` reaches the model. No side-channel through claude-cli.
- [x] **Decide fallback** — initial verdict was Option A (keep current architecture). Reversed once we measured the 188 KB trace and saw the divert was real; shipped Option B (trace-id pointer + Huginn store) as `feature/search-trace-pointer` (huginn) + PR #81 (muninn).
- [ ] **Squash `75c4198` into `68ad460`** before pushing the branch (carry-over from prior handover).
- [ ] **Update `wiki/muninn/tracing.md`** — the "Future work" section currently lists "out-of-band trace channel via MCP `_meta`" as a Phase 2 item; update to reflect that this was probed and ruled out, with a pointer to this working doc for the rationale.

## 7. Useful queries

```sql
-- Coverage by display name (different connectors render the same MCP tool differently)
SELECT name, count(*),
       count(*) FILTER (WHERE attributes ? 'searchTrace') AS w_trace
FROM traces WHERE name LIKE '%search_knowledge%' GROUP BY name;

-- Did searchTrace land on the most recent claude-cli search?
SELECT name, attributes ? 'searchTrace' as has_trace,
       length(attributes->>'output') as out_len,
       left(attributes->>'output', 120) as out_head
FROM traces
WHERE name = 'search_knowledge (knowledge)'
ORDER BY started_at DESC LIMIT 5;
```

```bash
# Check that diverted files no longer contain the fence after rewrite
grep -l 'huginn-trace' \
  ~/.claude/projects/-Users-rune-source-private-muninn-bots-melosys/*/tool-results/*.txt \
  || echo "All clean"
```

## 8. Sources

- `docs/handover-connector-tracing-parity.md` — prior session's handover with the open question
- `wiki/muninn/tracing.md` — current canonical design doc; explains span tree, schema, opt-in surfaces
- `src/ai/stream-parser.ts:164-204` — the `handleUser` path with parseHuginnTrace + recovery
- `src/ai/huginn-trace.ts` — both `parseHuginnTrace` and `recoverOversizedClaudeCliToolResult`
- `src/ai/connectors/openai-compat.ts:217-248` — boundary-strip logic
- `src/core/message-processor.ts:164-211` — span attribute assembly + `emitSearchTraceSpans`
- `huginn/knowledge_api_mcp_adapter.py:292-293` — where the fence is currently emitted
