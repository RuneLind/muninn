/**
 * Lint check `diagram-svg` — what a `<Diagram>` lost on the way to the
 * reader. Page text only (`checkPageText`, so `wiki-check` reports it), over
 * the files `loadPageFiles` read for the page. One warning per diagram for
 * each finding in {@link DIAGRAM_FINDINGS}:
 *
 * - the diagram file did not load (missing, unreadable, over its cap, not a
 *   diagram file, past the page's limits): the reader shows one line;
 * - the JSON file is not a JSON object: the reader shows one line;
 * - the HTML sibling is missing, unparsable (not exactly one `<svg>`), holds
 *   the reserved id text `__dgm-id__`, is over its 2 MB cap or over the page
 *   budget: the reader shows the text form;
 * - two diagram files of different kinds share one HTML sibling: archify
 *   writes one picture per file, so both blocks draw the same picture, which
 *   matches at most one of them;
 * - the sanitizer dropped an element or attribute it has no rule for (a drop
 *   by design, such as `tabindex` or `data-preset`, is not reported);
 * - the SVG carries an archify class the reader's stylesheet does not map
 *   (`DIAGRAM_CLASSES`): that part draws unstyled.
 *
 * Check 15 judges the tag's attributes only; a file that did not load is this
 * check's finding.
 */

import { readDiagram } from "../format/diagram-block.ts";
import {
  diagramFlavor,
  diagramSiblingHtml,
  diagramSiblingRelPath,
  PAGE_FILE_MAX_BYTES,
  PAGE_FILE_MAX_PER_PAGE,
  pageFileRefKinds,
  DIAGRAM_ID_MARK,
  type DiagramFlavor,
  type PageFileFailure,
} from "../format/query-block.ts";
import { parseBlocks } from "../format/markdown-ast.ts";
import { fencedLineMask } from "../dashboard/views/components/wiki-integrate.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LoadedPageFiles } from "./lint-components.ts";
import type { LintFinding } from "./lint.ts";

export const DIAGRAM_LINT_CHECKS = ["diagram-svg"] as const;

const ONE_LINE = "the reader shows one line instead of the diagram";
const TEXT_FORM = "the reader shows the text form";

/** Every `diagram-svg` finding's text, after `<Diagram src="…">`. */
export const DIAGRAM_FINDINGS = {
  file: {
    unavailable: `file is missing or unreadable; ${ONE_LINE}`,
    invalid: `file path is not a relative wiki path; ${ONE_LINE}`,
    extension: `file is not a diagram file (.architecture.json, .workflow.json, .lifecycle.json); ${ONE_LINE}`,
    "too-large": `file is over its ${PAGE_FILE_MAX_BYTES / 1024 / 1024} MB cap; ${ONE_LINE}`,
    limit: `file is past the page's ${PAGE_FILE_MAX_PER_PAGE}-file limit; ${ONE_LINE}`,
    budget: `file is over the page's file budget; ${ONE_LINE}`,
  } satisfies Record<PageFileFailure, string>,
  notObject: `is not a JSON object; ${ONE_LINE}`,
  sharedPicture: (html: string, others: string) =>
    `shares picture ${html} with ${others}; archify writes one picture per diagram file, so these blocks show the same drawing`,
  picture: {
    missing: (html: string) => `picture ${html} is missing; ${TEXT_FORM}`,
    unparsable: (html: string) => `picture ${html} does not hold exactly one <svg>; ${TEXT_FORM}`,
    "id-mark": (html: string) => `picture ${html} contains the reserved text ${DIAGRAM_ID_MARK}, which the reader uses for its own ids; ${TEXT_FORM}`,
    "too-large": (html: string) => `picture ${html} is over its 2 MB cap; ${TEXT_FORM}`,
    budget: (html: string) => `picture ${html} is over the page's file budget; ${TEXT_FORM}`,
  },
  unknownElements: (names: string) => `picture had elements the reader drops: ${names}`,
  unknownAttrs: (names: string) => `picture had attributes the reader drops: ${names}`,
  unknownClasses: (names: string) => `picture has classes the reader does not style: ${names}`,
} as const;

/** At most this many names per list in one message. */
const LIST_MAX = 8;

const list = (xs: readonly string[]): string =>
  xs.length <= LIST_MAX ? xs.join(", ") : `${xs.slice(0, LIST_MAX).join(", ")} and ${xs.length - LIST_MAX} more`;

export function checkDiagrams(page: { relPath: string }, rawContent: string, files: LoadedPageFiles | undefined): LintFinding[] {
  if (!files || !rawContent.includes("<Diagram")) return [];
  const lines = rawContent.split("\n");
  const fenced = fencedLineMask(lines);
  // The ref as a whole quoted value first, so `x.architecture.json` does not
  // land on the line of `./x.architecture.json`.
  const lineOf = (ref: string): number | undefined => {
    const on = (has: (l: string) => boolean) => lines.findIndex((l, n) => !fenced[n] && l.includes("<Diagram") && has(l));
    let i = on((l) => l.includes(`"${ref}"`) || l.includes(`'${ref}'`));
    if (i < 0) i = on((l) => l.includes(ref));
    return i < 0 ? undefined : i + 1;
  };
  const findings: LintFinding[] = [];
  const refs = [...pageFileRefKinds(parseBlocks(splitFrontmatter(rawContent).body))].filter(([, kinds]) => kinds.has("diagram"));
  // The refs of each HTML sibling, to find two kinds sharing one picture.
  const bySibling = new Map<string, { ref: string; flavor: DiagramFlavor }[]>();
  for (const [ref] of refs) {
    const rel = diagramSiblingRelPath(page.relPath, ref);
    const flavor = diagramFlavor(ref);
    if (rel === null || !flavor) continue;
    bySibling.set(rel, [...(bySibling.get(rel) ?? []), { ref, flavor }]);
  }
  // The refs a `<Diagram>` names, as the loader collected them.
  for (const [ref] of refs) {
    const result = files.get(ref);
    if (!result) continue;
    const at = lineOf(ref);
    const push = (message: string) =>
      findings.push({ check: "diagram-svg", relPath: page.relPath, message: `<Diagram src="${ref}"> ${message}`, ...(at === undefined ? {} : { line: at }) });
    if (!result.ok) {
      push(DIAGRAM_FINDINGS.file[result.reason]);
      continue;
    }
    const flavor = diagramFlavor(ref);
    if (!flavor) continue;
    if (!readDiagram(flavor, result.text)) push(DIAGRAM_FINDINGS.notObject);
    const rel = diagramSiblingRelPath(page.relPath, ref);
    const sharers = rel === null ? [] : (bySibling.get(rel) ?? []);
    if (new Set(sharers.map((s) => s.flavor)).size > 1) {
      const others = sharers.filter((s) => s.flavor !== flavor).map((s) => `<Diagram src="${s.ref}">`);
      push(DIAGRAM_FINDINGS.sharedPicture(diagramSiblingHtml(ref) ?? ref, others.join(", ")));
    }
    const svg = result.svg;
    if (!svg) continue;
    if (svg.problem) {
      push(DIAGRAM_FINDINGS.picture[svg.problem](diagramSiblingHtml(ref) ?? ref));
      continue;
    }
    if (svg.unknownElements.length) push(DIAGRAM_FINDINGS.unknownElements(list(svg.unknownElements)));
    if (svg.unknownAttrs.length) push(DIAGRAM_FINDINGS.unknownAttrs(list(svg.unknownAttrs)));
    if (svg.unknownClasses.length) push(DIAGRAM_FINDINGS.unknownClasses(list(svg.unknownClasses)));
  }
  return findings;
}
