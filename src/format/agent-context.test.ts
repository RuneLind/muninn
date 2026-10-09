import { describe, expect, test } from "bun:test";
import { AGENT_CONTEXT_FOLD_NAMES, isAgentContextTitle } from "./agent-context.ts";
import shared from "./fixtures/reader-shared.json";

describe("agent-context fold names (D22)", () => {
  test("the list is the shared fixture's, in order", () => {
    expect([...AGENT_CONTEXT_FOLD_NAMES]).toEqual(shared.agentContextFoldNames);
  });
  test("a title that starts with a name, any case, followed by a non-letter", () => {
    for (const name of AGENT_CONTEXT_FOLD_NAMES) {
      expect(isAgentContextTitle(name)).toBe(true);
      expect(isAgentContextTitle(`${name.toUpperCase()} — 08.10`)).toBe(true);
    }
    expect(isAgentContextTitle("Nåtilstand (08.10)")).toBe(true);
    expect(isAgentContextTitle("Handoffs")).toBe(false);
    expect(isAgentContextTitle("Current statement")).toBe(false);
    expect(isAgentContextTitle("Spørringer")).toBe(false);
    expect(isAgentContextTitle("")).toBe(false);
  });
});
