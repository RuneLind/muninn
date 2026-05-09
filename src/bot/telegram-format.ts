import { type Block, parseBlocks } from "../format/markdown-ast.ts";
import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Telegram-safe HTML.
 * Walks the shared block AST; each block emits Telegram's HTML subset and
 * inline content runs through `renderInline`.
 */
export function formatTelegramHtml(text: string): string {
  const blocks = parseBlocks(text);
  const rendered = blocks.map(renderBlock).join("\n");
  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

const TG_ALLOWED_TAG = /^\/?(b|i|u|s|code|pre|a|tg-spoiler|tg-emoji|blockquote)(\s|>|$)/i;

function renderBlock(block: Block): string {
  switch (block.type) {
    case "code_block": {
      const openTag = block.lang ? `<code class="language-${block.lang}">` : "<code>";
      return `<pre>${openTag}${escapeHtml(block.code)}</code></pre>`;
    }
    case "hr":
      return "";
    case "heading":
      return `<b>${renderInline(block.content)}</b>`;
    case "blockquote":
      return block.lines.map((l) => `> ${renderInline(l)}`).join("\n");
    case "ul":
      return block.items.map((i) => `- ${renderInline(i)}`).join("\n");
    case "ol":
      return block.items.map((i, idx) => `${idx + 1}. ${renderInline(i)}`).join("\n");
    case "table": {
      const headerRow = `| ${block.headers.map(renderInline).join(" | ")} |`;
      const sepRow = "|" + block.headers.map(() => "---").join("|") + "|";
      const dataRows = block.rows.map((row) => `| ${row.map(renderInline).join(" | ")} |`);
      return [headerRow, sepRow, ...dataRows].join("\n");
    }
    case "text":
      return block.lines.map(renderInline).join("\n");
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

function renderInline(text: string): string {
  // Selective ampersand escape — preserve existing entities verbatim.
  let result = text.replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;");

  const ph = new Placeholders();

  result = result.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `<code>${escapeHtml(code)}</code>`),
  );

  // Link text is NOT inline-processed — prevents nested-tag tangles like
  // <a><i>...</a></i> that Telegram rejects.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    ph.add("LINK", `<a href="${url}">${label}</a>`),
  );

  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  result = ph.restore(result);

  // Telegram only renders a fixed set of HTML tags; anything else must be
  // escaped or it returns a 400.
  result = result.replace(/<([^>]+)>/g, (match, inner: string) => {
    if (TG_ALLOWED_TAG.test(inner)) return match;
    return `&lt;${inner}&gt;`;
  });

  return result;
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
