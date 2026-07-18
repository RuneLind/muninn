import type { Block, ComponentName, InlineComponentName } from "./markdown-ast.ts";

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
  /** Render a component block. `renderedChildren` is the component body already
   *  walked through this same renderer, so most components only wrap/decorate it.
   *  `rawChildren` is the same body as un-rendered `Block[]` — the pre-render
   *  structure a few components must introspect (a Diff's fence lines, a
   *  Checklist's `[x]`/`[ ]` markers, a CodeTabs' `<Tab>` children) that the
   *  rendered string has already flattened past. Components that don't need it
   *  simply omit the fourth parameter — a narrower implementation still satisfies
   *  this wider signature. */
  component(
    name: ComponentName,
    attrs: Record<string, string>,
    renderedChildren: string,
    rawChildren: Block[],
  ): string;
  /** Render an INLINE component (Verdict, Pill) embedded mid-text — a distinct
   *  seam from the block `component` method above. `text` is the raw inner text
   *  of the tag (empty for a self-closing occurrence); the platform emits its
   *  inline representation (a chip on web, a plain ✅/`[…]` fallback elsewhere).
   *  Called directly by each platform's `renderInline`, not via `renderBlocks`;
   *  living on the interface is what forces every platform to implement it. */
  inlineComponent(name: InlineComponentName, attrs: Record<string, string>, text: string): string;
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
    case "component":
      return r.component(block.name, block.attrs, renderBlocks(block.children, r), block.children);
    case "text":
      return r.text(block.lines);
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}
