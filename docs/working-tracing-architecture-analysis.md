# Working doc — Connector tracing architecture analysis

**Branch:** `feature/connector-tracing-parity`
**Status:** Analysis pass complete; Phase 2 (out-of-band trace channel) being scoped.

This is a working document, not a final design. It captures (1) the current state after the connector parity branch, (2) why the "tool result is in context twice" claim from the bot was a red herring, and (3) the path forward to a cleaner architecture.

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
| **MCP spec** (`spec.types.d.ts:Result`) | `_meta?: { [key: string]: unknown }` is on the base `Result` type that `CallToolResult` extends. Spec-level support confirmed. |
| **TS SDK client** (`@modelcontextprotocol/sdk` in muninn) | `client.callTool()` returns top-level `_meta?: { progressToken?, "io.modelcontextprotocol/related-task"?, [x:string]: unknown }`. Custom `_meta` keys are preserved verbatim. ✅ |
| **Python SDK server** (`mcp.types.CallToolResult` extends `Result`) | `meta: dict[str, Any] \| None = Field(alias="_meta")`. Setting it serializes to JSON `_meta` over the wire. ✅ |
| **FastMCP tool returns** (`func_metadata.py`) | `if isinstance(result, CallToolResult): … return result` — FastMCP passes `CallToolResult` through unchanged, including `_meta`. ✅ |
| **Muninn's openai-compat path** (`mcp-client.ts:148`) | Returns the raw SDK result; just read `(result as any)._meta?.["huginn.trace"]`. ✅ |
| **Claude CLI NDJSON** | **Not yet probed.** Need to write a tiny test MCP server that sets `_meta`, run `claude -p --output-format stream-json --verbose`, and grep the NDJSON `tool_result` block for `_meta`. This is the load-bearing unknown. |
| **Copilot SDK** | **Not yet probed.** Need to inspect `event.data.result` shape on a `tool.execution_complete` event when the upstream tool sets `_meta`. |

### The load-bearing unknown

If `claude-cli` strips `_meta` before exposing the `tool_result` to NDJSON consumers, this approach won't work for that connector and we'd need either:
- A tiny pointer in text (`huginn-trace-id: <uuid>`) plus a Huginn-side store Muninn fetches from, or
- Continue to ship the fence in text *only* for claude-cli, with the existing parse + recover paths.

Same for `copilot-sdk` — but that connector already gives us `result.contents[]` access in `tool.execution_complete`, so even if `_meta` doesn't surface, we have a degraded path.

## 6. Open questions / TODO

- [x] **Verify divert-recovery actually works in production** — **Confirmed working** for the relevant case. For jarvis (the only Muninn-spawned claude-cli bot today), 0/7 of the saved tool-result files contain the trace fence. The 5/12 fence-bearing files in `bots-melosys` come from interactive `claude` sessions Rune ran from the bot directory, **not** from Muninn — melosys is configured `connector: copilot-sdk`, so Muninn's stream-parser was never in that loop. Probe of `recoverOversizedClaudeCliToolResult` against an actual fence-bearing file successfully extracted the trace, so the regex and recovery logic are sound. Capra has no diverted files at all (small results).
- [ ] **Probe `_meta` end-to-end for each connector**:
  - `claude-cli`: write a tiny MCP test server that sets `_meta`; run it under `claude -p --output-format stream-json`; grep the NDJSON for `_meta`.
  - `copilot-sdk`: same setup; inspect `event.data.result` shape on `tool.execution_complete`.
  - `openai-compat`: trivial — `mcp-client.ts` returns the raw `CallToolResult`, just read `result._meta`.
- [ ] **Decide fallback for connectors that drop `_meta`** — likely a `huginn-trace-id` pointer + a Huginn-side trace store endpoint Muninn can fetch. Worth a Phase 3.
- [ ] **Squash `75c4198` into `68ad460`** before pushing the branch (carry-over from prior handover).

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
