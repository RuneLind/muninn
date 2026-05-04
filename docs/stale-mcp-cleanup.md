# Stale MCP processes — what they break and how to clean them up

## Symptom

You change a trace-related env var (`HUGINN_TRACE_POINTER`, an MCP entry's `env`
block in `bots/<name>/.mcp.json`, etc.), restart muninn, and traces still show
the old behaviour: missing `searchTrace` on most tool spans, fence-mode trace
where you expected pointer-mode, or inconsistent results across calls in the
same request (one call has trace, five don't).

You verified the running muninn process has the new env. You verified the
huginn knowledge-API server has the new env. You restarted muninn cleanly.
The bug persists.

## What's actually happening

Two separate effects compound:

1. **`TRACE_DEFAULT` in `knowledge_api_mcp_adapter.py` is captured at module
   load**, not per-request. An adapter spawned without `HUGINN_TRACE_POINTER`
   in its env will *never* emit trace markers — even if every other process in
   the chain has the var. `pkill`-ing the adapter helps only if its parent
   doesn't immediately respawn it.

2. **Long-lived benchmark runners (`bun run benchmarks/scripts/run-cell.ts ...`)
   each hold their own copilot-sdk client and spawned MCP children**. If you
   started a benchmark hours or days ago and never let it finish (or it hung),
   the parent still has its child MCP adapters alive with whatever env it
   started with. When you `pkill knowledge_api_mcp_adapter`, the benchmark
   parents respawn fresh adapters — also with stale env.

The smoking gun: `pgrep -f knowledge_api_mcp_adapter` returns processes after
you ran `pkill`. Their parent PIDs (`ps -o ppid=`) point at long-running `bun
run benchmarks/scripts/run-cell.ts ...` processes.

## Cleanup

Use the bundled script. Default is dry-run — pass `--kill` to act.

```bash
bun run cleanup            # list what would be killed
bun run cleanup:kill       # send SIGTERM to all stale processes
```

The script kills, in order:

1. Orphaned `benchmarks/scripts/run-cell.ts` parents (must go first, otherwise
   they respawn the children).
2. `knowledge_api_mcp_adapter` instances.
3. `@github/copilot/index.js --headless` MCP children from old copilot-sdk
   sessions.

It does **not** touch:

- The foreground `bun run dev` (you control that yourself).
- Claude Desktop's MCP children (those belong to `Claude.app`).
- `knowledge_api_server.py` (long-lived data process; restart with whatever
  command you originally used if you need to flip its env).

## Verification after cleanup

```bash
# Should be empty
pgrep -af "knowledge_api_mcp_adapter|@github/copilot/index.js --headless|benchmarks/scripts/run-cell.ts"

# After restarting muninn and running one request, check the spawned adapter
ps eww $(pgrep -f knowledge_api_mcp_adapter | tail -1) | tr ' ' '\n' | grep TRACE
# Expect: HUGINN_TRACE_POINTER=1 (and HUGINN_TRACE_DEFAULT=1 if set)
```

## Why benchmark runs leak

`benchmarks/scripts/run-cell.ts` is a long-running probe that spins up a
copilot-sdk session per run. If you `Ctrl-C` the script, the bun parent dies
but the spawned `node @github/copilot/index.js --headless` child can outlive
it briefly; in some cases the bun parent also detaches and survives a terminal
close. Either way they sit there for hours holding stale MCP adapter state.

A future improvement to the benchmark runner would be a proper SIGINT handler
that tears down its copilot-sdk client. Until then, run `bun run cleanup` after
any benchmark session you didn't let finish cleanly.

## Why this isn't fixed in muninn directly

Muninn doesn't own these processes — they were started by a developer running
benchmarks in a separate terminal. The right fix is harness-side (in
`benchmarks/scripts/run-cell.ts`), not in muninn itself. Until then, manual
cleanup is the path.
