---
name: muninn-db
description: Access and query the Muninn PostgreSQL database running in Docker. Use this skill whenever you need to run SQL queries, inspect data, debug database issues, check table contents, or understand the schema. Triggers on database queries, SQL, checking data, table inspection, "what's in the DB", row counts, data debugging, or any task requiring direct database access in the Muninn project.
---

# Muninn Database Access

The Muninn database is PostgreSQL 17 with pgvector, running inside a Docker container. There is no `psql` on the host machine — all queries go through `docker exec`.

## How to run queries

```bash
docker exec muninn-postgres psql -U muninn -d muninn -c "YOUR SQL HERE"
```

For multi-line or complex queries, use a heredoc:

```bash
docker exec muninn-postgres psql -U muninn -d muninn <<'SQL'
SELECT count(*) FROM messages;
SQL
```

For formatted output, add `-x` (expanded) or use `\x auto`:

```bash
docker exec muninn-postgres psql -U muninn -d muninn -x -c "SELECT * FROM users LIMIT 3"
```

## Connection details

| Field | Value |
|---|---|
| Container | `muninn-postgres` |
| User | `muninn` |
| Password | `muninn` |
| Database | `muninn` |
| Host port | `5435` |
| Internal port | `5432` |
| Image | `pgvector/pgvector:pg17` |

The app connects via `DATABASE_URL=postgresql://muninn:muninn@127.0.0.1:5435/muninn`.

For IDE database tools (IntelliJ, DataGrip, etc.), use JDBC URL: `jdbc:postgresql://127.0.0.1:5435/muninn`

## Test database

A separate `muninn_test` database exists for tests. Same credentials, same container:

```bash
docker exec muninn-postgres psql -U muninn -d muninn_test -c "YOUR SQL HERE"
```

## Schema overview

13 tables total. All timestamps are `TIMESTAMPTZ`. UUIDs auto-generated. Most tables have `bot_name` for multi-bot isolation.

### Core data tables

**users** — Canonical user identity
- `id` TEXT PK, `username`, `display_name`, `platform`, `is_active`, `created_at`, `updated_at`, `last_seen_at`

**threads** — Conversation topics per user+bot
- `id` UUID PK, `user_id`, `bot_name`, `name`, `description`, `is_active`, `created_at`, `updated_at`
- Unique constraint: one active thread per user+bot (`idx_threads_active`)
- Unique thread names per user+bot (`idx_threads_name`)

**messages** — Full conversation history
- `id` UUID PK, `user_id`, `bot_name`, `username`, `role` (user|assistant), `content`, `cost_usd`, `duration_ms`, `model`, `input_tokens`, `output_tokens`, `source`, `platform`, `thread_id` FK→threads, `created_at`

**memories** — Semantic memory with vector embeddings
- `id` UUID PK, `user_id`, `bot_name`, `content`, `summary`, `tags` TEXT[], `search_vector` TSVECTOR, `embedding` vector(384), `source_message_id` FK→messages, `scope` (personal|shared), `created_at`
- Has GIN index on `search_vector` for full-text search
- Has HNSW index on `embedding` for vector similarity

**goals** — User goals, commitments, deadlines
- `id` UUID PK, `user_id`, `bot_name`, `title`, `description`, `status` (active|completed|cancelled), `deadline`, `tags`, `source_message_id`, `platform`, `last_checked_at`, `reminder_sent_at`, `created_at`, `updated_at`

**scheduled_tasks** — Cron-style or interval recurring tasks
- `id` UUID PK, `user_id`, `bot_name`, `title`, `task_type` (reminder|briefing|custom), `prompt`, `schedule_hour`, `schedule_minute`, `schedule_days` INT[], `schedule_interval_ms`, `timezone`, `platform`, `enabled`, `last_run_at`, `next_run_at`, `created_at`, `updated_at`

**watchers** — Background monitors (email, calendar, etc.)
- `id` UUID PK, `user_id`, `bot_name`, `name`, `type` (email|calendar|github|news|goal), `config` JSONB, `interval_ms`, `enabled`, `last_run_at`, `last_notified_ids` JSONB, `created_at`, `updated_at`

**user_settings** — Quiet hours, timezone
- `user_id` TEXT PK, `quiet_start` INT, `quiet_end` INT, `timezone`, `created_at`, `updated_at`

### Operational tables

**activity_log** — Dashboard activity feed
- `id` UUID PK, `type` (message_in|message_out|error|system|slack_channel_post), `user_id`, `bot_name`, `username`, `text`, `duration_ms`, `cost_usd`, `metadata` JSONB, `created_at`

**haiku_usage** — Token tracking for background Haiku calls
- `id` UUID PK, `source`, `bot_name`, `model`, `input_tokens`, `output_tokens`, `created_at`

**traces** — Request tracing spans
- `id` UUID PK, `trace_id`, `parent_id`, `name`, `kind` (root|span|event), `status` (ok|error), `bot_name`, `user_id`, `username`, `platform`, `started_at`, `duration_ms`, `attributes` JSONB, `created_at`

**prompt_snapshots** — Full prompt captures per trace
- `id` UUID PK, `trace_id`, `system_prompt`, `user_prompt`, `created_at`

**schema_migrations** — Migration tracking
- `version` TEXT PK, `name`, `applied_at`

## Common queries

### Quick health check
```sql
SELECT 'messages' as tbl, count(*) FROM messages
UNION ALL SELECT 'memories', count(*) FROM memories
UNION ALL SELECT 'goals', count(*) FROM goals
UNION ALL SELECT 'users', count(*) FROM users;
```

### Messages per bot
```sql
SELECT bot_name, count(*) FROM messages GROUP BY bot_name ORDER BY count DESC;
```

### Recent messages for a user
```sql
SELECT role, left(content, 80) as preview, created_at
FROM messages WHERE user_id = '8177931333' AND bot_name = 'jarvis'
ORDER BY created_at DESC LIMIT 10;
```

### Search memories
```sql
-- Full-text search
SELECT summary, tags, created_at FROM memories
WHERE search_vector @@ plainto_tsquery('english', 'your search term')
ORDER BY created_at DESC;

-- By tags
SELECT summary, tags FROM memories WHERE 'tag-name' = ANY(tags);
```

### Active goals
```sql
SELECT title, status, deadline, created_at FROM goals
WHERE status = 'active' ORDER BY created_at DESC;
```

### Token usage (last 24h)
```sql
SELECT source, count(*), sum(input_tokens) as input, sum(output_tokens) as output
FROM haiku_usage WHERE created_at > now() - interval '24 hours'
GROUP BY source ORDER BY count DESC;
```

### Cost summary
```sql
SELECT bot_name, count(*), round(sum(cost_usd)::numeric, 4) as total_cost
FROM messages WHERE cost_usd IS NOT NULL
GROUP BY bot_name ORDER BY total_cost DESC;
```

## Docker lifecycle

```bash
bun run db:up          # Start Postgres container
bun run db:down        # Stop and remove container
bun run db:backup      # pg_dump to backups/
bun run db:restore     # Restore latest backup
bun run db:migrate     # Apply pending migrations
bun run db:setup:test  # Create/reset muninn_test DB
```

If the container isn't running, start it with `bun run db:up` and wait a few seconds for it to become healthy.
