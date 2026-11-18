/**
 * The read-and-search snapshots against real git repositories built in a temp
 * dir: what a code snapshot and a wiki snapshot hold, how each is keyed, and
 * what the sweep removes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { testTempDirSync } from "../test/temp-dir.ts";
import { codeSnapshot, leaseSnapshot, sweepSnapshots, wikiSnapshot, wikiSnapshotFiles, SNAPSHOT_IDLE_MS } from "./snapshots.ts";

let base: string;
let root: string;

// What this filesystem does with names, probed once: the cases below need a
// case-insensitive one that keeps a decomposed (NFD) name as written (APFS).
const probe = testTempDirSync(join(tmpdir(), "snapshots-probe-"));
writeFileSync(join(probe, "CaseProbe"), "");
const caseInsensitive = existsSync(join(probe, "caseprobe"));
const COMPOSED = "\u00e9t\u00e9";
const DECOMPOSED = COMPOSED.normalize("NFD");
mkdirSync(join(probe, DECOMPOSED));
const keepsDecomposed = readdirSync(probe).includes(DECOMPOSED);
rmSync(probe, { recursive: true, force: true });
const runsAsRoot = process.getuid?.() === 0;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

beforeAll(() => {
  base = testTempDirSync(join(tmpdir(), "snapshots-"));
  root = join(base, "snapshots");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("codeSnapshot", () => {
  let origin: string;
  let work: string;

  beforeAll(() => {
    origin = join(base, "origin.git");
    work = join(base, "repo");
    mkdirSync(work);
    git(base, "init", "--bare", origin);
    git(work, "init");
    git(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, ".gitignore"), ".env\nlocal-notes.md\n");
    writeFileSync(join(work, "app.ts"), "export const answer = 42;\n");
    mkdirSync(join(work, "docs"));
    writeFileSync(join(work, "docs", "guide.md"), "# guide\n");
    symlinkSync("docs/guide.md", join(work, "inside-link"));
    symlinkSync("/etc/hosts", join(work, "absolute-link"));
    symlinkSync("../../outside.txt", join(work, "docs", "climbing-link"));
    git(work, "add", "-A");
    git(work, "commit", "-m", "one");
    git(work, "push", "origin", "main");
    git(work, "remote", "set-head", "origin", "main");
    // The working tree also holds what must never reach a snapshot.
    writeFileSync(join(work, ".env"), "SECRET=env-secret-1a2b\n");
    writeFileSync(join(work, "local-notes.md"), "ignored-secret-3c4d\n");
    writeFileSync(join(work, "untracked.ts"), "untracked-5e6f\n");
    writeFileSync(join(work, "app.ts"), "export const answer = 'uncommitted';\n");
  });

  test("holds the tracked files of origin/<default branch>: no .env, no ignored or untracked file, no .git", async () => {
    const snap = await codeSnapshot(work, { root });
    expect(snap.branch).toBe("main");
    expect(snap.commit).toBe(git(work, "rev-parse", "origin/main"));
    expect(files(snap.dir)).toEqual([".gitignore", "app.ts", "docs/guide.md", "inside-link"]);
    expect(existsSync(join(snap.dir, ".env"))).toBe(false);
    expect(existsSync(join(snap.dir, "local-notes.md"))).toBe(false);
    expect(existsSync(join(snap.dir, ".git"))).toBe(false);
    // The commit's text, not the working tree's.
    expect(readFileSync(join(snap.dir, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
  });

  test("keeps a link that stays inside and drops the absolute and the climbing ones", async () => {
    const snap = await codeSnapshot(work, { root });
    expect(lstatSync(join(snap.dir, "inside-link")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(snap.dir, "inside-link"), "utf8")).toBe("# guide\n");
    expect(existsSync(join(snap.dir, "absolute-link"))).toBe(false);
    expect(() => lstatSync(join(snap.dir, "docs", "climbing-link"))).toThrow();
  });

  test("is reused while the commit stands and rebuilt beside the old one when it moves", async () => {
    const first = await codeSnapshot(work, { root });
    expect((await codeSnapshot(work, { root })).dir).toBe(first.dir);
    git(work, "add", "app.ts");
    git(work, "commit", "-m", "two");
    expect((await codeSnapshot(work, { root })).dir).toBe(first.dir); // not pushed: origin/main has not moved
    git(work, "push", "origin", "main");
    const second = await codeSnapshot(work, { root });
    expect(second.dir).not.toBe(first.dir);
    expect(readFileSync(join(second.dir, "app.ts"), "utf8")).toBe("export const answer = 'uncommitted';\n");
    expect(readFileSync(join(first.dir, "app.ts"), "utf8")).toBe("export const answer = 42;\n");
  });

  test("a repo with no origin default branch is refused", async () => {
    const lone = join(base, "lone");
    mkdirSync(lone);
    git(lone, "init");
    await expect(codeSnapshot(lone, { root })).rejects.toThrow(/no origin default branch/);
  });
});

describe("wikiSnapshot", () => {
  let wiki: string;

  beforeAll(() => {
    wiki = join(base, "wiki");
    mkdirSync(join(wiki, "concepts"), { recursive: true });
    git(wiki, "init");
    writeFileSync(join(wiki, ".gitignore"), "node_modules/\n.claude/settings.local.json\n");
    writeFileSync(join(wiki, "index.md"), "# index\n");
    writeFileSync(join(wiki, "concepts", "a.md"), "committed text\n");
    writeFileSync(join(wiki, "gone.md"), "deleted in the tree\n");
    git(wiki, "add", "-A");
    git(wiki, "commit", "-m", "one");
    // Uncommitted state the snapshot must carry, and what it must not.
    writeFileSync(join(wiki, "concepts", "a.md"), "uncommitted edit\n");
    writeFileSync(join(wiki, "concepts", "new-page.md"), "untracked page\n");
    rmSync(join(wiki, "gone.md"));
    mkdirSync(join(wiki, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(wiki, "node_modules", "pkg", "index.js"), "ignored\n");
    mkdirSync(join(wiki, ".claude"));
    writeFileSync(join(wiki, ".claude", "settings.local.json"), "{}\n");
    writeFileSync(join(wiki, ".wiki-write.lock"), "{}\n");
    writeFileSync(join(wiki, ".wiki-stamp.123.tmp"), "x\n");
    symlinkSync("/etc/hosts", join(wiki, "link.md"));
  });

  test("holds the uncommitted edit and the untracked page; no ignored file, no write artifact, no link, no .git", async () => {
    const snap = await wikiSnapshot(wiki, { root });
    expect(files(snap.dir)).toEqual([".gitignore", "concepts/a.md", "concepts/new-page.md", "index.md"]);
    expect(readFileSync(join(snap.dir, "concepts", "a.md"), "utf8")).toBe("uncommitted edit\n");
    expect(readFileSync(join(snap.dir, "concepts", "new-page.md"), "utf8")).toBe("untracked page\n");
    expect(existsSync(join(snap.dir, ".git"))).toBe(false);
  });

  test("is keyed by content: an unchanged tree reuses the copy, a changed one gets a new copy and the old one is untouched", async () => {
    const first = await wikiSnapshot(wiki, { root });
    expect((await wikiSnapshot(wiki, { root })).dir).toBe(first.dir);
    writeFileSync(join(wiki, "concepts", "a.md"), "second edit\n");
    const second = await wikiSnapshot(wiki, { root });
    expect(second.dir).not.toBe(first.dir);
    expect(readFileSync(join(second.dir, "concepts", "a.md"), "utf8")).toBe("second edit\n");
    expect(readFileSync(join(first.dir, "concepts", "a.md"), "utf8")).toBe("uncommitted edit\n");
  });
});

describe("wikiSnapshot: what it refuses to read", () => {
  function newWiki(name: string): string {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init");
    return dir;
  }

  test("a tracked file under a folder replaced by a symlink to an outside directory is not copied", async () => {
    const outside = join(base, "outside-secrets");
    mkdirSync(outside);
    writeFileSync(join(outside, "x"), "outside-secret-7g8h\n");
    const wiki = newWiki("wiki-linked-folder");
    writeFileSync(join(wiki, "index.md"), "# index\n");
    mkdirSync(join(wiki, "keys"));
    writeFileSync(join(wiki, "keys", "x"), "tracked text\n");
    git(wiki, "add", "-A");
    git(wiki, "commit", "-m", "one");
    rmSync(join(wiki, "keys"), { recursive: true });
    symlinkSync(outside, join(wiki, "keys"));
    // git still lists the tracked path from its index.
    expect(await wikiSnapshotFiles(wiki)).toContain("keys/x");
    const snap = await wikiSnapshot(wiki, { root });
    expect(files(snap.dir)).toEqual(["index.md"]);
    for (const f of files(snap.dir)) expect(readFileSync(join(snap.dir, f), "utf8")).not.toContain("outside-secret-7g8h");
  });

  test("a tracked file under a link in a grandparent folder is not copied", async () => {
    const outside = join(base, "outside-grand");
    mkdirSync(join(outside, "b"), { recursive: true });
    writeFileSync(join(outside, "b", "x"), "outside-secret-9k1m\n");
    const wiki = newWiki("wiki-linked-grandparent");
    writeFileSync(join(wiki, "index.md"), "# index\n");
    mkdirSync(join(wiki, "a", "b"), { recursive: true });
    writeFileSync(join(wiki, "a", "b", "x"), "tracked text\n");
    git(wiki, "add", "-A");
    git(wiki, "commit", "-m", "one");
    rmSync(join(wiki, "a"), { recursive: true });
    symlinkSync(outside, join(wiki, "a"));
    expect(await wikiSnapshotFiles(wiki)).toContain("a/b/x");
    const snap = await wikiSnapshot(wiki, { root });
    expect(files(snap.dir)).toEqual(["index.md"]);
  });

  test.skipIf(!caseInsensitive)(
    `a tracked Docs/x.md whose folder was renamed to docs is copied${caseInsensitive ? "" : " (skipped: case-sensitive filesystem)"}`,
    async () => {
      const wiki = newWiki("wiki-renamed-case");
      mkdirSync(join(wiki, "Docs"));
      writeFileSync(join(wiki, "Docs", "x.md"), "case text\n");
      git(wiki, "add", "-A");
      git(wiki, "commit", "-m", "one");
      renameSync(join(wiki, "Docs"), join(wiki, "tmp-name"));
      renameSync(join(wiki, "tmp-name"), join(wiki, "docs"));
      expect(readdirSync(wiki)).toContain("docs");
      expect(await wikiSnapshotFiles(wiki)).toEqual(["Docs/x.md"]);
      const snap = await wikiSnapshot(wiki, { root });
      expect(files(snap.dir)).toEqual(["Docs/x.md"]);
      expect(readFileSync(join(snap.dir, "Docs", "x.md"), "utf8")).toBe("case text\n");
    },
  );

  test.skipIf(!keepsDecomposed)(
    `a folder stored decomposed (NFD) that git lists composed is copied${keepsDecomposed ? "" : " (skipped: the filesystem normalises names)"}`,
    async () => {
      const wiki = newWiki("wiki-nfd-folder");
      mkdirSync(join(wiki, DECOMPOSED));
      writeFileSync(join(wiki, DECOMPOSED, "x.md"), "accent text\n");
      expect(readdirSync(wiki)).toContain(DECOMPOSED);
      git(wiki, "add", "-A");
      git(wiki, "commit", "-m", "one");
      const listed = await wikiSnapshotFiles(wiki);
      expect(listed).toHaveLength(1);
      const snap = await wikiSnapshot(wiki, { root });
      expect(files(snap.dir).map((f) => f.normalize("NFC"))).toEqual([`${COMPOSED}/x.md`]);
      expect(readFileSync(join(snap.dir, listed[0]!), "utf8")).toBe("accent text\n");
    },
  );

  test.skipIf(runsAsRoot)(
    `a readable file inside an execute-only folder (0311) is copied, never silently absent${runsAsRoot ? " (skipped: root ignores modes)" : ""}`,
    async () => {
      const wiki = newWiki("wiki-exec-only");
      writeFileSync(join(wiki, "index.md"), "# index\n");
      mkdirSync(join(wiki, "d"));
      writeFileSync(join(wiki, "d", "g.md"), "exec-only text\n");
      git(wiki, "add", "-A");
      git(wiki, "commit", "-m", "one");
      chmodSync(join(wiki, "d"), 0o311);
      try {
        const snap = await wikiSnapshot(wiki, { root });
        expect(files(snap.dir)).toEqual(["d/g.md", "index.md"]);
        expect(readFileSync(join(snap.dir, "d", "g.md"), "utf8")).toBe("exec-only text\n");
      } finally {
        chmodSync(join(wiki, "d"), 0o755);
      }
    },
  );

  test.skipIf(runsAsRoot)(
    `a tracked file in a folder that cannot be searched (0600) fails the snapshot loudly${runsAsRoot ? " (skipped: root ignores modes)" : ""}`,
    async () => {
      const wiki = newWiki("wiki-no-search");
      writeFileSync(join(wiki, "index.md"), "# index\n");
      mkdirSync(join(wiki, "d"));
      writeFileSync(join(wiki, "d", "g.md"), "hidden text\n");
      git(wiki, "add", "-A");
      git(wiki, "commit", "-m", "one");
      chmodSync(join(wiki, "d"), 0o600);
      try {
        await expect(wikiSnapshot(wiki, { root })).rejects.toThrow(/EACCES|permission denied/i);
      } finally {
        chmodSync(join(wiki, "d"), 0o755);
      }
    },
  );

  test("the byte limit refuses on the sizes alone, before any file is read", async () => {
    const wiki = newWiki("wiki-over-limit");
    writeFileSync(join(wiki, "a.md"), "x".repeat(2000));
    // Sorted after a.md, so a run that reads before checking reaches it and fails on EACCES.
    writeFileSync(join(wiki, "z.md"), "unreadable\n");
    chmodSync(join(wiki, "z.md"), 0o000);
    try {
      await expect(wikiSnapshot(wiki, { root, maxBytes: 100 })).rejects.toThrow(/bytes, over 100\./);
    } finally {
      chmodSync(join(wiki, "z.md"), 0o644);
    }
  });

  test("a rule only in the global excludes file under a custom XDG_CONFIG_HOME keeps the file out of the listing", async () => {
    const xdg = join(base, "xdg-config");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "ignore"), "xdg-only-notes.md\n");
    const wiki = newWiki("wiki-xdg-ignore");
    writeFileSync(join(wiki, "index.md"), "# index\n");
    writeFileSync(join(wiki, "xdg-only-notes.md"), "private notes\n");
    const saved = { xdg: process.env.XDG_CONFIG_HOME, global: process.env.GIT_CONFIG_GLOBAL };
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.GIT_CONFIG_GLOBAL;
    try {
      expect(await wikiSnapshotFiles(wiki)).toEqual(["index.md"]);
    } finally {
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.xdg;
      if (saved.global !== undefined) process.env.GIT_CONFIG_GLOBAL = saved.global;
    }
  });

  test("a rule only in the excludes file a GIT_CONFIG_GLOBAL config names keeps the file out of the listing", async () => {
    const cfgDir = join(base, "global-config");
    mkdirSync(cfgDir);
    writeFileSync(join(cfgDir, "excludes"), ".env.local\n");
    writeFileSync(join(cfgDir, "gitconfig"), `[core]\n\texcludesFile = ${join(cfgDir, "excludes")}\n`);
    const wiki = newWiki("wiki-global-config-ignore");
    writeFileSync(join(wiki, "index.md"), "# index\n");
    writeFileSync(join(wiki, ".env.local"), "SECRET=1\n");
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = join(cfgDir, "gitconfig");
    try {
      expect(await wikiSnapshotFiles(wiki)).toEqual(["index.md"]);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });
});

describe("sweepSnapshots", () => {
  test("removes a snapshot idle for an hour and a stale half-build; keeps a fresh one, a leased one and foreign names", () => {
    const sweepRoot = join(base, "sweep");
    mkdirSync(sweepRoot);
    const now = Date.now();
    const age = (name: string, ms: number) => {
      const p = join(sweepRoot, name);
      mkdirSync(p);
      const t = new Date(now - ms);
      utimesSync(p, t, t);
      return p;
    };
    age("code-old-1", SNAPSHOT_IDLE_MS + 1000);
    age("wiki-fresh-1", 60_000);
    const held = age("wiki-held-1", SNAPSHOT_IDLE_MS + 1000);
    age(".tmp-crashed", 60 * 60_000);
    age(".tmp-building", 1000);
    age("someone-elses", SNAPSHOT_IDLE_MS * 10);
    const release = leaseSnapshot({ dir: held });
    // The lease marked it used now; age it again to prove the lease, not the clock, keeps it.
    utimesSync(held, new Date(now - SNAPSHOT_IDLE_MS * 2), new Date(now - SNAPSHOT_IDLE_MS * 2));
    expect(sweepSnapshots({ root: sweepRoot, now }).sort()).toEqual([".tmp-crashed", "code-old-1"]);
    expect(readdirSync(sweepRoot).sort()).toEqual([".tmp-building", "someone-elses", "wiki-fresh-1", "wiki-held-1"]);
    release();
    // Released, it was marked used again: the idle hour starts now.
    expect(sweepSnapshots({ root: sweepRoot, now: Date.now() })).toEqual([]);
    expect(sweepSnapshots({ root: sweepRoot, now: Date.now() + SNAPSHOT_IDLE_MS + 1000 })).toContain("wiki-held-1");
  });
});
