/**
 * Converts Claude's markdown output to Slack mrkdwn format.
 * Slack uses its own formatting: *bold*, _italic_, ~strike~, <url|text>
 */
export function formatSlackMrkdwn(text: string): string {
  let result = text;

  // Preserve code blocks from further processing
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`\`\`\`\n${code.trimEnd()}\n\`\`\``);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`\`${code}\``);
    return `\x00INLINE${idx}\x00`;
  });

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

  // Strip remaining HTML tags
  result = result.replace(/<\/?[^>]+>/g, "");

  // Restore code blocks and inline codes
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)] ?? "");
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)] ?? "");

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
