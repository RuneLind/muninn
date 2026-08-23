/// <reference lib="dom" />
/**
 * Browser ENTRYPOINT for `/jira`, the read-only archive. Bundled by `Bun.build`
 * (see `jira-archive-client.ts`) and injected as an IIFE.
 *
 * **The page is already complete without it.** Every row, every verdict and the
 * rendered markdown are server-rendered, so this bundle owns exactly the two
 * things HTML cannot do: switch between the rendered and the raw view, and put
 * the raw markdown on the clipboard. A reader with no JavaScript sees the
 * rendered draft and, via the page's `<noscript>` rule, the raw pane below it —
 * which is the copy path too (select the text).
 *
 * The raw `<textarea>` IS the clipboard source: one copy of the bytes on the
 * page, so what is copied is provably what is shown.
 */

import {
  JA_COPY_ID,
  JA_COPY_LABEL,
  JA_PREVIEW_ID,
  JA_RAW_ID,
  JA_ROOT_ID,
  JA_VIEW_ATTR,
} from "./jira-archive-pure.ts";

/**
 * The pending «restore the label» timer.
 *
 * One per page, cancelled and replaced on every click: two copies two seconds
 * apart left the FIRST timer to fire under the second's «✓ Kopiert» and reset
 * the label while the second copy was still the freshest thing that happened.
 */
let restoreTimer: number | undefined;

function setView(view: string): void {
  const preview = document.getElementById(JA_PREVIEW_ID);
  const raw = document.getElementById(JA_RAW_ID);
  if (!preview || !raw) return;
  const showRaw = view === "markdown";
  preview.hidden = showRaw;
  raw.hidden = !showRaw;
  for (const btn of Array.from(document.querySelectorAll(`[${JA_VIEW_ATTR}]`))) {
    const on = btn.getAttribute(JA_VIEW_ATTR) === view;
    btn.classList.toggle("ja-tab-on", on);
    btn.setAttribute("aria-pressed", String(on));
  }
}

async function copyMarkdown(btn: HTMLElement): Promise<void> {
  const raw = document.getElementById(JA_RAW_ID) as HTMLTextAreaElement | null;
  if (!raw) return;
  const restore = () => {
    if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => {
      restoreTimer = undefined;
      btn.textContent = JA_COPY_LABEL;
    }, 2000);
  };
  try {
    await navigator.clipboard.writeText(raw.value);
    btn.textContent = "✓ Kopiert";
    restore();
  } catch {
    // No clipboard permission (or an insecure origin): show the reader the text
    // and select it, so the manual path is one keystroke rather than a dead
    // button that said nothing.
    setView("markdown");
    raw.focus();
    raw.select();
    btn.textContent = "Kopier selv (merket)";
    restore();
  }
}

function start(): void {
  const root = document.getElementById(JA_ROOT_ID);
  if (!root) return;
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const view = target.closest(`[${JA_VIEW_ATTR}]`);
    if (view) {
      setView(view.getAttribute(JA_VIEW_ATTR) ?? "preview");
      return;
    }
    const copy = target.closest(`#${JA_COPY_ID}`);
    if (copy) void copyMarkdown(copy as HTMLElement);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
