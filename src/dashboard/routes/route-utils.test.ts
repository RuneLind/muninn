import { describe, test, expect } from "bun:test";
import { parseIntParam, isValidUuid, clampIntQuery } from "./route-utils.ts";

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

/**
 * Ported verbatim from the two byte-identical copies this replaced — `clampDays` in
 * `dashboard/claude-usage-overview.ts` (mirroring claude-usage's upstream `clampInt`)
 * and `clampRecentWindowDays` in `db/summary-candidates.ts`. Both call sites keep their
 * own min/max/fallback; only the parse rule is shared.
 */
describe("clampIntQuery", () => {
  const USAGE = { min: 1, max: 90, fallback: 14 };
  const WINDOW = { min: 1, max: 90, fallback: 7 };

  test("absent / blank / unparseable ⇒ the caller's fallback", () => {
    expect(clampIntQuery(undefined, USAGE)).toBe(14);
    expect(clampIntQuery(null, WINDOW)).toBe(7);
    expect(clampIntQuery("", USAGE)).toBe(14);
    expect(clampIntQuery("   ", USAGE)).toBe(14);
    expect(clampIntQuery("abc", WINDOW)).toBe(7);
    expect(clampIntQuery("NaN", WINDOW)).toBe(7);
  });

  test("clamps to the caller's range rather than erroring", () => {
    expect(clampIntQuery("0", USAGE)).toBe(1);
    expect(clampIntQuery("-5", USAGE)).toBe(1);
    expect(clampIntQuery("900", USAGE)).toBe(90);
    expect(clampIntQuery("7", USAGE)).toBe(7);
    expect(clampIntQuery("21", WINDOW)).toBe(21);
  });

  test("Number()+round semantics, not parseInt", () => {
    // parseInt would read these as 1, 12 and 7 — i.e. answer a different window than the
    // query string asked for, and (for claude-usage) a different one than the service.
    expect(clampIntQuery("1e2", USAGE)).toBe(90); // parseInt reads "1"
    expect(clampIntQuery("7.9", USAGE)).toBe(8); // parseInt truncates to 7
    expect(clampIntQuery("12abc", USAGE)).toBe(14); // parseInt reads 12
    expect(clampIntQuery("1e9", USAGE)).toBe(90);
    expect(clampIntQuery("0x5a", USAGE)).toBe(90); // Number("0x5a") === 90, upstream's own semantics
    expect(clampIntQuery(" 5 ", USAGE)).toBe(5);
  });

  test("a non-finite literal takes the FALLBACK, not the max", () => {
    // Documented rather than clamped: `Number("Infinity")` is finite-checked away, so
    // `?days=Infinity` answers the default window, not 90.
    expect(clampIntQuery("Infinity", USAGE)).toBe(14);
    expect(clampIntQuery("-Infinity", USAGE)).toBe(14);
  });
});
