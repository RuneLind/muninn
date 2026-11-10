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
 * counted `you` lane in source order, how many rows its lists hold, and which
 * row each open step is with its text (`pairStepRows`). The reader may have
 * moved the viewer's role lanes up (`applyLaneRoles`), so the lanes are put
 * back in source order by `data-nm-order` first, and a row gets a button only
 * if its text is its step's: a lane with any row that does not match, or that
 * does not count the same, gets no buttons.
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
  /** Whether the reader still shows this page: no other view has started since it rendered. */
  current: () => boolean;
}

interface ListedStep {
  key: string;
  /** The step's source text, as `listYouSteps` gives it. */
  text: string;
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
  renumbered: { line: number; before: string; after: string }[];
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

/** A rendered lane as the pairing reads it, in DOM order. */
export interface RenderedLane {
  kind: string;
  /** Which counted `.next-moves` block the lane sits in, in DOM order: blocks are never reordered. */
  group: number;
  /** Its authored position in that block (`data-nm-order`), or null when the reader never reordered it. */
  order: number | null;
  /** Each row's rendered text, as `rowText` reads it. */
  rows: string[];
}

/** Text reduced to its letters and digits, lowercased: what a row and its step must share. */
export const renderedMatchText = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A step's markdown source as `renderedMatchText` would read its rendered row:
 *  images go, a link keeps its label, an autolink its URL, a tag its content, an entity nothing. */
export function sourceMatchText(src: string): string {
  return renderedMatchText(
    src
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/<\/?[A-Za-z][^>]*>/g, "")
      .replace(/&(?:[a-z]+|#\d+);/gi, ""),
  );
}

/**
 * Which rendered row gets which step's key. Lanes are put in source order
 * (block, then `order` where the reader set it, else DOM position); the `n`th
 * `you` lane of that order is the server's lane `n`. A lane pairs only when its
 * row count is the server's and every open step's row shows that step's text:
 * otherwise it pairs nothing (fail closed). `lane` in the result is the index
 * into `lanes` (DOM order).
 */
export function pairStepRows(
  lanes: RenderedLane[],
  list: { laneRows: number[]; steps: Pick<ListedStep, "key" | "text" | "lane" | "row" | "refusal">[] },
): { lane: number; row: number; key: string }[] {
  const pos = new Map<RenderedLane, number>();
  const seen = new Map<number, number>();
  for (const l of lanes) {
    const n = seen.get(l.group) ?? 0;
    pos.set(l, n);
    seen.set(l.group, n + 1);
  }
  const source = lanes
    .map((l, dom) => ({ l, dom }))
    .sort((a, b) => a.l.group - b.l.group || (a.l.order ?? pos.get(a.l)!) - (b.l.order ?? pos.get(b.l)!))
    .filter((x) => x.l.kind === "you");
  if (source.length !== list.laneRows.length) return [];
  const out: { lane: number; row: number; key: string }[] = [];
  source.forEach(({ l, dom }, i) => {
    if (l.rows.length !== list.laneRows[i]) return;
    const pairs: { lane: number; row: number; key: string }[] = [];
    for (const step of list.steps) {
      if (step.lane !== i || step.row === null || step.refusal) continue;
      const shown = l.rows[step.row];
      const want = sourceMatchText(step.text ?? "");
      if (shown === undefined || want === "" || renderedMatchText(shown) !== want) return;
      pairs.push({ lane: dom, row: step.row, key: step.key });
    }
    out.push(...pairs);
  });
  return out;
}

/** A row's own text: a task row's `.check-text`, else the row without its nested lists; reader-only additions left out. */
function rowText(li: HTMLElement): string {
  const own = li.querySelector<HTMLElement>(":scope > .check-text") ?? li;
  const copy = own.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(":scope > ul, :scope > ol, [data-reader-only]").forEach((n) => n.remove());
  return copy.textContent ?? "";
}

/** The counted lanes as the pairing reads them. */
function renderedLanes(article: HTMLElement): { el: HTMLElement; lane: RenderedLane }[] {
  const blocks: Element[] = [];
  return countedLanes(article).map((el) => {
    const block = el.closest(".next-moves")!;
    if (!blocks.includes(block)) blocks.push(block);
    const order = el.dataset.nmOrder !== undefined && /^\d+$/.test(el.dataset.nmOrder) ? Number(el.dataset.nmOrder) : null;
    return { el, lane: { kind: el.dataset.kind ?? "", group: blocks.indexOf(block), order, rows: laneRows(el).map(rowText) } };
  });
}

/** The preview's body: the lines that go, the renumbered lines, what goes with them, the log entry. */
export function previewHtml(p: Preview): string {
  const lines = p.removed.map((r) => `<span class="wiki-step-done-ln">${r.line}</span> ${esc(r.text)}`).join("\n");
  const renum = p.renumbered
    .map((r) => `<div class="wiki-step-done-sub">Line ${r.line} takes a new number: <code>${esc(r.before.trim())}</code> → <code>${esc(r.after.trim())}</code></div>`)
    .join("");
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
  // On the row itself, after its text and before any nested list: a task row
  // wraps (see the styles), so the panel takes a line of its own under the text.
  li.insertBefore(panel, li.querySelector(":scope > ul, :scope > ol"));
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
    // Only a page still on screen is fetched again: a reader who went to
    // another page meanwhile stays there (its render already took this panel).
    if (ctx.current() && panel.isConnected) ctx.reload();
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
  if (!countedLanes(article).some((l) => l.dataset.kind === "you" && Number(l.dataset.count) > 0)) return;
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
    if (!article.isConnected || !Array.isArray(list.steps) || !Array.isArray(list.laneRows) || list.baseHash !== shownHash) return;
    const lanes = renderedLanes(article);
    const byKey = new Map(list.steps.map((s) => [s.key, s]));
    for (const pair of pairStepRows(lanes.map((l) => l.lane), list)) {
      const step = byKey.get(pair.key)!;
      const li = laneRows(lanes[pair.lane]!.el)[pair.row];
      if (!li || li.querySelector(`:scope > [${STEP_DONE_ATTR}], :scope > .check-text > [${STEP_DONE_ATTR}]`)) continue;
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
      // In a task row the button goes inside `.check-text`, at the end of the
      // text: a flex sibling there would narrow the text column.
      const text = li.querySelector<HTMLElement>(":scope > .check-text");
      if (text) text.appendChild(btn);
      else li.insertBefore(btn, li.querySelector(":scope > ul, :scope > ol"));
    }
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
    li:hover > .wiki-step-done-btn, li:hover > .check-text > .wiki-step-done-btn, .wiki-step-done-btn:focus-visible { opacity: 1; }
    .wiki-step-done-btn:disabled { cursor: progress; }
    /* A task row with a Done wraps, so the panel (basis 100%) takes a line under
       the text; the text's basis 0 keeps it on the mark's line at its full width. */
    li.check-item:has(> .check-text > .wiki-step-done-btn) { flex-wrap: wrap; }
    li.check-item:has(> .check-text > .wiki-step-done-btn) > .check-text { flex: 1 1 0; min-width: 0; }
    .${STEP_DONE_PANEL_CLASS} {
      flex: 0 0 100%; min-width: 0; box-sizing: border-box;
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
