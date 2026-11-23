/**
 * The uncaught-exception backstop, driven in a child `bun` process: an
 * installed handler changes how the process exits, which no in-process test can
 * observe. Each child script installs the backstop, throws, and prints a line
 * from a later timer; the exit code and stdout say whether it survived.
 * The second half reads `src/index.ts`'s parsed source: where it installs the
 * backstop and where it marks boot complete (after the scheduler start).
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { runProc } from "../utils/run-proc.ts";
import { testTempDirSync } from "../test/temp-dir.ts";

const dir = testTempDirSync(path.join(tmpdir(), "muninn-backstop-"));

const MODULE = path.resolve(import.meta.dir, "uncaught-backstop.ts");
// Absolute, so the script outside the repo loads the repo's copy (never Bun's auto-install).
const LOGTAPE = Bun.resolveSync("@logtape/logtape", import.meta.dir);

/** A child script: the logger writes each record to stdout as `LOG <level> <phase> <message>`. */
async function runChild(name: string, body: string) {
  const file = path.join(dir, `${name}.ts`);
  writeFileSync(
    file,
    `import { configure, getLogger } from ${JSON.stringify(LOGTAPE)};
import { installUncaughtBackstop } from ${JSON.stringify(MODULE)};
await configure({
  sinks: { out: (r) => process.stdout.write("LOG " + r.level + " " + r.properties.phase + " " + String(r.properties.error).split("\\n")[0] + "\\n") },
  loggers: [{ category: ["muninn"], sinks: ["out"], lowestLevel: "debug" }, { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" }],
});
const backstop = installUncaughtBackstop(getLogger(["muninn", "core"]));
setTimeout(() => process.stdout.write("LATER\\n"), 80);
${body}
`,
  );
  // --no-env-file keeps any .env out of the child.
  return runProc([process.execPath, "--no-env-file", file], 10_000, "backstop-child", { processGroup: true, cwd: dir });
}

describe("uncaught-exception backstop", () => {
  test("after boot: a throw in a timer is logged at error with its stack, and the process keeps running", async () => {
    const r = await runChild("booted", `backstop.markBooted();\nsetTimeout(() => { throw new Error("timer throw"); }, 5);`);
    expect(r.stdout).toContain("LOG error running Error: timer throw");
    expect(r.stdout).toContain("LATER");
    expect(r.exitCode).toBe(0);
  });

  test("after boot: a throw in an abort listener is survived too", async () => {
    const r = await runChild(
      "abort-listener",
      `backstop.markBooted();\nconst c = new AbortController();\nc.signal.addEventListener("abort", () => { throw new Error("listener throw"); });\nsetTimeout(() => c.abort(), 5);`,
    );
    expect(r.stdout).toContain("LOG error running Error: listener throw");
    expect(r.stdout).toContain("LATER");
    expect(r.exitCode).toBe(0);
  });

  test("before boot: a throw in a timer is logged and the process exits non-zero", async () => {
    const r = await runChild("not-booted", `setTimeout(() => { throw new Error("boot throw"); }, 5);`);
    expect(r.stdout).toContain("LOG error boot Error: boot throw");
    expect(r.stdout).not.toContain("LATER");
    expect(r.exitCode).not.toBe(0);
  });

  test("before boot: a top-level throw in the main module still exits non-zero", async () => {
    // Bun hands a top-level throw to the installed handler and would otherwise carry on with exit 0.
    const r = await runChild("top-level", `throw new Error("config refused");`);
    expect(r.stdout).toContain("LOG error boot Error: config refused");
    expect(r.stdout).not.toContain("LATER");
    expect(r.exitCode).not.toBe(0);
  });

  test("before boot: a rejected top-level await still exits non-zero", async () => {
    const r = await runChild("top-level-await", `await Promise.reject(new Error("await refused"));`);
    expect(r.stdout).toContain("LOG error boot Error: await refused");
    expect(r.stdout).not.toContain("LATER");
    expect(r.exitCode).not.toBe(0);
  });
});

// --- src/index.ts, read from its parsed source (never by starting muninn) ---

const INDEX = path.resolve(import.meta.dir, "../index.ts");

async function parseIndex(): Promise<ts.SourceFile> {
  return ts.createSourceFile(INDEX, await readFile(INDEX, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every node under `node`, optionally stopping at function boundaries. */
function descendants(node: ts.Node, intoFunctions = true): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    if (!intoFunctions && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return out;
}

const callName = (n: ts.Node): string | null =>
  !ts.isCallExpression(n) ? null
  : ts.isIdentifier(n.expression) ? n.expression.text
  : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
  : null;

const markBootedCalls = (n: ts.Node) => descendants(n).filter((d) => callName(d) === "markBooted");

/** A top-level statement that awaits at module level (an `await` or `for await` outside any function). */
const awaitsAtTopLevel = (s: ts.Statement) =>
  descendants(s, false).some((d) => ts.isAwaitExpression(d) || (ts.isForOfStatement(d) && !!d.awaitModifier));

/** The top-level `setTimeout(() => { … startScheduler(…) … }, ms)` statement and its callback. */
function schedulerTimer(sf: ts.SourceFile) {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || callName(stmt.expression) !== "setTimeout") continue;
    const cb = (stmt.expression as ts.CallExpression).arguments[0];
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && descendants(cb).some((d) => callName(d) === "startScheduler")) {
      return { stmt, cb };
    }
  }
  return null;
}

/**
 * The scheduler-start timer as `src/index.ts` arms it, run for real in a child:
 * the child holds the backstop, then every top-level statement of `src/index.ts`
 * that is the scheduler timer or calls `markBooted()`, in source order, with
 * stubs for what they reference. The timer's 10 s becomes 5 ms.
 */
async function runSchedulerChild(name: string, startThrows: boolean, extra = "") {
  const sf = await parseIndex();
  const timer = schedulerTimer(sf);
  if (!timer) throw new Error("src/index.ts arms no top-level setTimeout that calls startScheduler");
  const picked = sf.statements.filter((s) => s === timer.stmt || markBootedCalls(s).length > 0).map((s) => s.getText(sf));
  const file = path.join(dir, `${name}.ts`);
  writeFileSync(
    file,
    `import { configure, getLogger } from ${JSON.stringify(LOGTAPE)};
import { installUncaughtBackstop } from ${JSON.stringify(MODULE)};
await configure({
  sinks: { out: (r) => process.stdout.write("LOG " + r.level + " " + r.properties.phase + " " + String(r.properties.error).split("\\n")[0] + "\\n") },
  loggers: [{ category: ["muninn"], sinks: ["out"], lowestLevel: "debug" }, { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" }],
});
const uncaughtBackstop = installUncaughtBackstop(getLogger(["muninn", "core"]));
globalThis.setTimeout(() => process.stdout.write("LATER\\n"), 80);
const setTimeout = (fn: () => void, _ms: number) => globalThis.setTimeout(fn, 5);
const config = {};
const botConfigs = [{ name: "a", telegramBotToken: "t" }, { name: "b", telegramBotToken: "t" }];
const telegramBotMap = new Map(botConfigs.map((b) => [b.name, { api: {} }]));
const startScheduler = (_api: unknown, _config: unknown, bot: { name: string }) => {
  process.stdout.write("START " + bot.name + "\\n");
  if (${startThrows}) throw new Error("scheduler start throw");
};
${extra}
${picked.join("\n")}
`,
  );
  return runProc([process.execPath, "--no-env-file", file], 10_000, "backstop-child", { processGroup: true, cwd: dir });
}

describe("src/index.ts: the scheduler start is part of boot", () => {
  // Proves the behaviour of the code as src/index.ts places it; that the timer
  // and the markBooted() call are where it says is the wiring tests' job below.
  test("a throw from the scheduler-start timer exits 1, as it did before the backstop", async () => {
    const r = await runSchedulerChild("scheduler-throw", true);
    expect(r.stdout).toContain("START a");
    expect(r.stdout).toContain("LOG error boot Error: scheduler start throw");
    expect(r.stdout).not.toContain("LATER");
    expect(r.exitCode).toBe(1);
  });

  test("once the schedulers have started, boot is complete and a later throw is survived", async () => {
    const r = await runSchedulerChild("scheduler-ok", false, `globalThis.setTimeout(() => { throw new Error("after boot"); }, 40);`);
    expect(r.stdout).toContain("START a\nSTART b");
    expect(r.stdout).toContain("LOG error running Error: after boot");
    expect(r.stdout).toContain("LATER");
    expect(r.exitCode).toBe(0);
  });
});

describe("src/index.ts: backstop wiring (parsed source)", () => {
  test("calls markBooted() exactly once", async () => {
    expect(markBootedCalls(await parseIndex()).length).toBe(1);
  });

  test("marks boot complete as the last statement of the scheduler-start timer", async () => {
    const sf = await parseIndex();
    const timer = schedulerTimer(sf);
    expect(timer, "a top-level setTimeout whose callback calls startScheduler").not.toBeNull();
    const body = timer!.cb.body;
    expect(ts.isBlock(body), "the scheduler-start callback has a block body").toBe(true);
    const last = (body as ts.Block).statements.at(-1);
    expect(last && ts.isExpressionStatement(last) && callName(last.expression) === "markBooted", "markBooted() is the callback's last statement").toBe(true);
  });

  test("the scheduler-start timer cannot return before markBooted()", async () => {
    // An early return would leave the instance in boot mode for good, where any
    // uncaught throw exits the process. Nested functions' returns are their own.
    const sf = await parseIndex();
    const timer = schedulerTimer(sf);
    expect(timer, "a top-level setTimeout whose callback calls startScheduler").not.toBeNull();
    const call = markBootedCalls(timer!.cb)[0];
    expect(call, "the callback calls markBooted()").toBeDefined();
    const early = descendants(timer!.cb.body, false)
      .filter((d) => ts.isReturnStatement(d) && d.getStart(sf) < call!.getStart(sf))
      .map((d) => `line ${sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1}: ${d.getText(sf)}`);
    expect(early, "return statements before markBooted()").toEqual([]);
  });

  test("installs the backstop after the unhandledRejection handler and before the first top-level await after it", async () => {
    const sf = await parseIndex();
    const stmts = [...sf.statements];
    const rejection = stmts.findIndex(
      (s) =>
        ts.isExpressionStatement(s) &&
        callName(s.expression) === "on" &&
        ts.isStringLiteral((s.expression as ts.CallExpression).arguments[0]!) &&
        ((s.expression as ts.CallExpression).arguments[0] as ts.StringLiteral).text === "unhandledRejection",
    );
    const install = stmts.findIndex(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some(
          (d) => d.initializer !== undefined && callName(d.initializer) === "installUncaughtBackstop",
        ),
    );
    expect(rejection, "a top-level process.on(\"unhandledRejection\", …)").toBeGreaterThan(-1);
    expect(install, "a top-level installUncaughtBackstop(…) declaration").toBeGreaterThan(rejection);
    const firstAwait = stmts.findIndex((s, i) => i > rejection && awaitsAtTopLevel(s));
    expect(firstAwait, "a top-level await follows the rejection handler").toBeGreaterThan(-1);
    expect(install, "installed before that await").toBeLessThan(firstAwait);
  });
});
