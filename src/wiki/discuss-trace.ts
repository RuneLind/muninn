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
import { MENTIONS_MAX_COMMITS, MENTIONS_MAX_LOG, type MentionsBody } from "./mentions.ts";

export const TRACE_LINE_MAX = 300;

/** Lines into a section until the next would pass the bound, then a note of how many `noun` were left out. */
function bounded(lines: string[], noun: string, atLeast = false): string[] {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (size > PACK_SECTION_MAX) {
      out.push(`- … ${atLeast ? "at least " : ""}${lines.length - i} more ${noun} cut`);
      break;
    }
    out.push(lines[i]!);
  }
  return out;
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
 * The context pack of a trace turn, from the mentions payload. Each log.md
 * line is listed once, under «Its log.md lines». The note under «Where it is
 * mentioned» counts the mention lines the pack leaves out: the payload's total
 * (log.md included) less the lines both sections show, «at least» when the
 * totals are lower bounds. The log section's lines are root log.md hits of the
 * same search, so they are in that total.
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
  const logLines = bounded(
    b.log.map((l) => `- log.md:${l.n} [${l.date ?? "no date"}${l.kind ? ` ${l.kind}` : ""}] ${clampLine(l.line, TRACE_LINE_MAX)}`),
    "log.md lines",
    b.log.length >= MENTIONS_MAX_LOG,
  );
  const logShown = Math.min(b.log.length, logLines.filter((l) => !l.startsWith("- … ")).length);
  const omitted = Math.max(0, b.totalLines - where.shown - logShown);
  if (where.lines.length === 0) out.push(b.files.length === 0 ? "(no tracked file names it)" : `(no tracked file but ${ROOT_LOG} names it)`);
  else out.push(...where.lines);
  if (omitted > 0) out.push(`- … ${at}${omitted} more mention line${omitted === 1 ? "" : "s"} not listed in this pack`);
  out.push("", "## Commits that changed how often it occurs (newest first)");
  if (b.commits.length === 0) out.push("(none)");
  else out.push(...bounded(b.commits.map((c) => `- ${c.date.slice(0, 10)} ${c.sha.slice(0, 10)} ${clampLine(c.subject, 200)}${c.files.length ? ` (${c.files.slice(0, 6).join(", ")}${c.files.length > 6 ? ", …" : ""})` : ""}`), "commits", b.commits.length >= MENTIONS_MAX_COMMITS));
  out.push("", "## Its log.md lines");
  if (b.log.length === 0) out.push("(none)");
  else out.push(...logLines);
  out.push("", "## PRs those lines name");
  if (b.prs.length === 0) out.push("(none)");
  else out.push(...bounded(b.prs.map((p) => `- ${p.repo}#${p.number}: ${prState(p)} (${p.url})`), "PRs"));
  return out;
}

/** A trace turn's prompt: what the agent can read, the trace pack, the discussion so far and the question, last. */
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
