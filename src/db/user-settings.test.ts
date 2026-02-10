import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getUserSettings, upsertUserSettings } from "./user-settings.ts";

setupTestDb();

describe("user-settings", () => {
  test("getUserSettings returns defaults for new user", async () => {
    const settings = await getUserSettings("new-user");
    expect(settings.userId).toBe("new-user");
    expect(settings.quietStart).toBeNull();
    expect(settings.quietEnd).toBeNull();
    expect(settings.timezone).toBe("Europe/Oslo");
  });

  test("upsertUserSettings creates new settings", async () => {
    await upsertUserSettings("u1", { quietStart: 22, quietEnd: 8 });
    const settings = await getUserSettings("u1");
    expect(settings.quietStart).toBe(22);
    expect(settings.quietEnd).toBe(8);
    expect(settings.timezone).toBe("Europe/Oslo");
  });

  test("upsertUserSettings updates existing settings", async () => {
    await upsertUserSettings("u1", { quietStart: 22, quietEnd: 8 });
    await upsertUserSettings("u1", { quietStart: 23, quietEnd: 7, timezone: "America/New_York" });

    const settings = await getUserSettings("u1");
    expect(settings.quietStart).toBe(23);
    expect(settings.quietEnd).toBe(7);
    expect(settings.timezone).toBe("America/New_York");
  });

  test("upsertUserSettings can clear quiet hours", async () => {
    await upsertUserSettings("u1", { quietStart: 22, quietEnd: 8 });
    await upsertUserSettings("u1", { quietStart: null, quietEnd: null });

    const settings = await getUserSettings("u1");
    expect(settings.quietStart).toBeNull();
    expect(settings.quietEnd).toBeNull();
  });

  test("upsertUserSettings with timezone only", async () => {
    await upsertUserSettings("u1", { timezone: "Asia/Tokyo" });

    const settings = await getUserSettings("u1");
    expect(settings.timezone).toBe("Asia/Tokyo");
    expect(settings.quietStart).toBeNull();
    expect(settings.quietEnd).toBeNull();
  });

  test("different users have independent settings", async () => {
    await upsertUserSettings("u1", { quietStart: 22, quietEnd: 8 });
    await upsertUserSettings("u2", { quietStart: 0, quietEnd: 6, timezone: "UTC" });

    const s1 = await getUserSettings("u1");
    const s2 = await getUserSettings("u2");

    expect(s1.quietStart).toBe(22);
    expect(s2.quietStart).toBe(0);
    expect(s2.timezone).toBe("UTC");
  });
});
