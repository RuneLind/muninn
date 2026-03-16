// Client-side markdown/mrkdwn → HTML formatters.
// Exported as TypeScript (for testing) AND as a JS string (for browser injection).
//
// IMPORTANT: formatWebHtml is a manual port of src/web/web-format.ts — keep both in sync.

// ── Pure functions ─────────────────────────────────────────────────────

function escapeHtmlLocal(text: string): string {
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

// Pre-compiled regexes for block-element blank-line collapsing (used in formatWebHtml hot path)
const BLOCK_RE = "(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)";
const BLOCK_BEFORE_RE = new RegExp(`\\n+(</?${BLOCK_RE}[>\\s])`, "g");
const BLOCK_AFTER_RE = new RegExp(`(</${BLOCK_RE}>|<hr>)\\n+`, "g");

/** Convert markdown tables to HTML tables */
function convertTables(text: string): string {
  return text.replace(
    /^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_match, headerLine: string, _separator: string, bodyLines: string) => {
      const headers = headerLine.replace(/^\||\|$/g, "").split("|");
      const rows = bodyLines.trimEnd().split("\n").map((r: string) => r.replace(/^\||\|$/g, "").split("|"));
      const thead = "<thead><tr>" + headers.map((h: string) => `<th>${h.trim()}</th>`).join("") + "</tr></thead>";
      const tbody = "<tbody>" + rows.map((row: string[]) =>
        "<tr>" + row.map((cell: string) => `<td>${cell.trim()}</td>`).join("") + "</tr>"
      ).join("") + "</tbody>";
      return `<table>${thead}${tbody}</table>`;
    },
  );
}

/**
 * Client-side markdown → HTML formatter for web chat.
 * Manual port of src/web/web-format.ts — keep both in sync.
 */
export function formatWebHtml(text: string): string {
  let result = text.replace(/\r\n/g, "\n");

  // Preserve code blocks
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const langClass = lang ? ` class="language-${escapeHtmlLocal(lang)}"` : "";
    codeBlocks.push(`<pre><code${langClass}>${escapeHtmlLocal(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtmlLocal(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Defensive normalization: Slack-style links → markdown links
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
  result = result.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)");

  // Escape HTML entities
  result = result.replace(/&/g, "&amp;");
  result = result.replace(/</g, "&lt;");
  result = result.replace(/>/g, "&gt;");
  result = result.replace(/"/g, "&quot;");

  // Tables
  result = convertTables(result);

  // Headings
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes: string, content: string) => {
    const level = Math.min(hashes.length + 1, 6);
    return `<h${level}>${content}</h${level}>`;
  });

  // Horizontal rules
  result = result.replace(/^---+$/gm, "<hr>");

  // Blockquotes
  result = convertBlockquotes(result);

  // Lists before italic to avoid * list items matching *italic*
  result = convertUnorderedLists(result);
  result = convertOrderedLists(result);

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic *text*
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<em>$1</em>");
  // Italic _text_
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<em>$1</em>");
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links [text](url) — only http/https
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText: string, url: string) => {
    if (/^https?:\/\//.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener">${linkText}</a>`;
    }
    return linkText;
  });

  // Restore code blocks and inline codes
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)] ?? "");
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)] ?? "");

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  // Collapse blank lines around block-level elements
  result = result.replace(BLOCK_BEFORE_RE, "\n$1");
  result = result.replace(BLOCK_AFTER_RE, "$1\n");

  return result.trim();
}

/** Minimal Slack mrkdwn → HTML renderer. Uses escapeHtml from helpersScript(). */
export function renderSlackMrkdwn(text: string): string {
  const links: { url: string; label: string }[] = [];
  let t = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) => {
    links.push({ url, label });
    return "%%SLINK" + (links.length - 1) + "%%";
  });
  t = escapeHtmlLocal(t)
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~([^~]+)~/g, "<del>$1</del>")
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    t = t.replace(
      "%%SLINK" + i + "%%",
      `<a href="${escapeHtmlLocal(link.url)}" target="_blank">${escapeHtmlLocal(link.label)}</a>`,
    );
  }
  return t;
}

const TG_TAGS = ["b", "strong", "i", "em", "u", "s", "del", "code", "pre", "a", "br", "span"];
const WEB_TAGS = [...TG_TAGS, "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "p", "details", "summary"];

/**
 * Sanitize HTML — allow only safe tags and attributes.
 * NOTE: requires DOM (document.createElement) — only runs in browser context.
 * The TS export is for reference only; the runtime version is in webFormatClientScript().
 */
export function sanitizeHtml(html: string, isWeb: boolean): string {
  const allowedTags = isWeb ? WEB_TAGS : TG_TAGS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (globalThis as any).document;
  const tmp = doc.createElement("div");
  tmp.innerHTML = html;

  function walk(node: any) {
    const children = Array.from(node.childNodes) as any[];
    for (const child of children) {
      if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (!allowedTags.includes(tag)) {
          const text = doc.createTextNode(child.textContent || "");
          node.replaceChild(text, child);
        } else {
          const attrs = Array.from(child.attributes) as any[];
          for (const attr of attrs) {
            if (tag === "a" && attr.name === "href" && /^https?:\/\//.test(attr.value)) continue;
            if (tag === "a" && (attr.name === "target" || attr.name === "rel")) continue;
            if (tag === "code" && attr.name === "class") continue;
            child.removeAttribute(attr.name);
          }
          if (tag === "a") {
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noopener");
          }
          walk(child);
        }
      }
    }
  }
  walk(tmp);
  return tmp.innerHTML;
}

// ── Browser-injectable JS string ───────────────────────────────────────

/** Returns all web format client functions as a browser-compatible JS string.
 *  Uses escapeHtml from helpersScript() (already available in page scope). */
export function webFormatClientScript(): string {
  return `
  // Client-side markdown → HTML formatter for web chat.
  // IMPORTANT: This is a manual port of src/web/web-format.ts — keep both in sync.
  function formatWebHtml(text) {
    var result = text.replace(/\\r\\n/g, '\\n');

    // Preserve code blocks
    var codeBlocks = [];
    result = result.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
      var idx = codeBlocks.length;
      var langClass = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      codeBlocks.push('<pre><code' + langClass + '>' + escapeHtml(code.replace(/\\s+$/, '')) + '</code></pre>');
      return '\\x00CODEBLOCK' + idx + '\\x00';
    });

    // Preserve inline code
    var inlineCodes = [];
    result = result.replace(/\`([^\`]+)\`/g, function(_, code) {
      var idx = inlineCodes.length;
      inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
      return '\\x00INLINE' + idx + '\\x00';
    });

    // Defensive normalization: Claude occasionally outputs Slack-style links (<url|text>)
    // instead of standard markdown. Not an intermediate Slack→HTML conversion — input is
    // always raw markdown from the AI connector.
    result = result.replace(/<(https?:\\/\\/[^|>]+)\\|([^>]+)>/g, '[$2]($1)');
    result = result.replace(/<(https?:\\/\\/[^>]+)>/g, '[$1]($1)');

    // Escape HTML entities
    result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Tables
    result = result.replace(/^(\\|.+\\|)\\n(\\|[\\s\\-:|]+\\|)\\n((?:\\|.+\\|\\n?)+)/gm, function(_, headerLine, _sep, bodyLines) {
      var headers = headerLine.replace(/^\\||\\|$/g, '').split('|');
      var rows = bodyLines.replace(/\\s+$/, '').split('\\n');
      var thead = '<thead><tr>' + headers.map(function(h) { return '<th>' + h.trim() + '</th>'; }).join('') + '</tr></thead>';
      var tbody = '<tbody>' + rows.map(function(row) {
        var cells = row.replace(/^\\||\\|$/g, '').split('|');
        return '<tr>' + cells.map(function(c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<table>' + thead + tbody + '</table>';
    });

    // Headings
    result = result.replace(/^(#{1,6})\\s+(.+)$/gm, function(_, hashes, content) {
      var level = Math.min(hashes.length + 1, 6);
      return '<h' + level + '>' + content + '</h' + level + '>';
    });

    // Horizontal rules
    result = result.replace(/^---+$/gm, '<hr>');

    // Blockquotes (> escaped to &gt;)
    var bqLines = result.split('\\n');
    var bqResult = [];
    var quoteLines = [];
    function flushQuote() {
      if (quoteLines.length > 0) {
        bqResult.push('<blockquote>' + quoteLines.join('<br>') + '</blockquote>');
        quoteLines = [];
      }
    }
    for (var bi = 0; bi < bqLines.length; bi++) {
      var bqMatch = bqLines[bi].match(/^&gt;\\s?(.*)/);
      if (bqMatch) { quoteLines.push(bqMatch[1]); }
      else { flushQuote(); bqResult.push(bqLines[bi]); }
    }
    flushQuote();
    result = bqResult.join('\\n');

    // Unordered lists
    var ulLines = result.split('\\n');
    var ulResult = [];
    var ulItems = [];
    function flushUl() {
      if (ulItems.length > 0) {
        ulResult.push('<ul>' + ulItems.map(function(item) { return '<li>' + item + '</li>'; }).join('') + '</ul>');
        ulItems = [];
      }
    }
    for (var ui = 0; ui < ulLines.length; ui++) {
      var ulMatch = ulLines[ui].match(/^[-*]\\s+(.*)/);
      if (ulMatch) { ulItems.push(ulMatch[1]); }
      else { flushUl(); ulResult.push(ulLines[ui]); }
    }
    flushUl();
    result = ulResult.join('\\n');

    // Ordered lists
    var olLines = result.split('\\n');
    var olResult = [];
    var olItems = [];
    function flushOl() {
      if (olItems.length > 0) {
        olResult.push('<ol>' + olItems.map(function(item) { return '<li>' + item + '</li>'; }).join('') + '</ol>');
        olItems = [];
      }
    }
    for (var oi = 0; oi < olLines.length; oi++) {
      var olMatch = olLines[oi].match(/^\\d+\\.\\s+(.*)/);
      if (olMatch) { olItems.push(olMatch[1]); }
      else { flushOl(); olResult.push(olLines[oi]); }
    }
    flushOl();
    result = olResult.join('\\n');

    // Bold
    result = result.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    // Italic *text*
    result = result.replace(/(?<!\\w)\\*([^*]+?)\\*(?!\\w)/g, '<em>$1</em>');
    // Italic _text_
    result = result.replace(/(?<!\\w)_([^_]+?)_(?!\\w)/g, '<em>$1</em>');
    // Strikethrough
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Links [text](url) — only http/https
    result = result.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(_, text, url) {
      if (/^https?:\\/\\//.test(url)) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + text + '</a>';
      }
      return text;
    });

    // Restore code blocks and inline codes
    for (var ci = 0; ci < codeBlocks.length; ci++) {
      result = result.replace('\\x00CODEBLOCK' + ci + '\\x00', codeBlocks[ci]);
    }
    for (var ii = 0; ii < inlineCodes.length; ii++) {
      result = result.replace('\\x00INLINE' + ii + '\\x00', inlineCodes[ii]);
    }

    // Clean up excessive blank lines
    result = result.replace(/\\n{3,}/g, '\\n\\n');

    // Collapse blank lines around block-level elements — their CSS handles spacing,
    // and pre-wrap would otherwise render the \\n as extra visible line breaks.
    var blockRe = '(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)';
    result = result.replace(new RegExp('\\\\n+(</?' + blockRe + '[>\\\\s])', 'g'), '\\n$1');
    result = result.replace(new RegExp('(</' + blockRe + '>|<hr>)\\\\n+', 'g'), '$1\\n');

    return result.trim();
  }

  // Minimal Slack mrkdwn renderer
  function renderSlackMrkdwn(text) {
    var links = [];
    var t = text.replace(/<(https?:\\/\\/[^|>]+)\\|([^>]+)>/g, function(_, url, label) {
      links.push({url: url, label: label});
      return '%%SLINK' + (links.length - 1) + '%%';
    });
    t = escapeHtml(t)
      .replace(/\\*([^*]+)\\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/~([^~]+)~/g, '<del>$1</del>')
      .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\n/g, '<br>');
    for (var i = 0; i < links.length; i++) {
      t = t.replace('%%SLINK' + i + '%%',
        '<a href="' + escapeHtml(links[i].url) + '" target="_blank">' + escapeHtml(links[i].label) + '</a>');
    }
    return t;
  }

  // Sanitize HTML — allow safe tags and attributes
  var _tgTags = ['b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'a', 'br', 'span'];
  var _webTags = _tgTags.concat(['h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'p', 'details', 'summary']);

  function sanitizeHtml(html, isWeb) {
    var allowedTags = isWeb ? _webTags : _tgTags;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;

    function walk(node) {
      var children = Array.from(node.childNodes);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 1) {
          var tag = child.tagName.toLowerCase();
          if (allowedTags.indexOf(tag) === -1) {
            var text = document.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
          } else {
            var attrs = Array.from(child.attributes);
            for (var j = 0; j < attrs.length; j++) {
              var attr = attrs[j];
              if (tag === 'a' && attr.name === 'href' && /^https?:\\/\\//.test(attr.value)) continue;
              if (tag === 'a' && (attr.name === 'target' || attr.name === 'rel')) continue;
              if (tag === 'code' && attr.name === 'class') continue;
              child.removeAttribute(attr.name);
            }
            if (tag === 'a') {
              child.setAttribute('target', '_blank');
              child.setAttribute('rel', 'noopener');
            }
            walk(child);
          }
        }
      }
    }
    walk(tmp);
    return tmp.innerHTML;
  }
  `;
}
