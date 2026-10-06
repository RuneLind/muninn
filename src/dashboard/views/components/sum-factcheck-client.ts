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
 *
 * The answer arrives as server-rendered HTML (`answer_html` on the stream,
 * `html` on `/result`), so this bundle carries no markdown renderer. So does
 * the transcript check's block (`transcriptHtml` on `/result`, `html` on the
 * transcript POST), whose button shows only when a fresh web result is saved
 * and the document has a transcript (`hasTranscript` on `/result`). While a
 * transcript run is in flight, ↻ Re-check is disabled, a reopen keeps the block
 * the run writes, and an answer for a web result that has since been replaced
 * is dropped.
 */

import { makeSseFrameParser } from "./client-runtime.ts";
import {
  factcheckBadgeHtml,
  factcheckProgressHtml,
  factcheckVerdictChipsHtml,
  type FactcheckProgressRow,
} from "./sum-factcheck-render.ts";
import { escHtml } from "./escape.ts";
import { timeAgo } from "./helpers.ts";
import { DOC_PANEL_FACTCHECK_BTN_ID } from "./doc-panel.ts";

export const SUM_FACTCHECK_SECTION_ID = "sumFactcheck";
export const SUM_FACTCHECK_BTN_ID = DOC_PANEL_FACTCHECK_BTN_ID;

interface SavedClaim { verdict: string }
interface SavedResult { answer: string; html: string | null; claims: SavedClaim[]; createdAt: number }
interface SavedState {
  result: SavedResult | null;
  stale: boolean | null;
  /** `null` when unknown (no saved result yet, or the file was unreadable). */
  hasTranscript: boolean | null;
  transcriptHtml: string | null;
}

/** One transcript check: a single JSON POST. */
interface TranscriptRun { running: boolean; error: string | null }

/** Monotonic order of `/result` reads and transcript writes, per page. */
let seq = 0;
/** Per document: the `seq` at which a transcript POST last wrote its block. */
const transcriptWrittenAt = new Map<string, number>();

interface RunState {
  rows: FactcheckProgressRow[];
  lede: string;
  running: boolean;
  /** The run's notice; it outlives the run until a newer result or run replaces it. */
  error: string | null;
  finishedAt: number;
  /** Set once `done` adopted this run's answer, so its `answer_html` fills it in. */
  adopted: boolean;
}

type Badge = { bad: number; total: number };

const runs = new Map<string, RunState>();
const transcriptRuns = new Map<string, TranscriptRun>();
const saved = new Map<string, SavedState>();
let badges = new Map<string, Badge>();
let current: { source: string; docId: string } | null = null;

const keyOf = (source: string, docId: string) => `${source}\u0000${docId}`;
const query = (source: string, docId: string) =>
  `source=${encodeURIComponent(source)}&docId=${encodeURIComponent(docId)}`;

function section(): HTMLElement | null {
  return document.getElementById(SUM_FACTCHECK_SECTION_ID);
}

/** At the start of an open (`mainEl` null: the article is still loading) and
 *  again once it is rendered. `null` source ⇒ an unregistered one: no button,
 *  no section. */
export function sumFactcheckOnOpen(docId: string, source: string | null, mainEl: HTMLElement | null): void {
  const btn = document.getElementById(SUM_FACTCHECK_BTN_ID) as HTMLButtonElement | null;
  if (btn) btn.hidden = !source;
  current = source ? { source, docId } : null;
  if (!current) return;
  const key = keyOf(current.source, current.docId);
  if (mainEl) {
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
    el.dataset.key = key;
  }
  // A reopen starts without the last transcript run's notice.
  if (mainEl && transcriptRuns.get(key)?.running === false) transcriptRuns.delete(key);
  render();
  // Re-read on every open: a re-run since the last look moves `stale`.
  if (mainEl && !runs.get(key)?.running) void loadSaved(current.source, current.docId);
}

/** Drop a finished transcript run's notice: a new web result supersedes it. */
function clearTranscriptNotice(key: string): void {
  if (transcriptRuns.get(key)?.running === false) transcriptRuns.delete(key);
}

async function loadSaved(source: string, docId: string): Promise<void> {
  const key = keyOf(source, docId);
  const readAt = ++seq;
  try {
    const res = await fetch(`/api/summaries/factcheck/result?${query(source, docId)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      result: (Omit<SavedResult, "html">) | null;
      stale: boolean | null;
      html?: string;
      hasTranscript?: boolean | null;
      transcriptHtml?: string | null;
    };
    const result = data.result ? { ...data.result, html: data.html ?? null } : null;
    const before = saved.get(key);
    // While a transcript run is in flight, or once one wrote its block after
    // this read began, the block on screen is newer than this answer — unless
    // the web result itself changed, which replaces both.
    const sameWebResult = !!before?.result && !!result && before.result.createdAt === result.createdAt;
    const keepTranscript =
      sameWebResult && (!!transcriptRuns.get(key)?.running || (transcriptWrittenAt.get(key) ?? 0) > readAt);
    saved.set(key, {
      result,
      stale: data.stale,
      hasTranscript: data.hasTranscript ?? null,
      transcriptHtml: keepTranscript ? before!.transcriptHtml : (data.transcriptHtml ?? null),
    });
    if (result && before?.result && result.createdAt !== before.result.createdAt) clearTranscriptNotice(key);
    // A result newer than a finished run's notice supersedes it.
    const run = runs.get(key);
    if (run && !run.running && result && result.createdAt > run.finishedAt) runs.delete(key);
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
  // A web run started under a transcript run would replace the claims it checks.
  if (runs.get(key)?.running || transcriptRuns.get(key)?.running) return;
  const run: RunState = { rows: [], lede: "", running: true, error: null, finishedAt: 0, adopted: false };
  runs.set(key, run);
  render();
  void stream(source, docId, run).finally(() => {
    run.running = false;
    run.finishedAt = Date.now();
    render();
    // The stream does not say whether the document has a transcript; a first
    // check on it learns that here, without replacing the adopted result.
    if (run.adopted && saved.get(key)?.hasTranscript == null) void loadTranscriptFlag(source, docId);
  });
}

async function loadTranscriptFlag(source: string, docId: string): Promise<void> {
  const key = keyOf(source, docId);
  try {
    const res = await fetch(`/api/summaries/factcheck/result?${query(source, docId)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { hasTranscript?: boolean | null };
    const state = saved.get(key);
    if (state) state.hasTranscript = data.hasTranscript ?? null;
    render();
  } catch {
    /* no button; a reopen asks again */
  }
}

/** Check the saved claims against the document's transcript. */
export function sumFactcheckTranscriptStart(): void {
  if (!current) return;
  const { source, docId } = current;
  const key = keyOf(source, docId);
  if (transcriptRuns.get(key)?.running || runs.get(key)?.running) return;
  // The web result this run checks; an answer is applied only while it is still the shown one.
  const origin = saved.get(key)?.result?.createdAt;
  if (origin === undefined) return;
  const run: TranscriptRun = { running: true, error: null };
  transcriptRuns.set(key, run);
  render();
  void (async () => {
    try {
      const res = await fetch("/api/summaries/factcheck/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, docId }),
      });
      const data = (await res.json().catch(() => null)) as { html?: string; error?: string } | null;
      if (!res.ok || typeof data?.html !== "string") {
        run.error = data?.error || `Transcript check failed (HTTP ${res.status}).`;
        return;
      }
      const state = saved.get(key);
      if (state?.result?.createdAt !== origin) return;
      state.transcriptHtml = data.html;
      transcriptWrittenAt.set(key, ++seq);
    } catch (err) {
      run.error = `Transcript check failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      run.running = false;
      render();
    }
  })();
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
        // Nothing verified, or a partial re-run over an earlier result: the
        // server saved nothing, and the earlier result stays shown.
        if (data.claimCount === 0) {
          run.error = "No claim could be verified, so nothing was saved.";
          break;
        }
        if (data.reason === "partial") {
          run.error = "Partial run, earlier result kept.";
          break;
        }
        saved.set(key, {
          result: {
            answer: String(data.answer || ""),
            html: null,
            claims: run.rows.map((r) => ({ verdict: r.verdict || "❓" })),
            createdAt: typeof data.checkedAt === "number" ? data.checkedAt : Date.now(),
          },
          stale: false,
          // A new claim set: the server nulled the transcript check with it.
          hasTranscript: saved.get(key)?.hasTranscript ?? null,
          transcriptHtml: null,
        });
        run.adopted = true;
        clearTranscriptNotice(key);
        if (data.saved !== true) run.error = "Checked, but the result could not be saved — it will be gone on reload.";
        void sumFactcheckLoadBadges();
        break;
      }
      case "answer_html": {
        const result = saved.get(key)?.result;
        if (run.adopted && result && typeof data.html === "string") result.html = data.html;
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
  if (!current) return;
  const key = keyOf(current.source, current.docId);
  const run = runs.get(key);
  const state = saved.get(key);
  // The button follows the document the panel is on, even before its article
  // (and so its section) has rendered.
  const btn = document.getElementById(SUM_FACTCHECK_BTN_ID) as HTMLButtonElement | null;
  if (btn) btn.disabled = !!run?.running || !!transcriptRuns.get(key)?.running;

  const el = section();
  if (!el || el.dataset.key !== key) return;
  if (run?.running) {
    el.hidden = false;
    el.innerHTML =
      head("", '<span class="sum-fc-meta">checking against the web…</span>', false) +
      factcheckProgressHtml(run.rows) +
      (run.lede ? `<div class="sum-fc-lede">${escHtml(run.lede)}</div>` : "") +
      notice(run.error);
    return;
  }
  const result = state?.result;
  if (!result && !run?.error) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const tRun = transcriptRuns.get(key);
  const transcriptRunning = !!tRun?.running;
  const meta = result
    ? `<span class="sum-fc-meta">checked ${escHtml(timeAgo(result.createdAt))}</span>` +
      (state?.stale ? '<span class="sum-fc-stale" title="The summary changed since this check">stale</span>' : "")
    : "";
  const transcriptBtn =
    // A stale web check is hidden behind ↻ Re-check: the POST refuses it (409 web_check_stale).
    result && result.claims.length > 0 && state?.hasTranscript && !state.stale
      ? `<button type="button" class="sum-fc-txbtn"${transcriptRunning ? " disabled" : ""} title="Check each claim against the document's transcript">` +
        `${transcriptRunning ? "checking transcript…" : state.transcriptHtml ? "↻ Transcript" : "⧉ Check transcript"}</button>`
      : "";
  el.innerHTML =
    head(result ? factcheckVerdictChipsHtml(result.claims) : "", meta, true, transcriptBtn, transcriptRunning) +
    notice(run?.error ?? null) +
    notice(tRun?.error ?? null) +
    (state?.transcriptHtml ?? "") +
    (result ? `<div class="sum-fc-answer">${result.html ?? escHtml(result.answer)}</div>` : "");
  el.querySelector(".sum-fc-recheck")?.addEventListener("click", () => sumFactcheckStart());
  el.querySelector(".sum-fc-txbtn")?.addEventListener("click", () => sumFactcheckTranscriptStart());
}

function notice(text: string | null): string {
  return text ? `<div class="sum-fc-err" role="alert">${escHtml(text)}</div>` : "";
}

function head(chips: string, meta: string, recheck: boolean, extra = "", recheckDisabled = false): string {
  return (
    '<div class="sum-fc-head"><span class="sum-fc-title">✓ Fact check</span>' +
    `<span class="sum-fc-chips">${chips}</span>${meta}` +
    (recheck
      ? `<button type="button" class="sum-fc-recheck"${recheckDisabled ? ' disabled title="Wait for the transcript check to finish"' : ' title="Run the fact check again"'}>↻ Re-check</button>`
      : "") +
    extra +
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
