/**
 * `plans/queue.yaml` — the hand-orderable column ranking behind the `/plans`
 * board.
 *
 * The board's columns come from each plan's own `plan_status` frontmatter; this
 * file carries only the ORDER within a column, because "which card is next" is a
 * judgement no frontmatter field holds. It lives in the mimir wiki beside the
 * plans so the ordering travels with the corpus and is reviewable in git.
 *
 * Three rules the grammar encodes, and all three are load-bearing:
 *
 *   1. **The shape is exactly one thing.** Top-level keys from the column enum,
 *      each a flat block sequence of bare slugs, items two-space indented, keys
 *      emitted in {@link QUEUE_COLUMNS} order whatever order the caller's object
 *      carries. Nothing else is EMITTED. Two parsers read this file (this one,
 *      and mimir's own), and a byte shape is the only contract that survives
 *      that. The READ side is deliberately laxer than the write side — it is a
 *      hand-edited file, so an end-of-line `#` comment, a `proposed: []` and a
 *      key with no value all parse clean (to the same thing rule 2 emits).
 *   2. **An empty column is OMITTED, never `proposed: []`.** `parse` cannot tell
 *      the two apart on the way back in, so allowing both would let a writer
 *      emit a file that round-trips to a different file.
 *   3. **The SLUG GRAMMAR is shared with mimir's parser**, pinned here because
 *      it is the one thing both sides must agree on byte for byte:
 *      `^[A-Za-z][A-Za-z0-9-]*$`, and never the YAML literals `true`/`false`/
 *      `null` in any casing (mimir cannot tell a quoted `true` from the boolean
 *      on the way back in). A non-conforming entry is warned about and DROPPED
 *      on read; {@link serializeQueue} THROWS on one rather than quoting it,
 *      because quoting emits a file mimir's parser would silently drop. Slugs
 *      are compared byte-exact and case-sensitively — a slug IS a plan file's
 *      basename, and two basenames differing in case are two files.
 *
 * Everything here is pure — no fs, no yaml file paths. `source.ts` reads the
 * bytes and hands them over; PR 4's order writer serializes back through
 * {@link serializeQueue}.
 */

import { isMap, parseDocument } from "yaml";

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

/** The shared slug grammar — see rule 3. Leading letter, then letters, digits
 *  and hyphens; nothing else survives as a bare YAML scalar in both parsers. */
const SLUG_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
/** Words YAML resolves to a boolean or null in some casing. Never a slug, even
 *  quoted: the quoting is exactly what the other parser cannot see. */
const YAML_LITERALS = new Set(["true", "false", "null"]);

/** Whether a string is a legal queue slug under the grammar both parsers share. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !YAML_LITERALS.has(slug.toLowerCase());
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

  // `uniqueKeys: false` on purpose: the default THROWS on a repeated top-level
  // key, which would blank every column's ordering over one merge artefact in
  // one of them. The later key wins (yaml's own assignment order) and the
  // duplicate is warned about instead.
  const parsed = parseDocument(text, { uniqueKeys: false });
  if (parsed.errors.length > 0) {
    warnings.push(
      `queue.yaml: unparseable YAML (${parsed.errors[0]!.message}) — every column treated as unranked`,
    );
    return { order, warnings };
  }
  const doc: unknown = parsed.toJS();
  if (doc == null) return { order, warnings };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    warnings.push("queue.yaml: top level is not a mapping — every column treated as unranked");
    return { order, warnings };
  }
  if (isMap(parsed.contents)) {
    const seen = new Set<string>();
    for (const item of parsed.contents.items) {
      const key = String((item.key as { value?: unknown })?.value ?? item.key);
      if (seen.has(key)) {
        warnings.push(`queue.yaml: duplicate column "${key}" — the last one wins`);
      }
      seen.add(key);
    }
  }

  // A slug ranks in exactly ONE column. The columns are mutually exclusive board
  // states, so a slug in two of them is a merge artefact, not an ordering —
  // which is a different sentence from the same slug listed twice in one column,
  // so the column it was first placed in is tracked, not just the fact.
  const placed = new Map<string, QueueColumn>();

  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!isQueueColumn(key)) {
      warnings.push(`queue.yaml: unknown column "${key}" — dropped`);
      continue;
    }
    // A key with no value at all (`proposed:`) is YAML for null. That is the
    // hand-edited spelling of an empty column, and rule 2 already says an empty
    // column has no key — so it is absent, not an error.
    if (value == null) continue;
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
      if (!isValidSlug(slug)) {
        warnings.push(`queue.yaml: "${slug}" is not a valid slug — dropped`);
        continue;
      }
      const where = placed.get(slug);
      if (where !== undefined) {
        warnings.push(
          where === key
            ? `queue.yaml: "${slug}" appears twice in column "${key}" — later one dropped`
            : `queue.yaml: "${slug}" appears in more than one column ("${where}" and "${key}") — later one dropped`,
        );
        continue;
      }
      if (knownSlugs && !knownSlugs.has(slug)) {
        warnings.push(`queue.yaml: "${slug}" names no plan on disk — dropped`);
        continue;
      }
      placed.set(slug, key);
      slugs.push(slug);
    }
    // Rule 2: an emptied column leaves no key behind.
    if (slugs.length > 0) order[key] = slugs;
  }

  return { order, warnings };
}

/**
 * Emit one slug, or refuse.
 *
 * Quoting an off-grammar slug was the earlier behaviour and it is the wrong
 * failure: the bytes would round-trip through THIS parser and be dropped by
 * mimir's, so the board and the wiki would disagree about the ordering with
 * nothing on either side saying so. Throwing keeps the two readers in lockstep
 * — the caller (PR 4's order endpoint) turns it into a 4xx.
 */
function scalar(slug: string): string {
  if (!isValidSlug(slug)) {
    throw new Error(`queue.yaml: "${slug}" is not a valid slug — refusing to write it`);
  }
  return slug;
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
 *
 * **Throws** on a slug outside the shared grammar (rule 3) rather than quoting
 * it — the caller must reject the request, not write bytes mimir would drop.
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
