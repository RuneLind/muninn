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
 * A refusal stays in the preview with what the reader can do next: Remove
 * stays on only where a retry can help (`retryable`), and Reload shows where
 * the page on screen is no longer the page on disk (`needsReload`). A refusal
 * whose preview has closed meanwhile goes on the page as a notice, at the
 * page's next render if the reader has left it. Escape and Cancel close the
 * preview and put focus back on its Done, also while a write runs: a button
 * is turned off with `aria-disabled`, which keeps focus on it.
 *
 * Which rendered row is which step comes from `GET /api/wiki/step-done`: per
 * counted `you` lane in source order, how many rows its lists hold, and which
 * row each open step is (`pairStepRows`). The reader may have moved the
 * viewer's role lanes up (`applyLaneRoles`), so the lanes are put back in
 * source order by `data-nm-order` first. A lane that renders another number
 * of rows than the server counted gets no buttons. Row text is not compared:
 * a row shows a wikilink's label and a tag in code as text, which its source
 * does not read as.
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

const REMOVED_NOTICE = "The step is removed from the page.";
const UNCOMMITTED_NOTICE =
  "The step is removed, but the commit failed: the page has uncommitted edits, so Done is not offered on it again until they are committed.";

/** Pages whose last Done wrote but did not commit: Done is not offered there again. */
const uncommitted = new Set<string>();
/** A line to show above the steps the next time the page renders; `focus` when that render is the reload a Done asked for. */
const notices = new Map<string, { text: string; focus: boolean; role?: "alert" }>();
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
  /** How many rows its own lists render. */
  rows: number;
}

/**
 * Which rendered row gets which step's key. Lanes are put in source order
 * (block, then `order` where the reader set it, else DOM position); the `n`th
 * `you` lane of that order is the server's lane `n`. A lane pairs only when it
 * renders the number of rows the server counted and holds every open step's
 * row: otherwise it pairs nothing (fail closed). `lane` in the result is the
 * index into `lanes` (DOM order).
 */
export function pairStepRows(
  lanes: RenderedLane[],
  list: { laneRows: number[]; steps: Pick<ListedStep, "key" | "lane" | "row" | "refusal">[] },
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
    if (l.rows !== list.laneRows[i]) return;
    const pairs: { lane: number; row: number; key: string }[] = [];
    for (const step of list.steps) {
      if (step.lane !== i || step.row === null || step.refusal) continue;
      if (step.row >= l.rows) return;
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
    return { el, lane: { kind: el.dataset.kind ?? "", group: blocks.indexOf(block), order, rows: laneRows(el).length } };
  });
}

/** One line for the later steps a Done renumbers: how many, and which numbers become which. Empty when none. */
export function renumberLine(renumbered: Preview["renumbered"]): string {
  if (!renumbered.length) return "";
  const one = renumbered.length === 1;
  const says = one ? "The step after it takes a new number" : `The ${renumbered.length} steps after it take new numbers`;
  const num = (line: string) => /^[ \t]*(\d+)\./.exec(line)?.[1];
  const [first, last] = [renumbered[0]!, renumbered[renumbered.length - 1]!];
  const n = [num(first.before), num(last.before), num(first.after), num(last.after)];
  if (renumbered.some((r) => num(r.before) === undefined || num(r.after) === undefined)) return `${says}.`;
  return one ? `${says}: ${n[0]} becomes ${n[2]}.` : `${says}: ${n[0]}–${n[1]} become ${n[2]}–${n[3]}.`;
}

/** The preview's body: the lines that go, one line for the renumbered steps, what goes with them, the log entry. */
export function previewHtml(p: Preview): string {
  const lines = p.removed.map((r) => `<span class="wiki-step-done-ln">${r.line}</span> ${esc(r.text)}`).join("\n");
  const renumbers = renumberLine(p.renumbered);
  const renum = renumbers ? `<div class="wiki-step-done-sub">${esc(renumbers)}</div>` : "";
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
    `<button type="button" class="wiki-step-done-reload" hidden>Reload the page</button>` +
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

/** Off without `disabled`: a disabled button drops focus to the body, and Escape then never reaches the preview. */
function setOff(b: HTMLElement, off: boolean): void {
  if (off) b.setAttribute("aria-disabled", "true");
  else b.removeAttribute("aria-disabled");
}
const isOff = (b: HTMLElement): boolean => b.getAttribute("aria-disabled") === "true";

/**
 * One line above the steps, replacing an earlier one: in the first counted
 * block that is not inside a closed fold, else above the article. A settled
 * block is not counted, so the line never lands in a collapsed callout.
 */
function showNotice(article: HTMLElement, text: string, role: "status" | "alert"): HTMLElement {
  article.querySelectorAll(`.${STEP_DONE_NOTE_CLASS}`).forEach((n) => n.remove());
  const note = document.createElement("div");
  note.className = STEP_DONE_NOTE_CLASS;
  note.setAttribute("role", role);
  note.setAttribute("data-reader-only", "");
  note.tabIndex = -1;
  note.textContent = text;
  const block = countedLanes(article)
    .map((l) => l.closest<HTMLElement>(".next-moves"))
    .find((b) => b && !b.closest("details:not([open])"));
  if (block) block.prepend(note);
  else article.prepend(note);
  return note;
}

/** A refused write a second click on Remove can get through: a wiki being written right now, or Gardener cards that could not be read. */
export const retryable = (status: number, data: Record<string, unknown>): boolean => data.locked === true || status === 503;

/** A refused write after which the page on screen may not be the page on disk: it changed, the preview no longer fits, or the answer never came. */
export const needsReload = (status: number, data: Record<string, unknown>): boolean =>
  data.stale === true || data.changed === true || status === 0 || status === 500;

/** A row's text as a button's name carries it: one line, capped. */
const NAME_CHARS = 120;
function rowName(li: HTMLElement): string {
  const text = rowText(li).replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS - 1).join("").trimEnd()}…` : text;
}

function closePanels(root: ParentNode): void {
  root.querySelectorAll(`.${STEP_DONE_PANEL_CLASS}`).forEach((p) => p.remove());
}

function openPreview(root: HTMLElement, li: HTMLElement, btn: HTMLButtonElement, step: ListedStep, ctx: StepDonePageContext, baseHash: string): void {
  const had = li.querySelector(`:scope > .${STEP_DONE_PANEL_CLASS}`);
  closePanels(root);
  if (had) return; // a second click on Done closes its own preview
  const name = rowName(li);
  const panel = document.createElement("div");
  panel.className = STEP_DONE_PANEL_CLASS;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Mark the step done");
  panel.setAttribute("data-reader-only", "");
  panel.textContent = "Reading what Done removes…";
  // On the row itself, after its text and before any nested list: a task row
  // wraps (see the styles), so the panel takes a line of its own under the text.
  li.insertBefore(panel, li.querySelector(":scope > ul, :scope > ol"));
  const close = () => {
    panel.remove();
    btn.focus({ preventScroll: true });
  };
  // Escape from inside the preview closes it; the shell's own Escape handlers do not also run.
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  setOff(btn, true);
  void (async () => {
    let r: { status: number; data: Record<string, unknown> };
    try {
      r = await postJson({ wiki: ctx.wiki, relPath: ctx.relPath, step: step.key, baseHash, preview: true });
    } catch {
      r = { status: 0, data: { error: "The preview could not be fetched." } };
    } finally {
      setOff(btn, false);
    }
    if (!panel.isConnected) return;
    if (r.status !== 200) {
      panel.innerHTML = `<div class="wiki-step-done-err" role="alert">${esc(errorText(r.data, "Done cannot remove this step."))}</div>`;
      return;
    }
    const p = r.data as unknown as Preview;
    panel.innerHTML = previewHtml(p);
    panel.querySelector<HTMLButtonElement>(".wiki-step-done-cancel")!.addEventListener("click", close);
    panel.querySelector<HTMLButtonElement>(".wiki-step-done-reload")!.addEventListener("click", () => ctx.reload());
    const go = panel.querySelector<HTMLButtonElement>(`[${STEP_DONE_CONFIRM_ATTR}]`)!;
    go.focus({ preventScroll: true });
    go.addEventListener("click", () => {
      if (!isOff(go)) void write(root, panel, go, step, name, ctx, baseHash, p.previewHash);
    });
  })();
}

async function write(
  article: HTMLElement,
  panel: HTMLElement,
  go: HTMLButtonElement,
  step: ListedStep,
  name: string,
  ctx: StepDonePageContext,
  baseHash: string,
  previewHash: string,
): Promise<void> {
  const err = panel.querySelector<HTMLElement>(".wiki-step-done-err")!;
  const reload = panel.querySelector<HTMLButtonElement>(".wiki-step-done-reload")!;
  setOff(go, true);
  err.hidden = true;
  reload.hidden = true;
  let r: { status: number; data: Record<string, unknown> };
  try {
    r = await postJson({ wiki: ctx.wiki, relPath: ctx.relPath, step: step.key, baseHash, previewHash });
  } catch {
    r = { status: 0, data: { error: "The request failed: nothing is known to have been written. Reload the page." } };
  }
  if (r.status === 200 && r.data.ok === true) {
    // Only a page still on screen is fetched again: a reader who went to
    // another page meanwhile stays there. A preview closed meanwhile (Cancel,
    // Escape, another Done) does not stop it: the page changed all the same.
    const reloads = ctx.current() && article.isConnected;
    if (r.data.uncommitted === true) uncommitted.add(pageKey(ctx));
    notices.set(pageKey(ctx), { text: r.data.uncommitted === true ? UNCOMMITTED_NOTICE : REMOVED_NOTICE, focus: reloads });
    if (reloads) ctx.reload();
    return;
  }
  // A refusal stays on screen and says why: a page changed underneath, a
  // session editing it, a preview that no longer fits.
  const why = errorText(r.data, "Done could not remove the step.");
  if (!panel.isConnected) {
    // The preview closed while the write ran (another Done, Escape, or the
    // reader left the page): the refusal goes on the page if it is still the
    // one shown, else it waits for that page's next render.
    const text = `Done did not remove «${name}»: ${why}`;
    if (ctx.current() && article.isConnected) showNotice(article, text, "alert");
    else notices.set(pageKey(ctx), { text, focus: false, role: "alert" });
    return;
  }
  err.textContent = why;
  err.hidden = false;
  reload.hidden = !needsReload(r.status, r.data);
  setOff(go, !retryable(r.status, r.data));
}

/** Put a Done button on each open step of the rendered article's `you` lanes. */
export function enhanceStepDone(root: HTMLElement, ctx: StepDonePageContext): void {
  const article = root.querySelector<HTMLElement>(".wiki-article:not(.wiki-ask-article)");
  if (!article || !ctx.relPath) return;
  const key = pageKey(ctx);
  const notice = notices.get(key);
  if (notice) {
    notices.delete(key);
    // After the reload a Done asked for, the keyboard goes here: the article was replaced under it.
    const note = showNotice(article, notice.text, notice.role ?? "status");
    if (notice.focus) note.focus({ preventScroll: true });
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
      btn.setAttribute("aria-label", `Done: ${rowName(li)}`);
      // Escape on the Done itself closes its preview too (focus is here while the preview is read).
      btn.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !li.querySelector(`:scope > .${STEP_DONE_PANEL_CLASS}`)) return;
        e.preventDefault();
        e.stopPropagation();
        closePanels(li);
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isOff(btn)) return; // its preview is still being read
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
    .wiki-step-done-btn[aria-disabled="true"] { cursor: progress; }
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
      margin: 0; padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere;
      background: var(--bg-surface); border: 1px solid var(--border-secondary); font-size: 12px;
    }
    .wiki-step-done-ln { color: var(--text-secondary); user-select: none; }
    .wiki-step-done-acts { display: flex; gap: 8px; flex-wrap: wrap; }
    .wiki-step-done-acts button {
      padding: 3px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-primary);
    }
    .wiki-step-done-acts .wiki-step-done-go { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
    .wiki-step-done-acts button[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
    .wiki-step-done-err { color: var(--status-error); font-weight: 500; }
    .wiki-step-done-err[hidden], .wiki-step-done-acts button[hidden] { display: none; }
    .${STEP_DONE_NOTE_CLASS} {
      margin: 0 0 8px; padding: 6px 10px; border-radius: 8px; font-size: 13px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary);
    }
    .${STEP_DONE_NOTE_CLASS}[role="alert"] { color: var(--status-error); font-weight: 500; }`;
}
