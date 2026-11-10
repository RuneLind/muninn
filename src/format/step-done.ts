/**
 * Done on a step of a `<Lane kind="you">` (mimir plan muninn-wiki-first-screen-claims,
 * PR 1): the page text with that one step deleted. Pure; the route
 * (`wiki-step-done.ts`) runs it inside the wiki's write queue, as
 * `question-close.ts` is run for a card.
 *
 * A step is named by {@link stepKey}: a hash of its raw source lines and its
 * ordinal among steps with the same lines in the page's counted `you` lanes.
 * Never by index: the parser skips `[x]` and empty items, so indices shift.
 *
 * The result is re-read through `countedNextMovesLanes`, the walk the index and
 * the reader count with: the target lane must equal the old one minus that
 * step and every other lane must be unchanged, or nothing is written.
 */
import {
  countedNextMovesLanes,
  isSettledSection,
  laneFromAttrs,
  listItemLines,
  parseBlocks,
  parseChecklist,
  readerFencedLines,
  runChecklistSteps,
  COMPONENT_OPEN_RE,
  type Block,
  type ComponentBlock,
  type ListBlock,
  type NextMovesLane,
} from "./markdown-ast.ts";
import { frontmatterBodyLine } from "./frontmatter-fence.ts";
import { leadSentence } from "./lead-sentence.ts";
import { sha256 } from "../utils/date-hash.ts";

const CHECK_RE = /^\[([ xX])\][ \t]*([\s\S]*)$/;

/** One open step of a counted `you` lane. */
export interface YouStep {
  key: string;
  /** The step's text as `NextMovesLane.items` holds it. */
  text: string;
  /** Index among the page's counted `you` lanes. */
  lane: number;
  /** For a list step: its index among the top-level items of the lane's own
   *  lists, in source order, `[x]` and empty items included (the rows the
   *  reader renders as the lane body's `ul > li`/`ol > li`). Null for a
   *  `<Checklist>` or `<RunChecklist>` row. */
  row: number | null;
  /** Why Done cannot delete it, or null. */
  refusal: string | null;
}

export type StepDoneCode = "no-step" | "nested" | "checklist" | "unplaceable";

export type StepDoneEdit =
  | {
      ok: true;
      content: string;
      /** Every removed non-blank line, 1-based on the page. */
      removed: { line: number; text: string }[];
      /** The next item's marker line, when it took the deleted first item's number. */
      renumbered: { line: number; before: string; after: string } | null;
      laneRemoved: boolean;
      nextMovesRemoved: boolean;
      /** The step's bold label, when it opens with one. */
      label: string | null;
      lead: string;
      text: string;
    }
  | { ok: false; code: StepDoneCode; reason: string };

/** The key a step is named by: its raw lines' hash and its ordinal among equal lines. */
export function stepKey(raw: string, ordinal: number): string {
  return `${sha256(raw).slice(0, 16)}.${ordinal}`;
}

const LABEL_RE = /^(?:\[[ xX]\][ \t]*)?(\*\*|__)((?:(?!\1).)+?)(?::\1|\1:)/;

/** A step's bold label (`**Label:** …` or `**Label**: …`), or null. */
export function stepLabel(text: string): string | null {
  return LABEL_RE.exec(text.split("\n")[0]!.trim())?.[2]?.trim() ?? null;
}

/** The `log.md` bullet a Done writes. */
export function stepDoneLogLine(edit: { label: string | null; lead: string }): string {
  return edit.label && edit.label !== edit.lead ? `Step done: ${edit.label} — ${edit.lead}` : `Step done: ${edit.lead}`;
}

interface LaneRef {
  nm: ComponentBlock;
  laneBlock: ComponentBlock;
  lane: NextMovesLane;
}

interface StepRef extends YouStep {
  raw: string;
  list: ListBlock | null;
  item: number;
  laneRef: LaneRef;
}

/** Every lane of every counted `<NextMoves>`, with its blocks: `countedNextMovesLanes`' walk. */
function countedLaneRefs(blocks: Block[]): LaneRef[] {
  const out: LaneRef[] = [];
  const walk = (bs: Block[], settled: boolean) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === "NextMoves") {
        if (settled) continue;
        for (const c of b.children) {
          if (c.type === "component" && c.name === "Lane") out.push({ nm: b, laneBlock: c, lane: laneFromAttrs(c.attrs, c.children) });
        }
        continue;
      }
      walk(b.children, settled || isSettledSection(b));
    }
  };
  walk(blocks, false);
  return out;
}

interface Parsed {
  lines: string[];
  eol: string;
  from: number;
  blocks: Block[];
  refs: LaneRef[];
  steps: StepRef[];
  /** Per counted `you` lane: how many top-level items its own lists hold. */
  laneRows: number[];
}

function parsePage(text: string): Parsed | { error: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const from = frontmatterBodyLine(text.replace(/\r\n/g, "\n"));
  const blocks = parseBlocks(lines.slice(from).join("\n"));
  const refs = countedLaneRefs(blocks);
  const counted = countedNextMovesLanes(blocks).lanes;
  if (counted.length !== refs.length || counted.some((l, k) => l.items.join("\0") !== refs[k]!.lane.items.join("\0"))) {
    return { error: "the page's lanes read differently here than in the index" };
  }
  const steps: StepRef[] = [];
  const seen = new Map<string, number>();
  const push = (s: Omit<StepRef, "key">) => {
    const n = seen.get(s.raw) ?? 0;
    seen.set(s.raw, n + 1);
    steps.push({ ...s, key: stepKey(s.raw, n) });
  };
  let youIndex = 0;
  const laneRows: number[] = [];
  for (const ref of refs) {
    if (ref.lane.kind !== "you") continue;
    const lane = youIndex++;
    let row = 0;
    const found: string[] = [];
    for (const b of ref.laneBlock.children) {
      if (b.type === "ul" || b.type === "ol") {
        const at = listItemLines(b);
        b.items.forEach((item, k) => {
          const r = row++;
          const m = CHECK_RE.exec(item);
          const text = m ? (m[1] === " " ? m[2]! : null) : item;
          if (text === null || text.trim() === "") return;
          found.push(text);
          const src = at?.[k];
          if (!src?.length) {
            push({ text, lane, row: r, refusal: "the parser gave this step no source lines", raw: `\0nolines\0${text}`, list: b, item: k, laneRef: ref });
            return;
          }
          const raw = src.map((n) => lines[from + n]!).join("\n");
          const nested = b.nested?.[k] ?? [];
          const refusal = nested.some((c) => c.type === "ul" || c.type === "ol")
            ? "the step holds a nested list: edit it on the page"
            : nested.length
              ? "the step holds more than its own lines (a paragraph or code under it): edit it on the page"
              : null;
          push({ text, lane, row: r, refusal, raw, list: b, item: k, laneRef: ref });
        });
      } else if (b.type === "component" && (b.name === "Checklist" || b.name === "RunChecklist")) {
        const rows = b.name === "Checklist" ? parseChecklist(b.children).filter((x) => !x.checked && x.text.trim() !== "") : runChecklistSteps(b.children).filter((x) => !x.checked);
        for (const x of rows) {
          found.push(x.text);
          push({ text: x.text, lane, row: null, refusal: `a <${b.name}> row: tick it on the page`, raw: `\0${b.name}\0${x.text}`, list: null, item: -1, laneRef: ref });
        }
      }
    }
    if (found.join("\0") !== ref.lane.items.join("\0")) return { error: "a lane's steps read differently here than in the index" };
    laneRows.push(row);
  }
  return { lines, eol, from, blocks, refs, steps, laneRows };
}

/** The open steps of every counted `you` lane, with their keys, in page order. */
export function listYouSteps(text: string): YouStep[] | null {
  const p = parsePage(text);
  if ("error" in p) return null;
  return p.steps.map(({ key, text: t, lane, row, refusal }) => ({ key, text: t, lane, row, refusal }));
}

/** Per counted `you` lane, how many top-level items its own lists hold, `[x]`
 *  and empty ones included: what the reader checks its rendered rows against. */
export function youLaneRows(text: string): number[] | null {
  const p = parsePage(text);
  return "error" in p ? null : p.laneRows;
}

/** The line a component closes on, by the parser's rule: a `</Name>` line,
 *  same-name opens nesting, fenced lines skipped. Absolute; -1 when unclosed. */
function closeLine(lines: string[], from: number, fenced: boolean[], open: number, name: string): number {
  const first = lines[open]!.trim().match(COMPONENT_OPEN_RE);
  if (first && first[4]!.includes(`</${name}>`)) return open;
  let depth = 1;
  for (let i = open + 1; i < lines.length; i++) {
    if (fenced[i - from]) continue;
    const t = lines[i]!.trim();
    if (t === `</${name}>`) {
      if (--depth === 0) return i;
      continue;
    }
    const m = t.match(COMPONENT_OPEN_RE);
    if (m && m[1] === name && m[3] !== "/" && !m[4]!.includes(`</${name}>`)) depth++;
  }
  return -1;
}

const blank = (s: string | undefined) => s !== undefined && s.trim() === "";

/** Add to `del` the blank line after each deleted run that a blank line also precedes. */
function collapseBlanks(lines: string[], del: Set<number>, lo: number, hi: number): void {
  for (let i = lo; i <= hi; i++) {
    if (!del.has(i) || del.has(i - 1)) continue;
    let e = i;
    while (del.has(e + 1)) e++;
    if (blank(lines[i - 1]) && blank(lines[e + 1]) && e + 1 <= hi) del.add(e + 1);
    i = e;
  }
}

const laneShape = (l: NextMovesLane) => JSON.stringify([l.kind, l.known, l.label, l.who, l.role, l.since, l.sinceRaw, l.items]);

/** The page text with step `key` deleted, or why not. */
export function stepDoneEdit(text: string, key: string): StepDoneEdit {
  const p = parsePage(text);
  const unplaceable = (why: string): StepDoneEdit => ({ ok: false, code: "unplaceable", reason: `${why}: edit the step on the page` });
  if ("error" in p) return unplaceable(p.error);
  const step = p.steps.find((s) => s.key === key);
  if (!step) return { ok: false, code: "no-step", reason: "the page has no such open step: it changed or the step is gone" };
  if (step.refusal) return { ok: false, code: step.list ? "nested" : "checklist", reason: step.refusal };
  const { lines, from, eol } = p;
  const list = step.list!;
  const src = listItemLines(list)![step.item]!.map((n) => from + n);
  const fenced = readerFencedLines(lines.slice(from).join("\n"));
  const laneOpen = p.from + (step.laneRef.laneBlock.line ?? -1);
  const nmOpen = p.from + (step.laneRef.nm.line ?? -1);
  if (step.laneRef.laneBlock.line === undefined || step.laneRef.nm.line === undefined) return unplaceable("the lane has no source line");
  const laneClose = closeLine(lines, from, fenced, laneOpen, "Lane");
  const nmClose = closeLine(lines, from, fenced, nmOpen, "NextMoves");
  if (laneClose <= laneOpen || nmClose <= nmOpen || src.some((n) => n <= laneOpen || n >= laneClose)) return unplaceable("the step shares a line with its lane's tags");

  const del = new Set(src);
  let renumbered: { line: number; before: string; after: string } | null = null;
  const out = [...lines];
  if (list.type === "ol" && step.item === 0 && list.items.length > 1) {
    const all = listItemLines(list)!;
    const next = from + all[1]![0]!;
    const own = /^(\s*)(\d{1,9})([.)])/.exec(lines[src[0]!]!);
    const theirs = /^(\s*)(\d{1,9})([.)])/.exec(lines[next]!);
    if (!own || !theirs) return unplaceable("the numbered list's markers could not be read");
    if (own[2] !== theirs[2]) {
      out[next] = `${theirs[1]}${own[2]}${lines[next]!.slice(theirs[1]!.length + theirs[2]!.length)}`;
      renumbered = { line: next + 1, before: lines[next]!, after: out[next]! };
    }
  }
  collapseBlanks(lines, del, laneOpen + 1, laneClose - 1);
  const bodyLeft = (open: number, close: number) => {
    for (let i = open + 1; i < close; i++) if (!del.has(i) && !blank(lines[i])) return true;
    return false;
  };
  let laneRemoved = false;
  let nextMovesRemoved = false;
  if (!bodyLeft(laneOpen, laneClose)) {
    laneRemoved = true;
    for (let i = laneOpen; i <= laneClose; i++) del.add(i);
    collapseBlanks(lines, del, nmOpen + 1, nmClose - 1);
    if (!bodyLeft(nmOpen, nmClose)) {
      nextMovesRemoved = true;
      for (let i = nmOpen; i <= nmClose; i++) del.add(i);
      collapseBlanks(lines, del, from, lines.length - 1);
    }
  }
  const content = out.filter((_, i) => !del.has(i)).join(eol);
  const removed = [...del].sort((a, b) => a - b).filter((i) => !blank(lines[i])).map((i) => ({ line: i + 1, text: lines[i]! }));

  // The postcondition, through the walk the index counts with.
  const before = countedNextMovesLanes(p.blocks).lanes;
  const after = countedNextMovesLanes(parseBlocks(content.split(/\r?\n/).slice(from).join("\n"))).lanes;
  const at = p.refs.indexOf(step.laneRef);
  const ownIndex = p.steps.filter((s) => s.laneRef === step.laneRef).indexOf(step);
  const target = before[at]!;
  const expected = before.map(laneShape);
  if (laneRemoved) {
    if (target.items.length !== 1) return unplaceable("the lane would go with steps still in it");
    expected.splice(at, 1);
  } else {
    expected[at] = laneShape({ ...target, items: target.items.filter((_, k) => k !== ownIndex) });
  }
  const got = after.map(laneShape);
  if (got.length !== expected.length || got.some((g, k) => g !== expected[k])) return unplaceable("the page would not read back as the step removed");
  return {
    ok: true,
    content,
    removed,
    renumbered,
    laneRemoved,
    nextMovesRemoved,
    label: stepLabel(step.text),
    lead: leadSentence(step.text),
    text: step.text,
  };
}
