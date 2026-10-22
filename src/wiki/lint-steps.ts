/**
 * Lint check 22 `steps-focus` — a `<Steps>` step that names a focus id its
 * diagram file does not define. Page text only (`checkPageText`, so
 * `wiki-check` reports it), over the files `loadPageFiles` read for the page.
 *
 * A step's focus ids are `stepItemFocus`'s (the code spans that end the item's
 * last paragraph);
 * with no list, the steps are the file's `meta.views` and their `focus`. A
 * file's ids are its nodes' (`diagramNodeIds`: architecture `components`,
 * workflow `nodes`, lifecycle `states`). A file that did not load, is not a
 * JSON object or defines no nodes is check 21's finding (`diagram-svg`), not
 * this one's.
 *
 * One warning per step that names any unknown id, on the item's own line as
 * the parser recorded it (`listItemLines`), else on the tag's line.
 */

import { diagramNodeIds, readDiagram } from "../format/diagram-block.ts";
import { diagramFlavor } from "../format/query-block.ts";
import { listItemLines, parseBlocks, type Block } from "../format/markdown-ast.ts";
import { stepItemFocus } from "../format/steps-focus.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import type { LintFinding } from "./lint.ts";

export const STEPS_LINT_CHECKS = ["steps-focus"] as const;

export function checkSteps(page: { relPath: string }, rawContent: string, files: LoadedPageFiles | undefined): LintFinding[] {
  if (!files || !rawContent.includes("<Steps")) return [];
  const body = splitFrontmatter(rawContent).body;
  const offset = rawContent.slice(0, rawContent.length - body.length).split("\n").length - 1;
  const findings: LintFinding[] = [];

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
      // No nodes at all is check 21's finding; every step would be blamed here.
      if (!known?.size) continue;
      const items = b.children.flatMap((c) => {
        if (c.type !== "ul" && c.type !== "ol") return [];
        const at = listItemLines(c);
        return c.items.map((text, k) => ({ focus: stepItemFocus(text, c.nested?.[k]), line: at?.[k]?.[0] }));
      });
      const steps = items.length ? items : (readDiagram(flavor, result.text)?.views ?? []).map((v) => ({ focus: v.focus, line: undefined }));
      const tagLine = b.line === undefined ? undefined : b.line + offset;
      steps.forEach(({ focus, line: itemLine }, k) => {
        const unknown = focus.filter((id) => !known.has(id));
        if (!unknown.length) return;
        const at = itemLine === undefined ? tagLine : itemLine + offset;
        const line = at === undefined ? undefined : at + 1;
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
