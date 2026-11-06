/**
 * The decision inbox's rule (P3, D19 and D22 in mimir plans/muninn-wiki-decision-triage.mdx):
 * which of four lanes an open card goes to, and the order inside a lane. Pure.
 * `docs/proto/decision-inbox/dump.ts` was the reference.
 */

import { QUESTION_NOT_SURE } from "../../format/question.ts";

export type InboxLane = "close" | "ask" | "pass" | "default";

/** The wiki whose cards to the owner are asked rather than defaulted. */
export const ASK_WIKI = "melosys-kode-wiki";

export interface LaneFacts {
  wiki: string;
  /** Every author's latest live answer ({@link liveAnswers}). */
  answers: readonly { choice: string | null }[];
  /** `unclosedCards` flags the card (P1). */
  hinted: boolean;
  /** Do the resolved targets include the owner; null when they name nobody. */
  ownerAsked: boolean | null;
}

/** A live answer other than not sure, a text-only one included (D22). */
export const settlingAnswers = <A extends { choice: string | null }>(answers: readonly A[]): A[] =>
  answers.filter((a) => a.choice !== QUESTION_NOT_SURE);

export function inboxLane(card: LaneFacts): InboxLane {
  if (card.hinted || settlingAnswers(card.answers).length > 0) return "close";
  if (card.ownerAsked === false) return "pass";
  return card.wiki.toLowerCase() === ASK_WIKI ? "ask" : "default";
}

/** When the card started waiting: the commit that added it, then the waiting lane's `since`, then now. */
export function inboxBornMs(card: { added: string | null; laneSince: string | null }, nowMs: number): number {
  for (const at of [card.added, card.laneSince]) {
    const ms = at ? Date.parse(at) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return nowMs;
}

/** Oldest first; ties keep the page order. */
export function sortByAge<C extends { added: string | null; laneSince: string | null }>(cards: readonly C[], nowMs: number): C[] {
  return cards
    .map((c, i) => ({ c, i, at: inboxBornMs(c, nowMs) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.c);
}
