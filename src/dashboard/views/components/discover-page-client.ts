/// <reference lib="dom" />
/**
 * `/summaries/discover` — the DOM half (plan muninn-youtube-discovery, PR 2).
 * Bundled by `discover-page-browser.ts`; the page embeds the stored shelves as
 * JSON (`#dscData`) and this file renders them: one shelf per seed, cards in a
 * row, a details drawer, sort and length filters.
 *
 * Actions: Summarize posts the existing `POST /api/youtube/summarize` and then
 * marks the video `queued`; ☆ Later toggles `later`; ✕ dismisses with an Undo.
 * Every state write is `POST /api/summaries/discover/state` and applies to the
 * video on every shelf. Opening a card asks `POST /api/summaries/discover/details`
 * once per video (the server probes one at a time and caches).
 */

import { escHtml } from "./escape.ts";
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

interface PageState {
  shelves: DiscoverShelf[];
  sort: DiscoverSort;
  minLen: number;
  /** The drawer's video and shelf, or null when closed. */
  open: { runId: string; videoId: string } | null;
  playing: boolean;
  details: Map<string, { state: "loading" | "error"; text?: string }>;
  summarizing: Set<string>;
}

const st: PageState = {
  shelves: [],
  sort: "score",
  minLen: 0,
  open: null,
  playing: false,
  details: new Map(),
  summarizing: new Set(),
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
function toast(msg: string, undo?: () => void): void {
  const t = $("dscToast");
  if (!t) return;
  t.innerHTML = escHtml(msg) + (undo ? ` <button type="button" data-undo>Undo</button>` : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
  const btn = t.querySelector<HTMLButtonElement>("[data-undo]");
  if (btn && undo)
    btn.onclick = () => {
      t.hidden = true;
      undo();
    };
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/** Write a state; on success apply it to every shelf. Answers whether it stuck. */
async function setState(videoId: string, state: DiscoverHitState): Promise<boolean> {
  try {
    const r = await postJson("/api/summaries/discover/state", { videoId, state });
    if (!r.ok) {
      toast(typeof r.data.error === "string" ? r.data.error : `Could not save (HTTP ${r.status}).`);
      return false;
    }
  } catch {
    toast("Could not save: the server did not answer.");
    return false;
  }
  eachHit(videoId, (h) => (h.state = state));
  return true;
}

function scoreHtml(h: DiscoverHit): string {
  return `<div class="dsc-score"><span class="dsc-bar"><i style="width:${pct(h.score)}%"></i></span>${pct(h.score)}% match</div>`;
}

function actionsHtml(h: DiscoverHit, inDrawer: boolean): string {
  const sum =
    h.state === "queued"
      ? `<button type="button" class="dsc-btn dsc-done" disabled>✓ Queued</button>`
      : `<button type="button" class="dsc-btn dsc-primary" data-act="sum"${st.summarizing.has(h.videoId) ? " disabled" : ""}>Summarize</button>`;
  const later =
    h.state === "later"
      ? `<button type="button" class="dsc-btn dsc-done" data-act="later" aria-pressed="true" title="Saved for later">★${inDrawer ? " Saved" : ""}</button>`
      : `<button type="button" class="dsc-btn" data-act="later" aria-pressed="false" title="Save for later">☆ Later</button>`;
  const open = `<a class="dsc-btn" href="${escHtml(watchUrl(h.videoId))}" target="_blank" rel="noopener" title="Open on YouTube">${inDrawer ? "Open ↗" : "↗"}</a>`;
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
  const empty =
    shelf.hits.length === 0
      ? "Nothing new worth watching came up."
      : dismissed === shelf.hits.length
        ? "All dismissed."
        : "Nothing at this length.";
  return (
    `<section class="dsc-shelf" id="run-${escHtml(shelf.runId)}" data-run="${escHtml(shelf.runId)}">` +
    `<div class="dsc-shelf-head">` +
    (shelf.seedVideoId ? `<img src="${escHtml(thumb(shelf.seedVideoId))}" alt="">` : "") +
    `<div><div class="dsc-because">${escHtml(because)}</div>` +
    `<h3><a href="${escHtml(seedHref)}">${escHtml(shelf.seedTitle)}</a></h3>` +
    `<div class="dsc-meta">${shelf.searched} videos searched · ${shelf.known} you already have · ${shelf.hits.length - dismissed} shown · ${escHtml(new Date(shelf.createdAt).toISOString().slice(0, 10))}</div>` +
    `<div class="dsc-qs">${shelf.queries.map((q) => `<span class="dsc-q" title="${escHtml(q.why)}">${escHtml(q.query)}</span>`).join("")}</div>` +
    `</div></div>` +
    `<div class="dsc-row">${rows.map((h) => cardHtml(h, shelf)).join("") || `<div class="dsc-empty">${empty}</div>`}</div>` +
    `</section>`
  );
}

function render(): void {
  const main = $("dscMain");
  if (!main) return;
  const shown = st.shelves.reduce((n, s) => n + dscVisibleHits(s.hits, st.sort, st.minLen).length, 0);
  const count = $("dscCount");
  if (count) count.textContent = `${shown} suggestion${shown === 1 ? "" : "s"} on ${st.shelves.length} shel${st.shelves.length === 1 ? "f" : "ves"}`;
  main.innerHTML =
    st.shelves.length === 0
      ? `<div class="dsc-empty">No shelves yet. Open a YouTube summary on <a href="/summaries">Summaries</a> and press ▶ Find on YouTube: each search is kept here as a shelf.</div>`
      : st.shelves.map(shelfHtml).join("");
  renderDrawer();
}

function detailHtml(hit: DiscoverHit, shelf: DiscoverShelf): string {
  const d: DiscoverVideoDetails | null = hit.details;
  const player = st.playing
    ? `<div class="dsc-player"><iframe src="https://www.youtube-nocookie.com/embed/${escHtml(hit.videoId)}?autoplay=1" title="${escHtml(hit.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
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
  let more = "";
  if (d) {
    if (d.chapters.length)
      more += `<div><h4>Chapters</h4><ul class="dsc-chapters">${d.chapters.map((c) => `<li><span>${escHtml(dscDuration(c.start))}</span>${escHtml(c.title)}</li>`).join("")}</ul></div>`;
    if (d.description) more += `<div><h4>Description</h4><div class="dsc-desc">${escHtml(d.description)}</div></div>`;
    if (d.tags.length) more += `<div class="dsc-qs">${d.tags.map((t) => `<span class="dsc-q">#${escHtml(t)}</span>`).join("")}</div>`;
    if (!more) more = `<div class="dsc-note">YouTube lists no chapters or description for this video.</div>`;
  } else if (load?.state === "error") {
    more = `<div class="dsc-note dsc-warn" role="status">${escHtml(load.text ?? "Could not load the details.")} <button type="button" class="dsc-btn" data-act="details">Try again</button></div>`;
  } else {
    more = `<div class="dsc-note" role="status">Loading the description and chapters…</div>`;
  }
  return (
    `<div class="dsc-detail">${player}<div class="dsc-detail-body">` +
    `<h3>${escHtml(hit.title || hit.videoId)}</h3>` +
    (hit.channel ? `<div class="dsc-meta">${escHtml(hit.channel)}</div>` : "") +
    `<div class="dsc-stats">${stats.join("")}</div>` +
    (hit.why ? `<div class="dsc-box"><div class="dsc-lbl">Why it was picked</div>${escHtml(hit.why)}</div>` : "") +
    `<div class="dsc-from">Found from <b>${escHtml(shelf.seedTitle)}</b>${hit.query ? ` by the search <span class="dsc-q">${escHtml(hit.query)}</span>` : ""}</div>` +
    actionsHtml(hit, true) +
    more +
    `</div></div>`
  );
}

function renderDrawer(): void {
  const dr = $("dscDrawer");
  const bg = $("dscDrawerBg");
  if (!dr || !bg) return;
  const found = st.open ? findHit(st.open.videoId) : null;
  if (!st.open || !found) {
    dr.hidden = true;
    bg.hidden = true;
    dr.innerHTML = "";
    return;
  }
  dr.innerHTML =
    `<button type="button" class="dsc-btn dsc-close" data-act="close">✕ Close</button>` + detailHtml(found.hit, found.shelf);
  dr.dataset.video = found.hit.videoId;
  dr.hidden = false;
  bg.hidden = false;
}

async function loadDetails(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found || found.hit.details || st.details.get(videoId)?.state === "loading") return;
  st.details.set(videoId, { state: "loading" });
  renderDrawer();
  let next: { state: "error"; text: string } | null = null;
  try {
    const r = await postJson("/api/summaries/discover/details", { videoId });
    const details = r.data.details as DiscoverVideoDetails | undefined;
    if (r.ok && details) eachHit(videoId, (h) => (h.details = details));
    else next = { state: "error", text: typeof r.data.error === "string" ? r.data.error : `Could not load the details (HTTP ${r.status}).` };
  } catch {
    next = { state: "error", text: "Could not load the details: the server did not answer." };
  }
  if (next) st.details.set(videoId, next);
  else st.details.delete(videoId);
  if (st.open?.videoId === videoId) render();
}

function openDrawer(runId: string, videoId: string): void {
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
  if (prev) document.querySelector<HTMLElement>(`.dsc-card[data-run="${prev.runId}"][data-video="${prev.videoId}"]`)?.focus();
}

async function summarize(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found || st.summarizing.has(videoId) || found.hit.state === "queued") return;
  st.summarizing.add(videoId);
  render();
  try {
    const r = await postJson("/api/youtube/summarize", { title: found.hit.title, url: watchUrl(videoId), video_id: videoId });
    if (!r.ok) toast(typeof r.data.error === "string" ? r.data.error : `Could not start (HTTP ${r.status}).`);
    else {
      await setState(videoId, "queued");
      toast(r.data.duplicate ? "Already summarized." : r.data.in_flight ? "Already running." : "Summary started.");
    }
  } catch {
    toast("Could not start: the server did not answer.");
  }
  st.summarizing.delete(videoId);
  render();
}

async function dismiss(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found) return;
  const before = found.hit.state;
  if (!(await setState(videoId, "dismissed"))) return;
  if (st.open?.videoId === videoId) st.open = null;
  render();
  toast("Dismissed. It won't be suggested again.", () => {
    void setState(videoId, before).then(() => render());
  });
}

async function toggleLater(videoId: string): Promise<void> {
  const found = findHit(videoId);
  if (!found) return;
  await setState(videoId, found.hit.state === "later" ? "new" : "later");
  render();
}

function act(name: string, videoId: string): void {
  if (name === "sum") void summarize(videoId);
  else if (name === "later") void toggleLater(videoId);
  else if (name === "dismiss") void dismiss(videoId);
  else if (name === "details") {
    st.details.delete(videoId);
    void loadDetails(videoId);
  } else if (name === "play") {
    st.playing = true;
    renderDrawer();
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
    const data = JSON.parse($("dscData")?.textContent ?? "{}") as { shelves?: DiscoverShelf[] };
    st.shelves = Array.isArray(data.shelves) ? data.shelves : [];
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
        act(actEl.dataset.act ?? "", videoId);
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
  render();
  focusHashShelf();
}
