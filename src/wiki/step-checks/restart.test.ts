/**
 * `restart=` and the boot fingerprint behind it: the probe's truth table over
 * fake boot state, the fingerprint over an in-memory disk (inputs, the race
 * check's order, modules it must cover), and the bundle recorder through a real
 * `Bun.build` on throwaway files.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { GitRun } from "../decision-triage/git.ts";
import {
  BOT_FILES,
  bundleRecorderPlugin,
  bundleRecords,
  ENV_FILES,
  inputPaths,
  lateModules,
  RACE_MARGIN_MS,
  resetBootStateForTest,
  sha256Hex,
  takeBootFingerprint,
  takeDiskSnapshot,
  type BootFingerprint,
  type DiskSnapshot,
  type FileRead,
  type FingerprintIo,
  type FingerprintSources,
} from "./boot-fingerprint.ts";
import { probeRestart, type ProbeDeps, type RestartDeps } from "./probes.ts";

const CO = "/co";
const SRC: FingerprintSources = { checkout: CO, envDir: CO, botsDir: "/co/bots" };
const TIP = "e".repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);

// ── the probe ────────────────────────────────────────────────────────────

/** git as muninn's own checkout: origin's main tip is in HEAD unless told otherwise. */
const checkoutGit = (anc: "yes" | "no" | "fail" = "yes"): GitRun => async (_cwd, args) => {
  const a = args.join(" ");
  if (a.startsWith("config --get-regexp")) return { ok: false, stdout: "", exitCode: 1 };
  if (a === "ls-remote --symref origin HEAD") return { ok: true, stdout: `ref: refs/heads/main\tHEAD\n${TIP}\tHEAD\n`, exitCode: 0 };
  if (a.startsWith("cat-file -e")) return { ok: true, stdout: "", exitCode: 0 };
  if (a.startsWith("merge-base")) return anc === "yes" ? { ok: true, stdout: "", exitCode: 0 } : anc === "no" ? { ok: false, stdout: "", exitCode: 1 } : { ok: false, stdout: "", exitCode: 128 };
  return { ok: false, stdout: "", exitCode: 128 };
};

const snap = (fingerprint: string, hashes: [string, string | null][] = []): DiskSnapshot => ({ fingerprint, hashes: new Map(hashes) });
const proven = (s: DiskSnapshot, modules: string[] = ["/co/src/index.ts"]): BootFingerprint => ({ proven: true, snapshot: s, modules: new Set(modules) });

function restartDeps(over: Partial<RestartDeps> = {}): RestartDeps {
  const s = snap("F", [["/co/src/a.ts", "h-a"]]);
  return {
    listenPort: () => 3010,
    boot: () => Promise.resolve(proven(s)),
    disk: async () => s,
    loadedModules: () => ["bun:main", "node:fs", "/co/src/index.ts", "/co/node_modules/hono/index.js"],
    bundles: () => ({ inputs: new Map(), unaccounted: false }),
    hashNow: async () => null,
    checkout: CO,
    ...over,
  };
}

const deps = (r: RestartDeps | undefined, git: GitRun = checkoutGit()): ProbeDeps => ({
  git,
  roots: null,
  readEnvFile: async () => ({ missing: true }),
  processHasEnv: () => false,
  appliedMigrations: async () => new Set(),
  ...(r ? { restart: r } : {}),
});

describe("restart: the truth table", () => {
  test("boot = disk, no late module, bundles match, the checkout holds origin's tip: ok", async () => {
    expect(await probeRestart("3010", deps(restartDeps()))).toEqual({ state: "ok", why: `muninn runs the code and .env on disk, and muninn's checkout contains origin's main tip ${TIP.slice(0, 7)}` });
  });

  test("no reader, no port yet, another port: unknown", async () => {
    expect((await probeRestart("3010", deps(undefined))).state).toBe("unknown");
    expect(await probeRestart("3010", deps(restartDeps({ listenPort: () => null })))).toEqual({ state: "unknown", why: "this muninn's dashboard port is not known yet" });
    expect(await probeRestart("3011", deps(restartDeps()))).toEqual({ state: "unknown", why: "this muninn listens on 3010" });
  });

  test("no boot fingerprint yet, or an unproven one: unknown with its why", async () => {
    expect(await probeRestart("3010", deps(restartDeps({ boot: () => null })))).toEqual({ state: "unknown", why: "muninn has not fingerprinted what it loaded yet" });
    expect(await probeRestart("3010", deps(restartDeps({ boot: () => Promise.resolve({ proven: false, why: "raced" }) })))).toEqual({ state: "unknown", why: "raced" });
  });

  test("the disk cannot be fingerprinted: unknown", async () => {
    expect((await probeRestart("3010", deps(restartDeps({ disk: async () => ({ failed: "x" }) })))).state).toBe("unknown");
  });

  test("the disk differs from boot: not-yet, naming no file", async () => {
    const r = await probeRestart("3010", deps(restartDeps({ disk: async () => snap("G") })));
    expect(r).toEqual({ state: "not-yet", why: "the code or .env on disk changed since muninn started: restart" });
  });

  test("a bundle built from bytes the disk no longer has: not-yet, also when boot = disk", async () => {
    const inputs = new Map([["/co/src/a.ts", new Set(["h-old"])]]);
    expect((await probeRestart("3010", deps(restartDeps({ bundles: () => ({ inputs, unaccounted: false }) })))).state).toBe("not-yet");
    // A source outside the fingerprint is read now; absent now is a mismatch too.
    const outside = new Map([["/elsewhere/x.ts", new Set(["h-x"])]]);
    expect((await probeRestart("3010", deps(restartDeps({ bundles: () => ({ inputs: outside, unaccounted: false }), hashNow: async () => "h-x" })))).state).toBe("ok");
    expect((await probeRestart("3010", deps(restartDeps({ bundles: () => ({ inputs: outside, unaccounted: false }), hashNow: async () => null })))).state).toBe("not-yet");
    expect((await probeRestart("3010", deps(restartDeps({ bundles: () => ({ inputs: outside, unaccounted: false }), hashNow: async () => "failed" })))).state).toBe("unknown");
    // Two builds that read different bytes cannot both match the disk.
    const both = new Map([["/co/src/a.ts", new Set(["h-a", "h-b"])]]);
    expect((await probeRestart("3010", deps(restartDeps({ bundles: () => ({ inputs: both, unaccounted: false }) })))).state).toBe("not-yet");
  });

  test("a bundle read a file nothing fingerprints, or a module loaded after boot: unknown", async () => {
    expect((await probeRestart("3010", deps(restartDeps({ bundles: () => ({ inputs: new Map(), unaccounted: true }) })))).state).toBe("unknown");
    const late = await probeRestart("3010", deps(restartDeps({ loadedModules: () => ["/co/src/index.ts", "/co/src/late.ts"] })));
    expect(late).toEqual({ state: "unknown", why: "muninn loaded code after its boot fingerprint, so what it runs is not proven: restart" });
  });

  test("the checkout lacks origin's tip: not-yet, pull then restart; its unknown passes through", async () => {
    expect(await probeRestart("3010", deps(restartDeps(), checkoutGit("no")))).toEqual({ state: "not-yet", why: `muninn's checkout does not contain origin's main tip ${TIP.slice(0, 7)}: pull, then restart` });
    expect((await probeRestart("3010", deps(restartDeps(), checkoutGit("fail")))).state).toBe("unknown");
  });

  test("lateModules ignores builtins and every node_modules (a worktree's resolve from the main checkout)", () => {
    expect(lateModules(["bun:main", "node:fs", "/co/node_modules/x.js", "/main/node_modules/y/z.js", "/co/src/a.ts", "/co/src/b.ts", "/other/c.ts"], new Set(["/co/src/a.ts"]))).toEqual(["/co/src/b.ts", "/other/c.ts"]);
  });
});

// ── the fingerprint ──────────────────────────────────────────────────────

/** An in-memory disk. `mtimes` default to 0; `onRead` runs after each read, before the stat. */
function memIo(files: Record<string, string>, opts: { listed?: string[] | null; mtimes?: Record<string, number>; failRead?: string; onRead?: (file: string) => void } = {}): FingerprintIo {
  return {
    listCheckout: async () => (opts.listed === undefined ? Object.keys(files).filter((f) => f.startsWith("/co/") && !f.startsWith("/co/bots/") && !path.basename(f).startsWith(".env")).map((f) => f.slice(4)) : opts.listed),
    listDir: async (dir) => {
      const under = Object.keys(files).filter((f) => f.startsWith(dir + "/"));
      const kids = under.map((f) => f.slice(dir.length + 1));
      return { dirs: [...new Set(kids.filter((k) => k.includes("/")).map((k) => k.split("/")[0]!))], files: kids.filter((k) => !k.includes("/")) };
    },
    read: async (file): Promise<FileRead> => {
      if (file === opts.failRead) return { failed: true };
      const r: FileRead = file in files ? { bytes: enc(files[file]!) } : { missing: true };
      opts.onRead?.(file);
      return r;
    },
    mtimeMs: async (file) => (file in files ? (opts.mtimes?.[file] ?? 0) : null),
  };
}

const DISK = { "/co/src/index.ts": "x", "/co/src/a.ts": "a", "/co/.env": "K=1\n", "/co/bots/jarvis/CLAUDE.md": "p", "/co/bots/jarvis/prompts/share.md": "s", "/co/bots/jarvis/prompts/notes.txt": "n" };
const fp = async (files: Record<string, string>, opts = {}) => {
  const s = await takeDiskSnapshot(SRC, memIo(files, opts));
  if (!("fingerprint" in s)) throw new Error("no snapshot");
  return s.fingerprint;
};

describe("the fingerprint's inputs", () => {
  test("the checkout listing, every .env name, and per bot the boot files and prompts/*.md", async () => {
    const files = await inputPaths(SRC, memIo(DISK));
    expect(Array.isArray(files)).toBe(true);
    const list = files as string[];
    expect(list).toContain("/co/src/index.ts");
    for (const e of ENV_FILES) expect(list).toContain(`/co/${e}`);
    for (const b of BOT_FILES) expect(list).toContain(`/co/bots/jarvis/${b}`);
    expect(list).toContain("/co/bots/jarvis/prompts/share.md");
    expect(list).not.toContain("/co/bots/jarvis/prompts/notes.txt");
  });

  test("a source edit, a reverted edit, an added file, a .env byte, a bot prompt", async () => {
    const base = await fp(DISK);
    expect(await fp({ ...DISK })).toBe(base);
    expect(await fp({ ...DISK, "/co/src/a.ts": "a2" })).not.toBe(base);
    expect(await fp({ ...DISK, "/co/src/a.ts": "a" })).toBe(base);
    expect(await fp({ ...DISK, "/co/src/new.ts": "" })).not.toBe(base);
    expect(await fp({ ...DISK, "/co/.env": "K=2\n" })).not.toBe(base);
    expect(await fp({ ...DISK, "/co/.env.local": "" })).not.toBe(base);
    expect(await fp({ ...DISK, "/co/bots/jarvis/prompts/share.md": "s2" })).not.toBe(base);
    expect(await fp({ ...DISK, "/co/bots/jarvis/config.json": "{}" })).not.toBe(base);
  });

  test("a listing or read failure: failed, never a snapshot", async () => {
    expect(await takeDiskSnapshot(SRC, memIo(DISK, { listed: null }))).toEqual({ failed: "git could not list muninn's checkout" });
    expect("failed" in (await takeDiskSnapshot(SRC, memIo(DISK, { failRead: "/co/src/a.ts" })))).toBe(true);
  });
});

describe("the boot fingerprint", () => {
  const START = 1_000_000;
  const mods = () => ["bun:main", "/co/src/index.ts", "/co/src/a.ts", "/co/node_modules/hono/x.js"];

  test("quiet files, every loaded module an input: proven", async () => {
    const b = await takeBootFingerprint(SRC, memIo(DISK, { mtimes: { "/co/src/a.ts": START - RACE_MARGIN_MS } }), mods, START);
    expect(b.proven).toBe(true);
    if (b.proven) expect([...b.modules]).toEqual(["/co/src/index.ts", "/co/src/a.ts"]);
  });

  test("a file changed inside the margin before start, or after it: unproven", async () => {
    for (const m of [START - RACE_MARGIN_MS + 1, START + 5]) {
      const b = await takeBootFingerprint(SRC, memIo(DISK, { mtimes: { "/co/src/a.ts": m } }), mods, START);
      expect(b).toEqual({ proven: false, why: "a file changed while muninn was starting, so what it loaded is not proven: restart" });
    }
  });

  test("the mtime is read after the bytes: an edit landing between the two is caught", async () => {
    const mtimes: Record<string, number> = {};
    const io = memIo(DISK, { mtimes, onRead: (f) => f === "/co/src/a.ts" && (mtimes[f] = START + 1) });
    expect((await takeBootFingerprint(SRC, io, mods, START)).proven).toBe(false);
  });

  test("a loaded module the fingerprint does not cover, or covers as absent: unproven", async () => {
    const extra = () => [...mods(), "/co/src/ignored.ts"];
    expect(await takeBootFingerprint(SRC, memIo(DISK), extra, START)).toEqual({ proven: false, why: "muninn loaded a file its fingerprint does not cover" });
    const deleted = memIo(DISK, { listed: ["src/index.ts", "src/a.ts", "src/gone.ts"] });
    expect((await takeBootFingerprint(SRC, deleted, () => [...mods(), "/co/src/gone.ts"], START)).proven).toBe(false);
  });

  test("an input that cannot be read: unproven", async () => {
    expect((await takeBootFingerprint(SRC, memIo(DISK, { failRead: "/co/.env" }), mods, START)).proven).toBe(false);
  });
});

// ── the bundle recorder ──────────────────────────────────────────────────

describe("bundleRecorderPlugin, through a real Bun.build", () => {
  // The records are process-wide: other files in this process build real bundles too.
  beforeEach(() => resetBootStateForTest());
  afterEach(() => resetBootStateForTest());
  const under = (dir: string) => [...bundleRecords().inputs.keys()].filter((k) => k.startsWith(dir + path.sep));

  test("records the hash of exactly the bytes it hands the bundler; node_modules falls through; an outside file marks the bundles unaccounted", async () => {
    const base = realpathSync(testTempDirSync(path.join(tmpdir(), "step-bundle-")));
    const co = path.join(base, "co");
    mkdirSync(path.join(co, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(co, "entry.ts"), 'import { d } from "dep"; import { o } from "../outside.ts"; console.log(d, o, "own");\n');
    writeFileSync(path.join(co, "node_modules", "dep", "index.js"), "export const d = 1;\n");
    writeFileSync(path.join(base, "outside.ts"), "export const o = 2;\n");
    const r = await Bun.build({ entrypoints: [path.join(co, "entry.ts")], target: "browser", format: "iife", plugins: [bundleRecorderPlugin(co)] });
    expect(r.success).toBe(true);
    expect(await r.outputs[0]!.text()).toContain('"own"');
    const rec = bundleRecords();
    expect(under(base)).toEqual([path.join(co, "entry.ts")]);
    expect([...rec.inputs.get(path.join(co, "entry.ts"))!]).toEqual([sha256Hex(enc('import { d } from "dep"; import { o } from "../outside.ts"; console.log(d, o, "own");\n'))]);
    expect(rec.unaccounted).toBe(true);
  });

  test("only own files: nothing unaccounted", async () => {
    const co = realpathSync(testTempDirSync(path.join(tmpdir(), "step-bundle-own-")));
    writeFileSync(path.join(co, "entry.ts"), 'import { b } from "./b.ts"; console.log(b);\n');
    writeFileSync(path.join(co, "b.ts"), "export const b = 1;\n");
    expect((await Bun.build({ entrypoints: [path.join(co, "entry.ts")], target: "browser", plugins: [bundleRecorderPlugin(co)] })).success).toBe(true);
    expect(bundleRecords().unaccounted).toBe(false);
    expect(under(co).sort()).toEqual([path.join(co, "b.ts"), path.join(co, "entry.ts")]);
  });
});
