---
name: muninn-peer-iteration
description: Orchestrate cross-instance Claude Code debugging via claude-hivemind — send test prompts to a Muninn bot peer (jarvis, melosys, capra, …), inspect the resulting trace in the Muninn DB, and coordinate with peer agents (e.g. huginn for search/retrieval changes) to iterate on behavior. Use this whenever you need to test how a Muninn bot reacts to an upstream change, debug search quality across the muninn+huginn split, validate that a tweak landed correctly, or run any multi-instance experiment that has one peer making changes and another driving the test loop. Triggers on phrases like "iterate with peers", "test bot via hivemind", "coordinate with huginn", "send test to melosys", "iterate on search ranking", "verify the change in the bot", or any debugging task that spans muninn (the orchestrator) and another peer instance.
---

# Muninn Peer Iteration

## What this is for

You're sitting in the Muninn repo with one or more bots running locally (`bun run dev`) and one or more *other* Claude Code instances open elsewhere on the machine — typically `huginn` (the knowledge backend) and possibly other repos. Each Muninn bot exposes itself as a hivemind peer; each Claude Code instance does too. This skill is the playbook for using that mesh to test, validate, and iterate on bot behavior — particularly when changes need to ripple between repos.

**Canonical loop:** you ask `huginn` to change something on the search side, then trigger `melosys` (a Muninn bot) to do a real query, then read the resulting trace from the DB, then tell `huginn` what you saw. Repeat. The whole point is letting two specialised agents work the same problem from opposite ends without you copy-pasting code or context between them.

## Prerequisites

- Muninn dev server running (`bun run dev`) — bot peers register from this process
- Postgres container up — needed to inspect traces (drives the `muninn-db` skill)
- claude-hivemind MCP connected — verify with `list_peers` before doing anything else
- The peer you want to coordinate with is actually open in another terminal/cmux pane

## Step 1 — Orient

Before sending any messages, set your own status and look around. This is courtesy: peers see your summary when they `list_peers`, and you'll be more useful to them if they know what you're trying to do.

Call `set_summary` with one short sentence describing the experiment, then `list_peers` with `scope: "machine"`. The non-default scope matters — bots can register in multiple namespaces (e.g. melosys exists in both `private` and `nav`), and you want the full picture so you don't message the wrong one.

A peer entry tells you: who they are (`ID`), what repo they're in (`CWD`, `Branch`), and what they think they're doing (`Summary`). Read all three before deciding who to involve.

## Step 2 — Compose a surgical test prompt

The whole purpose of triggering a bot is to capture *one clean trace*. A sloppy prompt produces a trace with 30+ spans across multiple tools and turns, which is unreadable and burns the bot's tokens. A surgical prompt produces a trace with one or two relevant spans you can analyse in seconds.

Surgical means:

- **Force the exact tool call you care about.** Name the collection, name the search term, name the source file. "Søk i nav-wiki etter 'trygdeavtale'" beats "What does the bot know about social-security agreements?"
- **Cap the response.** Tell the bot to skip analysis and just dump titles/headers. "Bare titler", "én linje per treff", "ikke gjør analyse — jeg trenger bare at søket skjer".
- **Match the bot's working language.** Norwegian-speaking bot → Norwegian prompt. Saves the bot from translating, and produces traces in the language of its real users.

**Good** (one tool call, ~10 s, fresh trace):

> Quick test: kjør EN knowledge_search på "trygdeavtale" i nav-wiki og gi meg titler på topp-3 treff (én linje per). Trenger bare at søket skjer slik at jeg kan inspisere trace-spans, ikke et ordentlig svar.

**Bad** (open-ended, multiple turns, noisy trace):

> What does the bot know about trygdeavgift? Can you summarise?

If you'll be running the same test repeatedly across iterations, save the prompt verbatim and reuse it — that way only the bot/upstream behaviour is varying, not your wording.

## Step 3 — Send and wait

Send the prompt with `send_message({ to: "<peer-id>", message: "<prompt>" })`. The reply arrives later as a `<channel source="claude-hivemind" ...>` message in your conversation. Note the `sent_at` timestamp on the reply — you'll use it to find the trace.

Bots typically reply in 8–30 s for a one-search prompt. If it takes much longer, the bot is doing more work than you asked for — your prompt wasn't surgical enough.

**Don't spam.** Each test prompt costs the bot a real Claude Code call. One prompt per upstream change. If you find yourself sending three prompts in a minute, slow down — read the previous trace first and form a hypothesis before retrying.

## Step 4 — Inspect the trace

Use the `muninn-db` skill for the SQL. The flow is always: find the trace by recent timestamp → list its spans → drill into the tool span you care about.

Find recent traces (web platform = chat-driven, peer messages route through the chat pipeline):

```sql
SELECT trace_id, started_at, duration_ms, bot_name
FROM traces
WHERE platform='web' AND parent_id IS NULL
  AND started_at > now() - interval '90 seconds'
ORDER BY started_at DESC LIMIT 3;
```

List the spans on the chosen trace:

```sql
SELECT name, kind, status, duration_ms, started_at
FROM traces
WHERE trace_id='<id>'
ORDER BY started_at;
```

Drill into a specific tool span:

```sql
SELECT name,
       attributes ? 'searchTrace' AS has_trace,
       length(attributes->>'output') AS out_len,
       left(attributes->>'output', 300) AS out_head,
       jsonb_pretty(attributes->'searchTrace') AS trace
FROM traces
WHERE trace_id='<id>' AND name='knowledge-search_knowledge';
```

Key attribute fields to know:

| Field | What it is |
|---|---|
| `attributes->>'input'` | The arguments the bot sent to the tool (JSON, abbreviated to ~500 chars) |
| `attributes->>'output'` | What the bot saw back from the tool (cleaned of any Huginn trace fence; capped at 16 KB; truncation envelope above that) |
| `attributes->'searchTrace'` | Structured Huginn search trace — query expansion, candidate ranks (faiss/bm25/rrf/CE), confidence decision, timings. Only present on Huginn search calls when `HUGINN_TRACE_DEFAULT=1` reached the adapter. |
| `attributes->>'statusText'` | Human-friendly description of what the tool was doing |

If `attributes ? 'searchTrace'` is `false` on a Huginn search and you expected it to be `true`, the env injection isn't reaching the adapter — verify with `ps eww -p <adapter-pid> | grep HUGINN`.

## Step 5 — Coordinate back upstream

When the trace tells you something the upstream peer needs to act on, message them. The coordination etiquette matters more than the mechanics:

- **Lead with the data, not the question.** Peers can act faster when they see the numbers first. "BM25 ranket Folketrygdloven over Trygdeforordningen, FAISS hadde det motsatt, CE-diff er 0.04 — vil du justere alfa?" beats "kan du se på trygdeavtale-rangeringen?"
- **Keep it short.** A paragraph max. Long messages get skimmed.
- **Match their language.** If they wrote Norwegian to you, write Norwegian back. Bots and human-driven Claude Code instances both pick up on this.
- **Acknowledge their last action before asking for the next.** "Takk for fix av X — nå ser jeg Y. Vil du …?" reads as collaboration; jumping straight to the next ask reads as demands.
- **Don't pile-on with multiple peers.** One round at a time. Concurrent changes from huginn AND a config change in muninn make it impossible to attribute the next trace difference to either cause.

After they reply with a change, go back to step 2 and trigger a fresh test. Keep both `trace_id`s in your scratch notes so you can compare before/after.

## When to use which peer

| Goal | Peer / source |
|---|---|
| Test how a bot uses a tool, see what it returned to the user | the bot peer (e.g. `melosys`, `jarvis`, `capra`) |
| Change ranking, query expansion, indexing, taxonomy | `huginn` |
| Check what the bot saw vs what it returned | the muninn DB (`muninn-db` skill) |
| Debug an MCP server that's down | the muninn dev server logs (`logs/` dir) |
| Inspect what the LLM was actually asked | `prompt_snapshots` table joined on `trace_id` |

## Bot autorespond — why your message might be ignored

Bots only auto-respond to peers in their `config.json` `hivemind.autoRespondPeers` list. If your peer ID isn't in that list, the bot receives the message but won't act on it. Your peer ID is normally the basename of your CWD — verify with `list_peers` (look for the entry whose `CWD` matches yours).

If you're getting silence, either add yourself to the list (in `bots/<bot>/config.json`, then restart the dev server) or send through a peer that's already allowed.

## Quick checklist before each round

- [ ] Updated `set_summary` if the experiment focus changed?
- [ ] Test prompt is surgical (one tool call, terse response)?
- [ ] Previous trace's `trace_id` saved so you can compare?
- [ ] Hypothesis written down (even mentally) — what do you expect this iteration to change?

If you can't answer any of these, you're about to burn a round. Stop and figure it out first.
