import { test, expect, describe } from "bun:test";
import { researchCardScript } from "./research-card.ts";

// research-card.ts only exports researchCardScript() — a browser-injectable JS string.
// parseResearchContent is defined inside that string, NOT as a TS export.
// We test the exported function and verify the JS string contains the expected definitions.

describe("researchCardScript", () => {
  test("returns a non-empty string", () => {
    const script = researchCardScript();
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(0);
  });

  test("contains RESEARCH_MARKER definition", () => {
    const script = researchCardScript();
    expect(script).toContain("RESEARCH_MARKER");
    expect(script).toContain("<!-- research:jira -->");
  });

  test("contains parseResearchContent function", () => {
    const script = researchCardScript();
    expect(script).toContain("function parseResearchContent(text)");
  });

  test("contains renderResearchCard function", () => {
    const script = researchCardScript();
    expect(script).toContain("function renderResearchCard(parsed)");
  });

  test("contains showResearchActions function", () => {
    const script = researchCardScript();
    expect(script).toContain("function showResearchActions(phase)");
  });

  test("contains saveResearchReport function", () => {
    const script = researchCardScript();
    expect(script).toContain("function saveResearchReport()");
  });

  test("contains the role-aware hivemind handoff functions", () => {
    const script = researchCardScript();
    expect(script).toContain("function buildStartBuildingPrompt(planPath, specPath, roles)");
    expect(script).toContain("function showHandoffConfirm(roles)");
    expect(script).toContain("function testHandoffInstruction(specPath, planPath)");
    expect(script).toContain("function confirmHandoffPrompt(roles, planPath, specPath)");
    expect(script).toContain("function handoffPaths()");
    expect(script).toContain("function checkSpecStatus(botName, issueKey)");
  });

  test("Start Building is disabled until a work plan exists, and gated on spec approval for spec-loop bots", () => {
    const script = researchCardScript();
    expect(script).toContain("buildBtn.disabled = !reportExists");
    // The Phase-3 approval gate: spec-loop bots (a specDomain prompt) also need an approved spec.
    expect(script).toContain("hasSpecDomain && !specApproved");
    expect(script).toContain("Approve the domain spec first");
  });

  test("buildStartBuildingPrompt (build-only) embeds the plan path, peer discovery, wait gate, delegate_task, and wiki target", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn buildStartBuildingPrompt;",
    )();
    const out: string = fn("/abs/reports/u1/MELOSYS-7546.md", "", ["build"]);
    expect(out).toContain("/abs/reports/u1/MELOSYS-7546.md");
    expect(out).toContain("list_peers");
    expect(out).toContain("Do NOT message any agent yet");
    expect(out).toContain("/Users/rune/source/nav/melosys-kode-wiki");
    // Phase 3: uses the tracked delegate_task tool, not prose send_to_peer.
    expect(out).toContain("delegate_task");
    expect(out).toContain('role: "build"');
    // Build-only fan-out must not mention the test agent.
    expect(out).not.toContain("TEST agent");
    expect(out).not.toContain("melosys-e2e-tests");
  });

  test("buildStartBuildingPrompt (build+test) recommends both peers, guards availability, and delegates each role", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn buildStartBuildingPrompt;",
    )();
    const out: string = fn(
      "/abs/reports/u1/MELOSYS-7546.md",
      "/abs/specs/u1/MELOSYS-7546.md",
      ["build", "test"],
    );
    expect(out).toContain("/abs/reports/u1/MELOSYS-7546.md");
    expect(out).toContain("/abs/specs/u1/MELOSYS-7546.md");
    expect(out).toContain("BUILD agent");
    expect(out).toContain("TEST agent");
    expect(out).toContain("melosys-e2e-tests");
    expect(out).toContain("AVAILABILITY GUARD");
    expect(out).toContain('role: "build"');
    expect(out).toContain('role: "test"');
    expect(out).toContain("delegate_task");
  });

  test("the handoff review instruction verifies code + knowledge + acceptance criteria", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn handoffReviewInstruction;",
    )();
    const out: string = fn();
    expect(out).toContain("verify every claim against the ACTUAL code");
    expect(out).toContain("search_knowledge");
    expect(out).toContain("faglige");
    // Phase 3 reframe: verify against the acceptance criteria, then implement.
    expect(out).toContain("acceptance criteria");
  });

  test("the test handoff instruction runs spec-from-analysis and reports e2e_spec_path", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn testHandoffInstruction;",
    )();
    const out: string = fn("/abs/specs/u1/MELOSYS-7546.md", "/abs/reports/u1/MELOSYS-7546.md");
    expect(out).toContain("/abs/specs/u1/MELOSYS-7546.md");
    expect(out).toContain("spec-from-analysis");
    expect(out).toContain("e2e_spec_path");
    // Binding hints are passed by pointing at the workplan's Code Analysis section.
    expect(out).toContain("Code Analysis");
    expect(out).toContain("/abs/reports/u1/MELOSYS-7546.md");
  });

  test("confirmHandoffPrompt fans out via delegate_task per role, not send_to_peer", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn confirmHandoffPrompt;",
    )();
    const out: string = fn(["build", "test"], "/abs/reports/u1/X-1.md", "/abs/specs/u1/X-1.md");
    expect(out).toContain("delegate_task");
    expect(out).toContain("NOT send_to_peer");
    expect(out).toContain('role: "build"');
    expect(out).toContain('role: "test"');
    expect(out).toContain("/abs/reports/u1/X-1.md");
    expect(out).toContain("/abs/specs/u1/X-1.md");

    // Build-only confirm omits the test handoff line.
    const buildOnly: string = fn(["build"], "/abs/reports/u1/X-1.md", "");
    expect(buildOnly).toContain('role: "build"');
    expect(buildOnly).not.toContain('role: "test"');
  });

  test("contains the Phase 5 live dev_run helpers", () => {
    const script = researchCardScript();
    expect(script).toContain("function fetchDevRun(cb)");
    expect(script).toContain("function renderRunAffordance()");
    expect(script).toContain("function renderRunCard()");
    expect(script).toContain("function onDevRunEvent(event)");
    expect(script).toContain("function showOrchestrateConfirm()");
    expect(script).toContain("function buildOrchestratePrompt(specPath, planPath)");
    expect(script).toContain("function resendHandoffPrompt(handoff, pickAnother)");
    expect(script).toContain("function phaseForStage(stage)");
  });

  test("the reply-counter is retired — no researchBotReplies references remain", () => {
    // Phase 5: affordance visibility is driven off dev_run state (status +
    // research_stage + handoff rows), not the positional client-side counter.
    expect(researchCardScript()).not.toContain("researchBotReplies");
  });

  test("phaseForStage maps the dev_run research_stage to the analysis-phase button set", () => {
    const script = researchCardScript();
    const fn = new Function(script + "\nreturn phaseForStage;")();
    expect(fn("investigation")).toBe("investigation");
    expect(fn("deep")).toBe("deepAnalysis");
    expect(fn("analysis")).toBe("analysis");
    expect(fn(null)).toBe("analysis");
    expect(fn(undefined)).toBe("analysis");
  });

  test("buildOrchestratePrompt delegates the cross-repo e2e and asks for the CI run URL", () => {
    const script = researchCardScript();
    const fn = new Function(script + "\nreturn buildOrchestratePrompt;")();
    const out: string = fn("/abs/specs/u1/X-1.md", "/abs/reports/u1/X-1.md");
    expect(out).toContain("delegate_task");
    expect(out).toContain("NOT send_to_peer");
    expect(out).toContain('role: "orchestrate"');
    expect(out).toContain("orchestrate-e2e-flow");
    expect(out).toContain("AVAILABILITY GUARD");
    // The green gate keys on the CI conclusion — the reply must carry the run URL.
    expect(out).toContain("GitHub Actions run URL");
    expect(out).toContain("/abs/specs/u1/X-1.md");
  });

  test("the orchestrate confirm renders only when the run parks at ready_to_verify", () => {
    const script = researchCardScript();
    expect(script).toContain("run.status === 'ready_to_verify' && !pendingOrchestrate");
  });

  test("resendHandoffPrompt re-delegates a stale handoff via delegate_task (per role)", () => {
    // String-contains targeting resendHandoffPrompt's body (it calls handoffPaths/
    // getBotInfo from the IIFE scope, so it can't be eval'd standalone like the
    // pure prompt builders). The role param + 'gone quiet' framing are unique to it.
    const script = researchCardScript();
    expect(script).toContain("has gone quiet");
    expect(script).toContain("(NOT send_to_peer), role: \"' + handoff.role");
  });

  test("saveDomainSpec flips the in-session specApproved gate on approval", () => {
    // Regression guard: clicking Approve Spec must set specApproved in-memory so
    // the build+test fan-out unlocks without a page reload (the re-render reads it).
    const script = researchCardScript();
    expect(script).toContain("if (approved) specApproved = true;");
  });

  test("parseResearchContent handles title + prompt + body", () => {
    // Evaluate the JS string in a controlled scope to test parseResearchContent
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input =
      "<!-- research:jira -->Analyze this task\n---\n# MELOSYS-7546 Fix login bug\n\nDescription here";
    const result = fn(input);
    expect(result.title).toBe("MELOSYS-7546 Fix login bug");
    expect(result.prompt).toBe("Analyze this task");
    expect(result.issueKey).toBe("MELOSYS-7546");
    expect(result.content).toContain("MELOSYS-7546 Fix login bug");
    expect(result.content).toContain("Description here");
  });

  test("parseResearchContent handles missing prompt (no --- separator)", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira --># PROJ-123 Some task\n\nBody text";
    const result = fn(input);
    expect(result.prompt).toBe("");
    expect(result.title).toBe("PROJ-123 Some task");
    expect(result.issueKey).toBe("PROJ-123");
  });

  test("parseResearchContent handles missing title (no heading)", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira -->Just some plain text without a heading";
    const result = fn(input);
    expect(result.title).toBe(
      "Just some plain text without a heading",
    );
    expect(result.issueKey).toBeNull();
  });

  test("parseResearchContent extracts issue key from heading with hash prefix", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira -->\n---\n## ABC-999 Title here";
    const result = fn(input);
    expect(result.issueKey).toBe("ABC-999");
  });

  test("parseResearchContent uses fallback title when content is empty-ish", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const input = "<!-- research:jira -->";
    const result = fn(input);
    expect(result.title).toBe("Jira Task");
  });

  test("parseResearchContent truncates long non-heading first lines", () => {
    const script = researchCardScript();
    const fn = new Function(
      script + "\nreturn parseResearchContent;",
    )();
    const longLine = "A".repeat(100);
    const input = "<!-- research:jira -->" + longLine;
    const result = fn(input);
    expect(result.title.length).toBeLessThanOrEqual(80);
    expect(result.title).toContain("...");
  });
});
