/**
 * The publish script's `--status --json` answer, validated and translated into
 * the shape `GET /api/wiki/felles-status` serves.
 *
 * The script (`publiser-felles-wiki.ts` in `muninn-nais`) prints exactly one
 * JSON object:
 *
 *     { "bøtte": string,
 *       "sider": [{ "relPath", "tilstand": "uendret"|"endret"|"avvist"|"mangler-lokalt",
 *                   "endredeFiler": string[], "avslag": string[], "advarsler": string[] }],
 *       "foreldreløse": string[] }
 *
 * Anything else is refused whole: the route never passes the script's stdout
 * through, so a changed script version shows up as one short error rather than
 * as a dialog that renders half a status.
 *
 * A path the script's scanner flags arrives MASKED (`[skjult sti: …]`). Such a
 * path names no page, so it is marked `masked` and the reader renders it as text.
 */

export type FellesPageState = "unchanged" | "changed" | "refused" | "missing-locally";

const STATES: Record<string, FellesPageState> = {
  uendret: "unchanged",
  endret: "changed",
  avvist: "refused",
  "mangler-lokalt": "missing-locally",
};

export interface FellesStatusPage {
  relPath: string;
  /** The path is the scanner's mask, not a page. */
  masked: boolean;
  state: FellesPageState;
  changedFiles: string[];
  refusals: string[];
  warnings: string[];
}

export interface FellesStatusOrphan {
  path: string;
  masked: boolean;
}

export interface FellesStatus {
  bucket: string;
  /** In the script's order (sorted by object name). */
  pages: FellesStatusPage[];
  /** Objects in the bucket with no page in the local wiki. */
  orphans: FellesStatusOrphan[];
  /** How many pages are `changed` — what «Felles: N changed» shows. */
  changed: number;
}

export type FellesStatusParse = { ok: true; status: FellesStatus } | { ok: false; reason: string };

const MASK_PREFIX = "[skjult sti";

export function isMaskedPath(p: string): boolean {
  return p.startsWith(MASK_PREFIX);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseFellesStatus(stdout: string): FellesStatusParse {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, reason: "the output is not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "the output is not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o["bøtte"] !== "string") return { ok: false, reason: "bøtte is not a string" };
  if (!Array.isArray(o.sider)) return { ok: false, reason: "sider is not an array" };
  if (!isStringArray(o["foreldreløse"])) return { ok: false, reason: "foreldreløse is not a string array" };

  const pages: FellesStatusPage[] = [];
  for (const [i, s] of o.sider.entries()) {
    if (!s || typeof s !== "object") return { ok: false, reason: `sider[${i}] is not an object` };
    const p = s as Record<string, unknown>;
    if (typeof p.relPath !== "string" || !p.relPath) return { ok: false, reason: `sider[${i}].relPath is not a string` };
    const state = typeof p.tilstand === "string" ? STATES[p.tilstand] : undefined;
    if (!state) return { ok: false, reason: `sider[${i}].tilstand is not a known state` };
    for (const key of ["endredeFiler", "avslag", "advarsler"]) {
      if (!isStringArray(p[key])) return { ok: false, reason: `sider[${i}].${key} is not a string array` };
    }
    pages.push({
      relPath: p.relPath,
      masked: isMaskedPath(p.relPath),
      state,
      changedFiles: p.endredeFiler as string[],
      refusals: p.avslag as string[],
      warnings: p.advarsler as string[],
    });
  }
  return {
    ok: true,
    status: {
      bucket: o["bøtte"],
      pages,
      orphans: o["foreldreløse"].map((path) => ({ path, masked: isMaskedPath(path) })),
      changed: pages.filter((p) => p.state === "changed").length,
    },
  };
}
