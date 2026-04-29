# Handover — copilot-sdk "Output too large" eats search content

## TL;DR

When an MCP tool returns more than some SDK-internal threshold of content,
copilot-sdk replaces the result the bot sees with a short placeholder
(`Output too large to read at once (NNN KB). Saved to: /var/folders/.../...txt`)
and writes the real payload to a tempfile. **The bot never reads the
tempfile** (no `Read` tool in benchmark mode; in prod the bot doesn't try),
so for any sufficiently large knowledge search the bot is operating on
nothing — the search ran, the tool span shows duration, but the model saw
no content.

This affects:

- **Production** melosys web chat (verified — see trace `d6200f7e-...`,
  `_originalBytes=256870`, output stored is the placeholder).
- **Benchmarks** that use copilot-sdk (verified — see trace
  `cbb60098-...`, all 4 `knowledge-search_knowledge` spans had only the
  placeholder).
- **Trace capture** — `searchTrace` is never extracted because the fence
  is in the tempfile, not in what we store. The huginn-trace.ts >4 KB-body
  fix landed on commit `58ff2ce` is correct but is downstream of this issue.

This was uncovered while debugging why melosys benchmark cells produced
0 knowledge search calls. That separate bug — relative path
`../../../huginn` resolving wrong from the deeper benchmark scratch dir —
is patched in `src/benchmarks/runner.ts` (`prepareScratchBotDir`); the
patch is **uncommitted** on `feature/huginn-search-trace-integration` at
the time of this handover. Commit it on the parent branch before forking
this investigation, so the new branch starts from a state where knowledge
MCP at least *spawns* in benchmark cells.

## Why it matters more than it looks

If H7 / cross-issue-hint / etc. analyses on MELOSYS-7588-scope7588 were
running against placeholder-only knowledge results, the entire benchmark
matrix's "knowledge-vs-yggdrasil" framing breaks down — the
"knowledge+yggdrasil" cells may have effectively been
"yggdrasil-only-with-extra-tool-calls". H7's measured
+8pp on MELOSYS-7588 still stands as a prompt effect, but the *mechanism*
ascribed to it (the bot reading actual knowledge) needs re-examination.

The same applies to every prod analysis since copilot-sdk became the
melosys connector. The bot is producing analyses, so it's working *somehow*
— either small queries fall under the threshold, or the placeholder text
is enough to trigger continuation searches. We don't know without
investigation.

## Evidence

### One known-bad benchmark trace

Trace `cbb60098-0395-461b-ba8c-60c8a44a86b3`
(MELOSYS-7631 + copilot-sdk + sonnet-4.6 + H7 + knowledge+yggdrasil,
2026-04-29 ~22:21):

```sql
SELECT name, count(*) FROM traces
WHERE trace_id = 'cbb60098-0395-461b-ba8c-60c8a44a86b3'
GROUP BY name ORDER BY count DESC;
```

4 × `knowledge-search_knowledge` spans, every one of them with output
beginning `Output too large to read at once (~71 KB). Saved to: ...`.
0 spans with `attributes ? 'searchTrace'`.

### One prod web chat trace

Trace `d6200f7e-b280-4336-b87d-ba2466f27735` (real `web_message` root,
melosys, 2026-04-29 ~18:33):

```sql
SELECT left(attributes->>'output', 200)
FROM traces WHERE trace_id = 'd6200f7e-...' AND name = 'knowledge-search_knowledge'
LIMIT 1;
```

Returns a `_truncated`-envelope wrapping content that itself starts with
`{"content":"Output too large to read at once (238.7 KB). Saved to: ..."`
— so the bot received only the placeholder string, no real content.

### Tempfiles still on disk

```
/var/folders/hv/02bh5wf526d52vpmmx91l2k00000gn/T/*copilot-tool-output*.txt
```

These contain the **full** original tool payload (huginn HTTP wrapper
shape `{"result": "<huge string with embedded huginn-trace fence>"}`).
For the cbb60098 run, sizes ranged 51–235 KB. macOS doesn't auto-clean
`/var/folders/.../T/` aggressively, so several days of these are
recoverable for forensic / one-shot analysis.

## Where in the code

- **Connector seam:** `src/ai/connectors/copilot-sdk.ts` line ~138–178
  (`tool.execution_complete` event). `event.data.result` is what the SDK
  hands us — and what the bot saw earlier in its own conversation. We
  pass it through `extractMcpResultText` (in `src/ai/huginn-trace.ts`)
  then `parseHuginnTrace` then `truncateOutput` for storage.
- **Field-preference order in `extractMcpResultText`:** `content` (string
  or array) → `text` → `result` → `detailedContent`. **`detailedContent`
  is checked last.** If the SDK envelope is
  `{ content: "Output too large...", detailedContent: "<full payload>" }`,
  we'd silently pick the placeholder. This is a strong candidate for
  the simplest fix.
- **Existing test that codifies the placeholder shape:**
  `src/ai/huginn-trace.test.ts` test
  `"extract+parse pipeline yields readable text for non-Huginn copilot-sdk results"`.
  It uses `{ content: "Output too large to read at once (159.3 KB)..." }`
  with no `detailedContent` — so we don't currently know what the SDK
  emits when the content overflows.

## Open questions to answer first (in order)

1. **What does `event.data.result` actually contain when the SDK
   diverts a tool result?** Add a one-shot debug log line in
   `copilot-sdk.ts` capturing `Object.keys(resultPayload)` and per-key
   sizes when the placeholder pattern is detected. Run one search through
   the live bot. Look in `logs/`.

2. **Is there a `detailedContent` / `contents[]` / similar field with the
   full payload?** If yes — change `extractMcpResultText` to prefer
   the longest text-bearing field rather than first-match. Smallest
   possible fix. Add a regression test that emits the SDK's actual shape.

3. **If no — is there an SDK option to raise or disable the threshold?**
   Check `@github/copilot-sdk` config for tool-result-size knobs. Some
   SDKs expose a `maxToolResultBytes` or similar. If yes, raise it on
   the shared `CopilotClient` singleton.

4. **If no SDK knob — read the tempfile.** The placeholder string is
   parseable: `Saved to: <path>`. We could intercept results matching
   that pattern, read the file, JSON-parse to get `result`, run
   `parseHuginnTrace` on it. Cost: one stat + one read per oversized
   tool result. Cleanup: delete the tempfile after read so we don't
   leak. Risk: SDK may also delete, race condition — read first, ignore
   ENOENT.

5. **Production chat impact:** quantify how often this fires in real
   melosys traffic. SQL:

   ```sql
   SELECT date_trunc('day', started_at) AS day,
          count(*) FILTER (WHERE attributes->>'output' LIKE '%Output too large%') AS oversized,
          count(*) AS total
   FROM traces
   WHERE name = 'knowledge-search_knowledge'
     AND bot_name = 'melosys'
     AND platform IN ('web', 'telegram', 'slack')
     AND started_at > now() - interval '14 days'
   GROUP BY 1 ORDER BY 1 DESC;
   ```

   If oversized share is high, this becomes urgent rather than
   nice-to-fix.

## Quick recovery path for already-completed runs

For salvaging the `cbb60098` benchmark run's trace data without re-running:

```ts
// scripts/recover-truncated-search-traces.ts (sketch)
// 1. SELECT spans where output starts with "Output too large"
// 2. Parse "Saved to: <path>" with regex
// 3. Bun.file(path).text() → JSON.parse → take .result
// 4. parseHuginnTrace(.result) → trace
// 5. UPDATE traces SET attributes = jsonb_set(attributes, '{searchTrace}', $trace::jsonb) WHERE id = $spanId
```

This is one-shot; the proper fix is upstream in copilot-sdk.ts.

## Recommended branch shape

- `fix/sdk-output-too-large` from current `feature/huginn-search-trace-integration`
  (or from `main` after merging it — depends on how soon that branch ships).
- Step 1 of the branch: the debug-log instrumentation (~5 lines) so we
  can see the SDK envelope shape on a real search. Land that, run one
  search, capture, revert. Don't ship the log line.
- Step 2: pick the right fix from §"Open questions" results.
- Step 3: regression test in `src/ai/huginn-trace.test.ts` mirroring
  the actual SDK envelope shape (replacing or extending the existing
  `"Output too large"` test).
- Step 4: backfill recovery script for already-existing prod and
  benchmark traces if it's cheap.

## What this handover does NOT cover

- The 4 KB tail-window fix to `parseHuginnTrace` (commit `58ff2ce` on
  `feature/huginn-search-trace-integration`) — already shipped, correct,
  unrelated to this issue.
- The benchmark scratch-dir cwd patch in `prepareScratchBotDir` —
  uncommitted on `feature/huginn-search-trace-integration` at handover
  time; commit it on that branch before starting the new branch.
- Bug-11-style leakage in copilot-sdk benchmark cells (`bash`,
  `Agent:general-purpose`, `read_bash` showed up in trace `cbb60098`
  despite `BENCHMARK_DISALLOWED_TOOLS` containing `Bash`/`Agent`).
  `--disallowedTools` is claude-cli-only; copilot-sdk benchmarks have no
  equivalent enforcement. Separate issue, also worth its own branch.
