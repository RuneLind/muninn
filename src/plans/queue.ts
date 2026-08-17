/**
 * `plans/queue.yaml` — the hand-orderable column ranking behind the `/plans`
 * board.
 *
 * The board's columns come from each plan's own `plan_status` frontmatter; this
 * file carries only the ORDER within a column, because "which card is next" is a
 * judgement no frontmatter field holds. It lives in the mimir wiki beside the
 * plans so the ordering travels with the corpus and is reviewable in git.
 *
 * Two rules the grammar encodes, and both are load-bearing:
 *
 *   1. **The shape is exactly one thing.** Top-level keys from the column enum,
 *      each a flat block sequence of bare slugs. Nothing else parses, nothing
 *      else is emitted. Two parsers will read this file (this one, and mimir's
 *      own fixture check) and a byte shape is the only contract that survives
 *      that.
 *   2. **An empty column is OMITTED, never `proposed: []`.** `parse` cannot tell
 *      the two apart on the way back in, so allowing both would let a writer
 *      emit a file that round-trips to a different file.
 *
 * Everything here is pure — no fs, no yaml file paths. `source.ts` reads the
 * bytes and hands them over; PR 4's order writer serializes back through
 * {@link serializeQueue}.
 */

import { parse } from "yaml";

/** The board columns that can be hand-ordered. Deliberately NOT the full
 *  `plan_status` enum: `shipped`/`superseded`/`abandoned` are terminal states
 *  nobody drags, and giving them a queue key would invite an ordering that the
 *  board never reads. Order here is also the key order {@link serializeQueue}
 *  emits, so the file's shape is stable across writers. */
export const QUEUE_COLUMNS = ["proposed", "ready", "in-flight", "blocked"] as const;
export type QueueColumn = (typeof QUEUE_COLUMNS)[number];

/** Column → ranked slugs. A column with no ranking is ABSENT, not `[]`. */
export type QueueOrder = Partial<Record<QueueColumn, string[]>>;

export interface QueueParseResult {
  order: QueueOrder;
  /** Human-readable reasons for everything dropped. The caller aggregates these
   *  into one log line — a corpus-wide rename can invalidate many rows at once
   *  and one warn per row would bury the signal. */
  warnings: string[];
}

function isQueueColumn(key: string): key is QueueColumn {
  return (QUEUE_COLUMNS as readonly string[]).includes(key);
}

/**
 * Parse `plans/queue.yaml` and validate it strictly against the grammar above.
 *
 * Anything off-grammar is DROPPED with a warning rather than throwing: this file
 * is hand-edited, and a typo in one column must not blank the board's ordering
 * wholesale. An empty/absent file is a legal state meaning "every column
 * unranked".
 *
 * @param knownSlugs When given, slugs naming no plan on disk are dropped — a
 *   plan can be renamed or retired out from under the queue, and a stale entry
 *   would otherwise rank a card that does not exist. Omit to skip the check
 *   (round-trip tests, and callers that have no corpus at hand).
 */
export function parseQueueYaml(
  text: string,
  knownSlugs?: ReadonlySet<string>,
): QueueParseResult {
  const warnings: string[] = [];
  const order: QueueOrder = {};
  if (!text.trim()) return { order, warnings };

  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`queue.yaml: unparseable YAML (${msg}) — every column treated as unranked`);
    return { order, warnings };
  }
  if (doc == null) return { order, warnings };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    warnings.push("queue.yaml: top level is not a mapping — every column treated as unranked");
    return { order, warnings };
  }

  // A slug ranks in exactly ONE column. The columns are mutually exclusive board
  // states, so a slug in two of them is a merge artefact, not an ordering.
  const placed = new Set<string>();

  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!isQueueColumn(key)) {
      warnings.push(`queue.yaml: unknown column "${key}" — dropped`);
      continue;
    }
    if (!Array.isArray(value)) {
      warnings.push(`queue.yaml: column "${key}" is not a list — dropped`);
      continue;
    }
    const slugs: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !entry.trim()) {
        warnings.push(`queue.yaml: column "${key}" has a non-slug entry — dropped`);
        continue;
      }
      const slug = entry.trim();
      if (placed.has(slug)) {
        warnings.push(`queue.yaml: "${slug}" appears in more than one column — later one dropped`);
        continue;
      }
      if (knownSlugs && !knownSlugs.has(slug)) {
        warnings.push(`queue.yaml: "${slug}" names no plan on disk — dropped`);
        continue;
      }
      placed.add(slug);
      slugs.push(slug);
    }
    // Rule 2: an emptied column leaves no key behind.
    if (slugs.length > 0) order[key] = slugs;
  }

  return { order, warnings };
}

/** Slugs are `[a-z0-9-]` in practice; quote anything that would not survive as a
 *  bare YAML scalar rather than emitting a file our own parser rejects. */
function scalar(slug: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) ? slug : JSON.stringify(slug);
}

/**
 * Emit the canonical `queue.yaml` bytes. This is the ONLY writer — PR 4's order
 * endpoint serializes through it so mimir's checked-in fixture and muninn's
 * writes cannot drift into two byte shapes.
 *
 * Columns are emitted in {@link QUEUE_COLUMNS} order regardless of the input's
 * key order, empty columns are omitted, and the file ends with a newline.
 * Returns `""` for a fully empty order — which is the same thing as no file, so
 * a writer handed an emptied board can delete rather than write a stub.
 */
export function serializeQueue(order: QueueOrder): string {
  const lines: string[] = [];
  for (const col of QUEUE_COLUMNS) {
    const slugs = order[col];
    if (!slugs || slugs.length === 0) continue;
    lines.push(`${col}:`);
    for (const slug of slugs) lines.push(`  - ${scalar(slug)}`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}
