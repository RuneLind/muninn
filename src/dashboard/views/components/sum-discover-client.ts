/// <reference lib="dom" />
/**
 * The `/summaries` doc panel's ▶ Find on YouTube section — the DOM half.
 * Published on `globalThis` by `sum-discover-browser.ts`; the page's inline
 * scripts call {@link sumDiscoverOnOpen} where they call `sumLinksOnOpen`.
 *
 * The button shows only on a registered `youtube` document. A click runs one
 * `POST /api/summaries/discover`; each row's Summarize is one click on the
 * existing `POST /api/youtube/summarize` (D2: nothing is captured without it).
 * State is kept per document, so a reopen shows the last list.
 */

import { escHtml } from "./escape.ts";
import { DOC_PANEL_DISCOVER_BTN_ID } from "./doc-panel.ts";

export const SUM_DISCOVER_SECTION_ID = "sumDiscover";

export interface DiscoverRow {
  videoId: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  viewCount: number | null;
  score: number;
  why: string;
  query: string;
}
interface Summarize {
  state: "pending" | "started" | "error";
  text: string;
  href?: string;
}
interface DocState {
  open: boolean;
  loading: boolean;
  results: DiscoverRow[] | null;
  queries: { query: string; why: string }[];
  searched: number;
  known: number;
  error: string | null;
  summarize: Map<string, Summarize>;
}

const states = new Map<string, DocState>();
let current: { source: string; docId: string; key: string } | null = null;

const keyOf = (source: string, docId: string) => `${source}\u0000${docId}`;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function stateFor(key: string): DocState {
  let s = states.get(key);
  if (!s) {
    s = { open: false, loading: false, results: null, queries: [], searched: 0, known: 0, error: null, summarize: new Map() };
    states.set(key, s);
  }
  return s;
}

const button = () => document.getElementById(DOC_PANEL_DISCOVER_BTN_ID) as HTMLButtonElement | null;
const section = () => document.getElementById(SUM_DISCOVER_SECTION_ID);

/** `1:02:03` / `12:34`; empty for an unknown length. */
export function discoverDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** `1.2M views` / `3.4k views` / `812 views`; empty when unknown. */
export function discoverViews(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k views`;
  return `${n} views`;
}

/** At the start of an open (`mainEl` null) and again once the article is rendered. */
export function sumDiscoverOnOpen(docId: string, source: string | null, mainEl: HTMLElement | null): void {
  const btn = button();
  if (source !== "youtube") {
    current = null;
    if (btn) btn.hidden = true;
    section()?.setAttribute("hidden", "");
    return;
  }
  const key = keyOf(source, docId);
  current = { source, docId, key };
  if (btn) btn.hidden = false;
  if (!mainEl) return;
  let el = section();
  if (!el || !mainEl.contains(el)) {
    el?.remove();
    el = document.createElement("section");
    el.id = SUM_DISCOVER_SECTION_ID;
    el.className = "sum-discover";
    el.setAttribute("aria-label", "Find on YouTube");
    const anchor = mainEl.querySelector("#sumLinks") ?? mainEl.querySelector("#sumFactcheck") ?? mainEl.querySelector("#sumArticleBody");
    if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else mainEl.insertBefore(el, mainEl.firstChild);
  }
  el.dataset.key = key;
  el.hidden = !stateFor(key).open;
  render();
}

export function sumDiscoverOnClose(): void {
  current = null;
}

/** The ▶ button. */
export function sumDiscoverStart(): void {
  if (!current) return;
  const { source, docId, key } = current;
  const s = stateFor(key);
  s.open = true;
  const el = section();
  if (el) el.hidden = false;
  if (s.loading) return;
  s.loading = true;
  s.error = null;
  render();
  void (async () => {
    try {
      const res = await fetch("/api/summaries/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, docId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: DiscoverRow[];
        queries?: { query: string; why: string }[];
        searched?: number;
        known?: number;
        error?: string;
      };
      if (!res.ok || !Array.isArray(data.results)) {
        s.error = data.error ?? `The search failed (HTTP ${res.status}).`;
        return;
      }
      s.results = data.results.filter((r) => VIDEO_ID_RE.test(r.videoId));
      s.queries = Array.isArray(data.queries) ? data.queries : [];
      s.searched = data.searched ?? 0;
      s.known = data.known ?? 0;
    } catch {
      s.error = "The search failed: the server did not answer.";
    } finally {
      s.loading = false;
      render();
    }
  })();
}

async function summarize(key: string, row: DiscoverRow): Promise<void> {
  const s = stateFor(key);
  // An error leaves the row retryable; a pending or started one does not post again.
  if (s.summarize.has(row.videoId) && s.summarize.get(row.videoId)!.state !== "error") return;
  s.summarize.set(row.videoId, { state: "pending", text: "Starting…" });
  render();
  const url = `https://www.youtube.com/watch?v=${row.videoId}`;
  let next: Summarize;
  try {
    const res = await fetch("/api/youtube/summarize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: row.title, url, video_id: row.videoId }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      job_id?: string;
      duplicate?: boolean;
      in_flight?: boolean;
      dashboard_url?: string;
      error?: string;
    };
    if (!res.ok) next = { state: "error", text: data.error ?? `Could not start (HTTP ${res.status}).` };
    else if (data.duplicate) next = { state: "started", text: "Already summarized", href: data.dashboard_url };
    else if (data.in_flight) next = { state: "started", text: "Already running", href: data.dashboard_url };
    else next = { state: "started", text: "Started", href: data.dashboard_url };
  } catch {
    next = { state: "error", text: "Could not start: the server did not answer." };
  }
  s.summarize.set(row.videoId, next);
  render();
}

function rowHtml(r: DiscoverRow, sum: Summarize | undefined): string {
  const url = `https://www.youtube.com/watch?v=${r.videoId}`;
  const meta = [r.channel ?? "", discoverDuration(r.durationSec), discoverViews(r.viewCount)].filter(Boolean).join(" · ");
  const href = sum?.href && sum.href.startsWith("/") ? sum.href : null;
  const status = sum
    ? `<span class="sum-discover-status${sum.state === "error" ? " error" : ""}" role="status">${escHtml(sum.text)}${href ? ` <a href="${escHtml(href)}">open</a>` : ""}</span>`
    : "";
  return (
    `<li class="sum-discover-row">` +
    `<div class="sum-discover-line"><a class="sum-discover-title" href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(r.title || r.videoId)}</a>` +
    `<button type="button" class="sum-discover-btn" data-summarize="${escHtml(r.videoId)}"${sum && sum.state !== "error" ? " disabled" : ""}>Summarize</button>${status}</div>` +
    (meta ? `<div class="sum-discover-meta">${escHtml(meta)}</div>` : "") +
    (r.why ? `<div class="sum-discover-why">${escHtml(r.why)}</div>` : "") +
    `</li>`
  );
}

function render(): void {
  const el = section();
  if (!el || !current || el.dataset.key !== current.key) return;
  const s = stateFor(current.key);
  const head =
    `<div class="sum-discover-head"><span class="sum-discover-heading">▶ Find on YouTube</span>` +
    `<button type="button" class="sum-discover-close" data-close aria-label="Close Find on YouTube">×</button></div>`;
  let body = "";
  if (s.loading) body = `<div class="sum-discover-note">Writing search queries, searching YouTube and ranking what is new…</div>`;
  else if (s.results) {
    const qs = s.queries.map((q) => escHtml(q.query)).join(" · ");
    const counts = `${s.searched} found, ${s.known} already summarized`;
    body =
      `<div class="sum-discover-note">${counts}${qs ? `. Searched: ${qs}` : ""}</div>` +
      (s.results.length === 0
        ? `<div class="sum-discover-note">Nothing new worth watching came up.</div>`
        : `<ul class="sum-discover-list">${s.results.map((r) => rowHtml(r, s.summarize.get(r.videoId))).join("")}</ul>`);
  }
  const err = s.error ? `<div class="sum-discover-msg error" role="status">${escHtml(s.error)}</div>` : "";
  el.innerHTML = head + body + err;
}

/** One delegated listener per page, wired by the browser entry. */
export function wireSumDiscover(): void {
  button()?.addEventListener("click", () => sumDiscoverStart());
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    const el = section();
    if (!target || !el || !el.contains(target) || !current) return;
    const btn = target.closest<HTMLElement>("[data-summarize]");
    if (btn) {
      const id = btn.getAttribute("data-summarize") ?? "";
      const row = stateFor(current.key).results?.find((r) => r.videoId === id);
      if (row) void summarize(current.key, row);
      return;
    }
    if (target.closest("[data-close]")) {
      stateFor(current.key).open = false;
      el.hidden = true;
    }
  });
}
