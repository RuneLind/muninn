import { test, expect, describe } from "bun:test";
import { resolveCorrectiveConfig, clampBudget, normalizeGraderMode } from "./corrective-config.ts";

describe("clampBudget", () => {
  test("clamps to the 1–2 range and floors", () => {
    expect(clampBudget(0)).toBe(1);
    expect(clampBudget(1)).toBe(1);
    expect(clampBudget(2)).toBe(2);
    expect(clampBudget(5)).toBe(2);
    expect(clampBudget(1.9)).toBe(1);
    expect(clampBudget(NaN)).toBe(1);
  });
});

describe("normalizeGraderMode", () => {
  test("only 'haiku' opts into the model grader; everything else is 'signal'", () => {
    expect(normalizeGraderMode("haiku")).toBe("haiku");
    expect(normalizeGraderMode("signal")).toBe("signal");
    expect(normalizeGraderMode(undefined)).toBe("signal");
    expect(normalizeGraderMode("nonsense")).toBe("signal");
  });
});

describe("resolveCorrectiveConfig", () => {
  test("off, budget 1, signal grader by default", () => {
    expect(resolveCorrectiveConfig({}, {})).toEqual({ enabled: false, retryBudget: 1, grader: "signal" });
  });

  test("per-bot config enables it, clamps the budget, and selects the grader", () => {
    expect(resolveCorrectiveConfig({ correctiveRetrieval: { enabled: true, retryBudget: 9, grader: "haiku" } }, {})).toEqual({
      enabled: true,
      retryBudget: 2,
      grader: "haiku",
    });
  });

  test("global env defaults apply when the bot doesn't say otherwise", () => {
    const env = { CORRECTIVE_RETRIEVAL_ENABLED: "true", CORRECTIVE_RETRIEVAL_BUDGET: "2", CORRECTIVE_RETRIEVAL_GRADER: "haiku" };
    expect(resolveCorrectiveConfig({}, env)).toEqual({ enabled: true, retryBudget: 2, grader: "haiku" });
  });

  test("per-bot config overrides the global default (disable wins too)", () => {
    const env = { CORRECTIVE_RETRIEVAL_ENABLED: "true", CORRECTIVE_RETRIEVAL_GRADER: "haiku" };
    expect(resolveCorrectiveConfig({ correctiveRetrieval: { enabled: false, grader: "signal" } }, env)).toEqual({
      enabled: false,
      retryBudget: 1,
      grader: "signal",
    });
  });

  test("kill-switch overrides everything", () => {
    const env = { CORRECTIVE_RETRIEVAL_DISABLED: "1", CORRECTIVE_RETRIEVAL_ENABLED: "true" };
    expect(resolveCorrectiveConfig({ correctiveRetrieval: { enabled: true, retryBudget: 2, grader: "haiku" } }, env)).toEqual({
      enabled: false,
      retryBudget: 1,
      grader: "signal",
    });
  });

  test("a bare global enable defaults the budget to 1 and the grader to signal", () => {
    expect(resolveCorrectiveConfig({}, { CORRECTIVE_RETRIEVAL_ENABLED: "true" })).toEqual({
      enabled: true,
      retryBudget: 1,
      grader: "signal",
    });
  });
});
