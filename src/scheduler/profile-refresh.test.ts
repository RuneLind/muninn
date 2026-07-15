import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { BotConfig } from "../bots/config.ts";

// --- Module mocks (registered before the dynamic import below) ---
// This file is run in an ISOLATED `bun test src/scheduler/profile-refresh.test.ts`
// process (see the test/test:unit scripts) so these mock.module registrations
// can't leak into the large shared unit-test process.

let owners: string[] = [];
const mockGetEnabledWatcherOwners = mock(async (_bot: string) => owners);
mock.module("../db/watchers.ts", () => ({ getEnabledWatcherOwners: mockGetEnabledWatcherOwners }));

// Which (user, bot) pairs are stale. Default: everything stale.
const staleKeys = new Set<string>();
let staleThrows = false;
const mockIsProfileStale = mock(async (userId: string, botName: string) => {
  if (staleThrows) throw new Error("db down");
  return staleKeys.has(`${botName}:${userId}`);
});
mock.module("../db/interest-profiles.ts", () => ({ isProfileStale: mockIsProfileStale }));

const refreshCalls: Array<{ userId: string; botName: string }> = [];
let refreshResolve: (() => void) | null = null;
const mockRefresh = mock(async (userId: string, botName: string) => {
  refreshCalls.push({ userId, botName });
  // Stay pending until released, so the in-flight guard can be exercised.
  await new Promise<void>((res) => (refreshResolve = res));
});
mock.module("../profile/generator.ts", () => ({ refreshInterestProfile: mockRefresh }));

const { maybeRefreshInterestProfile, __resetProfileRefreshInFlight } =
  await import("./profile-refresh.ts");

const botConfig = { name: "jarvis", connector: "claude-cli" } as unknown as BotConfig;

beforeEach(() => {
  owners = [];
  staleKeys.clear();
  staleThrows = false;
  refreshCalls.length = 0;
  refreshResolve = null;
  mockGetEnabledWatcherOwners.mockClear();
  mockIsProfileStale.mockClear();
  mockRefresh.mockClear();
  __resetProfileRefreshInFlight();
});

describe("maybeRefreshInterestProfile — refreshes per watcher owner", () => {
  test("refreshes each distinct stale watcher owner with its OWN userId", async () => {
    owners = ["owner-a", "owner-b"];
    staleKeys.add("jarvis:owner-a");
    staleKeys.add("jarvis:owner-b");

    await maybeRefreshInterestProfile(botConfig);

    expect(mockGetEnabledWatcherOwners).toHaveBeenCalledWith("jarvis");
    expect(refreshCalls.map((c) => c.userId).sort()).toEqual(["owner-a", "owner-b"]);
    expect(refreshCalls.every((c) => c.botName === "jarvis")).toBe(true);
  });

  test("skips owners whose profile is fresh", async () => {
    owners = ["fresh", "stale"];
    staleKeys.add("jarvis:stale"); // "fresh" is not stale

    await maybeRefreshInterestProfile(botConfig);

    expect(refreshCalls.map((c) => c.userId)).toEqual(["stale"]);
  });

  test("refreshes nobody when the bot owns no enabled watchers", async () => {
    owners = [];
    await maybeRefreshInterestProfile(botConfig);
    expect(refreshCalls).toHaveLength(0);
  });

  test("in-flight guard (keyed on bot:user) prevents re-dispatch before the row lands", async () => {
    owners = ["owner-a"];
    staleKeys.add("jarvis:owner-a");

    await maybeRefreshInterestProfile(botConfig); // dispatches, stays pending
    await maybeRefreshInterestProfile(botConfig); // should be guarded out

    expect(refreshCalls).toHaveLength(1);

    // Release the in-flight refresh; its .finally clears the guard.
    refreshResolve?.();
    await Promise.resolve();
    await Promise.resolve();

    await maybeRefreshInterestProfile(botConfig); // now dispatches again
    expect(refreshCalls).toHaveLength(2);
  });

  test("never throws when the staleness check errors (best-effort)", async () => {
    owners = ["owner-a"];
    staleThrows = true;
    await expect(maybeRefreshInterestProfile(botConfig)).resolves.toBeUndefined();
    expect(refreshCalls).toHaveLength(0);
  });
});
