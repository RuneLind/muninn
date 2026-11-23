/**
 * Robust JSON extraction from LLM output.
 *
 * Tries multiple strategies in order:
 * 1. Direct JSON.parse
 * 2. Strip markdown fences then parse
 * 3. Find first { or [ to matching } or ] via brace/bracket-counting then parse
 *    (retries from next opening char if first candidate fails)
 *
 * Throws with a descriptive message if all strategies fail.
 */
export function extractJson<T>(text: string): T {
  if (!text || typeof text !== "string") {
    throw new Error("extractJson: input must be a non-empty string");
  }

  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // 2. Strip markdown fences
  const fenceStripped = text
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
  if (fenceStripped !== text) {
    try {
      return JSON.parse(fenceStripped);
    } catch {
      // continue
    }
  }

  // 3. Bracket-counting: find opening { or [ and its matching closer
  //    Supports both objects and arrays. Retries from the next opening
  //    char if the first candidate turns out to be malformed.
  //    Try whichever opening bracket appears first in the text.
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");

  const tryObject = () => extractByBracketCounting<T>(text, "{", "}");
  const tryArray = () => extractByBracketCounting<T>(text, "[", "]");

  if (firstBrace === -1 && firstBracket === -1) {
    // No brackets at all
  } else if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    const arrayResult = tryArray();
    if (arrayResult !== undefined) return arrayResult;
    const objResult = tryObject();
    if (objResult !== undefined) return objResult;
  } else {
    const objResult = tryObject();
    if (objResult !== undefined) return objResult;
    const arrayResult = tryArray();
    if (arrayResult !== undefined) return arrayResult;
  }

  throw new Error(
    `Failed to extract JSON from response (length=${text.length}): ${text.slice(0, 200)}`,
  );
}

function extractByBracketCounting<T>(
  text: string,
  openChar: string,
  closeChar: string,
): T | undefined {
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(openChar, searchFrom);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === "\\") {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            // This candidate was malformed — try next opening char
            break;
          }
        }
      }
    }

    // Move past this failed start position
    searchFrom = start + 1;
  }

  return undefined;
}
