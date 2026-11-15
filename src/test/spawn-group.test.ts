import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "./temp-dir.ts";
import { ALLOWLIST, checkCounts, parseCounts, scannedFiles, scanSource, siteMessage, type Site, type SiteKind } from "./spawn-group-scan.ts";

/**
 * A child that may be killed gets its own process group, or the kill reaches
 * only the direct child and its grandchildren keep its pipes open. The scan is
 * `spawn-group-scan.ts`; today's sites sit in `scripts/spawn-group-allowlist.txt`.
 */

const ROOT = path.join(import.meta.dir, "..", "..");
const RP = `import { runProc } from "../utils/run-proc.js";\n`;
const CP = `import { spawn } from "node:child_process";\n`;
const G = `{ processGroup: true }`;

/** [case, source, site kinds in order]. */
const CASES: [string, string, SiteKind[]][] = [
  // runProc
  ["runProc call with processGroup: true", RP + `runProc(c, 5, "x", { quietTimeout: true, processGroup: true });`, []],
  ["x.runProc call with the literal", `x.runProc(c, 5, "x", ${G});`, []],
  ["(deps.runProc ?? runProc) with the literal", `(deps.runProc ?? runProc)(c, 5, "x", ${G});`, []],
  ["(a.runProc || runProc) with the literal", `(a.runProc || runProc)(c, 5, "x", ${G});`, []],
  ["runProc without options", RP + `runProc(c, 5, "x");`, ["runProc"]],
  ["runProc without processGroup", `runProc(c, 5, "x", { quietTimeout: true });`, ["runProc"]],
  ["runProc with processGroup: false", `runProc(c, 5, "x", { processGroup: false });`, ["runProc"]],
  ["runProc with the literal in the third slot", `runProc(c, 5, ${G});`, ["runProc"]],
  ["runProc with the literal in a fifth slot", `runProc(c, 5, "x", {}, ${G});`, ["runProc"]],
  ["runProc with a spread argument", `runProc(cmd, 1000, ...extra, ${G});`, ["runProc"]],
  ["runProc, spread after processGroup", `runProc(c, 5, "x", { processGroup: true, ...o });`, ["spread"]],
  ["runProc, spread before processGroup", `runProc(c, 5, "x", { ...o, processGroup: true });`, []],
  ["runProc as a value", RP + `const run = opts.run ?? runProc;`, ["value"]],
  ["runProc in an object shorthand", `const deps = { runProc };`, ["value"]],
  ["runProc passed as an argument", `use(runProc);`, ["value"]],
  ["runProc renamed in an import", `import { runProc as rp } from "./run-proc.ts";\nrp(c, 5, "x");`, ["value"]],
  ["a name renamed to runProc", `import { other as runProc } from "./o.ts";`, ["value"]],
  ["runProc renamed in an export", `export { runProc as rp } from "./run-proc.ts";`, ["value"]],
  ["barrel re-export keeping the name", `export { runProc } from "../utils/run-proc.ts";`, []],
  ["caller importing from the barrel", `import { runProc } from "./barrel.ts";\nrunProc(c, 5, "x");`, ["runProc"]],
  ["rp[\"runProc\"](…)", `rp["runProc"](c, 5, "x", ${G});`, ["value"]],
  ["import rp = require(…), then rp.runProc", `import rp = require("../utils/run-proc.js");\nrp.runProc(c, 5, "x");`, ["runProc"]],
  ["const { runProc } = import(…)", `const { runProc } = import("../utils/run-proc.js");\nrunProc(c, 5, "x", ${G});`, ["value"]],
  ["(Bun.spawn ?? runProc)(…)", `(Bun.spawn ?? runProc)(c, 5, "x", ${G});`, ["value", "value"]],
  ["(x ?? runProc) with a non-runProc operand", `(x ?? runProc)(c, 5, "x", ${G});`, ["value"]],
  ["(a.runProc && runProc) is not ?? or ||", `(a.runProc && runProc)(c, 5, "x", ${G});`, ["value", "value"]],
  ["((a ?? b)) nested parens", `((a.runProc ?? runProc))(c, 5, "x", ${G});`, ["value", "value"]],
  ["runProc as the object of .call", `runProc.call(null, c, 5, "x", ${G});`, ["value"]],
  ["typeof runProc in a type", RP + `type R = typeof runProc;\ninterface D { run?: typeof runProc }`, []],
  ["a runProc function declaration", `function runProc() {}`, []],
  ["a runProc parameter, method and property", `class A { runProc = 1; runProc2(runProc: number) {} }\nconst o = { runProc: f };`, []],
  ["class extends a runProc call is a value", `class A extends mixin(runProc) {}`, ["value"]],

  // spawn
  ["Bun.spawn with detached: true", `Bun.spawn(["git"], { stdout: "pipe", detached: true });`, []],
  ["Bun.spawn single-object form", `Bun.spawn({ cmd: ["git"], detached: true });`, []],
  ["child_process spawn with detached: true", CP + `spawn("git", ["x"], { detached: true });`, []],
  ["anything.spawn with detached: true", `pool.spawn(["git"], { detached: true });`, []],
  ["Bun.spawn without options", `Bun.spawn(["git"]);`, ["spawn"]],
  ["Bun.spawn without detached", `Bun.spawn(["git"], { stdout: "pipe" });`, ["spawn"]],
  ["Bun.spawn, detached not in the last argument", `Bun.spawn({ detached: true }, ["git"]);`, ["spawn"]],
  ["Bun.spawn, spread argument", `Bun.spawn(...args, { detached: true });`, ["spawn"]],
  ["Bun.spawn, spread after detached", `Bun.spawn(["git"], { detached: true, ...o });`, ["spread"]],
  ["globalThis.Bun.spawn", `globalThis.Bun.spawn(["git"]);`, ["spawn"]],
  ["const B = globalThis.Bun; B.spawn", `const B = globalThis.Bun;\nB.spawn(["git"]);`, ["spawn"]],
  ["import { spawn } from bun", `import { spawn } from "bun";\nspawn(["git"]);`, ["spawn"]],
  ["const { spawn } = import(\"bun\")", `const { spawn } = import("bun");\nspawn(["git"], { detached: true });`, ["value"]],
  ["require(…).spawn", `require("node:child_process").spawn("git", [], { detached: true });`, ["module"]],
  ["child_process spawn without detached", CP + `spawn("git", ["x"], { stdio: "pipe" });`, ["spawn"]],
  ["Bun[\"spawn\"](…)", `Bun["spawn"](["git"], { detached: true });`, ["value"]],
  ["Bun.spawn as a value", `const sp = Bun.spawn;`, ["value"]],
  ["an unrelated pool.spawn is flagged too", `pool.spawn(["git"]);`, ["spawn"]],
  ["a string that is exactly spawn", `const reason = "spawn";`, ["value"]],
  ["a string literal type is a type", `type R = "spawn" | "x";`, []],

  // child_process
  ["named spawn import", CP, []],
  ["*Sync imports", `import { spawnSync, execFileSync, execSync } from "node:child_process";\nexecSync("ls");`, []],
  ["type-only import", `import type { ChildProcess } from "child_process";\nlet c: ChildProcess;`, []],
  ["type-only specifier", `import { type ChildProcess, spawn } from "child_process";`, []],
  ["typeof import(…) in a type", `let c: typeof import("node:child_process");`, []],
  ["execFile import", `import { execFile } from "node:child_process";\nexecFile("git", ["x"], { detached: true }, cb);`, ["module"]],
  ["exec import", `import { exec } from "child_process";`, ["module"]],
  ["fork import", `import { fork } from "child_process";`, ["module"]],
  ["one site per bad specifier", `import { exec, spawn, fork } from "child_process";`, ["module", "module"]],
  ["renamed spawn import is one site", `import { spawn as sp } from "node:child_process";\nsp("git");`, ["module"]],
  ["renamed Sync import", `import { execSync as es } from "node:child_process";`, ["module"]],
  ["default import", `import cp from "node:child_process";`, ["module"]],
  ["namespace import", `import * as cp from "node:child_process";\ncp.execFileSync("git");`, ["module"]],
  ["default plus named import", `import cp, { spawn } from "node:child_process";`, ["module"]],
  ["bare import", `import "child_process";`, ["module"]],
  ["empty named import", `import {} from "child_process";`, ["module"]],
  ["export-from", `export { spawn } from "node:child_process";`, ["module"]],
  ["require", `const cp = require("child_process");`, ["module"]],
  ["dynamic import", `const cp = import("node:child_process");`, ["module"]],
  ["any other mention", `const m = "child_process";`, ["module"]],

  // the same-file const
  ["top-level const options", `const PROC_GROUP = ${G} as const;\nrunProc(c, 5, "x", PROC_GROUP);\nrunProc(c, 9, "y", PROC_GROUP);`, []],
  ["top-level const without as const", `const O = { detached: true };\nBun.spawn(["git"], O);`, []],
  ["const holding the wrong key for its call", `const O = { detached: true };\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["exported const", `export const O = ${G};\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["let options", `let O = ${G};\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["const inside a function", `function f() { const O = ${G};\nreturn runProc(c, 5, "x", O); }`, ["runProc"]],
  ["const declared twice (shadowed)", `const O = ${G};\nfunction f() { const O = {};\nreturn runProc(c, 5, "x", O); }\nrunProc(c, 5, "x", O);`, ["runProc", "runProc"]],
  ["const shadowed by a parameter", `const O = ${G};\nfunction f(O) {}\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["mutated const", `const O = ${G};\nO.processGroup = false;\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["const passed to Object.assign", `const O = ${G};\nObject.assign(O, x);\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["const passed elsewhere", `const O = ${G};\nuse(O);\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["const in the wrong argument slot", `const O = ${G};\nrunProc(c, 5, O, O);`, ["runProc"]],
  ["const not an object literal", `const O = make();\nrunProc(c, 5, "x", O);`, ["runProc"]],

  // fail closed on the literal
  ["shorthand detached", `const detached = true;\nBun.spawn(["git"], { detached });`, ["spawn"]],
  ["detached from a variable", `Bun.spawn(["git"], { detached: flag });`, ["spawn"]],
  ["detached: true as boolean", `Bun.spawn(["git"], { detached: true as boolean });`, ["spawn"]],
  ["quoted key", `Bun.spawn(["git"], { "detached": true });`, ["spawn"]],
  ["computed key", `Bun.spawn(["git"], { ["detached"]: true });`, ["spawn"]],
  ["computed key after detached", `Bun.spawn(["git"], { detached: true, [k]: 1 });`, ["spawn"]],
  ["quoted key after detached", `Bun.spawn(["git"], { detached: true, "detached": false });`, ["spawn"]],
  ["nested key", `Bun.spawn(["git"], { env: { detached: true } });`, ["spawn"]],
  ["conditional spread", `Bun.spawn(["git"], { ...(t ? { detached: true } : {}) });`, ["spawn"]],
  ["options in a variable", `const o = mk();\nBun.spawn(["git"], o);`, ["spawn"]],
  ["detached: true then false", `Bun.spawn(["git"], { detached: true, detached: false });`, ["spawn"]],
  ["detached: true after a spread after detached", `Bun.spawn(["git"], { detached: true, ...o, detached: true });`, []],

  // not code
  ["line comment", `// Bun.spawn(["git"])`, []],
  ["block comment", `/* runProc(c) */`, []],
  ["string containing a call", `const s = 'Bun.spawn(["git"])';`, []],
  ["template literal text", "const s = `Bun.spawn([${x}]) runProc`;", []],
  ["after a regex literal", "function f(v) { return /^[-?&*!|>%@`[\\]{},]/.test(v) }\nconst s = `Bun.spawn(`;", []],
  ["regex literal then a real spawn", "const r = /`/;\nBun.spawn([\"git\"]);", ["spawn"]],
  ["file without semicolons", `const a = 1\nBun.spawn(["git"], { detached: true })\nBun.spawn(["git"])\n`, ["spawn"]],
  ["respawn is another name", `respawn(["git"]);`, []],
  ["a syntax error reports the file", `Bun.spawn(["git"], { detached: true );`, ["parse"]],
];

describe("spawn group scan", () => {
  for (const [name, source, want] of CASES) {
    test(`${want.length ? "flags" : "passes"}: ${name}`, () => {
      expect(scanSource("src/x.ts", source).map((s) => s.kind)).toEqual(want);
    });
  }

  test("reports the line of the name, in source order", () => {
    expect(scanSource("src/x.ts", `const x = 1;\nconst p = Bun.spawn(\n  ["git"],\n  {},\n);`).map((s) => s.line)).toEqual([2]);
    expect(scanSource("src/x.ts", `Bun.spawn(["a"]);\n\nimport { exec } from "child_process";\nBun.spawn(["b"]);`).map((s) => `${s.kind}:${s.line}`))
      .toEqual(["spawn:1", "module:3", "spawn:4"]);
  });

  test("parses by extension: JSX text is not code, and a .ts file with JSX has parse errors", () => {
    expect(scanSource("src/x.tsx", `const e = <p>Bun.spawn(["git"])</p>;`)).toEqual([]);
    expect(scanSource("src/x.jsx", `const e = <p>Bun.spawn(["git"])</p>;\nBun.spawn(["git"]);`).map((s) => s.kind)).toEqual(["spawn"]);
    expect(scanSource("src/x.mjs", `Bun.spawn(["git"]);`).map((s) => s.kind)).toEqual(["spawn"]);
    expect(scanSource("src/x.ts", `const e = <p>x</p>;`).map((s) => s.kind)).toEqual(["parse"]);
  });

  const msg = (source: string) => siteMessage(scanSource("src/a.ts", source)[0]!);
  const HARM = "a kill (timeout, abort, `.kill()`) reaches only the direct child: grandchildren survive it, and a caller reading the child's pipes waits for them";
  const WAY_OUT = `add or raise \`<path> <count>\` in ${ALLOWLIST} and say why in the PR`;

  test("spawn message: harm, runProc first, then detached with its own -pid kill, and the way out", () => {
    const m = msg(`\nBun.spawn(["git"]);`);
    expect(m).toStartWith("src/a.ts:2 `Bun.spawn(…)`: no top-level `detached: true` in its last argument");
    for (const s of [HARM, "Use `runProc(…, { processGroup: true })`", "shutdown and Ctrl-C reach it", "its own kill of `-proc.pid` and its own exit handling", WAY_OUT]) expect(m).toContain(s);
    expect(m.indexOf("runProc(…, { processGroup")).toBeLessThan(m.indexOf("detached: true` is the alternative"));
  });

  test("runProc message names the fourth argument and processGroup, not detached", () => {
    const m = msg(`runProc(c, 5, "x");`);
    for (const s of ["no top-level `processGroup: true` in its options (fourth) argument", HARM, "Pass `{ processGroup: true }`", WAY_OUT]) expect(m).toContain(s);
    expect(m).not.toContain("detached");
  });

  test("spread message says to move the spread before the key", () => {
    const m = msg(`Bun.spawn(["git"], { detached: true, ...o });`);
    for (const s of ["a spread follows", "Move the spread before the key.", HARM, WAY_OUT]) expect(m).toContain(s);
  });

  test("value message says to call it directly or list the line", () => {
    const m = msg(`const run = opts.run ?? runProc;`);
    for (const s of ["`runProc` used as a value", "Call it directly with the literal, or list the line.", HARM, WAY_OUT]) expect(m).toContain(s);
  });

  test("module message says exec/execFile ignore detached and to use spawn or runProc", () => {
    const m = msg(`import { execFile } from "node:child_process";`);
    for (const s of ["`execFile` imported from \"node:child_process\"", "`exec` and `execFile` ignore `detached`", "Use `spawn` or `runProc`.", HARM, WAY_OUT]) expect(m).toContain(s);
  });

  test("parse message says to fix the syntax and offers no allowlist way out", () => {
    const m = msg(`Bun.spawn(;`);
    expect(m).toBe("src/a.ts:1 TypeScript parse errors: the scan does not trust a tree recovered from a syntax error. Fix the syntax.");
  });
});

describe("scannedFiles on a synthetic tree", () => {
  const root = testTempDirSync(path.join(tmpdir(), "spawn-group-tree-"));
  const put = (rel: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), "");
  };
  for (const f of [
    "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts", "src/e.js", "src/f.jsx", "src/g.mjs", "src/h.cjs",
    "src/a.test.ts", "src/i.spec.ts", "src/j_test.ts", "src/k.d.ts", "src/l.md", "src/utils/run-proc.ts",
    "src/node_modules/x.ts", "src/.hidden/y.ts", "scripts/s.ts", "db/m.ts", "e2e/w.ts", "other/o.ts",
  ]) put(f);

  test("non-test TS/JS under src/, scripts/ and db/, minus run-proc.ts", () => {
    expect(scannedFiles(root)).toEqual([
      "db/m.ts", "scripts/s.ts", "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts", "src/e.js", "src/f.jsx", "src/g.mjs", "src/h.cjs",
    ]);
  });
});

describe("allowlist rules", () => {
  const site = (p: string, line: number): Site => ({ path: p, line, kind: "spawn", what: "`Bun.spawn(…)`" });

  test("parse: comments and blanks skipped; malformed, zero, duplicate and out-of-order lines reported", () => {
    const { counts, format } = parseCounts(["# header", "", "src/a.ts 2", "src/b.ts 0", "src/b.ts", "src/c.ts 1", "src/c.ts 3", "src/a2.ts 1", "src/z.ts x"].join("\n"));
    expect([...counts]).toEqual([["src/a.ts", 2], ["src/c.ts", 1], ["src/a2.ts", 1]]);
    expect(format).toEqual([
      `malformed (want "<path> <count>", count 1 or more): src/b.ts 0`,
      `malformed (want "<path> <count>", count 1 or more): src/b.ts`,
      "duplicate entry: src/c.ts",
      "out of order: src/a2.ts after src/c.ts",
      `malformed (want "<path> <count>", count 1 or more): src/z.ts x`,
    ]);
  });

  test("an unlisted file fails with each of its sites", () => {
    const { over, stale } = checkCounts([site("src/new.ts", 4), site("src/new.ts", 9)], new Map());
    expect(stale).toEqual([]);
    expect(over).toHaveLength(1);
    const [head, a, b] = over[0]!.split("\n");
    expect(head).toBe(`src/new.ts: 2 site(s), not listed in ${ALLOWLIST}`);
    expect(a).toStartWith("  src/new.ts:4 `Bun.spawn(…)`: no top-level `detached: true`");
    expect(b).toStartWith("  src/new.ts:9 ");
  });

  test("a count below the live sites lists the file's sites and says one is new", () => {
    const { over } = checkCounts([site("src/a.ts", 3), site("src/a.ts", 9)], new Map([["src/a.ts", 1]]));
    expect(over[0]!.split("\n")[0]).toBe("src/a.ts: 2 sites, listed 1: one of them is new (the list is keyed by file and count, so it cannot say which)");
    expect(over[0]!.split("\n")).toHaveLength(3);
  });

  test("a count above the live sites is stale: lower it, or remove the line at zero or for a missing file", () => {
    const r = checkCounts([site("src/a.ts", 3)], new Map([["src/a.ts", 2], ["src/gone.ts", 1]]));
    expect(r.over).toEqual([]);
    expect(r.stale).toEqual([
      `src/a.ts: listed 2, live 1: lower the count to 1 in ${ALLOWLIST}`,
      `src/gone.ts: listed 1, no sites left: remove the line from ${ALLOWLIST}`,
    ]);
  });

  test("exact counts pass", () => {
    expect(checkCounts([site("src/a.ts", 1), site("src/a.ts", 2)], new Map([["src/a.ts", 2]]))).toEqual({ over: [], stale: [] });
  });
});

describe("the live tree", () => {
  const files = scannedFiles(ROOT);
  const sites = files.flatMap((f) => scanSource(f, readFileSync(path.join(ROOT, f), "utf8")));
  const { counts, format } = parseCounts(readFileSync(path.join(ROOT, ALLOWLIST), "utf8"));
  const check = checkCounts(sites, counts);

  test("scans src/, scripts/ and db/, not run-proc.ts", () => {
    for (const top of ["src/", "scripts/", "db/"]) expect(files.some((f) => f.startsWith(top))).toBe(true);
    expect(files).not.toContain("src/utils/run-proc.ts");
    expect(files).toContain("src/test/spawn-group-scan.ts");
  });

  test("no spawn site without a process group beyond scripts/spawn-group-allowlist.txt", () => {
    expect(check.over).toEqual([]);
  });

  test("no stale allowlist counts: a fixed site lowers its count", () => {
    expect(check.stale).toEqual([]);
  });

  test("the allowlist is well-formed, sorted and has no duplicates", () => {
    expect(format).toEqual([]);
  });
});
