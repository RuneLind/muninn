/**
 * The `/plans` board's one write into a plan PAGE: setting or clearing the
 * `priority:` line in its frontmatter.
 *
 * Four rules, all load-bearing:
 *
 *   1. **Fence-scoped, never a whole-file line upsert.** A `^priority:` replace
 *      over the whole file edits plan BODIES:
 *      `plans/mimir-plan-status-lifecycle.mdx` carries `plan_status:` at line 5
 *      (frontmatter) and again at line 145, inside a ```yaml example whose own
 *      `---` lines sit right beside it — mimir's `lint.sh` documents getting
 *      burned by exactly this shape.
 *   2. **The fence boundaries are the READER's**, byte for byte:
 *      `parseFrontmatter` (`src/wiki/store.ts`) opens on a line STARTING with
 *      `---` and closes at the first LATER line starting with `---`. Requiring
 *      the fences to be exactly `---` is a different rule, and every file the two
 *      rules disagree about is a file this corrupts or refuses to touch: a
 *      closing `--- ` (one trailing space) made the writer take body bytes for
 *      frontmatter — a body line reading `priority: …` was rewritten, and a clear
 *      DELETED it — while a loose OPENING fence made a file the board renders as
 *      a card permanently un-editable behind a 200. So both boundaries are
 *      derived here with `indexOf`/`startsWith` exactly as the reader draws them,
 *      and the produced bytes are CHECKED against that same rule before return.
 *   3. **A line upsert, never parse-and-reserialize.** `parseFrontmatter` has no
 *      writer, and a round trip through one would re-quote every hand-written
 *      `status_note` in the corpus. One line is replaced, inserted or deleted;
 *      every other byte is the file's own — with two measured caveats:
 *      `Bun.file().text()` strips a leading BOM, so a BOM'd file loses it on the
 *      first write (the caller hashes the same stripped text, so nothing goes
 *      stale — the byte is simply gone), and a multi-line YAML scalar whose
 *      continuation line begins `priority:` at column 0 is a shape
 *      `parseFrontmatter` ALSO mis-reads as a key, so this rewrites the line the
 *      reader would have read. Neither shape exists in mimir today.
 *   4. **Fail closed, and say so.** A fence this cannot read the boundaries of —
 *      no opening `---`, no closing one — is a REFUSAL (`{kind: "refused"}`, ⇒ a
 *      422), deliberately not the `noop` a caller would report as success.
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

import type { PlanPriority, PlanStatus } from "./constants.ts";

const FENCE = "---";
/** `parseFrontmatter`'s key shape: name at column 0, colon immediately after. */
const PRIORITY_LINE = /^priority:/;
const PLAN_STATUS_LINE = /^plan_status:/;
const STATUS_DATE_LINE = /^status_date:/;

/**
 * The outcome of one priority edit. A REFUSAL is not a noop: the caller answers
 * 422 for the first and 200 for the second, because "nothing to do" and "this
 * file is not a shape I may write" are different sentences to a reader whose
 * click did nothing.
 */
export type PlanPriorityEdit =
  | { kind: "changed"; content: string }
  | { kind: "noop" }
  | { kind: "refused"; reason: string };

/**
 * Where `parseFrontmatter` draws the fence, in byte offsets over the RAW string.
 *
 * `openEnd` is the newline ending line 1; `closeNl` is the newline immediately
 * before the closing fence line. The frontmatter body is `(openEnd, closeNl)` —
 * empty when the two coincide, which is what `---\n---` looks like.
 */
function fenceBounds(content: string): { openEnd: number; closeNl: number } | null {
  if (!content.startsWith(FENCE)) return null;
  const openEnd = content.indexOf("\n");
  if (openEnd === -1) return null;
  // The reader's own expression, not a re-derivation: any line starting `---`.
  const closeNl = content.indexOf(`\n${FENCE}`, 3);
  if (closeNl === -1 || closeNl < openEnd) return null;
  return { openEnd, closeNl };
}

/**
 * Set (or, with `null`, clear) a plan's frontmatter `priority`.
 *
 * A duplicate `priority:` inside one fence (a malformed file — the reader takes
 * the last) is normalized: the first is rewritten and the rest are dropped, so
 * the value the board shows and the value on disk cannot disagree afterwards.
 */
export function setPlanPriority(content: string, priority: PlanPriority | null): PlanPriorityEdit {
  const bounds = fenceBounds(content);
  if (!bounds) {
    return {
      kind: "refused",
      reason: "the file has no readable frontmatter fence — refusing to edit it",
    };
  }
  const { openEnd, closeNl } = bounds;
  const openLine = content.slice(0, openEnd);
  const tail = content.slice(closeNl);
  // `closeNl === openEnd` means the close IS line 2: there is no body region at
  // all, which is a different thing from a body region holding one empty line.
  const body = closeNl > openEnd ? content.slice(openEnd + 1, closeNl) : null;

  const cr = openLine.endsWith("\r") ? "\r" : "";
  const fence: string[] = [];
  let replaced = false;
  let hadPriority = false;
  for (const line of body === null ? [] : body.split("\n")) {
    if (!PRIORITY_LINE.test(line)) {
      fence.push(line);
      continue;
    }
    hadPriority = true;
    if (priority === null || replaced) continue;
    fence.push(`priority: ${priority}${cr}`);
    replaced = true;
  }
  if (priority === null && !hadPriority) return { kind: "noop" };
  if (priority !== null && !replaced) {
    // Insert anchor: after `plan_status:` (present in every plan on disk — it is
    // what makes a file a plan at all), else as the fence's last line.
    const anchor = fence.findIndex((line) => PLAN_STATUS_LINE.test(line));
    fence.splice(anchor === -1 ? fence.length : anchor + 1, 0, `priority: ${priority}${cr}`);
  }

  const out = openLine + (fence.length > 0 ? `\n${fence.join("\n")}` : "") + tail;
  if (out === content) return { kind: "noop" };

  // The guard, re-derived from the OUTPUT with the reader's rule rather than
  // from the pieces this was built out of — a comparison against the same slice
  // the string was concatenated from is a tautology, and a tautology is what let
  // rule 2's corruption through. This catches a fence boundary that MOVED (a
  // body line promoted into the frontmatter, or vice versa) as well as any byte
  // after it differing.
  const outBounds = fenceBounds(out);
  if (!outBounds || out.slice(outBounds.closeNl) !== tail) {
    return {
      kind: "refused",
      reason: "the edit would have changed bytes outside the frontmatter fence",
    };
  }
  return { kind: "changed", content: out };
}

/**
 * Set a plan's frontmatter `plan_status`, stamping `status_date` in the same
 * write — mimir's lifecycle records WHEN a status changed, and a flip without a
 * date would sort the card by a date describing the previous state.
 *
 * The archive move the board offers, but generic on purpose: any enum value is
 * a legal target, so a later column drag can reuse it.
 *
 * Same rules as {@link setPlanPriority}: fence-scoped line upsert, duplicate
 * lines normalized, refusal on an unreadable fence, output re-checked with the
 * reader's own boundary rule. Two of its own:
 *
 *   - **The same status is a noop that leaves `status_date` alone.** Re-clicking
 *     "abandoned" on an already-abandoned plan must not rewrite the date the
 *     real transition happened on.
 *   - **A missing `plan_status` line is inserted, not refused.** `source.ts`
 *     makes the key the membership test, so no card the board renders lacks it —
 *     but a file edited between the render and the click should gain the line
 *     rather than 422.
 */
export function setPlanStatus(
  content: string,
  status: PlanStatus,
  statusDate: string,
): PlanPriorityEdit {
  const bounds = fenceBounds(content);
  if (!bounds) {
    return {
      kind: "refused",
      reason: "the file has no readable frontmatter fence — refusing to edit it",
    };
  }
  const { openEnd, closeNl } = bounds;
  const openLine = content.slice(0, openEnd);
  const tail = content.slice(closeNl);
  const body = closeNl > openEnd ? content.slice(openEnd + 1, closeNl) : null;

  const cr = openLine.endsWith("\r") ? "\r" : "";
  const lines = body === null ? [] : body.split("\n");

  // The reader takes the LAST duplicate; this writer normalizes to the first —
  // but the noop test must read what the reader reads, or a duplicate fence
  // could noop on the wrong value.
  const statusLines = lines.filter((l) => PLAN_STATUS_LINE.test(l));
  const current = statusLines.length
    ? statusLines[statusLines.length - 1]!.slice("plan_status:".length).replace(/\r$/, "").trim()
    : null;
  if (current === status) return { kind: "noop" };

  const fence: string[] = [];
  let statusDone = false;
  let dateDone = false;
  for (const line of lines) {
    if (PLAN_STATUS_LINE.test(line)) {
      if (statusDone) continue;
      fence.push(`plan_status: ${status}${cr}`);
      statusDone = true;
      if (!dateDone) {
        fence.push(`status_date: ${statusDate}${cr}`);
        dateDone = true;
      }
      continue;
    }
    if (STATUS_DATE_LINE.test(line)) {
      // Replaced in place only when it precedes plan_status (dateDone false);
      // once the stamped pair is emitted, later copies are dropped.
      if (dateDone) continue;
      fence.push(`status_date: ${statusDate}${cr}`);
      dateDone = true;
      continue;
    }
    fence.push(line);
  }
  if (!statusDone) fence.unshift(`plan_status: ${status}${cr}`, `status_date: ${statusDate}${cr}`);
  else if (!dateDone) {
    // Unreachable today (the date is emitted beside the status), kept as a
    // guard should the emit order change.
    fence.push(`status_date: ${statusDate}${cr}`);
  }

  const out = openLine + (fence.length > 0 ? `\n${fence.join("\n")}` : "") + tail;
  if (out === content) return { kind: "noop" };

  const outBounds = fenceBounds(out);
  if (!outBounds || out.slice(outBounds.closeNl) !== tail) {
    return {
      kind: "refused",
      reason: "the edit would have changed bytes outside the frontmatter fence",
    };
  }
  return { kind: "changed", content: out };
}
