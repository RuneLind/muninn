/**
 * Discuss's wiki agent (mimir plan muninn-wiki-discuss, P2b): what one turn
 * reads and says, apart from the model call. The route
 * (`src/dashboard/routes/wiki-discuss.ts`) runs the turn; this module holds
 * the rules-file loader, the repos in reach, the turn's prompt and the reading
 * of a proposed edit out of the answer.
 *
 * The rules file (`.wiki-agent.md` at the wiki root) is prose for the model and
 * nothing else: no guard, tool or surface is read from it. The surface is the
 * route's, by the owning bot's connector type.
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Lexer, Tokenizer, getDefaults } from "marked";
import { findRepo, type GitRun, originBasename } from "./decision-triage/git.ts";
import type { ContextPack } from "./discuss-pack.ts";
import { clampLine, passageWhere } from "./discuss-prompt.ts";
import { parseEditList, type EditListResult } from "./integrate-edits.ts";
import type { RepoRoots } from "./decision-triage/git.ts";
import { sameWikiRoot } from "./readonly.ts";
import { truncateUnits } from "./ask-chat.ts";

/** The rules file, at the wiki root beside `.wiki-reader.json` (D3). */
export const WIKI_AGENT_RULES_FILE = ".wiki-agent.md";
/** The rules file's bound, in bytes. A file over it is refused, never cut:
 *  a rule cut in half reads as a different rule. */
export const WIKI_AGENT_RULES_MAX_BYTES = 16 * 1024;
/** One turn's model call, not the bot's timeout. */
export const DISCUSS_TURN_TIMEOUT_MS = 5 * 60 * 1000;
/** How many earlier turns the prompt carries, newest kept. */
export const DISCUSS_HISTORY_TURNS = 6;
/** Each earlier answer's bound in the prompt. */
export const DISCUSS_HISTORY_ANSWER_MAX = 4000;
/** The heading list's bound, in headings. */
export const DISCUSS_HEADINGS_MAX = 120;
/** The words the pack uses for a repo the page asked for and did not get. */
export const NOT_IN_REACH = "not in reach on this wiki";
/** The words for a page with no repo in reach. */
export const NO_REPO_IN_REACH = "no repo in reach";

export type RulesRead =
  | { state: "ok"; text: string; bytes: number }
  | { state: "absent" }
  | { state: "too-large"; bytes: number }
  | { state: "not-a-file" }
  | { state: "unreadable"; error: string };

/** Read the wiki's rules file, per turn. A symlink is refused: the file goes
 *  into a model prompt, and a link could point anywhere. */
export async function readWikiAgentRules(wikiRoot: string): Promise<RulesRead> {
  const file = path.join(wikiRoot, WIKI_AGENT_RULES_FILE);
  let st;
  try {
    st = await lstat(file);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", error: (err as Error).message };
  }
  if (!st.isFile()) return { state: "not-a-file" };
  if (st.size > WIKI_AGENT_RULES_MAX_BYTES) return { state: "too-large", bytes: st.size };
  try {
    const buf = await readFile(file);
    if (buf.length > WIKI_AGENT_RULES_MAX_BYTES) return { state: "too-large", bytes: buf.length };
    const text = buf.toString("utf8").trim();
    if (!text) return { state: "absent" };
    return { state: "ok", text, bytes: buf.length };
  } catch (err) {
    return { state: "unreadable", error: (err as Error).message };
  }
}

/** The refusal for a `.wiki-agent.md` that exists but the agent does not accept (422 too large, 503 unreadable or not a file); null for `ok` and `absent`, which each caller answers itself. Shared by the Discuss engine and Apply. */
export function wikiAgentRulesRefusal(rules: RulesRead): { status: 422 | 503; body: { error: string; reason: "rules-too-large" | "rules-unreadable" } } | null {
  if (rules.state === "ok" || rules.state === "absent") return null;
  if (rules.state === "too-large") {
    return { status: 422, body: { error: `the wiki's .wiki-agent.md is ${rules.bytes} bytes, over the ${WIKI_AGENT_RULES_MAX_BYTES}-byte bound`, reason: "rules-too-large" } };
  }
  return { status: 503, body: { error: "the wiki's .wiki-agent.md cannot be read", reason: "rules-unreadable" } };
}

/** A turn's mode: Explore answers; Edit may propose an edit to the page. */
export type DiscussMode = "explore" | "edit";

/** The line under a rules file's heading that marks its edit section. */
export const DISCUSS_EDIT_SECTION_MARKER = "<!-- discuss:edit -->";

/**
 * marked's block tokenizer, recording where each top-level heading and marker
 * starts. At the top level the lexer hands a tokenizer the input from the
 * current block on, so `src.length` gives the block's offset exactly; summing
 * the tokens' raws would not (a link definition leaves no token, and indented
 * code after a paragraph is merged into it with an added newline). Block quotes
 * and lists are the only block tokenizers that lex nested blocks; what they
 * hold is not top level.
 */
class RulesBlockTokenizer extends Tokenizer {
  readonly found: { rest: number; depth: number | null }[] = [];
  private nested = 0;
  private top(src: string, depth: number | null): void {
    if (this.nested === 0) this.found.push({ rest: src.length, depth });
  }
  override heading(src: string) {
    const t = super.heading(src);
    if (t) this.top(src, t.depth);
    return t;
  }
  override lheading(src: string) {
    const t = super.lheading(src);
    if (t) this.top(src, t.depth);
    return t;
  }
  override html(src: string) {
    const t = super.html(src);
    if (t && t.raw.trim() === DISCUSS_EDIT_SECTION_MARKER) this.top(src, null);
    return t;
  }
  override blockquote(src: string) {
    this.nested++;
    try {
      return super.blockquote(src);
    } finally {
      this.nested--;
    }
  }
  override list(src: string) {
    this.nested++;
    try {
      return super.list(src);
    } finally {
      this.nested--;
    }
  }
}

/**
 * The rules a turn gets for its mode. The file's block structure is CommonMark's,
 * read by marked's lexer: its top-level headings (ATX and Setext) and its
 * top-level HTML blocks; fenced code (backticks or tildes, any info string, an
 * unclosed fence running to the end) and indented code are opaque.
 *
 * A marker is a top-level HTML block that is exactly
 * {@link DISCUSS_EDIT_SECTION_MARKER}; one inside code, a list or a block quote
 * is not a marker and is sent as written. A marker belongs to the nearest
 * heading above it; that heading's section runs from the heading through the
 * line before the next heading of the same or a higher level, and goes only to
 * Edit turns. A section that would cover every heading of the file (its
 * heading is the first and nothing after it is of the same or a higher level)
 * is the whole rules file, whatever its level: it marks nothing, the file is
 * sent whole and `warn` hears of it once. A marker above every heading marks
 * nothing. No marker line is ever sent; a file with no marker is sent unchanged
 * in both modes.
 */
export function rulesForMode(rules: string, mode: DiscussMode, warn?: (msg: string) => void): string {
  const text = rules.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const tokenizer = new RulesBlockTokenizer();
  new Lexer({ ...getDefaults(), tokenizer }).lex(text);
  const lineAt = (rest: number) => text.slice(0, text.length - rest).split("\n").length - 1;
  const headings = tokenizer.found.flatMap(({ rest, depth }) => (depth === null ? [] : [{ line: lineAt(rest), depth }]));
  const markers = tokenizer.found.flatMap(({ rest, depth }) => (depth === null ? [lineAt(rest)] : []));
  if (markers.length === 0) return rules;
  const drop = new Set(markers);
  let warned = false;
  for (const markerAt of markers) {
    const h = headings.findLastIndex((x) => x.line < markerAt);
    if (h < 0) continue;
    const { line: start, depth } = headings[h]!;
    const next = headings.findIndex((x, i) => i > h && x.depth <= depth);
    if (h === 0 && next < 0) {
      if (!warned) warn?.(`${DISCUSS_EDIT_SECTION_MARKER} sits under the rules file's first heading, whose section is the whole file: ignored`);
      warned = true;
      continue;
    }
    if (mode === "edit") continue;
    const end = next < 0 ? lines.length : headings[next]!.line;
    for (let i = start; i < end; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The name prefix of a wiki thread, counted in its 50-unit bound. */
export const WIKI_THREAD_NAME_PREFIX = "Wiki: ";

/** A page's wiki thread name: `wiki: <title>` lowercased, the title cut to
 *  fit `max` units with the suffix (`getOrCreateWikiThread`'s `nameFor`). */
export function wikiThreadName(title: string, suffix: string, max = 50): string {
  const flat = title.replace(/\s+/g, " ").trim().toLowerCase() || "page";
  return `${WIKI_THREAD_NAME_PREFIX.toLowerCase()}${truncateUnits(flat, max - WIKI_THREAD_NAME_PREFIX.length - suffix.length).trimEnd()}${suffix}`;
}

/**
 * The repos a page asks for: its `repos:` (an inline list or one name); without
 * that key, its `project` as the reader's listing computes it; otherwise none.
 */
export function pageReposAsked(fm: Record<string, string | string[]>, project: string | undefined): string[] {
  const raw = fm.repos;
  const listed = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? raw.split(",") : null;
  const names = listed ? listed : project ? [project] : [];
  return [...new Set(names.map((n) => n.trim().replace(/^\[|\]$/g, "").trim()).filter(Boolean))];
}

export interface RepoInReach {
  name: string;
  /** The checkout's top level. */
  dir: string;
}

export interface RepoMissed {
  name: string;
  /** Why: {@link NOT_IN_REACH}, with the detail after it. */
  why: string;
}

export interface ReposReach {
  inReach: RepoInReach[];
  missed: RepoMissed[];
  /** A name the page asked for that is this wiki's own repo. */
  own: string[];
}

/**
 * Which of the page's repos the agent may read: a name is in reach only when
 * the wiki's `discuss.repos` lists it and `DECISION_TRIAGE_REPO_ROOTS` has a
 * checkout of it. The wiki's own repo is never in the list (its snapshot is
 * the wiki root already). `allow` null (no config, or one that did not parse)
 * puts nothing in reach.
 */
export async function reposInReach(opts: {
  asked: readonly string[];
  allow: readonly string[] | null | undefined;
  roots: RepoRoots | null;
  wikiRoot: string;
  git: GitRun;
}): Promise<ReposReach> {
  const out: ReposReach = { inReach: [], missed: [], own: [] };
  if (opts.asked.length === 0) return out;
  const ownOrigin = await opts.git(opts.wikiRoot, ["remote", "get-url", "origin"]);
  const ownName = ownOrigin.ok ? originBasename(ownOrigin.stdout) : path.basename(opts.wikiRoot);
  const allow = new Set(opts.allow ?? []);
  for (const name of opts.asked) {
    if (name === ownName) {
      out.own.push(name);
      continue;
    }
    if (!allow.has(name)) {
      out.missed.push({ name, why: NOT_IN_REACH });
      continue;
    }
    if (!opts.roots) {
      out.missed.push({ name, why: `${NOT_IN_REACH} (DECISION_TRIAGE_REPO_ROOTS is not set)` });
      continue;
    }
    const found = await findRepo(name, opts.roots, opts.git);
    if ("reason" in found) {
      out.missed.push({ name, why: `${NOT_IN_REACH} (no checkout on this machine: ${found.reason})` });
      continue;
    }
    if (sameWikiRoot(found.dir, opts.wikiRoot)) {
      out.own.push(name);
      continue;
    }
    out.inReach.push({ name, dir: found.dir });
  }
  return out;
}

/** A repo's snapshot as the pack names it. */
export interface PackRepo {
  name: string;
  dir: string;
  ref: string;
}

/** How the turn reaches the wiki and the code: read and search over
 *  snapshots, or a list of named MCP tools. */
export type AgentReach =
  | { kind: "readSearch"; wikiSnapshot: string; repos: PackRepo[]; missed: RepoMissed[]; own: string[] }
  | {
      kind: "mcpTools";
      tools: Record<string, string[]>;
      /** The `wiki` value the research server's wiki read tools take for this
       *  page's wiki; absent when that wiki is not in the bot's list. */
      wikiToolsWiki?: string;
    };

export interface EarlierTurn {
  question: string;
  selection: string | null;
  answer: string;
  endState: string;
}

/** The system prompt: a fixed frame and the wiki's own rules (for the turn's
 *  mode, {@link rulesForMode}). No persona. */
export function renderAgentSystemPrompt(wiki: string, rules: string): string {
  return [
    `You are the wiki agent behind Discuss in muninn's wiki reader. You discuss one page of the "${wiki}" wiki with the reader, in a thread.`,
    "Earlier exchanges of the thread come in the prompt as the discussion so far. The context pack describes this turn: what you can read, the page's place, the marked passage, its section with line numbers, the heading list and, for a plan page, its card. You cannot write files or run commands.",
    "The wiki's own rules follow. They decide how you answer.",
    "",
    "<wiki_rules>",
    rules,
    "</wiki_rules>",
  ].join("\n");
}

function numbered(text: string, fromLine: number): string {
  return text
    .split("\n")
    .map((l, i) => `${fromLine + i}: ${l}`)
    .join("\n");
}

function readSection(reach: AgentReach, pack: ContextPack): string[] {
  if (reach.kind === "mcpTools") {
    const tools = Object.entries(reach.tools).flatMap(([server, ts]) => ts.map((t) => `${server}-${t}`));
    return [
      "## What you can read",
      `The context pack below, and these tools only: ${tools.join(", ")}.`,
      "The knowledge server's search finds other pages of this wiki and the team's documents. yggdrasil's tools reach the indexed code: search finds it, file_outline lists a file's symbols, symbol_context shows a symbol's source and its callers.",
      ...(reach.wikiToolsWiki && reach.tools.research?.includes("wiki_grep")
        ? [
            `This wiki's own files: use research-wiki_grep for an exact key, id or a "where else" question (it finds every tracked file that holds it), research-wiki_read to read a file it returned, and research-wiki_history for the commits that added or removed a term. Pass wiki: ${JSON.stringify(reach.wikiToolsWiki)} to each.`,
          ]
        : []),
      "Cite code as `repo/path:line` from what a tool returned, and a page line as `" + pack.relPath + ":LINE`.",
    ];
  }
  const lines = [
    "## What you can read",
    "Read, Grep and Glob, inside these directories only. Each is a read-only snapshot; never cite a snapshot's path.",
    `- this wiki ("${pack.wiki}"): ${reach.wikiSnapshot}. Cite its files as \`<path in the wiki>:LINE\`, e.g. \`${pack.relPath}:12\`.`,
  ];
  for (const r of reach.repos) lines.push(`- ${r.name}: ${r.dir} (${r.ref}). Cite a file at ${r.dir}/src/x.ts as \`${r.name}/src/x.ts:LINE\`.`);
  lines.push("");
  lines.push("## Code in reach");
  if (reach.repos.length === 0) lines.push(`${NO_REPO_IN_REACH[0]!.toUpperCase()}${NO_REPO_IN_REACH.slice(1)}: no code repo's snapshot is given for this page.`);
  else lines.push(reach.repos.map((r) => `- ${r.name}: ${r.dir}`).join("\n"));
  for (const m of reach.missed) lines.push(`- ${m.name}: ${m.why}`);
  for (const o of reach.own) lines.push(`- ${o}: this wiki's own repo; its files are the wiki snapshot above`);
  return lines;
}

/**
 * The turn's prompt: what the agent can read, the context pack, the
 * discussion so far and the question, last.
 */
export function renderAgentTurnPrompt(opts: {
  pack: ContextPack;
  reach: AgentReach;
  card: string | null;
  cardNote?: string | null;
  earlier: readonly EarlierTurn[];
  question: string;
}): string {
  const { pack, reach } = opts;
  const out: string[] = [];
  out.push("## The page");
  out.push(`Wiki: ${pack.wiki}`);
  out.push(`Title: ${pack.title}`);
  out.push(`Page: ${pack.relPath}`);
  if (reach.kind === "readSearch") out.push(`Page file: ${pack.path} (inside the wiki snapshot ${reach.wikiSnapshot})`);
  out.push("");
  out.push(...readSection(reach, pack));
  out.push("");
  if (pack.passage !== null) {
    out.push(`## The marked passage (${passageWhere(pack)})`);
    out.push(pack.passage.split("\n").map((l) => `> ${l}`).join("\n"));
  } else {
    out.push("## The question is about the whole page");
  }
  out.push("");
  if (pack.section) {
    const head = pack.passage === null ? "The page from the top" : `The section the passage sits in${pack.section.heading ? ` («${clampLine(pack.section.heading, 200)}»)` : ""}`;
    out.push(`## ${head}, lines ${pack.section.fromLine}–${pack.section.toLine}`);
    out.push("Line numbers are the file's. Frontmatter and component tag lines are blank.");
    out.push("```text");
    out.push(numbered(pack.section.text, pack.section.fromLine));
    out.push("```");
    out.push("");
  }
  if (pack.headings.length) {
    out.push("## Headings");
    for (const h of pack.headings.slice(0, DISCUSS_HEADINGS_MAX)) out.push(`- ${"#".repeat(h.level)} ${clampLine(h.text, 160)} (lines ${h.fromLine}–${h.toLine})`);
    if (pack.headings.length > DISCUSS_HEADINGS_MAX) out.push(`- … ${pack.headings.length - DISCUSS_HEADINGS_MAX} more headings`);
    out.push("");
  }
  if (opts.card) {
    out.push("## The page's card");
    out.push(opts.card);
    out.push("");
  } else if (opts.cardNote) {
    out.push("## The page's card");
    out.push(opts.cardNote);
    out.push("");
  }
  const earlier = opts.earlier.slice(-DISCUSS_HISTORY_TURNS);
  if (earlier.length) {
    out.push("## The discussion so far");
    if (opts.earlier.length > earlier.length) out.push(`(${opts.earlier.length - earlier.length} earlier turns left out)`);
    for (const t of earlier) {
      out.push(`Question${t.selection ? ` about «${clampLine(t.selection, 200)}»` : ""}: ${clampLine(t.question, 2000)}`);
      const answer = t.answer.length > DISCUSS_HISTORY_ANSWER_MAX ? `${t.answer.slice(0, DISCUSS_HISTORY_ANSWER_MAX)} [… cut]` : t.answer;
      out.push(`Answer${t.endState === "done" ? "" : ` (${t.endState}, unfinished)`}: ${answer || "(none)"}`);
      out.push("");
    }
  }
  out.push("## Question");
  out.push(opts.question.trim());
  return out.join("\n");
}

/** Replace the live wiki root with the snapshot's in a card's text, so the
 *  paths it names are paths the agent can read. */
export function cardForSnapshot(card: string, wikiRoot: string, snapshotDir: string): string {
  const live = wikiRoot.replace(/\/+$/, "") + "/";
  return card.split(live).join(snapshotDir.replace(/\/+$/, "") + "/");
}

export interface ProposedEdit extends EditListResult {
  /** More edits than the one a turn may propose: the rules file asks for one. */
  overLimit: boolean;
}

/**
 * The bodies of an answer's fenced code blocks, in order. A fence opens with
 * three or more backticks or tildes (up to three spaces in, any info string)
 * and closes on a line of the same character, at least as long, and nothing
 * else; an unclosed fence runs to the end. CRLF reads as LF.
 */
export function fencedBlocks(text: string): { info: string; body: string }[] {
  return fencedBlockSpans(text).map(({ info, body }) => ({ info, body }));
}

/** {@link fencedBlocks} with each block's line span in the CRLF-normalized
 *  text: `from` is the opening fence's line, `to` the closing fence's (the
 *  last line for an unclosed fence). */
function fencedBlockSpans(text: string): { info: string; body: string; from: number; to: number }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: { info: string; body: string; from: number; to: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const info = open[2]!.trim();
    // A backtick fence's info string holds no backtick (CommonMark): that line is inline code.
    if (fence[0] === "`" && info.includes("`")) continue;
    const closer = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \t]*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !closer.test(lines[j]!); j++) body.push(lines[j]!);
    out.push({ info, body: body.join("\n"), from: i, to: Math.min(j, lines.length - 1) });
    i = j;
  }
  return out;
}

/**
 * The proposed edit in an answer: the last fenced block, whatever its info
 * string, that holds `"edits"` and that `parseEditList` reads as an edit list
 * with at least one item. Null when the answer proposes none. Read here so the
 * stored turn carries it; P4 applies it.
 */
export function extractProposedEdit(answer: string): ProposedEdit | null {
  return proposedEditBlock(answer)?.edit ?? null;
}

function proposedEditBlock(answer: string): { edit: ProposedEdit; from: number; to: number } | null {
  for (const { body, from, to } of fencedBlockSpans(answer).reverse()) {
    if (!/"edits"\s*:/.test(body)) continue;
    const parsed = parseEditList(body);
    if (parsed && parsed.edits.length + parsed.dropped.length > 0) return { edit: { ...parsed, overLimit: parsed.edits.length > 1 }, from, to };
  }
  return null;
}

/** The one line a thread's stored assistant message carries in place of the
 *  proposed edit's JSON block: the edit itself is the ledger row's. */
export const STORED_EDIT_MARKER = "_(Proposed edit: preview and apply it in the page's Discuss tab.)_";

/** The answer as a thread's message stores it: the block
 *  {@link extractProposedEdit} reads, replaced by {@link STORED_EDIT_MARKER};
 *  an answer with no edit unchanged. */
export function stripProposedEdit(answer: string): string {
  const block = proposedEditBlock(answer);
  if (!block) return answer;
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  return [...lines.slice(0, block.from), STORED_EDIT_MARKER, ...lines.slice(block.to + 1)].join("\n");
}
