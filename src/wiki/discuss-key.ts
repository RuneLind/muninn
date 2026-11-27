/**
 * The key a Discuss page turn names (mimir plan
 * muninn-wiki-discuss-pane-room-and-stream, PR 2): the first tracker key or
 * `keys` kind in the question, else in the selection it carries. The engine
 * then puts that key's mentions in the prompt, so a «where else is X?» needs
 * no `wiki_grep`. Sonnet 5.5 holds its text after a tool result (22.11 raw
 * API; 27.11 on Copilot: one grep at 7.9 s, all 180 deltas in the turn's last
 * 12 ms), so a turn with no tool call is the one that can stream.
 *
 * One key, the first: the rest are left to the tools. A wiki with neither
 * `trackers` nor `keys` (mimir) gets null. Pure.
 */

import { scanKeyKinds, type KeyKind } from "./key-kinds.ts";
import { titleKeys } from "./trackers/jira.ts";
import type { TrackerConfig } from "./trackers/types.ts";

/** The longest text scanned: a question is capped well under this, a selection may not be. */
export const DISCUSS_KEY_SCAN_MAX = 4000;

/** Where `key` first stands whole in `t`, by the tracker rule's edges (`LEFT`, `END_RE` in `trackers/jira.ts`): no ASCII word character before it, and after it neither a word character nor `-` and a digit; -1 when it never does. A bare `indexOf` found MELOSYS-8351 inside `XMELOSYS-8351` and called it first. */
function wholeIndexOf(t: string, key: string): number {
  for (let at = t.indexOf(key); at >= 0; at = t.indexOf(key, at + 1)) {
    const before = at > 0 ? t[at - 1]! : "";
    const after = t.slice(at + key.length, at + key.length + 2);
    if (!/[A-Za-z0-9_]/.test(before) && !/^(?:[A-Za-z0-9_]|-[0-9])/.test(after)) return at;
  }
  return -1;
}

/** The earliest key in `text`: a `keys` kind match or an uppercase tracker key, whichever starts first. */
function firstKeyIn(text: string, trackers: readonly TrackerConfig[], kinds: readonly Pick<KeyKind, "name" | "pattern">[]): string | null {
  const t = text.slice(0, DISCUSS_KEY_SCAN_MAX);
  let best: { key: string; at: number } | null = null;
  const take = (key: string, at: number) => {
    if (at >= 0 && (best === null || at < best.at)) best = { key, at };
  };
  for (const m of scanKeyKinds(t, kinds).matches) take(m.key, m.start);
  for (const tr of trackers) for (const k of titleKeys(t, tr)) take(k, wholeIndexOf(t, k));
  return (best as { key: string } | null)?.key ?? null;
}

/** The key a page turn names: the question's first, else the selection's first; null when neither names one. */
export function discussTurnKey(input: { question: string; selection?: string | null }, cfg: { trackers?: readonly TrackerConfig[]; keys?: readonly Pick<KeyKind, "name" | "pattern">[] } | null | undefined): string | null {
  const trackers = cfg?.trackers ?? [];
  const kinds = cfg?.keys ?? [];
  if (trackers.length === 0 && kinds.length === 0) return null;
  return firstKeyIn(input.question, trackers, kinds) ?? (input.selection ? firstKeyIn(input.selection, trackers, kinds) : null);
}
