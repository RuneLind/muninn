import { describe, expect, test } from "bun:test";
import { resolveCorrectiveConfig } from "./corrective-config.ts";

describe("resolveCorrectiveConfig", () => {
  test("defaults to disabled when nothing is set", () => {
    expect(resolveCorrectiveConfig({}, {})).toEqual({ enabled: false });
  });

  test("per-bot enabled = true wins over absent global", () => {
    const r = resolveCorrectiveConfig({ correctiveRetrieval: { enabled: true } }, {});
    expect(r.enabled).toBe(true);
  });

  test("per-bot enabled = false wins over global on", () => {
    const r = resolveCorrectiveConfig(
      { correctiveRetrieval: { enabled: false } },
      { CORRECTIVE_RETRIEVAL_ENABLED: "true" },
    );
    expect(r.enabled).toBe(false);
  });

  test("global env enables when per-bot is absent", () => {
    const r = resolveCorrectiveConfig({}, { CORRECTIVE_RETRIEVAL_ENABLED: "true" });
    expect(r.enabled).toBe(true);
  });

  test("kill-switch overrides both per-bot and global", () => {
    const r = resolveCorrectiveConfig(
      { correctiveRetrieval: { enabled: true } },
      { CORRECTIVE_RETRIEVAL_ENABLED: "true", CORRECTIVE_RETRIEVAL_DISABLED: "1" },
    );
    expect(r.enabled).toBe(false);
  });

  test("global env value other than 'true' does not enable", () => {
    const r = resolveCorrectiveConfig({}, { CORRECTIVE_RETRIEVAL_ENABLED: "1" });
    expect(r.enabled).toBe(false);
  });
});
