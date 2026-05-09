import { Placeholders } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Slack mrkdwn format.
 * Slack uses its own formatting: *bold*, _italic_, ~strike~, <url|text>
 */
export function formatSlackMrkdwn(text: string): string {
  let result = text;

  const placeholders = new Placeholders();

  // Preserve code blocks from further processing
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return placeholders.add("CODEBLOCK", `\`\`\`\n${code.trimEnd()}\n\`\`\``);
  });

  // Preserve inline code
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    return placeholders.add("INLINE", `\`${code}\``);
  });

  // Convert markdown tables to labeled bullet lists
  result = convertMarkdownTables(result);

  // Convert markdown headings to bold lines
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Remove horizontal rules
  result = result.replace(/^---+$/gm, "");

  // Convert **bold** to *bold* (Slack mrkdwn)
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert _italic_ — already correct for Slack
  // Convert *italic* (single) to _italic_ (but only after bold conversion)
  // Skip this since single * is bold in Slack

  // Convert ~~strikethrough~~ to ~strike~ (Slack mrkdwn)
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Convert markdown links [text](url) to Slack format <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert HTML tags that Claude might output
  result = result.replace(/<b>(.*?)<\/b>/g, "*$1*");
  result = result.replace(/<i>(.*?)<\/i>/g, "_$1_");
  result = result.replace(/<s>(.*?)<\/s>/g, "~$1~");
  result = result.replace(/<code>(.*?)<\/code>/g, "`$1`");
  result = result.replace(/<a href="([^"]+)">(.*?)<\/a>/g, "<$1|$2>");

  // Preserve Slack links before stripping HTML tags
  result = result.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, (_match, url, text) => {
    return placeholders.add("LINK", `<${url}|${text}>`);
  });
  // Also preserve bare URL links <url> (no display text)
  result = result.replace(/<(https?:\/\/[^>]+)>/g, (_match, url) => {
    return placeholders.add("LINK", `<${url}>`);
  });

  // Strip remaining HTML tags
  result = result.replace(/<\/?[^>]+>/g, "");

  // Restore Slack links + code blocks + inline codes
  result = placeholders.restore(result);

  // Strip empty bullet points (bullet char followed by only whitespace)
  result = result.replace(/^[•\-\*]\s*$/gm, "");

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Converts markdown tables to labeled bullet lists for Slack.
 *
 * Input:
 *   | # | Name | Link |
 *   |---|------|------|
 *   | 1 | Foo  | bar  |
 *   | 2 | Baz  |      |
 *
 * Output:
 *   • *#:* 1  *Name:* Foo  *Link:* bar
 *   • *#:* 2  *Name:* Baz
 */
function convertMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    // Check if this line looks like a table row (starts and contains |)
    if (!isTableRow(line)) {
      output.push(line);
      i++;
      continue;
    }

    // Collect consecutive table lines
    const tableLines: string[] = [];
    while (i < lines.length && isTableRow(lines[i]!)) {
      tableLines.push(lines[i]!);
      i++;
    }

    // Need at least header + separator + one data row
    if (tableLines.length < 3 || !isSeparatorRow(tableLines[1]!)) {
      // Not a real table, pass through as-is
      output.push(...tableLines);
      continue;
    }

    const headers = parseCells(tableLines[0]!);
    // Skip separator (index 1), convert data rows
    for (let r = 2; r < tableLines.length; r++) {
      if (isSeparatorRow(tableLines[r]!)) continue; // skip extra separators
      const cells = parseCells(tableLines[r]!);
      if (headers.length === 1) {
        // Single-column table: simple bullet
        const val = cells[0]?.trim();
        if (val) output.push(`• ${val}`);
      } else {
        const parts: string[] = [];
        for (let c = 0; c < headers.length; c++) {
          const val = cells[c]?.trim();
          if (val) parts.push(`*${headers[c]!.trim()}:* ${val}`);
        }
        if (parts.length > 0) output.push(`• ${parts.join("  ")}`);
      }
    }
    continue;
  }

  return output.join("\n");
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parseCells(line: string): string[] {
  // Remove leading/trailing pipes and split by |
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|");
}
