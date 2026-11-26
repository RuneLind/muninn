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
import type { MentionsBody } from "./mentions.ts";

export const TRACE_LINE_MAX = 300;

/** Lines into a section until the next would pass the bound, then a note of how many were left out. */
function bounded(lines: string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (size > PACK_SECTION_MAX) {
      out.push(`- … ${lines.length - i} more lines cut`);
      break;
    }
    out.push(lines[i]!);
  }
  return out;
}

const prState = (p: MentionsBody["prs"][number]): string => {
  if (p.state === "merged") return `merged${p.mergedAt ? ` ${p.mergedAt.slice(0, 10)}` : ""}`;
  if (p.state === "not-checked") return `not checked${p.reason ? ` (${p.reason})` : ""}`;
  if (p.state === "unknown") return "state not known yet";
  if (p.state === "not-a-pr") return "not a PR (GitHub has no such pull request)";
  return p.state;
};

/** The context pack of a trace turn, from the mentions payload. */
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
  if (b.files.length === 0) out.push("(no tracked file names it)");
  else out.push(...bounded(b.files.flatMap((f) => [`- ${f.relPath}${f.title ? ` «${clampLine(f.title, 160)}»` : ""}`, ...f.lines.map((l) => `  ${l.n}: ${clampLine(l.text, TRACE_LINE_MAX)}`)])));
  out.push("", "## Commits that changed how often it occurs (newest first)");
  if (b.commits.length === 0) out.push("(none)");
  else out.push(...bounded(b.commits.map((c) => `- ${c.date.slice(0, 10)} ${c.sha.slice(0, 10)} ${clampLine(c.subject, 200)}${c.files.length ? ` (${c.files.slice(0, 6).join(", ")}${c.files.length > 6 ? ", …" : ""})` : ""}`)));
  out.push("", "## Its log.md lines");
  if (b.log.length === 0) out.push("(none)");
  else out.push(...bounded(b.log.map((l) => `- log.md:${l.n} [${l.date ?? "no date"}${l.kind ? ` ${l.kind}` : ""}] ${clampLine(l.line, TRACE_LINE_MAX)}`)));
  out.push("", "## PRs those lines name");
  if (b.prs.length === 0) out.push("(none)");
  else out.push(...bounded(b.prs.map((p) => `- ${p.repo}#${p.number}: ${prState(p)} (${p.url})`)));
  return out;
}

/** A trace turn's prompt: what the agent can read, the trace pack, the discussion so far and the question, last. */
export function renderTraceTurnPrompt(opts: { wiki: string; mentions: MentionsBody; reach: AgentReach; earlier: readonly EarlierTurn[]; question: string }): string {
  const cite = opts.mentions.files[0]?.relPath ?? "index.md";
  return [
    ...traceContextPack(opts.wiki, opts.mentions),
    "",
    ...readSection(opts.reach, { wiki: opts.wiki, relPath: cite }),
    "",
    ...discussionSoFar(opts.earlier),
    "## Question",
    opts.question.trim(),
  ].join("\n");
}
