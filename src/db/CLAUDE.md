# Database Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `client.ts` | `initDb()` / `getDb()` / `closeDb()` — postgres singleton (max 5 connections) |
| `messages.ts` | Message CRUD, conversation listing, response metadata, alert messages |
| `memories.ts` | Memory CRUD, hybrid search (FTS + pgvector RRF), dashboard search, stats |
| `threads.ts` | Thread CRUD, switch/activate, Slack thread management, cascade delete |
| `users.ts` | User upsert (`ensureUser`), lookup, update |
| `goals.ts` | Goal CRUD with status tracking |
| `scheduled-tasks.ts` | Scheduled task CRUD (cron + interval styles) |
| `watchers.ts` | Watcher CRUD with dedup tracking (`lastNotifiedIds`) |
| `activity.ts` | Activity log persistence |
| `traces.ts` | Trace span storage, waterfall queries, tool usage stats |
| `connectors.ts` | Named AI connector configurations (DB-persisted) |
| `chat-preferences.ts` | Per-user+bot preferred connector |
| `prompt-snapshots.ts` | Prompt snapshot storage with retention cleanup |
| `user-settings.ts` | Per-user settings (quiet hours, timezone, preferences) |
| `stats.ts` | Aggregate usage statistics |

## Connection Pattern

```typescript
import { getDb } from "./client.ts";
const sql = getDb(); // throws if initDb() not called yet
const rows = await sql`SELECT * FROM users WHERE id = ${userId}`;
```

Uses the `postgres` npm package (not Bun.sql, not Supabase). Pool: max 5 connections, 20s idle timeout, 30min max lifetime.

## CRUD Pattern

Each file exports functions for one table. Functions accept typed parameters and return typed objects. Row-to-type mapping is done inline or via a `mapRow()` / `rowToThread()` helper.

## Timestamps

- Stored as `TIMESTAMPTZ` in Postgres
- Exposed as **epoch milliseconds** in TypeScript: `new Date(row.created_at).getTime()`
- All interfaces use `number` for timestamp fields (not `Date` or `string`)

## Vector Search (memories.ts)

- pgvector extension with 384-dimensional embeddings (MiniLM-L6-v2)
- Hybrid search: Reciprocal Rank Fusion (RRF) combining FTS (`tsvector`) and vector similarity (`<=>` operator)
- Embeddings stored as `vector` type, inserted via `sql.unsafe()` with `$N::vector` cast
- Memory scope: `personal` (per-user) or `shared` (visible to all users of a bot)

## Thread Management (threads.ts)

- Threads provide per-user+bot conversation isolation
- "main" thread is auto-created and cannot be deleted
- `switchThread()` deactivates current, activates target (transactional)
- Slack threads use name format `slack:{channel}:{threadTs}` (always inactive)
- Cascade delete: memories -> messages -> thread (done manually, not via FK cascade)
- Pre-migration messages (`thread_id IS NULL`) visible only in the `main` thread

## Migrations

- Numbered files in `db/migrations/` (`.sql` and `.ts`)
- Tracked in `schema_migrations` table
- Full consolidated schema: `db/init.sql` (applied by Docker on first start)
- Run: `bun run db:migrate` / Status: `bun run db:migrate:status`

### init.sql drift guard

Two deploy paths must agree: a **fresh** deploy applies `init.sql` then baselines
migrations (marks them applied without running), so `init.sql` is the whole truth;
an **upgraded** deploy runs `db/migrations/` incrementally. They only converge if
**every schema change lands in BOTH `init.sql` and a migration**.

`src/db/schema-drift.test.ts` enforces this: it builds the schema both ways into
throwaway DBs and diffs them structurally (columns + indexes + constraints +
extensions, order-independent). It skips cleanly when Postgres is unreachable.

- Migrations 006+ ALTER pre-existing tables (the supabase 001-005 base was
  consolidated into `init.sql` and deleted), so they can't replay from empty.
  `db/migration-replay-base.sql` is a **frozen** snapshot of `init.sql` just before
  migration 006 — the replay applies on top of it. It is history; never edit it.
- Excluded from the diff: `schema_migrations` (bookkeeping; only rows differ) and
  `benchmark_*` (created by migrations 030-034 but intentionally absent from
  `init.sql` — experimental tooling fresh deploys don't carry).
- The replay calls `runMigrations(url, { perMigrationTransaction: false })` because
  migration 016 uses `CREATE INDEX CONCURRENTLY`, which can't run in a transaction.
- **When the guard fails**, add the missing object to whichever side lacks it (a new
  migration for an upgraded-only column, an `init.sql` line for a fresh-only index).

## Testing

DB integration tests require:
1. Postgres running: `bun run db:up`
2. Test database created: `bun run db:setup:test` (creates `muninn_test`, applies schema)
3. Run: `bun run test:db`

Test files are co-located: `messages.test.ts`, `memories.test.ts`, `threads.test.ts`, `goals.test.ts`, `scheduled-tasks.test.ts`, `watchers.test.ts`, `traces.test.ts`, `activity.test.ts`, `user-settings.test.ts`, `stats.test.ts`, `schema-drift.test.ts` (init.sql ↔ migrations drift guard; creates its own throwaway DBs, no `db:setup:test` needed).

## Key Tables

| Table | Key columns | Notes |
|---|---|---|
| `users` | id, username, platform, is_active | Canonical user identity across platforms |
| `messages` | user_id, bot_name, role, content, platform, thread_id, trace_id | Token tracking (input/output/context), cost |
| `memories` | user_id, bot_name, summary, embedding, scope, search_vector | pgvector + FTS for hybrid search |
| `threads` | user_id, bot_name, name, connector_id, is_active | Unique on (user_id, bot_name, name) |
| `goals` | user_id, bot_name, title, status, deadline | Active goal tracking |
| `scheduled_tasks` | user_id, bot_name, schedule_hour/minute/days/interval_ms | Cron or interval scheduling |
| `watchers` | user_id, bot_name, interval_ms, last_notified_ids | Background monitors with dedup |
| `traces` | id, parent_id, name, attributes (JSONB) | Span hierarchy for request tracing |
| `connectors` | id, name, connector_type, model, base_url | Named AI connector configurations |

## Common Pitfalls

1. **sql.unsafe() for vectors**: The `postgres` library can't parameterize `vector` type — must use `sql.unsafe()` with `$N::vector` cast.
2. **Thread cascade**: No FK cascade on memories -> messages. Manual delete order: memories, messages, thread.
3. **Pre-migration messages**: Messages with `thread_id IS NULL` are only included when querying the `main` thread — other threads won't see them.
4. **Timestamp conversion**: Always use `new Date(row.field).getTime()` — raw row values are strings, not numbers.
5. **Transaction typing**: `sql.begin()` callback receives `TransactionSql` which loses call signatures — cast to `Sql` type.
