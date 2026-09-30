/// <reference lib="dom" />
/**
 * Reader chrome for two report blocks, derived from the RENDERED article:
 *
 *  - `↻ N historic` — a pill in the header's meta row, beside the status chip,
 *    counting the page's `<Historic>` sections (`section.historic`); a click
 *    opens any closed `<details>` around the first one and scrolls to it.
 *  - `line refs` — a toggle, shown only on a page with a pure ref group
 *    (`span.code-ref-group`, emitted by `src/wiki/code-refs.ts`), that hides
 *    those groups with one class on `.wiki-article`. A chip outside a group is
 *    never hidden, so hiding cannot delete prose. The choice is per viewer, in
 *    localStorage; default on.
 *
 * Runs at the article render site only, after the article HTML is in place.
 * Idempotent: a re-run removes its own controls before adding them again.
 */

import { CODE_REF_CLASS, CODE_REF_GROUP_CLASS, CODE_REF_LINK_CLASS } from "../../../wiki/code-refs.ts";

export { CODE_REF_CLASS, CODE_REF_GROUP_CLASS, CODE_REF_LINK_CLASS };
export const LINE_REFS_KEY = "muninn.wiki.lineRefs.v1";
export const CODE_REFS_OFF_CLASS = "code-refs-off";
export const HISTORIC_PILL_CLASS = "wiki-historic-pill";
export const LINE_REFS_TOGGLE_CLASS = "wiki-lineref-toggle";

export function historicPillLabel(n: number): string {
  return `↻ ${n} historic`;
}

/** Whether chips are shown. Any storage failure (private window, blocked site
 *  data) reads as the default, on. */
export function readLineRefsOn(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(LINE_REFS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeLineRefsOn(storage: Pick<Storage, "setItem"> | undefined, on: boolean): void {
  try {
    storage?.setItem(LINE_REFS_KEY, on ? "on" : "off");
  } catch {
    /* the toggle still works for this page view */
  }
}

function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function enhanceReportBlocks(wrap: ParentNode): void {
  const article = wrap.querySelector<HTMLElement>(".wiki-article");
  const row = wrap.querySelector<HTMLElement>(".wiki-article-head .wiki-meta-row");
  if (!article || !row) return;
  row.querySelectorAll(`.${HISTORIC_PILL_CLASS}, .${LINE_REFS_TOGGLE_CLASS}`).forEach((el) => el.remove());

  const historic = article.querySelectorAll<HTMLElement>("section.historic");
  if (historic.length > 0) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = HISTORIC_PILL_CLASS;
    pill.textContent = historicPillLabel(historic.length);
    pill.title = "Jump to the first historic section";
    pill.addEventListener("click", () => {
      const first = historic[0]!;
      // A Historic inside a closed Fold has no box to scroll to.
      for (let el = first.parentElement; el && el !== article; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement) el.open = true;
      }
      first.scrollIntoView({ block: "start" });
    });
    // Beside the status chip: after the last badge/status/flag in the row.
    const anchors = row.querySelectorAll(".wiki-badge, .wiki-status, .wiki-followup-flag");
    const after = anchors[anchors.length - 1];
    if (after) after.after(pill);
    else row.prepend(pill);
  }

  if (article.querySelector(`span.${CODE_REF_GROUP_CLASS}`)) {
    let on = readLineRefsOn(localStore());
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = LINE_REFS_TOGGLE_CLASS;
    toggle.textContent = "line refs";
    toggle.title = "Show or hide the parenthesised code line references";
    const apply = () => {
      article.classList.toggle(CODE_REFS_OFF_CLASS, !on);
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
    };
    toggle.addEventListener("click", () => {
      on = !on;
      writeLineRefsOn(localStore(), on);
      apply();
    });
    apply();
    row.appendChild(toggle);
  } else {
    article.classList.remove(CODE_REFS_OFF_CLASS);
  }
}
