/**
 * The work map's kind, a property of the wiki: `.wiki-reader.json`
 * `workMap: {"kind": "themes"}`. Absent (or no file) means `work`, so a wiki
 * that declares nothing runs today's efforts map byte-identically. Zod-free,
 * so `store.ts` and the client bundle can read it.
 */

export const WORK_MAP_KINDS = ["work", "themes"] as const;
export type WorkMapKind = (typeof WORK_MAP_KINDS)[number];

/** The `workMap` block of `.wiki-reader.json`. A bad block or kind warns and
 *  reads as `work`. */
export function parseWorkMapReaderConfig(raw: unknown): { kind: WorkMapKind; warning?: string } {
  if (raw === undefined) return { kind: "work" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "work", warning: "is not an object — reading it as kind work" };
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === undefined) return { kind: "work" };
  if (typeof kind === "string" && (WORK_MAP_KINDS as readonly string[]).includes(kind)) return { kind: kind as WorkMapKind };
  return { kind: "work", warning: `kind ${JSON.stringify(kind)} is not one of ${WORK_MAP_KINDS.join(", ")} — reading it as work` };
}

/** The kind from `.wiki-reader.json`'s text (null: no file). Malformed JSON
 *  reads as `work`, as the store's parser degrades it. */
export function workMapKindFromReaderText(text: string | null): WorkMapKind {
  if (text === null) return "work";
  try {
    const obj = JSON.parse(text) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "work";
    return parseWorkMapReaderConfig((obj as Record<string, unknown>).workMap).kind;
  } catch {
    return "work";
  }
}
