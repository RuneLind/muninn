import { describe, expect, test } from "bun:test";
import { approveButtonFor, approveButtonHtml, singleDriftNote } from "./wiki-gardener-drift.ts";

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

// Fix round 2 batch 2: the single card builds its Approve from the row here,
// so the browser cannot lock a drifted row by its own argument construction.
describe("approveButtonFor", () => {
  test("a drifted row with no fact-check lock keeps an enabled Approve", () => {
    const html = approveButtonFor({ factcheck: null, drifted: "target file changed since drafting" });
    expect(html).not.toContain("disabled");
    expect(html).toContain("data-drifted");
  });
  test("the fact-check lock disables Approve", () => {
    const html = approveButtonFor({ factcheck: { needsRedraft: true }, drifted: null });
    expect(html).toContain("data-fc-locked");
    expect(html).toContain("disabled");
  });
  test("the gate's single card calls it with the row and nothing else", async () => {
    const src = await Bun.file(new URL("./wiki-gardener-browser.ts", import.meta.url)).text();
    expect(src).toContain("html += approveButtonFor(p);");
    expect(src).not.toContain("approveButtonHtml");
  });
});
