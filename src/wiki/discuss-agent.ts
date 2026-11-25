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
import { findRepo, type GitRun, originBasename } from "./decision-triage/git.ts";
import type { ContextPack } from "./discuss-pack.ts";
import { clampLine, passageWhere } from "./discuss-prompt.ts";
import { parseEditList, type EditListResult } from "./integrate-edits.ts";
import type { RepoRoots } from "./decision-triage/git.ts";
import { sameWikiRoot } from "./readonly.ts";
import { truncateUnits } from "./ask-chat.ts";
import { STORED_EDIT_MARKER } from "./discuss-bounds.ts";
import { fencedBlockSpans, proposedEditSpan, replaceProposedEdit } from "./discuss-edit-block.ts";

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

/** The line that opens a rules file's Edit-only part (D8). */
export const DISCUSS_EDIT_START_MARKER = "<!-- discuss:edit -->";
/** The line that closes a rules file's Edit-only part (D8). */
export const DISCUSS_EDIT_END_MARKER = "<!-- /discuss:edit -->";

/**
 * The rules a turn gets for its mode, by a plain line scan (D8). A marker line
 * is one whose text, trimmed of leading and trailing whitespace, is exactly
 * {@link DISCUSS_EDIT_START_MARKER} or {@link DISCUSS_EDIT_END_MARKER}. There is
 * no markdown reading: a marker line inside a code fence counts like any other.
 * A line carrying a list or quote prefix (`- `, `> `) is not a marker line.
 *
 * - No marker line: the text unchanged in both modes.
 * - Well-formed (marker lines alternate start, end, …, ending on an end):
 *   Explore drops every line from each start through its end; Edit drops only
 *   the marker lines. The result is the CR/CRLF-normalised text; lines are
 *   removed whole, nothing else is trimmed or collapsed.
 * - Anything else: the text unchanged in both modes, marker lines included,
 *   and `warn` called once with the first faulty marker's line.
 */
export function rulesForMode(rules: string, mode: DiscussMode, warn?: (msg: string) => void): string {
  const lines = rules.replace(/\r\n?/g, "\n").split("\n");
  const kinds = lines.map((l) => {
    const t = l.trim();
    return t === DISCUSS_EDIT_START_MARKER ? "start" : t === DISCUSS_EDIT_END_MARKER ? "end" : null;
  });
  let open = -1;
  let fault: string | null = null;
  let markers = 0;
  for (let i = 0; i < kinds.length && fault === null; i++) {
    const k = kinds[i];
    if (k === null) continue;
    markers++;
    if (k === "start" && open >= 0) fault = `a second ${DISCUSS_EDIT_START_MARKER} at line ${i + 1} before the one at line ${open + 1} is closed`;
    else if (k === "end" && open < 0) fault = `${DISCUSS_EDIT_END_MARKER} at line ${i + 1} has no ${DISCUSS_EDIT_START_MARKER} before it`;
    else open = k === "start" ? i : -1;
  }
  if (fault === null && open >= 0) fault = `${DISCUSS_EDIT_START_MARKER} at line ${open + 1} has no ${DISCUSS_EDIT_END_MARKER} after it`;
  if (markers === 0) return rules;
  if (fault !== null) {
    warn?.(`the rules file's Edit-only markers do not pair up (${fault}): sent whole in both modes`);
    return rules;
  }
  const out: string[] = [];
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i];
    if (k !== null) inside = k === "start";
    else if (mode === "edit" || !inside) out.push(lines[i]!);
  }
  return out.join("\n");
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

/** The bodies of an answer's fenced code blocks, in order (the fence rule is
 *  `fencedBlockSpans`, `discuss-edit-block.ts`). */
export function fencedBlocks(text: string): { info: string; body: string }[] {
  return fencedBlockSpans(text).map(({ info, body }) => ({ info, body }));
}

/**
 * The proposed edit in an answer: the last fenced block, whatever its info
 * string, that holds `"edits"` and that `parseEditList` reads as an edit list
 * with at least one item (`proposedEditSpan`, which the reader bundle shares).
 * Null when the answer proposes none. Read here so the stored turn carries it;
 * P4 applies it.
 */
export function extractProposedEdit(answer: string): ProposedEdit | null {
  const span = proposedEditSpan(answer);
  const parsed = span ? parseEditList(span.body) : null;
  return parsed ? { ...parsed, overLimit: parsed.edits.length > 1 } : null;
}

/** Defined in `discuss-bounds.ts` (dependency-free: the reader bundle matches it). */
export { STORED_EDIT_MARKER };

/** The answer as a thread's message stores it: the block
 *  {@link extractProposedEdit} reads, replaced by {@link STORED_EDIT_MARKER};
 *  an answer with no edit unchanged. */
export function stripProposedEdit(answer: string): string {
  return replaceProposedEdit(answer, STORED_EDIT_MARKER);
}
