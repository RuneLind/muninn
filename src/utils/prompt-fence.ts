/**
 * The two prompt-fence primitives every one-shot surface needs, in one place.
 *
 * Both shipped as byte copies: `stripWrappingFence` in `src/share/prompt.ts` and
 * `src/jira/prompt.ts`, and `neutralizePromptFence` in `factcheck-retry-sse.ts`
 * with `neutralizeShareFence`/`neutralizeJiraFence` as further copies. Two copies
 * of a rule are two rules — the share/jira pair had already drifted nowhere only
 * because neither had been touched since; the ```markdown gap below existed in
 * both at once and had to be found twice.
 *
 * Dependency-free by contract (it sits in `src/utils/`), so a browser-bundled
 * caller can import it without dragging a route graph along.
 */

/**
 * Collapse any `"""` run to a single quote.
 *
 * Prompts in this codebase fence interpolated fields between `"""` markers, so a
 * field carrying its own fence can close the block early and have whatever
 * follows read as instructions. The rule everywhere: keep the readable content,
 * destroy the structural marker. Idempotent, since the result no longer matches.
 */
export function neutralizePromptFence(text: string): string {
  return text.replace(/"{3,}/g, '"');
}

/**
 * Info strings that make a fence a WRAPPER rather than content.
 *
 * The distinction is the whole reason this is an allow-list and not "any info
 * string": a ```` ```ts ```` or ```` ```kotlin ```` block may genuinely BE the
 * output (share posts a code snippet; a Jira task at `Full` depth carries one
 * excerpt), and unwrapping it splices the prose out of the block — the same
 * corruption the interior check below exists to prevent. A markdown/plaintext tag
 * cannot mean that: the content it announces is markdown, which is what the
 * caller asked for in the first place.
 */
const WRAPPER_INFO_STRINGS = new Set(["", "markdown", "md", "mdx", "text", "txt", "plaintext", "plain"]);

/**
 * Drop a fence that wraps the WHOLE text.
 *
 * Every one-shot instruction in this codebase says "no wrapping code fence", and
 * a model that ignores it does not produce slightly-off output — it produces a
 * post/task that renders as one syntax-highlighted block with the markdown
 * showing. Cheaper to undo here than to explain.
 *
 * Three rules, each of which was a bug in the copies this replaces:
 *
 *  1. **The info string is read, and allow-listed** (see {@link WRAPPER_INFO_STRINGS}).
 *     Both copies required it to be EMPTY, so ```` ```markdown ```` — the single
 *     most likely wrapper a model emits when told "markdown only" — sailed
 *     straight through into the reader's clipboard.
 *  2. **The closer only has to be at least as long as the opener**, CommonMark's
 *     own rule. Both copies used a backreference, so a ``` opener closed by a
 *     ````` line did not match and the wrapper survived.
 *  3. **The interior check is what makes "first line + last line" mean ONE
 *     fence.** The outer match is greedy by construction (`$` pins the closer to
 *     the last line), so a text that merely BEGINS and ENDS with a code block
 *     matched first-opener → last-closer and had BOTH of its real fences
 *     stripped. A run of the same marker at the start of an interior line, at
 *     least as long as the opener, disqualifies the match — by CommonMark's rule
 *     that run IS a closer, so the two lines matched are two separate blocks.
 *
 * The tradeoff is deliberate and one-directional: a genuine whole-text wrapper
 * whose interior holds a same-marker run is left unstripped. Under-stripping
 * costs one visible fence the reader can delete; over-stripping silently splices
 * prose into code.
 */
export function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  const m = /^(`{3,}|~{3,})([^\n]*)\r?\n([\s\S]*)\r?\n([`~]{3,})[ \t]*$/.exec(trimmed);
  if (!m) return trimmed;
  const opener = m[1]!;
  const rawInfo = m[2]!;
  const interior = m[3]!;
  const closer = m[4]!;
  const marker = opener[0]!;

  // CommonMark: a backtick fence's info string may not contain a backtick. Without
  // this a prose line of inline code reads as an opener that never closes.
  if (marker === "`" && rawInfo.includes("`")) return trimmed;
  if (!WRAPPER_INFO_STRINGS.has(rawInfo.trim().toLowerCase())) return trimmed;
  if (closer[0] !== marker || closer.length < opener.length) return trimmed;

  // `[<char>]` rather than an escape: `\`` is an identity escape a future
  // `u`-flagged rewrite would reject, and a char class needs no escaping here.
  const innerCloser = new RegExp(`(?:^|\\n)[ \\t]{0,3}[${marker}]{${opener.length},}`);
  if (innerCloser.test(interior)) return trimmed;
  return interior.trim();
}
