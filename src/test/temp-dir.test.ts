import { test, expect, describe } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedTestTempDirs, removeTestTempDirs, testTempDir, testTempDirSync } from "./temp-dir.ts";

/**
 * What the preload's `afterAll` relies on: both helpers record the dir they
 * make, and `removeTestTempDirs` removes every recorded dir. Calling it here
 * also removes dirs earlier files in this process recorded; those files have
 * finished, and the preload would remove them at the end anyway.
 */

describe("test temp dirs", () => {
  test("both helpers record their dir, and removeTestTempDirs removes every one", async () => {
    const sync = testTempDirSync(join(tmpdir(), "temp-dir-sync-"));
    const async = await testTempDir(join(tmpdir(), "temp-dir-async-"));
    writeFileSync(join(sync, "f.txt"), "x");
    expect(existsSync(sync)).toBe(true);
    expect(existsSync(async)).toBe(true);
    expect(recordedTestTempDirs()).toEqual(expect.arrayContaining([sync, async]));

    removeTestTempDirs();

    expect(existsSync(sync)).toBe(false);
    expect(existsSync(async)).toBe(false);
    expect(recordedTestTempDirs()).toEqual([]);
  });

  test("a dir that cannot be removed does not keep the others, stays recorded, and is reported once", () => {
    removeTestTempDirs();
    const before = testTempDirSync(join(tmpdir(), "temp-dir-before-"));
    const parent = testTempDirSync(join(tmpdir(), "temp-dir-locked-"));
    const child = testTempDirSync(join(parent, "child-"));
    const after = testTempDirSync(join(tmpdir(), "temp-dir-after-"));
    // A dir whose parent is read-only cannot be unlinked (EACCES). Root ignores
    // the mode, so the precondition is checked rather than assumed.
    expect(process.getuid?.()).not.toBe(0);
    chmodSync(parent, 0o500);
    let thrown: unknown;
    try {
      removeTestTempDirs();
    } catch (err) {
      thrown = err;
    } finally {
      chmodSync(parent, 0o700);
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const message = (thrown as AggregateError).message;
    expect(message).toContain(`${parent}:`);
    expect(message).toContain(`${child}:`);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect(existsSync(before)).toBe(false);
    expect(existsSync(after)).toBe(false);
    expect(recordedTestTempDirs()).toEqual([parent, child]);

    removeTestTempDirs();
    expect(existsSync(parent)).toBe(false);
    expect(recordedTestTempDirs()).toEqual([]);
  });
});
