import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mdxFilesUnder, runWikiCheck, wikiCheck, wikiRootFor } from "./wiki-check.ts";

const SCRIPT = path.join(import.meta.dir, "wiki-check.ts");
const BAD = ["---", "title: X", "---", '<Callout tone="success">', "x", "</Callout>", ""].join("\n");

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "wiki-check-"));
  // A wiki with a reader config, a page two folders down, and every excluded place.
  await Bun.write(path.join(tmp, "wiki/.wiki-reader.json"), "{}");
  await Bun.write(path.join(tmp, "wiki/plans/deep/a.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/plans/b.md"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/src/c.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/blogs/d.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/node_modules/x/e.mdx"), BAD);
  await Bun.write(path.join(tmp, "wiki/.hidden/f.mdx"), BAD);
  // A folder with no reader config anywhere above it.
  await Bun.write(path.join(tmp, "loose/sub/g.mdx"), BAD);
  await Bun.write(path.join(tmp, "clean/h.mdx"), "no components here\n");
  await Bun.write(path.join(tmp, "locked/i.mdx"), BAD);
  await chmod(path.join(tmp, "locked/i.mdx"), 0o000);
});
afterAll(async () => {
  await chmod(path.join(tmp, "locked/i.mdx"), 0o644).catch(() => {});
  await rm(tmp, { recursive: true, force: true });
});

// Root reads a 0o000 file, so the permission cases need an ordinary user.
const asRoot = process.getuid?.() === 0;

const spawn = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, ...args], { cwd: tmp, env: { PATH: process.env.PATH ?? "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe("wiki-check", () => {
  test("a directory walks .mdx pages outside blogs/src, node_modules and dot directories", () => {
    expect(mdxFilesUnder(path.join(tmp, "wiki")).map((p) => path.relative(tmp, p))).toEqual(["wiki/blogs/d.mdx", "wiki/plans/deep/a.mdx"]);
  });

  test("relPath is relative to the nearest .wiki-reader.json, else to the argument", async () => {
    expect(wikiRootFor(path.join(tmp, "wiki/plans/deep"))).toBe(path.join(tmp, "wiki"));
    const sub = await wikiCheck(path.join(tmp, "wiki/plans"));
    expect(sub.map((f) => f.relPath)).toEqual(["plans/deep/a.mdx"]);
    const one = await wikiCheck(path.join(tmp, "wiki/plans/deep/a.mdx"));
    expect(one.map((f) => [f.relPath, f.line])).toEqual([["plans/deep/a.mdx", 4]]);
    expect((await wikiCheck(path.join(tmp, "loose"))).map((f) => f.relPath)).toEqual(["sub/g.mdx"]);
    expect((await wikiCheck(path.join(tmp, "loose/sub/g.mdx"))).map((f) => f.relPath)).toEqual(["g.mdx"]);
  });

  test("runs with no .env, prints only JSON lines and exits 0 with and without findings", () => {
    const found = spawn(path.join(tmp, "wiki"));
    expect(found.code).toBe(0);
    expect(found.err).toBe("");
    expect(found.out.trimEnd().split("\n").map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ check: "component-value", relPath: "blogs/d.mdx", line: 4 }),
      expect.objectContaining({ check: "component-value", relPath: "plans/deep/a.mdx", line: 4 }),
    ]);
    expect(spawn(path.join(tmp, "clean"))).toEqual({ code: 0, out: "", err: "" });
  });

  test("a usage error exits 2 with the usage line", () => {
    for (const args of [[], ["relative/path"], [path.join(tmp, "clean"), path.join(tmp, "wiki")]]) {
      const r = spawn(...args);
      expect({ args, code: r.code, out: r.out }).toEqual({ args, code: 2, out: "" });
      expect(r.err).toStartWith("usage: ");
    }
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

  test.skipIf(asRoot)("an unreadable directory exits 2 with one line", async () => {
    const r = await runWikiCheck([path.join(tmp, "locked")]);
    expect(r.code).toBe(2);
    expect(r.err).toEqual([expect.stringMatching(/^wiki-check: cannot read .*i\.mdx: EACCES$/)]);
  });
});
