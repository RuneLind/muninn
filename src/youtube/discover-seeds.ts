/**
 * Which summaries a discovery starts from (plan muninn-youtube-discovery, PR 3).
 * Pure: the page's seed bar and the weekly watcher pick from the same listing
 * with the same rules. Each seed is its own run, so a shelf always has one
 * "because".
 */

import type { CapturedDoc } from "./discover-deps.ts";

/** Seeds per batch: a category's newest, or the last week's, at most this many. */
export const DISCOVER_SEED_CAP = 5;
/** "The last 7 days": today and the six days before it. */
export const DISCOVER_WEEK_DAYS = 7;

export interface SeedDoc {
  id: string;
  title: string;
  category: string | null;
  date: string | null;
}

/** The doc id's folder (`ai/claude-code/<title>.md` → `ai/claude-code`), or null at the root. */
export function categoryOfDocId(docId: string): string | null {
  const i = docId.lastIndexOf("/");
  return i > 0 ? docId.slice(0, i) : null;
}

const titleOf = (docId: string): string => (docId.split("/").pop() ?? docId).replace(/\.md$/i, "") || docId;

/** Newest first; an undated doc after every dated one; ties by id. */
function newestFirst(a: SeedDoc, b: SeedDoc): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function toSeedDocs(docs: readonly CapturedDoc[]): SeedDoc[] {
  return docs
    .map((d) => ({ id: d.id, title: titleOf(d.id), category: categoryOfDocId(d.id), date: d.date }))
    .sort(newestFirst);
}

/** Every category with its document count, largest first, then by name. */
export function seedCategories(docs: readonly SeedDoc[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of docs) if (d.category) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
}

/** A category's newest documents, at most {@link DISCOVER_SEED_CAP}. */
export function newestInCategory(docs: readonly SeedDoc[], category: string, cap = DISCOVER_SEED_CAP): SeedDoc[] {
  return docs.filter((d) => d.category === category).sort(newestFirst).slice(0, cap);
}

/** `YYYY-MM-DD` of `now` minus `days`, in UTC. */
function dayMinus(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/** Documents dated within the last {@link DISCOVER_WEEK_DAYS} days (today included), newest first, at most `cap`. */
export function lastWeekSeeds(docs: readonly SeedDoc[], now: number, cap = DISCOVER_SEED_CAP): SeedDoc[] {
  const from = dayMinus(now, DISCOVER_WEEK_DAYS - 1);
  return docs.filter((d) => d.date !== null && d.date >= from).sort(newestFirst).slice(0, cap);
}
