import { describe, expect, test } from "bun:test";
import { approveButtonHtml, singleDriftNote } from "./wiki-gardener-drift.ts";

// Finding 63, fix round 1 batch 2: a drifted single card keeps a way to `stale`.
describe("approveButtonHtml", () => {
  test("a drifted row keeps an ENABLED Approve, not the fact-check lock", () => {
    const html = approveButtonHtml({ factcheckLocked: false, drifted: true });
    expect(html).toContain('data-action="approve"');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("data-fc-locked");
    expect(html).toContain("marks it stale");
  });
  test("the fact-check lock still disables Approve, drifted or not", () => {
    for (const drifted of [false, true]) {
      const html = approveButtonHtml({ factcheckLocked: true, drifted });
      expect(html).toContain("data-fc-locked");
      expect(html).toContain("disabled");
    }
  });
  test("a clean row gets the plain Approve", () => {
    expect(approveButtonHtml({ factcheckLocked: false, drifted: false })).toBe(
      '<button class="gard-btn gard-approve" data-action="approve">Approve</button>',
    );
  });
});

describe("singleDriftNote", () => {
  test("names the reason and says Approve marks the row stale", () => {
    const note = singleDriftNote("target file changed since drafting");
    expect(note).toContain("(target file changed since drafting)");
    expect(note).toContain("Approve writes nothing and marks this proposal stale");
    expect(note).not.toContain("would be refused");
  });
});
