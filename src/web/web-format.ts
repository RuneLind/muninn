/**
 * Converts Claude's markdown output to rich HTML for the web chat.
 * Similar approach to formatTelegramHtml (extract code blocks, convert, restore)
 * but supports the full range of HTML elements the browser can render.
 *
 * NOTE: A client-side JS port exists in src/simulator/views/page.ts (formatWebHtml)
 * for streaming rendering — keep both in sync when modifying.
 */
export function formatWebHtml(text: string): string {
  let result = text;

  // Normalize line endings
  result = result.replace(/\r\n/g, "\n");

  // Preserve code blocks from further processing
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${langClass}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Escape HTML entities in regular text (code blocks already escaped above).
  // This prevents raw HTML in Claude's response from being interpreted as tags.
  // Must happen before markdown conversions so generated tags aren't affected.
  result = result.replace(/&/g, "&amp;");
  result = result.replace(/</g, "&lt;");
  result = result.replace(/>/g, "&gt;");
  result = result.replace(/"/g, "&quot;");

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
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)] ?? "");
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)] ?? "");

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
