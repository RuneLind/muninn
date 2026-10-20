/**
 * Architecture review 2026-10, finding 32: the reader's rail line for a
 * bucket-mirrored wiki whose copy is stale. Read off the namespace, so a
 * missing module fails these tests alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as view from "./wiki-mirror-status.ts";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const s = (over: Partial<view.ListingMirrorStatus>): view.ListingMirrorStatus => ({
  health: "degraded", lastSuccessAt: null, consecutiveFailures: 0, failedObjects: 0, ...over,
});

describe("mirrorStatusText", () => {
  test("nothing to say when healthy or absent", () => {
    expect(view.mirrorStatusText(undefined, NOW)).toBeNull();
    expect(view.mirrorStatusText(null, NOW)).toBeNull();
    expect(view.mirrorStatusText(s({ health: "ok", lastSuccessAt: NOW }), NOW)).toBeNull();
  });

  test("each degraded state says the copy may be stale and since when", () => {
    expect(view.mirrorStatusText(s({ health: "degraded", failedObjects: 2, lastSuccessAt: NOW - 3 * 3_600_000 }), NOW))
      .toBe("Copy may be out of date: 2 pages or files could not be updated; last complete update 3 h ago.");
    expect(view.mirrorStatusText(s({ health: "degraded", failedObjects: 1 }), NOW))
      .toBe("Copy may be out of date: 1 page or file could not be updated; no complete update yet.");
    expect(view.mirrorStatusText(s({ health: "degraded" }), NOW))
      .toBe("Copy may be out of date: the last update was incomplete; no complete update yet.");
    expect(view.mirrorStatusText(s({ health: "failing", consecutiveFailures: 4, lastSuccessAt: NOW - 25 * 60_000 }), NOW))
      .toBe("Copy may be out of date: the bucket does not answer; last complete update 25 min ago.");
    expect(view.mirrorStatusText(s({ health: "refused", lastSuccessAt: NOW - 3 * 86_400_000 }), NOW))
      .toBe("Copy is no longer updated from the bucket; last complete update 3 d ago.");
    expect(view.mirrorStatusText(s({ health: "starting" }), NOW))
      .toBe("Copying this wiki from the bucket — pages may be missing.");
  });

  test("the HTML is escaped text behind a warning mark", () => {
    const html = view.mirrorStatusHtml(s({ health: "failing" }), NOW);
    expect(html).toBe('<span class="wiki-mirror-status-mark" aria-hidden="true">⚠</span> Copy may be out of date: the bucket does not answer; no complete update yet.');
    expect(view.mirrorStatusHtml(undefined, NOW)).toBe("");
  });
});

describe("paintMirrorStatus", () => {
  const saved = globalThis.document;
  afterEach(() => {
    globalThis.document = saved;
  });

  test("shows the line for a stale mirror and hides it again once healthy", () => {
    const slot = { innerHTML: "", hidden: true };
    globalThis.document = { getElementById: (id: string) => (id === view.MIRROR_STATUS_SLOT_ID ? slot : null) } as unknown as Document;
    view.paintMirrorStatus(s({ health: "failing" }), NOW);
    expect(slot.hidden).toBe(false);
    expect(slot.innerHTML).toContain("the bucket does not answer");
    view.paintMirrorStatus(undefined, NOW);
    expect(slot.hidden).toBe(true);
    expect(slot.innerHTML).toBe("");
  });
});
