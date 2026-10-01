/// <reference lib="dom" />
/**
 * The Query explorer: a run of two or more `<Query>` cards (`section.query`)
 * with only whitespace between them gets a bar above the first card — a search
 * box matching each card's id, question, answer, body and `uses` values, and
 * one chip per `uses` value across the run. Client-side only; the server
 * renders the cards as before. A heading or any text between two cards splits
 * the run; cards inside a `<Fold>` are siblings of each other only, so they
 * form a run of their own.
 *
 * - Search: every whitespace-separated term must occur (case-insensitive).
 * - Chips: none pressed shows every card; pressed chips show a card that uses
 *   ANY of them.
 * - A card filtered out is `hidden`. A `wiki:reveal` event on it (dispatched by
 *   `revealHashTarget` for a `#q-n` link) clears that run's filter first, so a
 *   deep link always lands on a visible card.
 * - Idempotent: a card already in a run (`data-qx`) is skipped.
 */

import { REVEAL_EVENT } from "./wiki-hash-target.ts";

/** A whitespace-only text node. A comment never reaches the reader as a node:
 *  the renderer escapes `<!-- … -->` into visible text. */
const isBlankText = (n: Node): boolean => n.nodeType === 3 /* text */ && !(n.textContent ?? "").trim();

/** The card directly before `card`, past whitespace only. */
function previousCard(card: Element): Element | null {
  let n = card.previousSibling;
  while (n && isBlankText(n)) n = n.previousSibling;
  return n && n.nodeType === 1 /* element */ && (n as Element).matches("section.query") ? (n as Element) : null;
}

/** Every run of two or more adjacent cards under `root`, in document order. */
export function queryRuns(root: ParentNode): HTMLElement[][] {
  const runs: HTMLElement[][] = [];
  let cur: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>("section.query").forEach((card) => {
    if (cur.length && previousCard(card) === cur[cur.length - 1]) cur.push(card);
    else {
      if (cur.length >= 2) runs.push(cur);
      cur = [card];
    }
  });
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/** The text a card is searched by: its id, question, answer, body and every
 *  `uses` value. */
export function cardSearchText(card: Element): string {
  const parts = [".query-id", ".query-question", ".query-answer", ".query-body"].map(
    (sel) => card.querySelector(sel)?.textContent ?? "",
  );
  const uses = Array.from(card.querySelectorAll(".query-use"), (u) => u.textContent ?? "");
  return fold([...parts, ...uses].join("\n"));
}

/** True when `text` holds every term of `query`. */
export function matchesSearch(text: string, query: string): boolean {
  return fold(query).split(/\s+/).filter(Boolean).every((t) => text.includes(t));
}

/** True when no chip is pressed, or the card uses one that is. */
export function matchesUses(uses: readonly string[], pressed: ReadonlySet<string>): boolean {
  return pressed.size === 0 || uses.some((u) => pressed.has(u));
}

function enhanceRun(cards: HTMLElement[]): void {
  const first = cards[0]!;
  const items = cards.map((card) => ({
    card,
    text: cardSearchText(card),
    uses: Array.from(card.querySelectorAll(".query-use"), (u) => (u.textContent ?? "").trim()).filter(Boolean),
  }));
  const allUses = [...new Set(items.flatMap((i) => i.uses))];
  const pressed = new Set<string>();

  const bar = document.createElement("div");
  bar.className = "qx-bar";
  bar.setAttribute("role", "search");
  const input = document.createElement("input");
  input.type = "search";
  input.className = "qx-search";
  input.placeholder = "Search queries";
  input.setAttribute("aria-label", "Search queries");
  bar.append(input);
  const chips: HTMLButtonElement[] = allUses.map((u) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "qx-chip";
    b.textContent = u;
    b.setAttribute("aria-pressed", "false");
    return b;
  });
  if (chips.length) {
    const box = document.createElement("div");
    box.className = "qx-chips";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Filter by uses");
    box.append(...chips);
    bar.append(box);
  }
  const count = document.createElement("span");
  count.className = "qx-count";
  count.setAttribute("aria-live", "polite");
  bar.append(count);

  const apply = () => {
    let shown = 0;
    for (const i of items) {
      const show = matchesSearch(i.text, input.value) && matchesUses(i.uses, pressed);
      i.card.hidden = !show;
      if (show) shown++;
    }
    count.textContent = `${shown} of ${items.length} queries`;
  };
  const reset = () => {
    input.value = "";
    pressed.clear();
    for (const b of chips) b.setAttribute("aria-pressed", "false");
    apply();
  };
  input.addEventListener("input", apply);
  chips.forEach((b, k) =>
    b.addEventListener("click", () => {
      const u = allUses[k]!;
      if (pressed.has(u)) pressed.delete(u);
      else pressed.add(u);
      b.setAttribute("aria-pressed", String(pressed.has(u)));
      apply();
    }),
  );
  for (const i of items) {
    i.card.dataset.qx = "1";
    i.card.addEventListener(REVEAL_EVENT, () => {
      if (i.card.hidden) reset();
    });
  }
  first.before(bar);
  apply();
}

export function enhanceQueryExplorer(root: ParentNode): void {
  for (const run of queryRuns(root)) {
    if (run.some((c) => c.dataset.qx === "1")) continue;
    enhanceRun(run);
  }
}
