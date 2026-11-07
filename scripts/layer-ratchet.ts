/**
 * Report and shrink the import-direction allowlist (src/test/layers.ts).
 *
 *   bun scripts/layer-ratchet.ts            violations by layer pair, and the list's drift
 *   bun scripts/layer-ratchet.ts --update   drop list lines that are no longer violations (never adds one)
 *   bun scripts/layer-ratchet.ts --json     the report as JSON
 *
 * A new upward import goes onto the list by hand, in the PR that adds it, for review.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAllowlist, countByLayerPair, edgeLine, importEdges, parseAllowlist, shrinkAllowlist, sourceFiles, violations } from "../src/test/layers.ts";

const ROOT = path.join(import.meta.dir, "..");
export const ALLOWLIST_PATH = path.join(ROOT, "scripts", "layer-allowlist.txt");

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = sourceFiles(ROOT);
  const bad = violations(importEdges(ROOT, files));
  const current = bad.map(edgeLine);
  const listed = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
  const check = checkAllowlist(listed, current);
  const byPair = Object.fromEntries(countByLayerPair(bad));

  if (args.includes("--update")) {
    const kept = shrinkAllowlist(listed, current);
    const header = readFileSync(ALLOWLIST_PATH, "utf8").split("\n").filter((l) => l.startsWith("#"));
    writeFileSync(ALLOWLIST_PATH, [...header, ...kept].join("\n") + "\n");
    console.log(`removed ${listed.length - kept.length} line(s); ${kept.length} remain`);
    if (check.unlisted.length > 0) console.log(`not added (hand edit, with review):\n  ${check.unlisted.join("\n  ")}`);
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
