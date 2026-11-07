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
import { DECISION_ID_RE, parseQuestionPage } from "./question.ts";
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
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

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

/** Every `<DecisionLog>` … `</DecisionLog>` outside a code fence, by line. */
function logRegions(lines: string[], from: number): Region[] {
  const out: Region[] = [];
  let fence: string | null = null;
  let open = -1;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!.repeat(3);
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const t = line.trim();
    if (open < 0 && /^<DecisionLog(?:\s[^>]*)?>$/.test(t)) open = i;
    else if (open >= 0 && t === "</DecisionLog>") {
      out.push({ open, close: i });
      open = -1;
    }
  }
  return out;
}

/** The top-level list items in a region: those at the first item's indent. */
function regionItems(lines: string[], r: Region): Item[] {
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
    // A fence opens a nested code block, as a blank line or a list item ends the paragraph.
    const ends = (l: string) => l.trim() === "" || ITEM_RE.test(l) || /^\s*(`{3,}|~{3,})/.test(l);
    while (paraEnd + 1 < limit && !ends(lines[paraEnd + 1]!)) paraEnd++;
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

/** Text with MDX's `<`, `{` and `}` escaped. */
const mdxText = (text: string) => text.replace(/</g, "&lt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

/** One line of answer text: white space collapsed, escaped ({@link mdxText}), ending in a sentence stop. */
function answerSentence(text: string): string {
  const one = mdxText(text.replace(/\s+/g, " ").trim());
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
  const before = parseQuestionPage(parseBlocks(lines.slice(from).join("\n")));
  if (!before.questions.some((q) => q.id === id)) return { ok: false, code: "no-card", reason: `the page has no card ${id}` };
  const regions = logRegions(lines, from);
  if (regions.length === 0) return { ok: false, code: "no-log", reason: "the page has no <DecisionLog>, so where a close goes is a choice for the page: open it on the page" };
  const state = before.states.get(id);
  if (state && state.kind !== "open") return { ok: false, code: "not-open", reason: `card ${id} is already closed` };

  const items = regions.flatMap((r) => regionItems(lines, r).map((it) => ({ ...it, region: r })));
  const own = items.find((it) => it.id === id);
  let decision: string;
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
    if (!own) block.push(`${lead}**${id}**${sep}See the card. Closed ${today} (${decision}).`);
    block.push(`${lead}**${decision}**${sep}${what} ${mdxText(ruling.author)}, ${ruling.date}.`);
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

  const after = parseQuestionPage(parseBlocks(content.split(/\r?\n/).slice(from).join("\n")));
  const read = after.states.get(id);
  // The edit adds one `Closed` phrase. Read decided on `decision` means it is
  // canonical and last; a phrase that is not canonical leaves the card open.
  if (read?.kind !== "decided" || read.decision !== decision) {
    return { ok: false, code: "unplaceable", reason: `the page's log has a shape the close cannot place: close ${id} on the page` };
  }
  return { ok: true, content, decision, lines: shown };
}
