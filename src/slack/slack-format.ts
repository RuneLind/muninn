import { type Block, parseBlocks } from "../format/markdown-ast.ts";
import { Placeholders } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Slack mrkdwn.
 * Walks the shared block AST; tables become labeled bullet lists and inline
 * content runs through `renderInline` (which also accepts a few HTML tags
 * Claude occasionally emits and converts them to mrkdwn).
 */
export function formatSlackMrkdwn(text: string): string {
  const blocks = parseBlocks(text);
  const rendered = blocks.map(renderBlock).join("\n");
  return rendered
    .replace(/^[•\-\*]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "code_block":
      return "```\n" + block.code + "\n```";
    case "hr":
      return "";
    case "heading":
      return `*${renderInline(block.content)}*`;
    case "blockquote":
      return block.lines.map((l) => `> ${renderInline(l)}`).join("\n");
    case "ul":
      return block.items.map((i) => `- ${renderInline(i)}`).join("\n");
    case "ol":
      return block.items.map((i, idx) => `${idx + 1}. ${renderInline(i)}`).join("\n");
    case "table":
      return renderTable(block.headers, block.rows);
    case "text":
      return block.lines.map(renderInline).join("\n");
  }
}

/**
 * Tables become labeled bullet lists for Slack.
 *   • *Header1:* val1  *Header2:* val2
 * Single-column tables use simple bullets (• val).
 */
function renderTable(headers: string[], rows: string[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (headers.length === 1) {
      const val = renderInline(row[0] ?? "");
      if (val) lines.push(`• ${val}`);
      continue;
    }
    const parts: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      const val = renderInline(row[c] ?? "");
      if (val) parts.push(`*${renderInline(headers[c]!)}:* ${val}`);
    }
    if (parts.length > 0) lines.push(`• ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

function renderInline(text: string): string {
  let result = text;
  const ph = new Placeholders();

  // Inline code → placeholder (mrkdwn syntax: `code`).
  result = result.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `\`${code}\``),
  );

  // Markdown bold + strike → mrkdwn.
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Markdown links → Slack format.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // HTML tags Claude occasionally outputs → mrkdwn.
  result = result.replace(/<b>(.*?)<\/b>/g, "*$1*");
  result = result.replace(/<i>(.*?)<\/i>/g, "_$1_");
  result = result.replace(/<s>(.*?)<\/s>/g, "~$1~");
  result = result.replace(/<code>(.*?)<\/code>/g, "`$1`");
  result = result.replace(/<a href="([^"]+)">(.*?)<\/a>/g, "<$1|$2>");

  // Preserve Slack-style links before stripping remaining HTML.
  result = result.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
    ph.add("LINK", `<${url}|${label}>`),
  );
  result = result.replace(/<(https?:\/\/[^>]+)>/g, (_m, url: string) =>
    ph.add("LINK", `<${url}>`),
  );

  // Strip any remaining HTML tags Claude may have emitted.
  result = result.replace(/<\/?[^>]+>/g, "");

  return ph.restore(result);
}
