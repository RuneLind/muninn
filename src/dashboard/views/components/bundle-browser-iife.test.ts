/**
 * `makeBundledClientScript` (architecture review 2026-11-16, F23): concurrent
 * callers share one build, a failed build names its entry and is not kept, and
 * the next request builds again. Plus the pin that keeps the reader's client
 * files in the server's module graph, which is what `bun --watch` watches.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTempDirSync } from "../../../test/temp-dir.ts";
import { makeBundledClientScript } from "./bundle-browser-iife.ts";

const dir = testTempDirSync("bundle-iife-");

test("a failed build names the entry and is retried on the next request; a good one is shared and kept", async () => {
  writeFileSync(join(dir, "entry.ts"), "export const x = ;\n");
  const get = makeBundledClientScript("entry.ts", dir);
  const first = get();
  expect(get()).toBe(first); // concurrent callers share the one build
  await expect(first).rejects.toThrow(/^entry\.ts bundle failed:\n/);
  writeFileSync(join(dir, "entry.ts"), "console.info('fixed-build');\n");
  const second = get();
  expect(second).not.toBe(first);
  expect(await second).toContain("fixed-build");
  writeFileSync(join(dir, "entry.ts"), "export const x = ;\n");
  expect(get()).toBe(second); // a good build stays memoized
});

test("wiki-client.ts loads the shell only under --watch, caught, so a broken reader file never stops the server", async () => {
  const { underWatch } = await import("./wiki-client.ts");
  expect(underWatch(["--watch"])).toBe(true);
  expect(underWatch(["--hot"])).toBe(true);
  expect(underWatch([])).toBe(false);
  // With no argument it reads bun's own flags (`bun run --watch x.ts` puts
  // `--watch` there), never the script's arguments.
  const [execArgv, argv] = [process.execArgv, process.argv];
  try {
    process.execArgv = ["--watch"];
    process.argv = [argv[0]!, "x.ts"];
    expect(underWatch()).toBe(true);
    process.execArgv = [];
    process.argv = [argv[0]!, "x.ts", "--watch"];
    expect(underWatch()).toBe(false);
  } finally {
    process.execArgv = execArgv;
    process.argv = argv;
  }
  const src = await Bun.file(new URL("./wiki-client.ts", import.meta.url)).text();
  // No static import of the shell: one would load it on `bun run start` too, and a throw there stops boot.
  expect(src).not.toMatch(/^import .*wiki-browser/m);
  expect(src).toMatch(/^if \(underWatch\(\)\) \{\n {2}import\("\.\/wiki-browser\.ts"\)\.catch\(/m);
});
