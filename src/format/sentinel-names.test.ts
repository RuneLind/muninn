import { test, expect } from "bun:test";
import { Glob } from "bun";
import path from "node:path";
import { SENTINEL_NAMES } from "./sentinel-names.ts";

const SRC = path.join(import.meta.dir, "..");

/** A placeholder marker (`ph.add("INLINE", …)`) or a caller's sentinel built
 *  in a template literal (`` `\x00CB${id}\x00` ``). */
const PRODUCER_RES = [/\bph\.add\(\s*"([A-Z]+)"/g, /`(?:\\x00|\\u0000|\\0)([A-Z]+)\$\{/g];

/** The lint checks park wikilinks as `\x00L<n>\x00` to read a component's
 *  text; they render no HTML, so their sentinel never reaches a page. */
const RENDERS_NOTHING = (rel: string) => /^wiki\/lint-[^/]+\.ts$/.test(rel);

async function producers(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for await (const rel of new Glob("**/*.ts").scan(SRC)) {
    if (rel.endsWith(".test.ts") || RENDERS_NOTHING(rel)) continue;
    const text = await Bun.file(path.join(SRC, rel)).text();
    for (const re of PRODUCER_RES) for (const m of text.matchAll(re)) if (!found.has(m[1]!)) found.set(m[1]!, rel);
  }
  return found;
}

test("every render sentinel produced in src/ is in SENTINEL_NAMES, and every name there is produced", async () => {
  const found = await producers();
  const missing = [...found].filter(([name]) => !SENTINEL_NAMES.includes(name)).map(([name, rel]) => `${name} (${rel})`);
  expect(missing).toEqual([]);
  expect(SENTINEL_NAMES.filter((n) => !found.has(n))).toEqual([]);
});
