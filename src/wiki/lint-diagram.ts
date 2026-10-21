/**
 * Lint check `diagram-svg` — what a `<Diagram>`'s picture lost on the way to
 * the reader. Page text only (`checkPageText`, so `wiki-check` reports it),
 * over the files `loadPageFiles` read for the page. One warning per diagram
 * for each of:
 *
 * - the HTML sibling is missing, unparsable (not exactly one `<svg>`), over
 *   its 2 MB cap or over the page budget: the reader shows the text form;
 * - the sanitizer dropped an element or attribute it has no rule for (a drop
 *   by design, such as `tabindex` or `data-preset`, is not reported);
 * - the SVG carries an archify class the reader's stylesheet does not map
 *   (`DIAGRAM_CLASSES`): that part draws unstyled;
 * - the JSON file is not a JSON object: the reader shows one line instead.
 *
 * A file that did not load at all is check 15's finding, not this one.
 */

import { readDiagram } from "../format/diagram-block.ts";
import { diagramFlavor, diagramSiblingHtml } from "../format/query-block.ts";
import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import type { LintFinding } from "./lint.ts";

export const DIAGRAM_LINT_CHECKS = ["diagram-svg"] as const;

const PROBLEM_TEXT = {
  missing: "is missing",
  unparsable: "does not hold exactly one <svg>",
  "too-large": "is over its 2 MB cap",
  budget: "is over the page's file budget",
} as const;

/** At most this many names per list in one message. */
const LIST_MAX = 8;

const list = (xs: readonly string[]): string =>
  xs.length <= LIST_MAX ? xs.join(", ") : `${xs.slice(0, LIST_MAX).join(", ")} and ${xs.length - LIST_MAX} more`;

export function checkDiagrams(page: { relPath: string }, rawContent: string, files: LoadedPageFiles | undefined): LintFinding[] {
  if (!files || !rawContent.includes("<Diagram")) return [];
  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  const lineOf = (ref: string): number | undefined => {
    const i = lines.findIndex((l, n) => !fenced[n] && l.includes("<Diagram") && l.includes(ref));
    return i < 0 ? undefined : i + 1;
  };
  const findings: LintFinding[] = [];
  for (const [ref, result] of files) {
    const flavor = diagramFlavor(ref);
    if (!flavor || !result.ok) continue;
    const at = lineOf(ref);
    const push = (message: string) =>
      findings.push({ check: "diagram-svg", relPath: page.relPath, message: `<Diagram src="${ref}"> ${message}`, ...(at === undefined ? {} : { line: at }) });
    if (!readDiagram(flavor, result.text)) push("is not a JSON object; the reader shows one line instead of the diagram");
    const svg = result.svg;
    if (!svg) continue;
    if (svg.problem) {
      push(`picture ${diagramSiblingHtml(ref)} ${PROBLEM_TEXT[svg.problem]}; the reader shows the text form`);
      continue;
    }
    if (svg.unknownElements.length) push(`picture had elements the reader drops: ${list(svg.unknownElements)}`);
    if (svg.unknownAttrs.length) push(`picture had attributes the reader drops: ${list(svg.unknownAttrs)}`);
    if (svg.unknownClasses.length) push(`picture has classes the reader does not style: ${list(svg.unknownClasses)}`);
  }
  return findings;
}
