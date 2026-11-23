/**
 * The work map's kind, a property of the wiki: `.wiki-reader.json`
 * `workMap: {"kind": "themes"}`. Absent (or no file) means `work`, so a wiki
 * that declares nothing runs today's efforts map byte-identically. Zod-free,
 * so `store.ts` can read it.
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

/** The run's kind from `.wiki-reader.json`'s text (null: no file). Fails
 *  closed: the reader degrades a bad block to `work`, but a run that guessed
 *  `work` on a themes wiki would overwrite its map. No file, or no `workMap`
 *  key, is `work`; unparseable JSON, a top level that is not an object, or a
 *  `workMap` that is not `{kind: "work" | "themes"}` is an error. A leading
 *  BOM is dropped, as `Bun.file().text()` drops it for the reader. */
export function workMapKindFromReaderText(text: string | null): { ok: true; kind: WorkMapKind } | { ok: false; reason: string } {
  if (text === null) return { ok: true, kind: "work" };
  let obj: unknown;
  try {
    obj = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, reason: ".wiki-reader.json is not valid JSON" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: ".wiki-reader.json is not a JSON object" };
  const raw = (obj as Record<string, unknown>).workMap;
  if (raw === undefined) return { ok: true, kind: "work" };
  const kind = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).kind : undefined;
  if (typeof kind === "string" && (WORK_MAP_KINDS as readonly string[]).includes(kind)) return { ok: true, kind: kind as WorkMapKind };
  return { ok: false, reason: `.wiki-reader.json workMap is ${JSON.stringify(raw)}, not {"kind": ${WORK_MAP_KINDS.map((k) => `"${k}"`).join(" | ")}}` };
}
