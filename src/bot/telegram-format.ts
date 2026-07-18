import { parseBlocks, normalizeVerdictValue, parseMeterAttrs } from "../format/markdown-ast.ts";
import { renderBlocks, type BlockRenderer } from "../format/block-renderer.ts";
import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Telegram-safe HTML.
 * Walks the shared block AST via `renderBlocks`; each block emits Telegram's
 * HTML subset and inline content runs through `renderInline`.
 */
export function formatTelegramHtml(text: string): string {
  const rendered = renderBlocks(parseBlocks(text), telegramRenderer);
  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

const TG_ALLOWED_TAG = /^\/?(b|i|u|s|code|pre|a|tg-spoiler|tg-emoji|blockquote)(\s|>|$)/i;

const telegramRenderer: BlockRenderer = {
  code_block(block) {
    const openTag = block.lang ? `<code class="language-${block.lang}">` : "<code>";
    return `<pre>${openTag}${escapeHtml(block.code)}</code></pre>`;
  },
  hr: () => "",
  heading: (block) => `<b>${renderInline(block.content)}</b>`,
  blockquote: (lines) => lines.map((l) => `> ${renderInline(l)}`).join("\n"),
  ul: (items) => items.map((i) => `- ${renderInline(i)}`).join("\n"),
  ol: (items) => items.map((i, idx) => `${idx + 1}. ${renderInline(i)}`).join("\n"),
  table(headers, rows) {
    const headerRow = `| ${headers.map(renderInline).join(" | ")} |`;
    const sepRow = "|" + headers.map(() => "---").join("|") + "|";
    const dataRows = rows.map((row) => `| ${row.map(renderInline).join(" | ")} |`);
    return [headerRow, sepRow, ...dataRows].join("\n");
  },
  component(name, attrs, children) {
    switch (name) {
      case "Callout":
        return attrs.title ? `<b>${escapeHtml(attrs.title)}</b>\n${children}` : children;
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return `${value === "yes" ? "✅" : "❌"} ${label}`;
      }
      case "Pill":
        return `[${children.trim()}]`;
      case "Figure":
        return attrs.caption ? `${children}\n${escapeHtml(attrs.caption)}` : children;
      case "FileRef":
        return children.trim() || escapeHtml(attrs.path ?? "");
      case "ComparisonTable":
        return children;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        if (!meter) return children; // missing/non-numeric value → label as plain text
        return `${children}: ${meter.value}/${meter.max}`;
      }
    }
  },
  text: (lines) => lines.map(renderInline).join("\n"),
};

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
