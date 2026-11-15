import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "./temp-dir.ts";
import {
  allowlistLines,
  checkSites,
  parseCountAllowlist,
  scannedFiles,
  scanSource,
  siteMessage,
  type Site,
} from "./spawn-group-scan.ts";

/**
 * A child that may be killed gets its own process group, or the kill reaches
 * only the direct child and its grandchildren keep the pipes open. Today's
 * sites sit in `scripts/spawn-group-allowlist.txt`; the scan is
 * `src/test/spawn-group-scan.ts`.
 */

const ROOT = path.join(import.meta.dir, "..", "..");
const ALLOWLIST = path.join(ROOT, "scripts", "spawn-group-allowlist.txt");

const CP = `import { spawn, execFile, exec, fork } from "node:child_process";\n`;
const RP = `import { runProc } from "../utils/run-proc.ts";\n`;

/** [case, source, expected `kind form` per site]. */
const CASES: [string, string, string[]][] = [
  // flagged calls
  ["Bun.spawn, no options", `Bun.spawn(["git"]);`, ["spawn Bun.spawn"]],
  ["Bun.spawn, options without detached", `Bun.spawn(["git"], { stdout: "pipe" });`, ["spawn Bun.spawn"]],
  ["Bun.spawn object form without detached", `Bun.spawn({ cmd: ["git"], stdout: "pipe" });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, options in a variable", `const o = mk();\nBun.spawn(["git"], o);`, ["spawn Bun.spawn"]],
  ["Bun.spawn, spread after detached", `Bun.spawn(["git"], { detached: true, ...o });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, spread instead of detached", `Bun.spawn(["git"], { ...o });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, conditional spread", `Bun.spawn(["git"], { ...(t ? { detached: true } : {}) });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, detached: false", `Bun.spawn(["git"], { detached: false });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, detached: true then false", `Bun.spawn(["git"], { detached: true, detached: false });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, detached: true then a quoted key", `Bun.spawn(["git"], { detached: true, "detached": false });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, detached: true then shorthand", `Bun.spawn(["git"], { detached: true, detached });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, shorthand detached", `const detached = true;\nBun.spawn(["git"], { detached });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, quoted key", `Bun.spawn(["git"], { "detached": true });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, computed key", `Bun.spawn(["git"], { ["detached"]: true });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, nested detached", `Bun.spawn(["git"], { env: { detached: true } });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, detached from a variable", `Bun.spawn(["git"], { detached: flag });`, ["spawn Bun.spawn"]],
  ["Bun.spawn, a let options object", `let O = { detached: true };\nBun.spawn(["git"], O);`, ["spawn Bun.spawn"]],
  ["globalThis.Bun.spawn", `globalThis.Bun.spawn(["git"]);`, ["spawn Bun.spawn"]],
  ["node spawn", CP + `spawn("git", ["x"], { stdio: "pipe" });`, ["spawn child_process.spawn"]],
  ["node execFile with a callback", CP + `execFile("git", ["x"], (e) => {});`, ["spawn child_process.execFile"]],
  ["node exec", CP + `exec("ls", { timeout: 5 }, cb);`, ["spawn child_process.exec"]],
  ["node fork", CP + `fork("w.js");`, ["spawn child_process.fork"]],
  ["node alias import", `import { spawn as sp } from "child_process";\nsp("git");`, ["spawn child_process.spawn"]],
  ["node namespace import", `import * as cp from "node:child_process";\ncp.spawn("git", [], {});`, ["spawn child_process.spawn"]],
  ["node default import", `import cp from "node:child_process";\ncp.execFile("git");`, ["spawn child_process.execFile"]],
  ["runProc without options", RP + `await runProc(["git"], 5, "x");`, ["runProc runProc"]],
  ["runProc without processGroup", RP + `await runProc(["git"], 5, "x", { quietTimeout: true });`, ["runProc runProc"]],
  ["runProc processGroup: false", RP + `await runProc(["git"], 5, "x", { processGroup: false });`, ["runProc runProc"]],
  ["runProc, spread after processGroup", RP + `await runProc(["git"], 5, "x", { processGroup: true, ...o });`, ["runProc runProc"]],
  ["runProc through ??", RP + `await (deps.run ?? runProc)(["git"], 5, "x", {});`, ["runProc runProc"]],
  ["runProc alias", `import { runProc as rp } from "./run-proc.ts";\nawait rp(["git"], 5, "x");`, ["runProc runProc"]],
  ["runProc namespace", `import * as R from "../utils/run-proc.ts";\nawait R.runProc(["git"], 5, "x");`, ["runProc runProc"]],
  ["sites in line order", CP + `spawn("git");\nexport * from "child_process";`, ["spawn child_process.spawn", `reference re-export from "child_process"`]],
  ["multi-line call reports the call's line", `const x = 1;\nconst p = Bun.spawn(\n  ["git"],\n  { stdout: "pipe" },\n);`, ["spawn Bun.spawn"]],

  // fail closed: references the scan cannot resolve
  ["Bun.spawn as a value", `const sp = Bun.spawn;\nsp(["git"], { detached: true });`, ["reference Bun.spawn used as a value"]],
  ["Bun.spawn parenthesized callee", `(Bun.spawn)(["git"], { detached: true });`, ["reference Bun.spawn used as a value"]],
  ["spawn destructured from Bun", `const { spawn } = Bun;`, ["reference spawn destructured from Bun"]],
  ["rest destructured from Bun", `const { ...b } = Bun;`, ["reference spawn destructured from Bun"]],
  ["Bun['spawn']", `Bun["spawn"](["git"], { detached: true });`, ["reference Bun[...] element access"]],
  ["Bun[key]", `Bun[k](["git"]);`, ["reference Bun[...] element access"]],
  ["Bun as a value", `const B = Bun;\nB.spawn(["git"]);`, ["reference Bun used as a value"]],
  ["import { spawn } from bun", `import { spawn } from "bun";\nspawn(["git"], { detached: true });`, [`reference import { spawn } from "bun"`]],
  ["bun namespace import", `import * as B from "bun";\nB.spawn(["git"]);`, ["spawn Bun.spawn"]],
  ["promisify(execFile)", `import { promisify } from "node:util";\n` + CP + `const run = promisify(execFile);`, ["reference execFile (child_process) used as a value"]],
  ["re-export of a binding", CP + `export { spawn };`, ["reference spawn (child_process) used as a value"]],
  ["re-export from child_process", `export { spawn } from "node:child_process";`, [`reference re-export from "node:child_process"`]],
  ["export * from child_process", `export * from "child_process";`, [`reference re-export from "child_process"`]],
  ["binding passed as an argument", CP + `use(fork);`, ["reference fork (child_process) used as a value"]],
  ["binding in an object shorthand", CP + `const deps = { spawn };`, ["reference spawn (child_process) used as a value"]],
  ["require(child_process)", `const cp = require("node:child_process");`, [`reference require("node:child_process")`]],
  ["import = require", `import cp = require("child_process");`, [`reference import = require("child_process")`]],
  ["dynamic import", `const cp = await import("node:child_process");`, [`reference import("node:child_process")`]],
  ["namespace member not called", `import * as cp from "node:child_process";\nconst f = cp.execFile;`, ["reference cp.execFile (child_process) used as a value"]],
  ["namespace passed whole", `import * as cp from "node:child_process";\nuse(cp);`, ["reference cp (child_process) used as a value"]],
  ["namespace element access", `import * as cp from "node:child_process";\ncp["spawn"]("git");`, ["reference cp[...] (child_process)"]],
  ["runProc as a value", RP + `const run = opts.run ?? runProc;`, ["reference runProc used as a value"]],

  // passing forms
  ["Bun.spawn with detached: true", `Bun.spawn(["git"], { stdout: "pipe", detached: true });`, []],
  ["Bun.spawn object form with detached: true", `Bun.spawn({ cmd: ["git"], detached: true });`, []],
  ["Bun.spawn, spread before detached", `Bun.spawn(["git"], { ...o, detached: true });`, []],
  ["Bun.spawn, same-file const options", `const O = { detached: true } as const;\nBun.spawn(["git"], O);`, []],
  ["node spawn with detached: true", CP + `spawn("git", args, { detached: true });`, []],
  ["node spawn(cmd, options) with detached: true", CP + `spawn("git", { detached: true });`, []],
  ["node execFile with detached: true and a callback", CP + `execFile("git", ["x"], { detached: true }, cb);`, []],
  ["runProc with processGroup: true", RP + `await runProc(["git"], 5, "x", { quietTimeout: true, processGroup: true });`, []],
  ["runProc through ?? with processGroup", RP + `await (deps.runProc ?? runProc)(["git"], 5, "x", { processGroup: true });`, []],
  ["runProc, same-file const options", RP + `const G = { processGroup: true } as const;\nawait runProc(["git"], 5, "x", G);`, []],
  ["typeof runProc in a type", RP + `type R = typeof runProc;\ninterface D { run?: typeof runProc }`, []],
  ["Bun.spawnSync", `Bun.spawnSync(["git"], { timeout: 300 });`, []],
  ["node *Sync forms", `import { spawnSync, execFileSync, execSync } from "node:child_process";\nspawnSync("git");\nexecFileSync("git");\nexecSync("ls");`, []],
  ["node namespace *Sync", `import * as cp from "node:child_process";\ncp.execFileSync("git");`, []],
  ["type-only child_process import", `import type { ChildProcess } from "node:child_process";\nlet c: ChildProcess;`, []],
  ["type-only import of a spawner, re-exported as a type", `import type { spawn } from "node:child_process";\nexport type { spawn };`, []],
  ["obj.spawn( is not a spawner", `pool.spawn(["git"]);\nthis.spawn();`, []],
  ["respawn( is not a spawner", `respawn(["git"]);`, []],
  ["unimported spawn( is not a spawner", `spawn("git");`, []],
  ["other Bun members", `Bun.file("x");\nconst { file } = Bun;\nBun["file"]("x");`, []],
  ["line comment", `// Bun.spawn(["git"])`, []],
  ["block comment", `/* Bun.spawn(["git"]) */`, []],
  ["string", `const s = 'Bun.spawn(["git"])';`, []],
  ["template literal", "const s = `Bun.spawn([${x}])`;", []],
  ["after a regex literal", "function f(v) { return /^[-?&*!|>%@`[\\]{},]/.test(v) }\nconst s = `Bun.spawn(`;", []],
  ["regex literal then a real spawn", "const r = /`/;\nBun.spawn([\"git\"]);", ["spawn Bun.spawn"]],
  ["file without semicolons", `const a = 1\nBun.spawn(["git"], { detached: true })\nBun.spawn(["git"])\n`, ["spawn Bun.spawn"]],
  ["line comment inside import braces", `import {\n  // the spawner\n  spawn,\n} from "node:child_process"\nspawn("git")`, ["spawn child_process.spawn"]],
];

describe("spawn group scan", () => {
  for (const [name, source, want] of CASES) {
    test(`${want.length ? "flags" : "passes"}: ${name}`, () => {
      expect(scanSource("src/x.ts", source).map((s) => `${s.kind} ${s.form}`)).toEqual(want);
    });
  }

  test("reports the line the call starts on", () => {
    expect(scanSource("src/x.ts", `const x = 1;\nconst p = Bun.spawn(\n  ["git"],\n  {},\n);`).map((s) => s.line)).toEqual([2]);
    expect(scanSource("src/x.ts", `import {\n  // c\n  spawn,\n} from "node:child_process"\n\nspawn("git")`).map((s) => s.line)).toEqual([6]);
  });

  test("scans .tsx and .js sources", () => {
    expect(scanSource("src/x.tsx", `const e = <div/>;\nBun.spawn(["git"]);`)).toHaveLength(1);
    // JSX text is not code: read as .ts, this line would parse as a call.
    expect(scanSource("src/x.tsx", `const e = <p>Bun.spawn(["git"])</p>;`)).toEqual([]);
    expect(scanSource("src/x.js", `Bun.spawn(["git"]);`)).toHaveLength(1);
  });

  test("the message names file:line, the form, the condition and the remedy that fits the form", () => {
    const [spawn] = scanSource("src/a.ts", `\nBun.spawn(["git"]);`);
    const [run] = scanSource("src/b.ts", RP + `await runProc(["git"], 5, "x");`);
    const [ref] = scanSource("src/c.ts", `const sp = Bun.spawn;`);
    for (const s of [spawn!, run!, ref!]) {
      expect(siteMessage(s)).toContain("if this code kills the child (timeout, abort, .kill), the kill reaches only the direct child");
    }
    expect(siteMessage(spawn!)).toStartWith("src/a.ts:2 Bun.spawn:");
    expect(siteMessage(spawn!)).toContain("`detached: true` and kill `-proc.pid`");
    expect(siteMessage(run!)).toStartWith("src/b.ts:2 runProc:");
    expect(siteMessage(run!)).toContain("`processGroup: true`");
    expect(siteMessage(run!)).not.toContain("detached");
    expect(siteMessage(ref!)).toStartWith("src/c.ts:1 Bun.spawn used as a value:");
  });
});

describe("scannedFiles on a synthetic tree", () => {
  const root = testTempDirSync(path.join(tmpdir(), "spawn-group-tree-"));
  const put = (rel: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), "");
  };
  for (const f of [
    "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.js", "src/a.test.ts", "src/e.spec.ts", "src/f.d.ts", "src/g.md",
    "src/utils/run-proc.ts", "src/node_modules/x.ts", "src/.hidden/y.ts", "scripts/s.ts", "db/m.ts", "e2e/w.ts", "other/o.ts",
  ]) put(f);

  test("non-test TS/JS under src/, scripts/ and db/, minus run-proc.ts; not e2e/, tests, .d.ts or dot/node_modules dirs", () => {
    expect(scannedFiles(root)).toEqual(["db/m.ts", "scripts/s.ts", "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.js"]);
  });
});

describe("allowlist rules", () => {
  const site = (p: string, line: number): Site => ({ path: p, line, kind: "spawn", form: "Bun.spawn" });

  test("parse: comments and blanks skipped; malformed, zero, duplicate and unsorted lines reported", () => {
    const { counts, format } = parseCountAllowlist(["# header", "", "src/a.ts 2", "src/b.ts 0", "src/b.ts", "src/c.ts 1", "src/c.ts 1", "src/a2.ts 1", "src/z.ts x"].join("\n"));
    expect([...counts]).toEqual([["src/a.ts", 2], ["src/c.ts", 1], ["src/a2.ts", 1]]);
    expect(format).toEqual([
      `malformed (want "<path> <count>", count >= 1): src/b.ts 0`,
      `malformed (want "<path> <count>", count >= 1): src/b.ts`,
      "duplicate: src/c.ts",
      "unsorted: src/a2.ts after src/c.ts",
      `malformed (want "<path> <count>", count >= 1): src/z.ts x`,
    ]);
  });

  test("an unlisted file, or a count below the live sites, fails with every site of that file", () => {
    const sites = [site("src/a.ts", 3), site("src/a.ts", 9), site("src/b.ts", 1)];
    const r = checkSites(sites, new Map([["src/a.ts", 1], ["src/b.ts", 1]]));
    expect(r.unlisted).toHaveLength(2);
    expect(r.unlisted[0]).toStartWith("src/a.ts:3 Bun.spawn:");
    expect(r.unlisted[1]).toStartWith("src/a.ts:9 Bun.spawn:");
    expect(r.unlisted[0]).toEndWith("(src/a.ts: 2 site(s), allowlist allows 1)");
    expect(checkSites([site("src/new.ts", 4)], new Map()).unlisted[0]).toEndWith("(src/new.ts: 1 site(s), allowlist allows 0)");
    expect(r.stale).toEqual([]);
  });

  test("a count above the live sites is stale: lower it, or remove the line at zero", () => {
    const r = checkSites([site("src/a.ts", 3)], new Map([["src/a.ts", 2], ["src/gone.ts", 1]]));
    expect(r.unlisted).toEqual([]);
    expect(r.stale).toEqual([
      "src/a.ts: listed 2, live 1 — lower the count to 1 in scripts/spawn-group-allowlist.txt",
      "src/gone.ts: listed 1, live 0 — remove the line from scripts/spawn-group-allowlist.txt",
    ]);
  });

  test("exact counts pass, and allowlistLines writes them sorted", () => {
    const sites = [site("src/b.ts", 1), site("src/a.ts", 1), site("src/a.ts", 2)];
    expect(allowlistLines(sites)).toEqual(["src/a.ts 2", "src/b.ts 1"]);
    expect(checkSites(sites, parseCountAllowlist(allowlistLines(sites).join("\n")).counts)).toEqual({ unlisted: [], stale: [] });
  });
});

describe("the live tree", () => {
  const files = scannedFiles(ROOT);
  const sites = files.flatMap((f) => scanSource(f, readFileSync(path.join(ROOT, f), "utf8")));
  const { counts, format } = parseCountAllowlist(readFileSync(ALLOWLIST, "utf8"));
  const check = checkSites(sites, counts);

  test("scans src/, scripts/ and db/", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const top of ["src/", "scripts/", "db/"]) expect(files.some((f) => f.startsWith(top))).toBe(true);
    expect(files).not.toContain("src/utils/run-proc.ts");
  });

  test("no spawn without a visible process group outside scripts/spawn-group-allowlist.txt", () => {
    expect(check.unlisted).toEqual([]);
  });

  test("no stale allowlist entries: a fixed site lowers its count", () => {
    expect(check.stale).toEqual([]);
  });

  test("the allowlist is well-formed, sorted and has no duplicates", () => {
    expect(format).toEqual([]);
  });
});
