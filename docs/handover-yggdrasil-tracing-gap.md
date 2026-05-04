# Handover — yggdrasil trace coverage gap

## TL;DR

`yggdrasil-search` (and only `search`) emits a fence-mode trace that muninn captures. Every other yggdrasil tool — `search_pattern`, `read_source`, `symbol_context`, `file_outline`, `impact`, `list_files`, `list_repos`, `detect_changes` — has **zero** trace coverage in muninn. This is **not** a connector asymmetry (claude-cli vs copilot-sdk both behave identically here); it is a yggdrasil-server-side gap.

`yggdrasil-trace-url:` pointer-mode is also never observed in any trace — yggdrasil only emits inline fence, even though the server has `YGGDRASIL_TRACE_POINTER=1` in its env.

The investigation belongs in the yggdrasil repo, not muninn. Muninn's parser is verified working (it captures traces correctly when present).

## What just shipped (PR #91)

Six commits across two days:

| Commit | What |
|---|---|
| `30c7f2e` | (pre-existing) Stop chat page from overriding Jira plugin's chosen connector |
| `b58534b` | Spread `process.env` into spawned MCP child env in `copilot-mcp.ts` so `HUGINN_TRACE_POINTER` etc. propagate |
| `a706a87` | Simplify trace env helpers, drop unused `_resetTraceFlagsLoggedForTest` |
| `78b0a3f` | Fix parallel claude-cli tool capture (resolve each `tool_result` inline; drain in `handleResult`) |
| `2658668` | Trim narrative comments |
| `a9be60c` | Add `bun run cleanup` script + `docs/stale-mcp-cleanup.md` |

After all six commits and the cleanup of orphaned benchmark processes (the wakeup that revealed it: `bun run benchmarks/scripts/run-cell.ts ...` parents respawning their MCP children with stale env), Huginn knowledge tracing works end-to-end (pointer-mode + fence fallback). Yggdrasil is the remaining gap.

## Verified-good baseline

- Huginn knowledge_api_server has `HUGINN_TRACE_POINTER=1` and pointer-mode is fully implemented (confirmed via direct `curl http://localhost:8321/api/search?q=test&trace=true` → response contains `traceId`, not `trace`).
- Yggdrasil HTTP server (PID owning port 9130) has `YGGDRASIL_TRACE_POINTER=1` and `YGGDRASIL_TRACE_DEFAULT=1` in its env.
- Muninn's `peelHuginnTraceChannel` parser tries pointer first, then yggdrasil pointer (`parseYggdrasilTracePointer`), then huginn fence. The yggdrasil pointer regex requires `yggdrasil-trace-url: http(s)://…/api/trace/<16hex>` at end of output.
- `bots/melosys/.mcp.json` has `yggdrasil` as `type: "http"` pointing at `http://127.0.0.1:9130/mcp` — muninn does not spawn yggdrasil; it talks HTTP to a separately started server.
- The `mcp__yggdrasil__*` allow-rule is in `bots/melosys/.claude/settings.json` so claude-cli accepts the calls.

## The data that proves the gap

Run this in next session to refresh:

```sql
-- All-time yggdrasil trace coverage by connector and tool
SELECT
  t.attributes->>'connector' AS conn,
  c.attributes->>'toolName' AS tool,
  count(*) FILTER (WHERE c.attributes ? 'searchTrace') AS t_inline,
  count(*) FILTER (WHERE c.attributes ? 'searchTracePointer') AS t_ptr,
  count(*) AS total
FROM traces c
JOIN traces t ON c.parent_id = t.id
WHERE c.attributes->>'toolName' SIMILAR TO '(yggdrasil-|mcp__yggdrasil__)%'
  AND t.name = 'claude'
GROUP BY t.attributes->>'connector', c.attributes->>'toolName'
ORDER BY 1, 2;
```

Snapshot at 2026-05-04 07:30:

| Connector | Tool | t_inline | t_ptr | total |
|---|---|---|---|---|
| claude-cli | yggdrasil-search | 16 | 0 | 27 |
| claude-cli | yggdrasil-search_pattern | 0 | 0 | 23 |
| claude-cli | yggdrasil-read_source | 0 | 0 | 15 |
| claude-cli | yggdrasil-symbol_context | 0 | 0 | 11 |
| claude-cli | yggdrasil-file_outline | 0 | 0 | 5 |
| claude-cli | yggdrasil-impact | 0 | 0 | 3 |
| claude-cli | yggdrasil-list_files | 0 | 0 | 4 |
| claude-cli | yggdrasil-list_repos | 0 | 0 | 1 |
| copilot-sdk | yggdrasil-search | 9 | 0 | 27 |
| copilot-sdk | yggdrasil-search_pattern | 0 | 0 | 57 |
| copilot-sdk | yggdrasil-read_source | 0 | 0 | 11 |
| copilot-sdk | yggdrasil-symbol_context | 0 | 0 | 18 |
| copilot-sdk | yggdrasil-file_outline | 0 | 0 | 4 |
| copilot-sdk | yggdrasil-impact | 0 | 0 | 5 |
| copilot-sdk | yggdrasil-list_files | 0 | 0 | 7 |

**Reading the table:**

- `t_ptr = 0` everywhere. Pointer-mode is never observed for any yggdrasil tool, on any connector. Either yggdrasil doesn't implement pointer-mode at all, or its emission is conditional on something we're not hitting.
- `t_inline > 0` only on `yggdrasil-search`. Every other tool has zero trace coverage on both connectors. The gap is per-tool, not per-connector.

## What the next session should do

### 1. Verify directly against the yggdrasil HTTP server

Bypass muninn entirely. Hit yggdrasil's MCP HTTP endpoint and inspect the raw response text. The trace marker (if any) is a literal line at the end of the tool result.

```bash
# Look up the actual MCP tool-call shape yggdrasil expects.
curl -s http://127.0.0.1:9130/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_pattern","arguments":{"pattern":"foo","repo":"melosys-api"}}}' | tail -c 500
```

If the response text ends with `yggdrasil-trace-url: ...` or `​```huginn-trace ...`​`, muninn would have captured it. If neither is there, the server isn't emitting for that tool — yggdrasil-side bug.

### 2. Read yggdrasil's trace-emission code

The huginn peer (claude-hivemind ID `huginn`, cwd `/Users/rune/source/private/huginn`) is working on the yggdrasil port and shipped the trace code. They confirmed huginn-side is fully implemented. Ask them — or read directly:

```bash
# Yggdrasil repo path (per running server lsof output)
ls /Users/rune/source/private/yggdrasil

# Search for the env-var names and emission patterns
grep -rn "YGGDRASIL_TRACE_POINTER\|YGGDRASIL_TRACE_DEFAULT\|yggdrasil-trace-url" \
  /Users/rune/source/private/yggdrasil --include="*.ts" --include="*.py"
```

Specific questions to answer:

- Does yggdrasil's HTTP MCP handler check the trace flags **per tool**, or only on the search endpoint?
- Is pointer-mode (writing trace to in-memory store and emitting a `yggdrasil-trace-url:` URL line) implemented at all? If not, only fence-mode would ever fire — and only on tools that have the fence-emission code wired.
- Are `search_pattern`, `read_source`, `symbol_context`, etc. intentionally tracefree (analogous to huginn's `get_document` / `get_graph_node`, which the huginn peer confirmed are by-design no-trace)? Or is it a missing-implementation gap?

### 3. Confirm with `claude-hivemind`

The huginn peer was very fast on the previous round. Send a message to `huginn`:

```
yggdrasil tracing follow-up. Muninn now has full coverage on huginn knowledge calls (pointer-mode works after we cleaned up stale benchmark processes). But yggdrasil only emits fence-mode trace on the `search` tool — everything else (search_pattern, read_source, symbol_context, file_outline, impact, list_files, list_repos) has zero coverage across both connectors. Pointer-mode is never observed at all for yggdrasil. Two questions:
1. Is the per-tool gap intentional (analogous to huginn's get_document/get_graph_node being tracefree by design), or missing implementation?
2. Is yggdrasil pointer-mode shipped, or only the env vars + fence?
Filerefs in yggdrasil repo would help.
```

### 4. If it's missing implementation, decide where the fix lives

- **Yggdrasil-side**: add trace emission to the missing tool handlers. This is the right place if the data model supports a meaningful trace per tool (e.g. `search_pattern` has rerank/filter steps worth surfacing).
- **Muninn-side**: nothing to fix in the parser — verified working. If yggdrasil never emits for a tool, muninn correctly stores no trace.
- **Doc-side**: if some tools are intentionally tracefree, document the contract somewhere (yggdrasil's README + a brief note on the muninn `searchTrace` field that "absent means no trace was emitted, not necessarily a bug").

## Bonus finding — renderer format asymmetry (separate fix)

While verifying the data above, we found a different bug that masquerades as a trace-coverage problem in the dashboard UI:

`src/dashboard/views/components/tool-detail-renderers.ts:277-280` dispatches to per-tool renderers using regexes that only match the copilot-sdk tool-name format:

```js
if (/yggdrasil-symbol_context$/.test(name)) return tdrRenderSymbolContext;
if (/yggdrasil-list_files$/.test(name))     return tdrRenderListFiles;
if (/yggdrasil-read_source$/.test(name))    return tdrRenderReadSource;
if (/yggdrasil-search_pattern$/.test(name)) return tdrRenderSearchPattern;
```

- copilot-sdk tool name: `yggdrasil-search_pattern` (dash) → matches → custom panel with chips + matches
- claude-cli tool name: `mcp__yggdrasil__search_pattern` (double underscore) → no match → generic renderer (just raw output JSON)

The `output` attribute is identical in both cases — the data is there. Only the renderer dispatch differs. So claude-cli traces look "broken" in the UI even when the underlying data is fine.

**Fix sketch (own PR, not this one):**

Either widen the regexes to `(?:yggdrasil-|yggdrasil__)symbol_context$` (and likewise for the other four), or normalise the tool name once via the existing `formatToolDisplayName` pattern before dispatch. The second approach scales better to other servers (e.g. `knowledge`, `serena-*`) that may have the same dual-format issue.

This is **independent of the yggdrasil trace-emission gap** described above. The renderer fix lives entirely in muninn; the trace gap lives entirely in yggdrasil.

## Things NOT to redo in next session

- The copilot-sdk env propagation fix (`copilot-mcp.ts` spreads `process.env`) — shipped and verified.
- The claude-cli parallel tool-capture fix (`stream-parser.ts` resolves inline) — shipped and verified.
- Killing stale benchmark/MCP processes — `bun run cleanup` does this.
- Investigating muninn's parser on yggdrasil tools — already proven correct (it captures `yggdrasil-search` fence; if the regex were broken, it wouldn't capture *any* fence on any tool).

## Things to keep in mind

- The `MUNINN_DEBUG_CAPTURE_STREAM=1` debug helper from `executor.ts` (added in `78b0a3f`) writes raw NDJSON to `logs/stream-capture/`. Useful if you suspect Claude CLI is mangling the tool result before the parser sees it. **It only captures claude-cli stream-json**, not copilot-sdk events.
- The `bots/melosys/` folder is gitignored and synced via `bun run config:sync`. The `mcp__yggdrasil__*` allow rule we added must be synced back to `~/source/private/muninn-config` if other devs need it. (Local edits are still active for the local muninn, but won't be in the upstream repo until synced.)
- Yggdrasil server PID (`lsof -iTCP:9130 -sTCP:LISTEN`) was running with both `YGGDRASIL_TRACE_*` env vars set. If the next session starts and the server has been restarted without them, that's a separate red herring — verify env first, then dig into per-tool emission.

## Useful commands

```bash
# Find yggdrasil server + verify env
lsof -iTCP:9130 -sTCP:LISTEN
ps eww $(lsof -tiTCP:9130 -sTCP:LISTEN) | tr ' ' '\n' | grep -E "^YGGDRASIL"

# Find yggdrasil repo and trace-related code
find ~/source/private/yggdrasil -type f \( -name "*.ts" -o -name "*.py" \) \
  | xargs grep -l "yggdrasil-trace\|YGGDRASIL_TRACE" 2>/dev/null

# Latest claude-cli trace's yggdrasil tool coverage
docker exec -i $(docker ps --format '{{.Names}}' | grep -i muninn-postgres | head -1) \
  psql -U muninn -d muninn -c "
SELECT attributes->>'toolName' AS tool, attributes ? 'searchTrace' AS t,
       attributes ? 'searchTracePointer' AS p
FROM traces
WHERE trace_id = (
  SELECT trace_id FROM traces
  WHERE name='claude' AND attributes->>'connector'='claude-cli'
  ORDER BY started_at DESC LIMIT 1
)
AND attributes->>'toolName' LIKE 'mcp__yggdrasil%'
ORDER BY started_at;"

# Run cleanup if stale processes appear again
bun run cleanup
bun run cleanup:kill
```
