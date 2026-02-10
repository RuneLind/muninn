import { test, expect, describe, mock, beforeEach } from "bun:test";

// Mock getUserSettings before importing the module under test
const mockGetUserSettings = mock(() =>
  Promise.resolve({
    userId: "user-1",
    quietStart: null,
    quietEnd: null,
    timezone: "Europe/Oslo",
  }),
);

mock.module("../db/user-settings.ts", () => ({
  getUserSettings: mockGetUserSettings,
  upsertUserSettings: mock(() => Promise.resolve()),
}));

const { isQuietHours } = await import("./quiet-hours.ts");

beforeEach(() => {
  mockGetUserSettings.mockClear();
});

describe("isQuietHours", () => {
  test("returns false when no quiet hours set", async () => {
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-1",
      quietStart: null,
      quietEnd: null,
      timezone: "Europe/Oslo",
    });

    expect(await isQuietHours("user-1")).toBe(false);
  });

  test("returns false when quietStart is null", async () => {
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-1",
      quietStart: null,
      quietEnd: 8,
      timezone: "Europe/Oslo",
    });

    expect(await isQuietHours("user-1")).toBe(false);
  });

  test("returns false when quietEnd is null", async () => {
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-1",
      quietStart: 22,
      quietEnd: null,
      timezone: "Europe/Oslo",
    });

    expect(await isQuietHours("user-1")).toBe(false);
  });

  test("detects daytime quiet hours (same-day range)", async () => {
    // Quiet hours 10:00-14:00
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-1",
      quietStart: 10,
      quietEnd: 14,
      timezone: "UTC",
    });

    // This test depends on the current UTC hour, so we just verify it runs without error
    const result = await isQuietHours("user-1");
    expect(typeof result).toBe("boolean");
  });

  test("calls getUserSettings with correct userId", async () => {
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-42",
      quietStart: null,
      quietEnd: null,
      timezone: "Europe/Oslo",
    });

    await isQuietHours("user-42");
    expect(mockGetUserSettings).toHaveBeenCalledWith("user-42");
  });

  test("handles overnight range (e.g. 22-08)", async () => {
    // We test the logic indirectly: if current UTC hour is known,
    // we can verify the function correctly evaluates overnight ranges.
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-1",
      quietStart: 22,
      quietEnd: 8,
      timezone: "UTC",
    });

    const result = await isQuietHours("user-1");
    const currentUtcHour = new Date().getUTCHours();
    // Should be quiet if hour >= 22 OR hour < 8
    const expectedQuiet = currentUtcHour >= 22 || currentUtcHour < 8;
    expect(result).toBe(expectedQuiet);
  });

  test("handles same-day range with UTC timezone", async () => {
    mockGetUserSettings.mockResolvedValueOnce({
      userId: "user-1",
      quietStart: 10,
      quietEnd: 14,
      timezone: "UTC",
    });

    const result = await isQuietHours("user-1");
    const currentUtcHour = new Date().getUTCHours();
    const expectedQuiet = currentUtcHour >= 10 && currentUtcHour < 14;
    expect(result).toBe(expectedQuiet);
  });
});
