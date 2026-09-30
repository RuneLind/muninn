// Pure, so the Haiku router can use it without importing the Copilot SDK.

/**
 * Resolve a configured model id against Copilot's model catalog.
 *
 * Anthropic/CLI configs use dash version suffixes (claude-opus-4-6) while
 * Copilot's catalog uses dots (claude-opus-4.6). An unknown id is NOT an
 * error in Copilot — the service silently falls back to its default model —
 * so map what we can and flag what we can't.
 */
export function resolveCopilotModelId(
  requested: string,
  available: string[],
): { id: string; mapped: boolean; known: boolean } {
  if (available.includes(requested)) return { id: requested, mapped: false, known: true };
  // Full Anthropic ids carry a date suffix (claude-haiku-4-5-20251001) that
  // Copilot's catalog never has — strip it before the dash→dot rewrite.
  const undated = requested.replace(/-\d{8}$/, "");
  const dotted = undated.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  if (dotted !== requested && available.includes(dotted)) {
    return { id: dotted, mapped: true, known: true };
  }
  return { id: requested, mapped: false, known: false };
}
