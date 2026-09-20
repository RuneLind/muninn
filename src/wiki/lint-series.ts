/**
 * LINT CHECK 8 — the three series checks, and the only lint findings that carry
 * a FIX.
 *
 *  8.1 `same-work-no-link`   — two pages that are plainly one piece of work with
 *                              no wikilink either way.
 *  8.2 `series-unnamed`      — a cluster of linked pages that declares no
 *                              `series:` at all.
 *  8.3 `series-inconsistent` — an existing series whose declaration is only
 *                              half-written: two spellings of one key, two
 *                              `series_label:` heads, or a page linked into the
 *                              series that never joined it.
 *
 * Its own module rather than three more functions in `lint.ts`: it is the only
 * check that needs the SERIES vocabulary (`wiki-groups.ts`) and the RELATED
 * WORK cuts (`related.ts` + `related-constants.ts`), and folding it in would
 * pull both graphs into every reader of the seven hygiene checks. `lint.ts`
 * imports `checkSeries` as a value and this file imports `LintFinding` as a
 * TYPE, so the pair is erased at runtime and is not a module cycle.
 *
 * **The four cuts are REUSED, never re-declared** — `isBookkeeping`,
 * `RELATED_HUB_BACKLINKS` (25), `RELATED_DIGEST_PRS` (15) and
 * `RELATED_SHARED_PRS_MIN` (2), the numbers `related-constants.ts` states the
 * measurements for. Both the hub and the bookkeeping cut apply to BOTH ends of
 * every pair, exactly as `computeRelated` applies them to the open page: each
 * one says "this page is not a piece of work", which is as true of one end as of
 * the other.
 *
 * Report-only, like every other check: this module returns findings and writes
 * nothing. The `fix` payload on a finding is what `src/gardener/lint-proposals.ts`
 * turns into `wiki_proposals` rows for the human review gate.
 */

import {
  bySeriesDateDesc,
  clipSeriesTitle,
  newestSeriesPlan,
  seriesFoldKey,
  seriesKeyOf,
  SERIES_CONTINUE_MAX,
} from "../dashboard/views/components/wiki-groups.ts";
import { isBookkeeping } from "./related.ts";
import {
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  RELATED_SHARED_PRS_MIN,
  RELATED_SHARED_PRS_SHOWN,
} from "./related-constants.ts";
import { normalizeRelPath, wikiPageStem, type WikiIndex, type WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

/** The three check ids this module owns. `lint.ts` re-states them inside
 *  `LINT_CHECKS`; this list is what the module itself iterates. */
export const SERIES_LINT_CHECKS = [
  "same-work-no-link",
  "series-unnamed",
  "series-inconsistent",
] as const;
export type SeriesLintCheck = (typeof SERIES_LINT_CHECKS)[number];

/**
 * How many pages of one 8.2 cluster are proposed. A component past this is
 * proposed as its 12 NEWEST with the rest named in `detail` — a cut rather than
 * a refusal, because the cluster is real and the reviewer can still act on the
 * head of it. The dry run over mimir (2026-09-20) used 12 as a FILTER and
 * measured 21 usable clusters; as a cap it keeps the long tail reviewable
 * instead of dropping it.
 */
export const SERIES_CLUSTER_MAX = 12;

/** How many members a `detail` line names before it says "and N more". */
const DETAIL_MEMBERS_SHOWN = 12;

/**
 * ONE page edit a lint fix proposes. Deliberately a typed payload rather than a
 * sentence the proposal builder parses back out of `detail`: the builder writes
 * files, and a regex over prose is not a contract.
 */
export type LintPageEdit =
  /** Add `- [[title]]` under the page's `## See also`, the way the gardener's
   *  wire stage does (`buildSeeAlsoEdit`). */
  | { op: "see-also"; relPath: string; title: string }
  /** Upsert (or, with `value: null`, remove) one top-level frontmatter key. */
  | { op: "frontmatter"; relPath: string; key: "series" | "series_label"; value: string | null };

/** The machine-readable half of a finding: which pages to edit, and the group
 *  id every row of that one finding shares. */
export interface LintFix {
  /** `lint:<check>:<12 hex>` — deterministic from the check id, the sub-rule and
   *  the sorted member relPaths, so a re-run over an unchanged wiki reproduces
   *  it byte for byte and the gate can skip a group it has already seen. */
  groupKey: string;
  edits: LintPageEdit[];
}

/** A page that can take part in a series finding, with the per-page facts every
 *  rule below reads exactly once. */
interface Candidate {
  page: WikiPageMeta;
  /** `normalizeRelPath(page.relPath)` — the graph's own key. */
  key: string;
  /** Lower-cased PR refs, for the case-insensitive share test. */
  prs: Set<string>;
  /** The page's refs in FILE order, for the `shares …` reason's spelling. */
  prList: string[];
  sessions: string[];
  /** Raw authored `series:`, trimmed. `""` for a page in none. */
  series: string;
  /** More than `RELATED_DIGEST_PRS` refs — names half the month by construction. */
  digest: boolean;
}

function hash12(parts: readonly string[]): string {
  return new Bun.CryptoHasher("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

/** The group id for one finding. The sub-rule is IN the hash because 8.3's three
 *  sub-rules can cover the same member set, and two findings sharing a group key
 *  would mint two proposal rows with one `topic_key`. */
function groupKeyFor(check: SeriesLintCheck, sub: string, members: readonly string[]): string {
  return `lint:${check}:${hash12([sub, ...[...members].sort()])}`;
}

/** Newest first, the rail's own ordering. */
function newestFirst(pages: readonly WikiPageMeta[]): WikiPageMeta[] {
  return [...pages].sort(bySeriesDateDesc);
}

/**
 * How a `[[wikilink]]` on another page should spell THIS page.
 *
 * The wire stage links a page by its `title`, so that is tried first — but only
 * when the title resolves BACK to this page: `byKey` is first-registration-wins,
 * so a title shared with another page would make the lint's own fix a
 * `broken-link` finding on the next run. Falls back to the filename stem, then
 * to the path form (`plans/foo`), which `index.resolve` handles explicitly.
 */
function wikilinkTargetFor(index: WikiIndex, page: WikiPageMeta): string {
  const selfKey = normalizeRelPath(page.relPath);
  for (const candidate of [page.title, page.name]) {
    if (!candidate || !candidate.trim()) continue;
    const resolved = index.resolve(candidate);
    if (resolved && normalizeRelPath(resolved.relPath) === selfKey) return candidate.trim();
  }
  return page.relPath.replace(/\.mdx?$/i, "");
}

/** The pages check 8 will consider at all: markdown pages that are a piece of
 *  work. Explainers carry no frontmatter and join no link graph; bookkeeping
 *  pages and hubs are the two `related.ts` cuts, applied to every end of every
 *  pair. */
function buildCandidates(index: WikiIndex): Candidate[] {
  const out: Candidate[] = [];
  for (const page of index.pages) {
    if (page.type === "explainer") continue;
    if (isBookkeeping(page.relPath)) continue;
    const key = normalizeRelPath(page.relPath);
    if ((index.backlinks.get(key)?.length ?? 0) > RELATED_HUB_BACKLINKS) continue;
    const prList = page.prRefs ?? [];
    out.push({
      page,
      key,
      prList,
      prs: new Set(prList.map((r) => r.toLowerCase())),
      sessions: page.sessions ?? [],
      series: seriesKeyOf(page),
      digest: prList.length > RELATED_DIGEST_PRS,
    });
  }
  return out;
}

/** The refs both pages name, in `a`'s own order — the `shares …` reason's list. */
function sharedPrs(a: Candidate, b: Candidate): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of a.prList) {
    const k = ref.toLowerCase();
    if (seen.has(k) || !b.prs.has(k)) continue;
    seen.add(k);
    out.push(ref);
  }
  return out;
}

/** True when either page's frontmatter names the other as its successor —
 *  `pairedBy: "superseded"` is `superseded_by:` already resolved by the store's
 *  pairing pass, so nothing here re-parses frontmatter. */
function supersededPair(a: Candidate, b: Candidate): boolean {
  const parentOf = (c: Candidate): string | null =>
    c.page.pairedBy === "superseded" && c.page.parent ? normalizeRelPath(c.page.parent) : null;
  return parentOf(a) === b.key || parentOf(b) === a.key;
}

/** ─────────────────────────── 8.1 same work, no link ───────────────────────── */

/**
 * Pairs that are one piece of work with NO wikilink either way, by one of three
 * signals in this precedence: ≥2 shared PR refs (neither page a digest), a
 * shared session id, or a `superseded_by` chain. One finding per pair, filed
 * against the NEWER page — which is the page the proposed `See also` line is
 * written on, so the finding and its fix name the same file.
 *
 * Candidate pairs come from inverted indexes over the two list fields plus the
 * store's superseded pairing, so the cost is the number of pages carrying a
 * signal at all rather than the square of the wiki (measured on jarvis, 1,261
 * pages carrying none: zero pairs considered).
 */
function checkSameWorkNoLink(index: WikiIndex, candidates: Candidate[]): LintFinding[] {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const pairs = new Map<string, [Candidate, Candidate]>();
  const addPair = (a: Candidate, b: Candidate): void => {
    if (a.key === b.key) return;
    const [x, y] = a.key < b.key ? [a, b] : [b, a];
    pairs.set(`${x.key}\u0000${y.key}`, [x, y]);
  };

  // Inverted indexes: a pair is only worth evaluating when the two pages share
  // a ref or a session, or one supersedes the other.
  for (const field of ["prs", "sessions"] as const) {
    const inverted = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const values = field === "prs" ? c.prList.map((r) => r.toLowerCase()) : c.sessions;
      for (const v of new Set(values)) {
        const list = inverted.get(v);
        if (list) list.push(c);
        else inverted.set(v, [c]);
      }
    }
    for (const group of inverted.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) addPair(group[i]!, group[j]!);
      }
    }
  }
  for (const c of candidates) {
    if (c.page.pairedBy !== "superseded" || !c.page.parent) continue;
    const parent = byKey.get(normalizeRelPath(c.page.parent));
    if (parent) addPair(c, parent);
  }

  const findings: LintFinding[] = [];
  for (const [a, b] of pairs.values()) {
    if ((index.outgoing.get(a.key) ?? []).includes(b.key)) continue;
    if ((index.outgoing.get(b.key) ?? []).includes(a.key)) continue;

    let why: string | null = null;
    const shared = sharedPrs(a, b);
    if (shared.length >= RELATED_SHARED_PRS_MIN && !a.digest && !b.digest) {
      why = `shares ${shared.slice(0, RELATED_SHARED_PRS_SHOWN).join(", ")}`;
    } else {
      const session = a.sessions.find((s) => b.sessions.includes(s));
      if (session) why = `same session ${session}`;
      else if (supersededPair(a, b)) why = "superseded_by chain";
    }
    if (!why) continue;

    const [newer, older] = newestFirst([a.page, b.page]) as [WikiPageMeta, WikiPageMeta];
    findings.push({
      check: "same-work-no-link",
      relPath: newer.relPath,
      message: `Same work as "${older.relPath}", but neither page links to the other`,
      detail: `${older.relPath} — ${why}`,
      fix: {
        groupKey: groupKeyFor("same-work-no-link", "see-also", [newer.relPath, older.relPath]),
        edits: [
          { op: "see-also", relPath: newer.relPath, title: wikilinkTargetFor(index, older) },
        ],
      },
    });
  }
  return findings.sort((x, y) => x.relPath.localeCompare(y.relPath));
}

/** ───────────────────── the clustering edge, shared by 8.2 + 8.3(c) ────────── */

/**
 * The SERIES edge: mutual wikilinks, OR one wikilink plus ≥1 shared PR ref
 * (neither page a digest), OR a `superseded_by` chain.
 *
 * Stronger than 8.1's signal on purpose. 8.1 asks "are these two the same work"
 * about a PAIR, where a missing link is the finding; a cluster is transitive, so
 * a weak edge merges half the wiki — measured in mimir's dry run, the raw link
 * graph's largest component is 189 of 379 narrative pages.
 */
function seriesComponents(index: WikiIndex, candidates: Candidate[]): Candidate[][] {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const parent = new Map<string, string>(candidates.map((c) => [c.key, c.key]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression, so a long superseded chain does not walk on every union.
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const a of candidates) {
    for (const toKey of index.outgoing.get(a.key) ?? []) {
      const b = byKey.get(toKey);
      if (!b || b.key === a.key) continue;
      const mutual = (index.outgoing.get(b.key) ?? []).includes(a.key);
      const linkPlusPr =
        !a.digest && !b.digest && sharedPrs(a, b).length >= 1;
      if (mutual || linkPlusPr) union(a.key, b.key);
    }
    if (a.page.pairedBy === "superseded" && a.page.parent) {
      const parentPage = byKey.get(normalizeRelPath(a.page.parent));
      if (parentPage) union(a.key, parentPage.key);
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const root = find(c.key);
    const list = groups.get(root);
    if (list) list.push(c);
    else groups.set(root, [c]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

/** `a, b, c` with the tail folded — the `detail` line's member list. */
function memberList(paths: readonly string[]): string {
  if (paths.length <= DETAIL_MEMBERS_SHOWN) return paths.join(", ");
  return `${paths.slice(0, DETAIL_MEMBERS_SHOWN).join(", ")} and ${paths.length - DETAIL_MEMBERS_SHOWN} more`;
}

/**
 * The 12 newest of a cluster, plus the ones cut. The cap is on the pages that
 * get a ROW: a cluster of 40 is a real cluster, and proposing 40 frontmatter
 * edits behind one Accept is not a review.
 */
function capCluster(members: WikiPageMeta[]): { kept: WikiPageMeta[]; cut: WikiPageMeta[] } {
  const ordered = newestFirst(members);
  return {
    kept: ordered.slice(0, SERIES_CLUSTER_MAX),
    cut: ordered.slice(SERIES_CLUSTER_MAX),
  };
}

/** The member a series is named after: the newest non-terminal plan, else the
 *  newest member. `newestSeriesPlan` is the rail's own rule — a blog records the
 *  work and never names it. */
function headOf(members: WikiPageMeta[]): WikiPageMeta {
  const ordered = newestFirst(members);
  return newestSeriesPlan(ordered) ?? ordered[0]!;
}

/** ────────────────────────── 8.2 + 8.3(c), one pass ───────────────────────── */

/**
 * One clustering answers both, and that is deliberate: a component is either
 * fully unnamed (8.2 coins a key) or it touches exactly one existing series
 * (8.3 writes the missing half). Splitting them into two passes over two vertex
 * sets let ONE page be proposed by both checks with two different keys — two
 * `wiki_proposals` rows on one `target_path`, whose group applies would stale
 * each other.
 *
 * A component touching TWO existing series keys is left alone: merging two
 * named series is an editorial decision, not a lint fix.
 */
function checkClusters(candidates: Candidate[], index: WikiIndex): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const component of seriesComponents(index, candidates)) {
    const folds = new Set(component.filter((c) => c.series).map((c) => seriesFoldKey(c.series)));
    if (folds.size >= 2) continue;

    const unnamed = component.filter((c) => !c.series).map((c) => c.page);
    if (unnamed.length === 0) continue;

    if (folds.size === 1) {
      // 8.3(c) — the series exists; these pages link into it without declaring it.
      const named = component.find((c) => !!c.series)!;
      const key = named.series;
      const { kept, cut } = capCluster(unnamed);
      const paths = kept.map((p) => p.relPath);
      findings.push({
        check: "series-inconsistent",
        relPath: headOf(kept).relPath,
        message: `${kept.length} page(s) link into the series "${key}" without declaring it`,
        detail:
          `joining ${key}: ${memberList(paths)}` +
          (cut.length ? ` · ${cut.length} more cut: ${memberList(cut.map((p) => p.relPath))}` : ""),
        fix: {
          groupKey: groupKeyFor("series-inconsistent", `join:${key}`, paths),
          edits: paths.map((relPath) => ({
            op: "frontmatter" as const,
            relPath,
            key: "series" as const,
            value: key,
          })),
        },
      });
      continue;
    }

    // 8.2 — nobody in this component has named the work yet.
    const { kept, cut } = capCluster(unnamed);
    const head = headOf(kept);
    const key = wikiPageStem(head.relPath);
    const label = clipSeriesTitle(head.title);
    const paths = kept.map((p) => p.relPath);
    findings.push({
      check: "series-unnamed",
      relPath: head.relPath,
      message: `${kept.length} linked pages declare no series: — propose series: ${key}`,
      detail:
        `members: ${memberList(paths)}` +
        (cut.length ? ` · ${cut.length} more cut: ${memberList(cut.map((p) => p.relPath))}` : ""),
      fix: {
        groupKey: groupKeyFor("series-unnamed", "coin", paths),
        edits: [
          ...paths.map((relPath) => ({
            op: "frontmatter" as const,
            relPath,
            key: "series" as const,
            value: key,
          })),
          { op: "frontmatter", relPath: head.relPath, key: "series_label", value: label },
        ],
      },
    });
  }
  return findings.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** ──────────────────── 8.3 (a) spelling + (b) duplicate label ──────────────── */

/**
 * The two sub-rules that read the AUTHORED key alone.
 *
 * They run over every page carrying `series:` — hubs and bookkeeping pages
 * included, and unlike every other rule here. The four cuts answer "is this page
 * a piece of work", which is the question the PAIRING rules ask; a key somebody
 * typed is a declaration, and a wiki whose series is spelled two ways is
 * inconsistent wherever the second spelling landed.
 *
 * **One normalisation, stated once:** two keys are the same series when
 * `seriesFoldKey` (trim + lower-case) agrees — the rail's own fold, because the
 * folds store lower-cases what it compares and two spellings already render as
 * one row there.
 */
function checkDeclaredSeries(index: WikiIndex): LintFinding[] {
  const byFold = new Map<string, WikiPageMeta[]>();
  for (const page of index.pages) {
    if (page.type === "explainer") continue;
    const key = seriesKeyOf(page);
    if (!key) continue;
    const fold = seriesFoldKey(key);
    const list = byFold.get(fold);
    if (list) list.push(page);
    else byFold.set(fold, [page]);
  }

  const findings: LintFinding[] = [];
  for (const members of byFold.values()) {
    const head = headOf(members);
    const headKey = seriesKeyOf(head);

    // (a) one series, more than one spelling.
    const variants = [...new Set(members.map((m) => seriesKeyOf(m)))];
    if (variants.length > 1) {
      const wrong = members.filter((m) => seriesKeyOf(m) !== headKey);
      const paths = wrong.map((p) => p.relPath);
      findings.push({
        check: "series-inconsistent",
        relPath: head.relPath,
        message: `series: "${headKey}" is spelled ${variants.length} ways — ${variants.join(", ")}`,
        detail: `normalising to "${headKey}" on: ${memberList(paths)}`,
        fix: {
          groupKey: groupKeyFor("series-inconsistent", `spelling:${seriesFoldKey(headKey)}`, paths),
          edits: paths.map((relPath) => ({
            op: "frontmatter" as const,
            relPath,
            key: "series" as const,
            value: headKey,
          })),
        },
      });
    }

    // (b) more than one member carries series_label:. The head is picked among
    //     the LABELLED members, so the fix can never remove every label.
    const labelled = members.filter((m) => !!m.seriesLabel && m.seriesLabel.trim());
    if (labelled.length > 1) {
      const labelHead = headOf(labelled);
      const extra = labelled.filter((m) => m.relPath !== labelHead.relPath);
      const paths = extra.map((p) => p.relPath);
      findings.push({
        check: "series-inconsistent",
        relPath: labelHead.relPath,
        message: `series "${headKey}" has ${labelled.length} series_label: heads — the rail shows the newest one`,
        detail: `keeping "${labelHead.seriesLabel}" on ${labelHead.relPath}; removing series_label: from ${memberList(paths)}`,
        fix: {
          groupKey: groupKeyFor("series-inconsistent", `label:${seriesFoldKey(headKey)}`, paths),
          edits: paths.map((relPath) => ({
            op: "frontmatter" as const,
            relPath,
            key: "series_label" as const,
            value: null,
          })),
        },
      });
    }
  }
  return findings;
}

/**
 * Check 8 over a built index — index-level, like `checkOrphans` and
 * `checkStemCollisions`, and pure: it reads no file and writes nothing.
 */
export function checkSeries(index: WikiIndex): LintFinding[] {
  const candidates = buildCandidates(index);
  return [
    ...checkSameWorkNoLink(index, candidates),
    ...checkClusters(candidates, index),
    ...checkDeclaredSeries(index),
  ];
}

/** Re-exported so a caller that already imports this module does not need a
 *  second import for the clip width the 8.2 label is built with. */
export { SERIES_CONTINUE_MAX };
