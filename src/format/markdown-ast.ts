/**
 * Block-level markdown lexer shared by all platform formatters.
 *
 * Each platform (web HTML, telegram HTML, slack mrkdwn) walks the same
 * `Block[]` and emits its target output. The lexer detects code blocks,
 * horizontal rules, headings, blockquotes, lists, and tables; everything
 * else lands in `text` blocks that the platform renders with its own
 * inline rules (bold, italic, strike, links, inline code).
 *
 * Inline content is preserved as raw strings — platforms differ enough on
 * inline rendering (Slack converts HTML tags, Telegram has a tag whitelist,
 * web HTML-escapes everything) that a shared inline AST would force every
 * platform through unwanted abstractions.
 */

export type Block =
  | { type: "code_block"; lang: string; code: string }
  | { type: "hr" }
  | { type: "heading"; level: number; content: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "text"; lines: string[] };

const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;
const CODE_PLACEHOLDER_RE = /^\x00CB(\d+)\x00$/;
const HR_RE = /^---+$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const normalized = text.replace(/\r\n/g, "\n");

  // Extract code blocks first; their content must not be parsed as markdown.
  const codeBlocks: { lang: string; code: string }[] = [];
  const protectedText = normalized.replace(CODE_BLOCK_RE, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, code: code.trimEnd() });
    return `\x00CB${idx}\x00`;
  });

  const lines = protectedText.split("\n");
  const blocks: Block[] = [];
  let textBuffer: string[] = [];
  let i = 0;

  function flushText() {
    if (textBuffer.length > 0) {
      blocks.push({ type: "text", lines: textBuffer });
      textBuffer = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    const cbMatch = line.match(CODE_PLACEHOLDER_RE);
    if (cbMatch) {
      flushText();
      const cb = codeBlocks[parseInt(cbMatch[1]!, 10)]!;
      blocks.push({ type: "code_block", lang: cb.lang, code: cb.code });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushText();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const hMatch = line.match(HEADING_RE);
    if (hMatch) {
      flushText();
      blocks.push({ type: "heading", level: hMatch[1]!.length, content: hMatch[2]! });
      i++;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      flushText();
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(BLOCKQUOTE_RE);
        if (!m) break;
        quoteLines.push(m[1]!);
        i++;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    if (UL_RE.test(line)) {
      flushText();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(UL_RE);
        if (!m) break;
        items.push(m[1]!);
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (OL_RE.test(line)) {
      flushText();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(OL_RE);
        if (!m) break;
        items.push(m[1]!);
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    if (isTableRow(line)) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && isTableRow(lines[j]!)) {
        tableLines.push(lines[j]!);
        j++;
      }
      if (tableLines.length >= 3 && isSeparatorRow(tableLines[1]!)) {
        flushText();
        const headers = parsePipeCells(tableLines[0]!).map((c) => c.trim());
        const rows = tableLines
          .slice(2)
          .filter((l) => !isSeparatorRow(l))
          .map((l) => parsePipeCells(l).map((c) => c.trim()));
        blocks.push({ type: "table", headers, rows });
        i = j;
        continue;
      }
    }

    textBuffer.push(line);
    i++;
  }
  flushText();

  return blocks;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parsePipeCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|");
}
