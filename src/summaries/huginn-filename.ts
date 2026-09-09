/**
 * huginn's `sanitize_filename`, ported — the rule that decides which FILE an
 * ingest writes.
 *
 * huginn's summary ingest takes no document id: it keys the path on
 * `<category>/<sanitize_filename(title)>.md`. A re-run reads the title back out
 * of the stored doc id and posts it again, so the whole path rests on that
 * function being IDEMPOTENT for the stem it reads — and where it is not, the
 * POST writes a SECOND document instead of replacing the one it re-ran.
 *
 * The original (`main/utils/filename.py`, read 2026-09-09):
 *
 * ```python
 * name = re.sub(r'[<>:"/\\|?*]', '_', name)
 * name = re.sub(r'[\s_]+', ' ', name).strip()
 * if len(name) > 200:
 *     name = name[:200]
 * return name or "Untitled"
 * ```
 *
 * Three details are where a port goes wrong, and each is measured against the
 * real interpreter by `huginn-filename.test.ts`:
 *
 *  - **`_` is in the collapse class.** The first pass turns every unsafe
 *    character into `_`, and the second turns any run of whitespace-or-
 *    underscore into ONE SPACE. So a stem carrying a literal `_`, or two spaces
 *    in a row, is not a fixed point — it comes back a different name. Measured
 *    over the live corpus 2026-09-09: 59 stems carry one.
 *  - **Python's `\s` is not JavaScript's.** Python matches `\x1c`–`\x1f` and
 *    `\x85` (NEL) and does NOT match U+FEFF; JavaScript is the exact opposite
 *    on those five. The class below is Python's 29 code points, spelled out —
 *    `\s` alone would call a stem carrying a NEL a fixed point that huginn then
 *    renames, and refuse a stem carrying a BOM that huginn would leave alone.
 *  - **The strip and the truncation are Python's units.** `.strip()` is applied
 *    AFTER the collapse, so only spaces are left to strip — `String.trim()`
 *    would additionally eat a leading U+FEFF that Python keeps. And `len()`
 *    counts CODE POINTS, so a stem of 200 astral characters is 200 to Python
 *    and 400 to `String.length`.
 *
 * Import-free and pure, so the route, the tests and any later reader share one
 * copy rather than a second spelling of huginn's rule.
 */

/** Exactly the characters `re.sub(r'[<>:"/\\|?*]', …)` replaces. */
const UNSAFE_RE = /[<>:"/\\|?*]/g;

/**
 * `[\s_]` as PYTHON reads it: its 29 whitespace code points plus the
 * underscore. Not `[\s_]`, which is JavaScript's 25 and diverges on five.
 */
const COLLAPSE_RE =
  /[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000_]+/g;

/** huginn truncates a name past this many CODE POINTS. */
export const HUGINN_FILENAME_MAX = 200;

/** What `sanitize_filename` answers for a name that sanitizes to nothing. */
export const HUGINN_FILENAME_FALLBACK = "Untitled";

/** huginn's `sanitize_filename`, character for character. */
export function sanitizeFilenameLikeHuginn(name: string): string {
  const replaced = name.replace(UNSAFE_RE, "_");
  // The collapse has already turned every whitespace character into a space, so
  // stripping spaces IS Python's `.strip()` here — and unlike `String.trim()` it
  // leaves a U+FEFF alone, exactly as Python does.
  const collapsed = replaced.replace(COLLAPSE_RE, " ").replace(/^ +| +$/g, "");
  // `len()`/`[:200]` are code points, not UTF-16 units.
  const points = Array.from(collapsed);
  const truncated = points.length > HUGINN_FILENAME_MAX
    ? points.slice(0, HUGINN_FILENAME_MAX).join("")
    : collapsed;
  return truncated || HUGINN_FILENAME_FALLBACK;
}
