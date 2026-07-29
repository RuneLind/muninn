/**
 * Pure (DOM-free, server-import-free) helpers for the fact-check **Integrate into
 * article** flow — the counterpart to `src/wiki/integrate-edits.ts`.
 *
 * The one thing that must be shared verbatim between the server (which builds the
 * integrate prompt from the PERSISTED answer markdown) and the bundled client
 * (which previews the proposed edits per claim) is the answer-block parser. It
 * lives here — the `synthesisTopicKey` precedent in `wiki-atlas-semantic.ts` —
 * so there is ONE implementation and no hand-mirror to drift.
 *
 * Kept free of every server-only import (no node builtins, no `src/wiki/*`), so
 * `src/wiki/integrate-edits.ts` imports THIS module and never the reverse.
 */

/**
 * The four verdict markers, matching `VERDICT_RE` in `factcheck-sse.ts`. The VS16
 * (U+FE0F) is OPTIONAL on ALL FOUR — the persisted answer is the raw model blocks
 * with no normalization pass, and models emit both the bare ⚠ (U+26A0) and the
 * VS16-suffixed ❌️/✅️/❓️ that most emoji keyboards produce. A single missed
 * variant makes the whole claim invisible to the integrate flow, which is why the
 * separator is likewise tolerant (em dash / en dash / hyphen / colon), `Claim` is
 * matched case-insensitively, and the title is optional.
 *
 * The `###` anchor is deliberately NOT loosened: the heading level is a fixed
 * prompt contract (`factcheckVerifySystemPrompt`), and accepting `##`/`####` would
 * start matching prose that merely mentions a claim.
 */
const CLAIM_HEADING_RE =
  /^###\s*(✅️?|⚠️?|❌️?|❓️?)\s*Claim\s+(\d+)\s*\/\s*(\d+)\s*(?:[—–:-]\s*(.*))?$/iu;

/** One claim anchor derived SERVER-SIDE from the persisted fact-check answer. */
export interface FactcheckClaimAnchor {
  /** `n` from the `Claim n/m` heading (1-based, as the model wrote it). */
  index: number;
  /** Verdict emoji, normalized to the VS16 form for ⚠️. */
  verdict: string;
  /** Short claim title from the heading (empty when the heading carried none). */
  title: string;
  /** The whole block — heading line through the text before the next `###`. */
  block: string;
}

/** Normalize verdict spelling to ONE form downstream can compare against: strip
 *  every optional VS16, then re-add it on ⚠ (whose canonical form here IS ⚠️,
 *  matching `INTEGRATE_VERDICTS`). */
function normalizeVerdict(v: string): string {
  const bare = v.replace(/\uFE0F/g, "");
  return bare === "⚠" ? "⚠️" : bare;
}

/**
 * Split a persisted fact-check answer into its per-claim verdict blocks. The
 * `### <emoji> Claim n/m — <title>` heading is a fixed prompt contract
 * (`factcheckVerifySystemPrompt` in `src/wiki/factcheck-context.ts`), so this is
 * a heading scan, not a heuristic. Text before the first heading (the compose
 * lede) is ignored. Never throws; a malformed answer yields `[]`.
 */
export function parseFactcheckClaims(answer: string): FactcheckClaimAnchor[] {
  if (!answer || typeof answer !== "string") return [];
  const lines = answer.split("\n");
  const anchors: FactcheckClaimAnchor[] = [];
  let current: FactcheckClaimAnchor | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current) anchors.push({ ...current, block: buffer.join("\n").trim() });
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    const m = line.trim().match(CLAIM_HEADING_RE);
    if (m) {
      flush();
      current = {
        index: Number(m[2]),
        verdict: normalizeVerdict(m[1]!),
        title: (m[4] ?? "").trim(),
        block: "",
      };
      buffer = [line];
      continue;
    }
    // A non-claim `###` heading closes the current block without opening one.
    if (current && /^###\s/.test(line.trim())) {
      flush();
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return anchors;
}

/** Verdicts the integrate flow acts on (v1): contradicted + partly supported.
 *  ✅ and ❓ blocks are never turned into edits. */
export const INTEGRATE_VERDICTS = ["❌", "⚠️"] as const;

/** The correctable subset of {@link parseFactcheckClaims} — ❌ and ⚠️ only. */
export function correctableClaims(answer: string): FactcheckClaimAnchor[] {
  const wanted = new Set<string>(INTEGRATE_VERDICTS);
  return parseFactcheckClaims(answer).filter((c) => wanted.has(c.verdict));
}
