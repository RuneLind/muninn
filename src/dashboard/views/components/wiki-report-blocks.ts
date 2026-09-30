/// <reference lib="dom" />
/**
 * Reader chrome for report blocks, derived from the RENDERED article:
 *
 *  - `↻ N historic` — a pill in the header's meta row, beside the status chip,
 *    counting the page's `<Historic>` sections (`section.historic`); a click
 *    opens any closed `<details>` around the first one and scrolls to it.
 *  - `✋ N for you` / `⏳ waiting · N` / `✉ N not sent · age` — the same kind of
 *    pill per `<NextMoves>` lane kind, summing the lanes' `data-count` (the
 *    renderer's count, the one the index uses too), plus the lane ages
 *    (`decorateLaneAges`), computed here from `data-since`.
 *  - `line refs` — a toggle, shown only on a page with a pure ref group
 *    (`span.code-ref-group`, emitted by `src/wiki/code-refs.ts`), that hides
 *    those groups with one class on `.wiki-article`. A chip outside a group is
 *    never hidden, so hiding cannot delete prose. The choice is per viewer, in
 *    localStorage; default on.
 *
 * Runs at the article render site only, after the article HTML is in place.
 * Idempotent: a re-run removes its own controls before adding them again.
 */

import { CODE_REF_CLASS, CODE_REF_GROUP_CLASS, CODE_REF_LINK_CLASS } from "../../../wiki/code-refs.ts";

export { CODE_REF_CLASS, CODE_REF_GROUP_CLASS, CODE_REF_LINK_CLASS };
export const LINE_REFS_KEY = "muninn.wiki.lineRefs.v1";
export const CODE_REFS_OFF_CLASS = "code-refs-off";
export const HISTORIC_PILL_CLASS = "wiki-historic-pill";
export const LINE_REFS_TOGGLE_CLASS = "wiki-lineref-toggle";

export function historicPillLabel(n: number): string {
  return `↻ ${n} historic`;
}

/** Whether chips are shown. Any storage failure (private window, blocked site
 *  data) reads as the default, on. */
export function readLineRefsOn(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(LINE_REFS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeLineRefsOn(storage: Pick<Storage, "setItem"> | undefined, on: boolean): void {
  try {
    storage?.setItem(LINE_REFS_KEY, on ? "on" : "off");
  } catch {
    /* the toggle still works for this page view */
  }
}

function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// ── NextMoves ────────────────────────────────────────────────────────────────

export const MOVES_PILL_CLASS = "wiki-moves-pill";
export const MOVES_AGE_CLASS = "nm-age";
type PillKind = "you" | "waiting" | "draft";

const MOVES_PILL_TITLE: Record<PillKind, string> = {
  you: "Jump to the steps waiting on you",
  waiting: "Jump to what this page is waiting on",
  draft: "Jump to the drafts not sent yet",
};

/** Whole days from the calendar day `since` (`YYYY-MM-DD`) to `now`'s day, both
 *  in the viewer's timezone; 0 for today or a future day, null for a bad date. */
export function daysSince(since: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (!m) return null;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(day.getTime()) || day.getDate() !== Number(m[3])) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounded, not floored: a DST day is 23 or 25 hours long.
  return Math.max(0, Math.round((today.getTime() - day.getTime()) / 86_400_000));
}

export function movesPillLabel(kind: PillKind, n: number, ageDays: number | null): string {
  if (kind === "you") return `✋ ${n} for you`;
  if (kind === "waiting") return `⏳ waiting · ${n}`;
  return `✉ ${n} not sent${ageDays === null ? "" : ` · ${ageDays} d`}`;
}

interface MovesTally {
  count: number;
  first: HTMLElement | null;
  /** The oldest valid `since` among the kind's lanes, as an age in days. */
  oldestAgeDays: number | null;
}

/** Sum the lanes' server-computed `data-count` per kind. An unknown kind was
 *  already folded to `waiting` by the renderer. */
function readMoves(article: HTMLElement, now: Date): Record<PillKind | "blocked", MovesTally> {
  const tally = (): MovesTally => ({ count: 0, first: null, oldestAgeDays: null });
  const out = { you: tally(), waiting: tally(), draft: tally(), blocked: tally() };
  article.querySelectorAll<HTMLElement>(".next-moves .nm-lane").forEach((lane) => {
    const t = out[lane.dataset.kind as keyof typeof out];
    if (!t) return;
    const n = Number(lane.dataset.count) || 0;
    t.count += n;
    if (n > 0 && !t.first) t.first = lane;
    const age = lane.dataset.since ? daysSince(lane.dataset.since, now) : null;
    if (age !== null && n > 0) t.oldestAgeDays = Math.max(t.oldestAgeDays ?? 0, age);
  });
  return out;
}

/** Ages computed here, never server-side, so cached HTML cannot carry a stale
 *  one: a waiting lane's head reads `since N d`, and each top-level item of a
 *  draft lane gets a `not sent · N d` chip. Idempotent. */
function decorateLaneAges(article: HTMLElement, now: Date): void {
  article.querySelectorAll(`.nm-lane .${MOVES_AGE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll<HTMLElement>(".next-moves .nm-lane[data-since]").forEach((lane) => {
    const since = lane.dataset.since!;
    const age = daysSince(since, now);
    const sinceEl = lane.querySelector<HTMLElement>(":scope > .nm-head > .nm-since");
    if (sinceEl) {
      sinceEl.textContent = age !== null && lane.dataset.kind === "waiting" ? `since ${age} d` : since;
      sinceEl.title = since;
    }
    if (age === null || lane.dataset.kind !== "draft") return;
    const chip = () => {
      const c = document.createElement("span");
      c.className = MOVES_AGE_CLASS;
      c.textContent = `not sent · ${age} d`;
      c.title = `drafted ${since}`;
      return c;
    };
    const items = lane.querySelectorAll<HTMLElement>(":scope > .nm-body > ul > li, :scope > .nm-body > ol > li");
    if (items.length === 0) {
      lane.querySelector(":scope > .nm-head")?.append(chip());
      return;
    }
    items.forEach((li) => {
      // After the item's own text, before anything nested under it.
      const nested = Array.from(li.children).find((c) => /^(UL|OL|P|PRE|DIV)$/.test(c.tagName));
      if (nested) li.insertBefore(chip(), nested);
      else li.append(chip());
    });
  });
}

export function enhanceReportBlocks(wrap: ParentNode): void {
  const article = wrap.querySelector<HTMLElement>(".wiki-article");
  const row = wrap.querySelector<HTMLElement>(".wiki-article-head .wiki-meta-row");
  if (!article || !row) return;
  row
    .querySelectorAll(`.${HISTORIC_PILL_CLASS}, .${MOVES_PILL_CLASS}, .${LINE_REFS_TOGGLE_CLASS}`)
    .forEach((el) => el.remove());

  const pills: HTMLButtonElement[] = [];
  /** A header pill that opens any closed `<details>` around `target` (a block
   *  inside a closed Fold has no box to scroll to) and scrolls to it. */
  const jumpPill = (className: string, label: string, title: string, target: HTMLElement) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = className;
    pill.textContent = label;
    pill.title = title;
    pill.addEventListener("click", () => {
      for (let el = target.parentElement; el && el !== article; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement) el.open = true;
      }
      target.scrollIntoView({ block: "start" });
    });
    pills.push(pill);
  };

  const historic = article.querySelectorAll<HTMLElement>("section.historic");
  if (historic.length > 0) {
    jumpPill(HISTORIC_PILL_CLASS, historicPillLabel(historic.length), "Jump to the first historic section", historic[0]!);
  }

  const now = new Date();
  const moves = readMoves(article, now);
  for (const kind of ["you", "waiting", "draft"] as const) {
    const m = moves[kind];
    if (m.count === 0 || !m.first) continue;
    jumpPill(`${MOVES_PILL_CLASS} ${MOVES_PILL_CLASS}-${kind}`, movesPillLabel(kind, m.count, m.oldestAgeDays), MOVES_PILL_TITLE[kind], m.first);
  }
  decorateLaneAges(article, now);

  // Beside the status chip: after the last badge/status/flag in the row.
  const anchors = row.querySelectorAll(".wiki-badge, .wiki-status, .wiki-followup-flag");
  let after: Element | undefined = anchors[anchors.length - 1];
  for (const pill of pills) {
    if (after) after.after(pill);
    else row.prepend(pill);
    after = pill;
  }

  if (article.querySelector(`span.${CODE_REF_GROUP_CLASS}`)) {
    let on = readLineRefsOn(localStore());
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = LINE_REFS_TOGGLE_CLASS;
    toggle.textContent = "line refs";
    toggle.title = "Show or hide the parenthesised code line references";
    const apply = () => {
      article.classList.toggle(CODE_REFS_OFF_CLASS, !on);
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
    };
    toggle.addEventListener("click", () => {
      on = !on;
      writeLineRefsOn(localStore(), on);
      apply();
    });
    apply();
    row.appendChild(toggle);
  } else {
    article.classList.remove(CODE_REFS_OFF_CLASS);
  }
}
