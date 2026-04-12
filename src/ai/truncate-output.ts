/**
 * Serializes and caps tool call outputs for storage on trace spans.
 *
 * Used by all three AI connectors (claude-cli stream parser, copilot-sdk,
 * openai-compat) so large retrieval results don't bloat the traces table.
 */

/** Maximum bytes (UTF-8) stored for a single tool call output. */
export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024; // 16 KB

/**
 * Envelope used when a raw tool output exceeds {@link TOOL_OUTPUT_MAX_BYTES}.
 *
 * Downstream consumers (export scripts, dashboard) can detect truncation by
 * checking for `_truncated === true` after JSON-parsing the stored string.
 */
export interface TruncationEnvelope {
  _truncated: true;
  _originalBytes: number;
  head: string;
}

/**
 * Serialize and cap a tool output for storage on a trace span.
 *
 * - Strings pass through if under the cap
 * - Other values are JSON-stringified
 * - Over-cap payloads are replaced with a {@link TruncationEnvelope}
 * - Unserializable values (e.g. circular references) yield `undefined`
 */
export function truncateOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  // Single UTF-8 encode: use the buffer for both length check and slicing.
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= TOOL_OUTPUT_MAX_BYTES) return text;
  const head = buf.subarray(0, TOOL_OUTPUT_MAX_BYTES).toString("utf8");
  const envelope: TruncationEnvelope = { _truncated: true, _originalBytes: buf.length, head };
  return JSON.stringify(envelope);
}
