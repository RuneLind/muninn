import { describe, expect, test } from "bun:test";
import { pageNewerThanRun, pageNewestMs } from "./ids.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RUN = Date.parse("2026-10-29T12:00:00Z");
const NOW = RUN + 6 * HOUR;

describe("pageNewerThanRun: no git dates", () => {
  test("a clean page git knows nothing about is not newer on its mtime or birthtime (a checkout, clone or pull stamps both)", () => {
    expect(pageNewerThanRun({ mtimeMs: RUN + HOUR, birthtimeMs: RUN + HOUR }, RUN, NOW)).toBe(false);
    expect(pageNewerThanRun({ mtimeMs: RUN + HOUR, birthtimeMs: RUN + HOUR, gitDirty: false }, RUN, NOW)).toBe(false);
  });

  test("an untracked page (dirty, no git dates) is newer", () => {
    expect(pageNewerThanRun({ gitDirty: true, mtimeMs: RUN - DAY, birthtimeMs: RUN - DAY }, RUN, NOW)).toBe(true);
  });

  test("a worked-on date after the run still counts without git dates", () => {
    expect(pageNewerThanRun({ workedMs: RUN + HOUR, mtimeMs: RUN + HOUR }, RUN, NOW)).toBe(true);
  });
});

describe("pageNewerThanRun: future dates", () => {
  const FUTURE = NOW + 365 * DAY;
  test("a commit dated in the future is ignored", () => {
    expect(pageNewerThanRun({ gitCreatedMs: RUN - DAY, gitTouchedMs: FUTURE }, RUN, NOW)).toBe(false);
    expect(pageNewerThanRun({ gitCreatedMs: FUTURE }, RUN, NOW)).toBe(false);
  });

  test("a worked date in the future is ignored", () => {
    expect(pageNewerThanRun({ gitCreatedMs: RUN - DAY, workedMs: FUTURE }, RUN, NOW)).toBe(false);
  });

  test("a date inside the 48h skew window still counts", () => {
    expect(pageNewerThanRun({ gitCreatedMs: RUN - DAY, gitTouchedMs: NOW + 47 * HOUR }, RUN, NOW)).toBe(true);
  });

  test("a slow viewer clock is anchored to the run, so a real commit after the run is not judged future", () => {
    expect(pageNewerThanRun({ gitCreatedMs: RUN - DAY, gitTouchedMs: RUN + DAY }, RUN, RUN - 10 * DAY)).toBe(true);
  });
});

describe("pageNewestMs", () => {
  test("a tracked dirty page counts its mtime, as the reader's update signal does", () => {
    expect(pageNewestMs({ gitDirty: true, gitCreatedMs: RUN - 30 * DAY, gitTouchedMs: RUN - 20 * DAY, mtimeMs: RUN + 5 * HOUR }, NOW)).toBe(RUN + 5 * HOUR);
  });

  test("a tracked clean page ignores its mtime", () => {
    expect(pageNewestMs({ gitCreatedMs: RUN - 30 * DAY, gitTouchedMs: RUN - 20 * DAY, mtimeMs: RUN + 5 * HOUR }, NOW)).toBe(RUN - 20 * DAY);
  });

  test("a future mtime on a dirty page is ignored", () => {
    expect(pageNewestMs({ gitDirty: true, gitCreatedMs: RUN - 30 * DAY, mtimeMs: NOW + 365 * DAY }, NOW)).toBe(RUN - 30 * DAY);
  });
});
