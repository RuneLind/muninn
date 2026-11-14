/**
 * `.wiki-reader.json`'s `whatsNew` block: which digest the start view's What's
 * new card builds. `default` is the 14-day bullet digest; `batch` lays out the
 * newest sync entries by area (`digest-batch.ts`). Its own module, with no
 * imports, so `store.ts` can read it without importing the digest code.
 */

export const WHATS_NEW_MODES = ["default", "batch"] as const;
export type WhatsNewMode = (typeof WHATS_NEW_MODES)[number];

/** Absent ⇒ `default`. A block that is not an object, or a `mode` that is not
 *  a known mode, warns and reads as `default`. */
export function parseWhatsNewReaderConfig(raw: unknown): { mode: WhatsNewMode; warning?: string } {
  if (raw === undefined) return { mode: "default" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { mode: "default", warning: "is not an object — reading it as mode default" };
  }
  const mode = (raw as Record<string, unknown>).mode;
  if (mode === undefined) return { mode: "default" };
  if (typeof mode === "string" && (WHATS_NEW_MODES as readonly string[]).includes(mode)) {
    return { mode: mode as WhatsNewMode };
  }
  return {
    mode: "default",
    warning: `mode ${JSON.stringify(mode)} is not one of ${WHATS_NEW_MODES.join(", ")} — reading it as default`,
  };
}
