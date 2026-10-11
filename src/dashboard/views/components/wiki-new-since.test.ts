import { describe, expect, test } from "bun:test";
import {
  LAST_VISIT_KEY,
  LAST_VISIT_MAX,
  localIsoDay,
  readLastVisit,
  visitDateText,
  visitKey,
  writeLastVisit,
} from "./wiki-new-since.ts";

// The DOM half (marks, the head line) is driven in e2e/wiki-new-since.spec.ts.

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

describe("last visit store", () => {
  test("a first visit reads null, then the stored time", () => {
    const s = memory();
    const key = visitKey("w", "plans/a.mdx");
    expect(readLastVisit(s, key)).toBeNull();
    writeLastVisit(s, key, 1_000);
    expect(readLastVisit(s, key)).toBe(1_000);
    expect(readLastVisit(s, visitKey("w", "plans/b.mdx"))).toBeNull();
    expect(readLastVisit(s, visitKey("other", "plans/a.mdx"))).toBeNull();
  });

  test("garbage, a wrong shape and bad values read as no visit", () => {
    const s = memory();
    s.data.set(LAST_VISIT_KEY, "{not json");
    expect(readLastVisit(s, "k")).toBeNull();
    s.data.set(LAST_VISIT_KEY, "[1,2]");
    expect(readLastVisit(s, "0")).toBeNull();
    s.data.set(LAST_VISIT_KEY, JSON.stringify({ k: "12", j: -1, n: Number.NaN }));
    expect(readLastVisit(s, "k")).toBeNull();
    expect(readLastVisit(s, "j")).toBeNull();
    // Inherited keys are not visits.
    expect(readLastVisit(s, "toString")).toBeNull();
  });

  test("a throwing or missing storage is no visit and no throw", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLastVisit(throwing, "k")).toBeNull();
    expect(() => writeLastVisit(throwing, "k", 1)).not.toThrow();
    expect(readLastVisit(undefined, "k")).toBeNull();
  });

  test("keeps the newest visits at the cap", () => {
    const s = memory();
    for (let i = 1; i <= LAST_VISIT_MAX + 5; i++) writeLastVisit(s, `k${i}`, i);
    const stored = JSON.parse(s.data.get(LAST_VISIT_KEY)!);
    expect(Object.keys(stored).length).toBe(LAST_VISIT_MAX);
    expect(readLastVisit(s, "k1")).toBeNull();
    expect(readLastVisit(s, `k${LAST_VISIT_MAX + 5}`)).toBe(LAST_VISIT_MAX + 5);
  });
});

describe("visit dates", () => {
  test("the local day, and DD.MM in this year else DD.MM.YYYY", () => {
    const visit = new Date(2026, 9, 7, 23, 30).getTime();
    expect(localIsoDay(visit)).toBe("2026-10-07");
    expect(visitDateText(visit, new Date(2026, 9, 11))).toBe("07.10");
    expect(visitDateText(visit, new Date(2027, 0, 2))).toBe("07.10.2026");
  });
});
