import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "./temp-dir.ts";
import {
  addedAllowlistLines,
  checkAllowlist,
  countByLayerPair,
  edgeLine,
  importEdges,
  importSpecifiers,
  layerOf,
  parseAllowlist,
  resolveSpecifier,
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

  test("no stale entries: a fixed edge leaves the list (bun scripts/layer-ratchet.ts --update); CI's --check-base step fails a PR that adds one", () => {
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
  test("added lines: what the head lists that the base does not, comments and blanks ignored, trimmed", () => {
    const base = "# header\na -> b\nc -> d\n";
    expect(addedAllowlistLines(base, "# header\na -> b\nc -> d\n")).toEqual([]);
    expect(addedAllowlistLines(base, "# new header text\n\na -> b\n")).toEqual([]);
    expect(addedAllowlistLines(base, "a -> b\n  c -> d  \n# x -> y\n")).toEqual([]);
    expect(addedAllowlistLines(base, "a -> b\nb -> z\nc -> d\ne -> f\n")).toEqual(["b -> z", "e -> f"]);
  });
  test("shrink removes fixed lines and never adds a new violation", () => {
    expect(shrinkAllowlist(["c -> d", "a -> b", "a -> b", "x -> y"], ["a -> b", "c -> d", "new -> edge"])).toEqual(["a -> b", "c -> d"]);
  });
});
