/**
 * The two `Was:` originals the approved creatine fixture records — the pre-edit
 * prose of claims 4 (❌) and 7 (⚠️) on `factcheck-creatine-original.mdx`.
 *
 * Shared by the two acceptance tests that both need them, byte-identical:
 *  - `factcheck-appendix.test.ts` passes them as `originals` and asserts the
 *    appendix reproduces the approved block byte for byte;
 *  - `factcheck-annotate-acceptance.test.ts` uses them as the corrections' `old`
 *    (the correction is exactly the replacement of this text).
 * Hand-typed in both files, they were one transcription slip away from an
 * unexplainable byte-exactness failure in whichever file was edited second.
 */

export const CREATINE_ORIGINALS = new Map<number, string>([
  [4, "Roughly 1kg of additional lean muscle mass gained versus resistance training alone."],
  [
    7,
    "Notably, the cognitive benefit appears strongest at standard **maintenance** doses rather " +
      "than during the higher-dose loading phase, suggesting the muscle and brain effects may not " +
      "scale with dose in the same way.",
  ],
]);
