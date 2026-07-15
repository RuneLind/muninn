import { test, expect, describe, mock, beforeEach } from "bun:test";
import { agentStatus } from "../observability/agent-status.ts";

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

const { refreshInterestProfile, loadInterestProfileForBot, loadInterestProfile, isValidProfileShape } =
  await import("./generator.ts");

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

  test("rejects (no upsert) model output with no bullet lines — refusals/prose", async () => {
    goals = [{ title: "x", description: null, tags: [] }];
    haikuResult = "I'm sorry, but I can't create a profile from this information.";
    await refreshInterestProfile("user-1", "jarvis");
    expect(mockCallHaiku).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });

  test("rejects (no upsert) model output over the length cap", async () => {
    goals = [{ title: "x", description: null, tags: [] }];
    haikuResult = "- runaway bullet " + "x".repeat(2000);
    await refreshInterestProfile("user-1", "jarvis");
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });
});

describe("isValidProfileShape", () => {
  test("accepts bullet lists under the cap (-, •, *)", () => {
    expect(isValidProfileShape("- a\n- b")).toBe(true);
    expect(isValidProfileShape("• a")).toBe(true);
    expect(isValidProfileShape("* a")).toBe(true);
    // Bullets can start after a non-bullet first line, too.
    expect(isValidProfileShape("interests:\n- a")).toBe(true);
  });

  test("rejects prose without bullets and over-long output", () => {
    expect(isValidProfileShape("Sorry, I cannot help with that.")).toBe(false);
    expect(isValidProfileShape("- ok\n" + "y".repeat(1600))).toBe(false);
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

describe("loadInterestProfile (explicit user — the identity the agent runs as)", () => {
  beforeEach(() => {
    mockGetInterestProfile.mockClear();
    mockGetBotDefaultUser.mockClear();
  });

  test("returns null when userId is undefined", async () => {
    expect(await loadInterestProfile(undefined, "jarvis")).toBeNull();
    expect(mockGetInterestProfile).toHaveBeenCalledTimes(0);
  });

  test("returns null when botName is undefined", async () => {
    expect(await loadInterestProfile("user-9", undefined)).toBeNull();
    expect(mockGetInterestProfile).toHaveBeenCalledTimes(0);
  });

  test("loads the profile for the PASSED user — never resolves via bot_default_user", async () => {
    defaultUser = "user-1"; // the web-chat acting persona
    storedProfile = { profile: "- watcher owner topic" };
    const out = await loadInterestProfile("watcher-owner-2", "jarvis");
    expect(out).toBe("- watcher owner topic");
    // The explicit user is what reaches the DB, not bot_default_user.
    expect(mockGetInterestProfile).toHaveBeenCalledWith("watcher-owner-2", "jarvis");
    expect(mockGetBotDefaultUser).toHaveBeenCalledTimes(0);
  });

  test("returns null when there is no profile row", async () => {
    storedProfile = null;
    expect(await loadInterestProfile("user-9", "jarvis")).toBeNull();
  });

  test("returns null (never throws) on a DB error", async () => {
    mockGetInterestProfile.mockRejectedValueOnce(new Error("db down"));
    expect(await loadInterestProfile("user-9", "jarvis")).toBeNull();
  });
});

// ── Observability ────────────────────────────────────────────────────────────
// `profile` was a declared AgentKind with no producer: the weekly distillation
// ran entirely unobserved. Recent rows come from its `haiku_usage` row (the
// extractor path), so the registry run is the LIVE signal — and it must settle
// on every path, including the two early returns that neither throw nor fall
// through (empty output, shape gate).

describe("refreshInterestProfile — observability", () => {
  beforeEach(() => agentStatus.clearRequest());

  function profileRuns() {
    return agentStatus.getAll().filter((r) => r.kind === "profile");
  }

  test("registers a profile run carrying the bot, model and tokens", async () => {
    goals = [{ title: "Ship the agent dashboard", description: "", tags: [] }] as never;
    await refreshInterestProfile("user-1", "jarvis");

    const runs = agentStatus.getRecentCompleted().filter((r) => r.kind === "profile");
    expect(runs).toHaveLength(1);
    expect(runs[0]!).toMatchObject({
      botName: "jarvis",
      name: "Interest profile: jarvis",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 100,
      outputTokens: 40,
    });
    expect(profileRuns().some((r) => !r.completed)).toBe(false);
  });

  test("registers NO run when there is nothing to distil (the skip path)", async () => {
    goals = [];
    memories = [];
    await refreshInterestProfile("user-1", "jarvis");
    // Registering before the skip would flash a run on /agents every scheduler tick.
    expect(profileRuns()).toHaveLength(0);
  });

  test("settles the run when the output fails the shape gate (early return, no throw)", async () => {
    goals = [{ title: "Ship it", description: "", tags: [] }] as never;
    haikuResult = "I'm sorry, I can't help with that."; // no bullets ⇒ shape gate rejects
    await refreshInterestProfile("user-1", "jarvis");

    expect(upsertCalls).toHaveLength(0);           // nothing persisted
    expect(profileRuns().some((r) => !r.completed)).toBe(false); // but the run still settled
  });
});
