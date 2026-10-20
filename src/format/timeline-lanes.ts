/**
 * The reader's timeline lanes: the page's dated items on one date axis, one
 * lane each for `<DecisionLog>` items, `<Query>` runs and `<Timeline>` items,
 * drawn in the view slot after the decision views. Derived, never authored.
 *
 * Server-only: `renderWikiHtml` passes `timelineLanesHtml` to `formatWebHtml`
 * as `timelineLanes`, so the chat bundle never carries it. Dates come from
 * `item-dates.ts`: a log item and a query read exactly as the reader's
 * `data-item-date` stamps do (`itemDate`: the latest date not after the render
 * day), a Timeline item by the date it leads with (`parseTimelineItem`), read
 * by `itemDates`, so a planned step after today keeps its place. A year-less
 * Timeline date is undated here.
 */

import { parseLogItem, parseTimelineItem } from "./genre-lists.ts";
import { itemDate, itemDates, listChildrenText } from "./item-dates.ts";
import { type Block, componentBlocks } from "./markdown-ast.ts";
import { escapeHtml } from "./markdown-core.ts";
import { parseQueryAttrs } from "./query-block.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { DC_VIEW_CLASS, READER_ONLY_ATTR } from "./reader-lens.ts";
import { visibleText } from "./report-top.ts";

export type LaneKind = "decisions" | "queries" | "timeline";

interface LaneItem {
  day: string;
  label: string;
}

interface TimelineLane {
  kind: LaneKind;
  items: LaneItem[];
}

/** The lanes view needs this many lanes with {@link LANE_MIN_ITEMS} dated items each. */
export const LANES_MIN = 2;
export const LANE_MIN_ITEMS = 2;

/** A label's longest visible run before it is cut with «…». */
const LABEL_MAX = 48;

const LANE_ORDER: readonly LaneKind[] = ["decisions", "queries", "timeline"];

const WORDS: Record<QuestionLanguage, { title: string; lanes: Record<LaneKind, string>; query: string; dated: (n: number) => string }> = {
  en: { title: "Dates on this page", lanes: { decisions: "Decisions", queries: "Queries", timeline: "Timeline" }, query: "Query", dated: (n) => `${n} dated` },
  no: { title: "Datoer på siden", lanes: { decisions: "Beslutninger", queries: "Spørringer", timeline: "Tidslinje" }, query: "Spørring", dated: (n) => `${n} datert` },
};

/** The days an item date is read with, as `formatWebHtml`'s `itemDates`. */
interface LaneDays {
  ref: string;
  today: string;
}

/** `formatWebHtml`'s `timelineLanes` option: `shown` reads a wikilink
 *  sentinel as its link text, as the reader's `data-item-date` does. */
export type TimelineLanesRenderer = (blocks: readonly Block[], days: LaneDays, language: QuestionLanguage, shown: (text: string) => string) => string;

function cut(text: string): string {
  const t = visibleText(text).replace(/\s+/g, " ").trim();
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1).trimEnd()}…` : t;
}

/** Every top-level item of every list directly in a block's body. */
function bodyItems(children: readonly Block[]): { text: string; nested: string }[] {
  return children.flatMap((b) =>
    b.type === "ul" || b.type === "ol" ? b.items.map((text, k) => ({ text, nested: listChildrenText(b.nested?.[k]) })) : [],
  );
}

/** The page's dated items per lane, in document order. A block nested in any
 *  other component counts; a fenced fake is a code block and does not. */
export function pageTimelineLanes(blocks: readonly Block[], days: LaneDays, shown: (text: string) => string = (t) => t): TimelineLane[] {
  const lanes: Record<LaneKind, LaneItem[]> = { decisions: [], queries: [], timeline: [] };
  for (const b of componentBlocks(blocks, "DecisionLog")) {
    for (const { text, nested } of bodyItems(b.children)) {
      const p = parseLogItem(text);
      const day = itemDate(shown(`${p.text}\n${nested}`), days.ref, days.today);
      if (day) lanes.decisions.push({ day, label: p.id ?? cut(shown(p.text)) });
    }
  }
  for (const b of componentBlocks(blocks, "Query")) {
    const q = parseQueryAttrs(b.attrs);
    const day = q.run ? itemDate(shown(q.run), days.ref, days.today) : null;
    // "" when the Query has neither: the renderer names it by the word for a query.
    if (day) lanes.queries.push({ day, label: cut(shown(q.id)) || cut(shown(q.question)) });
  }
  for (const b of componentBlocks(blocks, "Timeline")) {
    for (const { text } of bodyItems(b.children)) {
      const t = parseTimelineItem(text);
      // A year-less date is undated here: the nearest-year guess can land
      // a year off and out of written order, stretching the axis.
      const day = t.date && /\d{4}/.test(t.date) ? itemDates(t.date, days.ref)[0] : undefined;
      if (day) lanes.timeline.push({ day, label: cut(shown(t.text)) });
    }
  }
  return LANE_ORDER.map((kind) => ({ kind, items: lanes[kind] })).filter((l) => l.items.length > 0);
}

/** True when the lanes view draws: {@link LANES_MIN} lanes with {@link LANE_MIN_ITEMS} dated items each. */
export function lanesDraw(lanes: readonly TimelineLane[]): boolean {
  return lanes.filter((l) => l.items.length >= LANE_MIN_ITEMS).length >= LANES_MIN;
}

const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

function dayText(iso: string, language: QuestionLanguage): string {
  return language === "no" ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso;
}

/** The lanes view, or "" when it does not draw. One axis from the earliest
 *  to the latest day; items of one lane on one day share a mark. */
export const timelineLanesHtml: TimelineLanesRenderer = (blocks, days, language, shown) => {
  const lanes = pageTimelineLanes(blocks, days, shown);
  if (!lanesDraw(lanes)) return "";
  const w = WORDS[language];
  const all = lanes.flatMap((l) => l.items.map((i) => i.day)).sort();
  const first = all[0]!;
  const last = all[all.length - 1]!;
  const span = dayMs(last) - dayMs(first);
  const at = (day: string) => (span === 0 ? 50 : Math.round(((dayMs(day) - dayMs(first)) / span) * 1000) / 10);
  const rows = lanes
    .map((lane) => {
      const byDay = new Map<string, string[]>();
      for (const i of [...lane.items].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
        byDay.set(i.day, [...(byDay.get(i.day) ?? []), i.label || (lane.kind === "queries" ? w.query : "")]);
      }
      const marks = [...byDay]
        .map(([day, labels]) => {
          const say = `${dayText(day, language)}: ${labels.join(", ")}`;
          const n = labels.length > 1 ? `<span class="tll-n" aria-hidden="true">${labels.length}</span>` : "";
          return `<li class="tll-mark" style="inset-inline-start:${at(day)}%" title="${escapeHtml(say)}"><span class="tll-dot" aria-hidden="true"></span>${n}<span class="tll-say">${escapeHtml(say)}</span></li>`;
        })
        .join("");
      const name = `${w.lanes[lane.kind]}: ${w.dated(lane.items.length)}`;
      return (
        `<div class="tll-lane tll-${lane.kind}" role="group" aria-label="${escapeHtml(name)}">` +
        `<span class="tll-label" aria-hidden="true">${escapeHtml(w.lanes[lane.kind])} · ${lane.items.length}</span>` +
        `<ol class="tll-track">${marks}</ol></div>`
      );
    })
    .join("");
  const axis = `<div class="tll-axis" aria-hidden="true"><span>${dayText(first, language)}</span><span>${dayText(last, language)}</span></div>`;
  return `<section class="${DC_VIEW_CLASS} tl-lanes" ${READER_ONLY_ATTR} role="figure" aria-label="${escapeHtml(w.title)}"><div class="dc-title">${escapeHtml(w.title)}</div>${rows}${axis}</section>`;
};
