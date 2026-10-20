import { describe, expect, test } from "bun:test";
import { buildJudgeArgs } from "./judge.ts";

describe("buildJudgeArgs", () => {
  const flag = (args: string[], name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };

  test("tool-less: no built-in tool, no MCP source", () => {
    const args = buildJudgeArgs("judge this", "claude-sonnet-5-5");
    expect(flag(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--settings");
  });

  test("keeps the stream-json contract and puts the prompt after --", () => {
    const args = buildJudgeArgs("--looks-like-a-flag", "claude-sonnet-5-5");
    expect(args.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(flag(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    // The judge's text_delta progress comes from partial messages.
    expect(args).toContain("--include-partial-messages");
    expect(flag(args, "--model")).toBe("claude-sonnet-5-5");
    expect(args.slice(-2)).toEqual(["--", "--looks-like-a-flag"]);
  });
});
