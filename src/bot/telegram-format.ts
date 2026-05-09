import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Telegram-safe HTML.
 * The AI outputs standard markdown; this converts to Telegram's HTML subset.
 */
export function formatTelegramHtml(text: string): string {
  let result = text;

  // Escape HTML entities first (but preserve any intentional HTML tags Claude sent)
  // We selectively escape only & that aren't part of entities
  result = result.replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;");

  const placeholders = new Placeholders();

  // Preserve code blocks from further processing
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langAttr = lang ? `<code class="language-${lang}">` : "<code>";
    return placeholders.add("CODEBLOCK", `<pre>${langAttr}${escapeHtml(code.trimEnd())}</code></pre>`);
  });

  // Preserve inline code
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    return placeholders.add("INLINE", `<code>${escapeHtml(code)}</code>`);
  });

  // Convert markdown links early and protect from italic/bold processing
  // (prevents overlapping tags like <a><i>...</a></i> when formatting crosses link boundaries)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    return placeholders.add("LINK", `<a href="${url}">${text}</a>`);
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

  // Restore links + code blocks + inline codes
  result = placeholders.restore(result);

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

