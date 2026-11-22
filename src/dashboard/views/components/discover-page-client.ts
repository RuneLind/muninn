/// <reference lib="dom" />
/**
 * `/summaries/discover` — the DOM half (plan muninn-youtube-discovery, PR 2).
 * Bundled by `discover-page-browser.ts`; the page embeds the stored shelves as
 * JSON (`#dscData`) and this file renders them: one shelf per seed, cards in a
 * row, a details drawer, sort and length filters.
 *
 * Actions: Summarize posts the existing `POST /api/youtube/summarize`, marks the
 * video `queued` and follows the capture job: a capture that fails puts the
 * video back to its earlier state (`summarizeFlow`); ☆ Later toggles `later`;
 * ✕ dismisses with an Undo.
 * Every state write is `POST /api/summaries/discover/state` and applies to the
 * video on every shelf. Opening a card asks `POST /api/summaries/discover/details`
 * once per video (the server probes one at a time and caches).
 */

import { escHtml } from "./escape.ts";
import { bootSeedBar } from "./discover-seed-bar-client.ts";
import type { DiscoverHit, DiscoverHitState, DiscoverShelf, DiscoverVideoDetails } from "../../../db/youtube-discover.ts";

export type DiscoverSort = "score" | "new" | "long" | "short";

/** `1:02:03` / `12:34`; empty for an unknown length. */
export function dscDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** 1.2M, 34K, 999; empty for unknown. */
export function dscCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

/** `YYYYMMDD` → "3 days ago" / "5 months ago" / "2 years ago", against `now` (epoch ms). */
export function dscAge(uploadDate: string | null | undefined, now: number): string {
  if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return "";
  const t = Date.UTC(Number(uploadDate.slice(0, 4)), Number(uploadDate.slice(4, 6)) - 1, Number(uploadDate.slice(6, 8)));
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 365) {
    const m = Math.max(1, Math.round(days / 30));
    return `${m} month${m === 1 ? "" : "s"} ago`;
  }
  const y = Math.floor(days / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

/**
 * The cards a shelf shows: not dismissed, at least `minLen` seconds (an unknown
 * length passes only "any length"), in `sort` order. "Newest upload" sorts by a
 * cached probe's upload date, unknown last; ties keep the stored rank.
 */
export function dscVisibleHits(hits: readonly DiscoverHit[], sort: DiscoverSort, minLen: number): DiscoverHit[] {
  const kept = hits.filter(
    (h) => h.state !== "dismissed" && (minLen <= 0 || (h.durationSec !== null && h.durationSec > minLen)),
  );
  const byRank = (a: DiscoverHit, b: DiscoverHit) => a.rank - b.rank;
  const cmp: Record<DiscoverSort, (a: DiscoverHit, b: DiscoverHit) => number> = {
    score: (a, b) => b.score - a.score || byRank(a, b),
    new: (a, b) => (b.details?.uploadDate ?? "").localeCompare(a.details?.uploadDate ?? "") || byRank(a, b),
    long: (a, b) => (b.durationSec ?? -1) - (a.durationSec ?? -1) || byRank(a, b),
    short: (a, b) => (a.durationSec ?? Infinity) - (b.durationSec ?? Infinity) || byRank(a, b),
  };
  return [...kept].sort(cmp[sort]);
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const thumb = (id: string, q = "mqdefault") => (VIDEO_ID_RE.test(id) ? `https://i.ytimg.com/vi/${id}/${q}.jpg` : "");
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const pct = (score: number) => Math.round(Math.max(0, Math.min(1, score)) * 100);

/** How a followed capture job ended: done, failed (with the job's error), or unknown (the stream dropped). */
export type CaptureEnd = { end: "complete" } | { end: "error"; message: string } | { end: "lost" };

/** Minimal `EventSource`: what {@link followCaptureJob} uses, so a test can drive it. */
export interface CaptureStream {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  onerror: ((e: Event) => void) | null;
  close(): void;
}

/** Follow `/api/youtube/stream/<jobId>` to its end. Never rejects. */
export function followCaptureJob(jobId: string, open: (url: string) => CaptureStream): Promise<CaptureEnd> {
  return new Promise((resolve) => {
    let es: CaptureStream;
    try {
      es = open(`/api/youtube/stream/${encodeURIComponent(jobId)}`);
    } catch {
      return resolve({ end: "lost" });
    }
    let settled = false;
    const done = (end: CaptureEnd) => {
      if (settled) return;
      settled = true;
      es.close();
      resolve(end);
    };
    es.addEventListener("complete", () => done({ end: "complete" }));
    es.addEventListener("error", (e) => {
      // The job's own `error` event carries data; a transport error does not (that is `onerror`).
      const data = (e as MessageEvent).data;
      if (typeof data !== "string") return;
      let message = "the capture failed";
      try {
        const m = (JSON.parse(data) as { message?: unknown }).message;
        if (typeof m === "string" && m) message = m;
      } catch {
        /* keep the default */
      }
      done({ end: "error", message });
    });
    // A dropped stream (the job gone, the server restarted) says nothing about the capture. The job's
    // own `event: error` reaches `onerror` too, as a MessageEvent with data: the listener above has it.
    es.onerror = (e) => {
      if (typeof (e as MessageEvent).data !== "string") done({ end: "lost" });
    };
  });
}

export interface SummarizeFlowDeps {
  start: () => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>;
  setState: (state: DiscoverHitState) => Promise<string | null>;
  follow: (jobId: string) => Promise<CaptureEnd>;
  toast: (msg: string) => void;
  /** Called once the video is marked queued, before the job is followed. */
  queued: () => void;
}

/**
 * Summarize one video: start the capture, mark it `queued`, then follow the job
 * and, when the capture fails, put the video back to `before` with the job's
 * error in a toast (architecture review 2026-11-16, F17: a failed capture left
 * the video `queued` with a disabled button). A duplicate is already captured
 * and is not followed.
 */
export async function summarizeFlow(before: DiscoverHitState, deps: SummarizeFlowDeps): Promise<void> {
  let r: Awaited<ReturnType<SummarizeFlowDeps["start"]>>;
  try {
    r = await deps.start();
  } catch {
    return deps.toast("Could not start: the server did not answer.");
  }
  if (!r.ok) return deps.toast(typeof r.data.error === "string" ? r.data.error : `Could not start (HTTP ${r.status}).`);
  const started = r.data.duplicate ? "Already summarized." : r.data.in_flight ? "Already running." : "Summary started.";
  const err = await deps.setState("queued");
  deps.toast(err ? `${started} Marking it queued failed: ${err}` : started);
  if (err) return;
  deps.queued();
  const jobId = typeof r.data.job_id === "string" ? r.data.job_id : null;
  if (r.data.duplicate || !jobId) return;
  const end = await deps.follow(jobId);
  if (end.end !== "error") return;
  const undoErr = await deps.setState(before);
  deps.toast(
    undoErr
      ? `The summary failed: ${end.message}. It is still marked queued: ${undoErr}`
      : `The summary failed: ${end.message}. You can try again.`,
  );
}

interface PageState {
  shelves: DiscoverShelf[];
  sort: DiscoverSort;
  minLen: number;
  /** The drawer's video and shelf, or null when closed. */
  open: { runId: string; videoId: string } | null;
  playing: boolean;
  details: Map<string, { state: "loading" | "error"; text?: string }>;
  summarizing: Set<string>;
  /** Older shelves the server left out. */
  hidden: number;
}

const st: PageState = {
  shelves: [],
  sort: "score",
  minLen: 0,
  open: null,
  playing: false,
  details: new Map(),
  summarizing: new Set(),
  hidden: 0,
};

const $ = (id: string) => document.getElementById(id);

function eachHit(videoId: string, fn: (h: DiscoverHit) => void): void {
  for (const s of st.shelves) for (const h of s.hits) if (h.videoId === videoId) fn(h);
}
function findHit(videoId: string): { hit: DiscoverHit; shelf: DiscoverShelf } | null {
  const runId = st.open?.videoId === videoId ? st.open.runId : null;
  for (const shelf of st.shelves) {
    if (runId && shelf.runId !== runId) continue;
    const hit = shelf.hits.find((h) => h.videoId === videoId);
    if (hit) return { hit, shelf };
  }
  return null;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Undos the visible toast covers: a second dismissal joins the first's Undo instead of replacing it. */
let pendingUndos: (() => void)[] = [];
function toast(msg: string, undo?: () => void): void {
  const t = $("dscToast");
  if (!t) return;
  if (undo) pendingUndos.push(undo);
  // The live region stays in the page and only its text changes, so the change is announced.
  t.innerHTML = escHtml(msg) + (pendingUndos.length ? ` <button type="button" data-undo>Undo</button>` : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.innerHTML = "";
    pendingUndos = [];
  }, 5000);
  const btn = t.querySelector<HTMLButtonElement>("[data-undo]");
  if (btn)
    btn.onclick = () => {
      t.innerHTML = "";
      const all = pendingUndos;
      pendingUndos = [];
      for (const u of all) u();
    };
}

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/** Write a state; on success apply it to every shelf. Answers the error text, or null when it stuck. */
async function setState(videoId: string, state: DiscoverHitState): Promise<string | null> {
  try {
    const r = await postJson("/api/summaries/discover/state", { videoId, state });
    if (!r.ok) return typeof r.data.error === "string" ? r.data.error : `Could not save (HTTP ${r.status}).`;
  } catch {
    return "Could not save: the server did not answer.";
  }
  eachHit(videoId, (h) => (h.state = state));
  writes.set(videoId, { state, at: performance.now() });
  return null;
}

/** When each video's last state write committed: laid over shelves read before it (see `applyShelves`). */
const writes = new Map<string, { state: DiscoverHitState; at: number }>();
/** Shelves a seed run delivered while the drawer was open: applied when it closes. */
let pendingShelves: { shelves: DiscoverShelf[]; requestedAt: number; hidden: number } | null = null;

/** A replaced shelf's run id → the run of the same seed that replaced it, for focus and Undo. */
const runAlias = new Map<string, string>();
const liveRun = (runId: string): string => {
  let r = runId;
  for (let i = 0; i < 10 && runAlias.has(r); i++) r = runAlias.get(r)!;
  return r;
};

/** Replace the shelves with a fresh read; a write that committed after the read was asked wins over it. */
function applyShelves(shelves: DiscoverShelf[], requestedAt: number, hidden: number): void {
  const seedKey = (s: DiscoverShelf) => `${s.seedSource}\u0000${s.seedDocId}`;
  const bySeed = new Map(shelves.map((s) => [seedKey(s), s.runId]));
  for (const old of st.shelves) {
    const now = bySeed.get(seedKey(old));
    if (now && now !== old.runId) runAlias.set(old.runId, now);
  }
  for (const s of shelves)
    for (const h of s.hits) {
      const w = writes.get(h.videoId);
      if (w && w.at >= requestedAt) h.state = w.state;
    }
  st.shelves = shelves;
  st.hidden = hidden;
}

/** Videos with a Later or Dismiss write in flight: a second click waits for the first. */
const writing = new Set<string>();

function scoreHtml(h: DiscoverHit): string {
  return `<div class="dsc-score"><span class="dsc-bar"><i style="width:${pct(h.score)}%"></i></span>${pct(h.score)}% match</div>`;
}

function actionsHtml(h: DiscoverHit, inDrawer: boolean): string {
  // aria-disabled, not disabled: a disabled button drops the focus it holds (summarize() ignores the press).
  const sum =
    h.state === "queued"
      ? `<button type="button" class="dsc-btn dsc-done" data-act="sum" aria-disabled="true">✓ Queued</button>`
      : `<button type="button" class="dsc-btn dsc-primary" data-act="sum"${st.summarizing.has(h.videoId) ? ` aria-disabled="true"` : ""}>Summarize</button>`;
  // A queued video is summarized: Later would take it out of the known set.
  const later =
    h.state === "queued"
      ? ""
      : h.state === "later"
      ? `<button type="button" class="dsc-btn dsc-done" data-act="later" aria-pressed="true" title="Saved for later">★${inDrawer ? " Saved" : ""}</button>`
      : `<button type="button" class="dsc-btn" data-act="later" aria-pressed="false" title="Save for later">☆ Later</button>`;
  const open = `<a class="dsc-btn" data-fk="open" href="${escHtml(watchUrl(h.videoId))}" target="_blank" rel="noopener" title="Open on YouTube">${inDrawer ? "Open ↗" : "↗"}</a>`;
  const dismiss = inDrawer ? `<button type="button" class="dsc-btn" data-act="dismiss">✕ Not interested</button>` : "";
  return `<div class="dsc-actions">${sum}${later}${open}${dismiss}</div>`;
}

function cardHtml(h: DiscoverHit, shelf: DiscoverShelf): string {
  const meta = [h.channel ?? "", h.viewCount !== null ? `${dscCount(h.viewCount)} views` : ""].filter(Boolean).join(" · ");
  const sel = st.open && st.open.runId === shelf.runId && st.open.videoId === h.videoId ? " dsc-sel" : "";
  return (
    `<article class="dsc-card${sel}" tabindex="0" data-run="${escHtml(shelf.runId)}" data-video="${escHtml(h.videoId)}" aria-label="${escHtml(h.title || h.videoId)}">` +
    `<div class="dsc-thumb"><img loading="lazy" src="${escHtml(thumb(h.videoId))}" alt="">` +
    (h.durationSec !== null ? `<span class="dsc-dur">${escHtml(dscDuration(h.durationSec))}</span>` : "") +
    `<button type="button" class="dsc-x" data-act="dismiss" title="Not interested" aria-label="Not interested">✕</button></div>` +
    `<div class="dsc-body"><div class="dsc-title">${escHtml(h.title || h.videoId)}</div>` +
    (meta ? `<div class="dsc-meta">${escHtml(meta)}</div>` : "") +
    scoreHtml(h) +
    (h.why ? `<div class="dsc-why">${escHtml(h.why)}</div>` : "") +
    actionsHtml(h, false) +
    `</div></article>`
  );
}

function shelfHtml(shelf: DiscoverShelf): string {
  const rows = dscVisibleHits(shelf.hits, st.sort, st.minLen);
  const dismissed = shelf.hits.filter((h) => h.state === "dismissed").length;
  const because = ["Because you captured", shelf.seedCategory ?? "", shelf.seedDate ?? ""].filter(Boolean).join(" · ");
  const seedHref = `/summaries?doc=${encodeURIComponent(shelf.seedDocId)}&source=${encodeURIComponent(shelf.seedSource)}`;
  const failed = shelf.failed > 0;
  const empty =
    shelf.hits.length === 0
      ? failed
        ? "This search failed before it found anything."
        : "Nothing new worth watching came up."
      : dismissed === shelf.hits.length
        ? "All dismissed."
        : "Nothing at this length.";
  return (
    `<section class="dsc-shelf" id="run-${escHtml(shelf.runId)}" data-run="${escHtml(shelf.runId)}">` +
    `<div class="dsc-shelf-head">` +
    (shelf.seedVideoId ? `<img src="${escHtml(thumb(shelf.seedVideoId))}" alt="">` : "") +
    `<div><div class="dsc-because">${escHtml(because)}</div>` +
    `<h3><a data-fk="seed" href="${escHtml(seedHref)}">${escHtml(shelf.seedTitle)}</a></h3>` +
    `<div class="dsc-meta">${shelf.searched} videos searched · ${shelf.known} you already have · ${rows.length} shown · ${escHtml(new Date(shelf.createdAt).toISOString().slice(0, 10))}</div>` +
    `<div class="dsc-qs">${shelf.queries.map((q) => `<span class="dsc-q" title="${escHtml(q.why)}">${escHtml(q.query)}</span>`).join("")}</div>` +
    (failed ? `<div class="dsc-note dsc-warn">${escHtml(dscFailedNote(shelf))}</div>` : "") +
    `</div></div>` +
    (rows.length ? `<div class="dsc-row">${rows.map((h) => cardHtml(h, shelf)).join("")}</div>` : `<div class="dsc-empty">${empty}</div>`) +
    `</section>`
  );
}

/** A failed run's line: how many calls failed, and that the weekly run retries a seed whose newest run failed. */
export function dscFailedNote(shelf: Pick<DiscoverShelf, "failed">): string {
  const n = shelf.failed;
  return `${n} call${n === 1 ? "" : "s"} of this search failed (a YouTube search, or the model). The weekly discovery searches this summary again.`;
}

/** The line under the shelves when older ones were left out (F18). */
export function dscHiddenNote(hidden: number): string {
  if (hidden <= 0) return "";
  return `${hidden} older shel${hidden === 1 ? "f is" : "ves are"} not shown. A shelf holding a video saved for Later is always shown.`;
}

/** What has focus, by identity rather than node: a render replaces the nodes. */
interface FocusKey {
  inDrawer: boolean;
  run?: string;
  video?: string;
  act?: string;
  /** The card's neighbours in its row, for when the card itself is gone. */
  next?: string;
  prev?: string;
}
function focusKey(): FocusKey | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return null;
  const inDrawer = !!a.closest("#dscDrawer");
  const card = inDrawer
    ? renderedOpen && cardEl(renderedOpen.runId, renderedOpen.videoId)
    : a.closest<HTMLElement>(".dsc-card");
  return {
    inDrawer,
    run: a.closest<HTMLElement>("[data-run]")?.dataset.run,
    video: a.closest<HTMLElement>("[data-video]")?.dataset.video,
    // Every focusable the page renders carries `data-act` or `data-fk`: a render finds it again by that key.
    act: a.dataset.act ?? a.dataset.fk,
    next: (card?.nextElementSibling as HTMLElement | null)?.dataset.video,
    prev: (card?.previousElementSibling as HTMLElement | null)?.dataset.video,
  };
}
function cardEl(run: string, video: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.dsc-card[data-run="${CSS.escape(run)}"][data-video="${CSS.escape(video)}"]`);
}
const byKey = (key: string) => `[data-act="${CSS.escape(key)}"], [data-fk="${CSS.escape(key)}"]`;

function restoreFocus(k: FocusKey | null, prevOpen: PageState["open"]): void {
  if (!k) return;
  const dr = $("dscDrawer");
  if (k.inDrawer && dr && !dr.hidden) {
    (dr.querySelector<HTMLElement>(k.act ? byKey(k.act) : ".dsc-close") ?? dr.querySelector<HTMLElement>(".dsc-close"))?.focus();
    return;
  }
  // The drawer closed under the focus (a dismiss from it): go back to its shelf, or the run that replaced it.
  const run0 = k.inDrawer ? prevOpen?.runId : k.run;
  const run = run0 ? liveRun(run0) : run0;
  const video = k.inDrawer ? prevOpen?.videoId : k.video;
  if (!run) return;
  const card = video ? cardEl(run, video) : null;
  // A gone card hands focus to its neighbour, never the row's first card: focusing that scrolls the row back.
  const neighbour = (k.next ? cardEl(run, k.next) : null) ?? (k.prev ? cardEl(run, k.prev) : null);
  const shelfSel = `.dsc-shelf[data-run="${CSS.escape(run)}"]`;
  const target =
    (card && k.act && !k.inDrawer ? card.querySelector<HTMLElement>(byKey(k.act)) : null) ??
    // A shelf control outside the cards (the seed link).
    (!video && k.act ? document.querySelector<HTMLElement>(`${shelfSel} :is(${byKey(k.act)})`) : null) ??
    card ??
    neighbour ??
    // The shelf itself was replaced (a newer run of its seed): the same video on any shelf.
    (video ? document.querySelector<HTMLElement>(`.dsc-card[data-video="${CSS.escape(video)}"]`) : null) ??
    document.querySelector<HTMLElement>(`${shelfSel} .dsc-card`) ??
    document.querySelector<HTMLElement>(`${shelfSel} h3 a`);
  target?.focus({ preventScroll: true });
}

/** The open drawer's shelf and video at the last render, for focus after it closes. */
let renderedOpen: PageState["open"] = null;

function render(): void {
  const main = $("dscMain");
  if (!main) return;
  if (!st.open && pendingShelves) {
    const p = pendingShelves;
    pendingShelves = null;
    applyShelves(p.shelves, p.requestedAt, p.hidden);
  }
  const shown = st.shelves.reduce((n, s) => n + dscVisibleHits(s.hits, st.sort, st.minLen).length, 0);
  const count = $("dscCount");
  if (count)
    count.textContent =
      `${shown} suggestion${shown === 1 ? "" : "s"} on ${st.shelves.length} shel${st.shelves.length === 1 ? "f" : "ves"}` +
      (st.hidden > 0 ? ` · ${st.hidden} older not shown` : "");
  const focus = focusKey();
  const scroll = new Map<string, number>();
  main.querySelectorAll<HTMLElement>(".dsc-shelf").forEach((sh) => {
    const row = sh.querySelector<HTMLElement>(".dsc-row");
    if (row && sh.dataset.run) scroll.set(sh.dataset.run, row.scrollLeft);
  });
  main.innerHTML =
    st.shelves.length === 0
      ? `<div class="dsc-empty">No shelves yet. Use Search from above, or open a YouTube summary on <a href="/summaries">Summaries</a> and press ▶ Find on YouTube: each search is kept here as a shelf.</div>`
      : st.shelves.map(shelfHtml).join("") + (st.hidden > 0 ? `<div class="dsc-empty dsc-older">${escHtml(dscHiddenNote(st.hidden))}</div>` : "");
  main.querySelectorAll<HTMLElement>(".dsc-shelf").forEach((sh) => {
    const left = sh.dataset.run ? scroll.get(sh.dataset.run) : undefined;
    const row = sh.querySelector<HTMLElement>(".dsc-row");
    if (row && left) row.scrollLeft = left;
  });
  const prevOpen = renderedOpen;
  renderDrawer();
  renderedOpen = st.open;
  restoreFocus(focus, prevOpen);
}

/** The drawer's HTML; `bodyOnly` leaves the player out, so a playing video survives a re-render. */
function detailHtml(hit: DiscoverHit, shelf: DiscoverShelf, bodyOnly = false): string {
  const d: DiscoverVideoDetails | null = hit.details;
  const player = st.playing
    ? `<div class="dsc-player" tabindex="-1" data-fk="player" role="group" aria-label="Video player"><iframe src="https://www.youtube-nocookie.com/embed/${escHtml(hit.videoId)}?autoplay=1" title="${escHtml(hit.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
    : `<div class="dsc-player"><img src="${escHtml(thumb(hit.videoId, "hqdefault"))}" alt=""><button type="button" class="dsc-play" data-act="play" aria-label="Play here">▶</button></div>`;
  const stats: string[] = [];
  if (hit.durationSec !== null) stats.push(`<span class="dsc-stat"><b>${escHtml(dscDuration(hit.durationSec))}</b> long</span>`);
  const views = dscCount(d?.viewCount ?? hit.viewCount);
  if (views) stats.push(`<span class="dsc-stat"><b>${views}</b> views</span>`);
  const likes = dscCount(d?.likeCount);
  if (likes) stats.push(`<span class="dsc-stat"><b>${likes}</b> likes</span>`);
  const subs = dscCount(d?.channelFollowerCount);
  if (subs) stats.push(`<span class="dsc-stat"><b>${subs}</b> subscribers</span>`);
  const age = dscAge(d?.uploadDate, Date.now());
  if (age) stats.push(`<span class="dsc-stat">uploaded <b>${escHtml(age)}</b></span>`);
  stats.push(`<span class="dsc-stat"><b>${pct(hit.score)}%</b> match</span>`);
  const load = st.details.get(hit.videoId);
  // The details slot keeps one focus key (`details`) through loading, Try again and the answer.
  const slot = ` tabindex="-1" data-fk="details"`;
  let more = "";
  if (d) {
    if (d.chapters.length)
      more += `<div><h4>Chapters</h4><ul class="dsc-chapters">${d.chapters.map((c) => `<li><span>${escHtml(dscDuration(c.start))}</span>${escHtml(c.title)}</li>`).join("")}</ul></div>`;
    if (d.description) more += `<div><h4>Description</h4><div class="dsc-desc">${escHtml(d.description)}</div></div>`;
    if (d.tags.length) more += `<div class="dsc-qs">${d.tags.map((t) => `<span class="dsc-q">#${escHtml(t)}</span>`).join("")}</div>`;
    if (!more) more = `<div class="dsc-note">YouTube lists no chapters or description for this video.</div>`;
    more = more.replace(/^<div/, `<div${slot}`);
  } else if (load?.state === "error") {
    more = `<div class="dsc-note dsc-warn" role="status">${escHtml(load.text ?? "Could not load the details.")} <button type="button" class="dsc-btn" data-act="details">Try again</button></div>`;
  } else {
    more = `<div class="dsc-note" role="status"${slot}>Loading the description and chapters…</div>`;
  }
  const bodyHtml = detailBodyHtml(hit, shelf, stats, more);
  if (bodyOnly) return bodyHtml;
  return (
    `<div class="dsc-detail">${player}${bodyHtml}</div>`
  );
}

function detailBodyHtml(hit: DiscoverHit, shelf: DiscoverShelf, stats: string[], more: string): string {
  return (
    `<div class="dsc-detail-body">` +
    `<h3 id="dscDrawerTitle">${escHtml(hit.title || hit.videoId)}</h3>` +
    (hit.channel ? `<div class="dsc-meta">${escHtml(hit.channel)}</div>` : "") +
    `<div class="dsc-stats">${stats.join("")}</div>` +
    (hit.why ? `<div class="dsc-box"><div class="dsc-lbl">Why it was picked</div>${escHtml(hit.why)}</div>` : "") +
    `<div class="dsc-from">Found from <b>${escHtml(shelf.seedTitle)}</b>${hit.query ? ` by the search <span class="dsc-q">${escHtml(hit.query)}</span>` : ""}</div>` +
    actionsHtml(hit, true) +
    more +
    `</div>`
  );
}

/** Everything but the dialog, its backdrop, the toast and the announcer is inert while the dialog is open (the nav included). */
function setModal(open: boolean): void {
  const keep = new Set(["dscDrawer", "dscDrawerBg", "dscToast", "dscAnnounce"]);
  for (const el of Array.from(document.body.children)) {
    if (el instanceof HTMLElement && !keep.has(el.id) && el.tagName !== "SCRIPT") el.inert = open;
  }
  document.body.style.overflow = open ? "hidden" : "";
}

function renderDrawer(): void {
  const dr = $("dscDrawer");
  const bg = $("dscDrawerBg");
  if (!dr || !bg) return;
  const found = st.open ? findHit(st.open.videoId) : null;
  if (!st.open || !found) {
    abortDetails();
    dr.hidden = true;
    bg.hidden = true;
    dr.innerHTML = "";
    delete dr.dataset.video;
    setModal(false);
    return;
  }
  const body = dr.querySelector(".dsc-detail-body");
  const sameVideo = dr.dataset.video === found.hit.videoId && dr.dataset.playing === String(st.playing);
  if (sameVideo && body) body.outerHTML = detailHtml(found.hit, found.shelf, true);
  else
    dr.innerHTML =
      `<button type="button" class="dsc-btn dsc-close" data-act="close">✕ Close</button>` + detailHtml(found.hit, found.shelf);
  dr.dataset.video = found.hit.videoId;
  dr.dataset.playing = String(st.playing);
  dr.hidden = false;
  bg.hidden = false;
  setModal(true);
}

/** The drawer's details request: aborted when the drawer closes or another video opens, so the server drops its probe. */
let detailsRequest: { videoId: string; ctl: AbortController } | null = null;
function abortDetails(): void {
  if (!detailsRequest) return;
  detailsRequest.ctl.abort();
  st.details.delete(detailsRequest.videoId);
  detailsRequest = null;
}

async function loadDetails(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found || found.hit.details || st.details.get(videoId)?.state === "loading") return;
  st.details.set(videoId, { state: "loading" });
  const ctl = new AbortController();
  detailsRequest = { videoId, ctl };
  renderDrawer();
  let next: { state: "error"; text: string } | null = null;
  try {
    const r = await postJson("/api/summaries/discover/details", { videoId }, ctl.signal);
    const details = r.data.details as DiscoverVideoDetails | undefined;
    if (r.ok && details) eachHit(videoId, (h) => (h.details = details));
    else next = { state: "error", text: typeof r.data.error === "string" ? r.data.error : `Could not load the details (HTTP ${r.status}).` };
  } catch {
    if (ctl.signal.aborted) return;
    next = { state: "error", text: "Could not load the details: the server did not answer." };
  }
  if (detailsRequest?.ctl === ctl) detailsRequest = null;
  if (next) st.details.set(videoId, next);
  else st.details.delete(videoId);
  if (st.open?.videoId === videoId) render();
}

function openDrawer(runId: string, videoId: string): void {
  if (detailsRequest && detailsRequest.videoId !== videoId) abortDetails();
  st.open = { runId, videoId };
  st.playing = false;
  render();
  void loadDetails(videoId);
  $("dscDrawer")?.querySelector<HTMLElement>(".dsc-close")?.focus();
}

function closeDrawer(): void {
  const prev = st.open;
  st.open = null;
  st.playing = false;
  render();
  if (prev) cardEl(liveRun(prev.runId), prev.videoId)?.focus();
}

async function summarize(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found || st.summarizing.has(videoId) || found.hit.state === "queued") return;
  st.summarizing.add(videoId);
  render();
  const title = found.hit.title;
  let released = false;
  // The row shows ✓ Queued while the job runs; a failure re-renders it as Summarize.
  const release = () => {
    if (released) return;
    released = true;
    st.summarizing.delete(videoId);
    render();
  };
  await summarizeFlow(found.hit.state, {
    start: () => postJson("/api/youtube/summarize", { title, url: watchUrl(videoId), video_id: videoId }),
    setState: (state) => setState(videoId, state),
    follow: (jobId) => followCaptureJob(jobId, (url) => new EventSource(url)),
    toast,
    queued: release,
  });
  release();
  render();
}

async function dismiss(videoId: string, fromRun?: string): Promise<void> {
  const found = findHit(videoId);
  if (!found || writing.has(videoId)) return;
  const before = found.hit.state;
  const runId = fromRun ?? found.shelf.runId;
  writing.add(videoId);
  const err = await setState(videoId, "dismissed");
  writing.delete(videoId);
  if (err) return toast(err);
  if (st.open?.videoId === videoId) st.open = null;
  render();
  toast("Dismissed. It won't be suggested again.", () => {
    void setState(videoId, before).then((undoErr) => {
      if (undoErr) toast(undoErr);
      render();
      if (undoErr) return;
      const run = liveRun(runId);
      const card = cardEl(run, videoId) ?? document.querySelector<HTMLElement>(`.dsc-card[data-video="${CSS.escape(videoId)}"]`);
      // No card shown, yet a shelf holds the video undismissed: only the length filter hides it then.
      const held = st.shelves.some((s) => s.hits.some((h) => h.videoId === videoId && h.state !== "dismissed"));
      if (!card && !st.open && held) toast("Restored, but the length filter hides it.");
      // The Undo button went with its click: place the focus it dropped, never take focus moved meanwhile.
      const a = document.activeElement;
      if (a && a !== document.body) return;
      // With the drawer open the card is behind the modal: stay in the drawer.
      if (st.open) return $("dscDrawer")?.querySelector<HTMLElement>(".dsc-close")?.focus();
      // Otherwise the card it brought back, on its shelf (or the run that replaced it) or any shelf; a card the
      // length filter hides leaves its shelf's seed link.
      (card ?? document.querySelector<HTMLElement>(`.dsc-shelf[data-run="${CSS.escape(run)}"] [data-fk="seed"]`))?.focus();
    });
  });
}

async function toggleLater(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found || found.hit.state === "queued" || writing.has(videoId)) return;
  writing.add(videoId);
  const err = await setState(videoId, found.hit.state === "later" ? "new" : "later");
  writing.delete(videoId);
  if (err) toast(err);
  render();
}

function act(name: string, videoId: string, runId?: string): void {
  if (name === "sum") void summarize(videoId);
  else if (name === "later") void toggleLater(videoId);
  else if (name === "dismiss") void dismiss(videoId, runId);
  else if (name === "details") {
    // loadDetails re-renders only the drawer: the Try again button is gone, so follow the slot's key.
    const focus = focusKey();
    st.details.delete(videoId);
    void loadDetails(videoId);
    restoreFocus(focus, st.open);
  } else if (name === "play") {
    st.playing = true;
    renderDrawer();
    // The Play button is gone: focus the player's box, inside the dialog. Not the
    // iframe: a cross-origin frame keeps the keys, so Escape would stop closing the drawer.
    $("dscDrawer")?.querySelector<HTMLElement>(".dsc-player")?.focus();
  }
}

function focusHashShelf(): void {
  const m = /^#run-([0-9a-f-]{36})$/i.exec(location.hash);
  document.querySelectorAll(".dsc-shelf.dsc-target").forEach((el) => el.classList.remove("dsc-target"));
  if (!m) return;
  const el = document.getElementById(`run-${m[1]}`);
  if (!el) return;
  el.classList.add("dsc-target");
  el.scrollIntoView({ block: "start" });
}

export function bootDiscoverPage(): void {
  try {
    const data = JSON.parse($("dscData")?.textContent ?? "{}") as { shelves?: DiscoverShelf[]; hidden?: number };
    st.shelves = Array.isArray(data.shelves) ? data.shelves : [];
    st.hidden = typeof data.hidden === "number" ? data.hidden : 0;
  } catch {
    st.shelves = [];
  }
  const sortSel = $("dscSort") as HTMLSelectElement | null;
  const lenSel = $("dscLen") as HTMLSelectElement | null;
  sortSel?.addEventListener("change", () => {
    st.sort = sortSel.value as DiscoverSort;
    render();
  });
  lenSel?.addEventListener("change", () => {
    st.minLen = Number(lenSel.value) || 0;
    render();
  });
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.id === "dscDrawerBg") return closeDrawer();
    const actEl = target.closest<HTMLElement>("[data-act]");
    if (actEl) {
      if (actEl.dataset.act === "close") return closeDrawer();
      const host = actEl.closest<HTMLElement>("[data-video]");
      const videoId = host?.dataset.video ?? st.open?.videoId;
      if (videoId) {
        e.stopPropagation();
        // A card's shelf, not the first shelf holding the video (the drawer has none: findHit uses its run).
        act(actEl.dataset.act ?? "", videoId, actEl.closest<HTMLElement>(".dsc-card")?.dataset.run);
      }
      return;
    }
    if (target.closest("a")) return;
    const card = target.closest<HTMLElement>(".dsc-card");
    if (card?.dataset.run && card.dataset.video) openDrawer(card.dataset.run, card.dataset.video);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.open) return closeDrawer();
    const card = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".dsc-card");
    if (card && (e.key === "Enter" || e.key === " ") && e.target === card && card.dataset.run && card.dataset.video) {
      e.preventDefault();
      openDrawer(card.dataset.run, card.dataset.video);
    }
  });
  window.addEventListener("hashchange", focusHashShelf);
  bootSeedBar(
    (shelves, requestedAt, hidden) => {
    // The drawer is a modal over the shelves: swap them in when it closes, not under it.
    if (st.open) {
      pendingShelves = { shelves, requestedAt, hidden };
      return;
    }
    applyShelves(shelves, requestedAt, hidden);
    render();
    },
    (msg) => {
      // Its own live region: the toast may be holding someone's Undo.
      const a = $("dscAnnounce");
      if (a) a.textContent = msg;
    },
  );
  render();
  focusHashShelf();
}
