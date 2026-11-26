import { test, expect, describe } from "bun:test";
import { Window } from "happy-dom";
import { HASH_FLASH_CLASS, revealHashTarget } from "./wiki-hash-target.ts";
import { headingSlug } from "./wiki-ref-links.ts";
import { anchorSlug } from "../../../format/query-block.ts";
import { questionCardAnchor } from "../../../format/question-grid.ts";

/** The browser half (the fold opening, the scroll, the Back stack) is driven in
 *  e2e/wiki-step-anchors.spec.ts and e2e/wiki-ref-links.spec.ts. */

/**
 * A written `#fragment` against every way the reader mints an element id. The
 * server cannot tell an exact id from source text (`qcard-open 1` is an id,
 * `Kjøre Plan` is a Fold's id as written), so the reveal tries each producer's
 * form against the ids the page has. One row per producer: the id it mints,
 * then the written forms that must reach it.
 */
const PRODUCERS: { what: string; id: string; written: string[] }[] = [
  // Server: Fold, RunChecklist step, Query, case row, DecisionLog item (`anchorSlug`).
  { what: "Fold id as written", id: anchorSlug("Kjøre Plan"), written: ["kjøre-plan", "Kjøre Plan", "KJØRE-PLAN"] },
  // An NFD spelling of an NFC id (`o` + U+0308 for `ö`).
  { what: "Fold id, written decomposed", id: anchorSlug("Kj\u00f6re Plan"), written: ["Kjo\u0308re Plan"] },
  // Punctuation is where the two slugs part: `anchorSlug` makes `plan-tasks`, `headingSlug` `plan--tasks`.
  { what: "Fold id with punctuation", id: anchorSlug("Plan & tasks"), written: ["plan-tasks", "Plan & tasks"] },
  { what: "RunChecklist step", id: "alpha-r11", written: ["alpha-r11", "Alpha-R11", "ALPHA-R11"] },
  { what: "DecisionLog item", id: anchorSlug("D7"), written: ["d7", "D7"] },
  // A safe Question id is kept as written, lower-cased: a dot or a space survives.
  { what: "Question card with a dot", id: questionCardAnchor("O1.2"), written: ["qcard-o1.2", "qcard-O1.2"] },
  { what: "Question card with a space", id: questionCardAnchor("open 1"), written: ["qcard-open 1", "qcard-Open 1"] },
  // Client: a heading's GitHub-style slug (`headingSlug` via `ensureId`), which can lead or trail with `-`.
  { what: "emoji-led heading", id: headingSlug("🎯 Next Steps"), written: ["-next-steps", "🎯 Next Steps"] },
  { what: "heading with trailing punctuation", id: headingSlug("Notes —"), written: ["notes-", "Notes —"] },
  { what: "heading with inner punctuation", id: headingSlug("Runde 3 — kveld"), written: ["runde-3--kveld", "Runde 3 — kveld"] },
  { what: "repeated heading's suffix", id: "notater-1", written: ["notater-1", "Notater-1"] },
];

function withArticle(ids: string[], run: (root: Element, doc: Document) => void): void {
  const win = new Window();
  const doc = win.document as unknown as Document;
  const chrome = doc.createElement("div");
  chrome.id = "wikiList";
  doc.body.appendChild(chrome);
  const root = doc.createElement("div");
  root.className = "wiki-article";
  for (const id of ids) {
    const el = doc.createElement("section");
    el.id = id;
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  const lent = ["document", "HTMLDetailsElement", "CustomEvent"] as const;
  const saved = lent.map((k) => g[k]);
  for (const k of lent) g[k] = w[k];
  try {
    run(root, doc);
  } finally {
    lent.forEach((k, i) => (g[k] = saved[i]));
  }
}

describe("revealHashTarget: a written fragment reaches the id each producer mints", () => {
  test("the producers' ids are the ones the rows claim", () => {
    expect(PRODUCERS.map((p) => p.id)).toEqual([
      "kjøre-plan",
      "kj\u00f6re-plan",
      "plan-tasks",
      "alpha-r11",
      "d7",
      "qcard-o1.2",
      "qcard-open 1",
      "-next-steps",
      "notes-",
      "runde-3--kveld",
      "notater-1",
    ]);
  });

  for (const p of PRODUCERS) {
    for (const w of p.written) {
      test(`${p.what}: #${w} → #${p.id}`, () => {
        withArticle(
          PRODUCERS.map((x) => x.id),
          (root, doc) => {
            expect(revealHashTarget(root, `#${encodeURIComponent(w)}`)).toBe(true);
            expect(doc.getElementById(p.id)!.classList.contains(HASH_FLASH_CLASS)).toBe(true);
          },
        );
      });
    }
  }

  test("an exact id wins over a looser form of the same text", () => {
    // `Notes` exists as written AND as its lower case: the exact one is the target.
    withArticle(["Notes", "notes"], (root, doc) => {
      expect(revealHashTarget(root, "#Notes")).toBe(true);
      expect(doc.getElementById("Notes")!.classList.contains(HASH_FLASH_CLASS)).toBe(true);
      expect(doc.getElementById("notes")!.classList.contains(HASH_FLASH_CLASS)).toBe(false);
    });
  });

  test("an id outside the article, or one no form reaches, reveals nothing", () => {
    withArticle(["alpha-r11"], (root) => {
      expect(revealHashTarget(root, "#wikiList")).toBe(false);
      expect(revealHashTarget(root, "#WIKILIST")).toBe(false);
      expect(revealHashTarget(root, "#beta-r11")).toBe(false);
    });
  });
});
