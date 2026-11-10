/// <reference lib="dom" />
/**
 * The /wiki reader's stale check: the STALE tab (stale check PR 2a) and the
 * counts everywhere else (PR 2b: the rail's badges, the home's line and Stale
 * tab, the article's pill and marks). Moved out of the shell (`wiki-browser.ts`)
 * whole, in source order (mimir plan muninn-wiki-browser-split, C3).
 *
 * Importing this module runs nothing. The shell's `boot()` calls
 * {@link initStale} beside `initRail` and {@link registerStale} where the tab's
 * `toggle` listener stood. This module never imports the shell: what it reads
 * and calls there arrives through {@link StaleDeps}.
 */
import { confirmedHits, STALE_SHELL_HTML, staleBodyHtml, staleCounts, staleFixKey, staleFixResultNotice, staleTabBadge, type StaleNotice, type StalePageCounts, type StaleReportView, type StaleVerdictView } from "./wiki-stale-tab.ts";
import { placeStaleMarks } from "./wiki-stale-marks.ts";
import { makeStatusDateLoader, statusDatePillHtml } from "./wiki-status-date.ts";
import { staleCountMap, staleHomeBodyHtml, staleHomeLineHtml, stalePillHtml, staleRailBadgeHtml, type StaleSummaryView } from "./wiki-stale-summary.ts";
import { wikiReadonlyFlag } from "./wiki-readonly-client.ts";
import { wikiToolsFlag } from "./wiki-read-slice.ts";
import { makeSseFrameParser } from "./client-runtime.ts";
import { renderList } from "./wiki-rail-controller.ts";
import { getCurrentName } from "./wiki-shell-state.ts";
import type { StartTab } from "./wiki-home.ts";

/** What the stale check reads and calls on the shell, read live. */
export interface StaleDeps {
  WIKI(): string;
  currentRelPath(): string | null;
  /** The article this view last rendered, and its page (the marks' target). */
  renderedArticle(): { relPath: string; el: Element } | null;
  startTab(): StartTab;
  withWiki(url: string): string;
  loadPageByRelPath(relPath: string, push?: boolean, revealHash?: boolean): void;
}

/** Set once, by {@link initStale}, before anything here runs. */
let deps!: StaleDeps;

// ── The STALE tab (stale check PR 2a, `wiki-stale-tab.ts`) ────────────
/** The tab's report for the open page, and Check's state. */
let staleReport: StaleReportView | null = null;
let staleFor: string | null = null;
let staleChecking = false;
let staleProgress = "";
/** The outcome of the reader's last action, shown above the report whatever
 *  else renders (a verdict not saved, A12; Apply's and Send's answers): a
 *  repaint, Check and a reload of the same page keep it (R2B4); the next
 *  answer replaces it, another page clears it. */
let staleNotice = "";
let staleNoticeTone: StaleNotice["tone"] = "error";
/** Fixes whose Apply or Send is in flight, by `staleFixKey`: every repaint
 *  draws their buttons disabled, so no fix is posted twice. The value is the
 *  last report request issued when the POST answered (Infinity until then):
 *  only a report requested after it can drop the fix, so only such a report
 *  clears the key, never an earlier one landing late or a superseded one. */
const staleFixPending = new Map<string, number>();
/** A report from request `seq` landed: fixes answered before it was asked for
 *  are no longer in flight. */
function settleStaleFixes(seq: number): void {
  for (const [key, answeredAt] of staleFixPending) if (answeredAt < seq) staleFixPending.delete(key);
}
/** Linking pages whose last Check call failed: shown per row, not counted (A12). */
let staleRowErrors: Record<string, string> = {};
/** Pages the last Check left at its call limit (A12). */
let staleCapLeft = 0;
let staleCapCalls = 10;
/** Each `<details>`'s open state by its `data-stale-open` key, for the page
 *  in `staleFor` only: a repaint keeps it (A12), a new page starts clean.
 *  Written by the tab's `toggle` listener as the reader folds, never read back
 *  from the DOM at repaint, which may still be another page's (R2B4). */
let staleOpen: Record<string, boolean> = {};
/** The report request in flight: an older one answering late is dropped. */
let staleLoadSeq = 0;
/** The Check stream in flight: its page and its abort (A9). A Check belongs
 *  to the page it started on; leaving that page aborts it. */
let staleCheckRun: { relPath: string; abort: AbortController } | null = null;

/** The status date check's answer for the open page (first-screen-claims P3):
 *  the line after the pill. Its state and request live in `wiki-status-date.ts`. */
const statusDates = makeStatusDateLoader({ wiki: () => deps.WIKI(), onAnswer: () => paintStaleSurfaces() });

/** Abort the Check in flight, if any: the reader left its page. */
function abortStaleCheck(): void {
  staleCheckRun?.abort.abort();
  staleCheckRun = null;
  staleChecking = false;
}

/** The tab exists where the tool routes do and the instance writes (D25). */
export function staleTabAvailable(): boolean {
  return wikiToolsFlag() && !wikiReadonlyFlag();
}

/** The tab follows the page on screen: another page starts from no report
 *  (its own loads next), a view that is not a page shows none (R2B4). */
function staleFollowPage(relPath: string | null): void {
  const next = relPath && staleTabAvailable() ? relPath : null;
  if (staleFor === next) return;
  abortStaleCheck();
  staleFor = next;
  staleReport = null;
  resetStaleClientState();
  renderStale();
}

/** Forget the page's client-side Check state: a new page starts clean. */
function resetStaleClientState(): void {
  staleProgress = "";
  staleNotice = "";
  staleRowErrors = {};
  staleCapLeft = 0;
  staleOpen = {};
}

/** The open page did not load: its stale report is an error, never the
 *  previous page's report (A12). */
export function staleForFailedPage(): void {
  abortStaleCheck();
  staleFor = "";
  staleReport = { error: "the page did not load" };
  resetStaleClientState();
  renderStale();
}

function renderStale(): void {
  const body = document.getElementById("staleBody");
  if (body) {
    if (!body.querySelector(":scope > [data-stale-content]")) body.innerHTML = STALE_SHELL_HTML;
    const notice = body.querySelector(":scope > [data-stale-notice]")!;
    // Written only when it changes: the alert node announces its text once.
    if (notice.textContent !== staleNotice) notice.textContent = staleNotice;
    notice.setAttribute("data-tone", staleNotice ? staleNoticeTone : "");
    body.querySelector(":scope > [data-stale-content]")!.innerHTML = staleFor === null
      ? '<div class="wiki-conn-empty">Select a page to see what may be stale.</div>'
      : staleBodyHtml(staleReport, {
        checking: staleChecking,
        // "" is no line of Check's: the report's own count shows.
        progress: staleProgress || undefined,
        rowErrors: staleRowErrors,
        capLeft: staleCapLeft,
        capCalls: staleCapCalls,
        open: staleOpen,
        pendingFixes: new Set(staleFixPending.keys()),
      });
  }
  const badge = document.getElementById("wikiStaleCount");
  if (badge) {
    const b = staleTabBadge(staleReport);
    badge.textContent = b.text;
    badge.parentElement?.setAttribute("title", b.tabTitle);
  }
  paintStaleSurfaces();
}

/** What the client holds beyond a freshly loaded report, made to agree with
 *  it: a row a reader has judged is no longer a failed Check row, and no more
 *  pages are left at Check's limit than the report has without a verdict (R2B4). */
function reconcileStaleClientState(data: StaleReportView): void {
  const rows = data.buckets?.linking.filter((l) => l.bucket === "toCheck") ?? [];
  for (const l of rows) if (l.verdict?.checkedBy === "reader") delete staleRowErrors[l.relPath];
  staleCapLeft = Math.min(staleCapLeft, rows.filter((l) => !l.verdict).length);
}

/** Set (or with "" clear) the tab's notice and repaint. */
function setStaleNotice(text: string, tone: StaleNotice["tone"] = "error"): void {
  staleNotice = text;
  staleNoticeTone = tone;
  renderStale();
}

/** Fetch the open page's stale report (free hits, buckets, cached verdicts). */
export function loadStale(relPath: string): void {
  if (!staleTabAvailable()) return;
  statusDates.load(relPath);
  if (staleFor !== relPath) {
    abortStaleCheck();
    staleFor = relPath;
    staleReport = null;
    resetStaleClientState();
    renderStale();
  }
  const seq = ++staleLoadSeq;
  /** Still the latest request, and still for the page in the tab. */
  const mine = () => seq === staleLoadSeq && staleFor === relPath;
  fetch(deps.withWiki("/api/wiki/stale?page=" + encodeURIComponent(relPath)))
    .then((r) => r.json())
    .then((data: StaleReportView) => {
      if (!mine()) return;
      staleReport = data;
      settleStaleFixes(seq);
      if (!data.error) {
        reconcileStaleClientState(data);
        foldStaleReportCounts(relPath, staleCounts(data));
      }
      renderStale();
    })
    .catch(() => {
      if (!mine()) return;
      staleReport = { error: "the stale report could not be loaded" };
      settleStaleFixes(seq);
      renderStale();
    });
}

/** Check (D6): stream the check route, fill verdicts in as they arrive. */
export async function runStaleCheckClient(relPath: string): Promise<void> {
  if (staleChecking || staleFor !== relPath) return;
  const run = { relPath, abort: new AbortController() };
  staleCheckRun = run;
  /** This run is still the open page's Check: only then does it paint. */
  const mine = () => staleCheckRun === run && staleFor === relPath;
  staleChecking = true;
  staleProgress = "Starting…";
  staleRowErrors = {};
  staleCapLeft = 0;
  renderStale();
  let checked = 0;
  let failed = 0;
  let total = 0;
  try {
    const res = await fetch("/api/wiki/stale/check", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ wiki: deps.WIKI(), page: relPath }),
      signal: run.abort.signal,
    });
    if (!mine()) return;
    if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      let msg = "Check could not start (HTTP " + res.status + ").";
      try {
        const b = (await res.json()) as { error?: unknown };
        if (b && typeof b.error === "string") msg = b.error;
      } catch { /* keep the status copy */ }
      staleProgress = msg;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = makeSseFrameParser((frame) => {
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(frame.data) as Record<string, unknown>; } catch { return; }
      if (!mine()) return;
      const rel = String(d.relPath ?? "");
      if (frame.event === "start") {
        total = Number(d.toCheck) || 0;
        staleCapLeft = Number(d.left) || 0;
        staleCapCalls = Number(d.toCall) > 0 && staleCapLeft > 0 ? Number(d.toCall) : staleCapCalls;
      } else if (frame.event === "verdict") {
        checked++;
        delete staleRowErrors[rel];
        const l = staleReport?.buckets?.linking.find((x) => x.relPath === rel);
        if (l) l.verdict = { verdict: d.verdict, reason: d.reason, edit: d.edit } as StaleVerdictView;
      } else if (frame.event === "error") {
        // A failed call is not a checked page (A12): the row says why.
        failed++;
        staleRowErrors[rel] = String(d.message ?? "the check call failed");
      } else if (frame.event === "done") staleCapLeft = Number(d.left) || 0;
      if (frame.event === "app_error") staleProgress = String(d.message ?? "Check failed");
      else staleProgress = `${checked} of ${total} checked` + (failed ? ` · ${failed} failed` : "");
      renderStale();
    });
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !mine()) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    if (mine()) parser.end();
  } catch {
    if (mine()) staleProgress = "Could not reach the server.";
  } finally {
    // A run that was aborted or replaced leaves the state to its successor.
    if (mine()) {
      staleCheckRun = null;
      staleChecking = false;
      renderStale();
      loadStale(relPath);
    }
    // Check's verdicts can change other pages' rows too (PR 2b).
    loadStaleSummary();
  }
}

// ── The counts everywhere (stale check PR 2b, `wiki-stale-summary.ts`) ──
/** The wiki-wide summary (D31): the rail's badges and the home's line and tab. */
let staleSummary: StaleSummaryView | null = null;
let staleSummaryCounts = new Map<string, StalePageCounts>();
/** The summary request in flight: an older one answering late is dropped. */
let staleSummarySeq = 0;
/** Page reports folded into the summary's counts, each stamped when the report
 *  LANDS with the newest summary request at that moment: a summary asked for
 *  before the report landed keeps the report's counts, one asked for after it
 *  landed replaces them. */
const staleReportFolds = new Map<string, { counts: StalePageCounts; seq: number }>();
/** Each rail row's badge as `renderList` last painted it, by relPath. */
let staleRailPainted = new Map<string, string>();
/** `renderList` starts each paint from an empty record (`RailDeps`). */
export function resetStaleRailPainted(): void {
  staleRailPainted = new Map();
}
/** The article and hits the marks were last placed for. */
let staleMarksFor: { el: Element; sig: string } | null = null;

/** A page's two numbers for its rail row: the open page's own report once it
 *  has loaded (the numbers its pill and STALE tab show), else the summary's row. */
function staleRailCounts(relPath: string): StalePageCounts | undefined {
  if (!staleTabAvailable()) return undefined;
  if (relPath === staleFor && staleReport && !staleReport.error) return staleCounts(staleReport);
  return staleSummaryCounts.get(relPath);
}

/** Fetch the wiki-wide summary and repaint the rail and the home. */
export function loadStaleSummary(): void {
  if (!staleTabAvailable()) return;
  const seq = ++staleSummarySeq;
  fetch(deps.withWiki("/api/wiki/stale"))
    .then((r) => r.json())
    .then((data: StaleSummaryView) => {
      if (seq !== staleSummarySeq) return;
      staleSummary = data;
      adoptStaleSummaryCounts(staleCountMap(data), seq);
      renderStaleHome();
    })
    .catch(() => {
      if (seq !== staleSummarySeq) return;
      staleSummary = { error: "the summary could not be loaded" };
      adoptStaleSummaryCounts(new Map(), seq);
      renderStaleHome();
    });
}

/** Take summary `seq`'s counts, keeping the page reports that landed after it
 *  was asked for, and repaint the rail only when a badge would change. */
function adoptStaleSummaryCounts(next: Map<string, StalePageCounts>, seq: number): void {
  for (const [relPath, f] of staleReportFolds) {
    if (f.seq >= seq) next.set(relPath, f.counts);
    else staleReportFolds.delete(relPath);
  }
  staleSummaryCounts = next;
  repaintRailIfBadgeChanged();
}

/** A page report's counts become its summary row's, so the row keeps what the
 *  pill showed after the reader leaves the page; no refetch. */
function foldStaleReportCounts(relPath: string, counts: StalePageCounts): void {
  staleReportFolds.set(relPath, { counts, seq: staleSummarySeq });
  staleSummaryCounts.set(relPath, counts);
}

/** Repaint the rail when some painted row's badge would differ from what it
 *  shows now; otherwise no row render. */
function repaintRailIfBadgeChanged(): void {
  for (const [relPath, html] of staleRailPainted) {
    if (html !== staleRailBadgeHtml(staleRailCounts(relPath))) return renderList();
  }
}

/** The home's line, and its Stale tab when that is the one showing. */
function renderStaleHome(): void {
  if (getCurrentName() !== null) return;
  const line = document.getElementById("wikiStaleHome");
  if (line) line.innerHTML = staleHomeLineHtml(staleSummary);
  const body = document.getElementById("startBody");
  if (body && deps.startTab() === "stale") body.innerHTML = staleHomeBodyHtml(staleSummary);
}

/** The pill, the marks and the open page's rail row, from the report for the
 *  page on screen only: a report for another page paints nothing (R2B4). */
export function paintStaleSurfaces(): void {
  const onScreen = staleFor !== null && staleFor !== "" && staleFor === deps.currentRelPath();
  const shown = onScreen ? staleReport : null;
  const pill = document.getElementById("wikiStalePill");
  if (pill) {
    // The line is the loader's answer for the tab's page, so never another page's.
    const html = onScreen ? stalePillHtml(staleReport) + statusDatePillHtml(statusDates.answerFor(staleFor)) : "";
    if (pill.innerHTML !== html) pill.innerHTML = html;
  }
  const art = deps.renderedArticle();
  if (art && art.el.isConnected) {
    const hits = shown && !shown.error && art.relPath === staleFor ? confirmedHits(shown) : [];
    // Everything a mark shows: its words, and the status its title names.
    const sig = JSON.stringify(hits.map((h) => [h.line, h.target, h.text, h.said, h.now, h.frontmatter]));
    if (staleMarksFor?.el !== art.el || staleMarksFor.sig !== sig) {
      placeStaleMarks(art.el, hits);
      staleMarksFor = { el: art.el, sig };
    }
  }
  // The open page's rail row follows its report: repainted only when a
  // badge would change, so opening a page costs no extra row render.
  repaintRailIfBadgeChanged();
}

/** A rail row's badge, noted as painted. */
export function railStaleBadge(relPath: string): string {
  const html = staleRailBadgeHtml(staleRailCounts(relPath));
  staleRailPainted.set(relPath, html);
  return html;
}

/** Still true / Not a status: one reader verdict row, then a reload. */
export async function postStaleVerdict(btn: Element): Promise<void> {
  const relPath = btn.getAttribute("data-stale-page") || "";
  const kind = btn.getAttribute("data-kind") || "";
  const payload: Record<string, unknown> = { wiki: deps.WIKI(), page: relPath, kind, verdict: btn.getAttribute("data-stale-verdict") };
  if (kind === "status-line") {
    payload.line = Number(btn.getAttribute("data-line"));
    payload.target = btn.getAttribute("data-target") || "";
  } else payload.linking = btn.getAttribute("data-linking") || "";
  (btn as HTMLButtonElement).disabled = true;
  // The notice renders above the report, check bar or not (A12).
  const fail = (msg: string) => {
    if (staleFor !== relPath) return;
    setStaleNotice(msg);
  };
  try {
    const res = await fetch("/api/wiki/stale/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: unknown };
      fail("The verdict was not saved: " + (typeof b.error === "string" ? b.error : "HTTP " + res.status) + ".");
      return;
    }
  } catch {
    fail("The verdict was not saved: could not reach the server.");
    return;
  }
  if (staleFor === relPath) {
    staleNotice = "";
    // The last Check's line counted this row as failed or unchecked; the
    // reloaded report's own count replaces it (R2B4).
    if (kind === "passage" && !staleChecking) staleProgress = "";
    renderStale();
    loadStale(relPath);
  }
  // The rail and the home drop with the tab (PR 2b).
  loadStaleSummary();
}

/**
 * Apply / Send to Gardener on a Draft fix (PR 3): the button names the fix
 * (its kind, page, line + target or linking page, variant and `old`); the
 * server reads the edit off the stored verdict. Then the report and the
 * summary reload, and an Apply that wrote the page on screen reloads it.
 */
export async function postStaleFix(btn: Element, action: "apply" | "send"): Promise<void> {
  const relPath = btn.getAttribute("data-stale-page") || "";
  const kind = btn.getAttribute("data-kind") || "";
  const payload: Record<string, unknown> = {
    wiki: deps.WIKI(),
    page: relPath,
    kind,
    variant: btn.getAttribute("data-variant") || "new",
    old: btn.getAttribute("data-old") ?? "",
  };
  if (kind === "status-line") {
    payload.line = Number(btn.getAttribute("data-line"));
    payload.target = btn.getAttribute("data-target") || "";
  } else payload.linking = btn.getAttribute("data-linking") || "";
  const key = staleFixKey({ kind, page: relPath, line: btn.getAttribute("data-line"), target: btn.getAttribute("data-target"), linking: btn.getAttribute("data-linking") });
  // One request per fix: a click on a button a repaint has not yet disabled sends nothing.
  if (staleFixPending.has(key)) return;
  staleFixPending.set(key, Infinity);
  // The fix's buttons repaint disabled; the last notice stands until this answer replaces it.
  renderStale();
  let result: StaleNotice;
  let wrote = "";
  try {
    const res = await fetch(`/api/wiki/stale/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    result = staleFixResultNotice(action, res.status, b);
    if (result.tone !== "error" && action === "apply" && typeof b.page === "string") wrote = b.page;
  } catch {
    result = { tone: "error", text: `${action === "apply" ? "The fix was not applied" : "The fix was not sent to the Gardener"}: could not reach the server.` };
  }
  if (result.tone === "error") staleFixPending.delete(key);
  else {
    // The buttons stay disabled until a report asked for after this answer
    // lands (`settleStaleFixes`): an earlier one still offers the fix.
    staleFixPending.set(key, staleLoadSeq);
    // The rail, the head and the home drop with the tab; ⧗ appears on a Send.
    loadStaleSummary();
    if (wrote && wrote === deps.currentRelPath()) deps.loadPageByRelPath(wrote, false, false);
    if (staleFor === relPath) loadStale(relPath);
  }
  // A page opened meanwhile is not the fix's: its tab gets no notice.
  if (staleFor === relPath) setStaleNotice(result.text, result.tone);
}
/** The shown page changed (`setCurrentRelPath`, the one writer of the shell's
 *  `currentRelPath`): a Check that belongs to another page ends (A9), and the
 *  tab follows the page. */
export function staleFollowShownPage(relPath: string | null): void {
  if (staleCheckRun && staleCheckRun.relPath !== relPath) abortStaleCheck();
  staleFollowPage(relPath);
}

/** The wiki-wide summary the home's line and Stale tab render from. */
export function getStaleSummary(): StaleSummaryView | null {
  return staleSummary;
}

// ── Boot: called by the shell's boot(), each where its statements stood ───
/** Take the port. */
export function initStale(d: StaleDeps): void {
  deps = d;
}

/** The tab's `toggle` listener (capture: `toggle` does not bubble). */
export function registerStale(): void {
  /** The `<details>` the reader folds: its state is the page's from then on. */
  document.getElementById("staleBody")?.addEventListener(
    "toggle",
    (e) => {
      const d = e.target as HTMLElement;
      const key = d.getAttribute?.("data-stale-open");
      // A toggle queued by a body since replaced (another page's) is not this page's.
      if (key && d.isConnected) staleOpen[key] = (d as HTMLDetailsElement).open;
    },
    true,
  );
}
