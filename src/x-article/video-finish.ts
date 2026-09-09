/**
 * Everything an X-video capture does BETWEEN the model's answer and the ingest:
 * the envelope parse, and nothing else.
 *
 * It is a one-step tail and still a function, for the reason the concept exists:
 * a re-run calls the vertical's tail rather than deciding for itself what the
 * tail is. The TikTok twin next door has a second step (the degraded-frame-Reads
 * warn) that this one has never had — a difference worth being able to SEE in
 * one place rather than rediscovering by diffing two job bodies.
 */

import { parseSummaryResponse } from "../utils/summary-parser.ts";

export interface FinishXVideoSummaryInput {
  /** The RAW model text, envelope and all. */
  readonly raw: string;
  readonly onCategory?: (category: string) => void;
}

export interface FinishedXVideoSummary {
  readonly summary: string;
  readonly category: string;
}

export function finishXVideoSummary(input: FinishXVideoSummaryInput): FinishedXVideoSummary {
  const { category, summary } = parseSummaryResponse(input.raw);
  input.onCategory?.(category);
  return { summary, category };
}
