import { describe, expect, test } from "bun:test";
import { itemDate, itemDateReference, itemDates, renderDay, resolveYearless } from "./item-dates.ts";
import shared from "./fixtures/reader-shared.json";

// D20/D22: the cases live in the shared fixture, which PR 5's plan-card port
// will read too, so both parsers answer the same inputs the same way.

interface ItemDateCase {
  name: string;
  text: string;
  statusDate: string | null;
  /** The render day: a later date is skipped (D49), and with no usable
   *  `statusDate` it is the reference for a yearless date. */
  today: string;
  expected: string | null;
}

const cases = shared.itemDateCases as ItemDateCase[];

describe("item dates (D20, D49), from the shared fixture", () => {
  test("the fixture covers the acceptance-8 kinds, D49's and the date expressions'", () => {
    expect(cases.length).toBeGreaterThanOrEqual(74);
  });
  for (const c of cases) {
    test(c.name, () => {
      expect(itemDate(c.text, itemDateReference(c.statusDate, c.today), c.today)).toBe(c.expected);
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
  test("status_date when it is a calendar day, else the render day", () => {
    expect(itemDateReference("2026-10-07", "2027-01-02")).toBe("2026-10-07");
    expect(itemDateReference(undefined, "2027-01-02")).toBe("2027-01-02");
    expect(itemDateReference("07.10.2026", "2027-01-02")).toBe("2027-01-02");
  });
});

describe("renderDay", () => {
  test("is the day in Europe/Oslo, whatever the process timezone", () => {
    // 22:30 UTC on 10 Oct is 00:30 on 11 Oct in Oslo (CEST), and 23:30 UTC on
    // 31 Dec is 00:30 on 1 Jan (CET).
    expect(renderDay(new Date(Date.UTC(2026, 9, 10, 22, 30)))).toBe("2026-10-11");
    expect(renderDay(new Date(Date.UTC(2026, 11, 31, 23, 30)))).toBe("2027-01-01");
    expect(renderDay(new Date(Date.UTC(2026, 9, 10, 21, 30)))).toBe("2026-10-10");
  });
});
