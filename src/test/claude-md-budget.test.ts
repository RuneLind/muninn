import { test, expect, describe } from "bun:test";
import { statSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * Caps every tracked CLAUDE.md that Claude Code reads as memory.
 *
 * A nested CLAUDE.md is loaded in full whenever a session reads a file in its
 * folder, so its size is a per-read cost. Detail about one function belongs in
 * `src/<module>/reference/notes.md`, reached through the `## Index` in CLAUDE.md.
 * There is deliberately no "entry too high" rule: it would go red on ordinary shrinks.
 */

const ROOT = join(import.meta.dir, "..", "..");
const BUDGETS_FILE = join(import.meta.dir, "claude-md-budgets.json");

const DEFAULT_CEILING = 40_000;
const TIGHT_CEILING = 20_000;
const TIGHT_FOLDERS = ["src/wiki", "src/dashboard", "src/web"];

interface Budgets {
  entries: Record<string, number>;
  pending: string[];
}

interface Tree {
  /** Tracked CLAUDE.md and reference/*.md files, by repo-relative path. */
  files: ReadonlyMap<string, string>;
  isFile: (path: string) => boolean;
  budgets: Budgets;
}

/** Bot personas and docs/examples are prompts, not Claude Code memory. */
function isMemoryFile(path: string): boolean {
  return (
    posix.basename(path) === "CLAUDE.md" &&
    !/^bots\/[^/]+\/CLAUDE\.md$/.test(path) &&
    !path.startsWith("docs/examples/")
  );
}

function ceilingOf(path: string, budgets: Budgets): number {
  const entry = budgets.entries[path];
  if (entry !== undefined) return entry;
  return TIGHT_FOLDERS.some((folder) => path.startsWith(`${folder}/`)) ? TIGHT_CEILING : DEFAULT_CEILING;
}

function sizeAdvice(path: string, tree: Tree): string {
  const folder = posix.dirname(path);
  const isModule = /^src\/[^/]+$/.test(folder);
  if (isModule && tree.files.has(`${folder}/reference/notes.md`)) {
    return "move design notes into `notes.md` and add their heading to `## Index`";
  }
  if (tree.budgets.pending.includes(folder)) {
    return "trim, or raise this file's entry in `claude-md-budgets.json` in this PR; its file PR is pending";
  }
  if (isModule) {
    return `trim, or move the text into \`${folder}/reference/notes.md\` and add \`## Index\` to \`${path}\``;
  }
  return "trim, or move the text into the module it describes";
}

/** The file's lines with each fenced block blanked, so paragraph breaks survive. An unclosed fence runs to the end. */
function linesOutsideFences(text: string): string[] {
  let fence: string | null = null;
  return text.split("\n").map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence !== null) {
      const closes =
        marker?.[1] !== undefined &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === "";
      if (closes) fence = null;
      return "";
    }
    // A backtick fence's info string holds no backtick: ```a``` on one line is a code span.
    if (marker?.[1] !== undefined && !(marker[1][0] === "`" && marker[2]?.includes("`"))) {
      fence = marker[1];
      return "";
    }
    return line;
  });
}

/** A run of N backticks closes only on a run of exactly N. */
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const AT_PATH = /(?:^|[\s(\[])@([^\s`]+)/gm;

/** `@path` tokens outside fences and code spans, without their #fragment or trailing punctuation. */
function atPathsIn(text: string): string[] {
  const prose = linesOutsideFences(text)
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(CODE_SPAN, " "))
    .join("\n\n");
  return [...prose.matchAll(AT_PATH)]
    .map((match) => (match[1] ?? "").replace(/#.*$/, "").replace(/[.,;:!?)\]'"*_]+$/, ""))
    .filter(Boolean);
}

function isImport(raw: string, folder: string, tree: Tree): boolean {
  // These resolve on a developer machine and not on CI, so existence here proves nothing.
  if (raw.startsWith("~/") || raw.startsWith("/")) return true;
  return tree.isFile(posix.normalize(posix.join(folder, raw)));
}

function headingsIn(text: string): string[] {
  return linesOutsideFences(text).flatMap((line) => {
    const heading = line.match(/^ {0,3}#{2,3}[ \t]+(.+?)\s*$/);
    return heading?.[1] !== undefined ? [heading[1]] : [];
  });
}

/** The list items under `## Index`, up to the next heading of any level, without a trailing ` [trap]`. */
function indexLinesIn(text: string): string[] {
  const lines = linesOutsideFences(text);
  const start = lines.findIndex((line) => /^##[ \t]+Index\s*$/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,3}#{1,6}[ \t]/.test(line)) break;
    const item = line.match(/^\s*[-*+][ \t]+(.+?)\s*$/);
    if (item?.[1] !== undefined) out.push(item[1].replace(/ \[trap\]$/, ""));
  }
  return out;
}

function checkIndex(notesPath: string, folder: string, tree: Tree): string[] {
  const claudePath = `${folder}/CLAUDE.md`;
  const claude = tree.files.get(claudePath);
  if (claude === undefined) {
    return [
      `${notesPath}: no \`${claudePath}\`. Write one with the folder's rules and a \`## Index\` of these headings, and \`git add\` it: this guard reads \`git ls-files\`.`,
    ];
  }
  const headings = new Set<string>();
  for (const [path, text] of tree.files) {
    if (posix.dirname(path) === `${folder}/reference` && path.endsWith(".md")) {
      for (const heading of headingsIn(text)) headings.add(heading);
    }
  }
  const index = new Set(indexLinesIn(claude));
  return [
    ...[...headings]
      .filter((heading) => !index.has(heading))
      .map((heading) => `${claudePath}: heading "${heading}" in \`reference/\` is missing from \`## Index\`. Add \`- ${heading}\`.`),
    ...[...index]
      .filter((line) => !headings.has(line))
      .map((line) => `${claudePath}: \`## Index\` line "${line}" names no heading in \`reference/\`. Correct or remove it.`),
  ];
}

/** One message per violation, each naming the file and what to do. */
function checkClaudeMdBudgets(tree: Tree): string[] {
  const out: string[] = [];
  for (const [path, text] of tree.files) {
    if (!isMemoryFile(path)) continue;
    const ceiling = ceilingOf(path, tree.budgets);
    if (text.length > ceiling) {
      out.push(`${path}: ${text.length} chars, over its ${ceiling} ceiling: ${sizeAdvice(path, tree)}.`);
    }
    for (const raw of atPathsIn(text)) {
      if (isImport(raw, posix.dirname(path), tree)) {
        out.push(`${path}: \`@${raw}\` is a Claude Code import, loaded with this file. Write the path in backticks.`);
      }
    }
  }
  for (const path of tree.files.keys()) {
    const module = path.match(/^(src\/[^/]+)\/reference\/notes\.md$/);
    if (module?.[1] !== undefined) out.push(...checkIndex(path, module[1], tree));
  }
  for (const path of Object.keys(tree.budgets.entries)) {
    const notes = `${posix.dirname(path)}/reference/notes.md`;
    if (tree.files.has(notes)) {
      out.push(`${path}: has an entry in \`claude-md-budgets.json\` and \`${notes}\` exists. The file PR deletes its entry.`);
    }
  }
  return out;
}

async function readRealTree(): Promise<Tree> {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const files = new Map<string, string>();
  for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
    const inReference = posix.basename(posix.dirname(path)) === "reference" && path.endsWith(".md");
    if (!isMemoryFile(path) && !inReference) continue;
    const file = Bun.file(join(ROOT, path));
    if (await file.exists()) files.set(path, await file.text()); // absent: deleted in the working tree
  }
  const isFile = (path: string) => {
    try {
      return statSync(join(ROOT, path)).isFile();
    } catch {
      return false;
    }
  };
  return { files, isFile, budgets: (await Bun.file(BUDGETS_FILE).json()) as Budgets };
}

test("the real tree is within its budgets", async () => {
  const tree = await readRealTree();
  expect([...tree.files.keys()].filter(isMemoryFile).length).toBeGreaterThan(10);
  expect(checkClaudeMdBudgets(tree)).toEqual([]);
});

const fill = (chars: number) => "x".repeat(chars);

function check(
  files: Record<string, string>,
  opts: { entries?: Record<string, number>; pending?: string[]; existing?: string[] } = {},
): string[] {
  const map = new Map(Object.entries(files));
  const existing = new Set([...map.keys(), ...(opts.existing ?? [])]);
  return checkClaudeMdBudgets({
    files: map,
    isFile: (path) => existing.has(path),
    budgets: { entries: opts.entries ?? {}, pending: opts.pending ?? [] },
  });
}

/** A module with `reference/notes.md`, its `CLAUDE.md` holding `index` under `## Index`. */
function indexed(notes: string, index: string, rules = "Folder rules.\n"): Record<string, string> {
  return {
    "src/foo/CLAUDE.md": `# Foo\n\n${rules}\n## Index\n\n${index}`,
    "src/foo/reference/notes.md": notes,
  };
}

const NOTES_ADVICE = "move design notes into `notes.md` and add their heading to `## Index`";

describe("size", () => {
  test("fails one char over the default ceiling", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(40_001) })[0]).toContain("40001 chars");
    expect(check({ "src/ai/CLAUDE.md": fill(40_001) })).toHaveLength(1);
  });

  test("a file exactly at its ceiling passes", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(40_000) })).toEqual([]);
    expect(check({ "src/wiki/CLAUDE.md": fill(20_000) })).toEqual([]);
    expect(check({ "src/ai/CLAUDE.md": fill(50_000) }, { entries: { "src/ai/CLAUDE.md": 50_000 } })).toEqual([]);
  });

  test("fails one char over an entry", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(50_001) }, { entries: { "src/ai/CLAUDE.md": 50_000 } })).toHaveLength(1);
  });

  test("an entry below the default is the ceiling", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(1_001) }, { entries: { "src/ai/CLAUDE.md": 1_000 } })).toHaveLength(1);
  });

  test("the three tight folders default to 20k", () => {
    for (const folder of ["src/wiki", "src/dashboard", "src/web"]) {
      expect(check({ [`${folder}/CLAUDE.md`]: fill(20_001) })).toHaveLength(1);
    }
  });

  test("a file 30k under its default passes", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(10_000) })).toEqual([]);
  });

  test("a file with an entry above the default passes", () => {
    expect(check({ "src/wiki/CLAUDE.md": fill(590_000) }, { entries: { "src/wiki/CLAUDE.md": 593_000 } })).toEqual([]);
  });

  test("counts UTF-16 length, so an emoji with its variation selector counts 2", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(39_999) + "⚠️" })).toHaveLength(1);
    expect(check({ "src/ai/CLAUDE.md": fill(39_998) + "⚠️" })).toEqual([]);
  });

  test("the root, bots/CLAUDE.md, e2e and extensions are in scope at 40k", () => {
    for (const path of ["CLAUDE.md", "bots/CLAUDE.md", "e2e/CLAUDE.md", "extensions/CLAUDE.md"]) {
      expect(check({ [path]: fill(40_001) })).toHaveLength(1);
      expect(check({ [path]: fill(40_000) })).toEqual([]);
    }
  });

  test("bot personas and docs/examples are out of scope", () => {
    expect(check({ "bots/jarvis/CLAUDE.md": fill(90_000) })).toEqual([]);
    expect(check({ "docs/examples/jira-assistant/CLAUDE.md": fill(90_000) })).toEqual([]);
  });

  test("a file that is not named CLAUDE.md is not sized", () => {
    expect(check({ "src/ai/NOTCLAUDE.md": fill(90_000), "src/ai/reference/notes.md": "" })).toEqual([
      expect.stringContaining("no `src/ai/CLAUDE.md`"),
    ]);
  });
});

describe("size message, by folder", () => {
  test("a module with reference/notes.md", () => {
    const [message, ...rest] = check({ ...indexed("", ""), "src/foo/CLAUDE.md": `## Index\n\n${fill(40_001)}` });
    expect(rest.filter((m) => m.includes("chars"))).toEqual([]);
    expect(message).toContain(NOTES_ADVICE);
  });

  test("a notes.md wins over a stale pending listing", () => {
    const out = check({ ...indexed("", ""), "src/foo/CLAUDE.md": `## Index\n\n${fill(40_001)}` }, { pending: ["src/foo"] });
    expect(out[0]).toContain(NOTES_ADVICE);
  });

  test("a folder listed in pending", () => {
    expect(check({ "src/wiki/CLAUDE.md": fill(20_001) }, { pending: ["src/wiki"] })[0]).toContain(
      "trim, or raise this file's entry in `claude-md-budgets.json` in this PR; its file PR is pending",
    );
  });

  test("any other module folder", () => {
    expect(check({ "src/ai/CLAUDE.md": fill(40_001) }, { pending: ["src/wiki"] })[0]).toContain(
      "trim, or move the text into `src/ai/reference/notes.md` and add `## Index` to `src/ai/CLAUDE.md`",
    );
  });

  test("the root and other folders", () => {
    for (const path of ["CLAUDE.md", "e2e/CLAUDE.md"]) {
      expect(check({ [path]: fill(40_001) })[0]).toContain("trim, or move the text into the module it describes");
    }
  });
});

describe("@-import", () => {
  test("fails on an @-import of an existing file, resolved from the CLAUDE.md's own folder", () => {
    const out = check({ "src/ai/CLAUDE.md": "See @notes.md for detail.\n" }, { existing: ["src/ai/notes.md"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Write the path in backticks.");
    expect(out[0]).toContain("@notes.md");
  });

  test("does not resolve from the repo root", () => {
    expect(check({ "src/ai/CLAUDE.md": "See @notes.md.\n" }, { existing: ["notes.md"] })).toEqual([]);
  });

  test("resolves ./ and ../ paths", () => {
    expect(check({ "src/ai/CLAUDE.md": "@./a.md\n" }, { existing: ["src/ai/a.md"] })).toHaveLength(1);
    expect(check({ "src/ai/CLAUDE.md": "@../b.md\n" }, { existing: ["src/b.md"] })).toHaveLength(1);
  });

  test("reads the path without trailing punctuation or a #fragment", () => {
    expect(check({ "CLAUDE.md": "See @a.md, then @b.md#top.\n" }, { existing: ["a.md", "b.md"] })).toHaveLength(2);
  });

  test("fails on an @~/ path that does not exist", () => {
    const out = check({ "CLAUDE.md": "Personal rules: @~/.claude/mine.md\n" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Write the path in backticks.");
  });

  test("fails on an @/ path that does not exist", () => {
    expect(check({ "CLAUDE.md": "@/etc/rules.md\n" })).toHaveLength(1);
  });

  test("@mention passes", () => {
    expect(check({ "CLAUDE.md": "Ask @mention, or use @types/node.\n" })).toEqual([]);
  });

  test("an email address is not an @path", () => {
    expect(check({ "CLAUDE.md": "Mail me@a.md\n" }, { existing: ["a.md"] })).toEqual([]);
  });

  test("an @path naming a folder passes", () => {
    // isFile says no for a directory, on the real tree as in this fixture.
    expect(check({ "CLAUDE.md": "@bots\n" })).toEqual([]);
  });

  test("an @path inside a fence passes", () => {
    const body = "```bash\n@a.md\n@~/x.md\n```\n\n~~~\n@a.md\n~~~\n\n````\n```\n@a.md\n```\n@a.md\n````\n";
    expect(check({ "CLAUDE.md": body }, { existing: ["a.md"] })).toEqual([]);
  });

  test("an @path inside an unclosed fence passes", () => {
    expect(check({ "CLAUDE.md": "```\n@a.md\n" }, { existing: ["a.md"] })).toEqual([]);
  });

  test("an @path after a closed fence still fails", () => {
    expect(check({ "CLAUDE.md": "```\nx\n```\n@a.md\n" }, { existing: ["a.md"] })).toHaveLength(1);
  });

  test("an @path inside a code span passes", () => {
    const body = "Write `@a.md` and ``@~/x.md and ` tick`` and `split\n@a.md` here.\n";
    expect(check({ "CLAUDE.md": body }, { existing: ["a.md"] })).toEqual([]);
  });

  test("an @path after an unmatched backtick still fails", () => {
    expect(check({ "CLAUDE.md": "A ` tick.\n\n@a.md and a ` tick.\n" }, { existing: ["a.md"] })).toHaveLength(1);
  });

  test("notes.md is not memory, so its @paths are not imports", () => {
    expect(check(indexed("@a.md\n", ""), { existing: ["src/foo/reference/a.md"] })).toEqual([]);
  });
});

describe("index", () => {
  test("fails on a notes.md heading missing from ## Index", () => {
    const out = check(indexed("## One\n\n### Two\n", "- One\n"));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Two");
    expect(out[0]).toContain("missing from `## Index`");
  });

  test("fails on an index line whose heading no longer exists", () => {
    const out = check(indexed("## One\n", "- One\n- Gone\n"));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Gone");
    expect(out[0]).toContain("no heading");
  });

  test("fails on a notes.md with no CLAUDE.md", () => {
    const out = check({ "src/foo/reference/notes.md": "## One\n" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("no `src/foo/CLAUDE.md`");
  });

  test("fails when CLAUDE.md has no ## Index at all", () => {
    expect(check({ "src/foo/CLAUDE.md": "- One\n", "src/foo/reference/notes.md": "## One\n" })).toHaveLength(1);
  });

  test("an empty CLAUDE.md still counts as present", () => {
    expect(check({ "src/foo/CLAUDE.md": "", "src/foo/reference/notes.md": "No headings.\n" })).toEqual([]);
  });

  test("a # line inside a fence in notes.md passes", () => {
    const notes = "## One\n\n```bash\n# a comment\n## not a heading\n### nor this\n```\n\n~~~\n## nor this\n~~~\n";
    expect(check(indexed(notes, "- One\n"))).toEqual([]);
  });

  test("# and #### are not indexed", () => {
    expect(check(indexed("# Title\n\n## One\n\n#### Deep\n", "- One\n"))).toEqual([]);
  });

  test("a rule written as a list item above ## Index passes", () => {
    expect(check(indexed("## One\n", "- One\n", "- **Never** do the thing.\n- Always do the other.\n"))).toEqual([]);
  });

  test("a heading that starts with ⚠️, indexed with [trap], passes", () => {
    expect(check(indexed("## ⚠️ Sharp edge\n", "- ⚠️ Sharp edge [trap]\n"))).toEqual([]);
  });

  test("only one trailing [trap] is stripped, and only at the end", () => {
    expect(check(indexed("## A [trap]\n", "- A [trap] [trap]\n"))).toEqual([]);
    expect(check(indexed("## A [trap] b\n", "- A [trap] b\n"))).toEqual([]);
  });

  test("the index ends at the next heading", () => {
    expect(check(indexed("## One\n", "- One\n\n## Later\n\n- A later list.\n"))).toEqual([]);
  });

  test("the set is taken across every .md file in reference/", () => {
    const files = { ...indexed("## One\n", "- One\n- Two\n"), "src/foo/reference/more.md": "## Two\n" };
    expect(check(files)).toEqual([]);
    expect(check({ ...files, "src/foo/reference/more.txt": "## Three\n" })).toEqual([]);
    expect(check({ ...files, "src/foo/reference/deep/more.md": "## Three\n" })).toEqual([]);
    expect(check({ ...files, "src/other/more.md": "## Three\n" })).toEqual([]);
  });

  test("duplicate heading text is fine", () => {
    expect(check(indexed("## Same\n\n## Same\n", "- Same\n"))).toEqual([]);
  });

  test("a folder with no reference/ whose old CLAUDE.md has hundreds of list items passes", () => {
    const old = Array.from({ length: 500 }, (_, i) => `- item ${i}\n## Heading ${i}\n`).join("");
    expect(check({ "src/old/CLAUDE.md": `## Index\n\n${old}` })).toEqual([]);
  });

  test("reference/ without notes.md is not indexed", () => {
    expect(check({ "src/foo/CLAUDE.md": "x\n", "src/foo/reference/other.md": "## One\n" })).toEqual([]);
  });
});

describe("stale entry", () => {
  test("fails on a budgets entry for a folder that has reference/notes.md", () => {
    const out = check(indexed("## One\n", "- One\n"), { entries: { "src/foo/CLAUDE.md": 50_000 } });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("The file PR deletes its entry.");
    expect(out[0]).toContain("src/foo/CLAUDE.md");
  });

  test("an entry for a folder without reference/notes.md is not stale", () => {
    expect(check({ "src/foo/CLAUDE.md": "x\n" }, { entries: { "src/foo/CLAUDE.md": 50_000 } })).toEqual([]);
  });
});
