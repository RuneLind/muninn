import {
  parseBlocks,
  normalizeCalloutTone,
  normalizePillTone,
  normalizeVerdictValue,
  parseMeterAttrs,
  firstCodeBlock,
  diffLineClass,
  parseChecklist,
} from "../format/markdown-ast.ts";
import { renderBlocks, type BlockRenderer } from "../format/block-renderer.ts";
import { Placeholders, escapeHtml } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to rich HTML for the web chat.
 *
 * Walks the shared block AST from `parseBlocks` via the shared `renderBlocks`
 * dispatcher; each block emits its own HTML and inline content runs through
 * `renderInline`. The chat-page client picks this up automatically via
 * `web-format-browser.ts`'s bundle.
 */
export function formatWebHtml(text: string): string {
  const rendered = renderBlocks(parseBlocks(text), webRenderer);
  return collapseBlockSpacing(rendered).trim();
}

const webRenderer: BlockRenderer = {
  code_block(block) {
    const langClass = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
    return `<pre><code${langClass}>${escapeHtml(block.code)}</code></pre>`;
  },
  hr: () => "<hr>",
  heading(block) {
    const tag = `h${Math.min(block.level + 1, 6)}`;
    return `<${tag}>${renderInline(block.content)}</${tag}>`;
  },
  blockquote: (lines) => `<blockquote>${lines.map(renderInline).join("<br>")}</blockquote>`,
  ul: (items) => `<ul>${items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ul>`,
  ol: (items) => `<ol>${items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</ol>`,
  table(headers, rows) {
    const thead = "<thead><tr>" + headers.map((h) => `<th>${renderInline(h)}</th>`).join("") + "</tr></thead>";
    const tbody = "<tbody>" + rows.map((row) =>
      "<tr>" + row.map((cell) => `<td>${renderInline(cell)}</td>`).join("") + "</tr>"
    ).join("") + "</tbody>";
    return `<table>${thead}${tbody}</table>`;
  },
  component(name, attrs, children, rawChildren) {
    switch (name) {
      case "Callout": {
        const tone = normalizeCalloutTone(attrs.tone);
        const title = attrs.title
          ? `<strong class="callout-title">${escapeHtml(attrs.title)}</strong>`
          : "";
        return `<div class="callout callout-${tone}">${title}<div class="callout-body">${children}</div></div>`;
      }
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return `<span class="verdict verdict-${value}">${label}</span>`;
      }
      case "Pill": {
        const tone = normalizePillTone(attrs.tone);
        const cls = tone === "default" ? "pill" : `pill pill-${tone}`;
        return `<span class="${cls}">${children}</span>`;
      }
      case "Figure": {
        const caption = attrs.caption
          ? `<figcaption class="caption">${escapeHtml(attrs.caption)}</figcaption>`
          : "";
        return `<figure class="figure"><div class="figure-body">${children}</div>${caption}</figure>`;
      }
      case "FileRef":
        return `<code class="fileref">${children.trim() || escapeHtml(attrs.path ?? "")}</code>`;
      case "ComparisonTable":
        return `<div class="tablewrap">${children}</div>`;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        if (!meter) return children; // missing/non-numeric value → label as plain text
        const pct = Math.round((meter.value / meter.max) * 100);
        const cls = meter.tone === "default" ? "meter" : `meter meter-${meter.tone}`;
        return (
          `<div class="${cls}">` +
          `<span class="meter-label">${children}</span>` +
          `<span class="meter-bar"><span class="meter-fill" style="width:${pct}%"></span></span>` +
          `<span class="meter-value">${meter.value}/${meter.max}</span>` +
          `</div>`
        );
      }
      case "Diff": {
        const fence = firstCodeBlock(rawChildren);
        if (!fence) return children; // no fenced diff → fall back to the rendered body
        const rows = fence.code
          .split("\n")
          .map((line) => {
            const content = escapeHtml(line);
            return `<div class="diff-line diff-${diffLineClass(line)}">${content || "&nbsp;"}</div>`;
          })
          .join("");
        return `<div class="diff">${rows}</div>`;
      }
      case "FileTree":
        // Wrap-only: the rendered fence (a <pre><code>) is the tree; CSS gives it
        // the monospace box + guide styling.
        return `<div class="filetree">${children}</div>`;
      case "Checklist": {
        const items = parseChecklist(rawChildren);
        if (items.length === 0) return children; // no task list → render body as-is
        const rows = items
          .map((it) => {
            const state = it.checked ? "done" : "todo";
            const mark = it.checked ? "✓" : "✗";
            return (
              `<li class="check-item check-${state}">` +
              `<span class="check-mark">${mark}</span> ${renderInline(it.text)}</li>`
            );
          })
          .join("");
        return `<ul class="checklist">${rows}</ul>`;
      }
    }
  },
  text: (lines) => lines.map(renderInline).join("\n"),
};

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

const BLOCK_TAG = "(?:h[2-6]|blockquote|ul|ol|hr|table|thead|tbody|tr|pre|p)";
const NL_BEFORE_BLOCK = new RegExp(`\\n+(</?${BLOCK_TAG}[>\\s])`, "g");
const NL_AFTER_BLOCK = new RegExp(`(</${BLOCK_TAG}>|<hr>)\\n+`, "g");

/** Collapse excess blank lines, especially around block-level elements. */
function collapseBlockSpacing(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(NL_BEFORE_BLOCK, "\n$1")
    .replace(NL_AFTER_BLOCK, "$1\n");
}
