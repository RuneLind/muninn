/**
 * `<Steps src="./x.lifecycle.json">` in the reader: the same archify picture a
 * `<Diagram>` draws (`diagramFigureHtml`, without its view buttons), Prev,
 * Next, Play and Show all, and the steps as a list. A step's focus ids dim the
 * picture by archify's guided-view rule (`wiki-visuals.ts`).
 *
 * Where the steps come from:
 * - **An authored list.** Every item of every list directly in the block is a
 *   step, numbered on through the lists; its focus ids are `stepFocusOf`'s
 *   (`steps-focus.ts`: the code spans that end the item).
 * - **No list** (the tag self-closed, or a body without one): the file's
 *   `meta.views`, each view one step, listed by the reader alone.
 *
 * Pure: imported by the reader's render (`views: true`) only, through the
 * `stepsView` option of `formatWebHtml`, so the chat bundle never carries it.
 */
import { escapeHtml } from "./markdown-core.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";
import { diagramFigureHtml, readDiagram, type DiagramViewInput } from "./diagram-block.ts";
import { diagramFlavor, pageFileName } from "./query-block.ts";
import { stepItemOpen, stepsPosText } from "./steps-focus.ts";

export interface StepsViewInput extends DiagramViewInput {
  /** The block's body as rendered, its authored steps as `li.stp-step`. */
  bodyHtml: string;
  /** How many authored steps the body holds; 0 ⇒ the steps are the views. */
  authored: number;
}

export type StepsViewRenderer = (input: StepsViewInput) => string;

/** The block's reader chrome; a peek strips it (`PEEK_STEPS_CHROME`). */
export const STEPS_CHROME_CLASSES = ["stp-ctrl"] as const;

const RO = READER_ONLY_ATTR;

/** The reader's `<Steps>`. */
export const stepsViewHtml: StepsViewRenderer = (input) => {
  const flavor = diagramFlavor(input.ref);
  const read = flavor ? readDiagram(flavor, input.text) : null;
  const figure = diagramFigureHtml(input, false);
  if (!read) return `<section class="stp">${figure}${input.bodyHtml}</section>`;
  let count = input.authored;
  let list = input.bodyHtml;
  if (count === 0 && read.views.length) {
    count = read.views.length;
    list +=
      `<ol class="stp-list stp-derived" ${RO}>` +
      read.views
        .map(
          (v, i) =>
            stepItemOpen(i, v.focus, "") +
            `<strong>${escapeHtml(v.label)}</strong>${v.note ? ` — ${escapeHtml(v.note)}` : ""}</li>`,
        )
        .join("") +
      `</ol>`;
  }
  const label = read.title || pageFileName(input.ref);
  const drawn = !!input.svg?.svg;
  const ctrl =
    drawn && count > 0
      ? `<div class="stp-ctrl" role="toolbar" aria-label="${escapeHtml(`Steps: ${label}`)}" ${RO}>` +
        `<button type="button" class="stp-btn" data-stp-act="prev"><span aria-hidden="true">← </span>Prev</button>` +
        `<button type="button" class="stp-btn" data-stp-act="next">Next<span aria-hidden="true"> →</span></button>` +
        `<button type="button" class="stp-btn" data-stp-act="play" aria-pressed="false"><span aria-hidden="true">▶ </span>Play</button>` +
        `<button type="button" class="stp-btn" data-stp-act="all" aria-pressed="true">Show all</button>` +
        `<span class="stp-pos" aria-live="polite">${stepsPosText(-1, count)}</span>` +
        `</div>`
      : "";
  return `<section class="stp" data-stp-count="${count}" data-stp-cur="-1">${figure}${ctrl}${list}</section>`;
};

/** The reader's `<Steps>` CSS (the picture's is `diagramCss`). */
export function stepsCss(scope: string): string {
  return `
    ${scope} .stp { margin: 0.8rem 0 1rem; }
    ${scope} .stp > figure.dgm { margin-bottom: 0.4rem; }
    ${scope} .stp-ctrl { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0 0 0.4rem; }
    ${scope} .stp-btn {
      font: inherit; font-size: 0.85em; padding: 0.2rem 0.65rem; cursor: pointer; border-radius: 6px;
      color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--text-muted);
    }
    ${scope} .stp-btn[aria-pressed="true"] { background: var(--accent-hover); border-color: var(--accent-hover); color: #fff; }
    ${scope} .stp-btn:focus-visible { outline: 2px solid var(--accent-light); outline-offset: 1px; }
    ${scope} .stp-pos { font-size: 0.85em; color: var(--text-soft); margin-left: 0.3rem; }
    ${scope} .stp-step { border-radius: 4px; padding: 0.05rem 0.3rem; }
    ${scope} .stp-step.stp-cur { background: var(--bg-surface); box-shadow: inset 3px 0 0 var(--accent-light); }
    ${scope} .stp-list.stp-derived { margin-top: 0.3rem; }
    @media print { ${scope} .stp-ctrl { display: none; } }
    @media (forced-colors: active) {
      ${scope} .stp-btn[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
      ${scope} .stp-step.stp-cur { outline: 2px solid Highlight; }
    }
  `;
}
