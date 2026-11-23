/**
 * Lint check 27, `log-kind`: a `log.md` entry whose kind is outside the wiki's
 * own list (warning). An entry header is `## [YYYY-MM-DD] <kind> | <title>`.
 *
 * The list is `.wiki-reader.json` `logKinds`: `{ "kinds": [...], "since":
 * "YYYY-MM-DD" }`. `since` is optional and leaves older entries alone, since the
 * log is append-only and its history is not rewritten. Every line is read, a
 * line inside a code fence included. A wiki that declares no
 * list is not checked. Why: melosys-kode-wiki's log held about 100 kinds for
 * 711 entries on 2026-11-11, with repo names and three spellings of one act
 * among them, so the kind could not filter anything.
 */

export const LOG_KIND_LINT_CHECKS = ["log-kind"] as const;

export interface LogKindsConfig {
  kinds: string[];
  /** Entries dated before this day are not checked. */
  since?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A lower-case word: cased lower-case letters (`spørring`; no uncased script,
 *  no combining mark, so write `å` precomposed), digits, `-` and `+`. */
const KIND_RE = /^[\p{Ll}\p{N}][\p{Ll}\p{N}+-]*$/u;
const ENTRY_RE = /^## \[(\d{4}-\d{2}-\d{2})\]\s+(.*)$/;

/** `.wiki-reader.json` `logKinds`. A malformed block warns and is null; a bad entry warns and is dropped. */
export function parseLogKinds(value: unknown): { config: LogKindsConfig | null; warnings: string[] } {
  if (value === undefined) return { config: null, warnings: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { config: null, warnings: ["must be an object {kinds, since?} — ignoring it"] };
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.kinds)) return { config: null, warnings: ["kinds must be a list of strings — ignoring the block"] };
  const warnings: string[] = [];
  const kinds: string[] = [];
  for (const k of obj.kinds) {
    if (typeof k === "string" && KIND_RE.test(k)) kinds.push(k);
    else warnings.push(`kinds entry ${JSON.stringify(k)} is not a lower-case word (letters, digits, "-", "+") — dropping it`);
  }
  if (kinds.length === 0) return { config: null, warnings: [...warnings, "kinds names no usable kind — ignoring the block"] };
  if (obj.since === undefined) return { config: { kinds }, warnings };
  if (typeof obj.since === "string" && DAY_RE.test(obj.since)) return { config: { kinds, since: obj.since }, warnings };
  return { config: { kinds }, warnings: [...warnings, `since ${JSON.stringify(obj.since)} is not YYYY-MM-DD — checking every entry`] };
}

export interface LogKindFinding {
  line: number;
  kind: string;
  message: string;
}

/** The entries of a `log.md` text whose kind the config does not list. */
export function checkLogKinds(content: string, cfg: LogKindsConfig): LogKindFinding[] {
  const known = new Set(cfg.kinds);
  const list = `.wiki-reader.json logKinds (${cfg.kinds.join(", ")})`;
  const out: LogKindFinding[] = [];
  // No code-fence rule: a log holds entries, and one stray fence line would
  // hide every entry after it.
  content.split(/\r?\n/).forEach((text, i) => {
    const m = ENTRY_RE.exec(text);
    if (!m) return;
    const [, day, rest] = m;
    if (cfg.since && day! < cfg.since) return;
    const bar = rest!.indexOf(" | ");
    const kind = (bar < 0 ? rest! : rest!.slice(0, bar)).trim();
    if (bar < 0) out.push({ line: i + 1, kind, message: `log entry has no "<kind> | <title>" after its date; kinds: ${list}` });
    else if (!known.has(kind)) out.push({ line: i + 1, kind, message: `log kind "${kind}" is not in ${list}` });
  });
  return out;
}
