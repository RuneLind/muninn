import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
