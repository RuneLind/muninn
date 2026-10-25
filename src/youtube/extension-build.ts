/**
 * The emitter behind `bun run build:extension`.
 *
 * `extension-options-rules.ts` is the only part of the Chrome extension that
 * has a test, and the popup has to run the SAME code — so it is bundled for a
 * browser and the result is checked in at
 * `extensions/youtube/capture-rules.js` (not `options-rules.js`: one character
 * from the existing options page's `options.js`). The co-located test re-runs
 * THIS function and compares bytes with the checked-in copy, so a stale copy
 * fails CI rather than shipping a popup running last month's rules.
 *
 * It lives under `src/` rather than in `scripts/` because the test imports it,
 * and `src/ → scripts/` would be the first such import in the repo.
 * `scripts/build-extension.ts` is the `import.meta.main` wrapper.
 *
 * ⚠️ **The output must not depend on the process's working directory.** The
 * byte gate compares a build the test ran from wherever `bun test` was invoked
 * against a copy committed by a build run from the repo root, so a cwd-dependent
 * byte would fail the gate with a remedy ("a bun bump changed the codegen")
 * that names the wrong cause. Bun emits one `// <path>` banner per bundled
 * module and writes it relative to `process.cwd()` — measured: the repo root
 * gives `// src/youtube/extension-options-rules.ts`, `src/` gives
 * `// youtube/…` and `/tmp` gives `// ../../Users/…/src/youtube/…`. `Bun.build`'s
 * `root` option does NOT fix that (measured too — it moves the output layout,
 * not the banner), so the banner is normalized here, after the build.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

export const EXTENSION_RULES_ENTRY = join(REPO_ROOT, "src/youtube/extension-options-rules.ts");
export const EXTENSION_RULES_OUTPUT = join(REPO_ROOT, "extensions/youtube/capture-rules.js");

/**
 * One emitted extension file: its entry, where the copy is checked in, and its
 * format. Each output has its own byte gate in a co-located test.
 *
 * - `capture-rules.js` stays ESM: the YouTube popup and service worker import it.
 * - `html-to-markdown.js` is an IIFE: the X extension's content script is a
 *   classic script and cannot import a module, so the wrapper entry assigns
 *   `globalThis.muninnHtmlToMarkdown` and the manifest lists the file before
 *   `content.js`.
 */
export interface ExtensionOutput {
  readonly name: string;
  readonly entry: string;
  readonly output: string;
  readonly format: "esm" | "iife";
}

export const EXTENSION_OUTPUTS: readonly ExtensionOutput[] = [
  { name: "youtube capture rules", entry: EXTENSION_RULES_ENTRY, output: EXTENSION_RULES_OUTPUT, format: "esm" },
  {
    name: "x-article html-to-markdown",
    entry: join(REPO_ROOT, "src/summaries/html-to-markdown.extension.ts"),
    output: join(REPO_ROOT, "extensions/x-article/html-to-markdown.js"),
    format: "iife",
  },
];

/**
 * Bun's per-module banner, rewritten from cwd-relative to repo-root-relative.
 *
 * The bundler strips every other comment, so the only `// …` lines in the
 * output are these banners — one per bundled module, indented inside an IIFE
 * (two modules in the X output). Each is resolved against the CURRENT cwd,
 * which is what bun wrote it relative to, and re-expressed against the repo
 * root with forward slashes.
 */
function normalizeModuleBanners(text: string): string {
  return text.replace(/^([ \t]*)\/\/ (\S.*\.tsx?)$/gm, (_line, indent: string, emitted: string) => {
    const abs = isAbsolute(emitted) ? emitted : resolve(process.cwd(), emitted);
    return `${indent}// ${relative(REPO_ROOT, abs).split(sep).join("/")}`;
  });
}

/**
 * Bundle one output for the browser and write it to `outfile`. Returns the
 * bytes it wrote.
 *
 * The bundle is taken in memory and written here rather than through `outdir` +
 * `naming`: the output path is then just a path — a relative `--out`, a
 * root-level one and a temp file all work, where deriving the file name by
 * slicing off `dirname(outfile)` broke on the first two — and the normalization
 * above has somewhere to run.
 */
export async function buildExtensionOutput(spec: ExtensionOutput, outfile: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [spec.entry],
    target: "browser",
    format: spec.format,
  });
  if (!result.success) {
    throw new Error(`build:extension (${spec.name}) failed:\n${result.logs.map(String).join("\n")}`);
  }
  const text = normalizeModuleBanners(await result.outputs[0]!.text());
  await Bun.write(resolve(outfile), text);
  return text;
}

/** The YouTube popup's rules, the first output — what the original byte gate re-runs. */
export async function buildExtensionRules(outfile: string): Promise<string> {
  return buildExtensionOutput(EXTENSION_OUTPUTS[0]!, outfile);
}
