/**
 * Acceptance for the shipped template set, the per-bot merge and the tool fence.
 *
 * Two things only this file can see:
 *
 *   1. **Picker ORDER is a contract.** The variant loader sorts discovered ids
 *      with `localeCompare`, so a set keyed by id would render `bug, spike,
 *      story, task`. The shipped array's order is asserted literally.
 *   2. **The fence is written in the CONNECTOR's dialect.** An `mcp__*` list
 *      matches nothing on copilot and ships inert — muninn's signature failure —
 *      so the pattern strings are asserted per connector, not just "some fence
 *      exists".
 */

import { test, expect, describe } from "bun:test";
import { findJiraTemplate, resolveJiraTemplates, SHIPPED_JIRA_TEMPLATES } from "./templates.ts";
import { buildDepthFence, mcpWireName, JIRA_FULL_MCP_SERVERS } from "./tool-fence.ts";
import type { McpServerStatus } from "../ai/mcp-status.ts";

const server = (name: string, tools: string[]): McpServerStatus => ({
  name,
  displayName: name,
  status: "ok",
  toolCount: tools.length,
  tools: tools.map((t) => ({ name: t })),
  lastCheckedMs: Date.now(),
  critical: false,
});

/** The wire names probed off melosys's five running servers, 2026-08-22. */
const MELOSYS_SERVERS: McpServerStatus[] = [
  server("code", ["search_tools", "call_tool"]),
  server("yggdrasil", [
    "search", "symbol_context", "impact", "detect_changes", "analyze_ticket",
    "file_outline", "read_source", "list_repos", "search_pattern", "list_files",
  ]),
  server("knowledge", [
    "search_knowledge", "get_document", "list_collections", "list_tags",
    "get_graph_node", "get_graph_subtree",
  ]),
  server("hivemind", ["list_peers", "ask_peer", "send_to_peer", "delegate_task"]),
  server("research", ["research_knowledge"]),
];

describe("shipped templates", () => {
  test("four ids, in PICKER order — not alphabetical", () => {
    expect(SHIPPED_JIRA_TEMPLATES.map((t) => t.id)).toEqual(["bug", "story", "task", "spike"]);
  });

  test("every shipped template carries the measured paste subset and the no-references rule", () => {
    for (const t of SHIPPED_JIRA_TEMPLATES) {
      expect(t.content).toContain("ALDRI: HTML-tagger");
      expect(t.content).toContain("Ingen oppdiktede saksnumre");
      // `## Referanser` is server-appended; a model-written one would be the
      // fabricated-key surface all over again.
      expect(t.content).toContain("Ikke skriv en «## Referanser»-seksjon");
    }
  });

  test("acceptance criteria are PLAIN BULLETS — PR 0 measured task lists as non-converting", () => {
    const bug = SHIPPED_JIRA_TEMPLATES.find((t) => t.id === "bug")!;
    expect(bug.content).toContain("vanlige punkter (ikke avkryssingsbokser)");
    // `- [ ]` appears exactly ONCE, inside the prohibition — never as structure
    // the model is asked to produce.
    expect(bug.content.match(/- \[ \]/g)).toHaveLength(1);
    expect(bug.content).toContain("avkryssingsbokser (`- [ ]`)");
  });
});

describe("resolveJiraTemplates", () => {
  test("no bot prompts ⇒ the whole shipped set", () => {
    expect(resolveJiraTemplates(undefined).map((t) => t.id)).toEqual(["bug", "story", "task", "spike"]);
  });

  test("a same-id variant overrides IN PLACE, keeping picker order", () => {
    const out = resolveJiraTemplates({
      jiraTemplateVariants: [{ id: "bug", label: "Bug (NAV)", content: "EGEN BUG" }],
    });
    expect(out.map((t) => t.id)).toEqual(["bug", "story", "task", "spike"]);
    expect(out[0]!.label).toBe("Bug (NAV)");
    expect(out[0]!.content).toBe("EGEN BUG");
  });

  test("a new id APPENDS", () => {
    const out = resolveJiraTemplates({
      jiraTemplateVariants: [{ id: "epic", label: "Epic", content: "EPIC" }],
    });
    expect(out.map((t) => t.id)).toEqual(["bug", "story", "task", "spike", "epic"]);
  });

  test("BLANK IS ABSENT — a whitespace variant leaves the shipped one intact", () => {
    const out = resolveJiraTemplates({
      jiraTemplateVariants: [{ id: "bug", label: "Bug", content: "  \n " }],
    });
    expect(out[0]!.content).toContain("Skriv en BUG-sak");
  });
});

describe("findJiraTemplate", () => {
  test("an unknown id is UNDEFINED so the route can 400 — never a silent fallback", () => {
    expect(findJiraTemplate(resolveJiraTemplates(undefined), "epic")).toBeUndefined();
    expect(findJiraTemplate(resolveJiraTemplates(undefined), "")).toBeUndefined();
    expect(findJiraTemplate(resolveJiraTemplates(undefined), undefined)).toBeUndefined();
  });
});

describe("buildDepthFence — the connector's own dialect", () => {
  test("copilot tool-less depths carry `mcp:*` — single colon, the SDK's syntax", () => {
    for (const depth of ["ingen", "skisse"] as const) {
      const fence = buildDepthFence(depth, "copilot-sdk", MELOSYS_SERVERS);
      expect(fence).toContain("mcp:*");
      expect(fence).toContain("builtin:*");
      // An `mcp__*` list matches NOTHING on copilot — the inert-fence failure.
      expect(fence.some((f) => f.startsWith("mcp__"))).toBe(false);
    }
  });

  test("Full excludes every non-code/yggdrasil wire name and KEEPS the code ones", () => {
    const fence = buildDepthFence("full", "copilot-sdk", MELOSYS_SERVERS);
    // Probed wire names, `<server>-<tool>` on copilot.
    expect(fence).toContain("knowledge-search_knowledge");
    expect(fence).toContain("hivemind-ask_peer");
    expect(fence).toContain("research-research_knowledge");
    // The two servers Full exists to reach are NOT excluded.
    for (const t of ["code-search_tools", "code-call_tool", "yggdrasil-read_source", "yggdrasil-symbol_context"]) {
      expect(fence).not.toContain(t);
    }
    // 6 knowledge + 4 hivemind + 1 research = 11, plus the two builtin patterns.
    expect(fence.filter((f) => !f.includes(":"))).toHaveLength(11);
  });

  test("Full does NOT use a blanket `mcp:*` — that would fence off the code servers", () => {
    expect(buildDepthFence("full", "copilot-sdk", MELOSYS_SERVERS)).not.toContain("mcp:*");
  });

  test("the Claude dialects have no wildcard, so a tool-less depth ENUMERATES", () => {
    const fence = buildDepthFence("ingen", "claude-cli", MELOSYS_SERVERS);
    expect(fence).toContain("mcp__knowledge__search_knowledge");
    expect(fence).toContain("mcp__code__call_tool");
    expect(fence).not.toContain("mcp:*");
  });

  test("an unavailable probe still binds the tool-less depths on copilot", () => {
    // The wildcard needs no probe; Full degrades to the built-in fence, which is
    // honest — the pre-flight has already refused that depth.
    expect(buildDepthFence("ingen", "copilot-sdk", [])).toContain("mcp:*");
    expect(buildDepthFence("full", "copilot-sdk", [])).toEqual(["builtin:*", "custom:*"]);
  });

  test("mcpWireName spells both dialects", () => {
    expect(mcpWireName("copilot-sdk", "yggdrasil", "read_source")).toBe("yggdrasil-read_source");
    expect(mcpWireName("claude-sdk", "yggdrasil", "read_source")).toBe("mcp__yggdrasil__read_source");
    expect(mcpWireName(undefined, "code", "call_tool")).toBe("mcp__code__call_tool");
  });

  test("the Full allow-set is exactly the two NAV-source servers", () => {
    expect([...JIRA_FULL_MCP_SERVERS]).toEqual(["code", "yggdrasil"]);
  });
});
