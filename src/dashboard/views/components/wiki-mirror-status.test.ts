/**
 * Architecture review 2026-10, finding 32: the reader's rail line for a
 * bucket-mirrored wiki whose copy is stale. Read off the namespace, so a
 * missing module fails these tests alone.
 */
import { describe, expect, test } from "bun:test";
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
});

/** A fake slot of three elements; `msgWrites` counts every write to the live
 *  region, because a real DOM re-announces a write even of the same words. */
function withFakeSlot(run: (dom: { slot: { hidden: boolean }; msg: { textContent: string }; age: { textContent: string }; msgWrites: () => number }) => void): void {
  const saved = globalThis.document;
  const slot = { hidden: true };
  let text = "";
  let writes = 0;
  const msg = {
    get textContent() { return text; },
    set textContent(v: string) { writes++; text = v; },
  };
  const age = { textContent: "" };
  const byId: Record<string, unknown> = {
    [view.MIRROR_STATUS_SLOT_ID]: slot, [view.MIRROR_STATUS_MSG_ID]: msg, [view.MIRROR_STATUS_AGE_ID]: age,
  };
  globalThis.document = { getElementById: (id: string) => byId[id] ?? null } as unknown as Document;
  try {
    run({ slot, msg, age, msgWrites: () => writes });
  } finally {
    globalThis.document = saved;
  }
}

describe("paintMirrorStatus", () => {
  test("shows the line for a stale mirror and hides it again once healthy", () => {
    withFakeSlot(({ slot, msg, age }) => {
      view.paintMirrorStatus(s({ health: "failing" }), NOW);
      expect(slot.hidden).toBe(false);
      expect(msg.textContent).toBe("Copy may be out of date: the bucket does not answer;");
      expect(age.textContent).toBe("no complete update yet.");
      view.paintMirrorStatus(undefined, NOW);
      expect(slot.hidden).toBe(true);
      expect(msg.textContent).toBe("");
      expect(age.textContent).toBe("");
    });
  });
});

describe("the age advances between listings (batch H fix round 1, F1)", () => {
  test("repaintMirrorStatus redraws the last status against a later clock", () => {
    withFakeSlot(({ slot, age }) => {
      view.paintMirrorStatus(s({ health: "failing", lastSuccessAt: NOW - 2 * 60_000 }), NOW);
      expect(age.textContent).toBe("last complete update 2 min ago.");
      view.repaintMirrorStatus(NOW + 60 * 60_000);
      expect(age.textContent).toBe("last complete update 1 h ago.");
      expect(slot.hidden).toBe(false);
      // Healthy again: the tick keeps it hidden.
      view.paintMirrorStatus(undefined, NOW);
      view.repaintMirrorStatus(NOW + 2 * 60 * 60_000);
      expect(slot.hidden).toBe(true);
      expect(age.textContent).toBe("");
    });
  });

  test("the tick interval is one minute, the finest step the age text shows", () => {
    expect(view.MIRROR_STATUS_TICK_MS).toBe(60_000);
  });
});

// Batch H fix round 2, D3: `role="status"` is a polite live region, and the age
// text changes every minute for the first hour.
describe("the live region speaks on a health change, not on the minute tick (D3)", () => {
  test("a tick that only advances the age leaves the live region unwritten", () => {
    withFakeSlot(({ msg, age, msgWrites }) => {
      let now = NOW;
      let tick: (() => void) | undefined;
      let tickMs = 0;
      const onListing = view.installMirrorStatus({
        now: () => now,
        setInterval: (fn, ms) => { tick = fn; tickMs = ms; },
      });
      expect(tickMs).toBe(view.MIRROR_STATUS_TICK_MS);
      onListing(s({ health: "failing", lastSuccessAt: NOW - 2 * 60_000 }));
      expect(msg.textContent).toBe("Copy may be out of date: the bucket does not answer;");
      expect(age.textContent).toBe("last complete update 2 min ago.");
      expect(msgWrites()).toBe(1);

      now += 60_000;
      tick!();
      expect(age.textContent).toBe("last complete update 3 min ago.");
      expect(msgWrites()).toBe(1);
      // A listing with the same health is not a change either.
      onListing(s({ health: "failing", lastSuccessAt: NOW - 2 * 60_000 }));
      expect(msgWrites()).toBe(1);

      // The health changes: the live region speaks.
      onListing(s({ health: "degraded", failedObjects: 2, lastSuccessAt: NOW }));
      expect(msg.textContent).toBe("Copy may be out of date: 2 pages or files could not be updated;");
      expect(msgWrites()).toBe(2);
    });
  });

  test("the served slot keeps the age outside the live region", async () => {
    const { renderWikiPage } = await import("../wiki-page.ts");
    const html = await renderWikiPage();
    const m = /<p class="wiki-mirror-status" id="wikiMirrorStatus"([^>]*)>([\s\S]*?)<\/p>/.exec(html);
    expect(m).not.toBeNull();
    const [, attrs, body] = m!;
    // The line as a whole is not a live region…
    expect(attrs).not.toMatch(/role=|aria-live/);
    // …the health message is, and the age sits beside it, not inside it.
    expect(body).toMatch(/<span id="wikiMirrorStatusMsg" role="status"><\/span>/);
    expect(body).toMatch(/<span id="wikiMirrorStatusAge"><\/span>/);
  });
});
