import { test, expect, describe } from "bun:test";
import { buildGmailQuery } from "./email.ts";

describe("buildGmailQuery", () => {
  test("always includes is:unread", () => {
    expect(buildGmailQuery(undefined, null)).toBe("is:unread");
  });

  test("appends the custom filter", () => {
    expect(buildGmailQuery("from:boss", null)).toBe("is:unread from:boss");
  });

  test("formats after: as YYYY/MM/DD", () => {
    // 2026-01-15 12:00 UTC — well inside the same Oslo day.
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(buildGmailQuery(undefined, ts)).toBe("is:unread after:2026/01/15");
  });

  test("uses the Oslo date, not UTC, just after UTC midnight", () => {
    // 2026-06-15 23:30 UTC is already 2026-06-16 01:30 in Oslo (UTC+2 in summer).
    const ts = Date.UTC(2026, 5, 15, 23, 30, 0);
    expect(buildGmailQuery(undefined, ts)).toBe("is:unread after:2026/06/16");
  });

  test("uses the Oslo date in winter (UTC+1)", () => {
    // 2026-01-15 23:30 UTC is 2026-01-16 00:30 in Oslo (UTC+1 in winter).
    const ts = Date.UTC(2026, 0, 15, 23, 30, 0);
    expect(buildGmailQuery(undefined, ts)).toBe("is:unread after:2026/01/16");
  });

  test("combines filter and date", () => {
    const ts = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(buildGmailQuery("from:boss", ts)).toBe("is:unread from:boss after:2026/01/15");
  });
});
