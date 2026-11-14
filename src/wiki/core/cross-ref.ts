/**
 * Cross-page ids (living facts PR 4): `D9 i [[plans/x]]`, `D3, D4 og Q-16 på
 * [[y]]`. The pure half both sides share — the id token, the run grammar, the
 * endpoint's id list and its answer shape. DOM-free and dependency-free, so
 * the reader's bundle and `GET /api/wiki/ref` read the same rules.
 */

/** The wrapper a candidate run sits in until `GET /api/wiki/ref` answers:
 *  the in-page linker (`linkRefs`) skips it, so no id in it is linked to the
 *  citing page's own item. */
export const XREF_RUN_CLASS = "wiki-xref-run";
/** A resolved cross-page id: its own class, never `a.wiki-ref`, whose click
 *  handler jumps inside the open page. */
export const XREF_CLASS = "wiki-xref";
/** The linked item's anchor on a cross-page link; `navTargetFrom` reads it. */
export const NAV_ANCHOR_ATTR = "data-anchor";

/** One id: letters, an optional `-`, digits (`D9`, `Q-16`, `A003`, `P2`). The
 *  sides are checked by the callers' lookarounds. */
export const XREF_ID_SRC = String.raw`\p{L}+-?[0-9]+`;
/** What may stand between two ids of one run: a list or range separator. The
 *  in-page linker's `RUN_GAP_RE` is this source anchored. */
export const RUN_GAP_SRC = String.raw`\s*(?:[,/&–—-]|og|and|eller|or|til|to)?\s*`;

const NO_ALNUM_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NO_ALNUM_AFTER = String.raw`(?![\p{L}\p{N}])`;
const ID_RE_SRC = `${NO_ALNUM_BEFORE}${XREF_ID_SRC}${NO_ALNUM_AFTER}`;
/** The words between a run and its wikilink. */
const CONNECTOR_SRC = String.raw`[\s ]+(?:i|in|på|on)[\s ]+$`;
const RUN_RE = new RegExp(`${ID_RE_SRC}(?:${RUN_GAP_SRC}${ID_RE_SRC})*(?=${CONNECTOR_SRC})`, "u");
const ID_GLOBAL_RE = new RegExp(ID_RE_SRC, "gu");
const ID_WHOLE_RE = new RegExp(`^${XREF_ID_SRC}$`, "u");

/** How far back from the wikilink a run is looked for. */
export const XREF_SCAN_CHARS = 240;
/** The most ids one endpoint call answers. */
export const XREF_MAX_IDS = 64;

/** Whether `s` is one id, whole. */
export function isXrefId(s: string): boolean {
  return ID_WHOLE_RE.test(s);
}

/** An id of a configured tracker project (`MELOSYS-8308` with project
 *  `MELOSYS`) is a key, never a cross-page id. */
export function isTrackerKey(id: string, trackerProjects: readonly string[]): boolean {
  const m = /^(\p{L}+)-?[0-9]+$/u.exec(id);
  return !!m && trackerProjects.includes(m[1]!.toUpperCase());
}

export interface XrefRunId {
  id: string;
  /** Offsets into the text given to {@link findXrefRun}. */
  start: number;
  end: number;
}

/**
 * The id run that `text` ends with, before `i`, `in`, `på` or `on` and the
 * wikilink that follows it. `text` is what precedes the link. Null when the
 * text does not end that way. A tracker key is no id: the run keeps only the
 * ids after the last key, so «MELOSYS-8308 på [[…]]» is no candidate.
 */
export function findXrefRun(text: string, trackerProjects: readonly string[] = []): XrefRunId[] | null {
  const from = Math.max(0, text.length - XREF_SCAN_CHARS);
  const tail = text.slice(from);
  const m = RUN_RE.exec(tail);
  if (!m) return null;
  const ids: XrefRunId[] = [];
  for (const t of m[0].matchAll(ID_GLOBAL_RE)) {
    const start = from + m.index + t.index;
    ids.push({ id: t[0], start, end: start + t[0].length });
  }
  let k = ids.length;
  while (k > 0 && !isTrackerKey(ids[k - 1]!.id, trackerProjects)) k--;
  const kept = ids.slice(k);
  return kept.length ? kept : null;
}

/** Every id token in `text`, left to right. */
export function xrefIdsIn(text: string): XrefRunId[] {
  return [...text.matchAll(ID_GLOBAL_RE)].map((t) => ({ id: t[0], start: t.index, end: t.index + t[0].length }));
}

/** `ids=` as the endpoint reads it: comma-separated, each one id whole,
 *  first occurrence kept, at most {@link XREF_MAX_IDS}. */
export function parseXrefIds(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (id && isXrefId(id) && !out.includes(id)) out.push(id);
    if (out.length >= XREF_MAX_IDS) break;
  }
  return out;
}

/** The three kinds the in-page linker targets (`ID_TARGETS`). */
export type XrefKind = "decision" | "query" | "case";

/** One id the linked page defines, as `GET /api/wiki/ref` answers it. */
export interface XrefTarget {
  kind: XrefKind;
  /** The item's anchor in the page render (`-2` included when the render's
   *  allocator gave it one). */
  anchor: string;
  /** DecisionLog: the item's first sentence. Query: its question. CaseBoard:
   *  the row's status, owner and note. */
  text: string;
  /** Query only: the card's answer. */
  answer?: string;
  /** DecisionLog question items only (not a D item): the state the
   *  DecisionLog and the answer cards read. */
  state?: "open" | "closed" | "decided";
  /** With `state: "decided"`: the decision that closed it. */
  decision?: string;
  /** DecisionLog: the item's date (`YYYY-MM-DD`), when it carries one. */
  date?: string;
}

/** `GET /api/wiki/ref`'s answer. */
export interface XrefAnswer {
  /** The linked page's title. */
  title: string;
  refs: Record<string, XrefTarget>;
}
