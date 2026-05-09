import { type Block, parseBlocks } from "../format/markdown-ast.ts";
import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to rich HTML for the web chat.
 *
 * Walks the shared block AST from `parseBlocks`; each block emits its own
 * HTML and inline content runs through `renderInline`. The chat-page client
 * picks this up automatically via `web-format-browser.ts`'s bundle.
 */
export function formatWebHtml(text: string): string {
  const blocks = parseBlocks(text);
  const rendered = blocks.map(renderBlock).join("\n");
  return collapseBlockSpacing(rendered).trim();
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "code_block": {
      const langClass = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
      return `<pre><code${langClass}>${escapeHtml(block.code)}</code></pre>`;
    }
    case "hr":
      return "<hr>";
    case "heading": {
      const tag = `h${Math.min(block.level + 1, 6)}`;
      return `<${tag}>${renderInline(block.content)}</${tag}>`;
    }
    case "blockquote":
      return `<blockquote>${block.lines.map(renderInline).join("<br>")}</blockquote>`;
    case "ul":
      return `<ul>${block.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ul>`;
    case "ol":
      return `<ol>${block.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ol>`;
    case "table": {
      const thead = "<thead><tr>" + block.headers.map((h) => `<th>${renderInline(h)}</th>`).join("") + "</tr></thead>";
      const tbody = "<tbody>" + block.rows.map((row) =>
        "<tr>" + row.map((cell) => `<td>${renderInline(cell)}</td>`).join("") + "</tr>"
      ).join("") + "</tbody>";
      return `<table>${thead}${tbody}</table>`;
    }
    case "text":
      return block.lines.map(renderInline).join("\n");
  }
}

function renderInline(text: string): string {
  const ph = new Placeholders();
  let result = text;

  // Inline code first — protect content from further markdown processing.
  result = result.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `<code>${escapeHtml(code)}</code>`),
  );

  // Defensive: Claude occasionally outputs Slack-style angle-bracket links;
  // normalize them to markdown form before HTML-escaping (which would otherwise
  // turn the angle brackets into entities and hide the link).
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  // Escape HTML entities — prevents raw HTML in Claude's response from being
  // interpreted as tags. Must happen before generated tags are emitted below.
  result = escapeHtml(result);

  // Markdown links → <a>. Only http/https to prevent javascript: injection.
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    if (/^https?:\/\//.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    }
    return label;
  });

  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  return ph.restore(result);
}

/** Collapse excess blank lines, especially around block-level elements. */
function collapseBlockSpacing(text: string): string {
  let result = text.replace(/\n{3,}/g, "\n\n");
  const blockRe = "(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)";
  result = result.replace(new RegExp(`\\n+(</?${blockRe}[>\\s])`, "g"), "\n$1");
  result = result.replace(new RegExp(`(</${blockRe}>|<hr>)\\n+`, "g"), "$1\n");
  return result;
}
