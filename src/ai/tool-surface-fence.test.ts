/**
 * The declared tool surface against a REAL Claude CLI and a REAL Agent SDK
 * subprocess, driven through `executeOneShot` with a fake Messages API
 * (`src/test/fake-messages-api.ts`) in place of the real one.
 *
 * The fake answers with hostile tool calls: `Bash`, a `Read` of a canary
 * outside the allowed dir, a `Read` of `<botDir>/config.json`, a
 * `<dir>/../..` traversal `Read` and a call to a stub MCP server that records
 * calls. On `"none"`, `{ read }` and `{ web }` none of them may run and the
 * stub must never start, while `Read <dir>/x.jpg` works on `{ read }` and
 * `WebFetch` works on `{ web }`. The `"bot"` arm is the control: the same stub
 * records a call there, so a zero elsewhere is the fence and not a dead stub.
 *
 * The user scope is a throwaway `CLAUDE_CONFIG_DIR` seeded to be as open as
 * the developer's own: it allows Bash, Read, WebFetch and the stub, and
 * registers the stub as a user MCP server. `--restricted` and
 * `settingSources: []` must ignore all of it.
 *
 * Its own `bun test` link: it rewrites `process.env` for the subprocesses and
 * sets the tool-surface test seam. Each arm skips when its binary is absent
 * (no `claude` 2.1.303+ on PATH, no bundled SDK binary, no `openssl`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { executeOneShot } from "./one-shot.ts";
import type { ConnectorType } from "../bots/config.ts";
import {
  compareVersions,
  installedClaudeCliVersion,
  MIN_RESTRICTED_CLI_VERSION,
  toolSurfaceTestSeam,
  type ToolSurface,
} from "./tool-surface.ts";
import {
  allowedReadPlan,
  createFenceFixture,
  hasOpenssl,
  hostilePlan,
  PROBE_MARKER,
  webFetchPlan,
  type FenceFixture,
  type ObservedToolResult,
} from "../test/fake-messages-api.ts";
import { driveBot, driveConfig } from "../test/one-shot-drive.ts";

function sdkBinaryAvailable(): boolean {
  const require = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const { platform, arch } = process;
  const names = platform === "linux"
    ? [`linux-${arch}`, `linux-${arch}-musl`]
    : [`${platform}-${arch}`];
  return names.some((n) => {
    try {
      return existsSync(require.resolve(`@anthropic-ai/claude-agent-sdk-${n}/claude${platform === "win32" ? ".exe" : ""}`));
    } catch {
      return false;
    }
  });
}

const cliVersion = await installedClaudeCliVersion();
const cliReady = hasOpenssl() && cliVersion !== null && compareVersions(cliVersion, MIN_RESTRICTED_CLI_VERSION) >= 0;
const sdkReady = hasOpenssl() && sdkBinaryAvailable();

let f: FenceFixture;
const savedEnv = { ...process.env };

beforeAll(() => {
  if (!cliReady && !sdkReady) return;
  f = createFenceFixture();
  const configDir = join(f.root, "claude-config");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash", "Read", "WebFetch", "WebSearch", "mcp__stub__record"] },
  }));
  const botMcp = JSON.parse(readFileSync(join(f.botDir, ".mcp.json"), "utf8"));
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: botMcp.mcpServers }));

  // The subprocesses inherit this process's env: nothing of a parent Claude
  // session, no real credential, the fake API and the stub page's CA.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) delete process.env[key];
  }
  Object.assign(process.env, f.env, {
    CLAUDE_CONFIG_DIR: configDir,
    MUNINN_AGENT_CWD: join(f.root, "agent-home"),
  });
  toolSurfaceTestSeam.extraSettings = { skipWebFetchPreflight: true };
});

afterAll(() => {
  delete toolSurfaceTestSeam.extraSettings;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  f?.cleanup();
});

interface Outcome {
  results: ObservedToolResult[];
  leaked: string[];
  bashRan: boolean;
  mcpStarted: boolean;
  mcpCalls: number;
  pageHits: number;
  text: string;
}

async function probe(connector: ConnectorType, surface: ToolSurface, plan = [...hostilePlan(f), allowedReadPlan(f), webFetchPlan(f)]): Promise<Outcome> {
  f.api.setPlan(plan);
  // "started" is per probe: an earlier control arm legitimately starts the stub.
  rmSync(f.mcpStartedPath, { force: true });
  const hits = f.page.hits();
  const calls = f.mcpCalls();
  const res = await executeOneShot(`${PROBE_MARKER} run the tools`, driveConfig, driveBot(f.botDir, { connector, model: "claude-sonnet-4-5" }), {
    toolSurface: surface,
    timeoutMs: 90_000,
  });
  const results = f.api.toolResults();
  return {
    results,
    leaked: f.secrets.filter((s) => results.some((r) => r.text.includes(s))),
    bashRan: existsSync(f.bashMarker),
    mcpStarted: f.mcpStarted(),
    mcpCalls: f.mcpCalls() - calls,
    pageHits: f.page.hits() - hits,
    text: res.result,
  };
}

/** The five hostile calls come first in the plan; none may have run. */
function expectHostileRefused(o: Outcome) {
  expect(o.results.slice(0, 5).map((r) => [r.name, r.isError])).toEqual([
    ["Bash", true], ["Read", true], ["Read", true], ["Read", true], ["mcp__stub__record", true],
  ]);
  expect(o.leaked).toEqual([]);
  expect(o.bashRan).toBe(false);
  expect(o.mcpStarted).toBe(false);
  expect(o.mcpCalls).toBe(0);
}

for (const connector of ["claude-cli", "claude-sdk"] as const) {
  const ready = connector === "claude-cli" ? cliReady : sdkReady;
  describe.skipIf(!ready)(`${connector} against the fake Messages API`, () => {
    test('"none": nothing runs, not even the allowed Read or WebFetch', async () => {
      const o = await probe(connector, "none");
      expectHostileRefused(o);
      expect(o.results[5]!.isError).toBe(true);
      expect(o.results[6]!.isError).toBe(true);
      expect(o.pageHits).toBe(0);
      expect(o.text).toContain("PROBE-DONE");
    }, 120_000);

    test("{ read }: only the Read inside the dir runs", async () => {
      const o = await probe(connector, { read: [f.allowedDir] });
      expectHostileRefused(o);
      expect(o.results[5]).toMatchObject({ name: "Read", isError: false });
      expect(o.results[5]!.text).toContain('"type":"image"');
      expect(o.results[6]).toMatchObject({ name: "WebFetch", isError: true });
      expect(o.pageHits).toBe(0);
    }, 120_000);

    test("{ web }: only WebFetch runs, with no permission prompt", async () => {
      // The page is on 127.0.0.1, which claude-sdk's handler refuses (next test).
      if (connector === "claude-sdk") toolSurfaceTestSeam.allowWebHosts = ["127.0.0.1"];
      let o: Outcome;
      try {
        o = await probe(connector, { web: true });
      } finally {
        delete toolSurfaceTestSeam.allowWebHosts;
      }
      expectHostileRefused(o);
      expect(o.results[5]).toMatchObject({ name: "Read", isError: true });
      expect(o.results[6]).toMatchObject({ name: "WebFetch", isError: false });
      expect(o.results[6]!.text).toContain("PAGE-SUMMARY");
      expect(o.pageHits).toBe(1);
    }, 120_000);

    // claude-sdk's handler refuses an IP-literal private host. claude-cli has
    // no such rule: it fetches the same page (the test above), the residual
    // the PR records.
    test.skipIf(connector !== "claude-sdk")("{ web }: WebFetch to a loopback IP literal is refused", async () => {
      const o = await probe(connector, { web: true }, [webFetchPlan(f)]);
      expect(o.results[0]).toMatchObject({ name: "WebFetch", isError: true });
      expect(o.pageHits).toBe(0);
    }, 120_000);

    test('"bot" (control): the stub records a call, so the zeros above are the fence', async () => {
      const o = await probe(connector, "bot", [{ name: "mcp__stub__record", input: { note: "control" } }]);
      expect(o.results[0]).toMatchObject({ name: "mcp__stub__record", isError: false });
      expect(o.mcpCalls).toBe(1);
    }, 120_000);
  });
}
