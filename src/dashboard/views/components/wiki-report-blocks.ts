/// <reference lib="dom" />
/**
 * Reader chrome for report blocks, derived from the RENDERED article:
 *
 *  - `↻ N historic` — a pill in the header's meta row, beside the status chip,
 *    counting the page's `<Historic>` sections (`section.historic`); a click
 *    opens any closed `<details>` around the first one and scrolls to it.
 *  - `✋ Du · 3` / `⏳ Venter på fag · 2` / `✉ Utkast, ikke sendt · 2 · 1 d` —
 *    the same kind of pill per `<NextMoves>` lane kind, labelled with the
 *    lane's own `who` (the English `✋ N for you` default only when it has
 *    none), summing the counted lanes' `data-count` (the renderer's count, the
 *    one the index uses too; a lane in a settled section counts nowhere), plus
 *    the lane ages (`decorateLaneAges`), computed here from `data-since`.
 *  - `11 decisions` / `5 open` / `17 queries` / `11 cases` — counted pills
 *    (D8), from the stamped DecisionLog items, the Query cards and the
 *    CaseBoard rows not in status `none`; each jumps to its first target.
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
import type { IdLabels } from "../../../format/reader-lens.ts";
import { DECISION_ID_RE } from "../../../format/question.ts";
import { DEFAULT_QUESTION_LANGUAGE, type QuestionLanguage } from "../../../format/question-labels.ts";
import { revealElement } from "./wiki-hash-target.ts";
import { localStore } from "./wiki-local-store.ts";

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

// ── NextMoves ────────────────────────────────────────────────────────────────

export const MOVES_PILL_CLASS = "wiki-moves-pill";
export const MOVES_AGE_CLASS = "nm-age";
type PillKind = "you" | "waiting" | "draft";

const MOVES_PILL_TITLE: Record<PillKind, string> = {
  you: "Jump to the next steps",
  waiting: "Jump to what this page is waiting on",
  draft: "Jump to the drafts not sent yet",
};

/**
 * The settled sections a lane can sit in — a `<Historic>` and a resolved
 * `<Callout>`, as the web renderer marks them up. A lane inside one still
 * renders but counts in no pill: the twin of `isSettledSection` in
 * `src/format/markdown-ast.ts`, which keeps the index to the same rule.
 */
export const SETTLED_SECTION_SELECTOR = "section.historic, details.callout-resolved";

/** Whole days from the calendar day `since` (`YYYY-MM-DD`) to `now`'s day, both
 *  in the viewer's timezone; 0 for today, null for a FUTURE day (there is no
 *  age to show yet, so the lane shows the date) and for a bad date. */
export function daysSince(since: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // `setFullYear`, not the constructor, which maps years 0–99 to the 1900s.
  const day = new Date(2000, 0, 1);
  day.setFullYear(y, mo - 1, d);
  if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounded, not floored: a DST day is 23 or 25 hours long.
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  return days < 0 ? null : days;
}

/** A kind's header pill. With an authored `who` the label is the author's own
 *  words (`✋ Du · 3`), so the pill reads from the page's perspective rather
 *  than claiming the step is the VIEWER's; without one, the English default. */
export function movesPillLabel(kind: PillKind, n: number, ageDays: number | null, who?: string | null): string {
  const age = kind === "draft" && ageDays !== null ? ` · ${ageDays} d` : "";
  if (who) return `${MOVES_PILL_GLYPH[kind]} ${who} · ${n}${age}`;
  if (kind === "you") return `✋ ${n} for you`;
  if (kind === "waiting") return `⏳ waiting · ${n}`;
  return `✉ ${n} not sent${age}`;
}

const MOVES_PILL_GLYPH: Record<PillKind, string> = { you: "✋", waiting: "⏳", draft: "✉" };

interface MovesTally {
  count: number;
  first: HTMLElement | null;
  /** The first counted lane's authored `who`, or null. */
  who: string | null;
  /** The oldest valid `since` among the kind's lanes, as an age in days. */
  oldestAgeDays: number | null;
}

/** The lanes that count: the block's OWN lanes (its grid and strips) of every
 *  `.next-moves` block that is neither inside another block nor inside a
 *  settled section (`SETTLED_SECTION_SELECTOR`). The index walk
 *  (`countedNextMovesLanes`) never descends into a block either. */
function countedLanes(article: HTMLElement): HTMLElement[] {
  return Array.from(article.querySelectorAll<HTMLElement>(".next-moves"))
    .filter((block) => !block.parentElement?.closest(".next-moves") && !block.closest(SETTLED_SECTION_SELECTOR))
    .flatMap((block) =>
      Array.from(block.querySelectorAll<HTMLElement>(":scope > .nm-grid > .nm-lane, :scope > .nm-strips > .nm-lane")),
    );
}

/** Sum the lanes' server-computed `data-count` per kind. An unknown kind was
 *  already folded to `waiting` by the renderer. */
function readMoves(article: HTMLElement, now: Date): Record<PillKind | "blocked", MovesTally> {
  const tally = (): MovesTally => ({ count: 0, first: null, who: null, oldestAgeDays: null });
  const out = { you: tally(), waiting: tally(), draft: tally(), blocked: tally() };
  for (const lane of countedLanes(article)) {
    const t = out[lane.dataset.kind as keyof typeof out];
    if (!t) continue;
    const n = Number(lane.dataset.count) || 0;
    t.count += n;
    if (n > 0 && !t.first) {
      t.first = lane;
      t.who = lane.dataset.who ?? null;
    }
    const age = lane.dataset.since ? daysSince(lane.dataset.since, now) : null;
    if (age !== null && n > 0) t.oldestAgeDays = Math.max(t.oldestAgeDays ?? 0, age);
  }
  return out;
}

/** Ages computed here, never server-side, so cached HTML cannot carry a stale
 *  one: a lane's head reads `since N d` (the date itself for a future day), and
 *  each open top-level item of a draft lane gets a `not sent · N d` chip.
 *  Idempotent. */
function decorateLaneAges(article: HTMLElement, now: Date): void {
  article.querySelectorAll(`.nm-lane .${MOVES_AGE_CLASS}`).forEach((el) => el.remove());
  article.querySelectorAll<HTMLElement>(".next-moves .nm-lane[data-since]").forEach((lane) => {
    const since = lane.dataset.since!;
    const age = daysSince(since, now);
    const sinceEl = lane.querySelector<HTMLElement>(":scope > .nm-head > .nm-since");
    if (sinceEl) {
      sinceEl.textContent = age !== null ? `since ${age} d` : since;
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
    const items = lane.querySelectorAll<HTMLElement>(
      ":scope > .nm-body > ul > li:not(.check-done), :scope > .nm-body > ol > li:not(.check-done)",
    );
    if (items.length === 0) return;
    items.forEach((li) => {
      // After the item's own text, before anything nested under it.
      const nested = Array.from(li.children).find((c) => /^(UL|OL|P|PRE|DIV)$/.test(c.tagName));
      if (nested) li.insertBefore(chip(), nested);
      else li.append(chip());
    });
  });
}

// ── Counted pills (D8) ───────────────────────────────────────────────────────

export const COUNT_PILL_CLASS = "wiki-count-pill";
export type CountKind = "decisions" | "open" | "queries" | "cases";

const COUNT_WORDS: Record<QuestionLanguage, Record<CountKind, [string, string]>> = {
  en: { decisions: ["decision", "decisions"], open: ["open", "open"], queries: ["query", "queries"], cases: ["case", "cases"] },
  no: { decisions: ["beslutning", "beslutninger"], open: ["åpent", "åpne"], queries: ["spørring", "spørringer"], cases: ["sak", "saker"] },
};

/** The id prefix whose noun names a count, when the wiki's `idLabels` has it. */
const COUNT_PREFIX: Partial<Record<CountKind, string>> = { decisions: "D", queries: "Q" };

/** A counted pill's label: `11 decisions`, `5 åpne`, `17 queries`. With
 *  `idLabels` the decision and query nouns are the wiki's own, lower-cased
 *  (`11 beslutninger`). */
export function countPillLabel(kind: CountKind, n: number, lang: QuestionLanguage, labels?: IdLabels): string {
  const prefix = COUNT_PREFIX[kind];
  const own = prefix ? labels?.[prefix] : undefined;
  const word = own ? (n === 1 ? own.one : own.other).toLocaleLowerCase() : COUNT_WORDS[lang][kind][n === 1 ? 0 : 1];
  return `${n} ${word}`;
}

const COUNT_TITLE: Record<CountKind, string> = {
  decisions: "Jump to the first decision",
  open: "Jump to the first open question",
  queries: "Jump to the first query",
  cases: "Jump to the cases",
};

interface CountTally {
  count: number;
  first: HTMLElement | null;
}

/**
 * The four counts, read off the rendered page: unique decision ids (an id
 * matching `D` and digits on a stamped DecisionLog item), unique open
 * questions (an item the renderer marked `data-q-open`, by the one rule in
 * `isOpenQuestion`), Query cards (unique by id; each card with none counts
 * once) and the cases whose status is not `none` (unique by id). Exported for
 * the unit test.
 */
export function readCounts(article: ParentNode): Record<CountKind, CountTally> {
  const out: Record<CountKind, CountTally> = {
    decisions: { count: 0, first: null },
    open: { count: 0, first: null },
    queries: { count: 0, first: null },
    cases: { count: 0, first: null },
  };
  const seen: Record<CountKind, Set<string>> = { decisions: new Set(), open: new Set(), queries: new Set(), cases: new Set() };
  const add = (kind: CountKind, key: string, el: HTMLElement) => {
    if (seen[kind].has(key)) return;
    seen[kind].add(key);
    out[kind].count++;
    out[kind].first ??= el;
  };
  article.querySelectorAll<HTMLElement>("li.dl-item[data-q-state]").forEach((li) => {
    const id = li.querySelector(":scope > .dl-id")?.textContent?.trim() ?? "";
    if (!id) return;
    if (DECISION_ID_RE.test(id)) add("decisions", id, li);
    else if (li.hasAttribute("data-q-open")) add("open", id, li);
  });
  article.querySelectorAll<HTMLElement>("section.query").forEach((card) => {
    const id = card.querySelector(".query-id")?.textContent?.trim();
    if (id) add("queries", id, card);
    else {
      out.queries.count++;
      out.queries.first ??= card;
    }
  });
  article.querySelectorAll<HTMLElement>(".cb-group:not([data-status=\"none\"]) .cb-row").forEach((row) => {
    const id = row.querySelector(".cb-id")?.textContent?.trim() ?? row.id;
    add("cases", id, row);
  });
  return out;
}

export interface ReportBlockOptions {
  /** The wiki's `language`, for the counted pills. */
  language?: QuestionLanguage;
  /** The wiki's `idLabels`, for the counted pills' nouns. */
  idLabels?: IdLabels;
}

export function enhanceReportBlocks(wrap: ParentNode, opts: ReportBlockOptions = {}): void {
  const article = wrap.querySelector<HTMLElement>(".wiki-article");
  const row = wrap.querySelector<HTMLElement>(".wiki-article-head .wiki-meta-row");
  if (!article || !row) return;
  row
    .querySelectorAll(`.${HISTORIC_PILL_CLASS}, .${MOVES_PILL_CLASS}, .${COUNT_PILL_CLASS}, .${LINE_REFS_TOGGLE_CLASS}`)
    .forEach((el) => el.remove());

  const pills: HTMLButtonElement[] = [];
  /** A header pill that reveals `target` (D3): the lens and any closed
   *  `<details>` around it give way, then it scrolls and flashes. The Historic
   *  section and a lane carry no id, so the pill passes the element itself. */
  const jumpPill = (className: string, label: string, title: string, target: HTMLElement) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = className;
    pill.textContent = label;
    pill.title = title;
    pill.addEventListener("click", () => revealElement(article, target));
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
    jumpPill(
      `${MOVES_PILL_CLASS} ${MOVES_PILL_CLASS}-${kind}`,
      movesPillLabel(kind, m.count, m.oldestAgeDays, m.who),
      MOVES_PILL_TITLE[kind],
      m.first,
    );
  }
  decorateLaneAges(article, now);

  const counts = readCounts(article);
  const lang = opts.language ?? DEFAULT_QUESTION_LANGUAGE;
  for (const kind of ["decisions", "open", "queries", "cases"] as const) {
    const c = counts[kind];
    if (c.count === 0 || !c.first) continue;
    jumpPill(
      `${COUNT_PILL_CLASS} ${COUNT_PILL_CLASS}-${kind}`,
      countPillLabel(kind, c.count, lang, opts.idLabels),
      COUNT_TITLE[kind],
      c.first,
    );
  }

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
