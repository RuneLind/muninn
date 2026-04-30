# Handover — melosys search improvement (state at 2026-04-30)

## What we set out to do

Improve the search the melosys bot uses against the Huginn Knowledge MCP.
Two motivating questions:

1. **Does nav-wiki help?** Is the synthesised wiki layer useful, or is
   raw Confluence enough?
2. **Does the knowledge graph help?** Are entity detection and query
   expansion contributing to retrieval quality?

Wider question lurking behind both: how should we benchmark and iterate
on Huginn search quality from the muninn side?

## What we actually did

Before any of those questions could be measured, three bugs surfaced
that made the data unreadable. All three are now fixed and verified
end-to-end:

| Commit | Fix |
|---|---|
| `58ff2ce` | `parseHuginnTrace` couldn't handle trace bodies >4 KB. Real melosys searches produce ~14 KB traces. End-anchored backward search replaces the fixed window. |
| `bb009ec` | Benchmark scratch-dir overlay copied the knowledge MCP entry without setting `cwd`, so `--directory ../../../huginn` resolved against the wrong anchor → knowledge MCP silently failed to spawn → benchmark cells ran without knowledge tools. |
| `56d35c2` | When a tool result exceeded the SDK threshold, copilot-sdk replaced `result.content` with a placeholder string and put the full payload on `contents[0].text`. `extractMcpResultText` was preferring `content` first → bot saw "Output too large..." → bot ran blind. Affects prod chat too, not just benchmarks. |

After all three landed, we ran two benchmark cells — n=1 each — to
confirm the trace pipeline works end-to-end and to start mining real
bot-issued queries.

## Empirical findings (n=2 cells, 14 search_knowledge calls)

**Cells:** `copilot-sdk + claude-sonnet-4.6 + h7-mandated-code-reading-v1
+ knowledge+yggdrasil` on:

- **MELOSYS-7631** (POPP / year-end-settlement, domain-integration) →
  trace `f0ae5f19-5122-4f27-bd50-c541b5cb6a82`, hit 34.6%, hl 60%.
- **MELOSYS-7588-scope7588** (cross-repo refactor, code-heavy) →
  trace `d2facedb-af23-4246-ad04-71eaea8920ec`, hit 37.9%, hl 0%.

### Patterns that hold across both cells

1. **Bot does broad multi-collection search exactly ONCE per analysis**,
   then narrows to `collection: jira-issues` for the remaining 6/7
   searches. Same shape on completely different issue categories.
   The H7 prompt's "kryss-saks-sjekk" emphasis is the most plausible
   driver. This is the most surprising finding of the session.
2. **When broad search runs, every collection contributes**:
   - On 7631 (conceptual): `nav-wiki` won rank-0 (`POPP.md`) and
     dominated top 3 (`POPP.md`, `Årsavregning.md`, `Trygdeavgift.md`).
   - On 7588 (architecture): `melosys-confluence-v3` won rank-0
     (`Lagring av informasjon om trygdeavgift...`), nav-wiki second.
   - **They're complements, not substitutes** — the "winning" collection
     depends on whether the query is conceptual or architectural.
3. **KG entity detection always fires** (3–10 entities per query),
   **expansion always adds 5 terms** (looks hardcoded in Huginn), but
   `graphAnswered=true` was **never** reached. The graph short-circuit
   path didn't fire on any of the 14 queries.
4. **Huginn's `lowConfidence` flag never tripped** (0 of 16 collection
   decisions). Either the bot's queries are uniformly easy, or the
   threshold is too generous to be useful as a signal.

### What this means for the original questions

- **"Does nav-wiki help?" — Yes, when used. Quality of its top hits is
  high.** But it's only consulted on the bot's one broad search per
  analysis. Effective contribution per analysis is bounded by that.
- **"Does the KG help?" — Observably it fires (entities + expansion
  terms always added), causally unknown.** Need an A/B against
  expansion-disabled to answer cleanly. Huginn would need to ship a
  flag (`?disable_expansion=true`) for the comparison run.

### What the data does NOT settle

- Whether `cross-issue-hint-v1` would do broad-search more often
  than H7. Hasn't been measured with trace capture working.
- Whether MELOSYS-7969 (the highlighted gold for 7588) would surface
  if any of the 6 jira-issues searches in the 7588 trace went broader.
  Worth a SQL pull on `d2facedb` candidates to see if 7969 was ever
  in any top-N.
- Prod-traffic distribution of broad vs single-collection searches —
  benchmark may or may not match.

## Two divergent directions

### A. Prompt-side — nudge the bot toward broad search

Modify the H7 prompt (or a successor) to require broad search before
narrowing. Hypothesis H10-prompt-side: increasing broad-search frequency
moves nav-wiki contribution from 1/7 to 4/7+ per analysis, raising hit
rate on conceptual issues without hurting code-heavy ones. Cheap to
test — just a new treatment file.

### B. Ranking-side — improve the existing single-collection runs

Most queries hit jira-issues alone. Three sub-questions:

- Why doesn't MELOSYS-7969 surface for 7588's jira-issues searches?
  (H8 already proved it's not graph-reachable; tool/corpus gap.)
- Does Huginn's CE re-rank lift the right candidate? Trace data
  has stage-by-stage rank movement — measurable now.
- Is 5 expansion terms always the right number? Could be tuned per
  query length or entity count.

(B) is huginn-owned work. (A) is muninn-owned. They're independent.

### C. KG causal A/B (orthogonal)

Once huginn ships `?disable_expansion=true`, run the same two cells
twice (with vs without expansion) and compare top-N overlap and final
hit rate. Answers "does KG cause better retrieval" rather than just
"does KG fire". One-off cost, durable answer.

## Recommended iteration loop for next session

This worked well in this session and should continue:

1. **Keep muninn dev server running.** Bot peers register from there.
2. **Open huginn in a separate Claude Code instance** — same hivemind
   namespace. Use `mcp__claude-hivemind__list_peers` and
   `send_message` to coordinate.
3. **Use the `muninn-peer-iteration` skill** when you want a quick
   probe-via-melosys → trace-inspection → huginn-coordinate loop.
   The skill lives at `.claude/skills/muninn-peer-iteration/`.
4. **For real benchmark-grade measurements**, run cells via
   `bun run benchmarks/scripts/run-cell.ts <ISSUE>
   benchmarks/treatments/<treatment>.json --n-runs <N>`. n=1 is
   enough for "is this signal real?" — go to n≥3 only when comparing
   cells per the calibrated noise floor (~7pp on free-text candidates,
   ~2pp on H7-style structured ones).
5. **Read traces with `muninn-db` skill** + the canonical SQL from
   `muninn-peer-iteration`'s skill doc. The trace schema is documented
   in `src/ai/huginn-trace.ts`. Stage-by-stage candidate scoring is
   under `attributes.searchTrace.collections[].candidates[].stages`.

Avoid running benchmark cells in the foreground if you can — yggdrasil
indexing takes 1–2 min on 7588 (3 repos). Use background runs and
poll the DB for the trace_id rather than the runner stdout.

## Useful queries for the next session

Find recent benchmark traces on either issue:

```sql
SELECT trace_id, started_at, duration_ms FROM traces
WHERE bot_name LIKE '%melosys%' AND parent_id IS NULL
  AND started_at > now() - interval '24 hours'
ORDER BY started_at DESC LIMIT 10;
```

Check searchTrace coverage on a trace:

```sql
SELECT name, count(*),
       count(*) FILTER (WHERE attributes ? 'searchTrace') AS w_trace
FROM traces WHERE trace_id = '<id>' AND name LIKE 'knowledge-%'
GROUP BY name;
```

Per-query summary (one row per search_knowledge call):

```sql
SELECT row_number() OVER (ORDER BY started_at) AS q,
       attributes->'searchTrace'->'query'->>'raw' AS query,
       jsonb_array_length(coalesce(attributes->'searchTrace'->'query'->'detectedEntities', '[]'::jsonb)) AS n_ent,
       jsonb_array_length(coalesce(attributes->'searchTrace'->'query'->'expansionTerms', '[]'::jsonb)) AS n_exp,
       attributes->'searchTrace'->'query'->>'graphAnswered' AS graph_ans,
       jsonb_array_length(attributes->'searchTrace'->'collections') AS n_coll
FROM traces WHERE trace_id = '<id>' AND name = 'knowledge-search_knowledge'
ORDER BY started_at;
```

Top-N rank-0 from broad searches:

```sql
WITH s AS (
  SELECT attributes->'searchTrace' AS trace
  FROM traces WHERE trace_id = '<id>' AND name = 'knowledge-search_knowledge'
    AND jsonb_array_length(attributes->'searchTrace'->'collections') > 1
)
SELECT col->>'name' AS collection,
       cand->'stages'->'final'->>'rank' AS final_rank,
       (cand->'stages'->'final'->>'score')::numeric(7,4) AS score,
       left(cand->>'docTitle', 80) AS title
FROM s, jsonb_array_elements(trace->'collections') col,
     jsonb_array_elements(col->'candidates') cand
WHERE cand->'stages'->'final' IS NOT NULL
ORDER BY (cand->'stages'->'final'->>'rank')::int LIMIT 10;
```

## Branch state at handover

- `feature/huginn-search-trace-integration` — this branch, 4 commits
  ahead of main as of 56d35c2. Recommended to merge to main before
  continuing.
- `feature/search-tracing` (huginn side) — also recommended to merge
  before further muninn-side work, so the trace-fence contract is
  stable.
- `docs/handover-sdk-output-too-large.md` (cde14e4) is now historical
  — the issue it described is fixed in 56d35c2. Leave the file as
  audit context or strip it when convenient.

## Trace IDs to start from

| Trace | What it is |
|---|---|
| `f0ae5f19-5122-4f27-bd50-c541b5cb6a82` | MELOSYS-7631 baseline cell, all 7 searches with searchTrace |
| `d2facedb-af23-4246-ad04-71eaea8920ec` | MELOSYS-7588-scope7588 baseline cell, all 7 searches with searchTrace |

Trace retention is 7 days by default (`TRACING_RETENTION_DAYS`). After
that, re-run the cells to regenerate (cheap — copilot-sdk-sonnet runs
$0 against the prod billing).
