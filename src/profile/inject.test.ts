import { test, expect, describe } from "bun:test";
import { withInterestProfile } from "./inject.ts";

const BASE = `You are a quality gate for a senior AI engineer who lives in Claude Code.

Weight HIGHEST: Claude Code, MCP, retrieval.
Return ONLY a JSON array.`;

describe("withInterestProfile", () => {
  test("returns the base prompt verbatim when no profile", () => {
    expect(withInterestProfile(BASE, null)).toBe(BASE);
    expect(withInterestProfile(BASE, undefined)).toBe(BASE);
  });

  test("returns the base prompt verbatim when profile is blank/whitespace", () => {
    expect(withInterestProfile(BASE, "")).toBe(BASE);
    expect(withInterestProfile(BASE, "   \n  ")).toBe(BASE);
  });

  test("appends the profile while preserving the baseline verbatim as a prefix", () => {
    const profile = "- Rust async runtimes — building a scheduler\n- Local LLM inference — cost control";
    const out = withInterestProfile(BASE, profile);
    // Baseline must be preserved byte-for-byte at the start (anti-filter-bubble).
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain(profile);
    // The augment framing must be present and must NOT narrow the baseline.
    expect(out.toLowerCase()).toContain("augment");
    expect(out.toLowerCase()).toContain("do not narrow");
  });

  test("trims surrounding whitespace on the injected profile", () => {
    const out = withInterestProfile(BASE, "\n\n- topic\n\n");
    expect(out).toContain("- topic");
    expect(out).not.toContain("- topic\n\n");
  });
});
