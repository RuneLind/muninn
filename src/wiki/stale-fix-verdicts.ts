/**
 * The Stale check's fix paths and the verdict table (plan
 * muninn-wiki-drift-check, PR 3):
 *
 * - {@link resolveStaleFix}: which drafted edit an Apply or a Send means. The
 *   edit is read off the stored verdict under a key derived on the server
 *   from the page as it is now; the client names it, never supplies it.
 * - {@link writeFixedVerdicts} (D29): after an Apply or an Accept writes a
 *   linking page, a `fixed` row on the NEW passage's key, so a later sweep
 *   commit that hides the page's date does not put it back in To check.
 * - {@link fixedLinkingPages}: the To-check pages whose current passage carries
 *   that row; the GET routes count them out of To check.
 * - {@link keptAsWritten} (D20): a rejected Stale check card's edits become
 *   reader «still true» rows, «kept as written».
 */
import { linkingBuckets, type LinkingPage } from "./stale.ts";
import { changedHashOf, passageVerdictKey, staleVerdictStore, statusLineVerdictKey, type StaleVerdictStore } from "./stale-confirm.ts";
import type { StaleFixEdit, StaleFixKind, StaleFixVariant } from "./stale-fix.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";
import { READER_CHECKED_BY } from "../db/wiki-stale-verdicts.ts";
import { normalizeRelPath } from "./rel-path.ts";

export type ResolvedStaleFix = { ok: true; edit: StaleFixEdit } | { ok: false; status: 400 | 404 | 409; error: string };

/** What a client sends to name one drafted fix on `anchor`'s STALE tab. */
export interface StaleFixRequest {
  kind: string;
  /** A status-line fix: the hit's target plan, and its line (a hint). */
  target?: string;
  line?: number;
  /** A passage fix: the To-check linking page. */
  linking?: string;
  /** The edit's `old` as the client showed it: the fix must still be that one. */
  old?: string;
  variant: string;
  asOfMs?: number;
}

/**
 * The drafted edit a request names, read off its stored verdict: a
 * status-line fix writes `anchor` itself, a passage fix writes the linking
 * page. Refuses a variant the verdict has no text for, and an `old` that is
 * not the stored one (the verdict changed since the tab loaded).
 */
export async function resolveStaleFix(opts: {
  wiki: string;
  index: WikiIndex;
  anchor: WikiPageMeta;
  req: StaleFixRequest;
  store?: StaleVerdictStore;
}): Promise<ResolvedStaleFix> {
  const { wiki, index, anchor, req } = opts;
  const store = opts.store ?? staleVerdictStore();
  if (req.variant !== "new" && req.variant !== "home") return { ok: false, status: 400, error: "variant must be new or home" };
  const variant = req.variant as StaleFixVariant;
  let picked: { kind: StaleFixKind; page: string; link: string; edit: { old: string; new: string; home?: string }; reason: string } | null = null;
  let changedMeanwhile = false;
  if (req.kind === "status-line") {
    const target = (req.target ?? "").trim();
    const hits = (index.statusLineHits?.get(anchor.relPath) ?? []).filter((h) => !target || normalizeRelPath(h.target) === normalizeRelPath(target));
    if (!hits.length) return { ok: false, status: 404, error: `no status-line hit on ${anchor.relPath}${target ? ` for ${target}` : ""}` };
    const keyed = hits.map((h) => ({ h, key: statusLineVerdictKey(index, anchor.relPath, h) }));
    const rows = await store.get(wiki, "status-line", keyed.map((k) => k.key));
    const drafted = keyed
      .map((k) => ({ ...k, row: rows.get(k.key) }))
      .filter((k) => k.row?.verdict === "stale" && k.row.edit)
      .sort((a, b) => Number(b.h.line === req.line) - Number(a.h.line === req.line));
    const match = drafted.find((k) => req.old === undefined || k.row!.edit!.old === req.old);
    changedMeanwhile = !match && drafted.length > 0;
    if (match) picked = { kind: "status-line", page: anchor.relPath, link: match.h.target, edit: match.row!.edit!, reason: match.row!.reason };
  } else if (req.kind === "passage") {
    const linking = (req.linking ?? "").trim();
    const buckets = await linkingBuckets(index, anchor.relPath, req.asOfMs !== undefined ? { asOfMs: req.asOfMs } : {});
    if (!buckets) return { ok: false, status: 404, error: `${anchor.relPath} is not a changed page, so it has no linking pages to fix` };
    const l = buckets.linking.find((x) => x.relPath === linking);
    if (!l) return { ok: false, status: 404, error: `${linking || "(no linking page)"} does not link to ${anchor.relPath}` };
    const hash = await changedHashOf(index, buckets.relPath);
    if (hash === null) return { ok: false, status: 409, error: `${buckets.relPath} cannot be read, so its verdicts have no key` };
    const row = (await store.get(wiki, "passage", [passageVerdictKey(index, buckets.relPath, hash, l)])).values().next().value;
    if (row?.verdict === "stale" && row.edit) {
      if (req.old === undefined || row.edit.old === req.old) picked = { kind: "passage", page: l.relPath, link: buckets.relPath, edit: row.edit, reason: row.reason };
      else changedMeanwhile = true;
    }
  } else return { ok: false, status: 400, error: "kind must be status-line or passage" };
  if (!picked) {
    return changedMeanwhile
      ? { ok: false, status: 409, error: "The drafted fix changed since the tab loaded. Reload the STALE tab." }
      : { ok: false, status: 404, error: "No drafted fix for that line: Check it first." };
  }
  const text = variant === "home" ? picked.edit.home : picked.edit.new;
  if (typeof text !== "string") return { ok: false, status: 409, error: "That fix has no point-to-the-home variant." };
  return {
    ok: true,
    edit: { kind: picked.kind, page: picked.page, link: picked.link, old: picked.edit.old, text, variant, ...(picked.reason ? { reason: picked.reason } : {}) },
  };
}

/** The linking page's entry on a changed page's buckets, under `index`. */
async function linkingEntry(index: WikiIndex, changed: string, page: string): Promise<{ l: LinkingPage; hash: string; changed: string } | null> {
  const buckets = await linkingBuckets(index, changed);
  const l = buckets?.linking.find((x) => normalizeRelPath(x.relPath) === normalizeRelPath(page));
  if (!buckets || !l) return null;
  const hash = await changedHashOf(index, buckets.relPath);
  return hash === null ? null : { l, hash, changed: buckets.relPath };
}

export const FIXED_REASON = "Fixed through the Stale check";

/**
 * D29: a `fixed` row on the new passage of every linking page a passage edit
 * wrote. `index` must be the index built after the write. A page whose
 * changed page is no longer changed has no buckets and gets no row. Returns
 * how many rows were written.
 */
export async function writeFixedVerdicts(opts: {
  wiki: string;
  index: WikiIndex;
  edits: readonly Pick<StaleFixEdit, "kind" | "page" | "link">[];
  store?: StaleVerdictStore;
}): Promise<number> {
  const store = opts.store ?? staleVerdictStore();
  const seen = new Set<string>();
  let n = 0;
  for (const e of opts.edits) {
    if (e.kind !== "passage") continue;
    const k = `${e.link}\0${e.page}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const entry = await linkingEntry(opts.index, e.link, e.page);
    if (!entry) continue;
    await store.upsert({
      wiki: opts.wiki,
      kind: "fixed",
      page: entry.l.relPath,
      keyHash: passageVerdictKey(opts.index, entry.changed, entry.hash, entry.l),
      verdict: "fixed",
      reason: FIXED_REASON,
      edit: null,
      checkedBy: READER_CHECKED_BY,
    });
    n++;
  }
  return n;
}

/** The To-check linking pages of `changed` whose current passage carries a
 *  `fixed` row. One cheap page read first; keys only for pages that have one. */
export async function fixedLinkingPages(opts: {
  wiki: string;
  index: WikiIndex;
  changed: string;
  linking: readonly LinkingPage[];
  store?: StaleVerdictStore;
  /** The store's pages with a `fixed` row, when the caller already read them. */
  fixedPages?: Set<string>;
}): Promise<Set<string>> {
  const store = opts.store ?? staleVerdictStore();
  const out = new Set<string>();
  const pages = opts.fixedPages ?? (await store.pages?.(opts.wiki, "fixed")) ?? new Set<string>();
  const candidates = opts.linking.filter((l) => l.bucket === "toCheck" && pages.has(l.relPath));
  if (!candidates.length) return out;
  const hash = await changedHashOf(opts.index, opts.changed);
  if (hash === null) return out;
  const keys = new Map(candidates.map((l) => [passageVerdictKey(opts.index, opts.changed, hash, l), l.relPath] as const));
  const rows = await store.get(opts.wiki, "fixed", [...keys.keys()]);
  for (const [k, rel] of keys) if (rows.has(k)) out.add(rel);
  return out;
}

export const KEPT_REASON = "Kept as written: its Stale check fix was rejected in the Gardener";

/**
 * D20: a rejected card's edits become reader «still true» rows on the keys
 * they were drafted under, as the pages are now. A status-line edit names the
 * hit by its target and `old`; a passage edit by its linking page. An edit
 * whose hit or passage is gone writes nothing. Returns how many rows were written.
 */
export async function keptAsWritten(opts: {
  wiki: string;
  index: WikiIndex;
  edits: readonly StaleFixEdit[];
  store?: StaleVerdictStore;
}): Promise<number> {
  const store = opts.store ?? staleVerdictStore();
  let n = 0;
  for (const e of opts.edits) {
    if (e.kind === "passage") {
      const entry = await linkingEntry(opts.index, e.link, e.page);
      if (!entry) continue;
      await store.upsert({
        wiki: opts.wiki,
        kind: "passage",
        page: entry.l.relPath,
        keyHash: passageVerdictKey(opts.index, entry.changed, entry.hash, entry.l),
        verdict: "true",
        reason: KEPT_REASON,
        edit: null,
        checkedBy: READER_CHECKED_BY,
      });
      n++;
      continue;
    }
    const hits = (opts.index.statusLineHits?.get(e.page) ?? []).filter((h) => normalizeRelPath(h.target) === normalizeRelPath(e.link));
    const keyed = hits.map((h) => statusLineVerdictKey(opts.index, e.page, h));
    const rows = await store.get(opts.wiki, "status-line", keyed);
    for (const key of keyed) {
      if (rows.get(key)?.edit?.old !== e.old) continue;
      await store.upsert({ wiki: opts.wiki, kind: "status-line", page: e.page, keyHash: key, verdict: "true", reason: KEPT_REASON, edit: null, checkedBy: READER_CHECKED_BY });
      n++;
    }
  }
  return n;
}
