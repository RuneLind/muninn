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

test("wiki-client.ts imports the shell as a value, so a client-only edit restarts `bun --watch`", async () => {
  const src = await Bun.file(new URL("./wiki-client.ts", import.meta.url)).text();
  expect(src).toMatch(/^import \{ boot \} from "\.\/wiki-browser\.ts";$/m);
  // An import nothing reads is dropped by Bun's transpiler, and with it the files.
  expect(src).toMatch(/^export const wikiShellBoot: \(\) => unknown = boot;$/m);
});
