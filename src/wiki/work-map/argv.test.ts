/**
 * The spawned argv of a real organize call, driven through `realWorkMapModel`
 * → `runFencedOneShot` → `executeOneShot` → the claude-cli executor, with
 * `Bun.spawn` spied: the run's BotConfig is built from scratch, so a wiki
 * synthesis bot's `effort` and thinking budget never reach it.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../../config.ts";
import { silentTracer } from "../../test/one-shot-drive.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { realWorkMapModel, WORK_MAP_SPAWN_ARGS, WORK_MAP_TIMEOUT_MS, workMapBotConfig } from "./run.ts";

const config = { claudeModel: "claude-sonnet-4-5", claudeTimeoutMs: 30_000, tracingEnabled: false, tracingCaptureToolOutputs: false } as unknown as Config;

let saved: { cwd?: string; mtt?: string };
beforeEach(() => {
  saved = { cwd: process.env.MUNINN_AGENT_CWD, mtt: process.env.MAX_THINKING_TOKENS };
  process.env.MUNINN_AGENT_CWD = testTempDirSync(path.join(tmpdir(), "work-map-agent-"));
  // Set, as on a host whose shell exports a budget: the spawn must still carry none.
  process.env.MAX_THINKING_TOKENS = "31999";
});
afterEach(() => {
  if (saved.cwd === undefined) delete process.env.MUNINN_AGENT_CWD;
  else process.env.MUNINN_AGENT_CWD = saved.cwd;
  if (saved.mtt === undefined) delete process.env.MAX_THINKING_TOKENS;
  else process.env.MAX_THINKING_TOKENS = saved.mtt;
});

function fakeProc() {
  const out = JSON.stringify({ type: "result", result: '{"ok":true}', total_cost_usd: 0.42, duration_ms: 1200, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } });
  return { pid: 1, stdout: new Response(out + "\n").body!, stderr: new Response("").body!, exited: Promise.resolve(0), kill: () => {} };
}

async function spawnOnce(effort?: "high") {
  const spy = spyOn(Bun, "spawn").mockReturnValue(fakeProc() as never);
  try {
    const model = realWorkMapModel(config, { tracer: silentTracer() });
    const reply = await model({ wiki: "mimir", prompt: "the digest", systemPrompt: "the system", model: "claude-opus-5-5", ...(effort ? { effort } : {}) });
    const [argv, opts] = spy.mock.calls[0] as unknown as [string[], { env: Record<string, string | undefined>; cwd: string }];
    return { argv, opts, reply };
  } finally {
    spy.mockRestore();
  }
}

test("no --effort and no MAX_THINKING_TOKENS when WORK_MAP_EFFORT is unset", async () => {
  const { argv, opts, reply } = await spawnOnce();
  expect(argv.slice(0, 2)).toEqual(["claude", "-p"]);
  expect(argv).not.toContain("--effort");
  expect(opts.env.MAX_THINKING_TOKENS).toBeUndefined();
  expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  // Tool-less, no MCP, no settings, no session file, no auto memory.
  expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).not.toContain("--restricted");
  expect(argv.join("\u0000")).toContain(WORK_MAP_SPAWN_ARGS.join("\u0000"));
  expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("the system");
  // The prompt rides argv after "--".
  expect(argv.slice(-2)).toEqual(["--", "the digest"]);
  // The empty agent home, not a bot folder.
  expect(opts.cwd).toBe(path.join(process.env.MUNINN_AGENT_CWD!, ".fenced"));
  expect(reply).toMatchObject({ text: '{"ok":true}', costUsd: 0.42 });
});

test("WORK_MAP_EFFORT=high passes --effort high and still no thinking budget", async () => {
  const { argv, opts } = await spawnOnce("high");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
  expect(opts.env.MAX_THINKING_TOKENS).toBeUndefined();
});

test("the BotConfig is built from scratch: nothing from a synthesis bot that sets effort and a budget", () => {
  const bot = workMapBotConfig({ model: "claude-opus-5-5", dir: "/home/.fenced" });
  expect(bot).toEqual({
    name: "work-map",
    dir: "/home/.fenced",
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    connector: "claude-cli",
    model: "claude-opus-5-5",
    toolSurface: "none",
    timeoutMs: WORK_MAP_TIMEOUT_MS,
    spawnArgs: [...WORK_MAP_SPAWN_ARGS],
    spawnEnvOmit: ["MAX_THINKING_TOKENS"],
  });
});
