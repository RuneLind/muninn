/**
 * Follow-up fix: decode HTML entities left behind by migration 017.
 *
 * Migration 017 converted HTML tags to markdown but didn't decode
 * HTML entities (&amp;, &lt;, &gt;, &quot;). This fixes those.
 *
 * Run: bun db/migrations/019-fix-leftover-entities.ts
 * Dry run: bun db/migrations/019-fix-leftover-entities.ts --dry-run
 */
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis";
const sql = postgres(DATABASE_URL, { max: 1 });

async function migrate() {
  const rows = await sql`
    SELECT id, content FROM messages
    WHERE role = 'assistant'
      AND (content LIKE '%&amp;%' OR content LIKE '%&lt;%' OR content LIKE '%&gt;%' OR content LIKE '%&quot;%')
  `;

  console.log(`Found ${rows.length} messages with HTML entities${DRY_RUN ? " (dry run)" : ""}`);

  let updated = 0;
  for (const row of rows) {
    let converted = row.content;
    converted = converted.replace(/&amp;/g, "&");
    converted = converted.replace(/&lt;/g, "<");
    converted = converted.replace(/&gt;/g, ">");
    converted = converted.replace(/&quot;/g, '"');

    if (converted === row.content) continue;

    if (DRY_RUN) {
      const entities = row.content.match(/&(amp|lt|gt|quot);/g) ?? [];
      console.log(`\n--- ${row.id} ---`);
      console.log(`Entities: ${[...new Set(entities)].join(", ")} (${entities.length} total)`);
    } else {
      await sql`UPDATE messages SET content = ${converted} WHERE id = ${row.id}`;
    }
    updated++;
  }

  console.log(`\n${DRY_RUN ? "Would update" : "Updated"} ${updated} of ${rows.length} messages`);
  await sql.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  sql.end().then(() => process.exit(1));
});
