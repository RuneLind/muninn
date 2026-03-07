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
 * Run:     bun db/migrations/018-convert-slack-mrkdwn-to-markdown.ts
 * Dry run: bun db/migrations/018-convert-slack-mrkdwn-to-markdown.ts --dry-run
 */
import postgres from "postgres";

const DRY_RUN = process.argv.includes("--dry-run");

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://muninn:muninn@127.0.0.1:5434/muninn";
const sql = postgres(DATABASE_URL, { max: 1 });

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

async function migrate() {
  // Target messages from bots that used Slack mrkdwn formatting.
  // Match on Slack bold (*text*), Slack links (<url|text>), or Slack strike (~text~).
  const rows = await sql`
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

  console.log(`Found ${rows.length} messages with Slack mrkdwn${DRY_RUN ? " (dry run)" : ""}`);

  let updated = 0;
  for (const row of rows) {
    const converted = convertSlackMrkdwnToMarkdown(row.content);
    if (converted === row.content) continue;

    if (DRY_RUN) {
      console.log(`\n--- ${row.id} (${row.bot_name}) ---`);
      console.log(`BEFORE: ${row.content.slice(0, 150)}`);
      console.log(`AFTER:  ${converted.slice(0, 150)}`);
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
