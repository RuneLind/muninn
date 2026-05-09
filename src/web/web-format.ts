import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to rich HTML for the web chat.
 * Similar approach to formatTelegramHtml (extract code blocks, convert, restore)
 * but supports the full range of HTML elements the browser can render.
 *
 * NOTE: A client-side JS port exists in src/chat/views/components/web-format-client.ts
 * (formatWebHtml) for streaming rendering — keep both in sync when modifying.
 */
export function formatWebHtml(text: string): string {
  let result = text;

  // Normalize line endings
  result = result.replace(/\r\n/g, "\n");

  const placeholders = new Placeholders();

  // Preserve code blocks from further processing
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return placeholders.add("CODEBLOCK", `<pre><code${langClass}>${escapeHtml(code.trimEnd())}</code></pre>`);
  });

  // Preserve inline code
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    return placeholders.add("INLINE", `<code>${escapeHtml(code)}</code>`);
  });

  // Defensive normalization: Claude occasionally outputs Slack-style links (<url|text>)
  // instead of standard markdown [text](url). Convert them before HTML-escaping so they
  // go through the normal markdown link path. This is NOT an intermediate Slack→HTML
  // conversion — the primary input is always raw markdown from the AI connector.
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  // Escape HTML entities in regular text (code blocks already escaped above).
  // This prevents raw HTML in Claude's response from being interpreted as tags.
  // Must happen before markdown conversions so generated tags aren't affected.
  result = escapeHtml(result);

  // Convert markdown tables to HTML tables (uses | delimiters, unaffected by escaping)
  result = convertTables(result);

  // Convert headings: ## heading → <h3>, ### heading → <h4>, etc.
  // Map: # → h2, ## → h3, ### → h4, #### → h5, ##### → h6
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes: string, content: string) => {
    const level = Math.min(hashes.length + 1, 6); // # → h2, ## → h3, etc.
    return `<h${level}>${content}</h${level}>`;
  });

  // Horizontal rules
  result = result.replace(/^---+$/gm, "<hr>");

  // Blockquotes: consecutive &gt; lines grouped (> was escaped above)
  result = convertBlockquotes(result);

  // Lists before italic to avoid * list items matching *italic*
  // Unordered lists: consecutive - or * lines
  result = convertUnorderedLists(result);

  // Ordered lists: consecutive 1. lines
  result = convertOrderedLists(result);

  // Bold: **text** → <strong>
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *text* → <em> (not inside words)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");

  // Italic: _text_ → <em>
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");

  // Strikethrough: ~~text~~ → <s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) → <a> (only http/https to prevent javascript: injection)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    if (/^https?:\/\//.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
    }
    return text;
  });

  // Restore code blocks and inline codes
  result = placeholders.restore(result);

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  // Collapse blank lines around block-level elements — their CSS handles spacing,
  // and pre-wrap would otherwise render the \n as extra visible line breaks.
  const blockRe = "(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)";
  result = result.replace(new RegExp(`\\n+(</?${blockRe}[>\\s])`, "g"), "\n$1");
  result = result.replace(new RegExp(`(</${blockRe}>|<hr>)\\n+`, "g"), "$1\n");

  return result.trim();
}

/** Convert consecutive &gt; lines into <blockquote> (> is escaped to &gt; before this runs) */
function convertBlockquotes(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let quoteLines: string[] = [];

  function flushQuote() {
    if (quoteLines.length > 0) {
      result.push("<blockquote>" + quoteLines.join("<br>") + "</blockquote>");
      quoteLines = [];
    }
  }

  for (const line of lines) {
    const match = line.match(/^&gt;\s?(.*)/);
    if (match) {
      quoteLines.push(match[1]!);
    } else {
      flushQuote();
      result.push(line);
    }
  }
  flushQuote();

  return result.join("\n");
}

/** Convert consecutive - or * list items into <ul><li> */
function convertUnorderedLists(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length > 0) {
      result.push("<ul>" + listItems.map((item) => `<li>${item}</li>`).join("") + "</ul>");
      listItems = [];
    }
  }

  for (const line of lines) {
    const match = line.match(/^[-*]\s+(.*)/);
    if (match) {
      listItems.push(match[1]!);
    } else {
      flushList();
      result.push(line);
    }
  }
  flushList();

  return result.join("\n");
}

/** Convert consecutive numbered items into <ol><li> */
function convertOrderedLists(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length > 0) {
      result.push("<ol>" + listItems.map((item) => `<li>${item}</li>`).join("") + "</ol>");
      listItems = [];
    }
  }

  for (const line of lines) {
    const match = line.match(/^\d+\.\s+(.*)/);
    if (match) {
      listItems.push(match[1]!);
    } else {
      flushList();
      result.push(line);
    }
  }
  flushList();

  return result.join("\n");
}

/** Convert markdown tables to HTML tables */
function convertTables(text: string): string {
  // Match table pattern: header row, separator row, data rows
  return text.replace(
    /^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_match, headerLine: string, _separator: string, bodyLines: string) => {
      const headers = parsePipeCells(headerLine);
      const rows = bodyLines.trimEnd().split("\n").map(parsePipeCells);

      const thead = "<thead><tr>" + headers.map((h) => `<th>${h.trim()}</th>`).join("") + "</tr></thead>";
      const tbody = "<tbody>" + rows.map((row) =>
        "<tr>" + row.map((cell) => `<td>${cell.trim()}</td>`).join("") + "</tr>"
      ).join("") + "</tbody>";

      return `<table>${thead}${tbody}</table>`;
    },
  );
}

function parsePipeCells(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|");
}

