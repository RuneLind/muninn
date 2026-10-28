/**
 * `saidSpan`, shared by the server's hit window (`stale.ts`) and the reader's
 * marks (`wiki-stale-marks.ts`). The table is the output of the server's
 * private `saidSpan` before it moved here (PR #758 fix round 1), where no
 * match read `[0, 0]`; the server keeps that with `?? [0, 0]`.
 */
import { expect, test } from "bun:test";
import { saidSpan } from "./status-words.ts";

const BEFORE_MOVE: [string, string[], [number, number]][] = [
  [" is shipped",["shipped"],[4,11]],
  [" proposed, now in-flight",["proposed","in-flight"],[1,9]],
  [" in-flight, then shipped",["shipped"],[17,24]],
  [" not yet merged",["in-flight"],[1,15]],
  [" not yet merged",["shipped"],[0,0]],
  [" ikke merget ennå",["in-flight"],[1,12]],
  [" ble merget i går",["shipped"],[5,11]],
  [" er levert og ferdig",["shipped"],[4,10]],
  [" — blokkert av [[x]]",["blocked"],[3,11]],
  [" pågår (open PRs)",["in-flight"],[1,6]],
  [" åpne PR-er og utkast",["in-flight","proposed"],[1,11]],
  [" undone work",["shipped"],[0,0]],
  [" nothing here",["shipped"],[0,0]],
  [" Shipped, DONE",["shipped"],[1,8]],
  [" foreslått, så påbegynt",["in-flight"],[15,23]],
  [" draft blocked shipped",["blocked","shipped","proposed"],[1,6]],
  ["",["shipped"],[0,0]],
  [" in flight i gang",["in-flight"],[1,10]],
  [" æshipped shipped",["shipped"],[10,17]],
  [" not shipped",["shipped"],[0,0]],
];

test("saidSpan gives the server's spans from before the move", () => {
  for (const [text, said, span] of BEFORE_MOVE) expect([text, said, saidSpan(text, said) ?? [0, 0]]).toEqual([text, said, span]);
  expect(saidSpan(" nothing here", ["shipped"])).toBeNull();
});
