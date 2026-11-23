import { describe, expect, test } from "bun:test";
import { parseHandSample, UsageError } from "./script-roots.ts";

describe("parseHandSample: the hand sample's {read, wrong}", () => {
  test("two whole counts", () => {
    expect(parseHandSample('{"read": 5, "wrong": 1}')).toEqual({ read: 5, wrong: 1 });
  });

  test.each([
    ["not JSON", "not a file"],
    ["an empty object", "{}"],
    ["a missing count", '{"read": 5}'],
    ["a fraction", '{"read": 5.5, "wrong": 0}'],
    ["a negative", '{"read": 5, "wrong": -1}'],
    ["a string", '{"read": "5", "wrong": 0}'],
    ["null", "null"],
  ])("%s is a usage error", (_name, text) => {
    expect(() => parseHandSample(text)).toThrow(UsageError);
  });
});
