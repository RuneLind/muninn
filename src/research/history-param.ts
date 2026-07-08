/**
 * Shared parser for the compact `history` query param that both the Research
 * page (`/api/research/ask`) and the wiki Ask tab (`/api/wiki/ask`) replay on a
 * follow-up: a JSON array of `{ q, a }` prior turns (oldest→newest). The Q&A is
 * stateless on the server, so the running conversation lives entirely in this
 * param. Malformed/oversized input degrades to single-shot (empty history)
 * rather than erroring — a follow-up that loses context still answers standalone.
 *
 * Lifted out of research-routes.ts so the wiki route can reuse it without a
 * route-module import cycle (wiki-routes ↔ research-routes).
 */

import { MAX_HISTORY_TURNS, type ResearchTurn } from "./answer.ts";

// Loose upper bounds for the replayed `history` param — these only cap untrusted
// input size, they are NOT the synthesis budget (that is the binding cap in
// renderHistoryBlock, answer.ts). Kept generous (≥ that budget) so bumping the
// answer.ts budget actually takes effect rather than silently clamping here.
const HISTORY_PARAM_MAX_CHARS = 20_000; // whole param; rejected before JSON.parse
const HISTORY_QUESTION_CHARS = 1_000;
const HISTORY_ANSWER_CHARS = 4_000;

export function parseResearchHistory(raw: string | undefined): ResearchTurn[] {
  if (!raw || raw.length > HISTORY_PARAM_MAX_CHARS) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is { q: string; a: string } =>
          !!t && typeof t.q === "string" && typeof t.a === "string" && t.q.trim().length > 0,
      )
      .slice(-MAX_HISTORY_TURNS)
      .map((t) => ({
        question: t.q.slice(0, HISTORY_QUESTION_CHARS),
        answer: t.a.slice(0, HISTORY_ANSWER_CHARS),
      }));
  } catch {
    return [];
  }
}
