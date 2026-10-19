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

  // Each range: an address inside it is denied, and the addresses just outside it are allowed.
  const pin = (denied: string[], allowed: string[]) => {
    for (const url of denied) expect([url, isFetchableWebUrl(url)]).toEqual([url, false]);
    for (const url of allowed) expect([url, isFetchableWebUrl(url)]).toEqual([url, true]);
  };

  test("224.0.0.0/3 (multicast and reserved) is blocked; 223.255.255.255 is not", () => {
    pin(["https://224.0.0.1/", "https://239.255.255.250/", "https://240.0.0.1/", "https://255.255.255.255/"],
      ["https://223.255.255.255/"]);
  });

  test("192.0.0.0/24 and 192.0.2.0/24 are blocked; the rest of 192.0/16 is not", () => {
    pin(["https://192.0.0.1/", "https://192.0.0.255/", "https://192.0.2.1/", "https://192.0.2.255/"],
      ["https://192.0.1.1/", "https://192.0.3.1/", "https://192.0.32.10/", "https://192.0.255.1/"]);
  });

  test("198.18.0.0/15 is blocked; 198.17.255.255 and 198.20.0.1 are not", () => {
    pin(["https://198.18.0.1/", "https://198.19.255.255/"], ["https://198.17.255.255/", "https://198.20.0.1/"]);
  });

  test("NAT64 64:ff9b::/96 is judged by its embedded IPv4", () => {
    pin(["https://[64:ff9b::127.0.0.1]/", "https://[64:ff9b::a00:1]/", "https://[64:ff9b::c0a8:101]/"],
      ["https://[64:ff9b::8.8.8.8]/", "https://[64:ff9b::808:808]/"]);
  });

  test("6to4 2002::/16 is judged by its embedded IPv4", () => {
    pin(["https://[2002:7f00:1::]/", "https://[2002:a00:1::1]/", "https://[2002:a9fe:a9fe::]/"],
      ["https://[2002:808:808::1]/"]);
  });

  test("IPv6 multicast ff00::/8 is blocked", () => {
    pin(["https://[ff02::1]/", "https://[ff05::1:3]/", "https://[ffff::1]/"], ["https://[2606:4700::1111]/"]);
  });

  test("the documentation ranges the denylist leaves out pass, as documented", () => {
    pin([], ["https://198.51.100.1/", "https://203.0.113.1/", "https://[2001:db8::1]/", "https://[100::1]/", "https://[2001::1]/"]);
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

  beforeEach(() => {
    fake = join(root, "fake-claude");
    writeFileSync(
      fake,
      '#!/bin/sh\nmode=$(cat "$0.mode")\ncase "$mode" in fail) exit 1;; hang) exec sleep 4;; *) echo "$mode (Claude Code)";; esac\n',
      { mode: 0o755 },
    );
    const realSpawn = Bun.spawn;
    const realSync = Bun.spawnSync;
    const redirect = (cmd: string[]) => (cmd[0] === "claude" ? [fake, ...cmd.slice(1)] : cmd);
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], o: never) => realSpawn(redirect(cmd), o)) as never);
    syncSpy = spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[], o: never) => realSync(redirect(cmd), o)) as never);
    __setClaudeCliVersionForTest(undefined);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    syncSpy.mockRestore();
    delete toolSurfaceTestSeam.cliProbeTimeoutMs;
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
