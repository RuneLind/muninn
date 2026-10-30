/**
 * The start view's slot: which of the Your work card and What's new holds it,
 * and whether a digest may be requested. Pure, so every (state × event) row is
 * a unit test; `wiki-start-cards.ts` only feeds it events and applies `slotView`.
 *
 * Rule (plan `muninn-wiki-work-map`, D1): while the listing carries a map the
 * GET has not refused, What's new is hidden and no digest is requested.
 */

export type SlotKind = "whatsnew" | "fallback" | "card-loading" | "card" | "card-error";

export interface SlotState {
  readonly kind: SlotKind;
  /** The listing `runAt` the card is mounted for, or the one the GET refused
   *  (`fallback`); null under `whatsnew`. */
  readonly runAt: number | null;
  /** The last `runAt` the GET refused; it keeps What's new in the slot while
   *  the listing names it, across a map that goes and comes back. */
  readonly refused: number | null;
  /** Bumped when the card leaves the slot: a response carrying an older gen is late. */
  readonly gen: number;
}

export type SlotEvent =
  /** The start view was rendered (page load, tab switch, Back): a new DOM. */
  | { type: "mount"; runAt: number | null; hasBody: boolean }
  /** A background listing adopt: the DOM is the one already there. */
  | { type: "adopt"; runAt: number | null; hasBody: boolean }
  | { type: "get-map"; gen: number }
  /** A 2xx without a map, a 4xx, a non-JSON body, or the network twice. */
  | { type: "get-refused"; gen: number }
  /** Retry re-sends the GET with the error still showing, so it is no event. */
  | { type: "get-5xx"; gen: number };

export const INITIAL_SLOT: SlotState = { kind: "whatsnew", runAt: null, refused: null, gen: 0 };

export function isCardKind(kind: SlotKind): boolean {
  return kind === "card-loading" || kind === "card" || kind === "card-error";
}

/** True while a response started under `gen` may still change the card. */
export function slotLive(s: SlotState, gen: number): boolean {
  return gen === s.gen && isCardKind(s.kind);
}

function leave(s: SlotState, kind: "whatsnew" | "fallback", runAt: number | null, refused: number | null): SlotState {
  return { kind, runAt, refused, gen: isCardKind(s.kind) ? s.gen + 1 : s.gen };
}

export function nextSlot(s: SlotState, e: SlotEvent): SlotState {
  switch (e.type) {
    case "mount":
    case "adopt": {
      if (e.runAt === null) return leave(s, "whatsnew", null, s.refused);
      if (e.runAt === s.refused) return leave(s, "fallback", e.runAt, s.refused);
      if (isCardKind(s.kind) && e.runAt === s.runAt) {
        // A rebuilt DOM re-asks a GET that last answered 5xx; an adopt does not.
        return e.type === "mount" && s.kind === "card-error" ? { ...s, kind: "card-loading" } : s;
      }
      const kind = isCardKind(s.kind) && e.hasBody ? "card" : "card-loading";
      return { kind, runAt: e.runAt, refused: null, gen: s.gen };
    }
    case "get-map":
      return slotLive(s, e.gen) ? { ...s, kind: "card" } : s;
    case "get-refused":
      // A card already painting a map keeps it; only an empty card falls back.
      if (!slotLive(s, e.gen) || s.kind === "card") return s;
      return leave(s, "fallback", s.runAt, s.runAt);
    case "get-5xx":
      return slotLive(s, e.gen) && s.kind === "card-loading" ? { ...s, kind: "card-error" } : s;
  }
}

export interface SlotView {
  card: boolean;
  whatsNew: boolean;
  digestAllowed: boolean;
}

/** What the slot shows. What's new shows only content it holds (a digest, an
 *  error's Retry); a loading or empty one stays hidden. */
export function slotView(s: SlotState, whatsNewHasContent: boolean): SlotView {
  const digestAllowed = s.kind === "whatsnew" || s.kind === "fallback";
  return {
    card: s.kind === "card" || s.kind === "card-error",
    whatsNew: digestAllowed && whatsNewHasContent,
    digestAllowed,
  };
}
