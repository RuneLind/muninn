#!/usr/bin/env bun
// Sync gitignored bot folders to/from per-bot config repos.
// Manifest:  bots.config.json (at repo root)
// Usage:     bun run config:sync    [--commit] [--pull]
//            bun run config:restore
//
// Each entry in bots.config.json describes where a bot's source-of-truth lives:
//   { "repo": "<local path | git URL>", "subpath": "<dir-in-repo>", "branch": "<main>" }
// or { "inline": true } for bots checked into muninn directly (jarvis).
//
// Local-path repos (e.g. ~/source/private/muninn-config) are used as-is.
// Git URLs are cloned (sparse, by subpath) into ~/.muninn/bot-repos/<name>/.
//
// Default direction: push (local bots/<name>/ → repo subpath).
//   --pull     fetch latest from git remotes first (push direction unchanged)
//   --commit   stage, commit and push (if remote exists) in every touched repo
//   --restore  reverse direction: repo subpath → local bots/<name>/ (implies git pull)

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const MUNINN_DIR = resolve(import.meta.dir, "..");
const BOT_CACHE = join(homedir(), ".muninn", "bot-repos");

const args = new Set(process.argv.slice(2));
const COMMIT = args.has("--commit");
const RESTORE = args.has("--restore");
const PULL = args.has("--pull") || RESTORE; // restore always wants the latest source

interface BotEntry {
  repo?: string;
  subpath?: string;
  branch?: string;
  inline?: boolean;
}

interface Manifest {
  schemaVersion: 1;
  bots: Record<string, BotEntry>;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function isGitUrl(repo: string): boolean {
  return /^(git@|https?:\/\/|ssh:\/\/)/.test(repo);
}

function loadManifest(): Manifest {
  const path = join(MUNINN_DIR, "bots.config.json");
  if (!existsSync(path)) {
    console.error(`Manifest not found: ${path}`);
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(path, "utf-8")) as Manifest;
  if (m.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schemaVersion: ${m.schemaVersion}`);
  }
  return m;
}

async function ensureSourceOfTruth(
  name: string,
  e: BotEntry,
): Promise<{ path: string; repoRoot: string } | null> {
  if (!e.repo) {
    console.warn(`  ⚠ ${name}: missing "repo" field — skipping`);
    return null;
  }
  const subpath = e.subpath ?? `bots/${name}`;

  if (!isGitUrl(e.repo)) {
    const repoRoot = expandHome(e.repo);
    if (!existsSync(repoRoot)) {
      console.warn(`  ⚠ ${name}: ${repoRoot} not found — skipping (you may not own this bot)`);
      return null;
    }
    const path = join(repoRoot, subpath);
    mkdirSync(path, { recursive: true });
    return { path, repoRoot };
  }

  // Git URL — clone (sparse) or pull
  mkdirSync(BOT_CACHE, { recursive: true });
  const repoName = basename(e.repo).replace(/\.git$/, "");
  const repoRoot = join(BOT_CACHE, repoName);
  const branch = e.branch ?? "main";

  if (!existsSync(join(repoRoot, ".git"))) {
    console.log(`  → cloning ${e.repo}`);
    try {
      await Bun.$`git clone --branch ${branch} ${e.repo} ${repoRoot}`.quiet();
      await Bun.$`git -C ${repoRoot} sparse-checkout init --cone`.quiet();
      await Bun.$`git -C ${repoRoot} sparse-checkout set ${subpath}`.quiet();
    } catch (err) {
      console.warn(`  ⚠ ${name}: clone failed (${err instanceof Error ? err.message : err}) — skipping`);
      return null;
    }
  } else if (PULL) {
    console.log(`  ↓ pulling ${repoName}`);
    await Bun.$`git -C ${repoRoot} pull --ff-only`.quiet();
  }

  const path = join(repoRoot, subpath);
  mkdirSync(path, { recursive: true });
  return { path, repoRoot };
}

async function syncBot(name: string, e: BotEntry): Promise<string | null> {
  if (e.inline) {
    console.log(`  · ${name} (inline)`);
    return null;
  }
  const sot = await ensureSourceOfTruth(name, e);
  if (!sot) return null;
  const localDir = join(MUNINN_DIR, "bots", name);
  const RSYNC_FLAGS = ["-a", "--delete", "--exclude=reports/", "--exclude=.DS_Store"];

  if (RESTORE) {
    // repo subpath → local
    if (!existsSync(join(sot.path, "CLAUDE.md"))) {
      console.warn(`  ⚠ ${name}: ${sot.path}/CLAUDE.md not present — source-of-truth not populated, skipping`);
      return null;
    }
    mkdirSync(localDir, { recursive: true });
    await Bun.$`rsync ${RSYNC_FLAGS} ${sot.path}/ ${localDir}/`.quiet();
    console.log(`  ↻ ${sot.path} → bots/${name}/`);
    return null; // restore doesn't dirty the repo
  }

  // push: local → repo subpath
  if (!existsSync(localDir)) {
    console.warn(`  ⚠ ${name}: bots/${name}/ not present locally — skipping (run with --restore to populate)`);
    return null;
  }
  if (!existsSync(join(localDir, "CLAUDE.md"))) {
    console.warn(`  ⚠ ${name}: bots/${name}/CLAUDE.md not present — refusing to push (run --restore first)`);
    return null;
  }
  await Bun.$`rsync ${RSYNC_FLAGS} ${localDir}/ ${sot.path}/`.quiet();
  console.log(`  ✓ bots/${name}/ → ${sot.path}`);
  return sot.repoRoot;
}

async function commitRepo(repoRoot: string): Promise<void> {
  const status = (await Bun.$`git -C ${repoRoot} status --porcelain`.quiet().text()).trim();
  if (!status) return;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const message = `Config sync ${stamp}`;
  await Bun.$`git -C ${repoRoot} add -A`.quiet();
  await Bun.$`git -C ${repoRoot} commit -m ${message}`.quiet();
  const remotes = (await Bun.$`git -C ${repoRoot} remote`.quiet().text()).trim();
  if (remotes) {
    await Bun.$`git -C ${repoRoot} push`.quiet();
    console.log(`  ↑ ${repoRoot}`);
  } else {
    console.log(`  ✓ committed ${repoRoot} (no remote)`);
  }
}

async function main() {
  console.log(RESTORE ? `Restoring into ${MUNINN_DIR}` : `Syncing from ${MUNINN_DIR}`);
  const manifest = loadManifest();

  const touched = new Set<string>();
  for (const [name, entry] of Object.entries(manifest.bots)) {
    const repoRoot = await syncBot(name, entry);
    if (repoRoot) touched.add(repoRoot);
  }

  if (RESTORE) return; // nothing to commit on restore

  if (COMMIT) {
    console.log("\nCommitting…");
    for (const r of touched) await commitRepo(r);
  } else if (touched.size > 0) {
    console.log("\nDirty repos (run with --commit to auto-commit + push):");
    for (const r of touched) {
      const status = (await Bun.$`git -C ${r} status --porcelain`.quiet().text()).trim();
      if (status) {
        console.log(`  ${r}:`);
        console.log(status.split("\n").map((l) => `    ${l}`).join("\n"));
      }
    }
  }
}

await main();
