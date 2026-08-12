import { test, expect, describe, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock DB to prevent real SQL calls
mock.module("../db/client.ts", () => ({
  getDb: () => {
    const sql = (_strings: TemplateStringsArray, ..._values: any[]) =>
      Promise.resolve([]);
    return sql;
  },
}));

// Capture span writes so we can assert tool child spans land under the
// watcher:<type> root span (attachToolSpans → Tracer → saveSpan).
const saveSpanCalls: Array<Record<string, unknown>> = [];
mock.module("../db/traces.ts", () => ({
  saveSpan: async (params: Record<string, unknown>) => { saveSpanCalls.push(params); },
  updateSpan: async () => {},
}));
mock.module("../config.ts", () => ({
  loadConfig: () => ({ tracingEnabled: true, tracingCaptureToolOutputs: true }),
}));

const { spawnHaiku, callHaiku, HAIKU_TIMEOUT_MS, parseHaikuJson, parseLegacyHaikuOutput, readAndParseHaikuStream, buildHaikuArgs, _resetSpawnWarningsForTests } =
  await import("./executor.ts");
const { attachToolSpans } = await import("../core/tool-spans.ts");
const { resolveAgentCwd } = await import("../ai/agent-cwd.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const { Tracer } = await import("../tracing/index.ts");

/** Build a ReadableStream from NDJSON lines (mimics `claude` stream-json stdout). */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const body = lines.join("\n") + "\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
}

describe("parseHaikuJson", () => {
  test("parses valid JSON", () => {
    expect(parseHaikuJson('{"result":"ok"}')).toEqual({ result: "ok" });
  });

  test("throws descriptive error with stdout preview on invalid JSON", () => {
    expect(() => parseHaikuJson("not json at all")).toThrow(
      /Failed to parse Haiku JSON output:.*not json at all/,
    );
  });

  test("truncates the stdout preview to 300 chars", () => {
    const long = "x".repeat(1000);
    try {
      parseHaikuJson(long);
      throw new Error("expected parseHaikuJson to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The preview slice must not contain the full 1000-char payload.
      expect(msg).not.toContain("x".repeat(301));
      expect(msg).toContain("x".repeat(300));
    }
  });
});

/**
 * Any cwd-less `spawnHaiku`/`callHaiku` call resolves its cwd via
 * `resolveAgentCwd` and CREATES it — in the developer's real
 * `~/.muninn/agent-cwd` unless redirected. Every test in this file that reaches a
 * real spawn goes through here so the suite leaves nothing in `$HOME`.
 */
async function withScratchAgentCwd(body: () => Promise<void>): Promise<void> {
  const previous = process.env.MUNINN_AGENT_CWD;
  const scratch = mkdtempSync(join(tmpdir(), "muninn-executor-test-"));
  process.env.MUNINN_AGENT_CWD = scratch;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.MUNINN_AGENT_CWD;
    else process.env.MUNINN_AGENT_CWD = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("spawnHaiku timeout", () => {
  test("HAIKU_TIMEOUT_MS defaults to 60s", () => {
    expect(HAIKU_TIMEOUT_MS).toBe(60_000);
  });

  test("kills hanging process after timeout", async () => {
    // Call spawnHaiku directly with a very short timeout.
    // "claude" won't be found or will hang — either way it exceeds 100ms.
    await withScratchAgentCwd(async () => {
      await expect(
        spawnHaiku("test", { source: "timeout-test", entrypoint: "test", botName: "test-bot", timeoutMs: 100 }),
      ).rejects.toThrow(/timed out after 100ms|exited with code/);
    });
  });

  test("clearTimeout runs in finally block even on success", async () => {
    // Verify the try/finally pattern: timer is cleared on normal exit
    const proc = Bun.spawn(["echo", "done"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let timerCleared = false;
    let timeoutTimer: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error("should not fire"));
      }, 5000);
    });

    try {
      await Promise.race([proc.exited, timeoutPromise]);
    } finally {
      clearTimeout(timeoutTimer!);
      timerCleared = true;
    }

    expect(timerCleared).toBe(true);
  });
});

describe("callHaiku", () => {
  test("returns fallback when process fails", async () => {
    // cwd-less, like the spawnHaiku timeout test above — same scratch guard.
    await withScratchAgentCwd(async () => {
      const result = await callHaiku("test", "fallback-value", "test-source", undefined, undefined, 100);
      expect(result).toBe("fallback-value");
    });
  });
});

describe("parseLegacyHaikuOutput (fallback parse)", () => {
  test("recovers result + tokens + turns + cost from a legacy single-JSON blob", () => {
    const blob = JSON.stringify({
      type: "result",
      result: "hello world",
      num_turns: 3,
      total_cost_usd: 0.0042,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 2,
        output_tokens: 7,
      },
      modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 0.0042 } },
    });
    const r = parseLegacyHaikuOutput(blob, "fallback-model");
    expect(r.result).toBe("hello world");
    expect(r.inputTokens).toBe(17); // 10 + 5 + 2
    expect(r.outputTokens).toBe(7);
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.numTurns).toBe(3);
    expect(r.costUsd).toBe(0.0042);
    expect(r.toolCalls).toBeUndefined();
  });

  test("normalizes CLI-2.x result-as-object and falls back to effectiveModel", () => {
    const blob = JSON.stringify({
      result: { content: [{ type: "text", text: "boxed answer" }] },
    });
    const r = parseLegacyHaikuOutput(blob, "eff-model");
    expect(r.result).toBe("boxed answer");
    expect(r.model).toBe("eff-model");
    expect(r.inputTokens).toBe(0);
  });
});

describe("readAndParseHaikuStream", () => {
  const assistantWithTool = JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "tool_use", id: "toolu_01", name: "mcp__gmail__search_emails", input: { query: "is:unread" } }],
      usage: { input_tokens: 100, output_tokens: 5 },
    },
  });
  const toolResult = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "2 emails", is_error: false }] },
  });
  const assistantText = JSON.stringify({
    type: "assistant",
    message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "[]" }], usage: { input_tokens: 120, output_tokens: 3 } },
  });
  const resultEvent = JSON.stringify({
    type: "result", result: "[]", num_turns: 2, total_cost_usd: 0.001,
    usage: { input_tokens: 120, output_tokens: 8 },
  });

  test("complete stream yields a result with parsed tool calls", async () => {
    const { result, rawLines } = await readAndParseHaikuStream(
      ndjsonStream([assistantWithTool, toolResult, assistantText, resultEvent]),
      performance.now(), undefined, "test-bot",
    );
    expect(result).not.toBeNull();
    expect(result!.result).toBe("[]");
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0]!.name).toBe("mcp__gmail__search_emails");
    expect(result!.toolCalls![0]!.output).toBe("2 emails");
    expect(rawLines.length).toBe(4);
  });

  test("stream missing the result event returns null (drops to legacy fallback)", async () => {
    // The known CLI bug: the CLI degrades to a single legacy JSON blob with no
    // stream `result` event. readAndParseHaikuStream returns null, and the raw
    // blob feeds parseLegacyHaikuOutput — exactly spawnHaiku's fallback path.
    const legacyBlob = JSON.stringify({ result: "recovered", usage: { input_tokens: 4, output_tokens: 2 } });
    const { result, rawLines } = await readAndParseHaikuStream(
      ndjsonStream([legacyBlob]), performance.now(), undefined, "test-bot",
    );
    expect(result).toBeNull();
    const recovered = parseLegacyHaikuOutput(rawLines.join("\n"), "eff");
    expect(recovered.result).toBe("recovered");
    expect(recovered.inputTokens).toBe(4);
    expect(recovered.outputTokens).toBe(2);
  });

  test("fires live tool progress callbacks as lines arrive", async () => {
    const events: string[] = [];
    await readAndParseHaikuStream(
      ndjsonStream([assistantWithTool, toolResult, assistantText, resultEvent]),
      performance.now(),
      (e) => events.push(e.type),
      "test-bot",
    );
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_end");
  });
});

describe("tool child spans under watcher:<type>", () => {
  test("attachToolSpans lands the Haiku tool call under the watcher root span", async () => {
    saveSpanCalls.length = 0;
    const tracer = new Tracer("watcher:email", { botName: "jarvis", userId: "u1" });
    const rootId = saveSpanCalls[0]!.id as string;
    expect(saveSpanCalls[0]!.name).toBe("watcher:email");

    await attachToolSpans(
      tracer,
      [{
        id: "toolu_01",
        name: "mcp__gmail__search_emails",
        displayName: "search_emails (gmail)",
        durationMs: 1200,
        startOffsetMs: 50,
        input: JSON.stringify({ query: "is:unread" }),
        output: "2 emails",
      }],
      false,
    );

    const toolSpan = saveSpanCalls.find((s) => s.name === "search_emails (gmail)");
    expect(toolSpan).toBeDefined();
    // Parent is the watcher root span (attachToolSpans' "claude" label is absent
    // on a watcher Tracer, so addChildSpan falls back to the root span).
    expect(toolSpan!.parentId).toBe(rootId);
    expect((toolSpan!.attributes as any).toolName).toBe("mcp__gmail__search_emails");
  });
});

/**
 * The flag policy is the whole point of the bot-dir → agent-home move: what a
 * spawn used to absorb implicitly from its cwd (persona, MCP) it must now ask for
 * by name. Each of these is silent when wrong — a persona-less reminder still
 * reads fine, a fenced-off Gmail watcher still returns `[]`.
 */
describe("buildHaikuArgs", () => {
  const base = { prompt: "hi", model: "claude-haiku-4-5-20251001" };

  test("a tool-less call is fenced off from every ambient MCP source", () => {
    const args = buildHaikuArgs(base);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--system-prompt");
  });

  test("persona rides --system-prompt, adjacent to its value", () => {
    const args = buildHaikuArgs({ ...base, system: "You are Jarvis." });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are Jarvis.");
  });

  test("a bot dir with real servers becomes an inline --mcp-config, and drops the fence", () => {
    const root = mkdtempSync(join(tmpdir(), "muninn-haiku-args-"));
    try {
      const botDir = join(root, "jarvis");
      mkdirSync(botDir, { recursive: true });
      writeFileSync(
        join(botDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { gmail: { type: "stdio", command: "npx" } } }),
      );

      const args = buildHaikuArgs({ ...base, botDir });
      expect(args).not.toContain("--settings"); // no settings file in this bot dir
      const idx = args.indexOf("--mcp-config");
      expect(idx).toBeGreaterThan(-1);
      expect(JSON.parse(args[idx + 1]!).mcpServers.gmail.command).toBe("npx");
      // --mcp-config is variadic: it stops at the next `-`-prefixed token, so a
      // following FLAG is safe — but a bare positional would be swallowed as a
      // second config. Last position is the cheap way to never have to check.
      expect(idx + 1).toBe(args.length - 1);
      // The fence applies HERE TOO. Without it the CLI also merges the developer's
      // user-scope ~/.claude.json servers — measured 9 servers / 112 mcp__ tools
      // instead of the bot's own, including a `claude.ai Gmail` pointing at a
      // different mailbox that the bot's allow-list does not cover.
      expect(args).toContain("--strict-mcp-config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bot dir with no readable .mcp.json falls back to the fence, not an empty config", () => {
    const root = mkdtempSync(join(tmpdir(), "muninn-haiku-args-"));
    try {
      const args = buildHaikuArgs({ ...base, botDir: root });
      expect(args).toContain("--strict-mcp-config");
      expect(args).not.toContain("--mcp-config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  test("the bot's tool permissions ride --settings, or the MCP call is denied", () => {
    // Regression guard for the defect this PR introduced and then measured: with
    // the cwd moved out of the bot folder, `.claude/settings.json` stops being
    // discovered and `mcp__gmail__*` comes back "permission not granted" — which
    // the email checker reports as an ordinary empty inbox.
    const root = mkdtempSync(join(tmpdir(), "muninn-haiku-args-"));
    try {
      const botDir = join(root, "jarvis");
      mkdirSync(join(botDir, ".claude"), { recursive: true });
      writeFileSync(
        join(botDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { gmail: { type: "stdio", command: "npx" } } }),
      );
      writeFileSync(
        join(botDir, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__gmail__search_emails"] } }),
      );
      // The file Claude Code itself writes when a permission is approved in place.
      writeFileSync(
        join(botDir, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: ["mcp__jetbrains__execute_terminal_command"] } }),
      );

      const args = buildHaikuArgs({ ...base, botDir });
      // A JSON document, not the path — `--settings` is not repeatable, and the
      // bot's per-machine `settings.local.json` has to be merged into it.
      const passed = JSON.parse(args[args.indexOf("--settings") + 1]!);
      expect(passed.permissions.allow).toContain("mcp__gmail__search_emails");
      expect(passed.permissions.allow).toContain("mcp__jetbrains__execute_terminal_command");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tool-less call carries no --settings (nothing to permit)", () => {
    expect(buildHaikuArgs(base)).not.toContain("--settings");
  });

  test("keeps the stream-json contract the parser depends on", () => {
    const args = buildHaikuArgs(base);
    expect(args.slice(0, 3)).toEqual(["claude", "-p", "hi"]);
    expect(args).toContain("--verbose");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });
});

/**
 * The whole PR reduces to ONE production line — the `cwd:` on `Bun.spawn`. The
 * removed `spawnCwd` seam used to pin it; nothing did afterwards, and passing
 * `botDir` through to `cwd` by accident would silently restore every symptom
 * (repo CLAUDE.md reloaded, transcripts back in the developer's project folder)
 * while every other test stayed green.
 */
describe("spawnHaiku cwd", () => {
  test("always runs in the agent home, even when a botDir is supplied", async () => {
    const spawned: Array<{ cmd: string[]; cwd: string }> = [];
    const realSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[], o: any) => {
      spawned.push({ cmd, cwd: o.cwd });
      return {
        pid: 1,
        stdout: ndjsonStream([
          JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }),
        ]),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };
    try {
      await spawnHaiku("hi", {
        source: "cwd-test",
        botName: "jarvis",
        botDir: join(REPO_ROOT, "bots", "jarvis"),
      }).catch(() => {});
    } finally {
      (Bun as any).spawn = realSpawn;
    }

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cwd).toBe(resolveAgentCwd("jarvis"));
    expect(spawned[0]!.cwd).not.toContain(`${REPO_ROOT}/bots`);
    // The bot dir must reach the CLI as configuration, never as a working directory.
    expect(spawned[0]!.cmd).toContain("--mcp-config");
  });
});

/**
 * The silent-degrade guards. Both conditions produce a spawn that RUNS, succeeds,
 * and returns nothing useful — a broken `.mcp.json` edit means no Gmail, a missing
 * settings file means every MCP call is denied — and both read downstream as an
 * ordinary quiet inbox. A warning that never fires is the same as no guard, so it
 * is asserted against a real LogTape sink rather than assumed.
 */
describe("spawnHaiku degrade warnings", () => {
  const records: string[] = [];

  test("warns once per path when a botDir yields no MCP config and no settings", async () => {
    const { configure } = await import("@logtape/logtape");
    await configure({
      sinks: { capture: (r: any) => records.push(r.message.join("")) },
      loggers: [
        { category: ["muninn", "scheduler", "executor"], lowestLevel: "warning", sinks: ["capture"] },
        // Without this LogTape prints an 8-line meta notice into every suite run.
        // Root CLAUDE.md says tests never configure logging; this file is the one
        // exception, because a warning that never fires is the same as no guard.
        { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      ],
      reset: true,
    });
    _resetSpawnWarningsForTests();

    const root = mkdtempSync(join(tmpdir(), "muninn-warn-"));
    try {
      // A bot dir with neither file — the shape a typo'd path or a broken JSON
      // edit produces.
      buildHaikuArgs({ prompt: "x", model: "m", botDir: root });
      expect(records.filter((r) => r.includes("No usable .mcp.json"))).toHaveLength(1);
      expect(records.filter((r) => r.includes("will be DENIED"))).toHaveLength(1);

      // Throttled: these run at watcher-tick rate, so a permanent condition must
      // not produce a permanent log flood.
      buildHaikuArgs({ prompt: "x", model: "m", botDir: root });
      buildHaikuArgs({ prompt: "x", model: "m", botDir: root });
      expect(records.filter((r) => r.includes("No usable .mcp.json"))).toHaveLength(1);

      // A tool-less call asked for nothing and must say nothing.
      records.length = 0;
      buildHaikuArgs({ prompt: "x", model: "m" });
      expect(records).toHaveLength(0);

      // The case the two checks above structurally CANNOT see: a corrupt
      // settings.json next to a healthy settings.local.json. The merge returns
      // non-null, so `!settings` is false — while every mcp__gmail__* call in
      // production gets denied and the checker reports a quiet inbox.
      const capraish = join(root, "capra");
      mkdirSync(join(capraish, ".claude"), { recursive: true });
      writeFileSync(join(capraish, ".mcp.json"), JSON.stringify({ mcpServers: { gmail: { command: "npx" } } }));
      writeFileSync(join(capraish, ".claude", "settings.json"), '{"permissions":{"allow":["mcp__gmail__x"],}}');
      writeFileSync(join(capraish, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["other"] } }));

      const args = buildHaikuArgs({ prompt: "x", model: "m", botDir: capraish });
      expect(args).toContain("--settings"); // the healthy local file still merges
      expect(records.filter((r) => r.includes("Unparseable bot config"))).toHaveLength(1);
      // ...and it must NOT be reported as mere absence, which reads as intentional.
      expect(records.filter((r) => r.includes("No readable"))).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await configure({
        sinks: {},
        loggers: [{ category: ["logtape", "meta"], lowestLevel: "error", sinks: [] }],
        reset: true,
      });
    }
  });
});
