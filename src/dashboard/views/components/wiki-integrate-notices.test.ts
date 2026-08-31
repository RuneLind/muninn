/**
 * Red→green pins for the two integrate NOTICES: the copy the ➕ bar shows once an
 * integrate write has landed, and whether the preview opens its drop list.
 */
import { test, expect, describe } from "bun:test";
import {
  appendBlockedCopy,
  shouldOpenDroppedList,
  INTEGRATE_STALE_COPY,
} from "./wiki-integrate.ts";

describe("appendBlockedCopy", () => {
  test("an ANNOTATED integrate says the appendix was written, not that the check is stale", () => {
    // The annotated write ALWAYS persists the `<FactCheck>` appendix (every inline
    // chip links into it), so telling the reader to re-run the check and add it
    // describes work that the very write which disabled the button already did.
    const copy = appendBlockedCopy({ wrote: "integrate", annotatable: true });
    expect(copy).not.toBe(INTEGRATE_STALE_COPY);
    expect(copy).toContain("appendix");
  });

  test("a plain `.md` integrate keeps the staleness copy", () => {
    // There the callout is a CHOICE (the checkbox), so "the page changed since the
    // check" is the honest thing to say.
    expect(appendBlockedCopy({ wrote: "integrate", annotatable: false })).toBe(
      INTEGRATE_STALE_COPY,
    );
    expect(appendBlockedCopy({ wrote: "integrate" })).toBe(INTEGRATE_STALE_COPY);
  });
});

describe("shouldOpenDroppedList", () => {
  test("opens when more anchors were dropped than proposed", () => {
    expect(shouldOpenDroppedList({ edits: [1], dropped: [1, 2, 3, 4, 5, 6, 7] })).toBe(true);
  });

  test("stays collapsed when the run mostly succeeded", () => {
    expect(shouldOpenDroppedList({ edits: [1, 2, 3], dropped: [1] })).toBe(false);
    expect(shouldOpenDroppedList({ edits: [1, 2], dropped: [1, 2] })).toBe(false);
    expect(shouldOpenDroppedList({ edits: [1], dropped: [] })).toBe(false);
    expect(shouldOpenDroppedList({})).toBe(false);
  });
});
