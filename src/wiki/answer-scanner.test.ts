import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetAnswerScannerForTest, scanAnswerText, scannerRequired } from "./answer-scanner.ts";

const MARKER = "SYNTHETIC-SECRET-0000";
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "muninn-scanner-unit-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => __resetAnswerScannerForTest());

const write = async (name: string, source: string) => {
  const file = path.join(dir, name);
  await Bun.write(file, source);
  return file;
};

describe("scanAnswerText", () => {
  test("clean, refused with the scanner's reasons, in order", async () => {
    const file = await write(
      "stub.ts",
      `export function scanAnswer(t) { return t.includes("${MARKER}") ? [{ reason: "a" }, { reason: "b", extra: 1 }] : []; }`,
    );
    expect(await scanAnswerText(file, "plain text")).toEqual({ status: "clean" });
    expect(await scanAnswerText(file, `x ${MARKER} y`)).toEqual({ status: "refused", reasons: ["a", "b"] });
  });

  test("never clean when the contract is broken", async () => {
    const cases: [string, string][] = [
      ["no-export.ts", "export const x = 1;"],
      ["not-fn.ts", "export const scanAnswer = [];"],
      ["throws.ts", "export function scanAnswer() { throw new Error('nope'); }"],
      ["rejects.ts", "export async function scanAnswer() { throw new Error('nope'); }"],
      ["object.ts", "export function scanAnswer() { return { reason: 'x' }; }"],
      ["null.ts", "export function scanAnswer() { return null; }"],
      ["bad-item.ts", "export function scanAnswer() { return ['x']; }"],
      ["no-reason.ts", "export function scanAnswer() { return [{ reason: 5 }]; }"],
    ];
    for (const [name, source] of cases) {
      const outcome = await scanAnswerText(await write(name, source), "text");
      expect(`${name} → ${outcome.status}`).toBe(`${name} → unavailable`);
    }
    for (const p of ["", "   ", "relative.ts", "./stub.ts", path.join(dir, "absent.ts")]) {
      expect(`${JSON.stringify(p)} → ${(await scanAnswerText(p, "text")).status}`).toBe(`${JSON.stringify(p)} → unavailable`);
    }
  });

  test("a failed load is not cached: the next scan loads the module once it exists", async () => {
    const file = path.join(dir, "late.ts");
    expect((await scanAnswerText(file, "text")).status).toBe("unavailable");
    await Bun.write(file, "export function scanAnswer() { return []; }");
    expect((await scanAnswerText(file, "text")).status).toBe("clean");
  });
});

test("scannerRequired: nais only", () => {
  expect(scannerRequired("nais")).toBe(true);
  expect(scannerRequired("default")).toBe(false);
});

describe("answer cards PR 5 fix round 1: the scanner's own bounds and logging", () => {
  test("a scan that never settles is unavailable after the timeout, not a hung request", async () => {
    const file = await write("never.ts", "export function scanAnswer() { return new Promise(() => {}); }");
    const started = Date.now();
    const outcome = await scanAnswerText(file, "text", { timeoutMs: 50 });
    expect(outcome.status).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
  }, 3000);

  test("the reasons are capped in count and in length, with the rest counted", async () => {
    const file = await write(
      "many.ts",
      `export function scanAnswer() { return Array.from({ length: 100 }, (_, i) => ({ reason: String(i).padEnd(1000, "x") })); }`,
    );
    const outcome = await scanAnswerText(file, "text");
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reasons.length).toBe(20);
    expect(outcome.reasons.every((r) => [...r].length <= 300)).toBe(true);
    expect(outcome.reasons[0]!.startsWith("0x")).toBe(true);
    expect(outcome.omitted).toBe(80);
  });

  test("a sparse array is malformed, never a refusal with a hole in it", async () => {
    for (const [name, body] of [
      ["sparse.ts", "return [,];"],
      ["sparse-mixed.ts", "return [{ reason: 'a' }, , { reason: 'b' }];"],
    ] as const) {
      const outcome = await scanAnswerText(await write(name, `export function scanAnswer() { ${body} }`), "text");
      expect(`${name} → ${outcome.status}`).toBe(`${name} → unavailable`);
    }
  });
});

describe("answer cards PR 5 fix round 1: what the scanner logs", () => {
  const records: LogRecord[] = [];
  const rendered = (r: LogRecord) => r.message.map(String).join("");
  beforeEach(async () => {
    records.length = 0;
    await configure({
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [
        { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
        { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
      ],
      reset: true,
    });
  });
  afterEach(async () => {
    await reset();
  });

  test("a scanner that throws: the path and the error's class are logged, never its message", async () => {
    const file = await write(
      "leaky.ts",
      `export function scanAnswer(t) { throw new TypeError("could not scan: " + t + " {brace}"); }`,
    );
    expect((await scanAnswerText(file, `answer carrying ${MARKER}`)).status).toBe("unavailable");
    expect(records.length).toBe(1);
    const all = records.map((r) => `${rendered(r)} ${JSON.stringify(r.properties)}`).join("\n");
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain("could not scan");
    expect(rendered(records[0]!)).toContain(file);
    expect(rendered(records[0]!)).toContain("TypeError");
    expect(rendered(records[0]!)).not.toContain("undefined");
  });

  test("a path carrying braces is logged literally, not read as a template placeholder", async () => {
    const file = path.join(dir, "{weird}", "missing.ts");
    expect((await scanAnswerText(file, "text")).status).toBe("unavailable");
    expect(records.length).toBe(1);
    expect(rendered(records[0]!)).toContain("{weird}");
    expect(rendered(records[0]!)).not.toContain("undefined");
  });

  test("one line per category per minute, so a later failure is still logged", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const a = await write("throw-a.ts", "export function scanAnswer() { throw new Error('a'); }");
    const b = await write("throw-b.ts", "export function scanAnswer() { throw new RangeError('b'); }");
    const shape = await write("shape-a.ts", "export function scanAnswer() { return 5; }");
    await scanAnswerText(a, "x", { now: clock });
    await scanAnswerText(a, "x", { now: clock });
    // A different path is a different category.
    await scanAnswerText(b, "x", { now: clock });
    await scanAnswerText(shape, "x", { now: clock });
    expect(records.length).toBe(3);
    now += 30_000;
    await scanAnswerText(a, "x", { now: clock });
    expect(records.length).toBe(3);
    // Past the minute, the same failure is logged again — not silenced forever.
    now += 31_000;
    await scanAnswerText(a, "x", { now: clock });
    expect(records.length).toBe(4);
  });

  test("seventy distinct failing paths do not silence the seventy-first", async () => {
    for (let i = 0; i < 71; i++) {
      await scanAnswerText(path.join(dir, `absent-${i}.ts`), "x");
    }
    expect(records.length).toBe(71);
  });
});
