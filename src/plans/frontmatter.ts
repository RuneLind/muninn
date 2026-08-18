/**
 * The `/plans` board's one write into a plan PAGE: setting or clearing the
 * `priority:` line in its frontmatter.
 *
 * Three rules, all load-bearing:
 *
 *   1. **Fence-scoped, never a whole-file line upsert.** A `^priority:` replace
 *      over the whole file edits plan BODIES:
 *      `plans/mimir-plan-status-lifecycle.mdx` carries `plan_status:` at line 5
 *      (frontmatter) and again at line 145, inside a ```yaml example whose own
 *      `---` lines sit right beside it — mimir's `lint.sh` documents getting
 *      burned by exactly this shape. So the edit is confined to the leading
 *      `---` … `---` byte range, and the produced string is CHECKED against the
 *      original from the closing fence on before it is returned.
 *   2. **A line upsert, never parse-and-reserialize.** `parseFrontmatter` has no
 *      writer, and a round trip through one would re-quote every hand-written
 *      `status_note` in the corpus. One line is replaced, inserted or deleted;
 *      every other byte is the file's own.
 *   3. **Fail closed to `null`** (⇒ `writeWikiPage` answers `noop`, nothing is
 *      written) whenever the fence is not the shape this can edit safely: line 1
 *      is not `---`, or the fence never closes. A file we cannot read the fence
 *      of is a file we must not write.
 *
 * Key matching is `parseFrontmatter`'s own shape — the key at column 0 followed
 * immediately by `:` — so this writes exactly the line the board reads back.
 *
 * **CRLF:** the bytes are neither normalized nor rewritten. `source.ts`
 * normalizes only for PARSING and hashes as given; here the untouched lines keep
 * their own terminators (the split/join is on `\n`, so a `\r` rides along on the
 * line it belongs to) and an inserted line copies the opening fence's. So the
 * sha256 the caller returns is a hash of what is actually on disk.
 */

import type { PlanPriority } from "./constants.ts";

const FENCE = "---";
/** `parseFrontmatter`'s key shape: name at column 0, colon immediately after. */
const PRIORITY_LINE = /^priority:/;
const PLAN_STATUS_LINE = /^plan_status:/;

/** A line without its CRLF carriage return, for comparing against `---`. */
function bare(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Set (or, with `null`, clear) a plan's frontmatter `priority`.
 *
 * Returns the new file content, or `null` for "nothing to do" — the same value
 * already set, a clear on a file that carries no `priority:`, or a fence this
 * cannot safely edit. `writeWikiPage` turns `null` into a `noop`: no write, no
 * log entry, no reindex.
 *
 * A duplicate `priority:` inside one fence (a malformed file — the reader takes
 * the first) is normalized: the first is rewritten and the rest are dropped, so
 * the value the board shows and the value on disk cannot disagree afterwards.
 *
 * @throws if the produced string differs after the closing fence — the
 *   invariant this module exists for, asserted on the bytes rather than
 *   inferred from how they were built.
 */
export function setPlanPriority(content: string, priority: PlanPriority | null): string | null {
  const lines = content.split("\n");
  if (bare(lines[0] ?? "") !== FENCE) return null;
  const close = lines.findIndex((line, i) => i > 0 && bare(line) === FENCE);
  if (close === -1) return null;

  const cr = (lines[0] ?? "").endsWith("\r") ? "\r" : "";
  const fence: string[] = [];
  let replaced = false;
  let hadPriority = false;
  for (const line of lines.slice(1, close)) {
    if (!PRIORITY_LINE.test(line)) {
      fence.push(line);
      continue;
    }
    hadPriority = true;
    if (priority === null || replaced) continue;
    fence.push(`priority: ${priority}${cr}`);
    replaced = true;
  }
  if (priority === null && !hadPriority) return null;
  if (priority !== null && !replaced) {
    // Insert anchor: after `plan_status:` (present in every plan on disk — it is
    // what makes a file a plan at all), else as the fence's last line.
    const anchor = fence.findIndex((line) => PLAN_STATUS_LINE.test(line));
    fence.splice(anchor === -1 ? fence.length : anchor + 1, 0, `priority: ${priority}${cr}`);
  }

  const out = [lines[0]!, ...fence, ...lines.slice(close)].join("\n");
  if (out === content) return null;

  const tail = lines.slice(close).join("\n");
  const tailStart = out.length - tail.length;
  if (out.slice(tailStart) !== tail || out[tailStart - 1] !== "\n") {
    throw new Error("plan priority edit would have changed bytes outside the frontmatter fence");
  }
  return out;
}
