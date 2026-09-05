import { test, expect, describe, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAllBots, resolveBotsDir } from "./config.ts";
import { AMBIENT_INSTANCE_ENV } from "../test/ambient-env.ts";

/**
 * `MUNINN_BOTS_DIR` — the seam that lets a TEST give a process a bot roster
 * without writing into the repo's own `bots/`.
 *
 * That directory is process-external state shared with the developer's machine:
 * a spec that creates a bot there and is hard-killed leaves it behind, and the
 * next `bun run dev` discovers it. There is no ordering to hide behind —
 * `discoverBotsInternal` iterates raw `readdirSync` order — so
 * `resolveSummarizerBot`'s no-env fallback (the FIRST discovered bot) can land
 * on a throwaway pointing at a dead port.
 */

const created: string[] = [];

function tempBotsRoot(botName: string): string {
  const root = mkdtempSync(join(tmpdir(), "muninn-bots-dir-test-"));
  created.push(root);
  const dir = join(root, botName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), `Persona for ${botName}`);
  return root;
}

afterEach(() => {
  delete process.env.MUNINN_BOTS_DIR;
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("resolveBotsDir", () => {
  test("defaults to the checkout's own bots/", () => {
    delete process.env.MUNINN_BOTS_DIR;
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
  });

  test("honours an override, resolved to an absolute path", () => {
    const root = tempBotsRoot("someBot");
    process.env.MUNINN_BOTS_DIR = root;
    expect(resolveBotsDir()).toBe(resolve(root));
  });

  test("an EMPTY value is the default, not the working directory", () => {
    // `e2eEnv()` blanks every AMBIENT_INSTANCE_ENV name with an explicit "",
    // because a delete lets the child fall back to its own `.env`. `resolve("")`
    // is the CWD, so treating a blank as an override would point discovery at
    // the repo root and find no bots at all.
    process.env.MUNINN_BOTS_DIR = "";
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
    process.env.MUNINN_BOTS_DIR = "   ";
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
  });
});

describe("resolveBotsDir REFUSES a value that would empty the roster", () => {
  /**
   * Both refusals fall back to the checkout's own `bots/`. Honouring either is a
   * silent roster of ZERO — `discoverBotsInternal` warns once and returns `[]`,
   * every bot goes offline, no Telegram poller starts and `resolveSummarizerBot`
   * has nothing to resolve — and the only visible symptom is an instance that
   * came up healthy and answers nothing.
   */
  test("a RELATIVE value is refused even when it names a REAL directory", () => {
    // `src` exists and resolves (against whatever cwd the process has — a
    // launchd service and a shell do not share one), which is exactly why it is
    // refused rather than resolved.
    process.env.MUNINN_BOTS_DIR = "src";
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
    process.env.MUNINN_BOTS_DIR = "./src";
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
  });

  test("an absolute value naming a directory that is NOT there is refused", () => {
    const root = tempBotsRoot("zzgonebot");
    rmSync(root, { recursive: true, force: true });
    process.env.MUNINN_BOTS_DIR = root;
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
  });

  test("an absolute value naming a FILE is refused, not crashed on", () => {
    // `existsSync` alone let `/etc/hosts` through, and `readdirSync` then threw
    // ENOTDIR out of discovery — a boot crash from a typo, the exact failure the
    // guard exists to prevent. The check is on directory-ness, not existence.
    const root = tempBotsRoot("zzfilebot");
    const file = join(root, "not-a-dir.txt");
    writeFileSync(file, "x");
    process.env.MUNINN_BOTS_DIR = file;
    expect(resolveBotsDir()).toBe(resolve(import.meta.dir, "../../bots"));
    expect(() => discoverAllBots()).not.toThrow();
  });

  test("so discovery still finds the checkout's own bots after a typo", () => {
    // The property the two cases above exist for, at the seam that matters:
    // a mistyped `.env` line degrades to the real roster, not to no bots at all.
    process.env.MUNINN_BOTS_DIR = join(tmpdir(), "muninn-no-such-bots-root-zz");
    expect(discoverAllBots().map((b) => b.name)).toContain("jarvis");
  });
});

describe("discovery reads the override", () => {
  test("discoverAllBots finds EXACTLY the bots under MUNINN_BOTS_DIR", () => {
    const root = tempBotsRoot("zztestonlybot");
    process.env.MUNINN_BOTS_DIR = root;

    const names = discoverAllBots().map((b) => b.name);
    expect(names).toEqual(["zztestonlybot"]);
    // The checkout's own roster is NOT merged in — the override replaces it, so
    // a spec's throwaway cannot be picked over a real bot or vice versa.
    expect(names).not.toContain("jarvis");
    expect(discoverAllBots()[0]!.dir).toBe(join(root, "zztestonlybot"));
  });

  test("the override is re-read per call, not snapshotted at module load", () => {
    // A spawned server reads it once at boot; a test that sets it per case must
    // not be answered from the first case's snapshot.
    const a = tempBotsRoot("zzfirstbot");
    const b = tempBotsRoot("zzsecondbot");
    process.env.MUNINN_BOTS_DIR = a;
    expect(discoverAllBots().map((x) => x.name)).toEqual(["zzfirstbot"]);
    process.env.MUNINN_BOTS_DIR = b;
    expect(discoverAllBots().map((x) => x.name)).toEqual(["zzsecondbot"]);
  });
});

test("MUNINN_BOTS_DIR is an instance-profile flag no suite may inherit", () => {
  // Which bots this process has is the same class of value as which wikis it may
  // write: an ambient one would give every bot-resolution suite a different
  // roster on one machine than on the other.
  expect(AMBIENT_INSTANCE_ENV).toContain("MUNINN_BOTS_DIR");
});

describe("discovery survives a bots root the process may not READ", () => {
  /**
   * The residual `resolveBotsDir` documented: directory-ness is checked with
   * `stat`, which needs only search permission on the PARENT, so a directory
   * the process cannot read passes the guard and `readdirSync` threw EACCES out
   * of discovery — a boot crash, from a `.env` line. The guard for that class
   * sits around the `readdirSync` itself, and degrades the same way the other
   * refusals do: warn, then the checkout's own `bots/`.
   */
  test("an unreadable MUNINN_BOTS_DIR warns and falls back to the checkout's bots/", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // root reads everything; the property is not observable there.
      return;
    }
    const root = tempBotsRoot("zzlockedbot");
    chmodSync(root, 0o000);
    try {
      process.env.MUNINN_BOTS_DIR = root;
      let names: string[] = [];
      expect(() => { names = discoverAllBots().map((b) => b.name); }).not.toThrow();
      expect(names).toContain("jarvis");
      expect(names).not.toContain("zzlockedbot");
    } finally {
      chmodSync(root, 0o755);
    }
  });
});
