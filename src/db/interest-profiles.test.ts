import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  getInterestProfile,
  upsertInterestProfile,
  isProfileStale,
} from "./interest-profiles.ts";
import { getDb } from "./client.ts";

setupTestDb();

describe("interest-profiles", () => {
  test("getInterestProfile returns null when no row exists", async () => {
    expect(await getInterestProfile("u1", "jarvis")).toBeNull();
  });

  test("upsert inserts a new profile and getInterestProfile reads it back", async () => {
    await upsertInterestProfile({
      userId: "u1",
      botName: "jarvis",
      profile: "- Agents\n- Retrieval",
      derivedFrom: { goals: 2, memories: 5 },
    });
    const row = await getInterestProfile("u1", "jarvis");
    expect(row).not.toBeNull();
    expect(row!.profile).toBe("- Agents\n- Retrieval");
    expect(row!.derivedFrom).toEqual({ goals: 2, memories: 5 });
    expect(row!.userId).toBe("u1");
    expect(row!.botName).toBe("jarvis");
    expect(typeof row!.updatedAt).toBe("number");
  });

  test("upsert replaces profile + derived_from on conflict (user_id, bot_name)", async () => {
    await upsertInterestProfile({
      userId: "u1",
      botName: "jarvis",
      profile: "- old",
      derivedFrom: { goals: 1, memories: 1 },
    });
    await upsertInterestProfile({
      userId: "u1",
      botName: "jarvis",
      profile: "- new",
      derivedFrom: { goals: 3, memories: 9 },
    });
    const row = await getInterestProfile("u1", "jarvis");
    expect(row!.profile).toBe("- new");
    expect(row!.derivedFrom).toEqual({ goals: 3, memories: 9 });
  });

  test("profiles are scoped per (user, bot)", async () => {
    await upsertInterestProfile({ userId: "u1", botName: "jarvis", profile: "- j", derivedFrom: { goals: 0, memories: 1 } });
    await upsertInterestProfile({ userId: "u1", botName: "melosys", profile: "- m", derivedFrom: { goals: 0, memories: 1 } });
    expect((await getInterestProfile("u1", "jarvis"))!.profile).toBe("- j");
    expect((await getInterestProfile("u1", "melosys"))!.profile).toBe("- m");
    expect(await getInterestProfile("u2", "jarvis")).toBeNull();
  });

  describe("isProfileStale", () => {
    test("returns true when no profile row exists", async () => {
      expect(await isProfileStale("nobody", "jarvis", 7)).toBe(true);
    });

    test("returns false for a freshly-written profile", async () => {
      await upsertInterestProfile({ userId: "u1", botName: "jarvis", profile: "- x", derivedFrom: { goals: 0, memories: 1 } });
      expect(await isProfileStale("u1", "jarvis", 7)).toBe(false);
    });

    test("returns true when the profile is older than the staleness window", async () => {
      await upsertInterestProfile({ userId: "u1", botName: "jarvis", profile: "- x", derivedFrom: { goals: 0, memories: 1 } });
      // Backdate updated_at 10 days into the past — beyond the 7-day window.
      const sql = getDb();
      await sql`
        UPDATE interest_profiles
        SET updated_at = now() - interval '10 days'
        WHERE user_id = 'u1' AND bot_name = 'jarvis'
      `;
      expect(await isProfileStale("u1", "jarvis", 7)).toBe(true);
      // A wider window still counts the same row as fresh.
      expect(await isProfileStale("u1", "jarvis", 30)).toBe(false);
    });
  });
});
