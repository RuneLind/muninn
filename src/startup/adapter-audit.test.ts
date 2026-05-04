import { test, expect, describe } from "bun:test";
import { parseHuginnEnvFromPs } from "./adapter-audit.ts";

describe("parseHuginnEnvFromPs", () => {
  test("extracts the requested keys from typical ps eww output", () => {
    // ps eww concatenates env=value tokens with the command line, separated by spaces
    const sample =
      "PATH=/usr/bin:/bin LANG=en_US.UTF-8 HUGINN_TRACE_POINTER=1 HUGINN_TRACE_DEFAULT=1 KNOWLEDGE_API_URL=http://localhost:8321 python3 knowledge_api_mcp_adapter.py";
    expect(parseHuginnEnvFromPs(sample)).toEqual({
      HUGINN_TRACE_POINTER: "1",
      HUGINN_TRACE_DEFAULT: "1",
    });
  });

  test("returns empty when target keys are absent", () => {
    const sample = "PATH=/usr/bin:/bin python3 knowledge_api_mcp_adapter.py";
    expect(parseHuginnEnvFromPs(sample)).toEqual({});
  });

  test("preserves '0' values (so a stale adapter with explicit opt-out is visible)", () => {
    const sample = "HUGINN_TRACE_POINTER=0 HUGINN_TRACE_DEFAULT=0 python3";
    expect(parseHuginnEnvFromPs(sample)).toEqual({
      HUGINN_TRACE_POINTER: "0",
      HUGINN_TRACE_DEFAULT: "0",
    });
  });

  test("ignores tokens with leading '=' or no '=' at all", () => {
    // A leading '=' would make the key empty — guard against that
    expect(parseHuginnEnvFromPs("=value HUGINN_TRACE_POINTER=1 nokey")).toEqual({
      HUGINN_TRACE_POINTER: "1",
    });
  });

  test("captures only the first '=' in values containing '=' (e.g. URLs with query strings)", () => {
    // HUGINN_TRACE_DEFAULT is in the default key list and exercises the same parsing path.
    const sample = "HUGINN_TRACE_DEFAULT=http://localhost:8321/x?a=b HUGINN_TRACE_POINTER=1";
    expect(parseHuginnEnvFromPs(sample)).toEqual({
      HUGINN_TRACE_DEFAULT: "http://localhost:8321/x?a=b",
      HUGINN_TRACE_POINTER: "1",
    });
  });
});
