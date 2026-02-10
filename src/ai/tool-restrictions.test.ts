import { test, expect, describe } from "bun:test";
import { getRestrictedToolsForUser, buildToolRestrictionPrompt } from "./tool-restrictions.ts";
import type { RestrictedTools } from "../bots/config.ts";

const SAMPLE_RESTRICTIONS: RestrictedTools = {
  "Gmail": {
    description: "Email access via Gmail MCP",
    allowedUsers: ["user-1", "user-2"],
  },
  "Calendar": {
    description: "Calendar access via Google Calendar",
    allowedUsers: ["user-1"],
  },
  "Notion": {
    description: "Notion workspace access",
    allowedUsers: ["user-3"],
  },
};

describe("getRestrictedToolsForUser", () => {
  test("returns empty array when no restrictions defined", () => {
    const result = getRestrictedToolsForUser("user-1");
    expect(result).toEqual([]);
  });

  test("returns empty array when undefined restrictions", () => {
    const result = getRestrictedToolsForUser("user-1", undefined);
    expect(result).toEqual([]);
  });

  test("returns denied groups for user without access", () => {
    const result = getRestrictedToolsForUser("user-99", SAMPLE_RESTRICTIONS);
    expect(result).toHaveLength(3);
    expect(result.map((g) => g.name).sort()).toEqual(["Calendar", "Gmail", "Notion"]);
  });

  test("returns only denied groups (user has partial access)", () => {
    const result = getRestrictedToolsForUser("user-2", SAMPLE_RESTRICTIONS);
    expect(result).toHaveLength(2);
    const names = result.map((g) => g.name).sort();
    expect(names).toEqual(["Calendar", "Notion"]);
  });

  test("returns nothing for fully authorized user", () => {
    // user-1 has Gmail and Calendar
    const result = getRestrictedToolsForUser("user-1", SAMPLE_RESTRICTIONS);
    // user-1 doesn't have Notion
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Notion");
  });

  test("includes description in denied groups", () => {
    const result = getRestrictedToolsForUser("user-99", SAMPLE_RESTRICTIONS);
    const gmail = result.find((g) => g.name === "Gmail");
    expect(gmail?.description).toBe("Email access via Gmail MCP");
  });
});

describe("buildToolRestrictionPrompt", () => {
  test("returns empty string for no denied groups", () => {
    expect(buildToolRestrictionPrompt([])).toBe("");
  });

  test("builds restriction prompt with tool list", () => {
    const denied = [
      { name: "Gmail", description: "Email access" },
      { name: "Calendar", description: "Calendar access" },
    ];
    const prompt = buildToolRestrictionPrompt(denied);
    expect(prompt).toContain("## Verktøyrestriksjoner");
    expect(prompt).toContain("- Gmail: Email access");
    expect(prompt).toContain("- Calendar: Calendar access");
    expect(prompt).toContain("ALDRI bruke");
  });

  test("includes rules about indirect requests", () => {
    const denied = [{ name: "Test", description: "Test tool" }];
    const prompt = buildToolRestrictionPrompt(denied);
    expect(prompt).toContain("indirekte forespørsler");
    expect(prompt).toContain("ikke har tilgang");
  });
});
