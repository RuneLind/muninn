/**
 * `bun run build:extension` — the CLI wrapper.
 *
 * The emitter itself is `src/youtube/extension-build.ts`, where the co-located
 * test imports it from. One emitter, one output: a test that re-typed the
 * `bun build` invocation would pass while the shipped command drifted.
 *
 * `--out` exists for that test, which runs the emitter into a temp file and
 * compares bytes with the checked-in `extensions/youtube/capture-rules.js`.
 *
 * The output is bun's own codegen, so it is pinned to a bun version — CI runs
 * `BUN_VERSION: "1.3.10"`. A bun bump whose codegen differs fails that test,
 * and the remedy is `bun run build:extension` plus committing the copy. It does
 * NOT depend on the working directory this is run from; see the module banner
 * note in `extension-build.ts`.
 *
 *   bun run build:extension
 *   bun scripts/build-extension.ts --out /tmp/capture-rules.js
 */

import { resolve } from "node:path";
import { EXTENSION_RULES_OUTPUT, buildExtensionRules } from "../src/youtube/extension-build.ts";

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
