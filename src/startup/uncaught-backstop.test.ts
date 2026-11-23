/**
 * The uncaught-exception backstop, driven in a child `bun` process: an
 * installed handler changes how the process exits, which no in-process test can
 * observe. Each child script installs the backstop, throws, and prints a line
 * from a later timer; the exit code and stdout say whether it survived.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
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

describe("src/index.ts: backstop wiring", () => {
  test("installs the backstop beside the rejection handler and marks boot complete as its last statement", async () => {
    const text = await readFile(path.resolve(import.meta.dir, "../index.ts"), "utf8");
    const rejection = text.indexOf('process.on("unhandledRejection"');
    const install = text.indexOf("const uncaughtBackstop = installUncaughtBackstop(log);");
    expect(rejection).toBeGreaterThan(-1);
    expect(install, "src/index.ts must install the uncaught-exception backstop").toBeGreaterThan(rejection);
    expect(text.slice(rejection, install).split("\n").length, "installed beside the rejection handler").toBeLessThan(12);
    expect(text.trimEnd().endsWith("uncaughtBackstop.markBooted();"), "boot is complete at the module's last statement").toBe(true);
  });
});
