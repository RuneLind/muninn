# Handover — Connector tracing parity

**Branch:** `feature/connector-tracing-parity` (5 commits, not yet pushed)
**Status:** Code changes complete + tests passing. Open question on whether the divert-to-file rewrite actually keeps context clean in practice — bot's self-report is ambiguous (see "Open question" below).

## Goal

Bring `claude-cli` and `openai-compat` connectors up to the trace fidelity `copilot-sdk` had: inline `intent` bubbles for `report_intent` tool calls, Huginn `searchTrace` pinned to tool spans, and per-turn `contextTokens` reported on the `claude` span. Same `attributes.searchTrace` payload on every connector regardless of how the agent loop is owned.

## Commits

| Hash | What | Why |
|---|---|---|
| `7ab3c0f` | Add tracing parity for claude-cli and openai-compat | Shared `isReportIntentTool` / `extractIntentText` helpers in `stream-parser.ts`; intent emission for both new connectors; per-turn `contextTokens` from `assistant.message.usage`. Tests in `stream-parser.test.ts`. |
| `4a90bb3` | Unwrap MCP envelope in openai-compat tool results | Pre-existing bug from PR #78: `JSON.stringify(mcpResult)` hid the trace fence inside the `{content:[{type:"text",text:…}]}` envelope, so `parseHuginnTrace` couldn't anchor on the closing ```` ``` ````. Now uses `extractMcpResultText` first, like `copilot-sdk` does. |
| `75c4198` | Stop HUGINN_TRACE_DEFAULT for claude-cli and copilot-sdk | **Wrong call.** I queried `search_knowledge (knowledge)` (claude-cli display) and saw `0/36` spans with `searchTrace`, missed `knowledge-search_knowledge` (copilot-sdk display) which had `122/182`. Disabled a working feature. Reverted in next commit. Consider squashing with `68ad460` before push. |
| `68ad460` | Capture searchTrace for claude-cli via parse-before-truncate | Re-enabled the env var. Real bug for claude-cli was that the fence sat past `truncateOutput`'s 16 KB cap and got cut off in storage. Moved `parseHuginnTrace` *before* `truncateOutput` in `stream-parser.ts:handleUser` so `searchTrace` populates regardless of result size. |
| `d7cb6c4` | Recover Huginn trace from Claude CLI divert-to-file path | When result > Claude CLI's `MAX_MCP_OUTPUT_TOKENS`, the CLI saves to `~/.claude/projects/<id>/tool-results/<file>.txt` and hands the model an "Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to <path>" placeholder. New helper `recoverOversizedClaudeCliToolResult` in `huginn-trace.ts`: parses the placeholder, reads the file, extracts the trace, **rewrites the file with the fence stripped** so the model's next `Read` doesn't pull the trace JSON back into context. |

## Final architecture per connector

| Connector | How it sees tool results | Where searchTrace comes from | Context bloat protection |
|---|---|---|---|
| `claude-cli` | Stream NDJSON `tool_result` events, post-fact | (a) Inline: `parseHuginnTrace` in `stream-parser.handleUser` before truncation. (b) Diverted: `recoverOversizedClaudeCliToolResult` reads the saved file. | (a) Model gets fence inline (~14 KB). (b) File rewritten fence-free, so the model's `Read` returns clean content. |
| `copilot-sdk` | SDK fires `tool.execution_complete` events | `extractMcpResultText` reads `contents[]` (full payload even when SDK puts a placeholder in `content`), then `parseHuginnTrace`. | SDK's own oversized-tool-output divert keeps full payload off the model's context; model only sees the SDK placeholder. |
| `openai-compat` | Muninn calls MCP via `dashboard/mcp-client.ts` directly inside the agent loop | `extractMcpResultText` then `parseHuginnTrace` *before* the cleaned text is added to `messages`. | Model never sees the fence — Muninn strips before forwarding. Last fully-clean path. |

Env var injection currently:
- `src/ai/executor.ts:71` — `HUGINN_TRACE_DEFAULT: "1"` for claude-cli MCP spawns
- `src/ai/connectors/copilot-mcp.ts:81` — same for copilot-sdk MCP spawns
- `src/dashboard/mcp-client.ts:108` — same for openai-compat (also dashboard MCP debug)

## Files changed (cumulative on branch)

| File | What changed |
|---|---|
| `src/ai/stream-parser.ts` | New `isReportIntentTool` / `extractIntentText` exports. `handleAssistant` emits `intent` events for `report_intent`. `handleUser` runs `parseHuginnTrace` (and the divert-recovery) before `truncateOutput`. `lastTurnInputTokens` tracked from `assistant.message.usage`, exposed as `getResult().contextTokens`. New `searchTrace` field on `PendingToolCall`. |
| `src/ai/stream-parser.test.ts` | +13 tests covering intent emission, contextTokens, helper functions, and the parse-before-truncate path. |
| `src/ai/huginn-trace.ts` | New `recoverOversizedClaudeCliToolResult` + `OversizedRecovery` interface. Imports `readFileSync`/`writeFileSync` from `node:fs`. |
| `src/ai/huginn-trace.test.ts` | +6 tests covering recovery, opt-out, no-fence case, missing file, malformed JSON. |
| `src/ai/connectors/openai-compat.ts` | Imports `isReportIntentTool` / `extractIntentText` (intent emission) and `extractMcpResultText` (envelope unwrapping). Tool execution loop now keeps `rawResult` as the unwrapped MCP value, then runs `extractMcpResultText` → `parseHuginnTrace` → `messages.push({content: cleaned})`. `searchTrace` set on `ToolCall`. |
| `src/ai/connectors/copilot-sdk.ts` | Switched to shared `isReportIntentTool` / `extractIntentText` helpers; deleted the local copies. |
| `src/ai/connectors/copilot-mcp.ts` | (No net change vs `main` — `75c4198` removed `HUGINN_TRACE_DEFAULT` then `68ad460` restored it.) |
| `src/ai/executor.ts` | Same — net no change vs `main`. |
| `src/ai/tool-status.ts` | `getToolStatus` suppresses status text for `report_intent` across all naming formats (bare, `mcp__server__report_intent`, `server-report_intent`). |

Wiki repo (`muninn-and-huginn-wiki`, branch `main`, commit `6dd2592`):
- `wiki/muninn/tracing.md` — added "Connector parity" section + status-table row.

## Open question — model self-report vs reality

The bot just told the user (in Norwegian) something like:

> "The search ran — one call, result saved to file (210k chars, too big to show inline). This should be visible in tracing now. Yes, I see the tool result because that's how tool use works — search_knowledge returns the result as a tool response in my context. 210k chars is a lot — it takes up a large part of the context window."

This is ambiguous. Two interpretations:

1. **The model is parroting the placeholder text.** The placeholder string Claude CLI hands the model says "Error: result (210,xxx characters) exceeds maximum allowed tokens. Output has been saved to <path>." The model might be reading the size from that text without ever issuing a `Read` against the file. If so, our rewrite worked but the model never tried to use the data.

2. **The model is reading the file and seeing 210 K chars.** That would mean our rewrite isn't taking effect — either a race (model reads before stream-parser rewrites), a bug in the path extraction, or write permissions. Worth checking the file on disk after a search to see if it's fence-free.

**Quick verifications to settle this in the next session:**

```bash
# Find the most recent saved tool-result file
ls -lt ~/.claude/projects/-Users-rune-source-private-muninn-bots-melosys/*/tool-results/*.txt | head -3

# Check if it contains the trace fence (should NOT after a successful rewrite)
grep -l 'huginn-trace' ~/.claude/projects/-Users-rune-source-private-muninn-bots-melosys/*/tool-results/*.txt
```

```sql
-- Did searchTrace land on the most recent claude-cli search?
SELECT name, attributes ? 'searchTrace' as has_trace,
       length(attributes->>'output') as out_len,
       left(attributes->>'output', 120) as out_head
FROM traces
WHERE name = 'search_knowledge (knowledge)'
ORDER BY started_at DESC LIMIT 5;
```

If `has_trace` is `t` and the file no longer contains `huginn-trace`, the recovery worked and the bot's "210k chars" claim was just placeholder-parroting. No further action needed.

If `has_trace` is `f` or the file still has the fence, debug `recoverOversizedClaudeCliToolResult` in `huginn-trace.ts:175-235`. Most likely culprit: the regex `CLAUDE_CLI_OVERSIZED_RE` not matching the actual placeholder format (the user's example included `\n` between path and "Format:" — make sure the live placeholder has the same shape).

## Useful queries

```sql
-- Coverage by connector display name (the lesson from this branch:
-- claude-cli uses "(server)" suffix, copilot-sdk uses "<server>-".
-- Querying only one missed the working case.)
SELECT name, count(*),
       count(*) FILTER (WHERE attributes ? 'searchTrace') AS w_trace
FROM traces WHERE name LIKE '%search_knowledge%' GROUP BY name;

-- Recent claude-cli traces with token counts
SELECT trace_id, started_at, attributes->>'inputTokens' as in_tok, attributes->>'numTurns' as turns
FROM traces WHERE name = 'claude' AND attributes->>'model' LIKE 'claude%'
ORDER BY started_at DESC LIMIT 10;
```

## Suggested next-session tasks

1. **Verify the rewrite works in practice** — run the queries above after a search that triggers the divert, confirm fence is gone from disk and `searchTrace` is on the span.
2. **Squash `75c4198` into `68ad460`** before pushing if you want clean history (the wrong-call + revert pair adds noise). Branch isn't pushed yet so this is safe.
3. **Update wiki status table again** if all three connectors now have `searchTrace` end-to-end. The `tracing.md` "Connector parity" section already mentions it; the per-connector status row could call out the divert-recovery path.
4. **Consider adding a Phase 2 follow-up** — out-of-band trace channel (Huginn returns trace via MCP `_meta` instead of inline fence). That would let us drop both the parse-before-truncate hack and the file-rewrite hack. See wiki "Future work" section.
5. **(Optional) Open PR** with `/pr` once verified.

## Key learning to carry forward

When checking trace coverage in the DB, **always group by `name`** rather than picking a single display string. The three connectors produce different display names for the same tool — `mcp__knowledge__search_knowledge` becomes `search_knowledge (knowledge)` for claude-cli but `knowledge-search_knowledge` for copilot-sdk's dash-style. Querying one connector's name and assuming it represents all of them is what led to commit `75c4198` (since reverted).
