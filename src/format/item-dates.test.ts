import { describe, expect, test } from "bun:test";
import { itemDateReference, itemDates, lastItemDate, resolveYearless } from "./item-dates.ts";
import shared from "./fixtures/reader-shared.json";

// D20/D22: the cases live in the shared fixture, which plan-card's port reads
// too, so both parsers answer the same inputs the same way.

interface ItemDateCase {
  name: string;
  text: string;
  statusDate: string | null;
  today?: string;
  expected: string | null;
}

const cases = shared.itemDateCases as ItemDateCase[];

const localDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
};

describe("item dates (D20), from the shared fixture", () => {
  test("the fixture covers the acceptance-8 kinds", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
  for (const c of cases) {
    test(c.name, () => {
      const ref = itemDateReference(c.statusDate, c.today ? localDate(c.today) : new Date(2026, 9, 7, 12));
      expect(lastItemDate(c.text, ref)).toBe(c.expected);
    });
  }
});

describe("the nearest-year rule", () => {
  test("picks the candidate year nearest the reference", () => {
    expect(resolveYearless(18, 12, "2027-01-05")).toBe("2026-12-18");
    expect(resolveYearless(10, 10, "2026-10-07")).toBe("2026-10-10");
    expect(resolveYearless(5, 1, "2026-06-30")).toBe("2026-01-05");
  });
  test("183 days away is inside the window, a tie goes to the earlier day", () => {
    // 2028 is a leap year: 2028-01-01 → 2028-07-02 is 183 days, and so is
    // 2028-07-02 → 2029-01-01.
    expect(resolveYearless(1, 1, "2028-07-02")).toBe("2028-01-01");
  });
  test("a 29.02 more than six months from every leap day is null", () => {
    expect(resolveYearless(29, 2, "2026-10-07")).toBeNull();
    expect(resolveYearless(29, 2, "2027-09-01")).toBe("2028-02-29");
  });
});

describe("itemDates", () => {
  test("lists every date in order", () => {
    expect(itemDates("Spurt 01.10, besvart 2026-10-03, lukket 06.10.2026.", "2026-10-07")).toEqual([
      "2026-10-01",
      "2026-10-03",
      "2026-10-06",
    ]);
  });
  test("skips the reader's parked wikilinks and tags", () => {
    expect(itemDates('Se \x00WIKIPAGELINK12\x00 og <Fact n="1" v="ok">07.10</Fact>.', "2026-10-07")).toEqual(["2026-10-07"]);
  });
});

describe("itemDateReference", () => {
  test("status_date when it is a calendar day, else today's local day", () => {
    expect(itemDateReference("2026-10-07", new Date(2027, 0, 2))).toBe("2026-10-07");
    expect(itemDateReference(undefined, new Date(2027, 0, 2, 23, 59))).toBe("2027-01-02");
    expect(itemDateReference("07.10.2026", new Date(2027, 0, 2))).toBe("2027-01-02");
  });
});
