/// <reference lib="dom" />
/**
 * Done on a `<Lane kind="you">` step — the reader's half (mimir plan
 * muninn-wiki-first-screen-claims, PR 1; the route is `wiki-step-done.ts`).
 *
 * Each open list step in a counted `you` lane gets a quiet Done button. A click
 * previews the lines that go and the `log.md` entry; Remove in the preview
 * writes, and the page is then fetched and rendered again (`reload`), so the
 * next Done reads the new page and its new hash. There is no undo.
 *
 * Which rendered row is which step comes from `GET /api/wiki/step-done`: per
 * counted `you` lane, how many rows its lists hold and which row each open
 * step is. A lane whose rendered rows do not count the same gets no buttons.
 *
 * Gating: no fetch under the read slice or on a read-only wiki; the buttons
 * also sit in `WIKI_READONLY_BLOCKED_SELECTOR` (and so in the read slice's
 * hidden set). A wiki outside the close route's scope answers 404: no buttons.
 */

import { wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";
import { wikiToolsFlag } from "./wiki-read-slice.ts";
import { countedLanes } from "./wiki-report-blocks.ts";

export const STEP_DONE_ATTR = "data-step-done";
export const STEP_DONE_CONFIRM_ATTR = "data-step-done-confirm";
export const STEP_DONE_PANEL_CLASS = "wiki-step-done-panel";
export const STEP_DONE_NOTE_CLASS = "wiki-step-done-note";

export interface StepDonePageContext {
  /** The registry name, as the answer cards send it. */
  wiki: string;
  relPath: string;
  /** The open page's content hash, from its payload. */
  hash: () => string | null;
  /** Fetch and render the open page again. */
  reload: () => void;
}

interface ListedStep {
  key: string;
  lane: number;
  row: number | null;
  refusal: string | null;
}

interface StepList {
  baseHash: string;
  steps: ListedStep[];
  laneRows: number[];
}

interface Preview {
  removed: { line: number; text: string }[];
  renumbered: { line: number; before: string; after: string } | null;
  laneRemoved: boolean;
  nextMovesRemoved: boolean;
  logEntry: string;
  logNote: string;
  previewHash: string;
}

/** Pages whose last Done wrote but did not commit: Done is not offered there again. */
const uncommitted = new Set<string>();
/** A line to show above the steps after the reload a Done asked for. */
const notices = new Map<string, string>();
const pageKey = (ctx: StepDonePageContext) => `${ctx.wiki}\u0000${ctx.relPath}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The rows the reader renders for a lane's own lists, in source order. */
function laneRows(lane: HTMLElement): HTMLElement[] {
  const body = lane.querySelector<HTMLElement>(":scope > .nm-body");
  return body ? Array.from(body.querySelectorAll<HTMLElement>(":scope > ul > li, :scope > ol > li")) : [];
}

/** The preview's body: the lines that go, the renumbered line, what goes with them, the log entry. */
export function previewHtml(p: Preview): string {
  const lines = p.removed.map((r) => `<span class="wiki-step-done-ln">${r.line}</span> ${esc(r.text)}`).join("\n");
  const renum = p.renumbered
    ? `<div class="wiki-step-done-sub">Line ${p.renumbered.line} takes the number: <code>${esc(p.renumbered.before.trim())}</code> → <code>${esc(p.renumbered.after.trim())}</code></div>`
    : "";
  const goes = p.nextMovesRemoved
    ? `<div class="wiki-step-done-sub">That was the last step in the last lane: the lane and the next-moves block go too.</div>`
    : p.laneRemoved
      ? `<div class="wiki-step-done-sub">That was the lane's last step: the lane goes too.</div>`
      : "";
  return (
    `<div class="wiki-step-done-head">Done removes these lines from the page. There is no undo.</div>` +
    `<pre class="wiki-step-done-lines">${lines}</pre>${renum}${goes}` +
    `<div class="wiki-step-done-sub">${esc(p.logNote)}</div>` +
    `<pre class="wiki-step-done-log">${esc(p.logEntry)}</pre>` +
    `<div class="wiki-step-done-acts"><button type="button" class="wiki-step-done-go" ${STEP_DONE_CONFIRM_ATTR}>Remove the step</button>` +
    `<button type="button" class="wiki-step-done-cancel">Cancel</button></div>` +
    `<div class="wiki-step-done-err" role="alert" hidden></div>`
  );
}

async function postJson(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch("/api/wiki/step-done", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

const errorText = (data: Record<string, unknown>, fallback: string) => (typeof data.error === "string" && data.error ? data.error : fallback);

function showNotice(article: Element, text: string): void {
  const note = document.createElement("div");
  note.className = STEP_DONE_NOTE_CLASS;
  note.setAttribute("role", "status");
  note.setAttribute("data-reader-only", "");
  note.textContent = text;
  const block = article.querySelector(".next-moves");
  if (block) block.prepend(note);
  else article.prepend(note);
}

function closePanels(root: ParentNode): void {
  root.querySelectorAll(`.${STEP_DONE_PANEL_CLASS}`).forEach((p) => p.remove());
}

function openPreview(root: HTMLElement, li: HTMLElement, btn: HTMLButtonElement, step: ListedStep, ctx: StepDonePageContext, baseHash: string): void {
  const had = li.querySelector(`:scope > .${STEP_DONE_PANEL_CLASS}`);
  closePanels(root);
  if (had) return; // a second click on Done closes its own preview
  const panel = document.createElement("div");
  panel.className = STEP_DONE_PANEL_CLASS;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Mark the step done");
  panel.setAttribute("data-reader-only", "");
  panel.textContent = "Reading what Done removes…";
  li.appendChild(panel);
  btn.disabled = true;
  void (async () => {
    let r: { status: number; data: Record<string, unknown> };
    try {
      r = await postJson({ wiki: ctx.wiki, relPath: ctx.relPath, step: step.key, baseHash, preview: true });
    } catch {
      r = { status: 0, data: { error: "The preview could not be fetched." } };
    } finally {
      btn.disabled = false;
    }
    if (!panel.isConnected) return;
    if (r.status !== 200) {
      panel.innerHTML = `<div class="wiki-step-done-err" role="alert">${esc(errorText(r.data, "Done cannot remove this step."))}</div>`;
      return;
    }
    const p = r.data as unknown as Preview;
    panel.innerHTML = previewHtml(p);
    panel.querySelector<HTMLButtonElement>(".wiki-step-done-cancel")!.addEventListener("click", () => panel.remove());
    const go = panel.querySelector<HTMLButtonElement>(`[${STEP_DONE_CONFIRM_ATTR}]`)!;
    go.focus({ preventScroll: true });
    go.addEventListener("click", () => void write(panel, go, step, ctx, baseHash, p.previewHash));
  })();
}

async function write(panel: HTMLElement, go: HTMLButtonElement, step: ListedStep, ctx: StepDonePageContext, baseHash: string, previewHash: string): Promise<void> {
  const err = panel.querySelector<HTMLElement>(".wiki-step-done-err")!;
  go.disabled = true;
  err.hidden = true;
  let r: { status: number; data: Record<string, unknown> };
  try {
    r = await postJson({ wiki: ctx.wiki, relPath: ctx.relPath, step: step.key, baseHash, previewHash });
  } catch {
    r = { status: 0, data: { error: "The request failed: nothing is known to have been written. Reload the page." } };
  }
  if (r.status === 200 && r.data.ok === true) {
    if (r.data.uncommitted === true) {
      uncommitted.add(pageKey(ctx));
      notices.set(pageKey(ctx), "The step is removed, but the commit failed: the page has uncommitted edits, so Done is not offered on it again until they are committed.");
    }
    ctx.reload();
    return;
  }
  // A refusal stays on screen and says why: a page changed underneath, a
  // session editing it, a preview that no longer fits.
  err.textContent = errorText(r.data, "Done could not remove the step.");
  err.hidden = false;
  go.disabled = r.data.stale === true || r.data.dirty === true || r.data.changed === true;
}

/** Put a Done button on each open step of the rendered article's `you` lanes. */
export function enhanceStepDone(root: HTMLElement, ctx: StepDonePageContext): void {
  const article = root.querySelector<HTMLElement>(".wiki-article:not(.wiki-ask-article)");
  if (!article || !ctx.relPath) return;
  const key = pageKey(ctx);
  const notice = notices.get(key);
  if (notice) {
    notices.delete(key);
    showNotice(article, notice);
  }
  if (wikiReadonlyWikiFlag() || !wikiToolsFlag() || uncommitted.has(key)) return;
  const lanes = countedLanes(article).filter((l) => l.dataset.kind === "you");
  if (!lanes.some((l) => Number(l.dataset.count) > 0)) return;
  const shownHash = ctx.hash();
  void (async () => {
    let list: StepList;
    try {
      const res = await fetch(`/api/wiki/step-done?wiki=${encodeURIComponent(ctx.wiki)}&relPath=${encodeURIComponent(ctx.relPath)}`);
      if (!res.ok) return;
      list = (await res.json()) as StepList;
    } catch {
      return;
    }
    // The article must still be the one asked about, at the same page bytes.
    if (!article.isConnected || !Array.isArray(list.steps) || list.baseHash !== shownHash || list.laneRows.length !== lanes.length) return;
    lanes.forEach((lane, i) => {
      const rows = laneRows(lane);
      if (rows.length !== list.laneRows[i]) return;
      for (const step of list.steps) {
        if (step.lane !== i || step.row === null || step.refusal) continue;
        const li = rows[step.row];
        if (!li || li.querySelector(`:scope > [${STEP_DONE_ATTR}]`)) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wiki-step-done-btn";
        btn.setAttribute(STEP_DONE_ATTR, step.key);
        btn.setAttribute("data-reader-only", "");
        btn.title = "Mark this step done: preview what goes from the page";
        btn.textContent = "Done";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPreview(article, li, btn, step, ctx, list.baseHash);
        });
        // In a checklist row the text sits in `.check-text`: the button goes after it, before any nested list.
        const nested = li.querySelector(":scope > ul, :scope > ol");
        li.insertBefore(btn, nested);
      }
    });
  })();
}

export function stepDoneStyles(): string {
  return `
    .wiki-step-done-btn {
      margin-left: 0.5em; padding: 0 0.45em; font-size: 11px; line-height: 1.5; font-family: inherit;
      vertical-align: baseline; cursor: pointer; border-radius: 6px;
      border: 1px solid var(--border-secondary); background: transparent;
      color: var(--text-secondary); opacity: 0.55;
    }
    li:hover > .wiki-step-done-btn, .wiki-step-done-btn:focus-visible { opacity: 1; }
    .wiki-step-done-btn:disabled { cursor: progress; }
    .${STEP_DONE_PANEL_CLASS} {
      margin: 6px 0 8px; padding: 10px 12px; border-radius: 10px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-primary); font-size: 13px; line-height: 1.5;
      display: flex; flex-direction: column; gap: 6px;
    }
    .wiki-step-done-head { font-weight: 600; }
    .wiki-step-done-sub { color: var(--text-secondary); }
    .wiki-step-done-lines, .wiki-step-done-log {
      margin: 0; padding: 6px 8px; border-radius: 6px; overflow-x: auto; white-space: pre;
      background: var(--bg-surface); border: 1px solid var(--border-secondary); font-size: 12px;
    }
    .wiki-step-done-ln { color: var(--text-secondary); user-select: none; }
    .wiki-step-done-acts { display: flex; gap: 8px; flex-wrap: wrap; }
    .wiki-step-done-acts button {
      padding: 3px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-primary);
    }
    .wiki-step-done-acts .wiki-step-done-go { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
    .wiki-step-done-acts button:disabled { opacity: 0.5; cursor: not-allowed; }
    .wiki-step-done-err { color: var(--status-error); font-weight: 500; }
    .wiki-step-done-err[hidden] { display: none; }
    .${STEP_DONE_NOTE_CLASS} {
      margin: 0 0 8px; padding: 6px 10px; border-radius: 8px; font-size: 13px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary);
    }`;
}
