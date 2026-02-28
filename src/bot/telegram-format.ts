/**
 * Converts Claude's markdown output to Telegram-safe HTML.
 * The AI outputs standard markdown; this converts to Telegram's HTML subset.
 */
export function formatTelegramHtml(text: string): string {
  let result = text;

  // Escape HTML entities first (but preserve any intentional HTML tags Claude sent)
  // We selectively escape only & that aren't part of entities
  result = result.replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;");

  // Preserve code blocks from further processing
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? `<code class="language-${lang}">` : "<code>";
    codeBlocks.push(`<pre>${langAttr}${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Convert markdown headings to bold lines
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Remove horizontal rules
  result = result.replace(/^---+$/gm, "");

  // Convert **bold** to <b>bold</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Convert *italic* to <i>italic</i> (but not inside words like file*name)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");

  // Convert _italic_ to <i>italic</i>
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Convert ~~strikethrough~~ to <s>strikethrough</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Convert markdown links [text](url) to <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks and inline codes
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)] ?? "");
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)] ?? "");

  // Escape any HTML tags that Telegram doesn't support
  // Telegram allows: b, i, u, s, code, pre, a, tg-spoiler, tg-emoji, blockquote
  const allowedTags = /^\/?(b|i|u|s|code|pre|a|tg-spoiler|tg-emoji|blockquote)(\s|>|$)/i;
  result = result.replace(/<([^>]+)>/g, (match, inner) => {
    if (allowedTags.test(inner)) return match;
    return `&lt;${inner}&gt;`;
  });

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Strip all HTML tags for plain-text fallback when Telegram rejects the HTML.
 */
export function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
