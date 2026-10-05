/// <reference lib="dom" />
/**
 * The `/summaries` doc panel's Fact check section and the Latest rail badges —
 * the DOM half. Published on `globalThis` by `sum-factcheck-browser.ts`; the
 * page's inline scripts call {@link sumFactcheckOnOpen} after rendering a
 * document and {@link sumFactcheckBadgeHtml} while building rail rows.
 *
 * A run is keyed by document and keeps streaming when the reader moves to
 * another document or closes the panel: the server saves only a run whose
 * client is still connected, so dropping the stream on navigation would throw
 * the check away. Only the RENDER follows the panel.
 */

import { makeSseFrameParser } from "./client-runtime.ts";
import {
  factcheckAnswerHtml,
  factcheckBadgeHtml,
  factcheckCheckedLabel,
  factcheckProgressHtml,
  factcheckVerdictChipsHtml,
  type FactcheckProgressRow,
} from "./sum-factcheck-render.ts";
import { escHtml } from "./escape.ts";
import { DOC_PANEL_FACTCHECK_BTN_ID } from "./doc-panel.ts";

export const SUM_FACTCHECK_SECTION_ID = "sumFactcheck";
export const SUM_FACTCHECK_BTN_ID = DOC_PANEL_FACTCHECK_BTN_ID;

interface SavedClaim { verdict: string }
interface SavedResult { answer: string; claims: SavedClaim[]; createdAt: number; botName?: string }
interface SavedState { result: SavedResult | null; stale: boolean | null }

interface RunState {
  rows: FactcheckProgressRow[];
  lede: string;
  running: boolean;
  error: string | null;
}

type Badge = { bad: number; total: number };

const runs = new Map<string, RunState>();
const saved = new Map<string, SavedState>();
let badges = new Map<string, Badge>();
let current: { source: string; docId: string } | null = null;

const keyOf = (source: string, docId: string) => `${source}\u0000${docId}`;
const query = (source: string, docId: string) =>
  `source=${encodeURIComponent(source)}&docId=${encodeURIComponent(docId)}`;

function section(): HTMLElement | null {
  return document.getElementById(SUM_FACTCHECK_SECTION_ID);
}

/** After the article column is rendered for a document. `null` source ⇒ an
 *  unregistered one: no button, no section. */
export function sumFactcheckOnOpen(docId: string, source: string | null, mainEl: HTMLElement | null): void {
  const btn = document.getElementById(SUM_FACTCHECK_BTN_ID) as HTMLButtonElement | null;
  if (btn) btn.hidden = !source;
  current = source ? { source, docId } : null;
  if (!current || !mainEl) return;
  let el = section();
  if (!el || !mainEl.contains(el)) {
    el?.remove();
    el = document.createElement("section");
    el.id = SUM_FACTCHECK_SECTION_ID;
    el.className = "sum-fc";
    el.setAttribute("aria-label", "Fact check");
    const body = mainEl.querySelector("#sumArticleBody");
    if (body) mainEl.insertBefore(el, body);
    else mainEl.insertBefore(el, mainEl.firstChild);
  }
  render();
  const key = keyOf(current.source, current.docId);
  // Re-read on every open: a re-run since the last look moves `stale`.
  if (!runs.get(key)?.running) void loadSaved(current.source, current.docId);
}

async function loadSaved(source: string, docId: string): Promise<void> {
  try {
    const res = await fetch(`/api/summaries/factcheck/result?${query(source, docId)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as SavedState;
    saved.set(keyOf(source, docId), { result: data.result, stale: data.stale });
    render();
  } catch {
    /* no saved result shown; the button still works */
  }
}

/** Start (or re-start) a check for the document the panel shows. */
export function sumFactcheckStart(): void {
  if (!current) return;
  const { source, docId } = current;
  const key = keyOf(source, docId);
  if (runs.get(key)?.running) return;
  const run: RunState = { rows: [], lede: "", running: true, error: null };
  runs.set(key, run);
  render();
  void stream(source, docId, run).finally(() => {
    run.running = false;
    render();
  });
}

async function stream(source: string, docId: string, run: RunState): Promise<void> {
  const key = keyOf(source, docId);
  let res: Response;
  try {
    res = await fetch(`/api/summaries/factcheck?${query(source, docId)}`, { headers: { accept: "text/event-stream" } });
  } catch (err) {
    run.error = `Fact check failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    run.error = body?.error || `Fact check failed (HTTP ${res.status}).`;
    return;
  }
  let finished = false;
  const parser = makeSseFrameParser((frame) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(frame.data || "{}"); } catch { /* keep {} */ }
    switch (frame.event) {
      case "claims":
        run.rows = ((data.claims as { index: number; title: string }[]) || []).map((c) => ({ index: c.index, title: c.title }));
        break;
      case "claim_result": {
        const row = run.rows.find((r) => r.index === data.index);
        if (row) row.verdict = String(data.verdict || "❓");
        break;
      }
      case "delta":
        run.lede += String(data.text || "");
        break;
      case "app_error":
        run.error = String(data.message || "Fact check failed.");
        break;
      case "done": {
        finished = true;
        if (data.claimCount === 0) {
          // Nothing verified, nothing saved: the earlier result stays shown.
          run.error = "No claim could be verified, so nothing was saved.";
          break;
        }
        const answer = String(data.answer || "");
        const claims = run.rows.map((r) => ({ verdict: r.verdict || "❓" }));
        saved.set(key, {
          result: { answer, claims, createdAt: typeof data.checkedAt === "number" ? data.checkedAt : Date.now() },
          stale: false,
        });
        if (data.saved !== true) run.error = "Checked, but the result could not be saved — it will be gone on reload.";
        void sumFactcheckLoadBadges();
        break;
      }
      default:
        return;
    }
    render();
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch (err) {
    if (!finished) run.error = `Fact check interrupted: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!finished && !run.error) run.error = "The fact check ended without a result.";
}

function render(): void {
  const el = section();
  const btn = document.getElementById(SUM_FACTCHECK_BTN_ID) as HTMLButtonElement | null;
  if (!el || !current) return;
  const key = keyOf(current.source, current.docId);
  const run = runs.get(key);
  const state = saved.get(key);
  if (btn) btn.disabled = !!run?.running;

  if (run?.running) {
    el.hidden = false;
    el.innerHTML =
      head("Fact check", "", '<span class="sum-fc-meta">checking against the web…</span>', false) +
      factcheckProgressHtml(run.rows) +
      (run.lede ? `<div class="sum-fc-lede">${escHtml(run.lede)}</div>` : "") +
      (run.error ? `<div class="sum-fc-err" role="alert">${escHtml(run.error)}</div>` : "");
    return;
  }
  const result = state?.result;
  if (!result && !run?.error) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const meta = result
    ? `<span class="sum-fc-meta">${escHtml(factcheckCheckedLabel(result.createdAt, Date.now()))}</span>` +
      (state?.stale ? '<span class="sum-fc-stale" title="The summary changed since this check">stale</span>' : "")
    : "";
  el.innerHTML =
    head("Fact check", result ? factcheckVerdictChipsHtml(result.claims) : "", meta, true) +
    (run?.error ? `<div class="sum-fc-err" role="alert">${escHtml(run.error)}</div>` : "") +
    (result ? `<div class="sum-fc-answer">${factcheckAnswerHtml(result.answer)}</div>` : "");
  el.querySelectorAll<HTMLAnchorElement>(".sum-fc-answer a[href^='http']").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener";
  });
  el.querySelector(".sum-fc-recheck")?.addEventListener("click", () => sumFactcheckStart());
}

function head(title: string, chips: string, meta: string, recheck: boolean): string {
  return (
    `<div class="sum-fc-head"><span class="sum-fc-title">✓ ${escHtml(title)}</span>` +
    `<span class="sum-fc-chips">${chips}</span>${meta}` +
    (recheck ? '<button type="button" class="sum-fc-recheck" title="Run the fact check again">↻ Re-check</button>' : "") +
    "</div>"
  );
}

// ── Latest rail badges ────────────────────────────────────────────────────

/** Badge markup for a rail row (empty for an unchecked document). */
export function sumFactcheckBadgeHtml(source: string, docId: string): string {
  return factcheckBadgeHtml(badges.get(keyOf(source, docId)));
}

/** Fetch every badge (one request) and patch the rail rows already drawn. */
export async function sumFactcheckLoadBadges(): Promise<void> {
  try {
    const res = await fetch("/api/summaries/factcheck/badges", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { badges?: Array<{ source: string; docId: string } & Badge> };
    badges = new Map((data.badges || []).map((b) => [keyOf(b.source, b.docId), { bad: b.bad, total: b.total }]));
  } catch {
    return;
  }
  document.querySelectorAll<HTMLElement>(".sum-latest-row[data-doc-id]").forEach((row) => {
    const meta = row.querySelector(".sum-latest-meta");
    if (!meta) return;
    meta.querySelector(".sum-fc-badge")?.remove();
    const html = sumFactcheckBadgeHtml(row.dataset.source || "", row.dataset.docId || "");
    if (html) meta.insertAdjacentHTML("beforeend", html);
  });
}
