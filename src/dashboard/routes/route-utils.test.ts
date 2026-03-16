import { describe, test, expect } from "bun:test";
import { parseIntParam, isValidUuid } from "./route-utils.ts";

describe("parseIntParam", () => {
  test("returns default value for undefined input", () => {
    expect(parseIntParam(undefined, 10, 100)).toBe(10);
  });

  test("parses valid integer string", () => {
    expect(parseIntParam("25", 10, 100)).toBe(25);
  });

  test("returns default for NaN input", () => {
    expect(parseIntParam("abc", 10, 100)).toBe(10);
  });

  test("returns default for negative input", () => {
    expect(parseIntParam("-5", 10, 100)).toBe(10);
  });

  test("returns default for zero input", () => {
    expect(parseIntParam("0", 10, 100)).toBe(10);
  });

  test("clamps to max value", () => {
    expect(parseIntParam("200", 10, 100)).toBe(100);
  });

  test("returns exact max when input equals max", () => {
    expect(parseIntParam("100", 10, 100)).toBe(100);
  });

  test("returns default for empty string", () => {
    expect(parseIntParam("", 10, 100)).toBe(10);
  });
});

describe("isValidUuid", () => {
  test("returns true for valid UUID v4", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("returns true for uppercase UUID", () => {
    expect(isValidUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(isValidUuid("")).toBe(false);
  });

  test("returns false for non-UUID string", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
  });

  test("returns false for partial UUID", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716")).toBe(false);
  });

  test("returns false for UUID with extra characters", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000-extra")).toBe(false);
  });
});
