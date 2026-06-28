/**
 * Shared category list + summary-response parser for the YouTube and X-article
 * summarizers. Both backends prompt Claude for the same
 * `CATEGORY:` / `SUMMARY:` envelope, so the valid-category set and the parser
 * live here instead of being duplicated per backend.
 */

export const VALID_CATEGORIES = [
  "ai/claude-code", "ai/claude", "ai/openclaw", "ai/general", "ai/rag",
  "health", "tech", "career", "parenting", "entertainment", "coding",
] as const;

/**
 * The `ai/*` subset of {@link VALID_CATEGORIES}. The `anthropic-summaries`
 * collection only accepts these (Huginn's ingest allowlist is `ai/*`), so the
 * Anthropic summarizer offers Claude this narrower list and clamps anything
 * outside it back to `ai/general`.
 */
export const AI_CATEGORIES = VALID_CATEGORIES.filter((c) =>
  c.startsWith("ai/"),
) as readonly string[];

/**
 * Parse a summarizer response of the form:
 *
 *   CATEGORY: <category>
 *
 *   SUMMARY:
 *   <markdown body>
 *
 * Falls back to `ai/general` when the category line is missing or invalid.
 * Exported for testing.
 */
export function parseSummaryResponse(text: string): { category: string; summary: string } {
  const lines = text.split("\n");
  let category = "ai/general";
  let summaryStartIndex = 0;

  // Find CATEGORY line (scan first 5 lines in case of preamble)
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const match = lines[i]!.match(/^CATEGORY:\s*(.+)$/i);
    if (match) {
      category = match[1]!.trim().toLowerCase();
      summaryStartIndex = i + 1;
      break;
    }
  }

  // Find SUMMARY: marker
  for (let i = summaryStartIndex; i < lines.length; i++) {
    if (/^SUMMARY:$/i.test(lines[i]!.trim())) {
      summaryStartIndex = i + 1;
      break;
    }
  }

  const summary = lines.slice(summaryStartIndex).join("\n").trim();

  // Validate category
  if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
    category = "ai/general";
  }

  return { category, summary };
}
