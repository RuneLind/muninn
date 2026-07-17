import { extractJson } from "../ai/json-extract.ts";

/**
 * A distilled durable memory produced from a wiki Ask/Explain Q&A turn by the
 * "Remember this" button. `content` is the fact worth keeping, `summary` is the
 * ≤120-char search line stored on the memory row, `tags` are 1–3 lowercase topics
 * (the route prepends the stable `wiki-note` + wiki-name tags before saving).
 */
export interface DistilledMemory {
  content: string;
  summary: string;
  tags: string[];
}

/** How much of the (possibly long) answer we feed the distiller — the fact lives
 *  in the opening; the tail is padding for a small extraction call. */
export const REMEMBER_ANSWER_TRUNCATE = 2000;

/** Defensive cap on the stored search line (the prompt already asks for ≤120). */
export const REMEMBER_SUMMARY_MAX = 120;

/**
 * Build the Haiku prompt that distills a wiki Q&A turn into a durable memory.
 * The instruction is deliberately "what the reader LEARNED" (a standalone fact),
 * not "the user asked X" — memories are recalled out of context, so a fact phrased
 * as an interaction ("the user wanted to know…") is noise. The answer is truncated
 * to {@link REMEMBER_ANSWER_TRUNCATE} chars before prompting.
 */
export function buildDistillPrompt(input: {
  wikiName: string;
  question: string;
  answer: string;
}): string {
  const question = (input.question || "").trim();
  const answer = (input.answer || "").trim().slice(0, REMEMBER_ANSWER_TRUNCATE);
  return `You distill a knowledge-wiki Q&A into ONE durable fact worth remembering for later.

The reader was browsing the "${input.wikiName}" wiki and asked a question; an assistant answered from the wiki's sources. Capture the DURABLE FACT the reader learned — a standalone statement that stands on its own out of context. Do NOT phrase it as an interaction ("the user asked…", "the answer explained…"); state the fact directly.

Produce ONLY valid JSON (no markdown fences), shaped:
{"content": "1-2 sentence durable fact the reader learned", "summary": "≤120-char one-line search summary", "tags": ["topic1", "topic2"]}

- content: 1-2 sentences, the fact itself (not a description of the exchange).
- summary: a single line, ≤120 characters, for search.
- tags: 1-3 lowercase topic keywords.

Question: """
${question}
"""

Answer: """
${answer}
"""`;
}

/**
 * Tolerant parse of the distiller's raw output (mirrors the extractor's
 * `extractJson` discipline): strip fences / locate the JSON object, then validate
 * shapes. Returns null on any failure — the route then declines to save rather
 * than persisting a verbatim fallback. `content` and `summary` are required
 * non-empty strings; `tags` defaults to [] and is coerced to ≤3 lowercase
 * non-empty strings; `summary` is capped at {@link REMEMBER_SUMMARY_MAX}.
 */
export function parseDistillResult(raw: string): DistilledMemory | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = extractJson<unknown>(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  const summaryRaw = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!content || !summaryRaw) return null;

  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 3)
    : [];

  return {
    content,
    summary: summaryRaw.slice(0, REMEMBER_SUMMARY_MAX),
    tags,
  };
}

/**
 * Build the "reader's saved wiki notes" background block injected into the Ask /
 * Explain synthesis system prompt (PR C). `memories` are the tag-scoped
 * (`wiki-note`) hits from the hybrid memory search — so the honest "saved from
 * earlier wiki reading" framing holds and general chat memories never enter here.
 *
 * The framing is deliberate: notes are BACKGROUND, not a citable source. The model
 * is told not to cite them as `[n]` and to trust the numbered sources on conflict,
 * so a stale/wrong saved note can't override the retrieved corpus.
 *
 * Returns null for an empty list (⇒ the route leaves the prompt unchanged); blank
 * `content` rows are dropped, and an all-blank list also yields null. Order is
 * preserved (the caller's relevance order).
 */
export function buildSavedNotesBlock(memories: { content: string }[]): string | null {
  const lines = (memories ?? [])
    .map((m) => (typeof m.content === "string" ? m.content.trim() : ""))
    .filter(Boolean)
    .map((content) => `- ${content}`);
  if (lines.length === 0) return null;
  return (
    "READER'S SAVED WIKI NOTES (notes the reader explicitly saved from earlier wiki reading —\n" +
    "background only, NOT a citable source; do not cite these as [n]; if they conflict with\n" +
    "the numbered sources, trust the sources):\n" +
    lines.join("\n")
  );
}
