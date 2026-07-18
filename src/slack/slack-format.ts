import {
  parseBlocks,
  scanInlineComponents,
  normalizeVerdictValue,
  parseMeterAttrs,
  parseChecklist,
} from "../format/markdown-ast.ts";
import { renderBlocks, type BlockRenderer } from "../format/block-renderer.ts";
import { Placeholders } from "../format/markdown-core.ts";

/**
 * Converts Claude's markdown output to Slack mrkdwn.
 * Walks the shared block AST via `renderBlocks`; tables become labeled bullet
 * lists and inline content runs through `renderInline` (which also accepts a
 * few HTML tags Claude occasionally emits and converts them to mrkdwn).
 */
export function formatSlackMrkdwn(text: string): string {
  const rendered = renderBlocks(parseBlocks(text), slackRenderer);
  return rendered
    .replace(/^[•\-\*]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const slackRenderer: BlockRenderer = {
  code_block: (block) => "```\n" + block.code + "\n```",
  hr: () => "",
  heading: (block) => `*${renderInline(block.content)}*`,
  blockquote: (lines) => lines.map((l) => `> ${renderInline(l)}`).join("\n"),
  ul: (items) => items.map((i) => `- ${renderInline(i)}`).join("\n"),
  ol: (items) => items.map((i, idx) => `${idx + 1}. ${renderInline(i)}`).join("\n"),
  table: (headers, rows) => renderTable(headers, rows),
  component(name, attrs, children, rawChildren) {
    switch (name) {
      case "Callout":
        return attrs.title ? `*${renderInline(attrs.title)}*\n${children}` : children;
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = children.trim() || (value === "yes" ? "Yes" : "No");
        return `${value === "yes" ? "✅" : "❌"} ${label}`;
      }
      case "Pill":
        return `[${children.trim()}]`;
      case "Figure":
        return attrs.caption ? `${children}\n${renderInline(attrs.caption)}` : children;
      case "FileRef":
        return children.trim() || renderInline(attrs.path ?? "");
      case "ComparisonTable":
        return children;
      case "Meter": {
        const meter = parseMeterAttrs(attrs);
        if (!meter) return children; // missing/non-numeric value → label as plain text
        return `${children}: ${meter.value}/${meter.max}`;
      }
      case "Diff":
        return children; // fence-as-is: Slack already renders the ``` code block
      case "FileTree":
        return children; // fence-as-is: the indented-path fence renders verbatim
      case "Checklist": {
        const items = parseChecklist(rawChildren);
        if (items.length === 0) return children;
        return items.map((it) => `${it.checked ? "☑" : "☐"} ${renderInline(it.text)}`).join("\n");
      }
      case "AnnotatedCode":
        // file line + fence + annotation paragraphs (already in children).
        return attrs.file ? `*${renderInline(attrs.file)}*\n${children}` : children;
      case "CodeTabs":
        // Each Tab child already rendered itself as a `— label —` section.
        return children;
      case "Tab":
        return attrs.label ? `— ${renderInline(attrs.label)} —\n${children}` : children;
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  inlineComponent(name, attrs, text) {
    switch (name) {
      case "Verdict": {
        const value = normalizeVerdictValue(attrs.value);
        const label = text.trim() || (value === "yes" ? "Yes" : "No");
        return `${value === "yes" ? "✅" : "❌"} ${label}`;
      }
      case "Pill":
        return `[${text.trim()}]`;
      default: {
        const _exhaustive: never = name;
        return _exhaustive;
      }
    }
  },
  text: (lines) => lines.map(renderInline).join("\n"),
};

/**
 * Tables become labeled bullet lists for Slack.
 *   • *Header1:* val1  *Header2:* val2
 * Single-column tables use simple bullets (• val).
 */
function renderTable(headers: string[], rows: string[][]): string {
  const renderedHeaders = headers.map(renderInline);
  const lines: string[] = [];
  for (const row of rows) {
    if (headers.length === 1) {
      const val = renderInline(row[0] ?? "");
      if (val) lines.push(`• ${val}`);
      continue;
    }
    const parts: string[] = [];
    for (let c = 0; c < headers.length; c++) {
      const val = renderInline(row[c] ?? "");
      if (val) parts.push(`*${renderedHeaders[c]!}:* ${val}`);
    }
    if (parts.length > 0) lines.push(`• ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

function renderInline(text: string): string {
  const ph = new Placeholders();

  // Inline code FIRST — park it before the component scan so a complete
  // component tag inside backticks stays literal code (backticked) instead of
  // being interpreted. The parked sentinel carries no `<`, shielding the code
  // content from the scan below and from the trailing tag-strip.
  let result = text.replace(/`([^`]+)`/g, (_m, code: string) =>
    ph.add("INLINE", `\`${code}\``),
  );

  // Inline components (Verdict, Pill) on the code-shielded text: substitute each
  // occurrence with its plain-text fallback (✅/❌ + label, or [label]) directly
  // into the string. No parking needed — the fallback is plain mrkdwn, so the
  // label rides through the passes below (the trailing tag-strip neutralizes any
  // tag in the label text).
  result = scanInlineComponents(result)
    .map((seg) =>
      seg.kind === "text" ? seg.text : slackRenderer.inlineComponent(seg.name, seg.attrs, seg.text),
    )
    .join("");

  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Claude occasionally emits raw HTML tags; convert the recognised ones to
  // mrkdwn before the catch-all strip below removes them.
  result = result.replace(/<b>(.*?)<\/b>/g, "*$1*");
  result = result.replace(/<i>(.*?)<\/i>/g, "_$1_");
  result = result.replace(/<s>(.*?)<\/s>/g, "~$1~");
  result = result.replace(/<code>(.*?)<\/code>/g, "`$1`");
  result = result.replace(/<a href="([^"]+)">(.*?)<\/a>/g, "<$1|$2>");

  // Park Slack-style links so the next pass doesn't strip them.
  result = result.replace(/<(https?:\/\/[^>|]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
    ph.add("LINK", `<${url}|${label}>`),
  );
  result = result.replace(/<(https?:\/\/[^>]+)>/g, (_m, url: string) =>
    ph.add("LINK", `<${url}>`),
  );

  result = result.replace(/<\/?[^>]+>/g, "");

  return ph.restore(result);
}
