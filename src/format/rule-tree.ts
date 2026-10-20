/**
 * `<RuleTree title="…" outcomes="…">`: a rule written as a nested list, read
 * as a tree. An item's italic lead (`*yes:*`) is the edge label; an item whose
 * text starts with `→` is a leaf, and its outcome takes its tone from
 * `outcomes=`. A leaf's cases follow its last ` — ` (white space, em dash,
 * white space) as a comma-separated list of ids.
 *
 * Pure and browser-safe: `web-format.ts` imports it, and the chat bundle
 * carries `web-format.ts`. The render (`rule-tree-view.ts`, passed in by
 * `renderWikiHtml`) and lint check 18 (`src/wiki/lint-rule-tree.ts`) both read
 * a tree through {@link readRuleTree}, each handing it the same text function.
 */
import { lineCodeSpanRanges } from "./code-spans.ts";
import { labelListWarnings, normalizeLabel, parseLabelList } from "./delta-table.ts";
import type { Block, ListBlock, ListChild } from "./markdown-ast.ts";
import type { QuestionLanguage } from "./question-labels.ts";
import { STATUS_TILE_TONES, type StatusTone } from "./report-top.ts";

/** Words `outcomes=` takes besides the StatusRows tones, and the tone each reads as. */
const OUTCOME_TONE_WORDS: Readonly<Record<string, StatusTone>> = { yes: "good", no: "muted", fix: "warn" };

/** Every word an `outcomes=` entry may name, for the docs and the lint message.
 *  Read case-sensitively: `Good` is not read. */
export const RULE_TREE_TONES: readonly string[] = [...STATUS_TILE_TONES, ...Object.keys(OUTCOME_TONE_WORDS)];

const readOutcomeTone = (v: string): StatusTone | null => {
  const t = v.trim();
  if ((STATUS_TILE_TONES as readonly string[]).includes(t)) return t as StatusTone;
  return OUTCOME_TONE_WORDS[t] ?? null;
};

/** A case id by grammar; any other id counts only when a CaseBoard on the page holds it. */
export const RULE_TREE_CASE_ID_RE = /^[A-Z]+-\d+$/;

/** A year a leaf names: 19xx or 20xx, not inside a longer word or number. */
const YEAR_RE = /(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}])/gu;

/** The italic lead: `*label*` or `_label_`, an optional `:` after it. */
const LEAD_RES = [/^\*(?![\s*→])([^*\n]+?)\*(?![*\p{L}\p{N}_])(:?)/u, /^_(?![\s_→])([^_\n]+?)_(?![_\p{L}\p{N}])(:?)/u];

/** A leaf's arrow, after at most one opening emphasis run (captured). */
const ARROW_RE = /^\s*(\*\*|__|\*|_)?\s*→/;

/** The run that closes an opening emphasis run: after a non-space, not before a letter or digit. */
const closerRe = (run: string) => new RegExp(`(?<=\\S)${run.replace(/\*/g, "\\*")}(?![\\p{L}\\p{N}])`, "u");

/** A markdown link's `(destination)`, as `visibleText` reads a link. */
const LINK_DEST_RE = /(!?\[[^\]\n]*\])(\([^)\n]*\))/g;

/** A stand-in for each code-span character, so a delimiter inside code is not found. */
const CODE_MASK = "";

export interface RuleLeaf {
  /** The outcome's visible text; empty when the leaf names none. */
  outcome: string;
  tone: StatusTone | null;
  /** The case ids, each once, in source order. */
  cases: string[];
  /** `rest` cut where the cases start: `body + dash + pieces.join(",")` is `rest`.
   *  Null when the leaf names no cases. */
  caseSplit: { body: string; dash: string; pieces: string[] } | null;
  /** The years on the leaf's path: each ancestor item's own text, then the
   *  leaf's edge label and text before its cases. */
  years: string[];
  /** The leaf has a ` — ` tail that reads as no case ids (a typo, a full stop
   *  after the id): lint names it, since the reader draws it as text. */
  unreadTail: boolean;
}

export type RuleUnder = { kind: "list"; list: ListBlock; nodes: RuleNode[] } | { kind: "other"; child: ListChild };

export interface RuleNode {
  /** The item's text as the list holds it. */
  raw: string;
  /** The italic lead as written and its label; null without one. */
  lead: { raw: string; label: string } | null;
  /** `raw` after the lead. */
  rest: string;
  leaf: RuleLeaf | null;
  /** What sits under the item, in source order. */
  under: RuleUnder[];
  /** The item's visible text, the name lint gives it. */
  name: string;
}

export type RuleTreeLevel = "fatal" | "warning" | "info";

export interface RuleTreeFinding {
  message: string;
  /** `fatal`: the reader renders the body as written. */
  level: RuleTreeLevel;
  /** The item the finding is about; absent for the block itself. */
  node?: RuleNode;
}

export interface RuleTreeRead {
  before: Block[];
  list: ListBlock | null;
  after: Block[];
  nodes: RuleNode[];
  /** Every case id on a leaf, first seen first. */
  cases: string[];
  findings: RuleTreeFinding[];
}

export interface RuleTreeReadOptions {
  /** Raw item text to visible text: the reader reads wikilink sentinels as
   *  their link text first, the lint its parked links; both then `visibleText`. */
  text: (raw: string) => string;
  /** The page's CaseBoard ids; the lint reads no board file and passes none. */
  boardIds?: ReadonlySet<string>;
  /** The page holds a CaseBoard the caller did not read (the lint): an id
   *  outside the grammar may be on it, so a leaf whose other ids pass the
   *  grammar takes those as its cases and leaves the unknown ones out. */
  boardUnread?: boolean;
}

/** `s` with each inline code span's characters replaced, length kept. */
function maskCode(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      let out = "";
      let at = 0;
      for (const r of lineCodeSpanRanges(line)) {
        out += line.slice(at, r.start) + CODE_MASK.repeat(r.end - r.start);
        at = r.end;
      }
      return out + line.slice(at);
    })
    .join("\n");
}

const unstruck = (s: string) => s.replace(/~~[\s\S]*?~~/g, "");

/** `s` with code spans and link destinations masked, length kept. */
const maskInline = (s: string) => maskCode(s).replace(LINK_DEST_RE, (_m, text: string, dest: string) => text + CODE_MASK.repeat(dest.length));

/** An ASCII arrow where a leaf's `→` goes. */
const ASCII_ARROW_RE = /^\s*(\*\*|__|\*|_)?\s*->/;

/** The years `raw` names, struck text aside. */
const yearsIn = (raw: string, opts: RuleTreeReadOptions) => [...new Set(opts.text(unstruck(raw)).match(YEAR_RE) ?? [])];

function readLead(raw: string, text: (raw: string) => string): RuleNode["lead"] {
  for (const re of LEAD_RES) {
    const m = re.exec(raw);
    const label = m?.[1];
    if (m && label !== undefined) return { raw: m[0], label: text(label).replace(/:\s*$/, "").trim() };
  }
  return null;
}

function readLeaf(lead: string, rest: string, opts: RuleTreeReadOptions): RuleLeaf | null {
  // Code spans and link destinations masked, so a `(`, `,` or dash in either is no delimiter.
  const masked = maskInline(rest);
  const arrow = ARROW_RE.exec(masked);
  if (!arrow) return null;
  const from = arrow[0].length;
  let dash: RegExpExecArray | null = null;
  // The arrow's run holds no `—`, so every ` — ` lies after it; one in link text is no case dash.
  const unlinked = maskCode(rest).replace(LINK_DEST_RE, (m) => CODE_MASK.repeat(m.length));
  for (const m of unlinked.matchAll(/\s—\s/g)) dash = m as RegExpExecArray;
  const paren = masked.indexOf("(", from);
  const run = arrow[1];
  const closer = run ? closerRe(run).exec(masked.slice(from)) : null;
  const end = Math.min(paren < 0 ? masked.length : paren, dash ? dash.index : masked.length, closer ? from + closer.index : masked.length);
  const outcome = opts.text(unstruck(rest.slice(from, end))).replace(/[\s.,;:]+$/, "").trim();
  let caseSplit: RuleLeaf["caseSplit"] = null;
  let cases: string[] = [];
  let unreadTail = false;
  if (dash) {
    const tail = dash.index + dash[0].length;
    const pieces: string[] = [];
    let at = tail;
    for (const m of masked.slice(tail).matchAll(/,/g)) {
      pieces.push(rest.slice(at, tail + m.index));
      at = tail + m.index + 1;
    }
    pieces.push(rest.slice(at));
    const ids = pieces.map((p) => opts.text(unstruck(p)).trim()).filter(Boolean);
    const known = ids.filter((id) => RULE_TREE_CASE_ID_RE.test(id) || opts.boardIds?.has(id) === true);
    if (known.length && (known.length === ids.length || opts.boardUnread === true)) {
      caseSplit = { body: rest.slice(0, dash.index), dash: rest.slice(dash.index, tail), pieces };
      cases = [...new Set(known)];
    }
    // On a page with a board the lint did not read, an unknown id may be a board id.
    unreadTail = ids.length > 0 && !caseSplit && opts.boardUnread !== true;
  }
  return { outcome, tone: null, cases, caseSplit, years: yearsIn(lead + (caseSplit ? caseSplit.body : rest), opts), unreadTail };
}

/** `pathYears`: the years its ancestors' own text names, outermost first. */
function readNodes(list: ListBlock, opts: RuleTreeReadOptions, pathYears: readonly string[] = []): RuleNode[] {
  return list.items.map((raw, k) => {
    const lead = readLead(raw, opts.text);
    const rest = raw.slice(lead?.raw.length ?? 0);
    const leaf = readLeaf(lead?.raw ?? "", rest, opts);
    const years = [...new Set([...pathYears, ...(leaf ? leaf.years : yearsIn(raw, opts))])];
    if (leaf) leaf.years = years;
    const under: RuleUnder[] = (list.nested?.[k] ?? []).map((c) =>
      c.type === "ul" || c.type === "ol" ? { kind: "list", list: c, nodes: readNodes(c, opts, years) } : { kind: "other", child: c },
    );
    return { raw, lead, rest, leaf, under, name: opts.text(raw) };
  });
}

/** Every node of `nodes` and under them, in source order. */
export function ruleTreeNodes(nodes: readonly RuleNode[]): RuleNode[] {
  const out: RuleNode[] = [];
  const walk = (ns: readonly RuleNode[]) => {
    for (const n of ns) {
      out.push(n);
      for (const u of n.under) if (u.kind === "list") walk(u.nodes);
    }
  };
  walk(nodes);
  return out;
}

const NAME_MAX = 60;
const quoteName = (n: RuleNode) => `«${n.name.length > NAME_MAX ? `${n.name.slice(0, NAME_MAX - 1)}…` : n.name}»`;

/** Two leaves may share a case only when each names a year and no year is on both. */
function yearsApart(leaves: readonly RuleLeaf[]): boolean {
  const seen = new Set<string>();
  for (const l of leaves) {
    if (!l.years.length || l.years.some((y) => seen.has(y))) return false;
    for (const y of l.years) seen.add(y);
  }
  return true;
}

/** Read a `<RuleTree>` body: its first direct-child list is the tree; blocks
 *  before and after it render in place. */
export function readRuleTree(children: readonly Block[], attrs: Readonly<Record<string, string>>, opts: RuleTreeReadOptions): RuleTreeRead {
  const k = children.findIndex((b) => b.type === "ul" || b.type === "ol");
  if (k < 0) {
    return {
      before: [...children],
      list: null,
      after: [],
      nodes: [],
      cases: [],
      findings: [{ message: "holds no list; it renders as written", level: "fatal" }],
    };
  }
  const list = children[k] as ListBlock;
  const nodes = readNodes(list, opts);
  const outcomes = parseLabelList(attrs.outcomes ?? "", readOutcomeTone);
  const all = ruleTreeNodes(nodes);
  const leaves = all.filter((n): n is RuleNode & { leaf: RuleLeaf } => n.leaf !== null);
  for (const n of leaves) n.leaf.tone = n.leaf.outcome ? (outcomes.rows.get(normalizeLabel(n.leaf.outcome)) ?? null) : null;

  const findings: RuleTreeFinding[] = [];
  if (outcomes.bad.length) {
    findings.push({ message: `outcomes entry not read (use "Outcome=${RULE_TREE_TONES.join("|")}"): ${outcomes.bad.join("; ")}`, level: "warning" });
  }
  for (const w of labelListWarnings("outcomes", outcomes.labels, leaves.map((n) => n.leaf.outcome).filter(Boolean))) {
    findings.push({ message: w.replace("names no row", "names no leaf outcome").replace("names a row", "names an outcome"), level: "info" });
  }
  const untoned = new Map<string, (RuleNode & { leaf: RuleLeaf })[]>();
  for (const n of leaves) {
    if (!n.leaf.outcome) findings.push({ message: `leaf ${quoteName(n)} names no outcome after →`, level: "warning", node: n });
    else if (!n.leaf.tone) {
      const key = normalizeLabel(n.leaf.outcome);
      untoned.set(key, [...(untoned.get(key) ?? []), n]);
    }
  }
  for (const ns of untoned.values()) {
    const [first] = ns;
    if (!first) continue;
    const more = ns.length > 1 ? ` (${ns.length} leaves)` : "";
    findings.push({ message: `outcome "${first.leaf.outcome}" has no tone in outcomes${more}, first at leaf ${quoteName(first)}`, level: "warning", node: first });
  }
  const byCase = new Map<string, (RuleNode & { leaf: RuleLeaf })[]>();
  for (const n of leaves) for (const id of n.leaf.cases) byCase.set(id, [...(byCase.get(id) ?? []), n]);
  for (const [id, ns] of byCase) {
    const second = ns[1];
    if (!second || yearsApart(ns.map((n) => n.leaf))) continue;
    findings.push({
      message: `case ${id} is on ${ns.length} leaves that do not each name a different year: ${ns.map(quoteName).join(", ")}`,
      level: "warning",
      node: second,
    });
  }
  for (const n of all) {
    if (!n.leaf && (maskInline(n.raw).includes("→") || ASCII_ARROW_RE.test(n.rest))) {
      findings.push({ message: `item ${quoteName(n)} has → but is not read as a leaf (write the edge label in italics: *label:*)`, level: "info", node: n });
    } else if (n.leaf?.unreadTail) {
      findings.push({ message: `leaf ${quoteName(n)}: the text after the last — reads as no case ids`, level: "info", node: n });
    }
  }
  return { before: children.slice(0, k), list, after: children.slice(k + 1), nodes, cases: [...byCase.keys()], findings };
}

/** What the reader's view gets. `inline`, `same`, `child` and `blocks` are
 *  `web-format.ts`'s own renderers, passed in so the view adds no second one. */
export interface RuleTreeViewInput {
  read: RuleTreeRead & { list: ListBlock };
  /** The title as written (wikilink sentinels kept: the reader's restore links them). */
  title: string;
  /** The title's visible text, the tree's accessible name. */
  titleText: string;
  inline: (raw: string) => string;
  /** The pieces render as `whole` does, white space aside. */
  same: (pieces: readonly string[], whole: string) => boolean;
  child: (c: ListChild) => string;
  blocks: (bs: Block[]) => string;
  /** CaseBoard case id → its `kort:` rendered; ids with no `kort:` are absent. */
  korts: ReadonlyMap<string, string>;
  language: QuestionLanguage;
}

export type RuleTreeViewRenderer = (input: RuleTreeViewInput) => string;
