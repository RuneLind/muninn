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
    expect(p).toContain("LC_ALL=C git -C '/w/kode' grep -n -I -E -e '(^|[^[:alnum:]])MEL-77([^[:alnum:]]|$)' -- .");
    expect(p).toContain("LC_ALL=C git -C '/w/kode' log --oneline '-G(^|[^[:alnum:]])MEL-77([^[:alnum:]]|$)' -- .");
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
    expect(sub).toContain("grep -n -I -F -e 'it'\\''s' -- .");
    expect(sub).toContain("log --oneline '-Sit'\\''s' -- .");
    const whole = renderContinuePrompt({ path: null, trace: { wiki: "kode", root: "/w/kode", key: "R.1'(x)", mentionsUrl: "u", wholeKey: true }, turns: [turn(1, { selection: null })] });
    expect(whole).toContain("grep -n -I -E -e '(^|[^[:alnum:]])R\\.1'\\''\\(x\\)([^[:alnum:]]|$)' -- .");
    expect(whole).toContain("log --oneline '-G(^|[^[:alnum:]])R\\.1'\\''\\(x\\)([^[:alnum:]]|$)' -- .");
  });
});

// ── A trace's commands, run: what they list against the mentions payload ──

/** The rendered prompt's git commands, in order: the grep, then the log. */
const commandsOf = (prompt: string) => [...prompt.matchAll(/`((?:LC_ALL=C )?git -C [^`]+)`/g)].map((m) => m[1]!);
const sh = (cmd: string): string[] => {
  const r = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
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
