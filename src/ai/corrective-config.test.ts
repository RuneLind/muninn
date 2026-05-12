import { test, expect, describe } from "bun:test";
import { resolveCorrectiveConfig, clampBudget } from "./corrective-config.ts";

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

describe("resolveCorrectiveConfig", () => {
  test("off by default when nothing is configured", () => {
    expect(resolveCorrectiveConfig({}, {})).toEqual({ enabled: false, retryBudget: 1 });
  });

  test("per-bot config enables it and clamps the budget", () => {
    expect(resolveCorrectiveConfig({ correctiveRetrieval: { enabled: true, retryBudget: 9 } }, {})).toEqual({
      enabled: true,
      retryBudget: 2,
    });
  });

  test("global env default enables it when the bot doesn't say otherwise", () => {
    const env = { CORRECTIVE_RETRIEVAL_ENABLED: "true", CORRECTIVE_RETRIEVAL_BUDGET: "2" };
    expect(resolveCorrectiveConfig({}, env)).toEqual({ enabled: true, retryBudget: 2 });
  });

  test("per-bot config overrides the global default (disable wins too)", () => {
    const env = { CORRECTIVE_RETRIEVAL_ENABLED: "true" };
    expect(resolveCorrectiveConfig({ correctiveRetrieval: { enabled: false } }, env).enabled).toBe(false);
  });

  test("kill-switch overrides everything", () => {
    const env = { CORRECTIVE_RETRIEVAL_DISABLED: "1", CORRECTIVE_RETRIEVAL_ENABLED: "true" };
    expect(resolveCorrectiveConfig({ correctiveRetrieval: { enabled: true, retryBudget: 2 } }, env)).toEqual({
      enabled: false,
      retryBudget: 1,
    });
  });

  test("a bare global enable defaults the budget to 1", () => {
    expect(resolveCorrectiveConfig({}, { CORRECTIVE_RETRIEVAL_ENABLED: "true" })).toEqual({ enabled: true, retryBudget: 1 });
  });
});
