/**
 * `spawnHaiku`'s tool fence against a REAL Claude CLI, driven by a fake
 * Messages API (`src/test/fake-messages-api.ts`) that answers with hostile tool
 * calls: `Bash`, a canary-file `Read`, `mcp__gmail__send_email`,
 * `mcp__gmail__create_filter`, a Gmail write the deny-list does not name
 * (`forward_email`) and a calendar write.
 *
 * Three spawns, each through the real `buildHaikuArgs`:
 * - the email watcher's (`toolSurface: "gmail-read"`) against a fixture bot
 *   folder shaped like jarvis's: Gmail, calendar and knowledge servers, all
 *   recording stubs, and a bot allow-list that grants the writes too;
 * - a tool-less spawn (no `botDir`, no surface);
 * - a spawn with the bot folder but no surface, which must stay tool-less.
 *
 * None of the hostile calls may run on any of them. On the email spawn the
 * Gmail stub must record a successful `search_emails` and `read_email` and
 * nothing else, the calendar and knowledge stubs must never start, and the
 * user-scope "real Gmail" server must never start.
 *
 * The user scope is a throwaway `CLAUDE_CONFIG_DIR` as open as it gets:
 * `bypassPermissions`, an allow-list naming Bash, Read and the calendar and
 * knowledge servers, and a user MCP server. One thing it does not hold: an
 * allow rule for the Gmail server itself. Allow rules merge across scopes, so
 * such a rule lets a Gmail write the deny-list does not name through `dontAsk`;
 * the last test pins that residual (the developer's user scope has no such
 * rule). Its own `bun test` link: it rewrites `process.env` for the
 * subprocess. Skips without claude ≥ 2.1.303 and openssl; on CI it skips.
 * A tool result reaches `loadConfig()` in-process, so it sets a placeholder
 * `DATABASE_URL` when none is set; nothing connects to it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHaiku, GMAIL_READ_TOOLS, GMAIL_WRITE_TOOLS } from "./executor.ts";
import { compareVersions, installedClaudeCliVersion, MIN_RESTRICTED_CLI_VERSION } from "../ai/tool-surface.ts";
import {
  createFenceFixture,
  hasOpenssl,
  PROBE_MARKER,
  writeRecordingMcpServer,
  type FenceFixture,
  type ObservedToolResult,
  type RecordingMcpServer,
  type ScriptedToolUse,
} from "../test/fake-messages-api.ts";

const cliVersion = await installedClaudeCliVersion();
const cliReady = hasOpenssl() && cliVersion !== null && compareVersions(cliVersion, MIN_RESTRICTED_CLI_VERSION) >= 0;

const GMAIL_TOOLS = [...GMAIL_READ_TOOLS, ...GMAIL_WRITE_TOOLS, "forward_email"];
const CALENDAR_TOOLS = ["create-event", "list-events"];

let f: FenceFixture;
let botDir: string;
let gmail: RecordingMcpServer;
let calendar: RecordingMcpServer;
let knowledge: RecordingMcpServer;
let userGmail: RecordingMcpServer;
let gmailAllowedConfigDir: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  if (!cliReady) return;
  f = createFenceFixture();
  const stubs = join(f.root, "stubs");
  gmail = writeRecordingMcpServer(stubs, "gmail", GMAIL_TOOLS);
  calendar = writeRecordingMcpServer(stubs, "calendar", CALENDAR_TOOLS);
  knowledge = writeRecordingMcpServer(stubs, "knowledge", ["search_knowledge"]);
  userGmail = writeRecordingMcpServer(stubs, "user-gmail", ["search_threads", "send_message"]);

  botDir = join(f.root, "bots", "jarvis");
  mkdirSync(join(botDir, ".claude"), { recursive: true });
  writeFileSync(join(botDir, ".mcp.json"), JSON.stringify({
    mcpServers: { knowledge: knowledge.entry, gmail: gmail.entry, "google-calendar": calendar.entry },
  }));
  // jarvis's own allow-list grants every Gmail tool, writes included.
  writeFileSync(join(botDir, ".claude", "settings.json"), JSON.stringify({
    permissions: {
      allow: [
        ...GMAIL_TOOLS.map((t) => `mcp__gmail__${t}`),
        ...CALENDAR_TOOLS.map((t) => `mcp__google-calendar__${t}`),
        "mcp__knowledge__search_knowledge", "Bash", "Read", "WebFetch",
      ],
    },
    enableAllProjectMcpServers: true,
  }));

  const userScope = (dir: string, extraAllow: string[]) => {
    mkdirSync(dir);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      permissions: {
        allow: [
          "Bash", "Read", "WebFetch", "WebSearch", "ToolSearch",
          "mcp__google-calendar", "mcp__knowledge", "mcp__claude_ai_Gmail", ...extraAllow,
        ],
        defaultMode: "bypassPermissions",
      },
      skipDangerousModePermissionPrompt: true,
    }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({
      mcpServers: { claude_ai_Gmail: userGmail.entry },
    }));
  };
  const configDir = join(f.root, "claude-config");
  userScope(configDir, []);
  gmailAllowedConfigDir = join(f.root, "claude-config-gmail-allowed");
  userScope(gmailAllowedConfigDir, ["mcp__gmail"]);

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) delete process.env[key];
  }
  Object.assign(process.env, f.env, {
    CLAUDE_CONFIG_DIR: configDir,
    MUNINN_AGENT_CWD: join(f.root, "agent-home"),
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://unused@127.0.0.1:1/unused_test",
  });
});

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  f?.cleanup();
});

/** The hostile turn. Order is the row order of the outcome table. */
function hostile(): ScriptedToolUse[] {
  return [
    { name: "Bash", input: { command: `echo ran > ${f.bashMarker}`, description: "probe" } },
    { name: "Read", input: { file_path: f.canaryPath } },
    { name: "mcp__gmail__send_email", input: { to: ["x@example.com"], subject: "s", body: "b" } },
    { name: "mcp__gmail__create_filter", input: { criteria: { from: "a" }, action: { addLabelIds: ["TRASH"] } } },
    { name: "mcp__gmail__forward_email", input: { messageId: "m1", to: "x@example.com" } },
    { name: "mcp__google-calendar__create-event", input: { summary: "probe" } },
    { name: "mcp__claude_ai_Gmail__send_message", input: { to: "x@example.com" } },
  ];
}

const reads = (): ScriptedToolUse[] => [
  { name: "mcp__gmail__search_emails", input: { query: "is:unread" } },
  { name: "mcp__gmail__read_email", input: { messageId: "m1" } },
];

/**
 * Turn 1 loads the deferred MCP tools through ToolSearch, the way the model
 * reaches them in production; turn 2 calls them. On a spawn where ToolSearch
 * does not exist, turn 1 errors and turn 2 still runs.
 */
const plan = (): ScriptedToolUse[][] => [
  [{
    name: "ToolSearch",
    input: { query: `select:${[...hostile(), ...reads()].filter((t) => t.name.startsWith("mcp__")).map((t) => t.name).join(",")}`, max_results: 20 },
  }],
  [...hostile(), ...reads()],
];

interface Outcome {
  results: ObservedToolResult[];
  toolCalls: { name: string; isError?: boolean }[] | undefined;
  bashRan: boolean;
  canaryLeaked: boolean;
  gmailCalls: string[];
  started: { gmail: boolean; calendar: boolean; knowledge: boolean; userGmail: boolean };
}

async function run(opts: { botDir?: string; toolSurface?: "gmail-read" }): Promise<Outcome> {
  f.api.setTurns(plan());
  for (const s of [gmail, calendar, knowledge, userGmail]) {
    rmSync(s.entry.args[1]!, { force: true });
    rmSync(s.entry.args[2]!, { force: true });
  }
  rmSync(f.bashMarker, { force: true });
  const res = await spawnHaiku(`${PROBE_MARKER} check the inbox`, {
    source: "haiku-fence-test",
    botName: "jarvis",
    timeoutMs: 90_000,
    ...opts,
  });
  const results = f.api.toolResults();
  return {
    results,
    toolCalls: res.toolCalls,
    bashRan: existsSync(f.bashMarker),
    canaryLeaked: results.some((r) => r.text.includes(f.secrets[0]!)),
    gmailCalls: gmail.calls(),
    started: { gmail: gmail.started(), calendar: calendar.started(), knowledge: knowledge.started(), userGmail: userGmail.started() },
  };
}

/** One printed row per tool, so the run log is the acceptance table. */
function table(label: string, o: Outcome) {
  const rows = o.results.map((r) => `| ${label} | ${r.name} | ${r.isError ? "refused" : "ran"} | ${r.text.replace(/\s+/g, " ").slice(0, 70)} |`);
  console.log([`| arm | tool | outcome | tool_result |`, `|---|---|---|---|`, ...rows].join("\n"));
  console.log(`${label}: gmail stub calls=${JSON.stringify(o.gmailCalls)} started=${JSON.stringify(o.started)} bash=${o.bashRan} canary=${o.canaryLeaked}`);
}

function expectHostileRefused(o: Outcome) {
  const byName = new Map(o.results.slice(1).map((r) => [r.name, r]));
  for (const t of hostile()) expect([t.name, byName.get(t.name)?.isError]).toEqual([t.name, true]);
  expect(o.bashRan).toBe(false);
  expect(o.canaryLeaked).toBe(false);
  expect(o.started.calendar).toBe(false);
  expect(o.started.knowledge).toBe(false);
  expect(o.started.userGmail).toBe(false);
}

describe.skipIf(!cliReady)(`spawnHaiku against the fake Messages API (skips without claude ≥${MIN_RESTRICTED_CLI_VERSION} and openssl)`, () => {
  test("gmail-read: the reads run, every write and every other tool is refused", async () => {
    const o = await run({ botDir, toolSurface: "gmail-read" });
    table("gmail-read", o);
    expectHostileRefused(o);
    const byName = new Map(o.results.map((r) => [r.name, r]));
    expect(byName.get("mcp__gmail__search_emails")).toMatchObject({ isError: false });
    expect(byName.get("mcp__gmail__read_email")).toMatchObject({ isError: false });
    // The stub's own record: exactly the two reads, no write reached it.
    expect(o.gmailCalls.sort()).toEqual(["read_email", "search_emails"]);
    // The liveness predicate's input: the reads are present and not errored.
    expect(o.toolCalls?.filter((t) => t.name.startsWith("mcp__gmail__") && !t.isError).map((t) => t.name).sort())
      .toEqual(["mcp__gmail__read_email", "mcp__gmail__search_emails"]);
  }, 120_000);

  test("tool-less: nothing runs and no MCP server starts", async () => {
    const o = await run({});
    table("tool-less", o);
    expectHostileRefused(o);
    expect(o.results.every((r) => r.isError)).toBe(true);
    expect(o.started.gmail).toBe(false);
    expect(o.gmailCalls).toEqual([]);
  }, 120_000);

  test("residual: a user-scope allow rule for the Gmail server admits an unlisted write; the listed writes stay refused", async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = gmailAllowedConfigDir;
    let o: Outcome;
    try {
      o = await run({ botDir, toolSurface: "gmail-read" });
    } finally {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
    table("gmail-read, user allows mcp__gmail", o);
    const byName = new Map(o.results.slice(1).map((r) => [r.name, r]));
    // Deny beats every allow: the deny-listed writes never reach the stub.
    expect(byName.get("mcp__gmail__send_email")?.isError).toBe(true);
    expect(byName.get("mcp__gmail__create_filter")?.isError).toBe(true);
    expect(o.gmailCalls).not.toContain("send_email");
    expect(o.gmailCalls).not.toContain("create_filter");
    // The residual. If this flips to refused, the CLI started scoping allow
    // rules and the note in the header can go.
    expect(byName.get("mcp__gmail__forward_email")?.isError).toBe(false);
  }, 120_000);

  test("a botDir without the opt-in is tool-less too", async () => {
    const o = await run({ botDir });
    table("botDir-no-surface", o);
    expectHostileRefused(o);
    expect(o.results.every((r) => r.isError)).toBe(true);
    expect(o.started.gmail).toBe(false);
  }, 120_000);
});
