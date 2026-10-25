/**
 * `bun run build:extension` — the CLI wrapper.
 *
 * The emitter itself is `src/youtube/extension-build.ts`, where the co-located
 * tests import it from. One emitter, a list of outputs (`EXTENSION_OUTPUTS`):
 * a test that re-typed the `bun build` invocation would pass while the shipped
 * command drifted.
 *
 * `--out-dir` writes every output into one directory under its own file name
 * instead of over the checked-in copies, so a build can be compared byte for
 * byte with `extensions/youtube/capture-rules.js` and
 * `extensions/x-article/html-to-markdown.js`.
 *
 * The output is bun's own codegen, so it is pinned to a bun version — CI runs
 * `BUN_VERSION: "1.3.10"`. A bun bump whose codegen differs fails that test,
 * and the remedy is `bun run build:extension` plus committing the copy. It does
 * NOT depend on the working directory this is run from; see the module banner
 * note in `extension-build.ts`.
 *
 *   bun run build:extension
 *   bun scripts/build-extension.ts --out-dir /tmp/ext-build
 */

import { basename, join, resolve } from "node:path";
import { EXTENSION_OUTPUTS, buildExtensionOutput } from "../src/youtube/extension-build.ts";

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--out-dir");
const outDir = dirIndex >= 0 ? args[dirIndex + 1] : undefined;
if (dirIndex >= 0 && !outDir) {
  console.error("build:extension: --out-dir needs a path");
  process.exit(1);
}
for (const spec of EXTENSION_OUTPUTS) {
  const target = outDir ? join(resolve(outDir), basename(spec.output)) : spec.output;
  const text = await buildExtensionOutput(spec, target);
  console.log(`build:extension → ${target} (${Buffer.byteLength(text)} bytes)`);
}
