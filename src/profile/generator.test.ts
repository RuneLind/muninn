import { test, expect, describe, mock, beforeEach } from "bun:test";

// --- Module mocks (registered before the dynamic import below) ---
// This file is run in an ISOLATED `bun test src/profile/` process (see the
// test:unit script), so these mock.module registrations can't leak into the
// large shared unit-test process.

let goals: unknown[] = [];
let memories: unknown[] = [];
const mockGetActiveGoals = mock(async () => goals);
const mockGetMemoriesForUser = mock(async () => memories);
mock.module("../db/goals.ts", () => ({ getActiveGoals: mockGetActiveGoals }));
mock.module("../db/memories.ts", () => ({ getMemoriesForUser: mockGetMemoriesForUser }));

let defaultUser: string | null = "user-1";
let defaultUserThrows = false;
const mockGetBotDefaultUser = mock(async () => {
  if (defaultUserThrows) throw new Error("db down");
  return defaultUser;
});
mock.module("../db/chat-preferences.ts", () => ({ getBotDefaultUser: mockGetBotDefaultUser }));

let storedProfile: { profile: string } | null = null;
const upsertCalls: Array<{ profile: string; derivedFrom: { goals: number; memories: number } }> = [];
const mockUpsert = mock(async (p: { profile: string; derivedFrom: { goals: number; memories: number } }) => {
  upsertCalls.push({ profile: p.profile, derivedFrom: p.derivedFrom });
});
const mockGetInterestProfile = mock(async () => storedProfile);
mock.module("../db/interest-profiles.ts", () => ({
  upsertInterestProfile: mockUpsert,
  getInterestProfile: mockGetInterestProfile,
}));

let haikuResult = "- Agents — building tool-using systems\n- Retrieval — RAG quality";
const mockCallHaiku = mock(async () => ({
  result: haikuResult,
  inputTokens: 100,
  outputTokens: 40,
  model: "claude-haiku-4-5-20251001",
}));
mock.module("../ai/haiku-direct.ts", () => ({ callHaikuWithFallback: mockCallHaiku }));

const { refreshInterestProfile, loadInterestProfileForBot } = await import("./generator.ts");

beforeEach(() => {
  goals = [];
  memories = [];
  defaultUser = "user-1";
  defaultUserThrows = false;
  storedProfile = null;
  haikuResult = "- Agents — building tool-using systems\n- Retrieval — RAG quality";
  upsertCalls.length = 0;
  mockCallHaiku.mockClear();
  mockUpsert.mockClear();
  mockGetActiveGoals.mockClear();
  mockGetMemoriesForUser.mockClear();
});

describe("refreshInterestProfile", () => {
  test("skips (no Haiku call, no upsert) when goals AND memories are both empty", async () => {
    goals = [];
    memories = [];
    await refreshInterestProfile("user-1", "jarvis");
    expect(mockCallHaiku).toHaveBeenCalledTimes(0);
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });

  test("builds + upserts a profile from goals/memories with derived-from counts", async () => {
    goals = [{ title: "Ship agent framework", description: "v2", tags: ["agents"] }];
    memories = [
      { summary: "Prefers Rust for perf-critical code", tags: ["rust"] },
      { summary: "Reads RAG papers weekly", tags: [] },
    ];
    await refreshInterestProfile("user-1", "jarvis");
    expect(mockCallHaiku).toHaveBeenCalledTimes(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.profile).toBe(haikuResult);
    expect(upsertCalls[0]!.derivedFrom).toEqual({ goals: 1, memories: 2 });
  });

  test("skips upsert when the model returns blank output (prior profile left intact)", async () => {
    goals = [{ title: "x", description: null, tags: [] }];
    haikuResult = "   \n  ";
    await refreshInterestProfile("user-1", "jarvis");
    expect(mockCallHaiku).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });

  test("swallows a Haiku error without throwing (best-effort)", async () => {
    goals = [{ title: "x", description: null, tags: [] }];
    mockCallHaiku.mockRejectedValueOnce(new Error("haiku exploded"));
    await expect(refreshInterestProfile("user-1", "jarvis")).resolves.toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });
});

describe("loadInterestProfileForBot", () => {
  test("returns null when botName is undefined", async () => {
    expect(await loadInterestProfileForBot(undefined)).toBeNull();
    expect(mockGetBotDefaultUser).toHaveBeenCalledTimes(0);
  });

  test("returns null when the bot has no default user", async () => {
    defaultUser = null;
    expect(await loadInterestProfileForBot("jarvis")).toBeNull();
  });

  test("returns null when there is no profile row", async () => {
    defaultUser = "user-1";
    storedProfile = null;
    expect(await loadInterestProfileForBot("jarvis")).toBeNull();
  });

  test("returns the stored profile text when present", async () => {
    defaultUser = "user-1";
    storedProfile = { profile: "- topic A\n- topic B" };
    expect(await loadInterestProfileForBot("jarvis")).toBe("- topic A\n- topic B");
  });

  test("returns null (never throws) on a DB error", async () => {
    defaultUserThrows = true;
    expect(await loadInterestProfileForBot("jarvis")).toBeNull();
  });
});
