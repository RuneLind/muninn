/// <reference lib="dom" />
/**
 * `/summaries/discover` — the seed bar (plan muninn-youtube-discovery, PR 3).
 * Three ways to choose the summaries a discovery starts from: a category's
 * newest 5, the last 7 days' (at most 5), or up to 5 picked by hand. Each seed
 * is its own run (`POST /api/summaries/discover`, `origin: "page"`), one at a
 * time, and the shelves are re-read after each one that lands.
 *
 * The listing (`GET /api/summaries/discover/seeds`) is read on the first open
 * and read again on an open once it is over {@link LISTING_MAX_AGE_MS} old; a
 * failed re-read keeps the old one. Seed rules are `src/youtube/discover-seeds.ts`, the same ones the
 * weekly watcher uses.
 */

import { escHtml } from "./escape.ts";
import { DISCOVER_SEED_CAP, lastWeekSeeds, newestInCategory, type SeedDoc } from "../../../youtube/discover-seeds.ts";
import type { DiscoverShelf } from "../../../db/youtube-discover.ts";

export type SeedMode = "category" | "week" | "pick";

/** The pick list shows at most this many matches; the filter narrows the rest. */
export const PICK_LIST_MAX = 50;
/** A listing older than this is read again when a panel opens (new captures, a new day). */
export const LISTING_MAX_AGE_MS = 10 * 60_000;

/** Docs whose title or category holds every word of `query` (any case), in listing order, at most `limit`. */
export function dscFilterSeeds(docs: readonly SeedDoc[], query: string, limit = PICK_LIST_MAX): SeedDoc[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: SeedDoc[] = [];
  for (const d of docs) {
    const hay = `${d.title} ${d.category ?? ""}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

interface SeedListing {
  docs: SeedDoc[];
  categories: { category: string; count: number }[];
  now: number;
}

interface BarState {
  mode: SeedMode | null;
  listing: SeedListing | null;
  /** When the listing was read (`performance.now()`). */
  listedAt: number;
  loading: boolean;
  loadError: string | null;
  /** A failed re-read of a listing we already hold: the old one stays in use. */
  refreshError: string | null;
  category: string;
  filter: string;
  picked: Map<string, SeedDoc>;
  running: boolean;
}

const bar: BarState = {
  mode: null,
  listing: null,
  listedAt: 0,
  loading: false,
  loadError: null,
  refreshError: null,
  category: "",
  filter: "",
  picked: new Map(),
  running: false,
};

const $ = (id: string) => document.getElementById(id);

/** The seeds the open mode would search from. */
function chosenSeeds(): SeedDoc[] {
  const l = bar.listing;
  if (!l) return [];
  if (bar.mode === "category") return bar.category ? newestInCategory(l.docs, bar.category) : [];
  if (bar.mode === "week") return lastWeekSeeds(l.docs, l.now);
  if (bar.mode === "pick") return [...bar.picked.values()];
  return [];
}

const seedLine = (d: SeedDoc) =>
  `<li><span class="dsc-seed-title">${escHtml(d.title)}</span>${d.date ? ` <span class="dsc-seed-date">${escHtml(d.date)}</span>` : ""}</li>`;

function runButton(n: number): string {
  const label = n === 0 ? "Search" : `Search from ${n} summar${n === 1 ? "y" : "ies"}`;
  return `<button type="button" class="dsc-btn dsc-primary" id="dscSeedRun"${n === 0 ? " disabled" : ""}>${label}</button>`;
}

function pickListHtml(): string {
  const l = bar.listing;
  if (!l) return "";
  const shown = dscFilterSeeds(l.docs, bar.filter);
  const full = bar.picked.size >= DISCOVER_SEED_CAP;
  if (!shown.length) return `<p class="dsc-note">No summary matches.</p>`;
  return `<ul class="dsc-pick-list">${shown
    .map((d) => {
      const on = bar.picked.has(d.id);
      return `<li><label><input type="checkbox" data-pick="${escHtml(d.id)}"${on ? " checked" : ""}${!on && full ? " disabled" : ""}> <span class="dsc-seed-title">${escHtml(d.title)}</span> <span class="dsc-seed-date">${escHtml(d.category ?? "")}${d.date ? ` · ${escHtml(d.date)}` : ""}</span></label></li>`;
    })
    .join("")}</ul>`;
}

function pickCountText(): string {
  return `${bar.picked.size} of ${DISCOVER_SEED_CAP} chosen`;
}

function panelHtml(): string {
  if (bar.loading) return `<p class="dsc-note">Loading your summaries…</p>`;
  if (bar.loadError)
    return `<p class="dsc-note dsc-warn">${escHtml(bar.loadError)}</p><button type="button" class="dsc-btn" id="dscSeedRetry">Try again</button>`;
  const l = bar.listing;
  if (!l) return "";
  return (bar.refreshError ? `<p class="dsc-note dsc-warn">${escHtml(bar.refreshError)}</p>` : "") + modeHtml(l);
}

function modeHtml(l: SeedListing): string {
  if (bar.mode === "category") {
    if (!l.categories.length) return `<p class="dsc-note">Your YouTube summaries have no categories yet.</p>`;
    const opts = l.categories
      .map((c) => `<option value="${escHtml(c.category)}"${c.category === bar.category ? " selected" : ""}>${escHtml(c.category)} (${c.count})</option>`)
      .join("");
    const seeds = chosenSeeds();
    return `<label class="dsc-ctl"><span class="dsc-ctl-label">Category</span> <select id="dscSeedCat">${opts}</select></label>
      <p class="dsc-note">Its newest ${DISCOVER_SEED_CAP}, each searched on its own:</p>
      <ol class="dsc-seed-list">${seeds.map(seedLine).join("")}</ol>${runButton(seeds.length)}`;
  }
  if (bar.mode === "week") {
    const seeds = chosenSeeds();
    if (!seeds.length) return `<p class="dsc-note">No YouTube summaries captured in the last 7 days.</p>`;
    return `<p class="dsc-note">Captured in the last 7 days, newest first, at most ${DISCOVER_SEED_CAP}:</p>
      <ol class="dsc-seed-list">${seeds.map(seedLine).join("")}</ol>${runButton(seeds.length)}`;
  }
  return `<label class="dsc-ctl dsc-pick-filter"><span class="dsc-ctl-label">Filter</span> <input type="search" id="dscSeedFilter" value="${escHtml(bar.filter)}" placeholder="Title or category" autocomplete="off"></label>
    <div id="dscPickList">${pickListHtml()}</div>
    <div class="dsc-pick-foot"><span class="dsc-note" id="dscPickCount" aria-live="polite">${pickCountText()}</span>${runButton(bar.picked.size)}</div>`;
}

function syncModeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-seedmode]").forEach((b) => {
    b.setAttribute("aria-expanded", String(b.dataset.seedmode === bar.mode));
    b.disabled = bar.running;
  });
}

function renderPanel(focusFirst = false): void {
  const panel = $("dscSeedPanel");
  if (!panel) return;
  syncModeButtons();
  if (!bar.mode) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = panelHtml();
  if (focusFirst) panel.querySelector<HTMLElement>("select, input, button:not([disabled])")?.focus();
}

async function loadListing(): Promise<void> {
  bar.loading = true;
  bar.loadError = null;
  renderPanel();
  try {
    const res = await fetch("/api/summaries/discover/seeds");
    const data = (await res.json().catch(() => ({}))) as Partial<SeedListing> & { error?: string };
    if (!res.ok || !Array.isArray(data.docs)) throw new Error(data.error ?? `HTTP ${res.status}`);
    bar.listing = { docs: data.docs, categories: data.categories ?? [], now: typeof data.now === "number" ? data.now : Date.now() };
    bar.listedAt = performance.now();
    bar.category ||= bar.listing.categories[0]?.category ?? "";
    bar.refreshError = null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // A listing in hand is still usable: keep it and say it may be out of date.
    if (bar.listing) bar.refreshError = `Could not refresh the list (${why}); showing the one read earlier.`;
    else bar.loadError = `Could not list your YouTube summaries: ${why}`;
  } finally {
    bar.loading = false;
  }
  renderPanel(true);
}

function openMode(mode: SeedMode): void {
  if (bar.running) return;
  bar.mode = bar.mode === mode ? null : mode;
  const stale = bar.listing !== null && performance.now() - bar.listedAt > LISTING_MAX_AGE_MS;
  if (bar.mode && (!bar.listing || stale) && !bar.loading) {
    void loadListing();
    return;
  }
  renderPanel(true);
}

function progress(html: string): void {
  const p = $("dscProgress");
  if (p) p.innerHTML = html;
}

/** The stored shelves, and when they were asked for (`performance.now()`). */
async function readShelves(): Promise<{ shelves: DiscoverShelf[]; requestedAt: number } | null> {
  const requestedAt = performance.now();
  try {
    const res = await fetch("/api/summaries/discover/shelves");
    if (!res.ok) return null;
    const data = (await res.json()) as { shelves?: DiscoverShelf[] };
    return Array.isArray(data.shelves) ? { shelves: data.shelves, requestedAt } : null;
  } catch {
    return null;
  }
}

export type OnShelves = (shelves: DiscoverShelf[], requestedAt: number) => void;

/** Search from each seed in turn; `onShelves` gets the stored shelves after each run that landed. */
async function runSeeds(seeds: SeedDoc[], onShelves: OnShelves, announce?: (msg: string) => void): Promise<void> {
  if (bar.running || !seeds.length) return;
  const runMode = bar.mode;
  bar.running = true;
  bar.mode = null;
  renderPanel();
  // The panel and its Run button are gone and the chips are disabled: the progress line holds focus.
  progress(`Searching 1 of ${seeds.length}: <b>${escHtml(seeds[0]!.title)}</b>…`);
  $("dscProgress")?.focus();
  const failed: string[] = [];
  let firstRun: string | null = null;
  let landed = 0;
  let unshown = false;
  for (const [i, seed] of seeds.entries()) {
    progress(`Searching ${i + 1} of ${seeds.length}: <b>${escHtml(seed.title)}</b>…`);
    try {
      const res = await fetch("/api/summaries/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "youtube", docId: seed.id, origin: "page" }),
      });
      const data = (await res.json().catch(() => ({}))) as { runId?: string | null; error?: string };
      if (!res.ok) {
        failed.push(`${seed.title}: ${data.error ?? `HTTP ${res.status}`}`);
        continue;
      }
      if (!data.runId) {
        failed.push(`${seed.title}: the shelf could not be stored`);
        continue;
      }
      landed++;
      firstRun ??= data.runId;
      // A pick that landed is done; one that failed stays picked for a retry.
      if (runMode === "pick") bar.picked.delete(seed.id);
      const read = await readShelves();
      if (read) onShelves(read.shelves, read.requestedAt);
      // Every read returns all stored shelves: only the last one decides what the page shows.
      unshown = !read;
    } catch {
      failed.push(`${seed.title}: the server did not answer`);
    }
  }
  bar.running = false;
  syncModeButtons();
  const parts = [`${landed} new shel${landed === 1 ? "f" : "ves"}`];
  if (failed.length) parts.push(`${failed.length} failed`);
  const show = unshown
    ? " · the new shelves could not be shown: reload the page"
    : firstRun
      ? ` · <a href="#run-${escHtml(firstRun)}">Show the first</a>`
      : "";
  const why = failed.length ? `<ul class="dsc-fail-list">${failed.map((f) => `<li>${escHtml(f)}</li>`).join("")}</ul>` : "";
  progress(`Done: ${parts.join(", ")}${show}${why}`);
  // The drawer inerts the progress line's live region: say the outcome through the page's announcer instead.
  if (announce && $("dscProgress")?.closest("[inert]")) announce(`Done: ${parts.join(", ")}.`);
}

/** Wire the seed bar; `onShelves` replaces the page's shelves and re-renders. */
export function bootSeedBar(onShelves: OnShelves, announce?: (msg: string) => void): void {
  const root = $("dscSeeds");
  if (!root) return;
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const modeBtn = t.closest<HTMLButtonElement>("[data-seedmode]");
    if (modeBtn) return openMode(modeBtn.dataset.seedmode as SeedMode);
    if (t.closest("#dscSeedRetry")) return void loadListing();
    if (t.closest("#dscSeedRun")) return void runSeeds(chosenSeeds(), onShelves, announce);
  });
  root.addEventListener("change", (e) => {
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLSelectElement && t.id === "dscSeedCat") {
      bar.category = t.value;
      renderPanel();
      $("dscSeedCat")?.focus();
      return;
    }
    if (t instanceof HTMLInputElement && t.dataset.pick !== undefined) {
      const doc = bar.listing?.docs.find((d) => d.id === t.dataset.pick);
      if (!doc) return;
      if (t.checked && bar.picked.size < DISCOVER_SEED_CAP) bar.picked.set(doc.id, doc);
      else {
        bar.picked.delete(doc.id);
        t.checked = false;
      }
      // Update in place: the checkbox keeps focus.
      const full = bar.picked.size >= DISCOVER_SEED_CAP;
      root.querySelectorAll<HTMLInputElement>("[data-pick]").forEach((cb) => (cb.disabled = !cb.checked && full));
      const count = $("dscPickCount");
      if (count) count.textContent = pickCountText();
      const run = $("dscSeedRun");
      if (run) run.outerHTML = runButton(bar.picked.size);
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.id === "dscSeedFilter") {
      bar.filter = t.value;
      const list = $("dscPickList");
      if (list) list.innerHTML = pickListHtml();
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !bar.mode) return;
    const opener = document.querySelector<HTMLButtonElement>(`[data-seedmode="${bar.mode}"]`);
    bar.mode = null;
    renderPanel();
    opener?.focus();
  });
}
