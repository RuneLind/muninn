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
  ["a function expression, method and accessors named runProc/spawn", `const f = function runProc() {};\nclass A { runProc() {} get spawn() { return 1; } set spawn(v) {} }`, []],
  ["a type alias named runProc", `type runProc = string;`, []],
  ["type-only import renaming runProc", `import type { runProc as R } from "./run-proc.ts";\nexport type { spawn as S } from "bun";`, []],
  ["an import alias that keeps the name", `import { runProc as runProc } from "./run-proc.ts";`, []],
  ["runProc as the object of x.runProc", `runProc.runProc(c, 5, "x", ${G});`, ["value"]],
  ["runProc as an argument of a grouped runProc call", `runProc(runProc, 5, "x", ${G});`, ["value"]],
  ["class extends a runProc call is a value",`class A extends mixin(runProc) {}`, ["value"]],
  // Both operands of the accepted (a ?? b) / (a || b) callee.
  ["(deps.runProc ?? runProc) without options", `(deps.runProc ?? runProc)(c, 5, "x");`, ["runProc"]],
  ["(deps.runProc || runProc) without options", `(deps.runProc || runProc)(c, 5, "x");`, ["runProc"]],
  ["(deps.runProc || runProc) with the literal", `(deps.runProc || runProc)(c, 5, "x", ${G});`, []],
  ["(runProc ?? deps.runProc) with the literal", `(runProc ?? deps.runProc)(c, 5, "x", ${G});`, []],
  ["(runProc ?? deps.runProc) without options", `(runProc ?? deps.runProc)(c, 5, "x");`, ["runProc"]],
  ["(runProc ?? x) with a non-runProc right operand", `(runProc ?? x)(c, 5, "x", ${G});\n(runProc || x)(c, 5, "x", ${G});`, ["value", "value"]],
  ["(Bun.spawn ?? spawn) is not two runProc names", `(Bun.spawn ?? spawn)(["git"], { detached: true });`, ["value", "value"]],
  ["(a ? runProc : b.runProc) is not ?? or ||", `(a ? runProc : b.runProc)(c, 5, "x", ${G});`, ["value", "value"]],
  ["(a.runProc, runProc) is not ?? or ||", `(a.runProc, runProc)(c, 5, "x", ${G});`, ["value", "value"]],

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

  // A key in a destructuring assignment reads the property: an alias, like a binding element.
  ["({ spawn: s } = Bun)", `let s;\n({ spawn: s } = Bun);\ns(["sleep", "9"]);`, ["value"]],
  ["({ runProc: r } = mod)", `({ runProc: r } = mod);\nr(c, 5, "x");`, ["value"]],
  ["nested ({ a: { spawn: s } } = x)", `({ a: { spawn: s } } = x);`, ["value"]],
  ["({ spawn: s = f } = Bun) with a default", `({ spawn: s = f } = Bun);`, ["value"]],
  ["a nested pattern with a default", `({ a: { spawn: s } = {} } = x);`, ["value"]],
  ["[{ spawn: s }] = xs", `[{ spawn: s }] = xs;`, ["value"]],
  ["[{ spawn: s } = d] = xs", `[{ spawn: s } = d] = xs;`, ["value"]],
  ["[...{ spawn: s }] = xs", `[...{ spawn: s }] = xs;`, ["value"]],
  ["({ a: [{ runProc: r }] } = x)", `({ a: [{ runProc: r }] } = x);`, ["value"]],
  ["for ({ spawn: s } of xs)", `for ({ spawn: s } of xs) s(["git"]);`, ["value"]],
  ["for ({ spawn: s } in x)", `for ({ spawn: s } in x);`, ["value"]],
  ["({ \"spawn\": s } = Bun)", `({ "spawn": s } = Bun);`, ["value"]],
  // Wrapped and rest targets parse (the checker rejects them, the parser does not), so they count too.
  ["(({ spawn: s }) = x) in parentheses", `(({ spawn: s }) = x);`, ["value"]],
  ["({ a: { spawn: s } as T } = x)", `({ a: { spawn: s } as T } = x);`, ["value"]],
  ["({ a: { spawn: s } satisfies T } = x)", `({ a: { spawn: s } satisfies T } = x);`, ["value"]],
  ["({ a: { spawn: s }! } = x)", `({ a: { spawn: s }! } = x);`, ["value"]],
  ["({ a: <T>{ spawn: s } } = x)", `({ a: <T>{ spawn: s } } = x);`, ["value"]],
  ["({ a: { spawn: s }! as any } = x), two wrappers", `({ a: { spawn: s }! as any } = x);`, ["value"]],
  ["({ ...{ spawn: s } } = x)", `({ ...{ spawn: s } } = x);`, ["value"]],
  ["const { spawn: s } = Bun is a binding element", `const { spawn: s } = Bun;`, ["value"]],
  ["({ spawn } = Bun) shorthand", `({ spawn } = Bun);`, ["value"]],
  ["({ spawn = f } = Bun) shorthand with a default", `({ spawn = f } = Bun);`, ["value"]],
  // An object literal that is data keeps its keys as declared names, wherever it sits.
  ["{ spawn: fn } as an argument", `use({ spawn: fn });`, []],
  ["{ spawn: fn } returned", `function f() { return { spawn: fn }; }`, []],
  ["{ spawn: fn } as an initializer", `const o = { spawn: fn, "runProc": g };`, []],
  ["{ spawn: fn } on the right of an assignment", `o = { spawn: fn };`, []],
  ["{ spawn: fn } as a default inside a pattern", `({ a: s = { spawn: f } } = x);\n[t = { runProc: g }] = xs;\n({ b = { spawn: f } } = x);`, []],
  ["{ spawn: fn } as a binding default", `const { a = { spawn: f } } = x;`, []],
  ["runProc as a property value", `const deps = { run: runProc };`, ["value"]],
  ["{ spawn: fn } nested in data", `const o = { a: { spawn: fn }, b: [{ runProc: g }] };`, []],
  ["{ spawn: fn } iterated, not a for target", `for (const k in { spawn: f });\nfor (v of [{ runProc: g }]);`, []],
  ["{ spawn: fn } compared, not assigned", `if ({ spawn: fn } == x) f();`, []],

  // An instantiation expression is a value; only an erased heritage type is a type.
  ["Bun.spawn<…> instantiation", `const sp = Bun.spawn<"pipe", "pipe", "pipe">;\nsp(["sleep", "9"]);`, ["value"]],
  ["runProc<T> instantiation", `const r = runProc<string>;`, ["value"]],
  ["new (Bun.spawn<…>)", `new (Bun.spawn<"pipe">)();`, ["value"]],
  ["(runProc<T>)(…) with the literal", `(runProc<string>)(c, 5, "x", ${G});`, ["value"]],
  ["Bun.spawn<…>(…) with detached is a grouped call", `Bun.spawn<"pipe">(["git"], { detached: true });`, []],
  ["runProc<T>(…) with the literal is a grouped call", `runProc<string>(c, 5, "x", ${G});`, []],
  ["Bun.spawn<…>(…) without detached", `Bun.spawn<"pipe">(["git"]);`, ["spawn"]],
  ["typeof Bun.spawn in a type", `type S = typeof Bun.spawn;\nlet r: typeof runProc<string>;`, []],
  ["implements spawn is a type", `class A implements B, spawn {}`, []],
  ["interface extends runProc is a type", `interface I extends runProc, X.spawn {}`, []],
  ["class extends spawn is a value", `class A extends spawn {}\nconst B = class extends x.runProc {};`, ["value", "value"]],
  ["class extends spawn<T> is a value", `class A extends spawn<string> {}`, ["value"]],
  ["Bun.spawn!, as, satisfies and parens as values", `const a = Bun.spawn!;\nconst b = Bun.spawn as any;\nconst c = (Bun.spawn);\nconst d = Bun.spawn satisfies X;`, ["value", "value", "value", "value"]],
  ["Bun.spawn!, as, satisfies and parens as callees", `Bun.spawn!(["git"], { detached: true });\n(Bun.spawn as any)(["git"], { detached: true });\n(Bun.spawn)(["git"], { detached: true });\n(Bun.spawn satisfies X)(["git"], { detached: true });`, ["value", "value", "value", "value"]],

  // child_process
  ["named spawn import", CP, []],
  ["*Sync imports", `import { spawnSync, execFileSync, execSync } from "node:child_process";\nexecSync("ls");`, []],
  ["type-only import", `import type { ChildProcess } from "child_process";\nlet c: ChildProcess;`, []],
  ["type-only specifier", `import { type ChildProcess, spawn } from "child_process";`, []],
  ["type-only specifier renaming spawn", `import { type spawn as S } from "child_process";`, []],
  ["type-only import with a rename", `import type { SpawnOptions as O } from "node:child_process";`, []],
  ["spawn as spawn keeps the name", `import { spawn as spawn } from "node:child_process";`, []],
  ["typeof import(…) in a type", `let c: typeof import("node:child_process");`, []],
  ["execFile import", `import { execFile } from "node:child_process";\nexecFile("git", ["x"], { detached: true }, cb);`, ["module"]],
  ["exec import", `import { exec } from "child_process";`, ["module"]],
  ["fork import", `import { fork } from "child_process";`, ["module"]],
  ["one site per bad specifier", `import { exec, spawn, fork } from "child_process";`, ["module", "module"]],
  ["renamed spawn import is one site", `import { spawn as sp } from "node:child_process";\nsp("git");`, ["module"]],
  ["a non-Sync name renamed to a Sync name", `import { exec as execSync } from "child_process";`, ["module"]],
  ["renamed Sync import",`import { execSync as es } from "node:child_process";`, ["module"]],
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
  ["const declared twice at top level", `const O = ${G};\nconst O = ${G};\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["const cast to another type", `const O = ${G} as Opts;\nrunProc(c, 5, "x", O);`, ["runProc"]],
  ["const also used in a call through nested parens", `const O = ${G};\n((a.runProc ?? runProc))(c, 5, "x", O);\nrunProc(c, 5, "x", O);`, ["value", "value", "runProc"]],
  ["const not an object literal",`const O = make();\nrunProc(c, 5, "x", O);`, ["runProc"]],

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
    // The module site is found at the import before the renamed name inside it.
    expect(scanSource("src/x.ts", `import cp, {\n  runProc as rp,\n} from "child_process";`).map((s) => `${s.kind}:${s.line}`)).toEqual(["value:2", "module:3"]);
  });

  test("parses by extension: JSX text is not code, and a .ts file with JSX has parse errors", () => {
    expect(scanSource("src/x.tsx", `const e = <p>Bun.spawn(["git"])</p>;`)).toEqual([]);
    expect(scanSource("src/x.jsx", `const e = <p>Bun.spawn(["git"])</p>;\nBun.spawn(["git"]);`).map((s) => s.kind)).toEqual(["spawn"]);
    expect(scanSource("src/x.mjs", `Bun.spawn(["git"]);`).map((s) => s.kind)).toEqual(["spawn"]);
    for (const ext of [".js", ".mjs", ".cjs"]) expect(scanSource(`src/x${ext}`, `const e = <p>Bun.spawn(["git"])</p>;`)).toEqual([]);
    for (const ext of [".ts", ".mts", ".cts"]) expect(scanSource(`src/x${ext}`, `const e = <p>x</p>;`).map((s) => s.kind)).toEqual(["parse"]);
  });

  const msg = (source: string) => siteMessage(scanSource("src/a.ts", source)[0]!);
  const HARM = "reaches only the direct child";
  const WAY_OUT = `If the code is right as it stands (never killed, data and not code, or grouped in a way the scan cannot read), add or raise \`<path> <count>\` in ${ALLOWLIST} and give the reason in the PR.`;
  const ALLOWED = "Import from child_process only `spawn`, names ending in `Sync`, and types, each as a named, un-renamed import";
  const NEED_SPAWN = "The scan reads `detached: true` only in a bare object literal that is the call's last argument, or in a top-level, unexported `const` declared once in the file and used only as such options.";
  const NEED_RP = "The scan reads `processGroup: true` only in a bare object literal that is the call's fourth argument, or in a top-level, unexported `const` declared once in the file and used only as such options.";
  // For a last (or fourth) argument that is no object literal: it may be the command, so the remedy cannot read as "hoist it".
  const NEED_END_SPAWN = "The scan reads the group only from options that end the call: if that argument is the command, add an options literal holding `detached: true` after it; if it is the options, put `detached: true` in a literal there (`{ ...opts, detached: true }`), or in a top-level, unexported `const` holding that literal, declared once in the file and used only as such options.";
  const NEED_END_RP = "The scan reads the group only from runProc's fourth argument: put `processGroup: true` in a literal there (`{ ...opts, processGroup: true }`), or in a top-level, unexported `const` holding that literal, declared once in the file and used only as such options.";
  const FIT_DONE = "For a child that runs to completion, use `runProc(…, { processGroup: true })`";
  const FIT_LONG = "For a long-lived or streaming child, end the `spawn` call with an options literal holding `detached: true`";
  const RP_FIT = "Pass `{ processGroup: true }`: runProc then registers the group so muninn's shutdown and Ctrl-C reach it.";
  const UNREAD_SPAWN = [HARM, FIT_DONE, FIT_LONG, NEED_END_SPAWN];
  const UNREAD_RP = [HARM, RP_FIT, NEED_END_RP];
  const NOT_CALLED = ["not called", "used as a value"];

  /** [form, source, words the message must hold, words it must not]. */
  const MESSAGES: [string, string, string[], string[]][] = [
    // A remedy that fits the form.
    ["a string that is exactly spawn (an error code)", `const e = { ok: false, reason: "spawn" };`,
      ['the string "spawn"', 'as in `x["spawn"](…)`', "a string that is data, such as an error code, is listed"], [HARM, "directly with the literal"]],
    ["a case label", `switch (x) { case "spawn": break; }`, ['the string "spawn"', "refuses every such string"], [HARM]],
    ["a comparison", `if (e === "runProc") f();`, ['the string "runProc"', "refuses every such string"], [HARM]],
    ["a kind tag", `const k = { kind: "spawn" };`, ['the string "spawn"'], [HARM]],
    ["an index access with the name", `Bun["spawn"](["git"], { detached: true });`, ['the string "spawn"', "Call a spawner by its plain name (`x.spawn(…)`)"], [HARM]],
    ["a renamed child_process spawn", `import { spawn as sp } from "node:child_process";`,
      ["only un-renamed", "Import it as `{ spawn }`."], ["`exec`", "directly", HARM]],
    ["a renamed child_process Sync name", `import { execFileSync as efs } from "node:child_process";`,
      ["only un-renamed", "Import it as `{ execFileSync }`."], ["ignore", HARM]],
    ["a non-Sync name renamed to a Sync name", `import { exec as execSync } from "child_process";`, ["`exec` ignores `detached`"], ["Import it as"]],
    ["a renamed runProc import", `import { runProc as rp } from "./run-proc.ts";`,
      ["only under their own names", "Import or export the name un-renamed (`{ runProc }`)"], ["directly", HARM]],
    ["a renamed runProc export", `export { runProc as rp } from "./run-proc.ts";`, ["un-renamed (`{ runProc }`)"], [HARM]],
    ["a renamed spawn import from bun", `import { spawn as sp } from "bun";`, ["un-renamed (`{ spawn }`)"], [HARM, "`{ runProc }`"]],
    ["a namespace import", `import * as cp from "node:child_process";`, ["only through named imports", ALLOWED], [HARM, "Use `spawn` or `runProc`"]],
    ["a default import", `import cp from "node:child_process";`, [ALLOWED], [HARM]],
    ["a require", `const cp = require("node:child_process");`, ['"node:child_process" used other than as a named import', ALLOWED], [HARM]],
    ["a dynamic import", `const cp = import("node:child_process");`, [ALLOWED], [HARM]],
    ["an export-from", `export { execSync } from "node:child_process";`, [ALLOWED], [HARM]],
    ["a fork import", `import { fork } from "node:child_process";`,
      ["does not model `fork`", "it honours `detached`", "For a child that runs to completion"], ["`exec`", "ignore"]],
    ["an exec import", `import { exec } from "child_process";`, ["`exec` ignores `detached`", "stays in muninn's process group", "For a long-lived or streaming child"], ["`fork`"]],
    ["an execFile import", `import { execFile } from "node:child_process";`, ["`execFile` imported from \"node:child_process\"", "`execFile` ignores `detached`"], []],
    ["another child_process value", `import { ChildProcess } from "node:child_process";`, ["does not model `ChildProcess`", ALLOWED], [HARM]],
    // What the reader needs to act.
    ["runProc aliased as a value", `const run = opts.run ?? runProc;`,
      ["`runProc` used as a value", "cannot follow a name used as a value to its calls", "`(deps.runProc ?? runProc)(…, { processGroup: true })`"], [HARM, "directly with the literal"]],
    ["runProc in an object shorthand", `const deps = { runProc };`, ["`(deps.runProc ?? runProc)(…, { processGroup: true })`"], [HARM]],
    ["runProc passed as an argument", `use(runProc);`, ["cannot follow a name used as a value"], [HARM]],
    ["spawn as a value", `const sp = Bun.spawn;`, ["cannot follow a name used as a value", "Call `spawn` directly, with an options literal holding `detached: true` as its last argument."], [HARM, "deps.runProc"]],
    ["inline options as const", `runProc(c, 5, "x", { processGroup: true } as const);`, ["its options are wrapped in `as const`", NEED_RP], ["must be an object literal or a same-file const", HARM]],
    ["inline options with satisfies", `Bun.spawn(["git"], { detached: true } satisfies O);`, ["its options are wrapped in `satisfies`", NEED_SPAWN], [HARM]],
    ["inline options in parentheses", `Bun.spawn(["git"], ({ detached: true }));`, ["its options are wrapped in parentheses", NEED_SPAWN], [HARM]],
    ["inline options cast with as", `Bun.spawn(["git"], { detached: true } as Opts);`, ["its options are wrapped in a type assertion", NEED_SPAWN], [HARM, "`as const`"]],
    ["inline options cast with angle brackets", `Bun.spawn(["git"], <Opts>{ detached: true });`, ["its options are wrapped in a type assertion", NEED_SPAWN], [HARM]],
    ["inline options under two wrappers", `Bun.spawn(cmd, ({ detached: true }) as X);`, ["its options are wrapped in a type assertion", NEED_SPAWN], [HARM, "cannot read options"]],
    ["a string command and no options", `spawn("ls");`, ["`spawn(…)`: no top-level `detached: true` in its last argument", HARM], ["not an object literal", "The scan reads"]],
    ["a declared const with no initializer", `declare const O: Opts;\nBun.spawn(["git"], O);`, ["its last argument is `O`", "`O` has no initializer", ...UNREAD_SPAWN], [NEED_SPAWN]],
    ["a let with no initializer", `let O;\nrunProc(c, 5, "x", O);`, ["its fourth argument is `O`", "`O` has no initializer", ...UNREAD_RP], ["`let`", NEED_RP]],
    ["a const shadowed by a parameter", `const O = { processGroup: true };\nfunction f(O) {}\nrunProc(c, 5, "x", O);`, ["`O` is declared more than once in this file", ...UNREAD_RP], ["also appears"]],
    ["a const shadowed by an import", `import { O } from "./o.ts";\nconst O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is declared more than once in this file", ...UNREAD_RP], ["also appears"]],
    ["a spread of a qualifying const", `const G = { detached: true };\nBun.spawn(["git"], { ...G });`, ["the scan does not look inside a spread", NEED_SPAWN], [HARM]],
    ["a spread argument", `runProc(cmd, 1000, ...extra, { processGroup: true });`, ["a spread argument hides which argument holds the options", NEED_RP], [HARM]],
    ["let options", `let O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is declared with `let`, not `const`", ...UNREAD_RP], [NEED_RP, "`var`"]],
    ["var options", `var O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is declared with `var`, not `const`", ...UNREAD_RP], [NEED_RP, "`let`"]],
    ["using options", `using O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is declared with `using`, not `const`", ...UNREAD_RP], [NEED_RP, "`let`", "`var`"]],
    ["await using options", `await using O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is declared with `await using`, not `const`", ...UNREAD_RP], [NEED_RP, "`let`", "`var`"]],
    ["an exported const", `export const O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is exported", ...UNREAD_RP], []],
    ["a const inside a function", `function f() { const O = { processGroup: true };\nreturn runProc(c, 5, "x", O); }`, ["`O` is not declared at the top level of the file", ...UNREAD_RP], [NEED_RP]],
    ["a const declared twice", `const O = { processGroup: true };\nconst O = { processGroup: true };\nrunProc(c, 5, "x", O);`, ["`O` is declared more than once in this file", ...UNREAD_RP], []],
    ["a const shadowed in a function", `const O = { processGroup: true };\nfunction f() { const O = {};\nreturn runProc(c, 5, "x", O); }`, ["`O` is declared more than once in this file", ...UNREAD_RP], ["top level"]],
    ["a const used elsewhere", `const O = { processGroup: true };\nuse(O);\nrunProc(c, 5, "x", O);`, ["`O` also appears on line 2 other than as these options", ...UNREAD_RP], []],
    ["a const cast to another type", `const O = { processGroup: true } as Opts;\nrunProc(c, 5, "x", O);`, ["`O`'s initializer is not a plain object literal", ...UNREAD_RP], []],
    ["a name not declared in the file", `Bun.spawn(["git"], opts);`, ["its last argument is `opts`", "`opts` is not declared in this file as a `const`", ...UNREAD_SPAWN], [NEED_SPAWN]],
    ["a parameter as the options", `function f(o) { return Bun.spawn(["git"], o); }`, ["`o` is not declared in this file as a `const`", ...UNREAD_SPAWN], []],
    // N1: the last argument may be the command, held in a name or built by an expression.
    ["a command in a function-local const", `function f() { const cmd = ["git", "status"]; return Bun.spawn(cmd); }`,
      ["`Bun.spawn(…)`: its last argument is `cmd` and the scan cannot read options from it (`cmd` is not declared at the top level of the file), so it finds no `detached: true`, and a kill", ...UNREAD_SPAWN], [NEED_SPAWN]],
    ["a command in a hoisted const", `const cmd = ["git", "status"];\nBun.spawn(cmd);`, ["`cmd`'s initializer is not a plain object literal", ...UNREAD_SPAWN], [NEED_SPAWN]],
    ["a command in a parameter", `function f(args) { return Bun.spawn(args); }`, ["its last argument is `args`", "`args` is not declared in this file as a `const`", ...UNREAD_SPAWN], [NEED_SPAWN]],
    ["child_process args in a parameter", CP + `function f(a) { return spawn("git", a); }`, ["its last argument is `a`", ...UNREAD_SPAWN], [NEED_SPAWN]],
    ["a command built by an expression", `Bun.spawn(s.split(" "));`, ['its last argument is `s.split(" ")` and the scan cannot read options from it (it is not an object literal)', ...UNREAD_SPAWN], ["its options are not an object literal", NEED_SPAWN]],
    ["a long expression is cut short", `Bun.spawn(buildTheCommandLineFrom(configuration, extraArguments));`, ["its last argument is `buildTheCommandLineFrom(configuration, e…`"], ["extraArguments"]],
    ["an expression of exactly 40 characters is shown whole", `Bun.spawn(buildTheCommandLineFrom(configurations1));`, ["its last argument is `buildTheCommandLineFrom(configurations1)` and"], ["configurations1…"]],
    ["an expression over lines is shown on one", `Bun.spawn(s\n  .split(" "));`, ['its last argument is `s .split(" ")` and'], []],
    ["a wrapped command", `Bun.spawn(["git"] as const);`, ['its last argument is `["git"] as const`', ...UNREAD_SPAWN], ["its options are wrapped", NEED_SPAWN]],
    ["runProc with a parameter as options", `function f(o) { return runProc(c, 5, "x", o); }`, ["`runProc(…)`: its fourth argument is `o`", "`o` is not declared in this file as a `const`", ...UNREAD_RP], [NEED_RP, "detached"]],
    ["runProc with a call as options", `runProc(c, 5, "x", mk());`, ["its fourth argument is `mk()`", "(it is not an object literal)", ...UNREAD_RP], ["its options are not an object literal", NEED_RP, "detached"]],
    // N2: a binding renamed TO a spawner's name, as against a spawner renamed away.
    ["a name renamed to runProc in an import", `import { foo as runProc } from "./r";`,
      ["`foo` renamed to `runProc` in `foo as runProc`", "`runProc` is reserved for the real spawner", "Pick another name for `foo`"], ["cannot check the calls behind a rename", "un-renamed"]],
    ["a name renamed to spawn in an import", `import { foo as spawn } from "./r";`, ["`spawn` is reserved for the real spawner", "Pick another name for `foo`"], ["cannot check the calls behind a rename"]],
    ["a name renamed to spawn in an export", `const foo = 1;\nexport { foo as spawn };`, ["`foo` renamed to `spawn`", "`spawn` is reserved for the real spawner"], ["cannot check the calls behind a rename"]],
    ["runProc renamed to spawn reads as a rename away", `import { runProc as spawn } from "./r";`, ["only under their own names", "un-renamed (`{ runProc }`)"], ["reserved"]],
    ["spawn renamed away in an export", `export { spawn as sp } from "bun";`, ["only under their own names", "un-renamed (`{ spawn }`)"], ["reserved"]],
    // N3: called, through a callee shape the scan does not read.
    ["(runProc<T>)(…)", `(runProc<string>)(c, 5, "x", { processGroup: true });`,
      ["`runProc` called through `(runProc<string>)`", "the scan reads a call's options only when its callee is `runProc`, `x.runProc`, or `(a ?? b)` / `(a || b)`", "`runProc<T>(…)`", "`{ processGroup: true }` as its fourth argument"], [...NOT_CALLED, "detached"]],
    ["new (Bun.spawn<…>)()", `new (Bun.spawn<"pipe">)();`, ["`spawn` called through `new (Bun.spawn<\"pipe\">)`", "only when its callee is `spawn` or `x.spawn`, called without `new`", "ending the call with an options literal holding `detached: true`"], [...NOT_CALLED, "processGroup"]],
    ["new Bun.spawn(…)", `new Bun.spawn(["git"], { detached: true });`, ["`spawn` called through `new Bun.spawn`", "called without `new`"], NOT_CALLED],
    ["Bun.spawn!(…)", `Bun.spawn!(["git"], { detached: true });`, ["`spawn` called through `Bun.spawn!`", "only when its callee is `spawn` or `x.spawn`"], NOT_CALLED],
    ["(Bun.spawn as any)(…)", `(Bun.spawn as any)(["git"], { detached: true });`, ["called through `(Bun.spawn as any)`"], NOT_CALLED],
    ["(Bun.spawn satisfies X)(…)", `(Bun.spawn satisfies X)(["git"], { detached: true });`, ["called through `(Bun.spawn satisfies X)`"], NOT_CALLED],
    ["(Bun.spawn)(…)", `(Bun.spawn)(["git"], { detached: true });`, ["called through `(Bun.spawn)`"], NOT_CALLED],
    ["(x ?? runProc)(…)", `(x ?? runProc)(c, 5, "x", { processGroup: true });`, ["`runProc` called through `(x ?? runProc)`", "with a runProc name on each side"], NOT_CALLED],

    ["spawn, spread after detached", `Bun.spawn(["git"], { detached: true, ...o });`, ["a spread follows `detached: true` and may override it", "Move the spread before the key."], ["processGroup"]],
    ["runProc, spread after processGroup", `runProc(c, 5, "x", { processGroup: true, ...o });`, ["a spread follows `processGroup: true`", "Move the spread before the key."], ["detached"]],
  ];
  for (const [form, source, want, never] of MESSAGES) {
    test(`message for ${form}`, () => {
      const m = msg(source);
      for (const s of want) expect(m).toContain(s);
      for (const s of never) expect(m).not.toContain(s);
      expect(m).toEndWith(WAY_OUT);
      expect(m.split(WAY_OUT)).toHaveLength(2);
      expect(m).not.toContain("list the line");
    });
  }

  test("every name in an unread callee is told it is called, not that it is a value", () => {
    for (const source of [
      `(Bun.spawn ?? runProc)(c, 5, "x", ${G});`, `(a.runProc && runProc)(c, 5, "x", ${G});`, `((a.runProc ?? runProc))(c, 5, "x", ${G});`,
      `(runProc ?? x)(c, 5, "x", ${G});`, `(runProc || x)(c, 5, "x", ${G});`, `(Bun.spawn ?? spawn)(["git"], { detached: true });`,
      `(a ? runProc : b.runProc)(c, 5, "x", ${G});`, `(a.runProc, runProc)(c, 5, "x", ${G});`,
    ]) {
      const sites = scanSource("src/a.ts", source);
      expect(sites.length).toBeGreaterThan(0);
      for (const s of sites) {
        const m = siteMessage(s);
        expect(m).toContain("called through `(");
        expect(m).toContain("the scan reads a call's options only when its callee is");
        for (const no of NOT_CALLED) expect(m).not.toContain(no);
      }
    }
  });

  test("a name that is only a value keeps the value message", () => {
    for (const source of [`const b = Bun.spawn as any;`, `f(runProc)();`, `const r = runProc ?? x;`, `runProc.call(null, c, 5, "x", ${G});`, `class A extends spawn {}`, `(runProc ? a : b)(c, 5, "x", ${G});`]) {
      const m = msg(source);
      expect(m).toContain("used as a value, not called");
      expect(m).not.toContain("called through");
    }
  });

  /** Each new message's remedy, applied to its form, passes the guard. */
  const REMEDIES: [string, string][] = [
    ["a command in a local const, ended with detached", `function f() { const cmd = ["git", "status"]; return Bun.spawn(cmd, { detached: true }); }`],
    ["a command in a local const, through runProc", RP + `function f() { const cmd = ["git", "status"]; return runProc(cmd, 5, "x", ${G}); }`],
    ["a hoisted command const, ended with detached", `const cmd = ["git", "status"];\nBun.spawn(cmd, { detached: true });`],
    ["a command parameter, ended with detached", `function f(args) { return Bun.spawn(args, { detached: true }); }`],
    ["child_process args, ended with detached", CP + `function f(a) { return spawn("git", a, { detached: true }); }`],
    ["an expression command, ended with detached", `Bun.spawn(s.split(" "), { detached: true });`],
    ["an expression command, through runProc", `runProc(s.split(" "), 5, "x", ${G});`],
    ["a wrapped command, ended with detached", `Bun.spawn(["git"] as const, { detached: true });`],
    ["options in a parameter, spread into a literal", `function f(o) { return Bun.spawn(["git"], { ...o, detached: true }); }`],
    ["options in a const, as a qualifying const", `const O = { detached: true };\nfunction f(cmd) { return Bun.spawn(cmd, O); }`],
    ["runProc options in a parameter, spread into a literal", `function f(o) { return runProc(c, 5, "x", { ...o, processGroup: true }); }`],
    ["runProc options from a call, spread into a literal", `runProc(c, 5, "x", { ...mk(), processGroup: true });`],
    ["a binding renamed to another name (import)", `import { foo as runFoo } from "./r";\nimport { bar as spawner } from "./s";`],
    ["a binding renamed to another name (export)", `const foo = 1;\nexport { foo as spawnChild };`],
    ["(runProc<T>)(…) as runProc<T>(…)", `runProc<string>(c, 5, "x", ${G});`],
    ["new (Bun.spawn<…>)() as a plain call", `Bun.spawn<"pipe">(["git"], { detached: true });`],
    ["Bun.spawn!, as, satisfies and parens dropped", `Bun.spawn(["git"], { detached: true });`],
    ["(x ?? runProc) as (deps.runProc ?? runProc)", `(deps.runProc ?? runProc)(c, 5, "x", ${G});`],
  ];
  for (const [form, source] of REMEDIES) {
    test(`remedy passes: ${form}`, () => {
      expect(scanSource("src/a.ts", source)).toEqual([]);
    });
  }

  test("spawn message: which child each remedy fits, and the detached form's own kill and exit handling", () => {
    const m = msg(`\nBun.spawn(["git"]);`);
    expect(m).toStartWith("src/a.ts:2 `Bun.spawn(…)`: no top-level `detached: true` in its last argument, so a kill (timeout, abort, `.kill()`) reaches only the direct child");
    for (const s of [
      "For a child that runs to completion, use `runProc(…, { processGroup: true })`", "shutdown and Ctrl-C reach it",
      "For a long-lived or streaming child, end the `spawn` call with an options literal holding `detached: true`",
      "outside runProc's shutdown registry, so it needs its own kill of `-proc.pid` and its own exit handling", WAY_OUT,
    ]) expect(m).toContain(s);
    expect(m.indexOf("runs to completion")).toBeLessThan(m.indexOf("long-lived or streaming"));
  });

  test("runProc message names the fourth argument and processGroup, not detached", () => {
    const m = msg(`runProc(c, 5, "x");`);
    for (const s of ["no top-level `processGroup: true` in its options (fourth) argument", HARM, "Pass `{ processGroup: true }`", WAY_OUT]) expect(m).toContain(s);
    expect(m).not.toContain("detached");
  });

  test("parse message names the first diagnostic and its line, and offers no allowlist way out", () => {
    const m = msg(`\nBun.spawn(["git"], { detached: true );`);
    expect(m).toBe(`src/a.ts:2 TypeScript parse error "',' expected.": the scan does not trust a tree recovered from a syntax error, so it reads nothing else in this file until it parses and listing the file would hide every site in it. Fix the syntax.`);
    for (const s of [ALLOWLIST, "add or raise", "If the code is right"]) expect(m).not.toContain(s);
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
  const site = (p: string, line: number): Site => ({ path: p, line, kind: "spawn", what: "`Bun.spawn(…)`", why: "no top-level `detached: true` in its last argument." });

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
