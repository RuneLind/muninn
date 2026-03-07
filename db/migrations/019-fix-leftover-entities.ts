/**
 * Follow-up fix: decode HTML entities left behind by migration 017.
 *
 * Migration 017 converted HTML tags to markdown but didn't decode
 * HTML entities (&amp;, &lt;, &gt;, &quot;). This fixes those.
 *
 * Run via migration runner: bun db/migrate.ts
 * Run standalone:           bun db/migrations/019-fix-leftover-entities.ts
 */
import type postgres from "postgres";

export async function migrate(db: postgres.Sql) {
  const rows = await db`
    SELECT id, content FROM messages
    WHERE role = 'assistant'
      AND (content LIKE '%&amp;%' OR content LIKE '%&lt;%' OR content LIKE '%&gt;%' OR content LIKE '%&quot;%')
  `;

  console.log(`Found ${rows.length} messages with HTML entities`);

  let updated = 0;
  for (const row of rows) {
    let converted = row.content;
    converted = converted.replace(/&amp;/g, "&");
    converted = converted.replace(/&lt;/g, "<");
    converted = converted.replace(/&gt;/g, ">");
    converted = converted.replace(/&quot;/g, '"');

    if (converted === row.content) continue;
    await db`UPDATE messages SET content = ${converted} WHERE id = ${row.id}`;
    updated++;
  }

  console.log(`Updated ${updated} of ${rows.length} messages`);
}

// Standalone execution
if (import.meta.main) {
  const { default: pg } = await import("postgres");
  const url = process.env.DATABASE_URL ?? "postgresql://muninn:muninn@127.0.0.1:5435/muninn";
  const sql = pg(url, { max: 1 });
  await migrate(sql).finally(() => sql.end());
}
