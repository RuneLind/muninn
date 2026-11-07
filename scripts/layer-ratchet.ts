/**
 * Report and shrink the import-direction allowlist (src/test/layers.ts).
 *
 *   bun scripts/layer-ratchet.ts                    violations by layer pair, and the list's drift
 *   bun scripts/layer-ratchet.ts --update           drop list lines that are no longer violations (never adds one)
 *   bun scripts/layer-ratchet.ts --json             the report as JSON
 *   bun scripts/layer-ratchet.ts --check-base <ref> fail when the list has more entries than `<ref>`'s
 *
 * `layer-direction.test.ts` fails on an upward import the list lacks and on a stale
 * entry. CI's `layer-ratchet` job runs `--check-base` on every pull request against the
 * base its merge commit was built on, so a PR that adds an upward import together with
 * its list line is still red there. The count is the ratchet: a moved file renames its
 * entries and passes. A growth is a reviewed exception: the PR body says why, and only
 * the `layer-ratchet` status is red.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baseCheckVerdict, parseAllowlist, readBaseAllowlist } from "../src/test/layer-allowlist.ts";

const ROOT = path.join(import.meta.dir, "..");
export const ALLOWLIST_PATH = path.join(ROOT, "scripts", "layer-allowlist.txt");
const ALLOWLIST_REL = "scripts/layer-allowlist.txt";

function git(args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return { exitCode: r.exitCode, stdout: r.stdout.toString() };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf("--check-base");
  if (baseAt >= 0) {
    const ref = args[baseAt + 1];
    if (!ref) throw new Error("--check-base takes a git ref");
    const verdict = baseCheckVerdict(ref, ALLOWLIST_REL, readBaseAllowlist(ref, ALLOWLIST_REL, git), readFileSync(ALLOWLIST_PATH, "utf8"));
    for (const l of verdict.lines) (verdict.code === 0 ? console.log : console.error)(l);
    process.exit(verdict.code);
  }
  // Loaded only here: it imports `typescript`, which the `--check-base` job does not install.
  const { checkAllowlist, countByLayerPair, edgeLine, importEdges, rewriteAllowlist, sourceFiles, violations } = await import("../src/test/layers.ts");
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
