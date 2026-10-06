/**
 * The saved shape of a transcript check (`summary_factchecks.transcript_claims`)
 * and its reader. Its own module, free of the router import graph, because the
 * DB layer maps rows through {@link parseSavedTranscriptCheck}.
 */

import type { HaikuBackend } from "../ai/haiku-direct.ts";

export const TRANSCRIPT_VERDICTS = ["supported", "not in transcript", "contradicts transcript"] as const;
export type TranscriptVerdict = (typeof TRANSCRIPT_VERDICTS)[number];

/** One claim's transcript verdict as saved. */
export interface TranscriptClaimVerdict {
  index: number;
  verdict: TranscriptVerdict;
  note: string;
  /**
   * Only on a `not in transcript` verdict over a CUT transcript: whether the
   * model judged the claim's subject to lie in the part that was not sent.
   */
  beyondCut?: boolean;
}

export interface TranscriptCut {
  truncated: boolean;
  /** Characters sent. */
  keptChars: number;
  /** Characters the transcript has. */
  totalChars: number;
}

/** What `transcript_claims` holds. */
export interface SavedTranscriptCheck {
  claims: TranscriptClaimVerdict[];
  cut: TranscriptCut;
  model: string;
  /** The backend that answered (the router's own report); absent on checks saved before it was recorded. */
  backend?: HaikuBackend;
  botName: string;
  /** Epoch ms. */
  checkedAt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * A stored `transcript_claims` value as a {@link SavedTranscriptCheck}, or `null`
 * when its shape is not one: the column is JSONB, so a hand edit or an older
 * writer can leave anything there, and the renderer reads every field.
 */
export function parseSavedTranscriptCheck(value: unknown): SavedTranscriptCheck | null {
  if (!isRecord(value) || !Array.isArray(value.claims) || !isRecord(value.cut)) return null;
  const claims: TranscriptClaimVerdict[] = [];
  for (const c of value.claims) {
    if (!isRecord(c) || typeof c.index !== "number" || !Number.isInteger(c.index)) return null;
    if (typeof c.verdict !== "string" || !(TRANSCRIPT_VERDICTS as readonly string[]).includes(c.verdict)) return null;
    if (typeof c.note !== "string") return null;
    if (c.beyondCut !== undefined && typeof c.beyondCut !== "boolean") return null;
    claims.push({
      index: c.index,
      verdict: c.verdict as TranscriptVerdict,
      note: c.note,
      ...(typeof c.beyondCut === "boolean" ? { beyondCut: c.beyondCut } : {}),
    });
  }
  const { truncated, keptChars, totalChars } = value.cut;
  if (typeof truncated !== "boolean" || !isCount(keptChars) || !isCount(totalChars) || (truncated && totalChars === 0)) return null;
  if (typeof value.model !== "string" || typeof value.botName !== "string" || typeof value.checkedAt !== "number") return null;
  return {
    claims,
    cut: { truncated, keptChars, totalChars },
    model: value.model,
    ...(typeof value.backend === "string" ? { backend: value.backend as HaikuBackend } : {}),
    botName: value.botName,
    checkedAt: value.checkedAt,
  };
}
