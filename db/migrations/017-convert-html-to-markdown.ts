/**
 * Migration: Convert stored Telegram HTML messages to markdown.
 *
 * Before this change, Jarvis's persona told Claude to output Telegram HTML
 * (<b>, <i>, etc.), which was stored as-is in the DB. Now all AI output is
 * standard markdown, so we convert the old messages.
 *
 * Run via migration runner: bun db/migrate.ts
 * Run standalone:           bun db/migrations/017-convert-html-to-markdown.ts [--dry-run]
 */
import type postgres from "postgres";

export function convertTelegramHtmlToMarkdown(text: string): string {
  let result = text;

  // Pre blocks with language
  result = result.replace(
    /<pre><code\s+class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
    (_m, lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``,
  );

  // Pre blocks
  result = result.replace(/<pre>([\s\S]*?)<\/pre>/g, (_m, code: string) => `\`\`\`\n${code}\n\`\`\``);

  // Inline code
  result = result.replace(/<code>([^<]*?)<\/code>/g, "`$1`");

  // Links
  result = result.replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/g, "[$2]($1)");

  // Bold
  result = result.replace(/<b>([\s\S]*?)<\/b>/g, "**$1**");
  result = result.replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**");

  // Italic
  result = result.replace(/<i>([\s\S]*?)<\/i>/g, "*$1*");
  result = result.replace(/<em>([\s\S]*?)<\/em>/g, "*$1*");

  // Underline — no markdown equivalent
  result = result.replace(/<u>([\s\S]*?)<\/u>/g, "$1");

  // Strikethrough
  result = result.replace(/<s>([\s\S]*?)<\/s>/g, "~~$1~~");
  result = result.replace(/<del>([\s\S]*?)<\/del>/g, "~~$1~~");

  // Decode HTML entities (must come AFTER tag removal to avoid creating new tags)
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, '"');

  return result;
}

export async function migrate(db: postgres.Sql) {
  const rows = await db`
    SELECT id, content
    FROM messages
    WHERE role = 'assistant'
      AND content ~ '<(b|i|em|strong|code|pre|a )'
  `;

  console.log(`Found ${rows.length} messages with HTML tags`);

  let updated = 0;
  for (const row of rows) {
    const converted = convertTelegramHtmlToMarkdown(row.content);
    if (converted === row.content) continue;
    await db`UPDATE messages SET content = ${converted} WHERE id = ${row.id}`;
    updated++;
  }

  console.log(`Updated ${updated} of ${rows.length} messages`);
}

// Standalone execution
if (import.meta.main) {
  const { default: pg } = await import("postgres");
  const url = process.env.DATABASE_URL ?? "postgresql://muninn:muninn@127.0.0.1:5434/muninn";
  const sql = pg(url, { max: 1 });
  await migrate(sql).finally(() => sql.end());
}
