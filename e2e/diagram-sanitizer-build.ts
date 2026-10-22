/**
 * Builds the Chromium cases for `e2e/wiki-diagram-sanitizer.spec.ts` under Bun
 * (the sanitizer runs on Bun's `HTMLRewriter`, which the Playwright runner does
 * not have): every case of `src/test/diagram-svg-space.ts`, rendered by the
 * reader's own `renderWikiHtml` with each slice sanitized by
 * `diagramSvgFromHtml`, written as JSON to the path in argv[2].
 *
 * Each picture's expected tree is the sanitizer's output read under the model it
 * writes in (`readSanitizedTree`), after the two string transforms the renderer
 * documents (`diagramViewHtml`: line breaks to a space, the id mark to `dgm<n>-`).
 *
 *   bun e2e/diagram-sanitizer-build.ts <out.json>
 */
import { diagramSvgFromHtml, DIAGRAM_ID_MARK } from "../src/wiki/diagram-svg.ts";
import { renderWikiHtml } from "../src/wiki/render.ts";
import { diagramRef, diagramSpaceCases, readSanitizedTree, type SvgNode } from "../src/test/diagram-svg-space.ts";
import type { PageFileResult } from "../src/format/query-block.ts";

export interface BuiltCase {
  id: string;
  dim: string;
  html: string;
  /** One entry per slice: its expected tree, or null when the sanitizer drew nothing. */
  pictures: (SvgNode | null)[];
  mustShow: string[];
  /** The sanitizer's output did not read under its own model (a failure in itself). */
  unreadable?: string;
}

const JSON_TEXT = JSON.stringify({ meta: { title: "T" }, components: [{ id: "a", label: "A" }] });

const out: BuiltCase[] = [];
for (const c of diagramSpaceCases()) {
  const files = new Map<string, PageFileResult>();
  const pictures: (SvgNode | null)[] = [];
  let unreadable: string | undefined;
  for (const [i, slice] of c.slices.entries()) {
    const svg = await diagramSvgFromHtml(`<!doctype html><html><body>${slice}</body></html>`);
    files.set(diagramRef(i), { ok: true, text: JSON_TEXT, svg });
    if (svg.svg === null) {
      pictures.push(null);
      continue;
    }
    try {
      pictures.push(readSanitizedTree(svg.svg.replace(/\s*\n\s*/g, " ").replaceAll(DIAGRAM_ID_MARK, `dgm${i + 1}-`)));
    } catch (e) {
      unreadable = `slice ${i}: ${(e as Error).message}`;
      pictures.push(null);
    }
  }
  const html = renderWikiHtml(c.body, () => undefined, { views: true, files });
  out.push({ id: c.id, dim: c.dim, html, pictures, mustShow: c.mustShow, ...(unreadable ? { unreadable } : {}) });
}
await Bun.write(process.argv[2]!, JSON.stringify(out));
console.log(`built ${out.length} cases`);
