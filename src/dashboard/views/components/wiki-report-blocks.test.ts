import { test, expect, describe } from "bun:test";
import {
  LINE_REFS_KEY,
  daysSince,
  historicPillLabel,
  movesPillLabel,
  readLineRefsOn,
  writeLineRefsOn,
} from "./wiki-report-blocks.ts";

describe("NextMoves ages and pills", () => {
  // Local-time constructor: `daysSince` counts the viewer's calendar days.
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

  test("whole local days since a date; today and the future are 0; bad dates null", () => {
    expect(daysSince("2026-09-30", at(2026, 10, 1, 0))).toBe(1);
    expect(daysSince("2026-09-30", at(2026, 10, 1, 23))).toBe(1);
    expect(daysSince("2026-09-30", at(2026, 9, 30))).toBe(0);
    expect(daysSince("2026-10-05", at(2026, 10, 1))).toBe(0);
    expect(daysSince("2026-08-31", at(2026, 10, 1))).toBe(31);
    expect(daysSince("2026-02-31", at(2026, 10, 1))).toBeNull();
    expect(daysSince("30.09.2026", at(2026, 10, 1))).toBeNull();
  });

  test("a DST change does not shift the count", () => {
    // Europe DST ends 2026-10-25, US DST 2026-11-01: a 25-hour day still counts one.
    expect(daysSince("2026-10-24", at(2026, 10, 26))).toBe(2);
    expect(daysSince("2026-10-31", at(2026, 11, 2))).toBe(2);
    // …and a 23-hour spring day (Europe 2026-03-29, US 2026-03-08) is not lost.
    expect(daysSince("2026-03-28", at(2026, 3, 30, 0))).toBe(2);
    expect(daysSince("2026-03-07", at(2026, 3, 9, 0))).toBe(2);
  });

  test("pill labels", () => {
    expect(movesPillLabel("you", 3, null)).toBe("✋ 3 for you");
    expect(movesPillLabel("waiting", 2, 4)).toBe("⏳ waiting · 2");
    expect(movesPillLabel("draft", 2, 1)).toBe("✉ 2 not sent · 1 d");
    expect(movesPillLabel("draft", 1, null)).toBe("✉ 1 not sent");
  });
});

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
