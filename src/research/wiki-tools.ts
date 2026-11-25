/**
 * The wiki read tools on the research MCP server: `wiki_grep`, `wiki_read` and
 * `wiki_history` over a bot's wikis (`botWikis`), git-tracked files only.
 *
 * Registered only on an instance with `MUNINN_AUTH=off`: an MCP call does not
 * know who is asking, and an authenticating instance filters pages per reader.
 * A wiki whose root is in `WIKI_READONLY_ROOTS` is checked again on every call,
 * so a root listed after the bot was registered is still never read.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isReadonlyWikiRoot } from "../wiki/readonly.ts";
import {
  GREP_DEFAULT_MAX,
  GREP_MAX_RESULTS,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  READ_MAX_LINES,
  grepTracked,
  historyFor,
  readTracked,
  type TrackedOpts,
} from "../wiki/tracked-files.ts";

export interface BotWiki {
  name: string;
  root: string;
}

/** The three tool names, as the Copilot allow list names them. */
export const WIKI_TOOL_NAMES = ["wiki_grep", "wiki_read", "wiki_history"] as const;

export interface WikiToolDeps extends TrackedOpts {
  isReadonlyRoot?: (root: string) => boolean;
}

type ToolText = { content: { type: "text"; text: string }[]; isError?: true };

const text = (t: string): ToolText => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolText => ({ content: [{ type: "text", text: t }], isError: true });

/** The bot's wikis this call may read: read-only roots dropped at call time. */
export function liveWikis(wikis: readonly BotWiki[] | undefined, deps: WikiToolDeps = {}): BotWiki[] {
  const ro = deps.isReadonlyRoot ?? isReadonlyWikiRoot;
  return (wikis ?? []).filter((w) => !ro(w.root));
}

/** The wiki a call names (case-insensitive), or the only one when it names none. */
export function resolveToolWiki(wikis: readonly BotWiki[], name: string | undefined): BotWiki | string {
  const allowed = wikis.map((w) => w.name);
  const list = allowed.length > 0 ? allowed.map((n) => `"${n}"`).join(", ") : "(none)";
  const wanted = name?.trim();
  if (!wanted) {
    if (wikis.length === 1) return wikis[0]!;
    return `name the wiki: \`wiki\` is required when this bot has more than one wiki. Allowed: ${list}.`;
  }
  const hit = wikis.find((w) => w.name.toLowerCase() === wanted.toLowerCase());
  return hit ?? `unknown wiki "${wanted}". Allowed: ${list}.`;
}

export async function wikiGrepTool(
  wikis: readonly BotWiki[],
  args: { wiki?: string; pattern: string; regex?: boolean; glob?: string; maxResults?: number },
  deps: WikiToolDeps = {},
): Promise<ToolText> {
  const w = resolveToolWiki(liveWikis(wikis, deps), args.wiki);
  if (typeof w === "string") return fail(w);
  const res = await grepTracked(w.root, args.pattern, { git: deps.git, regex: args.regex, glob: args.glob, max: args.maxResults });
  if (!res.ok) return fail(`wiki_grep on "${w.name}": ${res.error}`);
  const scope = args.glob ? ` (files matching ${args.glob})` : "";
  const ere =
    res.regexEngine === "ere"
      ? "\n(This git has no PCRE: the pattern ran as POSIX ERE, where backslash classes such as \\d are not portable. Use [0-9], [[:space:]] and [[:alnum:]_] instead.)"
      : "";
  if (res.hits.length === 0) return text(`No tracked file in "${w.name}"${scope} has a line matching ${JSON.stringify(args.pattern)}.${ere}`);
  const atLeast = res.atLeast ? "at least " : "";
  const lines = [`${atLeast}${res.totalLines} matching line(s) in ${atLeast}${res.totalFiles} file(s) of "${w.name}"${scope}:${ere}`];
  for (const h of res.hits) lines.push(`${h.relPath}:${h.line}: ${h.text}`);
  const pastLines = res.totalLines - res.hits.length;
  if (pastLines > 0) {
    const shown = new Set(res.hits.map((h) => h.relPath));
    const pastFiles = res.totalFiles - shown.size;
    lines.push(
      `… ${atLeast}${pastLines} more line(s) past the cap of ${res.hits.length}, and ${atLeast}${pastFiles} more file(s) with no line shown. Narrow with glob or a longer pattern, or raise maxResults.`,
    );
  }
  return text(lines.join("\n"));
}

export async function wikiReadTool(
  wikis: readonly BotWiki[],
  args: { wiki?: string; path: string; offset?: number; limit?: number },
  deps: WikiToolDeps = {},
): Promise<ToolText> {
  const w = resolveToolWiki(liveWikis(wikis, deps), args.wiki);
  if (typeof w === "string") return fail(w);
  const res = await readTracked(w.root, args.path, { git: deps.git, offset: args.offset, limit: args.limit });
  if (!res.ok) return fail(`wiki_read on "${w.name}": ${res.error}`);
  if (res.totalLines === 0) return text(`${res.relPath} (wiki "${w.name}") is empty: it has no lines.`);
  if (res.toLine < res.fromLine) return text(`${res.relPath} has ${res.totalLines} line(s); offset ${res.fromLine} is past its end.`);
  const head = `${res.relPath} (wiki "${w.name}"), lines ${res.fromLine}–${res.toLine} of ${res.totalLines}:`;
  const tail = res.more ? `\n… more: call wiki_read again with offset=${res.toLine + 1}.` : "";
  return text(`${head}\n${res.text}${tail}`);
}

export async function wikiHistoryTool(
  wikis: readonly BotWiki[],
  args: { wiki?: string; term: string; path?: string; limit?: number },
  deps: WikiToolDeps = {},
): Promise<ToolText> {
  const w = resolveToolWiki(liveWikis(wikis, deps), args.wiki);
  if (typeof w === "string") return fail(w);
  const res = await historyFor(w.root, args.term, { git: deps.git, path: args.path, limit: args.limit });
  if (!res.ok) return fail(`wiki_history on "${w.name}": ${res.error}`);
  const cut = res.partial ? "\n… output cut at its size bound: older commits may follow. Narrow with path or a longer term, or lower limit." : "";
  if (res.commits.length === 0) {
    if (res.partial) return fail(`wiki_history on "${w.name}": no whole commit fit in the output.${cut}`);
    return text(`No commit in "${w.name}" added or removed ${JSON.stringify(args.term)}.`);
  }
  const atLeast = res.partial ? "at least " : "";
  const lines = [`${atLeast}${res.commits.length} commit(s) in "${w.name}" that added or removed ${JSON.stringify(args.term)}, newest first:`];
  for (const c of res.commits) {
    lines.push(`${c.hash.slice(0, 10)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`);
    const more = c.fileCount > c.files.length ? `, … and ${c.fileCount - c.files.length} more` : "";
    if (c.files.length > 0) lines.push(`  files: ${c.files.join(", ")}${more}`);
  }
  return text(lines.join("\n") + cut);
}

const WIKI_ARG = (wikis: readonly BotWiki[]) =>
  z
    .string()
    .optional()
    .describe(`The wiki: one of ${wikis.map((w) => `"${w.name}"`).join(", ")}. May be left out only when this bot has exactly one wiki.`);

/** Register the three tools on `server` for `wikis` (the bot's list at session start). */
export function registerWikiTools(server: McpServer, wikis: readonly BotWiki[], deps: WikiToolDeps = {}): void {
  server.tool(
    "wiki_grep",
    "Search the wiki's git-tracked files for a pattern, line by line. Use wiki_grep for an exact key, id or \"where else\" question (a Jira key, a MEL- id, a file name, a term): it finds every file that holds it, which semantic search does not. " +
      "Returns `relPath:line: text`; paths it returns are valid wiki_read paths. The pattern is a fixed string unless regex is true.",
    {
      wiki: WIKI_ARG(wikis),
      pattern: z.string().min(1).describe("The text to find. A fixed string, unless regex is true."),
      regex: z.boolean().optional().describe("Read the pattern as a Perl-compatible regular expression (PCRE: \\b, \\d, \\w, \\s work), matched by character, so æøå are one character each."),
      glob: z
        .string()
        .optional()
        .describe(
          "Search only files this glob selects, matched case-sensitively from the wiki root: `plans/**` or `plans` for the top-level folder plans (a nested folder needs its path, `a/plans`, or `**/name/**`), `plans/x.md` for one file, `*.csv` by name at any depth (a glob with a wildcard and no `/` also matches the file name). A leading `!` (negation) is not supported. A glob that selects no file is an error.",
        ),
      maxResults: z.number().int().positive().max(GREP_MAX_RESULTS).optional().describe(`Lines returned (default ${GREP_DEFAULT_MAX}); the rest are counted.`),
    },
    (args) => wikiGrepTool(wikis, args, deps),
  );
  server.tool(
    "wiki_read",
    `Read one git-tracked file of the wiki, numbered by line. Use it on a path wiki_grep or wiki_history returned. At most ${READ_MAX_LINES} lines and 256 KB per call; use offset to read on.`,
    {
      wiki: WIKI_ARG(wikis),
      path: z.string().min(1).describe("The file's path relative to the wiki root, as wiki_grep returns it."),
      offset: z.number().int().positive().optional().describe("First line to return (1-based, default 1)."),
      limit: z.number().int().positive().max(READ_MAX_LINES).optional().describe(`Lines to return (default and max ${READ_MAX_LINES}).`),
    },
    (args) => wikiReadTool(wikis, args, deps),
  );
  server.tool(
    "wiki_history",
    "List the wiki's commits that added or removed a term (git log -S), newest first, with the files each touched. Use it to find when a key or fact entered or left the wiki; paths it returns are valid wiki_read paths while the file is still tracked.",
    {
      wiki: WIKI_ARG(wikis),
      term: z.string().min(1).describe("The exact text whose occurrences a commit changed."),
      path: z.string().optional().describe("Limit to this file or folder path, relative to the wiki root. Not a glob: *, ? and [ are refused."),
      limit: z.number().int().positive().max(HISTORY_MAX_LIMIT).optional().describe(`Commits returned (default ${HISTORY_DEFAULT_LIMIT}).`),
    },
    (args) => wikiHistoryTool(wikis, args, deps),
  );
}
