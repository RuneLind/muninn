/**
 * Migration: Convert stored Slack mrkdwn messages to standard markdown.
 *
 * Slack bots were instructed to output Slack mrkdwn
 * (*bold*, ~strike~, <url|text>), which was stored as-is in the DB.
 * Now all bots output standard markdown. This migrates old messages.
 *
 * Key conversions:
 *   *bold*     → **bold**    (Slack bold = single *, markdown bold = double **)
 *   ~strike~   → ~~strike~~
 *   <url|text> → [text](url)
 *   <url>      → [url](url)
 *
 * Run via migration runner: bun db/migrate.ts
 * Run standalone:           bun db/migrations/018-convert-slack-mrkdwn-to-markdown.ts
 */
import type postgres from "postgres";

export function convertSlackMrkdwnToMarkdown(text: string): string {
  let result = text;

  // Preserve code blocks FIRST (before any backtick manipulation)
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Fix backtick-wrapped Slack bold: `*text*` → **text**
  // Claude sometimes wrapped Slack bold in inline code — unwrap and convert to markdown bold
  result = result.replace(/`\*([^*`]+)\*`/g, "**$1**");

  // Fix backtick-wrapped bullet chars: `•` → just •
  result = result.replace(/`•`/g, "•");

  // Fix double bullets: • • text → • text (after unwrapping `•`)
  result = result.replace(/•\s*•\s*/g, "• ");

  // Preserve remaining inline code (after backtick-bold unwrap)
  const inlineCodes: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    const idx = inlineCodes.length;
    inlineCodes.push(match);
    return `\x00INLINE${idx}\x00`;
  });

  // Slack links: <url|text> → [text](url)
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  // Bare Slack links: <url> → [url](url)
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  // Slack bold: *text* → **text** (but skip if already **text**)
  // Match *text* that is NOT preceded or followed by another *
  result = result.replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, "**$1**");

  // Slack strikethrough: ~text~ → ~~text~~ (skip if already ~~text~~)
  result = result.replace(/(?<!~)~(?!~)([^~\n]+?)(?<!~)~(?!~)/g, "~~$1~~");

  // Restore code blocks and inline codes
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)] ?? "");
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)] ?? "");

  return result;
}

export async function migrate(db: postgres.Sql) {
  const rows = await db`
    SELECT id, bot_name, content
    FROM messages
    WHERE role = 'assistant'
      AND bot_name IN ('jira-assistant')
      AND (
        content ~ '\\*[A-Z][^*]+\\*'
        OR content ~ '<https?://[^>]+\\|[^>]+>'
        OR content LIKE '%\`*%*\`%'
        OR content LIKE '%\`•\`%'
      )
  `;

  console.log(`Found ${rows.length} messages with Slack mrkdwn`);

  let updated = 0;
  for (const row of rows) {
    const converted = convertSlackMrkdwnToMarkdown(row.content);
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
