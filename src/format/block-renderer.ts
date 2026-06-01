import type { Block } from "./markdown-ast.ts";

/**
 * Per-platform block rendering strategy. Each platform formatter (web HTML,
 * telegram HTML, slack mrkdwn) supplies one of these; {@link renderBlocks}
 * walks the shared `Block[]` and dispatches to it.
 *
 * This replaces three near-identical `switch (block.type)` walkers that had
 * drifted apart over time. Keeping the dispatch + exhaustiveness check in one
 * place means a new `Block` variant becomes a compile error in every platform
 * at once, instead of a case silently missing from one formatter.
 *
 * Inline content stays a raw string here — platforms differ too much on inline
 * rules (escape vs. tag-whitelist vs. mrkdwn) to share, so each method runs the
 * platform's own `renderInline` over the strings it receives.
 */
export interface BlockRenderer {
  code_block(block: { lang: string; code: string }): string;
  hr(): string;
  heading(block: { level: number; content: string }): string;
  blockquote(lines: string[]): string;
  ul(items: string[]): string;
  ol(items: string[]): string;
  table(headers: string[], rows: string[][]): string;
  text(lines: string[]): string;
}

/** Render a parsed block list with a platform's {@link BlockRenderer}, joining
 *  blocks with a single newline (platforms apply their own spacing cleanup). */
export function renderBlocks(blocks: Block[], r: BlockRenderer): string {
  return blocks.map((block) => renderBlock(block, r)).join("\n");
}

function renderBlock(block: Block, r: BlockRenderer): string {
  switch (block.type) {
    case "code_block":
      return r.code_block(block);
    case "hr":
      return r.hr();
    case "heading":
      return r.heading(block);
    case "blockquote":
      return r.blockquote(block.lines);
    case "ul":
      return r.ul(block.items);
    case "ol":
      return r.ol(block.items);
    case "table":
      return r.table(block.headers, block.rows);
    case "text":
      return r.text(block.lines);
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}
