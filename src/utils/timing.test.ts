import { test, expect, describe } from "bun:test";
import { Timing } from "./timing.ts";

describe("Timing", () => {
  test("start/end measures elapsed time", () => {
    const t = new Timing();
    t.start("test");
    // Busy-wait a bit to ensure non-zero time
    const start = performance.now();
    while (performance.now() - start < 5) {}
    const elapsed = t.end("test");
    expect(elapsed).toBeGreaterThan(0);
  });

  test("end throws for unknown label", () => {
    const t = new Timing();
    expect(() => t.end("nonexistent")).toThrow('No active mark for "nonexistent"');
  });

  test("totalMs returns time since construction", () => {
    const t = new Timing();
    const start = performance.now();
    while (performance.now() - start < 5) {}
    expect(t.totalMs()).toBeGreaterThan(0);
  });

  test("summary returns all marks", () => {
    const t = new Timing();
    t.start("a");
    t.end("a");
    t.start("b");
    t.end("b");
    const s = t.summary();
    expect(s).toHaveProperty("a");
    expect(s).toHaveProperty("b");
    expect(s.a).toBeGreaterThanOrEqual(0);
    expect(s.b).toBeGreaterThanOrEqual(0);
  });

  test("summary includes in-progress marks", () => {
    const t = new Timing();
    t.start("running");
    const s = t.summary();
    expect(s).toHaveProperty("running");
    expect(s.running).toBeGreaterThanOrEqual(0);
  });

  test("formatTelegram produces total", () => {
    const t = new Timing();
    const result = t.formatTelegram();
    expect(result).toMatch(/total$/);
  });

  test("formatTelegram includes token info", () => {
    const t = new Timing();
    const result = t.formatTelegram({ inputTokens: 1500, outputTokens: 300 });
    expect(result).toContain("1.5k in");
    expect(result).toContain("300 out");
  });

  test("formatTelegram includes cost", () => {
    const t = new Timing();
    const result = t.formatTelegram({ costUsd: 0.0123 });
    expect(result).toContain("$0.0123");
  });

  test("formatTelegram includes startup when > 500ms", () => {
    const t = new Timing();
    const result = t.formatTelegram({ startupMs: 1500 });
    expect(result).toContain("mcp 1.5s");
  });

  test("formatTelegram omits startup when <= 500ms", () => {
    const t = new Timing();
    const result = t.formatTelegram({ startupMs: 300 });
    expect(result).not.toContain("mcp");
  });

  test("formatTelegram includes apiMs", () => {
    const t = new Timing();
    const result = t.formatTelegram({ apiMs: 2500 });
    expect(result).toContain("api 2.5s");
  });

  test("formatTelegram formats durations >= 1s as seconds", () => {
    const t = new Timing();
    const result = t.formatTelegram({ apiMs: 1200 });
    expect(result).toContain("1.2s");
  });

  test("formatTelegram formats durations < 1s as ms", () => {
    const t = new Timing();
    const result = t.formatTelegram({ apiMs: 500 });
    expect(result).toContain("500ms");
  });
});
