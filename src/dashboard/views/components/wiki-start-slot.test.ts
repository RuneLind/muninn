import { describe, expect, test } from "bun:test";
import { INITIAL_SLOT, nextSlot, slotLive, slotView, type SlotEvent, type SlotKind, type SlotState } from "./wiki-start-slot.ts";

const R = 1_000; // the listing runAt the card is mounted for
const N = 2_000; // a newer runAt
const G = 5; // the current generation

const S = (kind: SlotKind, runAt: number | null, refused: number | null = null): SlotState => ({ kind, runAt, refused, gen: G });

const STATES: Record<string, SlotState> = {
  whatsnew: S("whatsnew", null),
  "whatsnew (R refused)": S("whatsnew", null, R),
  fallback: S("fallback", R, R),
  "card-loading": S("card-loading", R),
  card: S("card", R),
  "card-error": S("card-error", R),
};

/** One row: state × event → kind, runAt, gen bumped, and the visibility it
 *  shows with What's new holding content. */
type Row = [state: string, event: SlotEvent, kind: SlotKind, runAt: number | null, bumped: boolean];

const mount = (runAt: number | null, hasBody = false): SlotEvent => ({ type: "mount", runAt, hasBody });
const adopt = (runAt: number | null, hasBody = false): SlotEvent => ({ type: "adopt", runAt, hasBody });
const ok: SlotEvent = { type: "get-map", gen: G };
const refused: SlotEvent = { type: "get-refused", gen: G };
const err5: SlotEvent = { type: "get-5xx", gen: G };
const lateOk: SlotEvent = { type: "get-map", gen: G - 1 };
const lateRefused: SlotEvent = { type: "get-refused", gen: G - 1 };
const late5: SlotEvent = { type: "get-5xx", gen: G - 1 };

const ROWS: Row[] = [
  // whatsnew
  ["whatsnew", mount(null), "whatsnew", null, false],
  ["whatsnew", adopt(null), "whatsnew", null, false],
  ["whatsnew", mount(R), "card-loading", R, false],
  ["whatsnew", adopt(R), "card-loading", R, false],
  ["whatsnew", ok, "whatsnew", null, false],
  ["whatsnew", refused, "whatsnew", null, false],
  ["whatsnew", err5, "whatsnew", null, false],
  // a map that went and came back with the runAt the GET refused: still refused
  ["whatsnew (R refused)", adopt(R), "fallback", R, false],
  ["whatsnew (R refused)", mount(R), "fallback", R, false],
  ["whatsnew (R refused)", adopt(N), "card-loading", N, false],
  // fallback
  ["fallback", mount(R), "fallback", R, false],
  ["fallback", adopt(R), "fallback", R, false],
  ["fallback", adopt(N), "card-loading", N, false],
  ["fallback", mount(N), "card-loading", N, false],
  ["fallback", adopt(null), "whatsnew", null, false],
  ["fallback", ok, "fallback", R, false],
  ["fallback", lateOk, "fallback", R, false],
  ["fallback", err5, "fallback", R, false],
  // card-loading
  ["card-loading", mount(R), "card-loading", R, false],
  ["card-loading", adopt(R), "card-loading", R, false],
  ["card-loading", adopt(N), "card-loading", N, false],
  ["card-loading", mount(N), "card-loading", N, false],
  ["card-loading", adopt(null), "whatsnew", null, true],
  ["card-loading", mount(null), "whatsnew", null, true],
  ["card-loading", ok, "card", R, false],
  ["card-loading", refused, "fallback", R, true],
  ["card-loading", err5, "card-error", R, false],
  ["card-loading", lateOk, "card-loading", R, false],
  ["card-loading", lateRefused, "card-loading", R, false],
  ["card-loading", late5, "card-loading", R, false],
  // card (a body is painted)
  ["card", mount(R, true), "card", R, false],
  ["card", adopt(R, true), "card", R, false],
  ["card", adopt(N, true), "card", N, false],
  ["card", mount(N, true), "card", N, false],
  ["card", adopt(null, true), "whatsnew", null, true],
  ["card", ok, "card", R, false],
  ["card", refused, "card", R, false],
  ["card", err5, "card", R, false],
  ["card", lateOk, "card", R, false],
  // card-error (no body)
  ["card-error", mount(R), "card-loading", R, false],
  ["card-error", adopt(R), "card-error", R, false],
  ["card-error", adopt(N), "card-loading", N, false],
  ["card-error", adopt(null), "whatsnew", null, true],
  ["card-error", ok, "card", R, false],
  ["card-error", refused, "fallback", R, true],
  ["card-error", err5, "card-error", R, false],
  ["card-error", late5, "card-error", R, false],
  ["card-error", lateOk, "card-error", R, false],
];

const VIEW: Record<SlotKind, { card: boolean; whatsNew: boolean; digestAllowed: boolean }> = {
  whatsnew: { card: false, whatsNew: true, digestAllowed: true },
  fallback: { card: false, whatsNew: true, digestAllowed: true },
  "card-loading": { card: false, whatsNew: false, digestAllowed: false },
  card: { card: true, whatsNew: false, digestAllowed: false },
  "card-error": { card: true, whatsNew: false, digestAllowed: false },
};

describe("start slot: every (state × event) row", () => {
  for (const [name, ev, kind, runAt, bumped] of ROWS) {
    test(`${name} + ${ev.type}${"runAt" in ev ? `(${ev.runAt})` : ""}${"gen" in ev && ev.gen !== G ? " late" : ""} → ${kind}`, () => {
      const next = nextSlot(STATES[name]!, ev);
      expect(next.kind).toBe(kind);
      expect(next.runAt).toBe(runAt);
      expect(next.gen).toBe(bumped ? G + 1 : G);
      // What's new holding content shows only where the view allows a digest.
      expect(slotView(next, true)).toEqual(VIEW[kind]);
    });
  }
});

describe("slotView", () => {
  test("What's new with no content stays hidden even when it holds the slot", () => {
    expect(slotView(S("whatsnew", null), false)).toEqual({ card: false, whatsNew: false, digestAllowed: true });
  });
  test("no card kind ever allows a digest request", () => {
    for (const k of ["card-loading", "card", "card-error"] as const) {
      expect(slotView(S(k, R), true).digestAllowed).toBe(false);
      expect(slotView(S(k, R), true).whatsNew).toBe(false);
    }
  });
});

describe("slotLive", () => {
  test("a response from an older generation is late, and nothing is live outside a card", () => {
    expect(slotLive(S("card", R), G)).toBe(true);
    expect(slotLive(S("card", R), G - 1)).toBe(false);
    expect(slotLive(S("whatsnew", null), G)).toBe(false);
    expect(slotLive(S("fallback", R, R), G)).toBe(false);
  });
  test("a GET started before the map dropped and answered after it returns paints nothing", () => {
    // Load under gen G, drop the map (gen G+1), the map returns with a new runAt.
    let s = nextSlot(INITIAL_SLOT, adopt(R));
    const startedGen = s.gen;
    s = nextSlot(s, adopt(null));
    s = nextSlot(s, adopt(N));
    expect(s.kind).toBe("card-loading");
    expect(slotLive(s, startedGen)).toBe(false);
    expect(nextSlot(s, { type: "get-map", gen: startedGen })).toEqual(s);
    expect(nextSlot(s, { type: "get-5xx", gen: startedGen })).toEqual(s);
    expect(nextSlot(s, { type: "get-refused", gen: startedGen })).toEqual(s);
  });
});

describe("a refused runAt", () => {
  test("keeps What's new in the slot across a map that goes and comes back with it", () => {
    let s = nextSlot(INITIAL_SLOT, adopt(R));
    s = nextSlot(s, { type: "get-refused", gen: s.gen });
    expect(s.kind).toBe("fallback");
    s = nextSlot(s, adopt(null));
    expect(s.kind).toBe("whatsnew");
    expect(nextSlot(s, adopt(R)).kind).toBe("fallback");
    expect(nextSlot(s, adopt(N)).kind).toBe("card-loading");
  });
});
