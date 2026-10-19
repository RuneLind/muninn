import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWikiCheck, wikiCheck, wikiRootFor } from "./wiki-check.ts";
import { buildWikiIndex } from "../src/wiki/store.ts";
import { lintWiki } from "../src/wiki/lint.ts";

const SCRIPT = path.join(import.meta.dir, "wiki-check.ts");
const BAD = ["---", "title: X", "---", '<Callout tone="success">', "x", "</Callout>", ""].join("\n");
const CULLED = ["---", "title: R", "signal: none", "signal-reason: retired", "---", '<Callout tone="success">', "x", "</Callout>", ""].join("\n");
const LOOSE_CLOSE = [
  "---",
  "title: Q",
  "---",
  '<Question id="S1" choices="A|B">',
  "",
  "Which one?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** \u2014 A.",
  "- **S1** \u2014 Which one? Lukket 17.10.2026 (S1).",
  "",
  "</DecisionLog>",
  "",
].join("\n");
const UNKNOWN_ROLE = ["---", "title: L", "---", "<NextMoves>", "", '<Lane kind="you" role="jurist">', "", "1. x", "", "</Lane>", "", "</NextMoves>", ""].join("\n");
const COMPILED = "<!-- generated from blogs/src/s.mdx -->\n<html></html>\n";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "wiki-check-"));
  // A wiki with a reader config, a page two folders down, and every place the store skips.
  await Bun.write(path.join(tmp, "wiki/.wiki-reader.json"), "{}");
  await Bun.write(path.join(tmp, "wiki/plans/deep/a.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/plans/b.md"), BAD);
  await Bun.write(path.join(tmp, "wiki/plans/r.mdx"), CULLED);
  await Bun.write(path.join(tmp, "wiki/plans/z.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/notes/z.md"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/src/c.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/src/s.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/s.html"), COMPILED);
  await Bun.write(path.join(tmp, "wiki/blogs/src/u.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/u.html"), "<html>hand-written</html>\n");
  await Bun.write(path.join(tmp, "wiki/blogs/d.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/node_modules/x/e.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/.hidden/f.mdx"), BAD);
  // A wiki whose reader config scopes the scan.
  await Bun.write(path.join(tmp, "scoped/.wiki-reader.json"), JSON.stringify({ include: ["plans/**"] }));
  await Bun.write(path.join(tmp, "scoped/plans/in.mdx"), BAD);
  await Bun.write(path.join(tmp, "scoped/other/out.mdx"), BAD);
  // A folder with no reader config anywhere above it.
  await Bun.write(path.join(tmp, "loose/sub/g.mdx"), BAD);
  await Bun.write(path.join(tmp, "clean/h.mdx"), "no components here\n");
  await Bun.write(path.join(tmp, "empty/note.md"), BAD);
  await Bun.write(path.join(tmp, "locked/i.mdx"), BAD);
  await chmod(path.join(tmp, "locked/i.mdx"), 0o000);
  await Bun.write(path.join(tmp, "mixed/j.mdx"), BAD);
  await chmod(path.join(tmp, "mixed/j.mdx"), 0o000);
  await Bun.write(path.join(tmp, "mixed/k.mdx"), BAD);
  // A wiki whose pages break the checks lintWiki runs on a page's own text.
  await Bun.write(path.join(tmp, "page-checks/.wiki-reader.json"), JSON.stringify({ roleKeys: ["fag", "utvikler"] }));
  await Bun.write(path.join(tmp, "page-checks/plans/q.mdx"), LOOSE_CLOSE);
  await Bun.write(path.join(tmp, "page-checks/plans/l.mdx"), UNKNOWN_ROLE);
  await Bun.write(path.join(tmp, "page-checks/plans/c.mdx"), BAD);
});
afterAll(async () => {
  for (const f of ["locked/i.mdx", "mixed/j.mdx"]) await chmod(path.join(tmp, f), 0o644).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
});

// Root reads a 0o000 file, so the permission cases need an ordinary user.
const asRoot = process.getuid?.() === 0;

const spawn = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, ...args], { cwd: tmp, env: { PATH: process.env.PATH ?? "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const relPaths = async (target: string) => (await runWikiCheck([target])).out.map((l) => (JSON.parse(l) as { relPath: string }).relPath);

describe("wiki-check walks the pages lintWiki checks", () => {
  test("a culled page, a page a same-stem .md shadows, and a compiled source are skipped", async () => {
    expect(await relPaths(path.join(tmp, "wiki"))).toEqual(["blogs/d.mdx", "blogs/src/c.mdx", "blogs/src/u.mdx", "plans/deep/a.mdx"]);
  });

  test("a blogs/src page is dropped only when its compiled .html sibling exists", async () => {
    const found = await relPaths(path.join(tmp, "wiki/blogs"));
    expect(found).toContain("blogs/src/c.mdx");
    expect(found).toContain("blogs/src/u.mdx");
    expect(found).not.toContain("blogs/src/s.mdx");
  });

  test.skipIf(asRoot)("an unreadable same-stem .md is no page, so it shadows nothing: the same findings as lintWiki", async () => {
    const root = path.join(tmp, "unreadable-shadow");
    await Bun.write(path.join(root, ".wiki-reader.json"), "{}");
    await Bun.write(path.join(root, "plans/q.mdx"), BAD);
    await Bun.write(path.join(root, "notes/q.md"), BAD);
    await chmod(path.join(root, "notes/q.md"), 0o000);
    try {
      const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.check.startsWith("component-"));
      expect(lint.map((f) => f.relPath)).toEqual(["plans/q.mdx"]);
      expect((await runWikiCheck([root])).out.map((l) => JSON.parse(l))).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
    } finally {
      await chmod(path.join(root, "notes/q.md"), 0o644);
    }
  });

  test("a .wiki-reader.json include scopes the walk", async () => {
    expect(await relPaths(path.join(tmp, "scoped"))).toEqual(["plans/in.mdx"]);
  });

  test("the same pages, and the same findings, as lintWiki", async () => {
    const root = path.join(tmp, "wiki");
    const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.check.startsWith("component-"));
    expect((await runWikiCheck([root])).out.map((l) => JSON.parse(l))).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
  });
});

describe("wiki-check runs the checks lintWiki runs on a page's own text", () => {
  const PAGE_TEXT = new Set(["question-block", "decision-first-sentence", "status-row-long", "role-key", "case-board-labels", "component-value", "component-attr"]);

  test("a question closed without a decision id is a question-block finding", async () => {
    const { findings } = await wikiCheck(path.join(tmp, "page-checks/plans/q.mdx"));
    expect(findings.map((f) => f.check)).toContain("question-block");
  });

  test("a lane role the reader config does not list is a role-key finding", async () => {
    const { findings } = await wikiCheck(path.join(tmp, "page-checks/plans/l.mdx"));
    expect(findings.map((f) => f.check)).toContain("role-key");
  });

  test("the same page-text findings as lintWiki, over a directory", async () => {
    const root = path.join(tmp, "page-checks");
    const lint = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => PAGE_TEXT.has(f.check));
    expect(new Set(lint.map((f) => f.check))).toEqual(new Set(["question-block", "role-key", "component-value"]));
    expect((await runWikiCheck([root])).out.map((l) => JSON.parse(l))).toEqual(lint.map((f) => JSON.parse(JSON.stringify(f))));
  });
});

describe("wiki-check", () => {
  test("relPath is relative to the nearest .wiki-reader.json, else to the argument", async () => {
    expect(wikiRootFor(path.join(tmp, "wiki/plans/deep"))).toBe(path.join(tmp, "wiki"));
    expect((await wikiCheck(path.join(tmp, "wiki/plans"))).findings.map((f) => f.relPath)).toEqual(["plans/deep/a.mdx"]);
    const one = await wikiCheck(path.join(tmp, "wiki/plans/deep/a.mdx"));
    expect(one.findings.map((f) => [f.relPath, f.line])).toEqual([["plans/deep/a.mdx", 4]]);
    expect((await wikiCheck(path.join(tmp, "loose"))).findings.map((f) => f.relPath)).toEqual(["sub/g.mdx"]);
    expect((await wikiCheck(path.join(tmp, "loose/sub/g.mdx"))).findings.map((f) => f.relPath)).toEqual(["g.mdx"]);
  });

  test("runs with no .env, prints only JSON lines and exits 0 with and without findings", () => {
    const found = spawn(path.join(tmp, "wiki/plans"));
    expect(found.code).toBe(0);
    expect(found.err).toBe("");
    expect(found.out.trimEnd().split("\n").map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ check: "component-value", relPath: "plans/deep/a.mdx", line: 4 }),
    ]);
    expect(spawn(path.join(tmp, "clean"))).toEqual({ code: 0, out: "", err: "" });
  });

  test("a directory with no .mdx page says so on stderr and exits 0", () => {
    expect(spawn(path.join(tmp, "empty"))).toEqual({ code: 0, out: "", err: `wiki-check: no .mdx pages under ${path.join(tmp, "empty")}\n` });
  });

  test("a usage error exits 2 with the usage line", () => {
    for (const args of [[], [path.join(tmp, "clean"), path.join(tmp, "wiki")]]) {
      const r = spawn(...args);
      expect({ args, code: r.code, out: r.out }).toEqual({ args, code: 2, out: "" });
      expect(r.err).toStartWith("usage: ");
    }
  });

  test("a relative path exits 2 and says the path must be absolute", () => {
    const r = spawn("relative/path");
    expect({ code: r.code, out: r.out }).toEqual({ code: 2, out: "" });
    expect(r.err.split("\n")[0]).toBe("wiki-check: the path must be absolute: relative/path");
    expect(r.err).toContain("usage: ");
  });

  test("a page that is not .mdx exits 2 with a usage message", () => {
    const r = spawn(path.join(tmp, "wiki/plans/b.md"));
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain(`not an .mdx page: ${path.join(tmp, "wiki/plans/b.md")}`);
    expect(r.err).toContain("usage: ");
  });

  test("an unreadable page or a missing path exits 2 with one line and no stack trace", () => {
    const targets = [path.join(tmp, "nope"), path.join(tmp, "nope.mdx"), ...(asRoot ? [] : [path.join(tmp, "locked/i.mdx")])];
    for (const target of targets) {
      const r = spawn(target);
      expect({ target, code: r.code, out: r.out, lines: r.err.trimEnd().split("\n").length }).toEqual({ target, code: 2, out: "", lines: 1 });
      expect(r.err).toStartWith("wiki-check: cannot read ");
      expect(r.err).not.toContain("    at ");
    }
  });

  test.skipIf(asRoot)("an unreadable page in a directory is one stderr line; the run goes on", () => {
    const r = spawn(path.join(tmp, "mixed"));
    expect(r.code).toBe(0);
    expect(r.err).toBe(`wiki-check: cannot read ${path.join(tmp, "mixed/j.mdx")}: EACCES\n`);
    expect(r.out.trimEnd().split("\n").map((l) => (JSON.parse(l) as { relPath: string }).relPath)).toEqual(["k.mdx"]);
  });

  test.skipIf(asRoot)("a directory none of whose pages can be read exits 3", async () => {
    const r = await runWikiCheck([path.join(tmp, "locked")]);
    expect(r.code).toBe(3);
    expect(r.err).toEqual([expect.stringMatching(/^wiki-check: cannot read .*i\.mdx: EACCES$/)]);
  });
});
