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
import { DECISION_ID_RE, eachComponent, maskCodeSpans, parseQuestionPage, type DecisionLogEntry } from "./question.ts";
import { frontmatterBodyLine } from "./frontmatter-fence.ts";
import { lineCodeSpanRanges } from "./code-spans.ts";
import { analyzeDecisionChains } from "./decision-chain.ts";

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
/** A D id named anywhere in a log item's text, as a word. */
const NAMED_DECISION_RE = /(?<![\p{L}\p{N}_])D(\d{1,4})(?![\p{L}\p{N}_])/gu;

/**
 * Where the page's parsers would read the owner's prose as grammar: an inline
 * tag's `<` (the reader renders `<Fact …>`, `<Check/>`), the first letter of a
 * decision's «Lukker/Closes On» (a decision-chain edge) and of a canonical
 * close or reopen word before a date (the close rule), the first letter of a
 * reversal word (`parseLogItem`'s «superseded by Dn» / «erstattet av Dn» dim
 * and the chain's word after a struck lead), and of a prose «PR n» /
 * «oppgave n» (a decision → PR edge: the owner adds a real link instead). A
 * WORD JOINER goes after the match: invisible in the reader, and no parser's
 * tag or word pattern spans it.
 */
/** Any case and any neighbour, as `REVERSAL_FOLLOWER_RE` (decision-chain.ts) and `SUPERSEDED_RE` (genre-lists.ts) read them. */
const REVERSAL_WORD_RE = /(?=snudd|reversed|superseded|erstattet)\p{L}/giu;
const GRAMMAR_RES = [
  REVERSAL_WORD_RE,
  // `PROSE_PR_RE` (decision-chain.ts): `PR` in capitals, `oppgave` with either first letter.
  /(?<![\p{L}\p{N}_[])(?=(?:PR|[Oo]ppgave)[ \t\u00a0]+\d)\p{L}/gu,
  /<(?=[A-Za-z/!?>])|(?<![\p{L}\p{N}_])(?=(?:[Ll]ukker|[Cc]loses)[ \t\u00a0]+[SO]\d)\p{L}|(?<![\p{L}\p{N}_])(?=(?:Closed|Lukket|Reopened|Gjenåpnet)[ \t\u00a0]+\d)\p{L}/gu,
];
const JOINER = "\u2060";

type Seg =
  | { kind: "fixed"; text: string }
  | { kind: "prose"; text: string }
  /** `inner`: the text between the delimiters, as written. */
  | { kind: "code"; inner: string; fence: number };

/**
 * One owner text as segments: on one line (it can open no item of its own),
 * split by its OWN code spans, which is what the owner sees in that text alone.
 * In NFC, the form every parser reads (`maskCodeSpans`), so the scan sees a
 * decomposed «Gjenåpnet» and a U+1FEF that NFC turns into a backtick as they do.
 */
function ownerSegs(text: string): Seg[] {
  const one = text.normalize("NFC").replace(/\s+/g, " ").trim();
  const out: Seg[] = [];
  let last = 0;
  for (const r of lineCodeSpanRanges(one)) {
    if (r.start > last) out.push({ kind: "prose", text: one.slice(last, r.start) });
    out.push({ kind: "code", inner: one.slice(r.start + r.runLen, r.end - r.runLen), fence: r.runLen });
    last = r.end;
  }
  if (last < one.length) out.push({ kind: "prose", text: one.slice(last) });
  return out;
}

const fixed = (text: string): Seg[] => [{ kind: "fixed", text }];
const segText = (s: Seg) => (s.kind === "code" ? "`".repeat(s.fence) + s.inner + "`".repeat(s.fence) : s.text);

/**
 * The decision's line from fixed words and owner texts, written so the page
 * reads what each owner text shows on its own (arch review 2026-11-16 F50): no
 * entities (the reader prints `&lt;` as typed), the owner's code spans as the
 * only code, and no grammar from the prose.
 *
 * Code spans pair across the whole line, so a backtick in one text can pair
 * with one in another. When the line pairs otherwise than the texts do, every
 * owner span is re-fenced longer than any run on the line (its content shows
 * the same), and a stray run that still pairs gets a span of its own. Grammar
 * is then broken with {@link JOINER}, in prose only: inserting it moves no
 * backtick and splits no backslash run, so the pairing checked here is the one
 * every parser and the reader compute. Null when the pairing cannot be made to
 * agree; the close then refuses.
 */
function inertLine(parts: Seg[][]): string | null {
  const segs = parts.flat();
  const lineOf = () => segs.map(segText).join("");
  /** The first span the line pairs that the segments do not mean, or null when they agree. */
  const firstStray = () => {
    const actual = lineCodeSpanRanges(lineOf());
    const expected: { start: number; end: number }[] = [];
    let at = 0;
    for (const s of segs) {
      const len = segText(s).length;
      if (s.kind === "code") expected.push({ start: at, end: at + len });
      at += len;
    }
    const k = actual.findIndex((a, i) => a.start !== expected[i]?.start || a.end !== expected[i]?.end);
    if (k >= 0) return actual[k]!.start;
    return actual.length === expected.length ? null : -1;
  };
  if (firstStray() !== null) {
    const fence = Math.max(...(lineOf().match(/`+/g) ?? [""]).map((r) => r.length)) + 1;
    for (const s of segs) if (s.kind === "code") s.fence = fence;
    for (let guard = 0; ; guard++) {
      const start = firstStray();
      if (start === null) break;
      if (start < 0 || guard > 1000) return null;
      let at = 0;
      const i = segs.findIndex((s) => {
        const len = segText(s).length;
        if (start < at + len) return true;
        at += len;
        return false;
      });
      const s = segs[i];
      if (!s || s.kind !== "prose") return null;
      const from = start - at;
      let to = from;
      while (s.text[to] === "`") to++;
      const pieces: Seg[] = [];
      if (from > 0) pieces.push({ kind: "prose", text: s.text.slice(0, from) });
      pieces.push({ kind: "code", inner: ` ${s.text.slice(from, to)} `, fence });
      if (to < s.text.length) pieces.push({ kind: "prose", text: s.text.slice(to) });
      segs.splice(i, 1, ...pieces);
    }
  }
  // The scan reads the whole line with its spans blanked, so a phrase running
  // from one text into the next is seen.
  const masked = segs.map((s) => (s.kind === "code" ? "\n".repeat(segText(s).length) : s.text)).join("");
  const cuts = new Set<number>();
  for (const re of GRAMMAR_RES) for (const m of masked.matchAll(re)) cuts.add(m.index! + m[0].length);
  // `parseLogItem` reads «superseded by» with every `(`+)…\1` stretch deleted
  // (`withoutCodeSpans`), which joins `superse``ded` and pairs runs no reader
  // pairs. A cut goes after a letter, so it moves no backtick and that reading
  // stays the one scanned here.
  const line = segs.map(segText).join("");
  const kept: number[] = [];
  let last = 0;
  for (const m of line.matchAll(/(`+)[\s\S]*?\1/g)) {
    for (let k = last; k < m.index!; k++) kept.push(k);
    last = m.index! + m[0].length;
  }
  for (let k = last; k < line.length; k++) kept.push(k);
  for (const m of kept.map((k) => line[k]).join("").matchAll(REVERSAL_WORD_RE)) cuts.add(kept[m.index!]! + 1);
  let out = "";
  let at = 0;
  for (const s of segs) {
    const t = segText(s);
    if (s.kind === "prose") for (let k = 0; k < t.length; k++) out += t[k] + (cuts.has(at + k + 1) ? JOINER : "");
    else out += t;
    at += t.length;
  }
  return out;
}

/** An answer's text as segments, ending in a sentence stop. */
function answerSentence(text: string): Seg[] {
  const segs = ownerSegs(text);
  return /[.!?]$/.test(segs.map(segText).join("")) ? segs : [...segs, ...fixed(".")];
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
  return closeEdit(text, id, ruling, today, false);
}

/** {@link closeCardEdit}; `neutralProbe` marks the run that tells a refusal's cause, which never probes again. */
function closeEdit(text: string, id: string, ruling: CloseRuling, today: string, neutralProbe: boolean): CloseEdit {
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
    // Past every D id the log defines AND names outside code (an orphan «Closed …
    // (D2)» or a «superseded by D2» would otherwise tie that entry to the new
    // decision; a `D39` citing another plan is masked, as every parser masks it).
    const named = before.entries.flatMap((e) => [...maskCodeSpans(e.text).matchAll(NAMED_DECISION_RE)].map((m) => Number(m[1])));
    const max = Math.max(0, ...[...before.decisions].map(decisionNumber), ...named);
    decision = `D${max + 1}`;
    // After the log's last decision item, else after the card's own item, else at the end of the first log.
    const anchor = ds.at(-1) ?? own ?? items.filter((it) => it.region === regions[0]).at(-1);
    const style = anchor ?? { indent: "", marker: "-", gap: " ", sep: " — " };
    const sep = style.sep || " — ";
    const what = ruling.choice !== null ? [fixed("Answer "), ownerSegs(ruling.choice), fixed(` on card ${id}.`)] : [answerSentence(ruling.body)];
    if (!what.flat().map(segText).join("").replace(/[.\s]/g, "")) return { ok: false, code: "no-ruling", reason: "the answer is empty: write the ruling on the page" };
    // Every owner text on the decision's one line, read together (`inertLine`).
    const decisionText = inertLine([...what, fixed(" "), ownerSegs(ruling.author), fixed(", "), ownerSegs(ruling.date), fixed(".")]);
    if (decisionText === null) return { ok: false, code: "unplaceable", reason: `the answer's backticks cannot be written on one line: close ${id} on the page` };
    const at = anchor ? anchor.end : regions[0]!.open;
    const lead = `${style.indent}${style.marker}${style.gap}`;
    const block: string[] = [];
    if (!own) {
      block.push(`${lead}**${id}**${sep}See the card. Closed ${today} (${decision}).`);
      inserted.push({ id, itemText: `See the card. Closed ${today} (${decision}).` });
    }
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
  const afterBlocks = parseBlocks(content.split(/\r?\n/).slice(from).join("\n"));
  const after = parseQuestionPage(afterBlocks);
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
  // A new decision carries no grammar of the owner's: it is not dimmed, and its
  // chain is the close's own edge, no reversal and no PR (ledgers left out, so
  // every prose number counts). Grammar the joiners could not break (a parser
  // reading a code span as prose) is refused, never written.
  if (ruling.kind === "answer") {
    const chain = analyzeDecisionChains(afterBlocks, []).chains.find((c) => c.decision === decision);
    const clean =
      after.entries.find((e) => e.id === decision)?.dim === false &&
      chain !== undefined &&
      chain.reversed === null &&
      chain.outputs.length === 0 &&
      chain.questions.length === 1 &&
      chain.questions[0]!.id === id;
    if (!clean) {
      // Blame the answer only when an answer with no owner words would pass.
      const neutral = neutralProbe || closeEdit(text, id, NEUTRAL_ANSWER, today, true).ok;
      const reason = neutral
        ?`the answer reads as decision-log grammar the close cannot neutralize: close ${id} on the page`
        : `the page's log already ties ${decision} to another entry: close ${id} on the page`;
      return { ok: false, code: "unplaceable", reason };
    }
  }
  return { ok: true, content, decision, lines: shown };
}

/** An answer with no owner grammar: what a refusal's cause is measured against. */
const NEUTRAL_ANSWER: CloseRuling = { kind: "answer", choice: "A", body: "", author: "A", date: "01.01.2000" };
