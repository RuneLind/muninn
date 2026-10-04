/**
 * `session-refs.ts` — the helpers moved out of `session-ledger.ts`,
 * `provenance-service.ts` and `graph.ts`. The move must not change an answer,
 * so `dedupeSessionRefs` is compared against the pre-move implementation
 * (copied verbatim below as the oracle) over the existing fixtures.
 */

import { test, expect, describe } from "bun:test";
import { bareId, dedupeSessionRefs, isSessionIdShape, stampedSessionRefs } from "./session-refs.ts";
import * as ledger from "./session-ledger.ts";
import * as service from "./provenance-service.ts";

/** `provenance-service.ts`'s implementation before the move, verbatim. */
function dedupeBefore(refs: readonly string[]): string[] {
  const bare = (ref: string): string => {
    const at = ref.indexOf(":");
    return at <= 0 || at === ref.length - 1 ? ref : ref.slice(at + 1);
  };
  const at = new Map<string, number>();
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const id = bare(ref);
    const seen = at.get(id);
    if (seen === undefined) {
      at.set(id, out.length);
      out.push(ref);
      continue;
    }
    if (out[seen] === id && ref !== id) out[seen] = ref;
  }
  return out;
}

const ID_A = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const SESSION_A = `claude-code:${ID_A}`;

const FIXTURES: string[][] = [
  [SESSION_A, ID_A, " ", "other"],
  [ID_A, SESSION_A],
  [SESSION_A, `opencode:${ID_A}`],
  ["a:", ":b", "x:y:z", "  ", ""],
  ["opencode:ses_7f3a9b2c1d", "ses_7f3a9b2c1d", "claude-code:ses_7f3a9b2c1d"],
];

describe("dedupeSessionRefs after the move", () => {
  test("answers exactly what the pre-move implementation answered", () => {
    for (const refs of FIXTURES) expect(dedupeSessionRefs(refs)).toEqual(dedupeBefore(refs));
  });

  test("the old homes re-export the SAME functions", () => {
    expect(service.dedupeSessionRefs).toBe(dedupeSessionRefs);
    expect(ledger.isSessionIdShape).toBe(isSessionIdShape);
  });
});

describe("bareId / stampedSessionRefs", () => {
  test("bareId strips one provider prefix", () => {
    expect(bareId(SESSION_A)).toBe(ID_A);
    expect(bareId(ID_A)).toBe(ID_A);
    expect(bareId("a:")).toBe("a:");
  });

  test("stampedSessionRefs dedupes and drops shapes that cannot be ids", () => {
    expect(stampedSessionRefs({ sessions: [ID_A, SESSION_A, "see notes", "x".repeat(129)] })).toEqual([
      SESSION_A,
    ]);
    expect(stampedSessionRefs({})).toEqual([]);
  });
});
