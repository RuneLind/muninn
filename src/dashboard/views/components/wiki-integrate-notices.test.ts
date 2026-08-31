/**
 * Red→green pins for the two integrate NOTICES: the copy the ➕ bar shows once an
 * integrate write has landed, and whether the preview opens its drop list.
 */
import { test, expect, describe } from "bun:test";
import {
  appendBlockedCopy,
  appendBlockedTone,
  shouldOpenDroppedList,
  integratePreviewHtml,
  INTEGRATE_STALE_COPY,
} from "./wiki-integrate.ts";

describe("appendBlockedCopy", () => {
  test("keys on what the write DID, not on the page being `.mdx`", () => {
    // `annotatable` means only "the checked page is .mdx". The apply route has an
    // explicit no-block branch (`!appendCallout && !wroteWrapper`), reachable on an
    // .mdx page whenever every mark drops and the reader leaves the checkbox off —
    // i.e. exactly the table-row / fenced-anchor pages this feature's drop tally
    // exists to diagnose. Claiming an appendix there is worse than the staleness
    // copy it replaced: it is false, and it removes the only prompt to add one.
    expect(appendBlockedCopy({ wrote: "integrate", annotatable: true, wroteBlock: false })).toBe(
      INTEGRATE_STALE_COPY,
    );
    expect(appendBlockedCopy({ wrote: "integrate", annotatable: true })).toBe(
      INTEGRATE_STALE_COPY,
    );
  });

  test("says the block was written when the write actually wrote one", () => {
    const copy = appendBlockedCopy({ wrote: "integrate", annotatable: true, wroteBlock: true });
    expect(copy).not.toBe(INTEGRATE_STALE_COPY);
    expect(copy).toContain("appendix");
  });

  test("a plain `.md` write that added its callout says so too", () => {
    // The `.md` branch writes a `> [!factcheck]` callout rather than the component
    // appendix, so the wording must not promise an `<FactCheck>` block there.
    const copy = appendBlockedCopy({ wrote: "integrate", annotatable: false, wroteBlock: true });
    expect(copy).not.toBe(INTEGRATE_STALE_COPY);
    expect(copy).not.toContain("appendix");
    expect(copy).toContain("callout");
  });
});

describe("appendBlockedTone", () => {
  test("a completed write is not styled as an error", () => {
    // The whole defect was that the message read as a fault. Moving the words while
    // leaving `.error` (red) on the span fixes half of it.
    expect(appendBlockedTone({ wrote: "integrate", wroteBlock: true })).toBe("done");
  });

  test("a genuinely stale turn stays an error", () => {
    expect(appendBlockedTone({ wrote: "integrate", wroteBlock: false })).toBe("error");
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

describe("the drop list on the ZERO-edit panel", () => {
  test("opens there too — that is the run whose headline is most misleading", () => {
    // `integratePreviewHtml` early-returns `nothingIntegrableHtml` when there are no
    // edits, and that panel rendered its reasons collapsed regardless. A run that
    // proposed 0 and dropped 7 is the strictest case of "the count alone misleads".
    const html = integratePreviewHtml(
      { edits: [], dropped: [{ reason: "the checked passage is a table row" }] },
      [],
      false,
    );
    expect(html).toContain("Nothing to integrate");
    expect(html).toContain("<details");
    expect(html).toMatch(/<details[^>]*\sopen[^>]*>/);
  });
});
