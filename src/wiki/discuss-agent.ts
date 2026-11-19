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
  | { kind: "mcpTools"; tools: Record<string, string[]> };

export interface EarlierTurn {
  question: string;
  selection: string | null;
  answer: string;
  endState: string;
}

/** The system prompt: a fixed frame and the wiki's own rules. No persona. */
export function renderAgentSystemPrompt(wiki: string, rules: string): string {
  return [
    `You are the wiki agent behind Discuss in muninn's wiki reader. You answer questions about one page of the "${wiki}" wiki, one turn at a time.`,
    "The turn tells you what you can read and holds the context pack: the page's place, the marked passage, its section with line numbers, the heading list and, for a plan page, its card. You cannot write files or run commands.",
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
 * The proposed edit in an answer: the last fenced block (```json or bare) that
 * `parseEditList` reads as an edit list with at least one item. Null when the
 * answer proposes none. Read here so the stored turn carries it; P4 applies it.
 */
export function extractProposedEdit(answer: string): ProposedEdit | null {
  const fences = [...answer.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)].map((m) => m[1]!);
  for (const body of fences.reverse()) {
    if (!/"edits"\s*:/.test(body)) continue;
    const parsed = parseEditList(body);
    if (parsed && parsed.edits.length + parsed.dropped.length > 0) return { ...parsed, overLimit: parsed.edits.length > 1 };
  }
  return null;
}
