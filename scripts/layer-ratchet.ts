/**
 * Report and shrink the import-direction allowlist (src/test/layers.ts).
 *
 *   bun scripts/layer-ratchet.ts                    violations by layer pair, and the list's drift
 *   bun scripts/layer-ratchet.ts --update           drop list lines that are no longer violations (never adds one)
 *   bun scripts/layer-ratchet.ts --json             the report as JSON
 *   bun scripts/layer-ratchet.ts --check-base <ref> fail when the list has an entry `<ref>`'s list lacks
 *
 * `layer-direction.test.ts` fails on an upward import the list lacks and on a stale
 * entry; CI runs `--check-base` on every pull request against its base, so a PR
 * that adds an upward import together with its list line is still red. Such a line
 * is a reviewed exception: the PR body says why, and it lands only past that red step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addedAllowlistLines, checkAllowlist, countByLayerPair, edgeLine, importEdges, parseAllowlist, rewriteAllowlist, sourceFiles, violations } from "../src/test/layers.ts";

const ROOT = path.join(import.meta.dir, "..");
export const ALLOWLIST_PATH = path.join(ROOT, "scripts", "layer-allowlist.txt");
const ALLOWLIST_REL = "scripts/layer-allowlist.txt";

function git(...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd: ROOT });
}

/** Exit code: 0 when the head adds no entry, 1 when it does, 2 on a bad ref. */
function checkBase(ref: string): number {
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).exitCode !== 0) {
    console.error(`--check-base: ${ref} is not a commit`);
    return 2;
  }
  const base = git("show", `${ref}:${ALLOWLIST_REL}`);
  if (base.exitCode !== 0) {
    // Only the PR that introduces the list meets this.
    console.log(`--check-base: ${ref} has no ${ALLOWLIST_REL}; nothing to compare`);
    return 0;
  }
  const added = addedAllowlistLines(base.stdout.toString(), readFileSync(ALLOWLIST_PATH, "utf8"));
  if (added.length === 0) {
    console.log(`--check-base: ${ALLOWLIST_REL} adds no entry over ${ref}`);
    return 0;
  }
  console.error(
    `::error::${ALLOWLIST_REL} adds ${added.length} upward import(s) over ${ref}. The list only shrinks: remove the import, or merge it as a reviewed exception whose reason the PR body states.`,
  );
  for (const l of added) console.error(`  added: ${l}`);
  return 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf("--check-base");
  if (baseAt >= 0) {
    const ref = args[baseAt + 1];
    if (!ref) throw new Error("--check-base takes a git ref");
    process.exit(checkBase(ref));
  }
  const files = sourceFiles(ROOT);
  const bad = violations(importEdges(ROOT, files));
  const current = bad.map(edgeLine);
  const listed = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
  const check = checkAllowlist(listed, current);
  const byPair = Object.fromEntries(countByLayerPair(bad));

  if (args.includes("--update")) {
    const next = rewriteAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"), current);
    const kept = parseAllowlist(next).length;
    writeFileSync(ALLOWLIST_PATH, next);
    console.log(`removed ${listed.length - kept} line(s); ${kept} remain`);
    if (check.unlisted.length > 0) console.log(`not added (hand edit, a reviewed exception):\n  ${check.unlisted.join("\n  ")}`);
  } else if (args.includes("--json")) {
    console.log(JSON.stringify({ files: files.length, violations: current.length, byPair, ...check }, null, 2));
  } else {
    console.log(`${files.length} files, ${current.length} upward imports (list: ${listed.length})`);
    for (const [pair, n] of Object.entries(byPair)) console.log(`  ${String(n).padStart(4)}  ${pair}`);
    for (const l of check.unlisted) console.log(`not on the list: ${l}`);
    for (const l of check.stale) console.log(`fixed, run --update: ${l}`);
    for (const l of check.format) console.log(l);
  }
}
