import { test, expect, describe, beforeEach } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  _resetSnapshotForTests,
  clearRoleOverride,
  getAllRoleOverrides,
  getRoleOverride,
  loadRoleOverrides,
  setRoleOverride,
} from "./role-overrides.ts";

setupTestDb();

describe("role-overrides", () => {
  beforeEach(async () => {
    // Start each test from a clean table + snapshot.
    await clearRoleOverride("SUMMARIZER_BOT");
    await clearRoleOverride("RESEARCH_BOT");
    await clearRoleOverride("HAIKU_BACKEND");
    _resetSnapshotForTests();
  });

  test("set → get reflects the write hot (snapshot refreshed, no reload)", async () => {
    expect(getRoleOverride("RESEARCH_BOT")).toBeUndefined();
    await setRoleOverride("RESEARCH_BOT", "capra");
    expect(getRoleOverride("RESEARCH_BOT")).toBe("capra");
  });

  test("clear → get falls back to undefined hot", async () => {
    await setRoleOverride("SUMMARIZER_BOT", "jarvis");
    expect(getRoleOverride("SUMMARIZER_BOT")).toBe("jarvis");
    await clearRoleOverride("SUMMARIZER_BOT");
    expect(getRoleOverride("SUMMARIZER_BOT")).toBeUndefined();
  });

  test("set is an upsert — second write replaces the value", async () => {
    await setRoleOverride("HAIKU_BACKEND", "anthropic");
    await setRoleOverride("HAIKU_BACKEND", "copilot");
    expect(getRoleOverride("HAIKU_BACKEND")).toBe("copilot");
  });

  test("loadRoleOverrides primes the snapshot from the DB (startup path)", async () => {
    await setRoleOverride("RESEARCH_BOT", "capra");
    await setRoleOverride("HAIKU_BACKEND", "cli");
    // Simulate a fresh process: wipe the in-memory snapshot, keep the DB rows.
    _resetSnapshotForTests();
    expect(getRoleOverride("RESEARCH_BOT")).toBeUndefined();

    await loadRoleOverrides();
    expect(getRoleOverride("RESEARCH_BOT")).toBe("capra");
    expect(getRoleOverride("HAIKU_BACKEND")).toBe("cli");
    expect(getAllRoleOverrides()).toEqual({ RESEARCH_BOT: "capra", HAIKU_BACKEND: "cli" });
  });
});
