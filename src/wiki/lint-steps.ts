/**
 * Lint check 22 `steps-focus` — a `<Steps>` step that names a focus id its
 * diagram file does not define. Page text only (`checkPageText`, so
 * `wiki-check` reports it), over the files `loadPageFiles` read for the page.
 *
 * A step's focus ids are `stepFocusOf`'s (the code spans that end the item);
 * with no list, the steps are the file's `meta.views` and their `focus`. A
 * file's ids are its nodes' (`diagramNodeIds`: architecture `components`,
 * workflow `nodes`, lifecycle `states`). A file that did not load or is not a
 * JSON object is check 21's finding (`diagram-svg`), not this one's.
 *
 * One warning per step that names any unknown id, on the item's own line when
 * the block's list items can be counted off the source (column-0 to 3-space
 * `-`, `*`, `N.` or `N)` lines between the tag and `</Steps>`, outside fences),
 * else on the tag's line.
 */

import { diagramNodeIds, readDiagram } from "../format/diagram-block.ts";
import { diagramFlavor } from "../format/query-block.ts";
import { parseBlocks, type Block } from "../format/markdown-ast.ts";
import { stepFocusOf } from "../format/steps-focus.ts";
import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import type { LintFinding } from "./lint.ts";

export const STEPS_LINT_CHECKS = ["steps-focus"] as const;

const ITEM_LINE = /^ {0,3}(?:[-*]|\d{1,9}[.)])(?:\s|$)/;

export function checkSteps(page: { relPath: string }, rawContent: string, files: LoadedPageFiles | undefined): LintFinding[] {
  if (!files || !rawContent.includes("<Steps")) return [];
  const body = splitFrontmatter(rawContent).body;
  const offset = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  const findings: LintFinding[] = [];

  /** The source lines (0-based) of the block's top-level items, or null when they do not count up. */
  const itemLines = (tagLine: number, expected: number): number[] | null => {
    const out: number[] = [];
    for (let n = tagLine + 1; n < lines.length; n++) {
      if (fenced[n]) continue;
      if (lines[n]!.trim() === "</Steps>") break;
      if (ITEM_LINE.test(lines[n]!)) out.push(n);
    }
    return out.length === expected ? out : null;
  };

  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type !== "component") continue;
      walk(b.children);
      if (b.name !== "Steps") continue;
      const ref = (b.attrs.src ?? "").trim();
      const result = ref ? files.get(ref) : undefined;
      const flavor = diagramFlavor(ref);
      if (!result?.ok || !flavor) continue;
      const known = diagramNodeIds(flavor, result.text);
      if (!known) continue;
      const items = b.children.flatMap((c) => (c.type === "ul" || c.type === "ol" ? c.items : []));
      const steps = items.length ? items.map(stepFocusOf) : (readDiagram(flavor, result.text)?.views ?? []).map((v) => v.focus);
      const tagLine = b.line === undefined ? undefined : b.line + offset;
      const at = items.length && tagLine !== undefined ? itemLines(tagLine, items.length) : null;
      steps.forEach((focus, k) => {
        const unknown = focus.filter((id) => !known.has(id));
        if (!unknown.length) return;
        const line = at ? at[k]! + 1 : tagLine === undefined ? undefined : tagLine + 1;
        const what = items.length ? `step ${k + 1}` : `view ${k + 1}`;
        findings.push({
          check: "steps-focus",
          relPath: page.relPath,
          message: `<Steps src="${ref}"> ${what} names ${unknown.length === 1 ? "a focus id" : "focus ids"} the diagram does not define: ${unknown.join(", ")}; the picture has no node to light for ${unknown.length === 1 ? "it" : "them"}`,
          ...(line === undefined ? {} : { line }),
        });
      });
    }
  };
  walk(parseBlocks(body));
  return findings;
}
