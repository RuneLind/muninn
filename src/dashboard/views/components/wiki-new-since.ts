/// <reference lib="dom" />
/**
 * "New since last read" (D20, reader lenses PR 4). The reader keeps the time of
 * this viewer's last visit to each page, per wiki and relPath, and on the next
 * visit marks the items dated after it:
 *
 *  - the server stamps each dated item with `data-item-date` (one parser,
 *    `src/format/item-dates.ts`): a DecisionLog item on its `.dl-text` (or on
 *    the `<li>` of an item with no id), a Query card on its `.query-head`, a
 *    compact lane on its `<details>`;
 *  - an item is new when that day is strictly after the stored visit's local
 *    day. A lane marks each of its top-level items (the lane itself when it
 *    holds none);
 *  - the head gets `✦ N nye siden 07.10` (a button that reveals the next new
 *    item, one per click, wrapping) and `endret siden 07.10` when the page
 *    itself changed after the visit. A first visit marks nothing;
 *  - the baseline is per tab: the first render of a page in a tab reads the
 *    stored visit and keeps it in `sessionStorage`, so Back/Forward, F5 and an
 *    in-place reload mark the same items; every render stores the new visit.
 *
 * The mark is a class plus a CSS `::before`, so it is never text: a selection,
 * Explain and fact-check never see it, and a peek card's copy is unmarked by
 * the CSS scope. Storage is per viewer and best effort (try/catch everywhere).
 */

import { ITEM_DATE_ATTR } from "../../../format/item-dates.ts";
import type { QuestionLanguage } from "../../../format/question-labels.ts";
import { revealElement } from "./wiki-hash-target.ts";
import { localStore } from "./wiki-local-store.ts";
import { PEEK_CLASS } from "./wiki-ref-links.ts";

export const LAST_VISIT_KEY = "muninn.wiki.lastVisit.v1";
/** How many pages of ONE wiki the store remembers; that wiki's oldest visits
 *  drop first, so a big wiki never evicts another wiki's pages. */
export const LAST_VISIT_MAX_PER_WIKI = 400;
/** The `sessionStorage` key prefix of a tab's baseline for one page. */
export const VISIT_BASELINE_KEY = "muninn.wiki.visitBaseline.v1";
export const NEW_ITEM_CLASS = "item-new";
export const NEW_LANE_CLASS = "nm-lane-new";
export const NEW_SINCE_PILL_CLASS = "wiki-new-since";
export const CHANGED_SINCE_CLASS = "wiki-changed-since";

const WORDS: Record<QuestionLanguage, {
  tag: string;
  newSince: (n: number, date: string) => string;
  changedSince: (date: string) => string;
  title: string;
  changedTitle: (date: string) => string;
}> = {
  en: {
    tag: "NEW",
    newSince: (n, d) => `✦ ${n} new since ${d}`,
    changedSince: (d) => `changed since ${d}`,
    title: "Jump to the first item dated after your last visit",
    changedTitle: (d) => `This page changed after your last visit on ${d}`,
  },
  no: {
    tag: "NY",
    newSince: (n, d) => `✦ ${n} ${n === 1 ? "ny" : "nye"} siden ${d}`,
    changedSince: (d) => `endret siden ${d}`,
    title: "Gå til det første punktet datert etter forrige besøk",
    changedTitle: (d) => `Siden er endret etter forrige besøk ${d}`,
  },
};

export const visitKey = (wiki: string, relPath: string): string => `${wiki}\n${relPath}`;
/** The wiki half of a {@link visitKey}. */
const wikiOfKey = (key: string): string => key.slice(0, Math.max(0, key.indexOf("\n")));

/** The stored visits, `{key: epoch ms}`; anything unreadable is `{}`. */
function readVisits(storage: Pick<Storage, "getItem"> | undefined): Record<string, number> {
  try {
    const raw = storage?.getItem(LAST_VISIT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** This viewer's last visit to the page, or null (first visit, or no storage). */
export function readLastVisit(storage: Pick<Storage, "getItem"> | undefined, key: string): number | null {
  const visits = readVisits(storage);
  return Object.hasOwn(visits, key) ? visits[key]! : null;
}

/** Store `at` as the visit, keeping the newest {@link LAST_VISIT_MAX_PER_WIKI}
 *  of each wiki. */
export function writeLastVisit(storage: Pick<Storage, "getItem" | "setItem"> | undefined, key: string, at: number): void {
  try {
    const visits = readVisits(storage);
    visits[key] = at;
    const perWiki = new Map<string, number>();
    const kept = Object.entries(visits)
      .sort((a, b) => b[1] - a[1])
      .filter(([k]) => {
        const n = (perWiki.get(wikiOfKey(k)) ?? 0) + 1;
        perWiki.set(wikiOfKey(k), n);
        return n <= LAST_VISIT_MAX_PER_WIKI;
      });
    storage?.setItem(LAST_VISIT_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* the marks still work for this view */
  }
}

/** `YYYY-MM-DD` of `ms` in the viewer's timezone. */
export function localIsoDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The visit's day in the wiki's language: `07.10` (`07.10.2025` in another
 *  year) on `no`, the lane ages' spelling; `Oct 7` (`Oct 7, 2025`) on `en`,
 *  where `07.10` reads as July 10. */
export function visitDateText(ms: number, now: Date, language: QuestionLanguage): string {
  const [y, m, d] = localIsoDay(ms).split("-");
  const thisYear = Number(y) === now.getFullYear();
  if (language === "no") return thisYear ? `${d}.${m}` : `${d}.${m}.${y}`;
  const md = `${EN_MONTHS[Number(m) - 1]} ${Number(d)}`;
  return thisYear ? md : `${md}, ${y}`;
}

type SessionLike = Pick<Storage, "getItem" | "setItem">;

/** The tab's baseline where `sessionStorage` cannot hold it. */
const memoryBaselines = new Map<string, number | null>();

/**
 * This tab's baseline for the page: the visit its first render in the tab
 * read, or null for a first visit. On the first render in a tab, `stored` is
 * that visit and is recorded; later renders get the recorded one back.
 */
export function tabBaseline(session: SessionLike | undefined, key: string, stored: () => number | null): number | null {
  const sKey = `${VISIT_BASELINE_KEY}\n${key}`;
  try {
    const raw = session?.getItem(sKey);
    if (raw != null) {
      const v: unknown = JSON.parse(raw);
      if (v === null || (typeof v === "number" && Number.isFinite(v) && v > 0)) return v as number | null;
    }
  } catch {
    /* fall through to memory */
  }
  if (memoryBaselines.has(key)) return memoryBaselines.get(key)!;
  const baseline = stored();
  memoryBaselines.set(key, baseline);
  try {
    session?.setItem(sKey, JSON.stringify(baseline));
  } catch {
    /* memory holds it for this document */
  }
  return baseline;
}

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The elements a dated element marks: a lane's top-level items (the lane
 *  when it has none), else the DecisionLog item or the Query head itself. */
function markTargets(el: HTMLElement): { items: HTMLElement[]; lane: HTMLElement | null } {
  if (el.classList.contains("nm-lane")) {
    const items = Array.from(
      el.querySelectorAll<HTMLElement>(":scope > .nm-body > ul > li, :scope > .nm-body > ol > li"),
    );
    return { items: items.length ? items : [el], lane: el };
  }
  return { items: [el.closest<HTMLElement>("li.dl-item") ?? el], lane: null };
}

/**
 * Mark every item dated strictly after `sinceDay` (`YYYY-MM-DD`); returns the
 * marked items in document order. Clears earlier marks first, so a re-run (an
 * in-place reload) is idempotent. A peek card's copy is never marked.
 */
export function markNewItems(article: HTMLElement, sinceDay: string | null): HTMLElement[] {
  article.querySelectorAll(`.${NEW_ITEM_CLASS}, .${NEW_LANE_CLASS}`).forEach((el) => {
    el.classList.remove(NEW_ITEM_CLASS, NEW_LANE_CLASS);
  });
  if (!sinceDay) return [];
  const marked = new Set<HTMLElement>();
  article.querySelectorAll<HTMLElement>(`[${ITEM_DATE_ATTR}]`).forEach((el) => {
    if (el.closest(`.${PEEK_CLASS}`)) return;
    const day = el.getAttribute(ITEM_DATE_ATTR) ?? "";
    if (!(day > sinceDay)) return;
    const { items, lane } = markTargets(el);
    lane?.classList.add(NEW_LANE_CLASS);
    for (const item of items) {
      item.classList.add(NEW_ITEM_CLASS);
      marked.add(item);
    }
  });
  return Array.from(marked).sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

export interface NewSinceOptions {
  wiki: string;
  relPath: string;
  language: QuestionLanguage;
  /** The page's last-modified time (the reader's update signal), epoch ms. */
  changedMs: number | null;
  now?: Date;
  storage?: Pick<Storage, "getItem" | "setItem">;
  session?: SessionLike;
}

/**
 * Take this tab's baseline (reading the stored visit BEFORE storing this one
 * on the tab's first render of the page), store this visit, mark what is
 * newer than the baseline, and put the count and «changed since» in the
 * head's meta row. Idempotent.
 */
export function enhanceNewSince(wrap: ParentNode, opts: NewSinceOptions): void {
  const article = wrap.querySelector<HTMLElement>(".wiki-article");
  const row = wrap.querySelector<HTMLElement>(".wiki-article-head .wiki-meta-row");
  if (!article) return;
  row?.querySelectorAll(`.${NEW_SINCE_PILL_CLASS}, .${CHANGED_SINCE_CLASS}`).forEach((el) => el.remove());
  const storage = opts.storage ?? localStore();
  const now = opts.now ?? new Date();
  const key = visitKey(opts.wiki, opts.relPath);
  const since = tabBaseline(opts.session ?? sessionStore(), key, () => readLastVisit(storage, key));
  writeLastVisit(storage, key, now.getTime());
  const words = WORDS[opts.language] ?? WORDS.en;
  article.style.setProperty("--new-label", JSON.stringify(words.tag));
  const marked = markNewItems(article, since === null ? null : localIsoDay(since));
  if (since === null || !row) return;
  const date = visitDateText(since, now, opts.language);
  const parts: HTMLElement[] = [];
  if (marked.length > 0) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = NEW_SINCE_PILL_CLASS;
    pill.textContent = words.newSince(marked.length, date);
    pill.title = words.title;
    let step = 0;
    pill.addEventListener("click", () => {
      // Document order NOW (the lens may have reordered a log); each click
      // reveals the next, wrapping, and opens what hides it (D3).
      const all = Array.from(article.querySelectorAll<HTMLElement>(`.${NEW_ITEM_CLASS}`)).filter(
        (el) => !el.closest(`.${PEEK_CLASS}`),
      );
      if (all.length === 0) return;
      const target = all[step % all.length]!;
      step = (step % all.length) + 1;
      revealElement(article, target);
    });
    parts.push(pill);
  }
  if (opts.changedMs !== null && opts.changedMs > since) {
    const changed = document.createElement("span");
    changed.className = CHANGED_SINCE_CLASS;
    changed.textContent = words.changedSince(date);
    changed.title = words.changedTitle(date);
    parts.push(changed);
  }
  if (parts.length === 0) return;
  // After the header pills (historic, lanes, counts), before the toggles.
  const pills = row.querySelectorAll(
    ".wiki-badge, .wiki-status, .wiki-followup-flag, .wiki-historic-pill, .wiki-moves-pill, .wiki-count-pill",
  );
  const after = pills[pills.length - 1];
  if (after) after.after(...parts);
  else row.prepend(...parts);
}

/** The NEW tag's look, shared by the rail's `.wiki-new-tag` (wiki-page.ts)
 *  and the item marks here: `--tok-str`, bordered, bold small type. */
export const NEW_TAG_LOOK = `
      font-size: 9.5px; font-weight: 700; letter-spacing: .06em; line-height: 1.35;
      color: var(--tok-str); border: 1px solid color-mix(in srgb, var(--tok-str) 55%, transparent);
      border-radius: 3px; padding: 0 3px;`;

/** The reader's CSS for the marks and the head line. */
export function newSinceCss(): string {
  const notPeek = `:not(.${PEEK_CLASS} *)`;
  const tag = `
      content: var(--new-label, "NEW");
      display: inline-block; vertical-align: 0.1em;${NEW_TAG_LOOK}
      margin-right: 6px; white-space: nowrap;`;
  return `
    .wiki-article .${NEW_ITEM_CLASS}${notPeek}::before {${tag}
    }
    .wiki-article .query-head.${NEW_ITEM_CLASS}${notPeek}::before { margin-bottom: 4px; }
    .wiki-article details.nm-lane.${NEW_ITEM_CLASS}${notPeek}::before { display: none; }
    .wiki-article .${NEW_LANE_CLASS}${notPeek} > summary .nm-who::before {${tag}
    }
    .${NEW_SINCE_PILL_CLASS} {
      font: inherit; font-size: 11px; font-weight: 600; padding: 1px 8px; cursor: pointer;
      border-radius: 999px; border: 1px solid color-mix(in srgb, var(--tok-str) 55%, transparent);
      background: color-mix(in srgb, var(--tok-str) 8%, transparent); color: var(--tok-str);
    }
    .${NEW_SINCE_PILL_CLASS}:hover, .${NEW_SINCE_PILL_CLASS}:focus-visible {
      background: color-mix(in srgb, var(--tok-str) 16%, transparent);
    }
    .${CHANGED_SINCE_CLASS} { font-size: 11px; color: var(--text-soft); white-space: nowrap; }
  `;
}
