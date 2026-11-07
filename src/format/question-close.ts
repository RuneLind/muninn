/**
 * Closing a `<Question>` card from the decision inbox (P3b of mimir
 * plans/muninn-wiki-decision-triage.mdx, D23): the page text with the card's
 * DecisionLog item closed. Pure; the route runs it inside the wiki's write queue.
 * Server code only, like `question-unclosed.ts`.
 *
 * Placement reads the raw lines, and the result is re-read through
 * `parseQuestionPage`, the parse the reader and lint check 10 run: when that
 * parse does not see the card closed on the decision written, nothing is written.
 */
import { parseBlocks } from "./markdown-ast.ts";
import { parseLogItem } from "./genre-lists.ts";
import { DECISION_ID_RE, eachComponent, parseQuestionPage, type DecisionLogEntry } from "./question.ts";
import { frontmatterBodyLine } from "../wiki/page-text.ts";

/** What closes the card: a decision the page already holds (the P1 hint), or an answer to record as a new one. */
export type CloseRuling =
  | { kind: "decision"; decision: string }
  /** `date` as the log writes it, `DD.MM.YYYY`. */
  | { kind: "answer"; choice: string | null; body: string; author: string; date: string };

export type CloseEdit =
  | { ok: true; content: string; decision: string; lines: string[] }
  | { ok: false; reason: string; code: "no-log" | "no-card" | "not-open" | "no-ruling" | "unplaceable" };

const ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])( +)(\S.*)$/;
/** `parseBlocks`' fence line (`FENCE_LINE_RE` in markdown-ast.ts): backticks only, 0–3 spaces. */
const FENCE_LINE_RE = /^( {0,3})(`{3,})(.*)$/;

/**
 * The line indices `parseBlocks` reads as fenced code, opener and closer
 * included, by its rule: an opener has no backtick in its info string and
 * counts only when a closer (a run at least as long, nothing after it) follows.
 */
function fencedLines(lines: string[], from: number): Set<number> {
  const out = new Set<number>();
  for (let i = from; i < lines.length; i++) {
    const open = FENCE_LINE_RE.exec(lines[i]!);
    if (!open || open[3]!.includes("`")) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const c = FENCE_LINE_RE.exec(lines[j]!);
      if (c && c[2]!.length >= open[2]!.length && c[3]!.trim() === "") {
        close = j;
        break;
      }
    }
    if (close < 0) continue;
    for (let k = i; k <= close; k++) out.add(k);
    i = close;
  }
  return out;
}

interface Region {
  open: number;
  close: number;
}

interface Item {
  start: number;
  /** Last line of the first paragraph: where a close phrase goes. */
  paraEnd: number;
  /** Last non-blank line of the item, nested lines included. */
  end: number;
  indent: string;
  marker: string;
  gap: string;
  id: string | null;
  sep: string;
}

/** Every `<DecisionLog>` … `</DecisionLog>` outside fenced code, by line. */
function logRegions(lines: string[], from: number, fenced: Set<number>): Region[] {
  const out: Region[] = [];
  let open = -1;
  for (let i = from; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const t = lines[i]!.trim();
    if (open < 0 && /^<DecisionLog(?:\s[^>]*)?>$/.test(t)) open = i;
    else if (open >= 0 && t === "</DecisionLog>") {
      out.push({ open, close: i });
      open = -1;
    }
  }
  return out;
}

/** The top-level list items in a region: those at the first item's indent. */
function regionItems(lines: string[], r: Region, fenced: Set<number>): Item[] {
  let top: number | null = null;
  const starts: number[] = [];
  for (let i = r.open + 1; i < r.close; i++) {
    const m = ITEM_RE.exec(lines[i]!);
    if (!m) continue;
    if (top === null) top = m[1]!.length;
    if (m[1]!.length === top) starts.push(i);
  }
  const items: Item[] = [];
  starts.forEach((start, k) => {
    const limit = starts[k + 1] ?? r.close;
    const m = ITEM_RE.exec(lines[start]!)!;
    let paraEnd = start;
    // Fenced code ends the paragraph, as a blank line or a list item does.
    const ends = (i: number) => lines[i]!.trim() === "" || ITEM_RE.test(lines[i]!) || fenced.has(i);
    while (paraEnd + 1 < limit && !ends(paraEnd + 1)) paraEnd++;
    let end = paraEnd;
    for (let i = paraEnd + 1; i < limit; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      // A line at or left of the marker after a blank line is a paragraph after the list.
      if (indent <= top! && lines[i - 1]!.trim() === "") break;
      end = i;
    }
    const p = parseLogItem(m[4]!);
    items.push({ start, paraEnd, end, indent: m[1]!, marker: m[2]!, gap: m[3]!, id: p.id, sep: p.id ? p.sep : "" });
  });
  return items;
}

const decisionNumber = (id: string) => Number(id.slice(1));

/** Text on one line, so it can open no item of its own, with MDX's `<`, `{` and `}` escaped. */
const mdxText = (text: string) => text.replace(/\s+/g, " ").trim().replace(/</g, "&lt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

/** One line of answer text ({@link mdxText}), ending in a sentence stop. */
function answerSentence(text: string): string {
  const one = mdxText(text);
  return /[.!?]$/.test(one) ? one : `${one}.`;
}

function withStop(line: string): string {
  const t = line.trimEnd();
  return /[.!?)»"”*]$/.test(t) ? t : `${t}.`;
}

/**
 * The page text with card `id` closed. With a `decision` ruling, the card's
 * item gets `Closed <today> (Dn).`; with an `answer`, a new decision `Dn+1`
 * (`Answer X on card Oy.` or the answer's text, then `<author>, <date>.`) goes
 * after the log's last decision, and the card's item is closed on it. A card
 * with no item gets one. A page with no `<DecisionLog>` is refused (D23).
 * `today` is `YYYY-MM-DD`.
 */
export function closeCardEdit(text: string, id: string, ruling: CloseRuling, today: string): CloseEdit {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  // Where the reader and lint end the frontmatter (`splitFrontmatter`).
  const from = frontmatterBodyLine(text.replace(/\r\n/g, "\n"));
  const blocks = parseBlocks(lines.slice(from).join("\n"));
  const before = parseQuestionPage(blocks);
  if (!before.questions.some((q) => q.id === id)) return { ok: false, code: "no-card", reason: `the page has no card ${id}` };
  // Whether the page has a log is the parser's answer (D23); the line scan only places.
  let parsedLog = false;
  eachComponent(blocks, (b) => {
    if (b.name === "DecisionLog") parsedLog = true;
  });
  if (!parsedLog) return { ok: false, code: "no-log", reason: "the page has no <DecisionLog>, so where a close goes is a choice for the page: open it on the page" };
  const fenced = fencedLines(lines, from);
  const regions = logRegions(lines, from, fenced);
  if (regions.length === 0) return { ok: false, code: "unplaceable", reason: `the page's log has a shape the close cannot place: close ${id} on the page` };
  const state = before.states.get(id);
  if (state && state.kind !== "open") return { ok: false, code: "not-open", reason: `card ${id} is already closed` };

  const items = regions.flatMap((r) => regionItems(lines, r, fenced).map((it) => ({ ...it, region: r })));
  const own = items.find((it) => it.id === id);
  let decision: string;
  /** The items the edit adds, as the parser must read them back. */
  const inserted: { id: string; itemText: string }[] = [];
  const added: { after: number; text: string }[] = [];
  if (ruling.kind === "decision") {
    if (!own) return { ok: false, code: "unplaceable", reason: `card ${id} has no log item to close` };
    if (!before.decisions.has(ruling.decision)) return { ok: false, code: "no-ruling", reason: `the page's log has no ${ruling.decision}` };
    decision = ruling.decision;
  } else {
    const ds = items.filter((it) => it.id && DECISION_ID_RE.test(it.id));
    const max = Math.max(0, ...[...before.decisions].map(decisionNumber));
    decision = `D${max + 1}`;
    // After the log's last decision item, else after the card's own item, else at the end of the first log.
    const anchor = ds.at(-1) ?? own ?? items.filter((it) => it.region === regions[0]).at(-1);
    const style = anchor ?? { indent: "", marker: "-", gap: " ", sep: " — " };
    const sep = style.sep || " — ";
    const what = ruling.choice !== null ? `Answer ${mdxText(ruling.choice)} on card ${id}.` : answerSentence(ruling.body);
    if (!what.replace(/[.\s]/g, "")) return { ok: false, code: "no-ruling", reason: "the answer is empty: write the ruling on the page" };
    const at = anchor ? anchor.end : regions[0]!.open;
    const lead = `${style.indent}${style.marker}${style.gap}`;
    const block: string[] = [];
    if (!own) {
      block.push(`${lead}**${id}**${sep}See the card. Closed ${today} (${decision}).`);
      inserted.push({ id, itemText: `See the card. Closed ${today} (${decision}).` });
    }
    const decisionText = `${what} ${mdxText(ruling.author)}, ${mdxText(ruling.date)}.`;
    block.push(`${lead}**${decision}**${sep}${decisionText}`);
    inserted.push({ id: decision, itemText: decisionText });
    // An empty log gets its list after a blank line, and keeps one before the close tag.
    added.push({ after: at, text: anchor ? block.join(eol) : ["", ...block, ""].join(eol) });
  }

  const out = [...lines];
  const shown: string[] = [];
  if (own) {
    out[own.paraEnd] = `${withStop(out[own.paraEnd]!)} Closed ${today} (${decision}).`;
    shown.push(own.paraEnd === own.start ? out[own.start]! : `${out[own.start]!} … ${out[own.paraEnd]!.trim()}`);
  }
  for (const a of added.sort((x, y) => y.after - x.after)) out.splice(a.after + 1, 0, a.text);
  for (const a of added) shown.push(...a.text.split(eol).filter((l) => l.trim()));
  const content = out.join(eol);

  // The postcondition, read through the parser the reader and lint run: every
  // entry the page had is there in order with its text, except that the card's
  // item gains the phrase at the end of its first paragraph, and the inserted
  // items are exactly the ones written. Anything else (a fence, a lazy line or a
  // log the line scan reads differently) is refused, never written.
  const after = parseQuestionPage(parseBlocks(content.split(/\r?\n/).slice(from).join("\n")));
  const phrase = `Closed ${today} (${decision}).`;
  const ownAt = before.entries.findIndex((e) => e.id === id);
  const expected: { id: string; itemText: string; text: string }[] = before.entries.map((e: DecisionLogEntry, k) =>
    k === ownAt ? { id, itemText: `${withStop(e.itemText)} ${phrase}`, text: `${withStop(e.itemText)} ${phrase}${e.text.slice(e.itemText.length)}` } : e,
  );
  // An inserted id is new to the page (a card with no item, a decision past the
  // highest), so its first entry is the one written.
  const insertedAt = inserted.map((x) => after.entries.findIndex((e) => e.id === x.id));
  const kept = after.entries.filter((_, k) => !insertedAt.includes(k));
  const placed =
    after.entries.length === before.entries.length + inserted.length &&
    kept.length === expected.length &&
    kept.every((e, k) => e.id === expected[k]!.id && e.itemText === expected[k]!.itemText && e.text === expected[k]!.text) &&
    inserted.every((x, k) => insertedAt[k]! >= 0 && after.entries[insertedAt[k]!]!.itemText === x.itemText) &&
    after.states.get(id)?.kind === "decided";
  if (!placed) {
    return { ok: false, code: "unplaceable", reason: `the page's log has a shape the close cannot place: close ${id} on the page` };
  }
  return { ok: true, content, decision, lines: shown };
}
