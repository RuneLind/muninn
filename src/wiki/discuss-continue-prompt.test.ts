/**
 * «Continue in Claude Code»'s prompt (Discuss P3, `renderContinuePrompt`):
 * the page path, each turn's passage, question and answer in order, and the
 * bound that drops the oldest answers first and never the handed-over turn.
 * A trace's git commands are run on a temp repo whose wiki is a subdirectory
 * and compared with what the mentions payload's searches return.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { marked } from "marked";
import { testTempDir } from "../test/temp-dir.ts";
import { CONTINUE_PROMPT_MAX, renderContinuePrompt, type ContinueTrace, type ContinueTurn } from "./discuss-prompt.ts";
import { grepTracked, historyFor } from "./tracked-files.ts";

const turn = (seq: number, over: Partial<ContinueTurn> = {}): ContinueTurn => ({
  seq,
  selection: "The ferry leaves at nine.",
  location: { found: "exact", fromLine: 12, toLine: 12 },
  question: `Question ${seq}?`,
  answer: `Answer ${seq}.`,
  endState: "done",
  pageChanged: false,
  ...over,
});

describe("renderContinuePrompt", () => {
  test("the path, then every turn oldest first, with where its passage is", () => {
    const p = renderContinuePrompt({ path: "/w/plans/ferry.mdx", turns: [turn(2, { selection: null }), turn(1)] });
    expect(p).toContain("Page: /w/plans/ferry.mdx");
    expect(p.indexOf("Turn 1 (passage, line 12):")).toBeLessThan(p.indexOf("Turn 2 (about the whole page):"));
    expect(p).toContain("> The ferry leaves at nine.");
    expect(p).toContain("Question 2?");
    expect(p).toContain("Answer 1.");
    expect(p.trimEnd().endsWith("show me the edit before you write it.")).toBe(true);
  });

  test("a turn that did not finish says how it ended; a section match is not stated as the passage's lines", () => {
    const p = renderContinuePrompt({ path: "/p", turns: [turn(1, { endState: "timeout", answer: "", location: { found: "section", fromLine: 4, toLine: 9 } })] });
    expect(p).toContain("Answer (the turn ended timeout):\n(none)");
    expect(p).toContain("not placed exactly; in the section at lines 4–9");
  });

  test("a turn whose page has changed since: no stored lines, the change said instead; other turns keep theirs", () => {
    const p = renderContinuePrompt({ path: "/p", turns: [turn(1, { pageChanged: true }), turn(2, { pageChanged: false, location: { found: "exact", fromLine: 30, toLine: 31 } })] });
    expect(p).toContain("Turn 1 (passage, lines not given: the page has changed since this turn):");
    expect(p).not.toContain("line 12");
    expect(p).toContain("Turn 2 (passage, lines 30–31):");
  });

  test("over the bound: the oldest answers go first, the last turn stays whole", () => {
    const long = "x".repeat(2900);
    const turns = Array.from({ length: 8 }, (_, k) => turn(k + 1, { answer: `${long} end ${k + 1}` }));
    const p = renderContinuePrompt({ path: "/p", turns });
    expect(p.length).toBeLessThanOrEqual(CONTINUE_PROMPT_MAX);
    expect(p).toContain("Answer: (left out to fit)");
    expect(p).toContain("end 8");
    expect(p).not.toContain("end 1");
  });
  test("a trace turn (no page): the key, the wiki and how to list the mentions again; no page wording", () => {
    const trace = { wiki: "kode", root: "/w/kode", key: "MEL-77", mentionsUrl: "http://127.0.0.1:3010/api/wiki/mentions?wiki=kode&key=MEL-77", wholeKey: true };
    const p = renderContinuePrompt({ path: null, trace, turns: [turn(1, { selection: null, location: null }), turn(2, { selection: null, location: null })] });
    expect(p).not.toContain("Page:");
    expect(p).toContain("Key: MEL-77");
    expect(p).toContain("Wiki: kode (/w/kode)");
    // One fenced block holds both commands, and no code span runs git.
    expect(marked.lexer(p).filter((t) => t.type === "code").map((t) => (t as { text: string }).text.split("\n").length)).toEqual([2]);
    const [grep, log] = commandsOf(p);
    expect(commandsOf(p)).toHaveLength(2);
    expect(grep).toStartWith('env -i PATH="$PATH" HOME="$HOME" LC_ALL=C GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git --no-pager --literal-pathspecs -C \'/w/kode\' -c core.quotePath=false');
    expect(grep).toEndWith(" grep --no-recurse-submodules --no-color -n -I -E -e '(^|[^[:alnum:]])MEL-77([^[:alnum:]]|$)' -- .");
    expect(log).toEndWith(" log --no-show-signature --no-color --no-decorate --no-ext-diff --no-textconv --relative --oneline '-G(^|[^[:alnum:]])MEL-77([^[:alnum:]]|$)' -- .");
    expect(p).toContain("lists at most 500 lines and 50 commits and checks at most 300 candidate commits");
    expect(p).toContain("http://127.0.0.1:3010/api/wiki/mentions?wiki=kode&key=MEL-77 returns the exact answer");
    expect(p).toContain("Both can list more than that answer");
    expect(p).toContain("Turn 1:\nQuestion: Question 1?");
    expect(p).not.toContain("about the whole page");
    expect(p).not.toContain("this wiki page");
    expect(p).not.toContain("If the page turns out to be wrong");
    expect(p.trimEnd().endsWith("Go on from the last answer.")).toBe(true);
  });

  test("a trace key with a quote is quoted for the shell, and a whole key's ERE escapes its metacharacters", () => {
    const sub = renderContinuePrompt({ path: null, trace: { wiki: "kode", root: "/w/kode", key: "it's", mentionsUrl: "u", wholeKey: false }, turns: [turn(1, { selection: null })] });
    expect(sub).toContain("LC_ALL=C.UTF-8 ");
    expect(sub).toContain(" -n -I -F -e 'it'\\''s' -- .");
    expect(sub).toContain(" --relative --oneline '-Sit'\\''s' -- .");
    expect(sub).toContain("lists at most 500 lines and 50 commits, so for a busy key the commands list more.");
    const whole = renderContinuePrompt({ path: null, trace: { wiki: "kode", root: "/w/kode", key: "R.1'(x)", mentionsUrl: "u", wholeKey: true }, turns: [turn(1, { selection: null })] });
    expect(whole).toContain(" -n -I -E -e '(^|[^[:alnum:]])R\\.1'\\''\\(x\\)([^[:alnum:]]|$)' -- .");
    expect(whole).toContain(" --oneline '-G(^|[^[:alnum:]])R\\.1'\\''\\(x\\)([^[:alnum:]]|$)' -- .");
  });
});

// ── A trace's commands, run: what they list against the mentions payload ──

/** The rendered prompt's git commands, in order (the grep, then the log), read as markdown: each code block's text, one command per line that starts with `env`, and each code span that runs git. */
function commandsOf(prompt: string): string[] {
  const out: string[] = [];
  marked.walkTokens(marked.lexer(prompt), (t) => {
    if (t.type === "code") out.push(...(t as { text: string }).text.split(/\n(?=env )/));
    else if (t.type === "codespan" && /\bgit\b/.test((t as { text: string }).text)) out.push((t as { text: string }).text);
  });
  return out;
}
const sh = (cmd: string, env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }): string[] => {
  const r = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", env });
  // git grep's «no match» is exit 1 with nothing on stderr.
  if (r.exitCode !== 0 && !(r.exitCode === 1 && r.stderr.length === 0)) throw new Error(`${cmd}: ${r.stderr.toString()}`);
  return r.stdout.toString().split("\n").filter(Boolean);
};

describe("a trace's commands against the mentions payload (wiki in a subdirectory of a bigger repo)", () => {
  let repo = "";
  let wiki = "";
  const subjectOf: Record<string, string> = {};
  const g = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const put = async (rel: string, text: string | Uint8Array) => {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), text);
  };
  const commit = (subject: string) => {
    g("add", "-A");
    g("commit", "-q", "-m", subject);
    subjectOf[g("rev-parse", "HEAD")] = subject;
  };

  beforeAll(async () => {
    repo = await realpath(await testTempDir(path.join(tmpdir(), "muninn-continue-trace-")));
    wiki = path.join(repo, "wiki");
    g("init", "-q", "-b", "main");
    await put("top.md", "Nothing here.\n");
    await put("wiki/a.md", "MEL-1 open.\nMEL-1_notes stay.\nSee MEL-10 only.\n");
    await put("wiki/b.md", "Not XMEL-1 nor MEL-1\u00e5.\n");
    await put("wiki/d.md", "Case R.1 here.\nNot Rx1.\n");
    await put("wiki/blob.bin", new Uint8Array([0, 1, 2, ...new TextEncoder().encode(" MEL-1 "), 0, 3]));
    commit("base");
    await put("top.md", "MEL-1 outside the wiki.\n");
    commit("outside only");
    await put("top.md", "MEL-1 outside the wiki. MEL-1 again.\n");
    await put("wiki/c.md", "hello\n");
    commit("outside key, unrelated wiki change");
    await put("wiki/ten.md", "MEL-10 only.\n");
    commit("only MEL-10");
    await put("wiki/a.md", "MEL-1 closed.\nMEL-1_notes stay.\nSee MEL-10 only.\n");
    commit("edit a line holding MEL-1");
    await put("wiki/n.md", "Saken \u00e6MEL-1 er ikke v\u00e5r.\n");
    commit("non-ASCII letter before MEL-1");
    await put("wiki/e.md", "see MEL-1/MEL-1 x\n");
    commit("two copies one character apart");
  });

  const run = (key: string, wholeKey: boolean) => {
    const trace: ContinueTrace = { wiki: "kode", root: wiki, key, mentionsUrl: "u", wholeKey };
    const [grep, log] = commandsOf(renderContinuePrompt({ path: null, trace, turns: [turn(1, { selection: null })] }));
    expect(grep).toBeDefined();
    expect(log).toBeDefined();
    // `path:line:` of each grep line; the subject of each `--oneline` commit.
    const lines = new Set(sh(grep!).map((l) => l.split(":").slice(0, 2).join(":")));
    const commits = new Set(sh(log!).map((l) => l.slice(l.indexOf(" ") + 1)));
    return { lines, commits };
  };
  const payload = async (key: string, wholeKey: boolean) => {
    const grep = await grepTracked(wiki, key, { max: 1000, wholeKey });
    const history = await historyFor(wiki, key, { limit: 200, wholeKey });
    if (!grep.ok || !history.ok) throw new Error("payload search failed");
    return { lines: new Set(grep.hits.map((h) => `${h.relPath}:${h.line}`)), commits: new Set(history.commits.map((c) => subjectOf[c.hash] ?? c.subject)) };
  };
  const minus = <T>(a: Set<T>, b: Set<T>) => [...a].filter((x) => !b.has(x)).sort();

  test("a whole key, the grep: every line of the payload (`_` ends a key, binary files skipped), and more only next to a non-ASCII letter", async () => {
    const got = run("MEL-1", true);
    const want = await payload("MEL-1", true);
    expect([...want.lines].sort()).toEqual(["a.md:1", "a.md:2", "e.md:1"]);
    expect(minus(want.lines, got.lines)).toEqual([]);
    expect(minus(got.lines, want.lines)).toEqual(["b.md:1", "n.md:1"]);
  });

  test("a whole key, the log: every commit of the payload, none outside the wiki or only about MEL-10, and more only where the prompt says", async () => {
    const got = run("MEL-1", true);
    const want = await payload("MEL-1", true);
    expect([...want.commits].sort()).toEqual(["base", "two copies one character apart"]);
    expect(minus(want.commits, got.commits)).toEqual([]);
    // An edit of a line holding the key, and a non-ASCII letter next to it: what the prompt says the log may add.
    expect(minus(got.commits, want.commits)).toEqual(["edit a line holding MEL-1", "non-ASCII letter before MEL-1"]);
  });

  test("a whole key with a regex metacharacter is matched literally", async () => {
    const got = run("R.1", true);
    const want = await payload("R.1", true);
    expect([...got.lines]).toEqual(["d.md:1"]);
    expect(got.lines).toEqual(want.lines);
    expect(got.commits).toEqual(want.commits);
  });

  test("a substring key (no kind), the grep: exactly the payload's lines", async () => {
    const got = run("MEL-1", false);
    const want = await payload("MEL-1", false);
    expect(want.lines.has("a.md:3")).toBe(true);
    expect(got.lines).toEqual(want.lines);
  });

  test("a substring key (no kind), the log: exactly the payload's commits, none from outside the wiki", async () => {
    const got = run("MEL-1", false);
    const want = await payload("MEL-1", false);
    expect(want.commits.has("only MEL-10")).toBe(true);
    expect(got.commits).toEqual(want.commits);
  });
});

// ── Class check (Discuss v2 PR 6, sweep A): git config × key and root characters ──
//
// Each row runs the rendered commands with `sh` and compares them with the
// mentions payload: for a whole key every payload line and commit is in the
// command's output (⊆), for a substring key the output is the payload, in
// order (=), both with the same path and subject spelling. Each key runs on
// a root holding every character class a root path can (', ", `, $, \, space,
// a part starting with -, non-ASCII, a newline) and on a plain one; the config
// rows run on the plain one, so each shows its own key's effect. The key file
// has a non-ASCII name and is added in the root commit. Config that changes
// nothing the comparison reads (hash length, an order git fixes, a flag that
// wins) is a pin row.

/** Every class of character a key can hold (`parseMentionKey`: 3–80 characters, no control character, so no newline). */
const KEY_ROWS = ["MEL-1", "it's", 'a"b', "tick`key", "two``ticks", "$HOME", "back\\slash", "sp ace", "-dash", "R.1(x)*", "[a-z]+", "nøkkel"];
/** The keys every config row runs: a plain one, and one with a quote (no backtick: the key rows cover it, and on an unfixed prompt it would hide the row's own effect). */
const CONFIG_KEYS = ["MEL-1", "it's"];

interface ConfigRow {
  cell: string;
  /** What the key changes on an unpinned command: the line or commit set, the spelling, or nothing. */
  effect: "set" | "spelling" | "pin";
  /** The global config file's text (`GIT_CONFIG_GLOBAL`), after {@link NEUTRAL}; absent, NEUTRAL alone. */
  global?: string;
  /** More variables for the shell the commands run in. */
  env?: (fx: Fixture) => Record<string, string>;
  /** Lines for the repo's own `.git/config` (the payload reads them too). */
  repo?: string;
  /** Lines for the repo's `.git/info/attributes`. */
  attributes?: string;
}

interface Fixture {
  repo: string;
  /** The wiki whose root holds every character class a path can. */
  wiki: string;
  /** A wiki in the same repo with a plain root, for the config rows. */
  plain: string;
  textconv: string;
  /** A textconv driver that prints nothing. */
  strip: string;
  gpg: string;
  hostile: string;
  system: string;
  /** HOME for the shell: its `.gitconfig` and XDG `git/config` hold the row's global config too, since `env -i` keeps HOME. */
  home: string;
}

/** Every global file starts with this, so on an unpinned command each row shows its own key's effect, not `core.quotePath`'s default (its own row). */
const NEUTRAL = "[core]\n\tquotePath = false\n";
const ALL_AT_ONCE =
  "[core]\n\tquotePath = true\n[log]\n\tshowRoot = false\n\tshowSignature = true\n\tdecorate = full\n[diff]\n\trenames = false\n[diff \"up\"]\n\ttextconv = TEXTCONV\n[submodule]\n\trecurse = true\n[grep]\n\tfullName = true\n\tcolumn = true\n[color]\n\tui = always\n[gpg]\n\tprogram = GPG\n[i18n]\n\tlogOutputEncoding = ISO-8859-1\n";

const CONFIG_ROWS: ConfigRow[] = [
  { cell: "core.quotePath=true (git's default) quotes a non-ASCII path", effect: "spelling", global: "[core]\n\tquotePath = true\n" },
  { cell: "log.showRoot=false drops the root commit", effect: "set", global: "[log]\n\tshowRoot = false\n" },
  { cell: "diff.renames=false lists a pure rename", effect: "set", global: "[diff]\n\trenames = false\n" },
  { cell: "a textconv driver changes what the pickaxe reads", effect: "set", global: "[diff \"up\"]\n\ttextconv = TEXTCONV\n" },
  { cell: "submodule.recurse=true greps a submodule", effect: "set", global: "[submodule]\n\trecurse = true\n" },
  { cell: "grep.fullName=true prints paths from the repo's top", effect: "spelling", global: "[grep]\n\tfullName = true\n" },
  { cell: "grep.column=true adds a column", effect: "spelling", global: "[grep]\n\tcolumn = true\n" },
  { cell: "color.ui=always colours a pipe", effect: "spelling", global: "[color]\n\tui = always\n" },
  { cell: "log.showSignature=true prints gpg's lines", effect: "spelling", global: "[log]\n\tshowSignature = true\n[gpg]\n\tprogram = GPG\n" },
  { cell: "i18n.logOutputEncoding re-encodes a subject", effect: "spelling", global: "[i18n]\n\tlogOutputEncoding = ISO-8859-1\n" },
  { cell: "log.decorate=full puts ref names before the subject", effect: "spelling", global: "[log]\n\tdecorate = full\n" },
  { cell: "grep.patternType=perl and grep.extendedRegexp: -E and -F win", effect: "pin", global: "[grep]\n\tpatternType = perl\n\textendedRegexp = true\n" },
  { cell: "grep.lineNumber=false and grep.threads: -n wins, the order is git's", effect: "pin", global: "[grep]\n\tlineNumber = false\n\tthreads = 1\n" },
  { cell: "log.follow=true: no single file is given", effect: "pin", global: "[log]\n\tfollow = true\n" },
  { cell: "core.abbrev, log.abbrevCommit, format.pretty, log.date: --oneline's own form", effect: "pin", global: "[core]\n\tabbrev = 12\n[log]\n\tabbrevCommit = false\n\tdate = iso\n[format]\n\tpretty = fuller\n" },
  { cell: "diff.algorithm, diff.indentHeuristic, diff.noprefix, diff.external", effect: "pin", global: "[diff]\n\talgorithm = patience\n\tindentHeuristic = false\n\tnoprefix = true\n\texternal = /bin/false\n" },
  { cell: "core.pager and pager.*: no terminal, and --no-pager", effect: "pin", global: "[core]\n\tpager = rev\n[pager]\n\tgrep = rev\n\tlog = rev\n" },
  { cell: "every set and spelling key at once", effect: "set", global: ALL_AT_ONCE },
  { cell: "the system file (GIT_CONFIG_SYSTEM) with every key", effect: "set", env: (fx) => ({ GIT_CONFIG_SYSTEM: fx.system }) },
  { cell: "GIT_CONFIG_PARAMETERS in the shell", effect: "set", env: () => ({ GIT_CONFIG_PARAMETERS: "'log.showroot'='false' 'grep.fullname'='true'" }) },
  { cell: "GIT_DIR in the shell names another repo", effect: "set", env: (fx) => ({ GIT_DIR: path.join(fx.repo, "nonexistent.git") }) },
  {
    cell: "the repo's own .git/config: the payload's -c pins and flags win, and what it reads the commands read",
    effect: "set",
    repo: "[core]\n\tquotePath = true\n[grep]\n\tfullName = true\n\tcolumn = true\n[submodule]\n\trecurse = true\n[color]\n\tui = always\n[log]\n\tdecorate = full\n\tshowSignature = true\n\tshowRoot = false\n[gpg]\n\tprogram = GPG\n[diff]\n\trenames = false\n[diff \"up\"]\n\ttextconv = TEXTCONV\n",
  },
  {
    cell: "the repo's own textconv that hides the key file from the pickaxe: a whole key's -G reads it raw (--no-textconv), as the payload's does",
    effect: "set",
    repo: "[diff \"strip\"]\n\ttextconv = STRIP\n",
    attributes: "nøkkel-ny.md diff=strip\n",
  },
];

describe("a trace's commands read the config the payload reads (class check)", () => {
  const fx: Fixture = { repo: "", wiki: "", plain: "", textconv: "", strip: "", gpg: "", hostile: "", system: "", home: "" };
  const subjects: string[] = [];
  const quiet = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const g = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { stdout: "pipe", stderr: "pipe", env: quiet });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  const keyLines = (word: string) => [...KEY_ROWS, ...CONFIG_KEYS].map((k) => `${word} ${k} here.`).join("\n") + "\n";
  const commit = (subject: string, ...extra: string[]) => {
    g(fx.repo, "add", "-A");
    g(fx.repo, ...extra, "commit", "-q", ...(extra.length ? ["-S"] : []), "-m", subject);
    subjects.push(subject);
  };
  const fill = (text: string) => text.replace("TEXTCONV", fx.textconv).replace("GPG", fx.gpg).replace("STRIP", fx.strip);

  beforeAll(async () => {
    const base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-continue-hostile-")));
    fx.repo = path.join(base, "repo");
    // A line of its own that is a code fence, for the fence's length.
    fx.wiki = path.join(fx.repo, "wi'ki \"q\" `b` $x \\y ø -z\n```\nnl");
    fx.plain = path.join(fx.repo, "plain wiki");
    fx.textconv = path.join(base, "textconv.sh");
    fx.gpg = path.join(base, "gpg.sh");
    fx.strip = path.join(base, "strip.sh");
    await writeFile(fx.strip, "#!/bin/sh\n:\n", { mode: 0o755 });
    fx.hostile = path.join(base, "hostile.gitconfig");
    fx.system = path.join(base, "system.gitconfig");
    fx.home = path.join(base, "home");
    await mkdir(path.join(fx.home, ".config", "git"), { recursive: true });
    await writeFile(path.join(base, "keys.txt"), keyLines("Textconv"));
    await writeFile(fx.textconv, `#!/bin/sh\ncat '${path.join(base, "keys.txt")}'\n`, { mode: 0o755 });
    await writeFile(fx.gpg, "#!/bin/sh\nfor a in \"$@\"; do if [ \"$a\" = --verify ]; then echo 'gpg: FAKE SIGNATURE' >&2; exit 1; fi; done\ncat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 0 fake' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n=fake\\n-----END PGP SIGNATURE-----\\n'\n", { mode: 0o755 });
    // The submodule's own repo.
    const sub = path.join(base, "subsrc");
    await mkdir(sub, { recursive: true });
    g(sub, "init", "-q", "-b", "main");
    await writeFile(path.join(sub, "k.md"), keyLines("Sub"));
    g(sub, "add", "-A");
    g(sub, "commit", "-q", "-m", "sub");

    // Two wikis in one repo, each commit the same in both: one whose root holds every character class, one plain.
    const wikis = [fx.wiki, fx.plain];
    const each = async (f: (w: string, n: number) => Promise<void> | void) => {
      for (const [n, w] of wikis.entries()) await f(w, n);
    };
    await each(async (w) => {
      await mkdir(w, { recursive: true });
    });
    g(fx.repo, "init", "-q", "-b", "main");
    await writeFile(path.join(fx.repo, "top.md"), keyLines("Top"));
    await each(async (w) => {
      await writeFile(path.join(w, "nøkkel.md"), keyLines("See"));
      await writeFile(path.join(w, ".gitattributes"), "*.txt diff=up\n");
    });
    commit("rot: nøkkel");
    await each((w) => g(fx.repo, "mv", path.join(w, "nøkkel.md"), path.join(w, "nøkkel-ny.md")));
    commit("flytt: nøkkel");
    await each((w) => writeFile(path.join(w, "x.txt"), "nothing\n"));
    commit("textconv only");
    await each((w) => writeFile(path.join(w, "nøkkel-ny.md"), keyLines("See") + keyLines("Again")));
    commit("edit");
    // A ref on a listed commit, for log.decorate.
    g(fx.repo, "tag", "v1");
    await each((w, n) => g(w, "submodule", "add", "-q", "--name", `sub${n}`, sub, "sub"));
    commit("submodule");
    await each((w) => writeFile(path.join(w, "nøkkel-ny.md"), keyLines("See") + keyLines("Again") + keyLines("Signed")));
    commit("signed", "-c", `gpg.program=${fx.gpg}`, "-c", "user.signingkey=fake");
    await writeFile(path.join(fx.repo, "top.md"), keyLines("Top") + keyLines("Outside"));
    commit("outside only");
  });

  const prompt = (root: string, key: string, wholeKey: boolean) => renderContinuePrompt({ path: null, trace: { wiki: "kode", root, key, mentionsUrl: "u", wholeKey }, turns: [turn(1, { selection: null })] });
  type Payload = { lines: string[]; commits: { hash: string; subject: string }[] };
  const payloads = new Map<string, Promise<Payload>>();
  const payload = async (root: string, key: string, wholeKey: boolean): Promise<Payload> => {
    const grep = await grepTracked(root, key, { max: 1000, fullText: true, wholeKey });
    const history = await historyFor(root, key, { limit: 100, wholeKey });
    if (!grep.ok) throw new Error(grep.error);
    if (!history.ok) throw new Error(history.error);
    return { lines: grep.hits.map((h) => `${h.relPath}:${h.line}:${h.full}`), commits: history.commits.map((c) => ({ hash: c.hash, subject: c.subject })) };
  };
  /** The payload, once per root, key and kind; `fresh` reads it again (the repo row changes what it reads). */
  const payloadOf = (root: string, key: string, wholeKey: boolean, fresh = false) => {
    const id = `${root}\0${key}\0${wholeKey}`;
    if (fresh) return payload(root, key, wholeKey);
    if (!payloads.has(id)) payloads.set(id, payload(root, key, wholeKey));
    return payloads.get(id)!;
  };
  const shAsync = async (cmd: string, env: Record<string, string>): Promise<string[]> => {
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", env, detached: true });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    // git grep's «no match» is exit 1 with nothing on stderr.
    if (code !== 0 && !(code === 1 && err.length === 0)) throw new Error(`${cmd}: ${err}`);
    return out.split("\n").filter(Boolean);
  };
  /** Run the prompt's commands for `key` in a shell with `env` and compare with the payload: ⊆ for a whole key, = for a substring key. */
  const compare = async (root: string, key: string, wholeKey: boolean, env: Record<string, string>, fresh = false) => {
    const cmds = commandsOf(prompt(root, key, wholeKey));
    expect(cmds).toHaveLength(2);
    const [grepCmd, logCmd] = cmds;
    const [want, lines, logLines] = await Promise.all([payloadOf(root, key, wholeKey, fresh), shAsync(grepCmd!, env), shAsync(logCmd!, env)]);
    expect(want.lines.length).toBeGreaterThan(0);
    expect(want.commits.length).toBeGreaterThan(0);
    const commits = logLines.map((l) => ({ abbrev: l.slice(0, l.indexOf(" ")), subject: l.slice(l.indexOf(" ") + 1) }));
    const found = (c: { hash: string; subject: string }) => commits.some((o) => o.abbrev.length >= 7 && c.hash.startsWith(o.abbrev) && o.subject === c.subject);
    if (wholeKey) {
      expect({ key, missing: want.lines.filter((l) => !lines.includes(l)) }).toEqual({ key, missing: [] });
      expect({ key, missing: want.commits.filter((c) => !found(c)).map((c) => c.subject) }).toEqual({ key, missing: [] });
    } else {
      expect({ key, lines }).toEqual({ key, lines: want.lines });
      expect({ key, commits: commits.map((c) => c.subject), all: want.commits.every(found) }).toEqual({ key, commits: want.commits.map((c) => c.subject), all: true });
    }
  };
  const baseEnv = () => ({ PATH: process.env.PATH ?? "", HOME: fx.home, GIT_CONFIG_GLOBAL: fx.hostile });
  /** The row's global config, in every file git reads as the user's. */
  const writeGlobal = async (text: string) => {
    for (const f of [fx.hostile, path.join(fx.home, ".gitconfig"), path.join(fx.home, ".config", "git", "config")]) await writeFile(f, text);
  };

  // Key × root: every key class, on the root with every character class and on the plain one.
  for (const key of KEY_ROWS) {
    for (const [rootName, rootOf] of [["the root of every class", () => fx.wiki], ["a plain root", () => fx.plain]] as const) {
      test(`key ${JSON.stringify(key)} on ${rootName}: the commands parse out of the prompt and match the payload (whole key ⊆, substring =)`, async () => {
        await writeGlobal(NEUTRAL);
        await Promise.all([true, false].map((wholeKey) => compare(rootOf(), key, wholeKey, baseEnv())));
      });
    }
  }

  // Config: each row on the plain root, so a row shows its key's effect alone.
  for (const row of CONFIG_ROWS) {
    test(`config [${row.effect}] ${row.cell}`, async () => {
      await writeGlobal(fill(NEUTRAL + (row.global ?? "")));
      await writeFile(fx.system, fill(ALL_AT_ONCE));
      const env = { ...baseEnv(), ...row.env?.(fx) };
      const gitConfig = path.join(fx.repo, ".git", "config");
      const saved = await Bun.file(gitConfig).text();
      const attributes = path.join(fx.repo, ".git", "info", "attributes");
      if (row.repo) await writeFile(gitConfig, saved + fill(row.repo));
      if (row.attributes) await writeFile(attributes, row.attributes);
      try {
        await Promise.all(CONFIG_KEYS.flatMap((key) => [true, false].map((wholeKey) => compare(fx.plain, key, wholeKey, env, row.repo !== undefined))));
      } finally {
        if (row.repo) await writeFile(gitConfig, saved);
        if (row.attributes) await writeFile(attributes, "");
      }
    });
  }
});
