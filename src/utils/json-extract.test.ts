import { test, expect, describe } from "bun:test";
import { extractJson } from "./json-extract.ts";

describe("extractJson", () => {
  test("parses clean JSON directly", () => {
    const result = extractJson<{ action: string }>('{"action": "none"}');
    expect(result).toEqual({ action: "none" });
  });

  test("parses JSON wrapped in markdown fences", () => {
    const input = '```json\n{"worth_remembering": true, "summary": "Test"}\n```';
    const result = extractJson<{ worth_remembering: boolean; summary: string }>(input);
    expect(result.worth_remembering).toBe(true);
    expect(result.summary).toBe("Test");
  });

  test("parses JSON wrapped in plain fences (no language tag)", () => {
    const input = '```\n{"has_schedule": false}\n```';
    const result = extractJson<{ has_schedule: boolean }>(input);
    expect(result.has_schedule).toBe(false);
  });

  test("extracts JSON embedded in natural language preamble", () => {
    const input = 'Here is the analysis result:\n{"action": "new", "title": "Finish report"}';
    const result = extractJson<{ action: string; title: string }>(input);
    expect(result.action).toBe("new");
    expect(result.title).toBe("Finish report");
  });

  test("extracts JSON with trailing text", () => {
    const input = '{"worth_remembering": false}\nLet me know if you need anything else.';
    const result = extractJson<{ worth_remembering: boolean }>(input);
    expect(result.worth_remembering).toBe(false);
  });

  test("extracts JSON surrounded by preamble and epilogue", () => {
    const input =
      'Based on the conversation, here is my assessment:\n{"action": "none"}\nI hope this helps!';
    const result = extractJson<{ action: string }>(input);
    expect(result.action).toBe("none");
  });

  test("handles nested braces in JSON values", () => {
    const input = 'Result: {"data": {"nested": true}, "count": 1}';
    const result = extractJson<{ data: { nested: boolean }; count: number }>(input);
    expect(result.data.nested).toBe(true);
    expect(result.count).toBe(1);
  });

  test("handles braces inside string values", () => {
    const input = '{"summary": "User said {hello} and {goodbye}", "tags": ["greeting"]}';
    const result = extractJson<{ summary: string; tags: string[] }>(input);
    expect(result.summary).toBe("User said {hello} and {goodbye}");
    expect(result.tags).toEqual(["greeting"]);
  });

  test("handles escaped quotes inside strings", () => {
    const input = '{"summary": "User said \\"hello\\" to the bot"}';
    const result = extractJson<{ summary: string }>(input);
    expect(result.summary).toBe('User said "hello" to the bot');
  });

  test("throws on no JSON found", () => {
    expect(() => extractJson("No JSON here at all")).toThrow("Failed to extract JSON");
  });

  test("throws on malformed JSON", () => {
    expect(() => extractJson("{not: valid json}")).toThrow();
  });

  test("handles CLI 2.x content array text that is clean JSON", () => {
    const text = '{"worth_remembering": false}';
    const result = extractJson<{ worth_remembering: boolean }>(text);
    expect(result.worth_remembering).toBe(false);
  });

  // Fix 1: Stray brace in preamble — retries from next {
  test("skips stray brace in preamble and finds real JSON", () => {
    const input = 'Here is the {result}:\n{"action": "none"}';
    const result = extractJson<{ action: string }>(input);
    expect(result.action).toBe("none");
  });

  test("skips multiple stray braces before real JSON", () => {
    const input = 'See {this} and {that} then: {"valid": true}';
    const result = extractJson<{ valid: boolean }>(input);
    expect(result.valid).toBe(true);
  });

  // Fix 2: Input guards
  test("throws on empty string", () => {
    expect(() => extractJson("")).toThrow("input must be a non-empty string");
  });

  test("throws on null input", () => {
    expect(() => extractJson(null as unknown as string)).toThrow("input must be a non-empty string");
  });

  test("throws on undefined input", () => {
    expect(() => extractJson(undefined as unknown as string)).toThrow("input must be a non-empty string");
  });

  // Fix 3: Array support
  test("parses clean JSON array directly", () => {
    const result = extractJson<string[]>('["a", "b", "c"]');
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("extracts JSON array from preamble text", () => {
    const input = 'Here are the results:\n[{"id": "1", "source": "email"}]\nDone.';
    const result = extractJson<Array<{ id: string; source: string }>>(input);
    expect(result).toEqual([{ id: "1", source: "email" }]);
  });

  test("extracts empty JSON array", () => {
    const input = "No new emails found.\n[]";
    const result = extractJson<unknown[]>(input);
    expect(result).toEqual([]);
  });

  test("extracts JSON array wrapped in markdown fences", () => {
    const input = '```json\n[{"id": "abc"}]\n```';
    const result = extractJson<Array<{ id: string }>>(input);
    expect(result).toEqual([{ id: "abc" }]);
  });

  test("prefers object over array when both present", () => {
    // Object extraction is tried first
    const input = 'preamble {"key": "val"} then [1,2,3]';
    const result = extractJson<{ key: string }>(input);
    expect(result).toEqual({ key: "val" });
  });
});
