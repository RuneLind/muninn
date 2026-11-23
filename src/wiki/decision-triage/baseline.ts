/**
 * The replay file, read two ways. {@link readBaselineCards} is all that facts and
 * prompt code ever receive: seven named fields and no label. The labels and the
 * control's predictions come out of {@link readBaselineLabels}, for the scorer.
 */

import type { ReplayCard } from "./facts.ts";
import { replayKey } from "./schema.ts";

interface RawItem {
  wiki: string;
  relPath: string;
  id: string;
  answeredAt: string;
  commit?: string | null;
  hashMatches?: boolean | null;
  replayable?: boolean;
}

export function readBaselineCards(text: string): { cards: ReplayCard[]; unreplayable: number } {
  const raw = JSON.parse(text) as { items?: RawItem[] };
  if (!Array.isArray(raw.items)) throw new Error("not a baseline file (no items)");
  const cards: ReplayCard[] = [];
  let unreplayable = 0;
  for (const i of raw.items) {
    if (i.replayable !== true || !i.commit) {
      unreplayable++;
      continue;
    }
    cards.push({ wiki: i.wiki, relPath: i.relPath, id: i.id, answeredAt: i.answeredAt, commit: i.commit, hashMatches: i.hashMatches === true, replayable: true });
  }
  return { cards, unreplayable };
}

export interface BaselineLabels {
  labels: Map<string, { added: boolean; gapHours: number | null; textAlone: boolean }>;
  population: { added: number; other: number } | undefined;
  answersUntil: string | null;
}

/** For the scorer only, and only after the facts are gathered. */
export function readBaselineLabels(text: string): BaselineLabels {
  const raw = JSON.parse(text) as {
    answersUntil?: string;
    population?: { added: number; other: number };
    items: (RawItem & { addedSomething?: boolean; gapHours?: number | null; textAlonePredict?: unknown })[];
  };
  const labels: BaselineLabels["labels"] = new Map();
  for (const i of raw.items) {
    if (i.replayable !== true) continue;
    labels.set(replayKey(i), {
      added: i.addedSomething === true,
      gapHours: i.gapHours ?? null,
      textAlone: i.textAlonePredict === "HUMAN",
    });
  }
  return { labels, population: raw.population, answersUntil: raw.answersUntil ?? null };
}
