/**
 * Done on a step of a `<Lane kind="you">` (mimir plan muninn-wiki-first-screen-claims,
 * PR 1): the page text with that one step deleted. Pure; the route
 * (`wiki-step-done.ts`) runs it inside the wiki's write queue, as
 * `question-close.ts` is run for a card.
 *
 * A step is named by a key of the page's own bytes and the step's place among
 * the page's open `you` steps. A key read from one page text names nothing on
 * any other, so every Done starts from a fresh list of the page it edits.
 *
 * The result is re-read through `countedNextMovesLanes`, the walk the index and
 * the reader count with: the target lane must equal the old one minus that
 * step and every other lane must be unchanged, or nothing is written.
 */
import {
  countedNextMovesLanes,
  isSettledSection,
  isTaskList,
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
  type OlBlock,
} from "./markdown-ast.ts";
import { ordinals } from "./block-renderer.ts";
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
      /** The later items of the step's numbered list, each taking its number minus one. */
      renumbered: { line: number; before: string; after: string }[];
      laneRemoved: boolean;
      nextMovesRemoved: boolean;
      /** What the log line says of the step: its lead sentence as plain text, a bold label kept. */
      lead: string;
      text: string;
    }
  | { ok: false; code: StepDoneCode; reason: string };

/** The `log.md` bullet a Done writes. */
export function stepDoneLogLine(edit: { lead: string }): string {
  return `Step done: ${edit.lead}`;
}

interface LaneRef {
  nm: ComponentBlock;
  laneBlock: ComponentBlock;
  lane: NextMovesLane;
}

interface StepRef extends YouStep {
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
  /** `ends[i]` is the line break after `lines[i]`, byte for byte ("" after the last). */
  ends: string[];
  from: number;
  blocks: Block[];
  refs: LaneRef[];
  steps: StepRef[];
  /** Per counted `you` lane: how many top-level items its own lists hold. */
  laneRows: number[];
}

function parsePage(text: string): Parsed | { error: string } {
  const lines = text.split(/\r?\n/);
  const ends = [...text.matchAll(/\r?\n/g)].map((m) => m[0]);
  ends.push("");
  const from = frontmatterBodyLine(text.replace(/\r\n/g, "\n"));
  const blocks = parseBlocks(lines.slice(from).join("\n"));
  const refs = countedLaneRefs(blocks);
  const counted = countedNextMovesLanes(blocks).lanes;
  if (counted.length !== refs.length || counted.some((l, k) => l.items.join("\0") !== refs[k]!.lane.items.join("\0"))) {
    return { error: "the page's lanes read differently here than in the index" };
  }
  const steps: StepRef[] = [];
  const pageHash = sha256(text).slice(0, 16);
  const push = (s: Omit<StepRef, "key">) => {
    steps.push({ ...s, key: `${pageHash}.${steps.length}` });
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
            push({ text, lane, row: r, refusal: "the parser gave this step no source lines", list: b, item: k, laneRef: ref });
            return;
          }
          const nested = b.nested?.[k] ?? [];
          const refusal = nested.some((c) => c.type === "ul" || c.type === "ol")
            ? "the step holds a nested list: edit it on the page"
            : nested.length
              ? "the step holds more than its own lines (a paragraph or code under it): edit it on the page"
              : null;
          push({ text, lane, row: r, refusal, list: b, item: k, laneRef: ref });
        });
      } else if (b.type === "component" && (b.name === "Checklist" || b.name === "RunChecklist")) {
        const rows = b.name === "Checklist" ? parseChecklist(b.children).filter((x) => !x.checked && x.text.trim() !== "") : runChecklistSteps(b.children).filter((x) => !x.checked);
        for (const x of rows) {
          found.push(x.text);
          push({ text: x.text, lane, row: null, refusal: `a <${b.name}> row: tick it on the page`, list: null, item: -1, laneRef: ref });
        }
      }
    }
    if (found.join("\0") !== ref.lane.items.join("\0")) return { error: "a lane's steps read differently here than in the index" };
    laneRows.push(row);
  }
  return { lines, ends, from, blocks, refs, steps, laneRows };
}

/** The open steps of every counted `you` lane, with their keys, in page order. */
export function listYouSteps(text: string): YouStep[] | null {
  const p = parsePage(text);
  if ("error" in p) return null;
  return p.steps.map(({ key, text: t, lane, row, refusal }) => ({ key, text: t, lane, row, refusal }));
}

/** Each open LIST step of {@link listYouSteps}, refused ones included, with
 *  its first source line (1-based on the page) and whether its list is a task
 *  list (a `[ ]`/`[x]` row in it, which the reader draws as a checklist).
 *  Lint's `check-placement` reads where a step's `<Check>` may go from here. */
export function youListStepLines(text: string): { line: number; text: string; taskList: boolean }[] | null {
  const p = parsePage(text);
  if ("error" in p) return null;
  return p.steps.flatMap((s) => {
    const at = s.list ? listItemLines(s.list)?.[s.item] : undefined;
    return s.list && at?.length ? [{ line: p.from + at[0]! + 1, text: s.text, taskList: isTaskList(s.list) }] : [];
  });
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

const TAG_RE = /^<\/?[A-Z][\w.]*(?:\s[^>]*)?\/?>$/;
const MARKER_RE = /^([ \t]*)(\d{1,9})(\.)([ \t]+)/;

/**
 * Settle the blank lines around each deleted run: a blank line on both sides
 * collapses to one; text directly on both sides keeps one blank line between
 * (returned: the runs' first lines, to emit a blank there); a run at the top
 * of the page takes the blank lines after it, a run at its end the ones
 * before. A component tag line is not text: it interrupts a paragraph anyway.
 * `joinsSiblings` says a run sits between items of one list, where no blank
 * line goes in.
 */
function settleBlanks(lines: string[], del: Set<number>, from: number, joinsSiblings: (s: number, e: number) => boolean): Set<number> {
  const gapAt = new Set<number>();
  const text = (i: number) => i >= from && i < lines.length && !blank(lines[i]) && !TAG_RE.test(lines[i]!.trim());
  const runs: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!del.has(i)) continue;
    let e = i;
    while (del.has(e + 1)) e++;
    runs.push([i, e]);
    i = e;
  }
  for (const [s, e] of runs) {
    if (s === 0) for (let j = e + 1; j < lines.length - 1 && blank(lines[j]); j++) del.add(j);
    else if (e === lines.length - 1) for (let j = s - 1; j >= from && blank(lines[j]); j--) del.add(j);
    else if (blank(lines[s - 1]) && blank(lines[e + 1])) del.add(e + 1);
    else if (text(s - 1) && text(e + 1) && !joinsSiblings(s, e)) gapAt.add(s);
  }
  return gapAt;
}

/** `line` with its numbered-list marker's number set to `n`, the marker's
 *  width and indentation kept: a shorter number takes the difference as
 *  spaces after the delimiter, a zero-padded one stays padded. */
function withNumber(line: string, n: number): string | null {
  const m = MARKER_RE.exec(line);
  if (!m || n < 0) return null;
  const digits = m[2]!;
  let next = String(n);
  let pad = "";
  if (next.length < digits.length) {
    if (digits.startsWith("0")) next = next.padStart(digits.length, "0");
    else pad = " ".repeat(digits.length - next.length);
  }
  return `${m[1]}${next}${m[3]}${pad}${line.slice(m[1]!.length + digits.length + 1)}`;
}

const laneShape = (l: NextMovesLane) => JSON.stringify([l.kind, l.known, l.label, l.who, l.role, l.since, l.sinceRaw, l.items]);

/** What an edit proposes, as the postcondition reads it. */
export interface ProposedRemoval {
  content: string;
  laneRemoved: boolean;
  renumbered: readonly { before: string; after: string }[];
}

/**
 * The postcondition: why `proposed` is not the page with exactly `step`
 * removed, or null. Through the walk the index counts with.
 */
function removalViolation(p: Parsed, step: StepRef, proposed: ProposedRemoval): string | null {
  const { content, laneRemoved, renumbered } = proposed;
  const { from } = p;
  const list = step.list!;
  const before = countedNextMovesLanes(p.blocks).lanes;
  const after = countedNextMovesLanes(parseBlocks(content.split(/\r?\n/).slice(from).join("\n"))).lanes;
  const at = p.refs.indexOf(step.laneRef);
  const ownIndex = p.steps.filter((s) => s.laneRef === step.laneRef).indexOf(step);
  const target = before[at]!;
  const expected = before.map(laneShape);
  if (laneRemoved) {
    if (target.items.length !== 1) return "the lane would go with steps still in it";
    expected.splice(at, 1);
  } else {
    expected[at] = laneShape({ ...target, items: target.items.filter((_, k) => k !== ownIndex) });
  }
  const got = after.map(laneShape);
  if (got.length !== expected.length || got.some((g, k) => g !== expected[k])) return "the page would not read back as the step removed";
  // A renumbered line changes its marker's number and nothing else, and the
  // list renders as before with the step's number gone and later ones one lower.
  const sameBut = (a: string, b: string) => a.replace(MARKER_RE, "$1#$3").replace(/^([ \t]*#\.)[ \t]+/, "$1 ") === b.replace(MARKER_RE, "$1#$3").replace(/^([ \t]*#\.)[ \t]+/, "$1 ");
  if (renumbered.some((r) => !sameBut(r.before, r.after))) return "a renumbered line would change more than its number";
  if (renumbered.length && !laneRemoved) {
    const lists = (l: ComponentBlock) => l.children.filter((b): b is ListBlock => b.type === "ol" || b.type === "ul");
    const afterLane = countedLaneRefs(parseBlocks(content.split(/\r?\n/).slice(from).join("\n")))[at];
    const idx = lists(step.laneRef.laneBlock).indexOf(list);
    const now = afterLane ? lists(afterLane.laneBlock)[idx] : undefined;
    const was = ordinals((list as OlBlock).start, list.items.length, (list as OlBlock).values);
    const want = [...was.slice(0, step.item), ...was.slice(step.item + 1).map((n) => n - 1)];
    const shown = now?.type === "ol" ? ordinals(now.start, now.items.length, now.values) : null;
    if (!shown || shown.join() !== want.join()) return "the numbered list would not render as one sequence";
  }
  return null;
}

/** The postcondition for a list step of `text`, for a result some edit proposes. Null: it holds. */
export function stepRemovalViolation(text: string, key: string, proposed: ProposedRemoval): string | null {
  const p = parsePage(text);
  if ("error" in p) return p.error;
  const step = p.steps.find((s) => s.key === key);
  return step?.list ? removalViolation(p, step, proposed) : "the page has no such list step";
}

/** The page text with step `key` deleted, or why not. `violationOf` is the postcondition it must pass. */
export function stepDoneEdit(text: string, key: string, violationOf: typeof removalViolation = removalViolation): StepDoneEdit {
  const p = parsePage(text);
  const unplaceable = (why: string): StepDoneEdit => ({ ok: false, code: "unplaceable", reason: `${why}: edit the step on the page` });
  if ("error" in p) return unplaceable(p.error);
  const step = p.steps.find((s) => s.key === key);
  if (!step) return { ok: false, code: "no-step", reason: "the page has no such open step: it changed or the step is gone" };
  if (step.refusal) return { ok: false, code: step.list ? "nested" : "checklist", reason: step.refusal };
  const { lines, ends, from } = p;
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
  const renumbered: { line: number; before: string; after: string }[] = [];
  const out = [...lines];
  const all = listItemLines(list)!;
  // A numbered list: every later item takes its number minus one, unless all
  // its items carry the same number (`1.` `1.` `1.`), which stays as written.
  if (list.type === "ol") {
    const heads = all.map((ls) => from + ls[0]!);
    const nums = heads.map((n) => MARKER_RE.exec(lines[n]!)?.[2]);
    if (nums.some((n) => n === undefined)) return unplaceable("the numbered list's markers could not be read");
    const values = nums.map((n) => parseInt(n!, 10));
    if (values.some((v) => v !== values[0])) {
      for (let k = step.item + 1; k < heads.length; k++) {
        const at = heads[k]!;
        const next = withNumber(lines[at]!, values[k]! - 1);
        if (next === null) return unplaceable("the numbered list could not be renumbered");
        out[at] = next;
        renumbered.push({ line: at + 1, before: lines[at]!, after: next });
      }
    }
  }
  const bodyLeft = (open: number, close: number) => {
    for (let i = open + 1; i < close; i++) if (!del.has(i) && !blank(lines[i])) return true;
    return false;
  };
  let laneRemoved = false;
  let nextMovesRemoved = false;
  if (!bodyLeft(laneOpen, laneClose)) {
    laneRemoved = true;
    for (let i = laneOpen; i <= laneClose; i++) del.add(i);
    if (!bodyLeft(nmOpen, nmClose)) {
      nextMovesRemoved = true;
      for (let i = nmOpen; i <= nmClose; i++) del.add(i);
    }
  }
  const siblings = new Set(all.filter((_, k) => k !== step.item).flat().map((n) => from + n));
  const gapAt = settleBlanks(lines, del, from, (s, e) => !laneRemoved && (siblings.has(s - 1) || siblings.has(e + 1)));
  // Each surviving line keeps its own line break; the page's last line break
  // (none, or a final one) stays the last.
  const kept: string[] = [];
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (gapAt.has(i)) kept.push(ends[i]!);
    if (del.has(i)) continue;
    kept.push(out[i]! + ends[i]!);
    last = kept.length - 1;
  }
  if (del.has(lines.length - 1) && last >= 0) kept[last] = kept[last]!.replace(/\r?\n$/, "");
  const content = kept.join("");
  const removed = [...del].sort((a, b) => a - b).filter((i) => !blank(lines[i])).map((i) => ({ line: i + 1, text: lines[i]! }));

  const why = violationOf(p, step, { content, laneRemoved, renumbered });
  if (why) return unplaceable(why);
  return {
    ok: true,
    content,
    removed,
    renumbered,
    laneRemoved,
    nextMovesRemoved,
    lead: leadSentence(step.text, { keepLabel: true }),
    text: step.text,
  };
}
