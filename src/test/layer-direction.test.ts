import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "./temp-dir.ts";
import { baseCheckVerdict, readBaseAllowlist, type GitRun } from "./layer-allowlist.ts";
import {
  checkAllowlist,
  countByLayerPair,
  edgeLine,
  importEdges,
  importSpecifiers,
  layerOf,
  parseAllowlist,
  resolveSpecifier,
  rewriteAllowlist,
  shrinkAllowlist,
  sourceFiles,
  violations,
  type Layer,
} from "./layers.ts";

const ROOT = path.join(import.meta.dir, "..", "..");
const ALLOWLIST = path.join(ROOT, "scripts", "layer-allowlist.txt");

describe("the live tree", () => {
  const files = sourceFiles(ROOT);
  const current = violations(importEdges(ROOT, files)).map(edgeLine);
  const listed = parseAllowlist(readFileSync(ALLOWLIST, "utf8"));
  const check = checkAllowlist(listed, current);

  test("every non-test source file is in a layer (classify a new directory in src/test/layers.ts)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.filter((f) => layerOf(f) === null)).toEqual([]);
  });

  test("no upward import outside scripts/layer-allowlist.txt", () => {
    expect(check.unlisted).toEqual([]);
  });

  test("no stale entries: a fixed edge leaves the list (bun scripts/layer-ratchet.ts --update); CI's layer-ratchet job fails a PR whose list grows", () => {
    expect(check.stale).toEqual([]);
  });

  test("the allowlist is sorted and has no duplicates", () => {
    expect(check.format).toEqual([]);
  });
});

describe("sourceFiles and importEdges on a synthetic tree", () => {
  const root = testTempDirSync(path.join(tmpdir(), "layer-tree-"));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  put("src/a.ts", `import { b } from "../db/b.ts";\nimport type { B } from "../db/b.ts";\nexport * from "../db/b.ts";\n`);
  put("src/a.test.ts", `import { a } from "./a.ts";\n`);
  put("db/b.ts", `export const b = 1;\n`);
  put("scripts/c.ts", `export const c = 1;\n`);

  test("scans non-test .ts files under both src/ and db/, nothing else", () => {
    expect(sourceFiles(root)).toEqual(["db/b.ts", "src/a.ts"]);
  });
  test("one edge per (importer, target), however many times it is imported", () => {
    expect(importEdges(root)).toEqual([{ from: "src/a.ts", to: "db/b.ts" }]);
  });
});

describe("layerOf", () => {
  test("longest prefix wins, a file entry beats its directory", () => {
    expect(layerOf("src/test/test-db-url.ts")).toBe("platform");
    expect(layerOf("src/test/fixtures.ts")).toBe("routes/views");
    expect(layerOf("src/wiki/store.ts")).toBe("wiki-core");
    expect(layerOf("src/web/web-format.ts")).toBe("render");
  });
  test("an unmapped path has no layer", () => {
    expect(layerOf("src/new-thing/x.ts")).toBeNull();
    expect(layerOf("src/config.tsx")).toBeNull();
  });
});

describe("importSpecifiers", () => {
  test("type-only, re-export, side-effect and dynamic imports all count", () => {
    const src = [
      `import type { A } from "./a.ts";`,
      `import { type B } from "./b.ts";`,
      `export * from "./c.ts";`,
      `import "./d.ts";`,
      `// import "./commented.ts";`,
      `const m = await import("./e.ts");`,
      `const n = await import(name);`,
      `const f = require("./f.ts");`,
    ].join("\n");
    expect(importSpecifiers(src).sort()).toEqual(["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts", "./f.ts"]);
  });
});

describe("resolveSpecifier", () => {
  const files = new Set(["src/wiki/store.ts", "src/format/index.ts", "src/web/web-format.ts"]);
  const exists = (f: string) => files.has(f);
  test("relative paths resolve against the importer, with or without .ts", () => {
    expect(resolveSpecifier("src/wiki/lint.ts", "./store.ts", exists)).toBe("src/wiki/store.ts");
    expect(resolveSpecifier("src/wiki/lint.ts", "../web/web-format", exists)).toBe("src/web/web-format.ts");
    expect(resolveSpecifier("src/wiki/lint.ts", "../format", exists)).toBe("src/format/index.ts");
  });
  test("packages and missing or non-.ts targets resolve to null", () => {
    expect(resolveSpecifier("src/wiki/lint.ts", "hono", (f) => f === "src/wiki/hono.ts" || f === "hono.ts")).toBeNull();
    expect(resolveSpecifier("src/wiki/lint.ts", "./nope.ts", exists)).toBeNull();
    expect(resolveSpecifier("src/wiki/lint.ts", "./data.json", (f) => f === "src/wiki/data.json")).toBeNull();
  });
});

describe("violations", () => {
  const layers: Record<string, Layer> = { p: "platform", r: "render", w: "wiki-core", f: "features", v: "routes/views" };
  const layer = (f: string) => layers[f] ?? null;
  test("only edges into a higher layer are violations", () => {
    const edges = [
      { from: "w", to: "v" },
      { from: "w", to: "f" },
      { from: "w", to: "w" },
      { from: "v", to: "p" },
      { from: "f", to: "r" },
      { from: "p", to: "r" },
      { from: "x", to: "v" },
    ];
    expect(violations(edges, layer).map(edgeLine)).toEqual(["w -> v", "w -> f", "p -> r"]);
  });
  test("counts by layer pair, largest first", () => {
    const edges = [
      { from: "p", to: "r" },
      { from: "w", to: "v" },
      { from: "w", to: "v" },
    ];
    expect([...countByLayerPair(edges, layer)]).toEqual([
      ["wiki-core -> routes/views", 2],
      ["platform -> render", 1],
    ]);
  });
});

describe("allowlist", () => {
  test("parse skips comments and blank lines", () => {
    expect(parseAllowlist("# head\n\na -> b\n  c -> d  \n")).toEqual(["a -> b", "c -> d"]);
  });
  test("an unlisted violation, a stale entry, an unsorted pair and a duplicate are each reported", () => {
    const check = checkAllowlist(["a -> b", "c -> d", "c -> d", "b -> a"], ["a -> b", "e -> f"]);
    expect(check.unlisted).toEqual(["e -> f"]);
    expect(check.stale).toEqual(["b -> a", "c -> d"]);
    expect(check.format).toEqual(["duplicate entry: c -> d", "out of order: b -> a after c -> d"]);
  });
  test("a clean list reports nothing", () => {
    expect(checkAllowlist(["a -> b", "c -> d"], ["c -> d", "a -> b"])).toEqual({ unlisted: [], stale: [], format: [] });
  });
  test("shrink removes fixed lines and never adds a new violation", () => {
    expect(shrinkAllowlist(["c -> d", "a -> b", "a -> b", "x -> y"], ["a -> b", "c -> d", "new -> edge"])).toEqual(["a -> b", "c -> d"]);
  });
  test("--update's rewrite drops fixed and duplicate entries, trims them, and adds none", () => {
    expect(rewriteAllowlist("  a -> b \na -> b\nc -> d\nx -> y\n", ["a -> b", "c -> d", "new -> edge"])).toBe("a -> b\nc -> d\n");
  });
  test("--update's rewrite keeps an indented comment, as the parser treats it as one", () => {
    expect(rewriteAllowlist("# head\n  # indented note\na -> b\nx -> y\n", ["a -> b"])).toBe("# head\n  # indented note\na -> b\n");
  });
  test("--update's rewrite keeps mid-list comments and blank lines where they are", () => {
    expect(rewriteAllowlist("# head\n\na -> b\n# group two\nc -> d\nx -> y\n", ["a -> b", "c -> d"])).toBe("# head\n\na -> b\n# group two\nc -> d\n");
  });
});

describe("--check-base: the list's entry count may not grow over the base", () => {
  const rel = "scripts/layer-allowlist.txt";
  const base = { kind: "text", text: "# head\na -> b\nc -> d\n" } as const;
  const verdict = (head: string) => baseCheckVerdict("BASE", rel, base, head);

  test("one more entry: exit 1, with the count and the added edge", () => {
    const v = verdict("# head\na -> b\nc -> d\ne -> f\n");
    expect(v.code).toBe(1);
    expect(v.lines.join("\n")).toContain("2 -> 3 entries");
    expect(v.lines).toContain("  added: e -> f");
  });
  test("a rename or move at the same count: exit 0, the lines shown as information", () => {
    const v = verdict("# head\na -> b\nc2 -> d\n");
    expect(v.code).toBe(0);
    expect(v.lines).toContain("  added: c2 -> d");
    expect(v.lines).toContain("  removed: c -> d");
  });
  test("fewer entries, some of them new: exit 0", () => {
    expect(verdict("# head\nx -> y\n").code).toBe(0);
  });
  test("comments, blank lines and indentation are not entries", () => {
    const v = verdict("# new header\n\n# more\na -> b\n  c -> d  \n");
    expect(v.code).toBe(0);
    expect(v.lines.filter((l) => l.startsWith("  "))).toEqual([]);
  });
  test("a base without the list: exit 0", () => {
    expect(baseCheckVerdict("BASE", rel, { kind: "no-file" }, "a -> b\n").code).toBe(0);
  });
  test("a ref that is not a commit: exit 2", () => {
    expect(baseCheckVerdict("BASE", rel, { kind: "bad-ref" }, "a -> b\n").code).toBe(2);
  });
});

describe("readBaseAllowlist maps git's answers", () => {
  const git =
    (revParse: number, show: number): GitRun =>
    (args) =>
      args[0] === "rev-parse" ? { exitCode: revParse, stdout: "" } : { exitCode: show, stdout: show === 0 ? "a -> b\n" : "" };
  test("rev-parse fails: bad-ref; show fails: no-file; else the text", () => {
    expect(readBaseAllowlist("R", "x.txt", git(1, 0))).toEqual({ kind: "bad-ref" });
    expect(readBaseAllowlist("R", "x.txt", git(0, 128))).toEqual({ kind: "no-file" });
    expect(readBaseAllowlist("R", "x.txt", git(0, 0))).toEqual({ kind: "text", text: "a -> b\n" });
  });
  test("asks for the ref as a commit and for the file at that ref", () => {
    const calls: string[][] = [];
    readBaseAllowlist("R", "x.txt", (a) => {
      calls.push(a);
      return { exitCode: 0, stdout: "" };
    });
    expect(calls).toEqual([
      ["rev-parse", "--verify", "--quiet", "R^{commit}"],
      ["show", "R:x.txt"],
    ]);
  });
});
