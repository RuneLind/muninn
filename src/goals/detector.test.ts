import { test, expect, describe } from "bun:test";
import { buildPrompt, fuzzyMatchGoalTitle } from "./detector.ts";

// ── fuzzyMatchGoalTitle ──────────────────────────────────────────────

describe("fuzzyMatchGoalTitle", () => {
  test("exact match returns the title", () => {
    const result = fuzzyMatchGoalTitle("Finish report", ["Finish report"]);
    expect(result).toBe("Finish report");
  });

  test("case-insensitive match", () => {
    const result = fuzzyMatchGoalTitle("finish report", [
      "Finish Report",
      "Deploy API",
    ]);
    expect(result).toBe("Finish Report");
  });

  test("completed title is substring of goal title", () => {
    const result = fuzzyMatchGoalTitle("quarterly report", [
      "Write quarterly report for Q1",
      "Deploy API",
    ]);
    expect(result).toBe("Write quarterly report for Q1");
  });

  test("goal title is substring of completed title", () => {
    const result = fuzzyMatchGoalTitle(
      "I finished the quarterly report and sent it to the team",
      ["quarterly report", "Deploy API"],
    );
    expect(result).toBe("quarterly report");
  });

  test("returns null when no match", () => {
    const result = fuzzyMatchGoalTitle("something unrelated", [
      "Finish report",
      "Deploy API",
    ]);
    expect(result).toBeNull();
  });

  test("returns null for empty goal list", () => {
    const result = fuzzyMatchGoalTitle("Finish report", []);
    expect(result).toBeNull();
  });

  test("returns first match when multiple match", () => {
    const result = fuzzyMatchGoalTitle("report", [
      "Write report",
      "Review report",
    ]);
    expect(result).toBe("Write report");
  });

  test("handles single-word titles", () => {
    const result = fuzzyMatchGoalTitle("deploy", [
      "Deploy to production",
      "Write tests",
    ]);
    expect(result).toBe("Deploy to production");
  });

  test("handles empty completed title", () => {
    const result = fuzzyMatchGoalTitle("", ["Finish report"]);
    // Empty string is substring of everything
    expect(result).toBe("Finish report");
  });
});

// ── buildPrompt ──────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("includes user message", () => {
    const prompt = buildPrompt("I need to finish the report by Friday", "Sure, I can help!", "");
    expect(prompt).toContain("I need to finish the report by Friday");
  });

  test("includes assistant response", () => {
    const prompt = buildPrompt("Hello", "Sure, I can help!", "");
    expect(prompt).toContain("Sure, I can help!");
  });

  test("includes active goals when provided", () => {
    const goals = '- "Finish report" (id: g-1)\n- "Deploy API" (id: g-2)';
    const prompt = buildPrompt("Hello", "Sure!", goals);
    expect(prompt).toContain("Currently active goals:");
    expect(prompt).toContain("Finish report");
    expect(prompt).toContain("Deploy API");
  });

  test("shows 'No active goals' when goals list is empty", () => {
    const prompt = buildPrompt("Hello", "Sure!", "");
    expect(prompt).toContain("No active goals.");
    expect(prompt).not.toContain("Currently active goals:");
  });

  test("instructs JSON-only response format", () => {
    const prompt = buildPrompt("Hello", "Sure!", "");
    expect(prompt).toContain("Respond with ONLY valid JSON");
    expect(prompt).toContain("no markdown fences");
  });

  test("includes all three action types in instructions", () => {
    const prompt = buildPrompt("Hello", "Sure!", "");
    expect(prompt).toContain('"action": "none"');
    expect(prompt).toContain('"action": "new"');
    expect(prompt).toContain('"action": "completed"');
  });

  test("mentions ISO 8601 for deadlines", () => {
    const prompt = buildPrompt("Hello", "Sure!", "");
    expect(prompt).toContain("ISO 8601");
  });

  test("wraps user message in triple quotes", () => {
    const prompt = buildPrompt("Test message", "Reply", "");
    expect(prompt).toContain('User said: """\nTest message\n"""');
  });

  test("wraps assistant response in triple quotes", () => {
    const prompt = buildPrompt("Test", "Reply message", "");
    expect(prompt).toContain('Assistant replied: """\nReply message\n"""');
  });

  test("describes what counts as NEW goals", () => {
    const prompt = buildPrompt("Hello", "Sure!", "");
    expect(prompt).toContain("explicit goals");
    expect(prompt).toContain("commitments");
    expect(prompt).toContain("deadlines");
  });

  test("describes what NOT to detect", () => {
    const prompt = buildPrompt("Hello", "Sure!", "");
    expect(prompt).toContain("NOT worth detecting");
    expect(prompt).toContain("questions");
    expect(prompt).toContain("vague wishes");
  });
});
