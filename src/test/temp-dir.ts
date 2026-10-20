/**
 * Temp dirs for tests, removed when the run ends.
 *
 * `testTempDir` and `testTempDirSync` take the same prefix path as `mkdtemp` and
 * `mkdtempSync` and return the created dir. Each dir is recorded here, and the
 * `afterAll` in `src/test/preload.ts` removes every recorded dir once the
 * `bun test` run is done, so a test that never cleans up leaks nothing. A test
 * may still remove its dir earlier; the removal at the end uses `force`.
 *
 * Test files call these instead of `mkdtemp`/`mkdtempSync`;
 * `src/test/temp-dir-guard.test.ts` fails a test file that calls those directly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";

const created = new Set<string>();

export function testTempDirSync(prefix: string): string {
  const dir = mkdtempSync(prefix);
  created.add(dir);
  return dir;
}

export async function testTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(prefix);
  created.add(dir);
  return dir;
}

/** Removes every dir the helpers created. The preload's `afterAll` calls it. */
export function removeTestTempDirs(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.clear();
}
