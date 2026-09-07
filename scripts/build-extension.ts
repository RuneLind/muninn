/**
 * Emit the YouTube extension's shared rule module.
 *
 * `src/youtube/extension-options-rules.ts` is the only part of the extension
 * that has a test, and the popup has to run the SAME code — so it is bundled
 * for a browser and the result is checked in at
 * `extensions/youtube/capture-rules.js` (not `options-rules.js`: one character
 * from the existing options page's `options.js`).
 *
 * `--out` exists for the co-located test, which runs THIS script into a temp
 * file and compares bytes with the checked-in copy. One emitter, one output:
 * a test that re-typed the `bun build` invocation would pass while the shipped
 * command drifted.
 *
 * The output is bun's, so it is pinned to a bun version — CI runs
 * `BUN_VERSION: "1.3.10"`. A bun bump whose codegen differs fails that test,
 * and the remedy is `bun run build:extension` plus committing the copy.
 *
 *   bun run build:extension
 *   bun scripts/build-extension.ts --out /tmp/capture-rules.js
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const EXTENSION_RULES_ENTRY = join(REPO_ROOT, "src/youtube/extension-options-rules.ts");
export const EXTENSION_RULES_OUTPUT = join(REPO_ROOT, "extensions/youtube/capture-rules.js");

/** Bundle the rules module for the popup. Returns the bytes it wrote. */
export async function buildExtensionRules(outfile: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [EXTENSION_RULES_ENTRY],
    target: "browser",
    format: "esm",
    outdir: dirname(outfile),
    naming: { entry: outfile.slice(dirname(outfile).length + 1) },
  });
  if (!result.success) {
    throw new Error(`build:extension failed:\n${result.logs.map(String).join("\n")}`);
  }
  return await Bun.file(outfile).text();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outfile = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outfile) {
    console.error("build:extension: --out needs a path");
    process.exit(1);
  }
  const target = outfile ? resolve(outfile) : EXTENSION_RULES_OUTPUT;
  const text = await buildExtensionRules(target);
  console.log(`build:extension → ${target} (${Buffer.byteLength(text)} bytes)`);
}
