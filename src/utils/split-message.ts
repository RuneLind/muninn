/**
 * Split text into chunks that fit within maxLength,
 * trying to break at newlines or spaces for readability.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  // A cap below 1 cuts nothing off and would loop forever.
  if (!(maxLength >= 1)) throw new RangeError(`splitMessage: maxLength must be at least 1, got ${maxLength}`);
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
      // Never cut between a surrogate pair: half an emoji is not valid text. At a
      // cap of 1 the pair cannot fit whole, and stepping back to 0 would never end.
      if (splitIndex > 1 && /[\uD800-\uDBFF]/.test(remaining[splitIndex - 1] ?? "")) splitIndex--;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
