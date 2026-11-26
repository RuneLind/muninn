/**
 * A key's one hover target beside its fact chip (Discuss v2 PR 6, fix round 1
 * J1). The server marks every key, its chip after the mark; the chip paint
 * marks a key whose own chip shows as chipped, so the chip is its target, and
 * a key whose chip hides (no counted PR, no Jira status yet) keeps the mark.
 * A deferred Jira answer that shows the chip moves the target to it. The
 * browser half is e2e/wiki-trace.spec.ts.
 */

import { test, expect, describe } from "bun:test";
import { Window } from "happy-dom";
import { adoptLiveFactIssues, enhanceLiveFacts } from "./wiki-live-facts.ts";
import { peekKeyOf } from "./wiki-key-trace.ts";
import type { LiveFactsPayload } from "../../../wiki/core/live-facts-chip.ts";

const FACTS: LiveFactsPayload = {
  prs: { "acme/acme-api#6": { title: "DEMO-30 try", state: "CLOSED", isDraft: false, mergedAt: null, inProd: null, firstProd: null, draftTag: null, checkedAt: "2026-11-20T10:00:00Z" } },
  keys: { "DEMO-30": { prs: ["acme/acme-api#6"] } },
  noProd: [],
};

function article() {
  const w = new Window();
  w.document.body.innerHTML =
    '<div class="wiki-article"><p>' +
    '<span class="wiki-key" data-wiki-key="DEMO-30">DEMO-30</span><span class="fact-chip" data-live-fact="DEMO-30" data-reader-only></span> has a closed PR; ' +
    '<span class="wiki-key" data-wiki-key="DEMO-40">DEMO-40</span> has no chip.</p></div>';
  const doc = w.document as unknown as Document;
  const q = (s: string) => doc.querySelector<HTMLElement>(s)!;
  return { root: q(".wiki-article"), mark: q('.wiki-key[data-wiki-key="DEMO-30"]'), chip: q('span.fact-chip[data-live-fact="DEMO-30"]'), other: q('.wiki-key[data-wiki-key="DEMO-40"]') };
}

describe("a key's hover target follows whether its chip shows", () => {
  test("a hidden chip leaves the mark as the target; a Jira status that shows the chip moves it to the chip; a status gone moves it back", () => {
    const a = article();
    enhanceLiveFacts(a.root, FACTS);
    expect(a.chip.hidden).toBe(true);
    expect(peekKeyOf(a.mark)?.el === a.mark).toBe(true);
    expect(peekKeyOf(a.other)?.key).toBe("DEMO-40");

    adoptLiveFactIssues([{ key: "DEMO-30", status: "I arbeid" }]);
    expect(a.chip.hidden).toBe(false);
    expect(peekKeyOf(a.mark)).toBeNull();
    expect(peekKeyOf(a.chip)?.key).toBe("DEMO-30");
    expect(peekKeyOf(a.other)?.key).toBe("DEMO-40");

    adoptLiveFactIssues([]);
    expect(a.chip.hidden).toBe(true);
    expect(peekKeyOf(a.mark)?.el === a.mark).toBe(true);
  });
});
