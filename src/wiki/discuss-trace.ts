/**
 * A trace turn's prompt (Discuss v2 PR 6, D4): Discuss's agent on one key
 * rather than one page. The context pack is rebuilt every turn from the
 * mentions payload (`mentions.ts`), the way a page turn rebuilds its page
 * pack: the files and lines that name the key, the commits that changed it,
 * its `log.md` lines and the PRs those lines name, with what the GitHub
 * caches know of them. Never stored. Each section is cut at
 * {@link PACK_SECTION_MAX}, each line at {@link TRACE_LINE_MAX}.
 */

import { discussionSoFar, readSection, type AgentReach, type EarlierTurn } from "./discuss-agent.ts";
import { PACK_SECTION_MAX } from "./discuss-pack.ts";
import { clampLine } from "./discuss-prompt.ts";
import { MENTIONS_MAX_COMMITS, type MentionsBody } from "./mentions.ts";

export const TRACE_LINE_MAX = 300;

/** The leading lines that fit a section: until the next would pass the bound. */
function fitting(lines: string[]): string[] {
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (size > PACK_SECTION_MAX) return lines.slice(0, i);
  }
  return lines;
}

/** Lines into a section until the next would pass the bound, then a note of how many `noun` were left out. */
function bounded(lines: string[], noun: string, atLeast = false): string[] {
  const out = fitting(lines);
  return out.length < lines.length ? [...out, `- … ${atLeast ? "at least " : ""}${lines.length - out.length} more ${noun} cut`] : out;
}

/** The root log.md: its lines have a section of their own ({@link MentionsBody.log}). */
const ROOT_LOG = "log.md";

/**
 * «Where it is mentioned»: each file but the root log.md, its header and its
 * lines, until the next line would pass the bound. A header goes in only with
 * at least one of its lines. Returns the lines and how many mention lines they show.
 */
function mentionLines(files: MentionsBody["files"]): { lines: string[]; shown: number } {
  const lines: string[] = [];
  let size = 0;
  let shown = 0;
  for (const f of files) {
    if (f.relPath === ROOT_LOG) continue;
    let header: string | null = `- ${f.relPath}${f.title ? ` «${clampLine(f.title, 160)}»` : ""}`;
    for (const l of f.lines) {
      const line = `  ${l.n}: ${clampLine(l.text, TRACE_LINE_MAX)}`;
      const add = (header !== null ? header.length + 1 : 0) + line.length + 1;
      if (size + add > PACK_SECTION_MAX) return { lines, shown };
      if (header !== null) lines.push(header);
      header = null;
      lines.push(line);
      size += add;
      shown++;
    }
  }
  return { lines, shown };
}
const prState = (p: MentionsBody["prs"][number]): string => {
  if (p.state === "merged") return `merged${p.mergedAt ? ` ${p.mergedAt.slice(0, 10)}` : ""}`;
  if (p.state === "not-checked") return `not checked${p.reason ? ` (${p.reason})` : ""}`;
  if (p.state === "unknown") return "state not known yet";
  if (p.state === "not-a-pr") return "not a PR (GitHub has no such pull request)";
  return p.state;
};

/**
 * The context pack of a trace turn, from the mentions payload. Each mention
 * line is reported once: listed under «Where it is mentioned» or «Its log.md
 * lines», or counted in one cut note. The log section's note counts the root
 * log.md lines its search saw (`logTotalLines`) less those it lists; the
 * where note, the payload's total (log.md included) less every log.md line
 * and the lines it lists. «At least» when the totals are lower bounds. Fix
 * round 2 batch 3: the where note counted the log section's cut lines again.
 */
export function traceContextPack(wiki: string, b: MentionsBody): string[] {
  const at = b.totalsAtLeast ? "at least " : "";
  const out = [
    "## The key",
    `Wiki: ${wiki}`,
    `Key: ${b.key}${b.kind ? ` (kind: ${b.kind})` : ""}`,
    `Mentioned on ${at}${b.totalLines} line${b.totalLines === 1 ? "" : "s"} in ${at}${b.totalFiles} file${b.totalFiles === 1 ? "" : "s"} git tracks${b.truncated ? "; not all of them are listed below" : ""}.`,
    "",
    "## Where it is mentioned",
  ];
  const where = mentionLines(b.files);
  const logLines = fitting(b.log.map((l) => `- log.md:${l.n} [${l.date ?? "no date"}${l.kind ? ` ${l.kind}` : ""}] ${clampLine(l.line, TRACE_LINE_MAX)}`));
  const logTotal = Math.max(b.logTotalLines, b.log.length);
  const logCut = logTotal - logLines.length;
  const omitted = Math.max(0, b.totalLines - logTotal - where.shown);
  if (where.lines.length === 0) out.push(b.files.length === 0 ? "(no tracked file names it)" : `(no tracked file but ${ROOT_LOG} names it)`);
  else out.push(...where.lines);
  if (omitted > 0) out.push(`- … ${at}${omitted} more mention line${omitted === 1 ? "" : "s"} not listed in this pack`);
  out.push("", "## Commits that changed how often it occurs (newest first)");
  if (b.commits.length === 0) out.push("(none)");
  else out.push(...bounded(b.commits.map((c) => `- ${c.date.slice(0, 10)} ${c.sha.slice(0, 10)} ${clampLine(c.subject, 200)}${c.files.length ? ` (${c.files.slice(0, 6).join(", ")}${c.files.length > 6 ? ", …" : ""})` : ""}`), "commits", b.commits.length >= MENTIONS_MAX_COMMITS));
  out.push("", "## Its log.md lines");
  if (logTotal === 0) out.push("(none)");
  else out.push(...logLines);
  if (logCut > 0) out.push(`- … ${at}${logCut} more log.md line${logCut === 1 ? "" : "s"} cut`);
  out.push("", "## PRs those lines name");
  if (b.prs.length === 0) out.push("(none)");
  else out.push(...bounded(b.prs.map((p) => `- ${p.repo}#${p.number}: ${prState(p)} (${p.url})`), "PRs"));
  return out;
}

/** A trace turn's prompt: the trace pack, then what the agent can read, the discussion so far and the question, last. */
export function renderTraceTurnPrompt(opts: { wiki: string; mentions: MentionsBody; reach: AgentReach; earlier: readonly EarlierTurn[]; question: string }): string {
  const cite = opts.mentions.files[0]?.relPath ?? "index.md";
  return [
    ...traceContextPack(opts.wiki, opts.mentions),
    "",
    ...readSection(opts.reach, { wiki: opts.wiki, relPath: cite }, "trace"),
    "",
    ...discussionSoFar(opts.earlier),
    "## Question",
    opts.question.trim(),
  ].join("\n");
}
