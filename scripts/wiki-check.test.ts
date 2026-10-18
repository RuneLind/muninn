import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mdxFilesUnder, wikiCheck, wikiRootFor } from "./wiki-check.ts";

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
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("wiki-check", () => {
  test("a directory walks .mdx pages outside blogs/src, node_modules and dot directories", () => {
    expect(mdxFilesUnder(path.join(tmp, "wiki")).map((p) => path.relative(tmp, p))).toEqual([
      "wiki/blogs/d.mdx",
      "wiki/plans/deep/a.mdx",
    ]);
  });

  test("relPath is relative to the nearest .wiki-reader.json, else to the argument", async () => {
    expect(wikiRootFor(path.join(tmp, "wiki/plans/deep"))).toBe(path.join(tmp, "wiki"));
    const sub = await wikiCheck(path.join(tmp, "wiki/plans"));
    expect(sub.map((f) => f.relPath)).toEqual(["plans/deep/a.mdx"]);
    const page = await wikiCheck(path.join(tmp, "wiki/plans/deep/a.mdx"));
    expect(page.map((f) => [f.relPath, f.line])).toEqual([["plans/deep/a.mdx", 4]]);
    expect((await wikiCheck(path.join(tmp, "loose"))).map((f) => f.relPath)).toEqual(["sub/g.mdx"]);
    expect((await wikiCheck(path.join(tmp, "loose/sub/g.mdx"))).map((f) => f.relPath)).toEqual(["g.mdx"]);
  });

  test("runs with no .env, prints only JSON lines and exits 0 with and without findings", async () => {
    const spawn = (arg: string) => {
      const p = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, arg], { cwd: tmp, env: { PATH: process.env.PATH ?? "" } });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const found = spawn(path.join(tmp, "wiki"));
    expect(found.code).toBe(0);
    expect(found.err).toBe("");
    const lines = found.out.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({ check: "component-value", relPath: "blogs/d.mdx", line: 4 }),
      expect.objectContaining({ check: "component-value", relPath: "plans/deep/a.mdx", line: 4 }),
    ]);
    const clean = spawn(path.join(tmp, "clean"));
    expect(clean).toEqual({ code: 0, out: "", err: "" });
    expect(spawn("relative/path").code).toBe(2);
  });
});
