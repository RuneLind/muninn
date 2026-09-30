import { test, expect, describe } from "bun:test";
import { LINE_REFS_KEY, historicPillLabel, readLineRefsOn, writeLineRefsOn } from "./wiki-report-blocks.ts";

describe("line refs preference", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  test("default is on", () => expect(readLineRefsOn(mem())).toBe(true));
  test("no storage reads as on", () => expect(readLineRefsOn(undefined)).toBe(true));
  test("a throwing storage reads as on and a write does not throw", () => {
    const boom = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(readLineRefsOn(boom)).toBe(true);
    expect(() => writeLineRefsOn(boom, false)).not.toThrow();
  });
  test("off round-trips under the versioned key", () => {
    const s = mem();
    writeLineRefsOn(s, false);
    expect(s.m.get(LINE_REFS_KEY)).toBe("off");
    expect(readLineRefsOn(s)).toBe(false);
    writeLineRefsOn(s, true);
    expect(readLineRefsOn(s)).toBe(true);
  });
});

test("historic pill label", () => expect(historicPillLabel(2)).toBe("↻ 2 historic"));
