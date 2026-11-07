import { expect, test } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";

test("a spawned e2e muninn reads no developer triage log: DECISION_TRIAGE_DIR is set, absolute, and not under the home dir", () => {
  const dir = e2eEnv().DECISION_TRIAGE_DIR ?? "";
  // Blank means the default `~/.muninn/decision-triage` (`log.ts`), the developer's real log.
  expect(dir).not.toBe("");
  expect(path.isAbsolute(dir)).toBe(true);
  expect(dir.startsWith(path.join(homedir(), ".muninn"))).toBe(false);
});
