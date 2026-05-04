import { test, expect, beforeAll } from "bun:test";
import vm from "node:vm";
import { toolDetailRenderersScript } from "./tool-detail-renderers.ts";
import { escScript } from "./helpers.ts";

/**
 * Eval the embedded renderer script in a vm context so we can call the
 * functions directly. This catches any syntax errors in the template-literal
 * JS (which TS doesn't check) and verifies that each renderer produces
 * something sensible for realistic attrs shapes pulled from the live DB.
 */
const sandbox: Record<string, unknown> = {};
beforeAll(() => {
  // Polyfill the browser globals the renderer script touches (window,
  // document). We only hold state on window; document calls are never reached
  // when we invoke renderers directly.
  const ctx: Record<string, unknown> = {
    window: { __tdrState: { showRaw: false, attrs: null } },
    document: { getElementById: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(`${escScript()}\n${toolDetailRenderersScript()}`, ctx);
  Object.assign(sandbox, ctx);
});

function call(fn: string, ...args: unknown[]): string {
  const f = sandbox[fn] as (...a: unknown[]) => string;
  if (typeof f !== "function") throw new Error(`missing fn: ${fn}`);
  return f(...args);
}

test("dispatcher picks renderer by toolName (copilot-sdk dash form)", () => {
  const pick = sandbox.tdrPickRenderer as (n: string) => unknown;
  expect(pick("knowledge-get_graph_node")).toBe(sandbox.tdrRenderGraphNode);
  expect(pick("yggdrasil-symbol_context")).toBe(sandbox.tdrRenderSymbolContext);
  expect(pick("yggdrasil-list_files")).toBe(sandbox.tdrRenderListFiles);
  expect(pick("yggdrasil-read_source")).toBe(sandbox.tdrRenderReadSource);
  expect(pick("yggdrasil-search_pattern")).toBe(sandbox.tdrRenderSearchPattern);
  expect(pick("knowledge-search_knowledge")).toBeNull();
  expect(pick("totally-unknown-tool")).toBeNull();
});

test("dispatcher picks renderer by toolName (claude-cli mcp__ form)", () => {
  const pick = sandbox.tdrPickRenderer as (n: string) => unknown;
  expect(pick("mcp__knowledge__get_graph_node")).toBe(sandbox.tdrRenderGraphNode);
  expect(pick("mcp__yggdrasil__symbol_context")).toBe(sandbox.tdrRenderSymbolContext);
  expect(pick("mcp__yggdrasil__list_files")).toBe(sandbox.tdrRenderListFiles);
  expect(pick("mcp__yggdrasil__read_source")).toBe(sandbox.tdrRenderReadSource);
  expect(pick("mcp__yggdrasil__search_pattern")).toBe(sandbox.tdrRenderSearchPattern);
  expect(pick("mcp__yggdrasil__search")).toBeNull();
  expect(pick("mcp__totally__unknown_tool")).toBeNull();
});

test("normalize helper converts mcp__ form to dash form", () => {
  const norm = sandbox.tdrNormalizeToolName as (n: string) => string;
  expect(norm("mcp__yggdrasil__symbol_context")).toBe("yggdrasil-symbol_context");
  expect(norm("mcp__claude_ai_Context7__query-docs")).toBe("claude_ai_Context7-query-docs");
  expect(norm("yggdrasil-symbol_context")).toBe("yggdrasil-symbol_context");
  expect(norm("Read")).toBe("Read");
  expect(norm("")).toBe("");
});

test("renderToolDetail falls back to generic for unknown tool", () => {
  const html = call("renderToolDetail", { attributes: { toolName: "unknown", input: '{"q":"hi"}', output: "result" } });
  expect(html).toContain("Input");
  expect(html).toContain("Output");
  expect(html).toContain("hi");
  expect(html).toContain("result");
});

test("graph_node renderer parses real output shape", () => {
  const attrs = {
    toolName: "knowledge-get_graph_node",
    input: '{"node_id":"epic:MELOSYS-7383"}',
    output: "**MELOSYS-7383: Title here** (Epic)\n\n" +
            "Properties:\n  issue_count: 50\n  summary: short summary\n\n" +
            "Incoming (2):\n" +
            "  <--tilhører_epic-- MELOSYS-7835: Some title\n" +
            "  <--tilhører_epic-- MELOSYS-7892: Other title\n",
  };
  const html = call("tdrRenderGraphNode", attrs);
  expect(html).toContain("epic:MELOSYS-7383");
  expect(html).toContain("Title here");
  expect(html).toContain("issue_count");
  expect(html).toContain("MELOSYS-7835");
  expect(html).toContain("Incoming (2)");
  expect(html).toContain("tilhører_epic");
});

test("symbol_context renderer extracts repo + signature + relations", () => {
  const out = {
    symbol: {
      name: "OpprettOgFerdigstillJournalpostSøknad",
      qualified_name: "no.nav.melosys.saksflyt.steg.soknad.OpprettOgFerdigstillJournalpostSøknad",
      kind: "class",
      file: "melosys-api/saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/steg/soknad/OpprettOgFerdigstillJournalpostSøknad.kt",
      lines: "38-96",
      signature: "@Component\nclass OpprettOgFerdigstillJournalpostSøknad(...)",
    },
    callers: [], callees: [], extends: [],
    implements: [{ kind: "implements", name: "StegBehandler", qualified_name: "no.nav.melosys.saksflyt.steg.StegBehandler", file_path: "saksflyt/src/main/java/no/nav/melosys/saksflyt/steg/StegBehandler.java", repo_name: "melosys-api" }],
    extended_by: [], implemented_by: [],
  };
  const attrs = {
    toolName: "yggdrasil-symbol_context",
    input: JSON.stringify({ qualified_name: out.symbol.qualified_name, repo: "melosys-api" }),
    output: JSON.stringify(out),
  };
  const html = call("tdrRenderSymbolContext", attrs);
  expect(html).toContain("melosys-api");
  expect(html).toContain("OpprettOgFerdigstillJournalpostSøknad");
  expect(html).toContain("class");
  expect(html).toContain("@Component");
  expect(html).toContain("Implements (1)");
  expect(html).toContain("StegBehandler");
});

test("symbol_context renderer surfaces 'No symbol found' as error", () => {
  const html = call("tdrRenderSymbolContext", {
    toolName: "yggdrasil-symbol_context",
    input: '{"qualified_name":"x","repo":"y"}',
    output: "No symbol found matching: x",
  });
  expect(html).toContain("tdr-error");
  expect(html).toContain("No symbol found");
});

test("list_files renderer strips base path prefix", () => {
  const html = call("tdrRenderListFiles", {
    toolName: "yggdrasil-list_files",
    input: '{"repo":"melosys-api","path":"saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/prosessflyt"}',
    output: JSON.stringify({
      repo: "melosys-api",
      total_files: 2,
      truncated: false,
      files: [
        { path: "saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/prosessflyt/ProsessflytDefinisjon.kt", language: "kotlin" },
        { path: "saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/prosessflyt/ProsessFlyt.kt",         language: "kotlin" },
      ],
    }),
  });
  expect(html).toContain("ProsessflytDefinisjon.kt");
  // Prefix should be stripped (no full path in list)
  expect(html).not.toContain(">saksflyt/src/main/kotlin/no/nav/melosys/saksflyt/prosessflyt/ProsessflytDefinisjon.kt<");
});

test("read_source renderer surfaces 'File not found' as error", () => {
  const html = call("tdrRenderReadSource", {
    toolName: "yggdrasil-read_source",
    input: '{"repo":"melosys-api","path":"x.kt"}',
    output: "File not found: /Users/rune/source/nav/melosys-api/x.kt",
  });
  expect(html).toContain("tdr-error");
  expect(html).toContain("File not found");
});

test("search_pattern renderer renders matches with line marker", () => {
  const html = call("tdrRenderSearchPattern", {
    toolName: "yggdrasil-search_pattern",
    input: '{"context_lines":2,"max_results":2,"pattern":"FOO","repo":"r"}',
    output: JSON.stringify({
      pattern: "FOO",
      total_matches: 1,
      matches: [{
        repo: "r",
        path: "src/x.kt",
        line: 10,
        content: "    FOO matched here",
        context_before: ["before1", "before2"],
        context_after: ["after1"],
      }],
    }),
  });
  expect(html).toContain("FOO");
  expect(html).toContain("r/src/x.kt");
  expect(html).toContain(":10");
  expect(html).toContain("tdr-line-mark"); // hit line highlighted
  expect(html).toContain("before1");
  expect(html).toContain("after1");
});

test("response section is omitted when output is null/empty", () => {
  const html = call("tdrRenderResponseSection", null);
  expect(html).toBe("");
  expect(call("tdrRenderResponseSection", "")).toBe("");
});

test("response section starts collapsed and exposes a toggle button", () => {
  // Reset state so the section is in its default closed state.
  (sandbox.window as { __tdrState: { showResponse: boolean } }).__tdrState.showResponse = false;
  const html = call("tdrRenderResponseSection", "plain text payload");
  expect(html).toContain("Response sent to LLM");
  expect(html).toContain("Show response sent to LLM");
  // Body is hidden when collapsed — neither the meta line nor the text show up.
  expect(html).not.toContain("plain text payload");
  expect(html).not.toContain("chars rendered");
});

test("response section expands to show plain-text output verbatim", () => {
  (sandbox.window as { __tdrState: { showResponse: boolean } }).__tdrState.showResponse = true;
  const html = call("tdrRenderResponseSection", "1. result a\n2. result b\n");
  expect(html).toContain("Hide response");
  expect(html).toContain("result a");
  expect(html).toContain("result b");
  // No truncation chip when the output isn't a {head, _truncated} envelope.
  expect(html).not.toContain("tdr-response-trunc");
});

test("response section parses huginn's truncation envelope and reports original size", () => {
  (sandbox.window as { __tdrState: { showResponse: boolean } }).__tdrState.showResponse = true;
  const output = JSON.stringify({ _truncated: true, _originalBytes: 28880, head: "## Doc.md\n\ncontent here" });
  const html = call("tdrRenderResponseSection", output);
  expect(html).toContain("content here");
  expect(html).toContain("truncated from 28,880 bytes");
  expect(html).toContain("tdr-response-trunc");
});

test("renderer error is caught and shown gracefully", () => {
  // Force the symbol_context renderer to crash by passing bad output JSON
  // string that parses but lacks expected shape — the renderer handles this
  // explicitly, so trigger a real throw via input that breaks JSON.parse on
  // a re-eval. Simpler: inject a getter that throws.
  const attrs: Record<string, unknown> = {
    toolName: "yggdrasil-symbol_context",
    input: "{not-valid-json",
    get output() { throw new Error("boom"); },
  };
  const html = call("renderToolDetail", { attributes: attrs });
  expect(html).toContain("Renderer error");
  expect(html).toContain("boom");
});
