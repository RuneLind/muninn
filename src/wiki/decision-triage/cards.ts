/**
 * Which cards a night reads: every open `<Question>` with an id on a page the
 * index lists, leaving out a closed-without-shipping plan (as `waitsOnYou`
 * does), a culled page and a duplicated id (as `waitsOnOwner` does).
 */

import { closedWithoutShipping } from "../../plans/board-client-pure.ts";
import type { WikiIndex, WikiPageMeta } from "../store.ts";
import { readPageText, type PageRead } from "./facts.ts";

export interface OpenCards {
  /** The pages holding at least one card, read once. */
  pages: PageRead[];
  cards: { relPath: string; id: string }[];
}

function pageInScope(meta: WikiPageMeta): boolean {
  return /\.mdx?$/i.test(meta.relPath) && !meta.culled && !closedWithoutShipping(meta.plan_status);
}

export async function collectOpenCards(index: WikiIndex, readBody: (meta: WikiPageMeta) => Promise<string | null>): Promise<OpenCards> {
  const pages: PageRead[] = [];
  const cards: OpenCards["cards"] = [];
  for (const meta of [...index.pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    if (!pageInScope(meta)) continue;
    const text = await readBody(meta);
    if (text === null || !text.includes("<Question")) continue;
    const read = readPageText(meta.relPath, text);
    const open = read.page.questions.filter((q) => q.id !== null && !q.duplicate && (read.page.states.get(q.id)?.kind ?? "open") === "open");
    if (open.length === 0) continue;
    pages.push(read);
    for (const q of open) cards.push({ relPath: meta.relPath, id: q.id! });
  }
  return { pages, cards };
}
