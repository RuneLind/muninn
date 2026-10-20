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

/** The dirs recorded and not yet removed, in creation order. */
export function recordedTestTempDirs(): string[] {
  return [...created];
}

/**
 * Removes every dir the helpers created. The preload's `afterAll` calls it.
 *
 * Each dir is removed on its own, so one that fails (EACCES, or ENOTEMPTY/EBUSY
 * from a child still writing past the retries) does not keep the rest. A failed
 * dir stays recorded, and the call then throws once naming every failure: from
 * the preload that fails the run, because a dir left behind is the leak this
 * helper exists to stop.
 */
export function removeTestTempDirs(): void {
  const failures: Error[] = [];
  for (const dir of [...created]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      created.delete(dir);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(new Error(`${dir}: ${reason}`, { cause: err }));
    }
  }
  if (failures.length > 0) {
    const lines = failures.map((e) => `  ${e.message}`).join("\n");
    throw new AggregateError(failures, `could not remove ${failures.length} test temp dir(s):\n${lines}`);
  }
}
