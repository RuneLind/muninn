import type { Block, ComponentName, InlineComponentName, ListBlock } from "./markdown-ast.ts";

/** What sits under one list item, already rendered by the same renderer: a
 *  child list one `depth` deeper, or a fenced code block. */
export interface RenderedChild {
  kind: "list" | "code";
  out: string;
}

/** A list's nesting, handed to `ul`/`ol` beside its items. `children[k]` is
 *  what sits under `items[k]`, in source order; `depth` is 0 for a top-level
 *  list; `loose` is set when a blank line separated items in the source. */
export interface ListNest {
  children: (RenderedChild[] | undefined)[];
  depth: number;
  loose: boolean;
  /** Ordered lists: an item's own number where it does not count on from the
   *  item before (`OlBlock.values`). */
  values?: (number | undefined)[];
}

/** The number each of `count` ordered items shows: `values[k]` where set, else
 *  one past the item before, the first counting from `start`. */
export function ordinals(start: number, count: number, values?: (number | undefined)[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(values?.[k] ?? (k === 0 ? start : out[k - 1]! + 1));
  return out;
}

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
  /** An item's text may hold `\n`-joined continuation lines. */
  ul(items: string[], nest: ListNest): string;
  /** `start` is the list's first ordinal (from the source markdown) — a list
   *  split across paragraphs must not restart at 1 on every fragment. */
  ol(items: string[], start: number, nest: ListNest): string;
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
    case "ol":
      return renderList(block, r, 0);
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

function renderList(list: ListBlock, r: BlockRenderer, depth: number): string {
  const nest: ListNest = {
    children: list.items.map((_, k) =>
      list.nested?.[k]?.map((c): RenderedChild =>
        c.type === "code_block"
          ? { kind: "code", out: r.code_block(c) }
          : { kind: "list", out: renderList(c, r, depth + 1) },
      ),
    ),
    depth,
    loose: list.loose === true,
    ...(list.type === "ol" && list.values ? { values: list.values } : {}),
  };
  return list.type === "ul" ? r.ul(list.items, nest) : r.ol(list.items, list.start, nest);
}

/**
 * List items as plain-text lines — the Telegram/Slack rendering, which have no
 * list markup. Each item is `marker text`, a continuation line hanging under the
 * text, and a child list indented two spaces; code is not indented (the fence
 * or `<pre>` would carry the spaces into the code). A loose list keeps a blank
 * line between items.
 */
export function textListItems(
  markers: string[],
  items: string[],
  nest: ListNest,
  inline: (s: string) => string,
): string {
  return items
    .map((item, k) => {
      const marker = markers[k]!;
      const hang = " ".repeat(marker.length + 1);
      const [head, ...rest] = item.split("\n");
      let out = `${marker} ${inline(head!)}`;
      for (const line of rest) out += `\n${hang}${inline(line)}`;
      for (const c of nest.children[k] ?? []) out += "\n" + (c.kind === "list" ? c.out.replace(/^(?=.)/gm, "  ") : c.out);
      return out;
    })
    .join(nest.loose ? "\n\n" : "\n");
}
