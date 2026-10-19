import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setClaudeCliVersionForTest,
  assertRestrictedCliAvailable,
  compareVersions,
  fencedCanUseTool,
  fencedSettings,
  installedClaudeCliVersion,
  isFetchableWebUrl,
  isInsideDirs,
  refuseFencedSurface,
  toolSurfaceTestSeam,
} from "./tool-surface.ts";
import { applyToolSurface, executeOneShot } from "./one-shot.ts";
import { resolveAgentCwd } from "./agent-cwd.ts";
import { tracedOneShot } from "../core/traced-one-shot.ts";
import { driveBot, driveCapture, driveConfig, silentTracer } from "../test/one-shot-drive.ts";

/**
 * The claude-cli half of the declared tool surface, driven from the top layer
 * (`runCaptureOneShot`) down to the real `executeClaudePrompt` argv; only
 * `Bun.spawn` is stubbed. The claude-sdk, copilot-sdk and openai-compat halves
 * have their own files, because each mocks a module or a global.
 */

let root: string;
let botDir: string;
let framesDir: string;
let agentRoot: string;
const savedAgentCwd = process.env.MUNINN_AGENT_CWD;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tool-surface-")));
  botDir = join(root, "bot");
  framesDir = join(root, "frames");
  agentRoot = join(root, "agent-home");
  mkdirSync(botDir);
  mkdirSync(framesDir);
  writeFileSync(join(framesDir, "x.jpg"), "jpg");
  // The fenced shapes must drop the bot's own servers, so the bot has some.
  writeFileSync(join(botDir, ".mcp.json"), JSON.stringify({ mcpServers: { gmail: { command: "true" } } }));
  process.env.MUNINN_AGENT_CWD = agentRoot;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedAgentCwd === undefined) delete process.env.MUNINN_AGENT_CWD;
  else process.env.MUNINN_AGENT_CWD = savedAgentCwd;
  __setClaudeCliVersionForTest(undefined);
});

describe("applyToolSurface", () => {
  const bot = () => driveBot("/tmp/b");

  test('"bot" keeps the bot\'s surface and "none" sets toolsDisabled, never mutating the caller', () => {
    const original = bot();
    expect(applyToolSurface(original, "bot", undefined).toolsDisabled).toBeUndefined();
    const none = applyToolSurface(original, "none", undefined);
    expect(none.toolsDisabled).toBe(true);
    expect(none.toolSurface).toBe("none");
    expect(original.toolsDisabled).toBeUndefined();
    expect(original.toolSurface).toBeUndefined();
  });

  test("{ read } carries its dirs; relative or empty dirs are refused", () => {
    expect(applyToolSurface(bot(), { read: ["/tmp/f/"] }, undefined).toolSurface).toEqual({ read: ["/tmp/f"] });
    expect(() => applyToolSurface(bot(), { read: [] }, undefined)).toThrow(/at least one directory/);
    expect(() => applyToolSurface(bot(), { read: ["frames"] }, undefined)).toThrow(/absolute/);
  });

  test("extraDirs ride only on \"bot\", and the error names the surface", () => {
    expect(() => applyToolSurface(bot(), { read: ["/tmp/f"] }, ["/tmp/g"])).toThrow(/only allowed with toolSurface "bot"/);
    expect(() => applyToolSurface(bot(), "none", ["/tmp/g"])).toThrow(/only allowed/);
    expect(() => applyToolSurface(bot(), { web: true }, ["/tmp/g"])).toThrow(/only allowed/);
    expect(() => applyToolSurface(bot(), "none", ["/tmp/g"])).toThrow(/^executeOneShot: extraDirs is only allowed with toolSurface "bot", not "none"\.$/);
    expect(applyToolSurface(bot(), "bot", ["/tmp/g"]).toolSurface).toBe("bot");
    expect(applyToolSurface(bot(), { read: ["/tmp/f"] }, []).toolSurface).toEqual({ read: ["/tmp/f"] });
  });

  test("copilot-sdk and openai-compat refuse the fenced shapes by capability", () => {
    for (const connector of ["copilot-sdk", "openai-compat"] as const) {
      const b = driveBot("/tmp/b", { connector });
      expect(() => applyToolSurface(b, { read: ["/tmp/f"] }, undefined)).toThrow(/cannot run a \{ read \}/);
      expect(() => applyToolSurface(b, { web: true }, undefined)).toThrow(/cannot run a \{ web \}/);
      expect(applyToolSurface(b, "none", undefined).toolsDisabled).toBe(true);
      expect(applyToolSurface(b, "bot", undefined).toolSurface).toBe("bot");
    }
  });

  test("refuseFencedSurface is the connectors' own refusal", () => {
    expect(() => refuseFencedSurface("copilot-sdk", { web: true })).toThrow(/copilot-sdk: the \{ web \}/);
    expect(() => refuseFencedSurface("openai-compat", { read: ["/x"] })).toThrow(/\{ read \}/);
    expect(() => refuseFencedSurface("copilot-sdk", "none")).not.toThrow();
    expect(() => refuseFencedSurface("copilot-sdk", undefined)).not.toThrow();
  });
});

describe("fencedCanUseTool", () => {
  test("{ read } allows Read under the dirs only — traversal and symlinks resolved", async () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret");
    const link = join(framesDir, "escape.txt");
    symlinkSync(outside, link);
    const can = fencedCanUseTool({ read: [framesDir] });
    const opts = { signal: new AbortController().signal } as never;
    expect((await can("Read", { file_path: join(framesDir, "x.jpg") }, opts))!.behavior).toBe("allow");
    expect((await can("Read", { file_path: outside }, opts))!.behavior).toBe("deny");
    expect((await can("Read", { file_path: join(framesDir, "..", "outside.txt") }, opts))!.behavior).toBe("deny");
    expect((await can("Read", { file_path: link }, opts))!.behavior).toBe("deny");
    expect((await can("Read", { file_path: `${framesDir}-sibling/x.jpg` }, opts))!.behavior).toBe("deny");
    expect((await can("Bash", { command: "ls" }, opts))!.behavior).toBe("deny");
    expect((await can("WebFetch", { url: "https://x" }, opts))!.behavior).toBe("deny");
    expect((await can("mcp__gmail__send_email", {}, opts))!.behavior).toBe("deny");
  });

  test("{ web } allows the web tools only", async () => {
    const can = fencedCanUseTool({ web: true });
    const opts = { signal: new AbortController().signal } as never;
    expect((await can("WebFetch", { url: "https://x" }, opts))!.behavior).toBe("allow");
    expect((await can("WebSearch", { query: "q" }, opts))!.behavior).toBe("allow");
    expect((await can("Read", { file_path: join(framesDir, "x.jpg") }, opts))!.behavior).toBe("deny");
    expect((await can("Bash", { command: "ls" }, opts))!.behavior).toBe("deny");
  });

  test("{ web } refuses WebFetch to loopback, private and local-only hosts", async () => {
    const can = fencedCanUseTool({ web: true });
    const opts = { signal: new AbortController().signal } as never;
    const denied = [
      "https://127.0.0.1:8443/page", "http://127.0.0.1/", "https://2130706433/", "https://0x7f.1/",
      "https://10.1.2.3/", "https://172.16.0.1/", "https://172.31.255.255/", "https://192.168.1.1/",
      "https://169.254.169.254/latest/meta-data/", "https://100.64.0.1/", "https://100.127.255.254/", "https://0.0.0.0/",
      "https://[::1]/", "https://[::]/", "https://[fe80::1]/", "https://[fd00::1]/", "https://[fc00::1]/",
      "https://[::ffff:127.0.0.1]/", "https://[::ffff:10.0.0.1]/", "https://[::ffff:169.254.169.254]/",
      "https://localhost/", "https://LOCALHOST./", "https://api.localhost/", "https://metadata.google.internal/",
      "https://printer.local/", "ftp://example.com/", "file:///etc/passwd", "not a url",
    ];
    for (const url of denied) {
      expect([url, (await can("WebFetch", { url, prompt: "p" }, opts))!.behavior]).toEqual([url, "deny"]);
    }
    expect((await can("WebFetch", { prompt: "p" }, opts))!.behavior).toBe("deny");
    const allowed = [
      "https://example.com/a", "http://example.com/", "https://8.8.8.8/", "https://172.32.0.1/",
      "https://100.128.0.1/", "https://[2606:4700::1111]/", "https://localhost.example.com/",
    ];
    for (const url of allowed) {
      expect([url, (await can("WebFetch", { url, prompt: "p" }, opts))!.behavior]).toEqual([url, "allow"]);
    }
    expect((await can("WebSearch", { query: "q" }, opts))!.behavior).toBe("allow");
  });

  test("isInsideDirs treats the dir itself as inside and a prefix-sharing sibling as outside", () => {
    expect(isInsideDirs(framesDir, [framesDir])).toBe(true);
    expect(isInsideDirs(`${framesDir}2/a`, [framesDir])).toBe(false);
  });
});

describe("isInsideDirs fails closed", () => {
  // `dl` points at `root`, outside `framesDir`; `filelink.txt` at a file outside it.
  let dl: string;
  let fileLink: string;
  beforeAll(() => {
    writeFileSync(join(root, "real.txt"), "secret");
    dl = join(framesDir, "dl");
    symlinkSync(root, dl);
    fileLink = join(framesDir, "filelink.txt");
    symlinkSync(join(root, "real.txt"), fileLink);
    symlinkSync(join(root, "gone.txt"), join(framesDir, "dangling.txt"));
  });

  test("a trailing slash on a file symlink is outside: realpath refuses it (ENOTDIR), and the walk would too", async () => {
    expect(isInsideDirs(`${fileLink}/`, [framesDir])).toBe(false);
    const can = fencedCanUseTool({ read: [framesDir] });
    const opts = { signal: new AbortController().signal } as never;
    expect((await can("Read", { file_path: `${fileLink}/` }, opts))!.behavior).toBe("deny");
  });

  test("a path too long to resolve (ENAMETOOLONG) is outside, even when it names a new file inside", () => {
    // Over PATH_MAX on macOS (1024) and Linux (4096). Without the `./` runs the
    // walk would resolve <frames>/new.jpg as inside: only the realpath error refuses it.
    expect(isInsideDirs(`${framesDir}/${"./".repeat(2100)}new.jpg`, [framesDir])).toBe(false);
  });

  test("a missing file under an escaping dir symlink is outside", () => {
    expect(isInsideDirs(`${dl}/nope.txt`, [framesDir])).toBe(false);
    expect(isInsideDirs(`${dl}/nope/deeper.txt`, [framesDir])).toBe(false);
  });

  test("a `..` segment is outside: Bun's realpath applies it before following symlinks", () => {
    // Defense in depth: the Read tool normalizes `..` before opening, so this gap is
    // unreachable through the CLI or SDK today. deep -> <root>/b/c, so a raw open of
    // <frames>/deep/../x.jpg reads <root>/b/x.jpg, while a lexical `..` lands on <frames>/x.jpg.
    mkdirSync(join(root, "b", "c"), { recursive: true });
    writeFileSync(join(root, "b", "x.jpg"), "secret");
    symlinkSync(join(root, "b", "c"), join(framesDir, "deep"));
    expect(readFileSync(`${framesDir}/deep/../x.jpg`, "utf8")).toBe("secret");
    expect(isInsideDirs(`${framesDir}/deep/../x.jpg`, [framesDir])).toBe(false);
    expect(isInsideDirs(`${framesDir}/nope/../x.jpg`, [framesDir])).toBe(false);
  });

  test("a dangling symlink is outside: its target is not a component that does not exist", () => {
    expect(isInsideDirs(join(framesDir, "dangling.txt"), [framesDir])).toBe(false);
  });

  test("a relative path is outside, whatever muninn's own cwd is", async () => {
    const saved = process.cwd();
    process.chdir(framesDir);
    try {
      expect(isInsideDirs("x.jpg", [framesDir])).toBe(false);
      const can = fencedCanUseTool({ read: [framesDir] });
      const opts = { signal: new AbortController().signal } as never;
      expect((await can("Read", { file_path: "x.jpg" }, opts))!.behavior).toBe("deny");
    } finally {
      process.chdir(saved);
    }
  });

  test("a root that does not resolve contains nothing: a file used as a dir (ENOTDIR)", () => {
    expect(isInsideDirs(join(framesDir, "x.jpg"), [`${join(root, "real.txt")}/`])).toBe(false);
    expect(isInsideDirs(join(framesDir, "x.jpg"), [join(root, "real.txt", "sub")])).toBe(false);
  });

  test("a root that does not resolve contains nothing: a dangling symlink", () => {
    expect(isInsideDirs(join(framesDir, "x.jpg"), [join(framesDir, "dangling.txt")])).toBe(false);
  });

  test("a root that does not resolve contains nothing: a symlink loop (ELOOP)", () => {
    const loop = join(root, "loop");
    symlinkSync(loop, loop);
    expect(isInsideDirs(join(framesDir, "x.jpg"), [loop])).toBe(false);
    expect(isInsideDirs(join(framesDir, "x.jpg"), [join(loop, "sub")])).toBe(false);
  });

  test('a root of "/" or with a trailing separator contains its files', () => {
    expect(isInsideDirs(join(framesDir, "x.jpg"), ["/"])).toBe(true);
    expect(isInsideDirs(join(framesDir, "x.jpg"), [`${framesDir}/`])).toBe(true);
  });

  test("a file not yet created under a real dir stays inside", () => {
    expect(isInsideDirs(join(framesDir, "new.jpg"), [framesDir])).toBe(true);
    expect(isInsideDirs(join(framesDir, "sub", "new.jpg"), [framesDir])).toBe(true);
  });
});

describe("fencedSettings and the test seam", () => {
  afterEach(() => {
    delete toolSurfaceTestSeam.extraSettings;
  });

  test("{ web } pre-approves the web tools; { read } needs no settings", () => {
    expect(fencedSettings({ web: true })).toEqual({ permissions: { allow: ["WebFetch", "WebSearch"] } });
    expect(fencedSettings({ read: ["/x"] })).toBeUndefined();
  });

  test("the seam merges into the one settings object", () => {
    toolSurfaceTestSeam.extraSettings = { skipWebFetchPreflight: true };
    expect(fencedSettings({ web: true })).toEqual({
      permissions: { allow: ["WebFetch", "WebSearch"] },
      skipWebFetchPreflight: true,
    });
    expect(fencedSettings({ read: ["/x"] })).toEqual({ skipWebFetchPreflight: true });
  });

  test("compareVersions orders numerically, not lexically", () => {
    expect(compareVersions("2.1.303", "2.1.303")).toBe(0);
    expect(compareVersions("2.1.99", "2.1.303")).toBeLessThan(0);
    expect(compareVersions("2.2.0", "2.1.303")).toBeGreaterThan(0);
  });
});

describe("the CLI version probe", () => {
  // A fake `claude` on the real spawn path: both spawn calls are redirected to
  // it, so the probe's caching and timeout run against a real process.
  let fake: string;
  let spawnSpy: ReturnType<typeof spyOn>;
  let syncSpy: ReturnType<typeof spyOn>;
  const setFake = (mode: string) => writeFileSync(`${fake}.mode`, mode);
  /** Every `claude` process the probe spawned, in order. */
  let probes: ReturnType<typeof Bun.spawn>[];

  beforeEach(() => {
    fake = join(root, "fake-claude");
    writeFileSync(
      fake,
      '#!/bin/sh\nmode=$(cat "$0.mode")\ncase "$mode" in fail) exit 1;; hang) exec sleep 4;; ' +
        // Ignores SIGTERM; only SIGKILL ends it.
        "deaf) trap '' TERM; exec sleep 4;; " +
        // Dies on SIGTERM, but a background child keeps stdout open for 3 s.
        "orphan) sleep 3 & exec sleep 4;; " +
        'slow) sleep 0.3; echo "2.1.400 (Claude Code)";; *) echo "$mode (Claude Code)";; esac\n',
      { mode: 0o755 },
    );
    const realSpawn = Bun.spawn;
    const realSync = Bun.spawnSync;
    const redirect = (cmd: string[]) => (cmd[0] === "claude" ? [fake, ...cmd.slice(1)] : cmd);
    probes = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], o: never) => {
      const proc = realSpawn(redirect(cmd), o);
      if (cmd[0] === "claude") probes.push(proc);
      return proc;
    }) as never);
    syncSpy = spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[], o: never) => realSync(redirect(cmd), o)) as never);
    __setClaudeCliVersionForTest(undefined);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    syncSpy.mockRestore();
    delete toolSurfaceTestSeam.cliProbeTimeoutMs;
    delete toolSurfaceTestSeam.cliProbeKillGraceMs;
    for (const p of probes) p.kill("SIGKILL");
    __setClaudeCliVersionForTest(undefined);
  });

  test("a failed read is not cached: the next fenced call reads again", async () => {
    setFake("fail");
    expect(await installedClaudeCliVersion()).toBeNull();
    setFake("2.1.400");
    expect(await installedClaudeCliVersion()).toBe("2.1.400");
    // A good version is cached: a later failure does not unseat it.
    setFake("fail");
    expect(await installedClaudeCliVersion()).toBe("2.1.400");
  });

  test("an old version is not cached: an upgrade is picked up without a restart", async () => {
    setFake("2.1.302");
    await expect((async () => assertRestrictedCliAvailable({ web: true }))()).rejects.toThrow(/2\.1\.303.*found 2\.1\.302/);
    setFake("2.1.303");
    await expect((async () => assertRestrictedCliAvailable({ web: true }))()).resolves.toBeUndefined();
  });

  test("a hanging `claude --version` times out without blocking the event loop", async () => {
    setFake("hang");
    toolSurfaceTestSeam.cliProbeTimeoutMs = 300;
    let ticked = false;
    setTimeout(() => { ticked = true; }, 50);
    const start = performance.now();
    const version = await installedClaudeCliVersion();
    expect(version).toBeNull();
    expect(performance.now() - start).toBeLessThan(2000);
    expect(ticked).toBe(true);
  }, 10_000);

  test("a timed-out probe is sent SIGTERM first, and returns once it has exited", async () => {
    setFake("hang");
    toolSurfaceTestSeam.cliProbeTimeoutMs = 200;
    toolSurfaceTestSeam.cliProbeKillGraceMs = 1_000;
    expect(await installedClaudeCliVersion()).toBeNull();
    expect(probes.length).toBe(1);
    expect(probes[0]!.signalCode).toBe("SIGTERM");
  }, 10_000);

  test("a probe that ignores SIGTERM is killed with SIGKILL before the call returns", async () => {
    setFake("deaf");
    toolSurfaceTestSeam.cliProbeTimeoutMs = 200;
    toolSurfaceTestSeam.cliProbeKillGraceMs = 300;
    expect(await installedClaudeCliVersion()).toBeNull();
    expect(probes.length).toBe(1);
    expect(probes[0]!.signalCode).toBe("SIGKILL");
  }, 10_000);

  test("the timeout does not wait for stdout to close: a child holding the pipe does not hold the call", async () => {
    setFake("orphan");
    toolSurfaceTestSeam.cliProbeTimeoutMs = 200;
    toolSurfaceTestSeam.cliProbeKillGraceMs = 300;
    const start = performance.now();
    expect(await installedClaudeCliVersion()).toBeNull();
    // The background `sleep 3` keeps stdout open; reading it to the end takes ~3 s.
    expect(performance.now() - start).toBeLessThan(1_500);
  }, 10_000);

  test("concurrent callers share one probe", async () => {
    setFake("slow");
    const versions = await Promise.all(Array.from({ length: 5 }, () => installedClaudeCliVersion()));
    expect(versions).toEqual(Array(5).fill("2.1.400"));
    expect(probes.length).toBe(1);
  }, 10_000);
});

describe("claude-cli argv, driven from runCaptureOneShot", () => {
  type Spawned = { args: string[]; cwd: string };
  let spawned: Spawned[];
  let spawnSpy: ReturnType<typeof spyOn>;

  const resultLine = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "ok",
    duration_ms: 5, duration_api_ms: 4, num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });

  beforeEach(() => {
    spawned = [];
    __setClaudeCliVersionForTest("2.1.303");
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[], opts: { cwd: string }) => {
      spawned.push({ args, cwd: opts.cwd });
      return {
        pid: 1,
        stdout: new Response(resultLine + "\n").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as never);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    delete toolSurfaceTestSeam.extraSettings;
  });

  const flagValues = (args: string[], flag: string) =>
    args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

  test('"bot": today\'s argv, cwd the bot folder, the bot\'s MCP config', async () => {
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), "bot");
    const { args, cwd } = spawned[0]!;
    expect(cwd).toBe(botDir);
    expect(args).not.toContain("--restricted");
    expect(args).not.toContain("--tools");
    expect(flagValues(args, "--mcp-config")).toEqual([join(botDir, ".mcp.json")]);
  });

  test('"none": no built-ins, no MCP server at all', async () => {
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), "none");
    const { args, cwd } = spawned[0]!;
    expect(cwd).toBe(botDir);
    expect(flagValues(args, "--tools")).toEqual([""]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--restricted");
  });

  test("{ read }: --restricted, Read only, the dirs added, an empty agent home as cwd", async () => {
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), { read: [framesDir] });
    const { args, cwd } = spawned[0]!;
    expect(cwd).toBe(join(agentRoot, ".fenced"));
    expect(args).toContain("--restricted");
    expect(flagValues(args, "--tools")).toEqual(["Read"]);
    expect(args).toContain("--strict-mcp-config");
    expect(flagValues(args, "--add-dir")).toEqual([framesDir]);
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--settings");
    // runCaptureOneShot's own capture cap sets effort.
    expect(flagValues(args, "--effort")).toEqual(["low"]);
  });

  test("{ web }: --restricted, the web tools only, ONE --settings carrying the allow rule", async () => {
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), { web: true });
    const { args, cwd } = spawned[0]!;
    expect(cwd).toBe(join(agentRoot, ".fenced"));
    expect(args).toContain("--restricted");
    expect(flagValues(args, "--tools")).toEqual(["WebFetch,WebSearch"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--add-dir");
    const settings = flagValues(args, "--settings");
    expect(settings).toHaveLength(1);
    expect(JSON.parse(settings[0]!)).toEqual({ permissions: { allow: ["WebFetch", "WebSearch"] } });
  });

  test("the test seam lands in the same single --settings", async () => {
    toolSurfaceTestSeam.extraSettings = { skipWebFetchPreflight: true };
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), { web: true });
    const settings = flagValues(spawned[0]!.args, "--settings");
    expect(settings).toHaveLength(1);
    expect(JSON.parse(settings[0]!)).toEqual({
      permissions: { allow: ["WebFetch", "WebSearch"] },
      skipWebFetchPreflight: true,
    });
  });

  test("a fenced run with no effort anywhere states --effort high (the user effortLevel is dropped)", async () => {
    await tracedOneShot(silentTracer(), "claude", "p", driveConfig, driveBot(botDir, { connector: "claude-cli" }), {
      toolSurface: { web: true },
    });
    expect(flagValues(spawned[0]!.args, "--effort")).toEqual(["high"]);
    await executeOneShot("p", driveConfig, driveBot(botDir, { connector: "claude-cli", effort: "medium" }), {
      toolSurface: { read: [framesDir] },
    });
    expect(flagValues(spawned[1]!.args, "--effort")).toEqual(["medium"]);
    await executeOneShot("p", driveConfig, driveBot(botDir, { connector: "claude-cli" }), { toolSurface: "bot" });
    expect(spawned[2]!.args).not.toContain("--effort");
  });

  test("a CLI older than 2.1.303 refuses the fenced shapes before spawning", async () => {
    __setClaudeCliVersionForTest("2.1.302");
    await expect(driveCapture(driveBot(botDir, { connector: "claude-cli" }), { web: true })).rejects.toThrow(/2\.1\.303/);
    __setClaudeCliVersionForTest(null);
    await expect(driveCapture(driveBot(botDir, { connector: "claude-cli" }), { read: [framesDir] })).rejects.toThrow(/no readable version/);
    expect(spawned).toHaveLength(0);
    // The unfenced shapes do not depend on the version.
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), "none");
    expect(spawned).toHaveLength(1);
  });

  test("a malformed surface is refused before spawning, never read as { web }", async () => {
    for (const bad of [undefined, null, {}, { web: false }, { web: "yes" }, { read: "/tmp" }]) {
      await expect(
        driveCapture(driveBot(botDir, { connector: "claude-cli" }), bad as never),
      ).rejects.toThrow(/unknown toolSurface/);
    }
    for (const bad of [undefined, null, {}, { web: false }]) {
      expect(() => applyToolSurface(driveBot(botDir, { connector: "claude-sdk" }), bad as never, undefined)).toThrow(
        /unknown toolSurface/,
      );
    }
    expect(spawned).toHaveLength(0);
  });

  test("a fenced surface refuses the bot's spawnArgs, which could re-add --settings or --mcp-config", async () => {
    const withArgs = driveBot(botDir, { connector: "claude-cli", spawnArgs: ["--settings", "{}"] });
    await expect(driveCapture(withArgs, { web: true })).rejects.toThrow(/spawnArgs/);
    await expect(driveCapture(withArgs, { read: [framesDir] })).rejects.toThrow(/spawnArgs/);
    expect(spawned).toHaveLength(0);
    // The unfenced shapes keep appending them (the benchmark scratch bot).
    await driveCapture(withArgs, "bot");
    await driveCapture(withArgs, "none");
    expect(spawned).toHaveLength(2);
    for (const { args } of spawned) expect(flagValues(args, "--settings")).toEqual(["{}"]);
  });

  test("a fenced run's agent home is a bucket no caller name maps to", async () => {
    await driveCapture(driveBot(botDir, { connector: "claude-cli" }), { read: [framesDir] });
    const { cwd } = spawned[0]!;
    for (const name of ["capture", "fenced", ".fenced", "shared", undefined]) {
      expect(resolveAgentCwd(name)).not.toBe(cwd);
    }
  });

  test("a degraded agent home refuses a fenced run before spawning", async () => {
    // mkdir in a read-only root fails (EACCES), so the agent home degrades to $TMPDIR.
    const readOnly = join(root, "read-only-home");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    process.env.MUNINN_AGENT_CWD = readOnly;
    try {
      await expect(driveCapture(driveBot(botDir, { connector: "claude-cli" }), { read: [framesDir] })).rejects.toThrow(/agent home/);
      await expect(driveCapture(driveBot(botDir, { connector: "claude-cli" }), { web: true })).rejects.toThrow(/agent home/);
      expect(spawned).toHaveLength(0);
      // An unfenced run keeps running in the bot folder.
      await driveCapture(driveBot(botDir, { connector: "claude-cli" }), "none");
      expect(spawned).toHaveLength(1);
    } finally {
      chmodSync(readOnly, 0o700);
      process.env.MUNINN_AGENT_CWD = agentRoot;
    }
  });

  test("{ read } with extraDirs beside it is refused before spawning", async () => {
    await expect(
      driveCapture(driveBot(botDir, { connector: "claude-cli" }), { read: [framesDir] }, { extraDirs: [root] }),
    ).rejects.toThrow(/only allowed with toolSurface "bot"/);
    expect(spawned).toHaveLength(0);
  });
});

/**
 * The IP denylist, enumerated. V4_BLOCKED and V6_BLOCKED are the full list of
 * what `isFetchableWebUrl` blocks by address: a range missing here is one the
 * code does not block, and the function's doc comment lists the same ranges.
 * Each row pins the first and last address (denied) and the address just
 * below and just above (allowed); `null` means the range touches the end of
 * the address space or the next address on that side is blocked too (fe80::/10
 * and fec0::/10 above, 64:ff9b::/96 inside the /32), and a neighbour that falls in another blocked range is replaced by the
 * nearest allowed one, named in `note`.
 */
describe("the IP denylist, enumerated: these tables are everything isFetchableWebUrl blocks by address", () => {
  type V4Row = { range: string; first: string; last: string; below: string | null; above: string | null; embedded: string; otherFirstOctet?: string[] };
  // `otherFirstOctet`: on a range narrower than /8, its first and last address with the first octet moved by one pass.
  // `embedded` is a private address chosen so that its bytes read at a wrong offset form a public address where they can
  // (see the offset test below); the IPv6 forms of each row embed it.
  const V4_BLOCKED: V4Row[] = [
    { range: "0.0.0.0/8", first: "0.0.0.0", last: "0.255.255.255", below: null, above: "1.0.0.0", embedded: "0.1.1.1" },
    { range: "10.0.0.0/8", first: "10.0.0.0", last: "10.255.255.255", below: "9.255.255.255", above: "11.0.0.0", embedded: "10.1.1.1" },
    { range: "100.64.0.0/10", first: "100.64.0.0", last: "100.127.255.255", below: "100.63.255.255", above: "100.128.0.0", embedded: "100.64.1.1", otherFirstOctet: ["99.64.0.0", "101.127.255.255"] },
    { range: "127.0.0.0/8", first: "127.0.0.0", last: "127.255.255.255", below: "126.255.255.255", above: "128.0.0.0", embedded: "127.1.1.1" },
    { range: "169.254.0.0/16", first: "169.254.0.0", last: "169.254.255.255", below: "169.253.255.255", above: "169.255.0.0", embedded: "169.254.1.1", otherFirstOctet: ["168.254.0.0", "170.254.255.255"] },
    { range: "172.16.0.0/12", first: "172.16.0.0", last: "172.31.255.255", below: "172.15.255.255", above: "172.32.0.0", embedded: "172.16.1.1", otherFirstOctet: ["171.16.0.0", "173.31.255.255"] },
    { range: "192.0.0.0/24", first: "192.0.0.0", last: "192.0.0.255", below: "191.255.255.255", above: "192.0.1.0", embedded: "192.0.0.1", otherFirstOctet: ["191.0.0.0", "193.0.0.255"] },
    { range: "192.0.2.0/24", first: "192.0.2.0", last: "192.0.2.255", below: "192.0.1.255", above: "192.0.3.0", embedded: "192.0.2.1", otherFirstOctet: ["191.0.2.0", "193.0.2.255"] },
    { range: "192.168.0.0/16", first: "192.168.0.0", last: "192.168.255.255", below: "192.167.255.255", above: "192.169.0.0", embedded: "192.168.1.1", otherFirstOctet: ["191.168.0.0", "193.168.255.255"] },
    { range: "198.18.0.0/15", first: "198.18.0.0", last: "198.19.255.255", below: "198.17.255.255", above: "198.20.0.0", embedded: "198.18.1.1", otherFirstOctet: ["197.18.0.0", "199.19.255.255"] },
    { range: "224.0.0.0/3", first: "224.0.0.0", last: "255.255.255.255", below: "223.255.255.255", above: null, embedded: "224.1.1.1" },
  ];

  type V6Row = { range: string; first: string; last: string; below: string | null; above: string | null; note?: string; alsoDenied?: string[]; alsoAllowed?: string[] };
  // `alsoAllowed` on an embedding prefix holds addresses that embed 127.0.0.1 and differ from the prefix in one byte
  // alone, for some of its bytes, not all: ::/96 bytes 1, 9, 10 and 11; ::ffff:0:0/96 bytes 9, 10 and 11; 64:ff9b::/96
  // bytes 0-3 (its bytes 4, 5 and 11 are in the 64:ff9b::/32 row's alsoDenied); 2002::/16 bytes 0 and 1.
  const V6_BLOCKED: V6Row[] = [
    {
      range: "::/96 (unspecified, loopback, IPv4-compatible), judged by its IPv4", first: "::", last: "::ffff:ffff",
      below: null, above: "::1:0:0", alsoDenied: ["::1"],
      alsoAllowed: ["1::7f00:1", "0:0:0:0:1:0:7f00:1", "::100:7f00:1", "::1:7f00:1"],
    },
    {
      range: "::ffff:0:0/96 (IPv4-mapped), judged by its IPv4", first: "::ffff:0:0", last: "::ffff:ffff:ffff",
      below: "::fffe:ffff:ffff", above: "::1:0:0:0", alsoAllowed: ["::feff:7f00:1", "::fffe:7f00:1", "0:0:0:0:1:ffff:7f00:1"],
    },
    {
      range: "64:ff9b::/96 (NAT64), judged by its IPv4", first: "64:ff9b::", last: "64:ff9b::ffff:ffff",
      below: "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff", above: null,
      note: "the address above, 64:ff9b::1:0:0, is blocked (the rest of 64:ff9b::/32); 64:ff9b::808:808 is the /96 judged by a public IPv4",
      alsoAllowed: ["164:ff9b::7f00:1", "65:ff9b::7f00:1", "64:fe9b::7f00:1", "64:ff9a::7f00:1", "64:ff9b::808:808"],
    },
    {
      range: "64:ff9b::/32 outside the /96, denied outright (RFC 8215 local-use 64:ff9b:1::/48 maps private IPv4 at any length)",
      first: "64:ff9b::", last: "64:ff9b:ffff:ffff:ffff:ffff:ffff:ffff",
      below: "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff", above: "64:ff9c::",
      // Public 8.8.8.8 behind a nonzero byte 4, 5 or 11, so a branch judging them by their IPv4 lets them through.
      alsoDenied: [
        "64:ff9b::1:0:0", "64:ff9b:100::808:808", "64:ff9b:1::808:808", "64:ff9b::1:808:808", "64:ff9b:8000::808:808",
        "64:ff9b:1::10.0.0.1", "64:ff9b:1::7f00:1", "64:ff9b:1:a00:0:1::", "64:ff9b:1:c0a8:1:1::", "64:ff9b:1:7f00:1::",
      ],
      alsoAllowed: ["64:ff9a::808:808", "64:ff9c::808:808", "64:ff9a:ffff::7f00:1", "64:ff9c::7f00:1"],
    },
    {
      range: "2002::/16 (6to4), judged by the IPv4 in bytes 2-5", first: "2002::", last: "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      below: "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", above: "2003::", alsoAllowed: ["3002:7f00:1::", "2:7f00:1::", "2003:7f00:1::"],
    },
    {
      range: "fc00::/7 (unique local)", first: "fc00::", last: "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      below: "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", above: "fe00::",
    },
    {
      range: "fe80::/10 (link-local)", first: "fe80::", last: "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      below: "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", above: null,
      note: "the address above, fec0::, is blocked (fec0::/10), and so is everything after it",
    },
    {
      range: "fec0::/10 (site-local)", first: "fec0::", last: "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      below: "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", above: null,
      note: "the address below, febf:ffff:…, is blocked (fe80::/10): fe7f:ffff:… is the nearest allowed; ff00:: above is blocked (ff00::/8)",
    },
    {
      range: "ff00::/8 (multicast)", first: "ff00::", last: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      below: "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", above: null,
      note: "the address below, feff:ffff:…, is blocked (fec0::/10): fe7f:ffff:… is the nearest allowed; fbff::1 pins the prefix to /8, not f000::/4",
      alsoAllowed: ["fbff::1"],
    },
  ];

  // Ranges that are reserved or documentation-only but deliberately not blocked.
  const PASSING = [
    "https://198.51.100.1/", "https://203.0.113.1/", "https://[2001:db8::1]/", "https://[100::1]/", "https://[2001::1]/",
  ];

  const octets = (ip: string) => ip.split(".").map(Number);
  const hex16 = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
  // Each IPv6 form that embeds an IPv4, with where the code reads it and the wrong offsets a mutant could read instead.
  const FORMS = [
    { form: "IPv4-compatible ::/96", url: (ip: string) => `https://[::${ip}]/`, bytes: (ip: string) => [...Array(12).fill(0), ...octets(ip)], wrong: [10, 11, 13] },
    { form: "IPv4-mapped ::ffff:0:0/96", url: (ip: string) => `https://[::ffff:${ip}]/`, bytes: (ip: string) => [...Array(10).fill(0), 0xff, 0xff, ...octets(ip)], wrong: [10, 11, 13] },
    { form: "NAT64 64:ff9b::/96", url: (ip: string) => `https://[64:ff9b::${ip}]/`, bytes: (ip: string) => [0, 0x64, 0xff, 0x9b, ...Array(8).fill(0), ...octets(ip)], wrong: [10, 11, 13] },
    {
      form: "6to4 2002::/16",
      url: (ip: string) => { const [a, b, c, d] = octets(ip) as [number, number, number, number]; return `https://[2002:${hex16(a, b)}:${hex16(c, d)}::]/`; },
      bytes: (ip: string) => [0x20, 0x02, ...octets(ip), ...Array(10).fill(0)], wrong: [0, 1, 3, 4],
    },
  ];
  // A public IPv4 whose bytes at every wrong offset above land in a blocked range, so it catches a mutant reading there.
  const OFFSET_PROBE = "8.10.10.1";

  const expectFetchable = (urls: string[], want: boolean) => {
    for (const url of urls) expect([url, isFetchableWebUrl(url)]).toEqual([url, want]);
  };
  const v4url = (ip: string) => `https://${ip}/`;
  const v6url = (ip: string) => `https://[${ip}]/`;
  const present = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);

  test.each(V4_BLOCKED)("IPv4 $range: edges, and the private and public IPv4 in every IPv6 form", (row) => {
    expectFetchable([row.first, row.last].map(v4url), false);
    expectFetchable([...present([row.below, row.above]), ...(row.otherFirstOctet ?? [])].map(v4url), true);
    const publicNeighbour = (row.above ?? row.below)!;
    for (const { url } of FORMS) {
      expectFetchable([url(row.embedded), url(row.first), url(row.last)], false);
      expectFetchable([url(publicNeighbour), url(OFFSET_PROBE)], true);
    }
  });

  test.each(V6_BLOCKED)("IPv6 $range: edges", (row) => {
    expectFetchable([row.first, row.last, ...(row.alsoDenied ?? [])].map(v6url), false);
    expectFetchable([...present([row.below, row.above]), ...(row.alsoAllowed ?? [])].map(v6url), true);
  });

  test("the reserved and documentation ranges the denylist leaves out pass", () => {
    expectFetchable(PASSING, true);
  });

  // Checks the fixtures, not the code: an independent CIDR reading of V4_BLOCKED.
  test("the fixtures are what they claim: in-range, out-of-range, and offset-discriminating", () => {
    const toInt = (b: number[]) => (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0;
    const inCidr = (b: number[], cidr: string) => {
      const [base, len] = cidr.split("/") as [string, string];
      const mask = Number(len) === 0 ? 0 : (0xffffffff << (32 - Number(len))) >>> 0;
      return ((toInt(b) & mask) >>> 0) === ((toInt(octets(base)) & mask) >>> 0);
    };
    const blocked = (b: number[]) => V4_BLOCKED.some((r) => inCidr(b, r.range));
    for (const r of V4_BLOCKED) {
      for (const ip of [r.first, r.last, r.embedded]) expect([r.range, ip, inCidr(octets(ip), r.range)]).toEqual([r.range, ip, true]);
      for (const ip of [...present([r.below, r.above]), ...(r.otherFirstOctet ?? [])]) expect([r.range, ip, blocked(octets(ip))]).toEqual([r.range, ip, false]);
    }
    expect(blocked(octets(OFFSET_PROBE))).toBe(false);
    // A mutant reading the IPv4 at a wrong offset is caught when the public probe reads blocked there or every
    // private fixture reads public there (6to4 offsets 0 and 1 read the 2002 prefix, which the probe cannot steer).
    for (const f of FORMS) {
      for (const o of f.wrong) {
        const probeCatches = blocked(f.bytes(OFFSET_PROBE).slice(o, o + 4));
        const fixturesCatch = V4_BLOCKED.every((r) => !blocked(f.bytes(r.embedded).slice(o, o + 4)));
        expect([f.form, o, probeCatches || fixturesCatch]).toEqual([f.form, o, true]);
      }
    }
  });
});
