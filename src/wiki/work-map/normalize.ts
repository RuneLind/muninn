/**
 * After validation, the runner normalizes the model's answer in a fixed order
 * (plan `muninn-wiki-work-map`, Design, «Output»):
 *
 *  1. Slugify every effort id and every reference to one, then drop an effort
 *     whose id still fails `EFFORT_ID_RE`.
 *  2. Drop a second effort with an id already used.
 *  3. Map short page ids to relPaths; drop an unknown page id and a reference
 *     to an effort that does not exist.
 *  4. Apply declared efforts (P6, {@link applyDeclaredEfforts}): a page in the
 *     active set that declares a known effort moves into it; a declared effort
 *     the model did not return comes back as `quiet`. Step 3 keeps references
 *     to a slug step 4 restores.
 *  5. A page in two efforts stays in the first and leaves the rest.
 *  6. Clear a `derivedFrom` naming a page outside its effort, or closing a cycle.
 *  7. Clear a `parent` naming no effort (or closing a cycle).
 *  8. Drop an effort left with no pages; a declared one is retired instead
 *     ({@link retiredEfforts}).
 *  9. Compute daily activity.
 * 10. Put every active page (the digest's id map) that no effort holds into
 *     loose, wherever its member was dropped: schema, step 1, 2, 3, 5 or 8.
 *
 * Steps 3 and 7 run again after step 8, since a dropped effort can leave a
 * reference to it. The model is never asked for numbers: step 9 counts them.
 */

import type { TouchRecord } from "../git-dates.ts";
import type { WorkEvent } from "../work-focus.ts";
import { EFFORT_ID_RE, type WorkMap, type WorkMapAnswer, type WorkMapDaily, type WorkMapEffort, type WorkMapRetired } from "./schema.ts";

import { osloDay, roleFromFolder, slugifyEffortId } from "./ids.ts";

export { osloDay, slugifyEffortId };

const DAY = 86_400_000;

/** What steps 4 and 8 read about declared efforts (P6). */
export interface DeclaredEfforts {
  /** relPath → declared effort id, for every indexed page whose `effort:`
   *  passes `EFFORT_ID_RE` as written (`declaredEffortOf`), active or not. */
  pages: ReadonlyMap<string, string>;
  /** The previous map's efforts and retired list; null on a first run. */
  previous: Pick<WorkMap, "efforts" | "retired"> | null;
  /** A page's newest `gitTouchedMs` or `workedMs`; 0 when it has neither. */
  lastWorkMs: (relPath: string) => number;
}

/** An effort mid-normalization: page ids are relPaths after step 3. */
export type NormalEffort = Omit<WorkMapEffort, "daily">;

export interface NormalizeContext {
  /** short page id → relPath (`WorkMapDigest.rel`). */
  rel: ReadonlyMap<string, string>;
  nowMs: number;
  sessionsSinceMs: number;
  gitTouches: ReadonlyMap<string, readonly TouchRecord[]>;
  /** A page's session events (`WikiPageMeta.work.events`). */
  workEvents: (relPath: string) => readonly WorkEvent[] | undefined;
  /** The session behind a page's event, where the index names one
   *  (`WorkEvidence.contributions`); absent ⇒ the event counts alone. */
  sessionOf?: (relPath: string, lastMs: number) => string | undefined;
  declared?: DeclaredEfforts;
}

export type NormalizedMap = Pick<WorkMap, "summary" | "needsYou" | "themes" | "efforts" | "loose"> & { retired: WorkMapRetired[] };

/** Rewrite `⟨p12⟩` to the reader's `⟦relPath⟧` marker; an unknown id loses
 *  its brackets. Only that sigil is touched, so a bare `p12` in prose stays. */
export function linkifySigils(text: string, rel: ReadonlyMap<string, string>): string {
  return text.replace(/⟨(p\d+)⟩/g, (_m, id: string) => (rel.has(id) ? `⟦${rel.get(id)}⟧` : id));
}

export function normalizeWorkMapAnswer(answer: WorkMapAnswer, ctx: NormalizeContext): NormalizedMap {
  const link = (s: string) => linkifySigils(s, ctx.rel);

  // 1. Slugify ids and references; drop what is still invalid.
  let efforts: NormalEffort[] = answer.efforts
    .map((e) => ({
      id: slugifyEffortId(e.id),
      name: e.name,
      aliases: e.aliases,
      oneLine: e.oneLine,
      state: e.state,
      ...(e.parent !== undefined ? { parent: slugifyEffortId(e.parent) } : {}),
      pages: e.pages.map((p) => ({ id: p.id, role: p.role, ...(p.derivedFrom ? { derivedFrom: p.derivedFrom } : {}) })),
      why: e.why,
      confidence: e.confidence,
      next: e.next,
      related: e.related.map((r) => ({ id: slugifyEffortId(r.id), why: r.why })),
    }))
    .filter((e) => EFFORT_ID_RE.test(e.id));
  let themes = answer.themes.map((t) => ({ name: t.name, efforts: t.efforts.map(slugifyEffortId) }));
  let needsYou = answer.needsYou.map((n) => ({ ...n, effort: n.effort === undefined ? undefined : slugifyEffortId(n.effort) }));

  // 2. A second effort with a used id goes.
  const seen = new Set<string>();
  efforts = efforts.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  // 3. Short page ids → relPaths; unknown ids and dangling effort references go.
  const toRel = (id: string) => ctx.rel.get(id);
  efforts = efforts.map((e) => ({
    ...e,
    pages: e.pages.flatMap((p) => {
      const id = toRel(p.id);
      if (!id) return [];
      const derivedFrom = p.derivedFrom !== undefined ? toRel(p.derivedFrom) : undefined;
      return [{ id, role: p.role, ...(derivedFrom ? { derivedFrom } : {}) }];
    }),
  }));
  needsYou = needsYou.map((n) => ({ ...n, pages: n.pages.map(toRel).filter((r): r is string => !!r) }));
  let loose = answer.loose.map(toRel).filter((r): r is string => !!r);
  // Step 4's restores, known before step 3 prunes: a reference to a slug
  // step 4 brings back is kept (correction a).
  const active = new Set(ctx.rel.values());
  const moving = ctx.declared ? declaredMoves(efforts, active, ctx.declared) : new Map<string, string[]>();
  let restoring = new Set([...moving.keys()].filter((slug) => !efforts.some((e) => e.id === slug)));
  const dropDangling = () => {
    const known = new Set([...efforts.map((e) => e.id), ...restoring]);
    efforts = efforts.map((e) => ({ ...e, related: e.related.filter((r) => known.has(r.id) && r.id !== e.id) }));
    themes = themes.map((t) => ({ ...t, efforts: t.efforts.filter((id) => known.has(id)) })).filter((t) => t.efforts.length > 0);
    needsYou = needsYou.map((n) => (n.effort !== undefined && known.has(n.effort) ? n : { ...n, effort: undefined }));
  };
  dropDangling();

  // 4. Declared efforts (P6).
  if (ctx.declared) efforts = applyDeclaredEfforts(efforts, ctx.declared, moving);
  restoring = new Set();

  // 5. A page sits in one effort: the first that names it.
  const placed = new Set<string>();
  efforts = efforts.map((e) => ({
    ...e,
    pages: e.pages.filter((p) => (placed.has(p.id) ? false : (placed.add(p.id), true))),
  }));
  loose = [...new Set(loose)].filter((r) => !placed.has(r));

  // 6. derivedFrom stays inside its effort and never closes a cycle.
  efforts = efforts.map((e) => {
    const inEffort = new Set(e.pages.map((p) => p.id));
    const from = new Map<string, string>();
    const pages = e.pages.map((p) => {
      if (p.derivedFrom === undefined) return p;
      let ok = inEffort.has(p.derivedFrom) && p.derivedFrom !== p.id;
      for (let at: string | undefined = p.derivedFrom, n = 0; ok && at !== undefined && n <= e.pages.length; n++) {
        if (at === p.id) ok = false;
        at = from.get(at);
      }
      if (!ok) {
        const { derivedFrom: _drop, ...rest } = p;
        return rest;
      }
      from.set(p.id, p.derivedFrom);
      return p;
    });
    return { ...e, pages };
  });

  // 7. parent names an effort and never closes a cycle.
  const clearParents = () => {
    const known = new Set(efforts.map((e) => e.id));
    const parentOf = new Map<string, string>();
    efforts = efforts.map((e) => {
      if (e.parent === undefined) return e;
      let ok = known.has(e.parent) && e.parent !== e.id;
      for (let at: string | undefined = e.parent, n = 0; ok && at !== undefined && n <= efforts.length; n++) {
        if (at === e.id) ok = false;
        at = parentOf.get(at);
      }
      if (!ok) {
        const { parent: _drop, ...rest } = e;
        return rest;
      }
      parentOf.set(e.id, e.parent);
      return e;
    });
  };
  clearParents();

  // 8. An effort with no pages goes; then the references to it. A declared
  // one the previous map knew is retired instead.
  efforts = efforts.filter((e) => e.pages.length > 0);
  const retired = ctx.declared ? retiredEfforts(efforts, ctx.declared) : [];
  dropDangling();
  clearParents();

  // 10. Every active page sits in one effort or in loose.
  const held = new Set([...efforts.flatMap((e) => e.pages.map((p) => p.id)), ...loose]);
  for (const r of ctx.rel.values()) if (!held.has(r)) (held.add(r), loose.push(r));

  // 9. Daily activity, and the prose sigils.
  const out: WorkMapEffort[] = efforts.map((e) => ({
    ...e,
    oneLine: link(e.oneLine),
    why: link(e.why),
    next: link(e.next),
    related: e.related.map((r) => ({ ...r, why: link(r.why) })),
    daily: dailyActivity(
      e.pages.map((p) => p.id),
      ctx,
    ),
  }));
  return {
    summary: link(answer.summary),
    needsYou: needsYou.map((n) => ({
      title: link(n.title),
      kind: n.kind,
      why: link(n.why),
      action: link(n.action),
      pages: [...new Set(n.pages)],
      ...(n.effort !== undefined ? { effort: n.effort } : {}),
    })),
    themes,
    efforts: out,
    retired,
    loose,
  };
}

/**
 * The pages each declared slug takes tonight, in active-set order: every page
 * in the run's active set whose `effort:` names a slug the model returned or
 * the previous map holds in `efforts` or `retired`. Any other slug is unknown
 * and moves nothing (lint check 25 warns). A declared page outside the active
 * set is never moved into the map.
 */
export function declaredMoves(efforts: readonly NormalEffort[], active: ReadonlySet<string>, declared: DeclaredEfforts): Map<string, string[]> {
  const known = new Set([
    ...efforts.map((e) => e.id),
    ...(declared.previous?.efforts ?? []).map((e) => e.id),
    ...(declared.previous?.retired ?? []).map((r) => r.id),
  ]);
  const moving = new Map<string, string[]>();
  for (const rel of active) {
    const slug = declared.pages.get(rel);
    if (slug === undefined || !known.has(slug)) continue;
    moving.set(slug, [...(moving.get(slug) ?? []), rel]);
  }
  return moving;
}

/**
 * Step 4: each page {@link declaredMoves} lists goes into its declared
 * effort S, whatever effort the model put it in.
 * - The model returned S (with pages after step 3, or emptied — none left):
 *   S keeps the model's text and state and takes its declared pages.
 * - The model did not return S: S is restored `state: quiet` with those
 *   pages — from the previous map's entry (name, aliases, oneLine, why, next,
 *   confidence, parent, related; the re-run steps prune what dangles), or for
 *   an id coming back from `retired` the fill values (`oneLine` = name, `why`
 *   = `next` = "", `confidence` 0, no aliases or related).
 * A moved page keeps the role the model gave it, else the previous map's,
 * else its folder's ({@link roleFromFolder}).
 */
export function applyDeclaredEfforts(
  efforts: NormalEffort[],
  declared: DeclaredEfforts,
  moving: ReadonlyMap<string, readonly string[]>,
): NormalEffort[] {
  if (moving.size === 0) return efforts;
  const prevEffort = new Map((declared.previous?.efforts ?? []).map((e) => [e.id, e]));
  const prevRetired = new Map((declared.previous?.retired ?? []).map((r) => [r.id, r]));
  const modelRole = new Map<string, NormalEffort["pages"][number]["role"]>();
  for (const e of efforts) for (const p of e.pages) if (!modelRole.has(p.id)) modelRole.set(p.id, p.role);
  const prevRole = new Map<string, NormalEffort["pages"][number]["role"]>();
  for (const e of declared.previous?.efforts ?? []) for (const p of e.pages) if (!prevRole.has(p.id)) prevRole.set(p.id, p.role);
  const target = new Map<string, string>();
  for (const [slug, rels] of moving) for (const rel of rels) target.set(rel, slug);
  const roleOf = (rel: string) => modelRole.get(rel) ?? prevRole.get(rel) ?? roleFromFolder(rel);

  const out = efforts.map((e) => {
    // A declared page stays only in its own effort, where it keeps its place.
    const pages = e.pages.filter((p) => (target.get(p.id) ?? e.id) === e.id);
    const add = (moving.get(e.id) ?? []).filter((rel) => !pages.some((p) => p.id === rel));
    return { ...e, pages: [...pages, ...add.map((rel) => ({ id: rel, role: roleOf(rel) }))] };
  });
  for (const [slug, rels] of moving) {
    if (out.some((e) => e.id === slug)) continue;
    const pages = rels.map((rel) => ({ id: rel, role: roleOf(rel) }));
    const prev = prevEffort.get(slug);
    if (prev) {
      out.push({
        id: slug,
        name: prev.name,
        aliases: prev.aliases,
        oneLine: prev.oneLine,
        state: "quiet",
        ...(prev.parent !== undefined ? { parent: prev.parent } : {}),
        pages,
        why: prev.why,
        confidence: prev.confidence,
        next: prev.next,
        related: prev.related,
      });
      continue;
    }
    const r = prevRetired.get(slug)!;
    out.push({ id: slug, name: r.name, aliases: [], oneLine: r.name, state: "quiet", pages, why: "", confidence: 0, next: "", related: [] });
  }
  return out;
}

/**
 * Step 8's retire half: `retired` = (previous `efforts` ∪ previous `retired`)
 * ∩ declared slugs, minus tonight's efforts. An id leaves it when no page
 * declares it any more, and a slug the previous map never held (a typo) never
 * enters it. `lastActive` is the newest `gitTouchedMs` or `workedMs` among
 * every page declaring the id, active or not.
 */
export function retiredEfforts(efforts: readonly NormalEffort[], declared: DeclaredEfforts): WorkMapRetired[] {
  const tonight = new Set(efforts.map((e) => e.id));
  const names = new Map<string, string>();
  for (const r of declared.previous?.retired ?? []) names.set(r.id, r.name);
  for (const e of declared.previous?.efforts ?? []) names.set(e.id, e.name);
  const lastActive = new Map<string, number>();
  for (const [rel, slug] of declared.pages) lastActive.set(slug, Math.max(lastActive.get(slug) ?? 0, declared.lastWorkMs(rel)));
  return [...names]
    .filter(([id]) => lastActive.has(id) && !tonight.has(id))
    .map(([id, name]) => ({ id, name, lastActive: lastActive.get(id)! }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Per day of the last 28 (Europe/Oslo), the distinct commits touching the
 * effort's pages — one commit on three of them counts once, metadata stamps
 * included — and the distinct sessions on them inside the sessions window,
 * by session id where `sessionOf` names one. Only days with activity are
 * listed, oldest first.
 */
export function dailyActivity(
  pages: readonly string[],
  ctx: Pick<NormalizeContext, "nowMs" | "sessionsSinceMs" | "gitTouches" | "workEvents" | "sessionOf">,
): WorkMapDaily[] {
  const since = ctx.nowMs - 28 * DAY;
  const commits = new Map<string, Set<string>>();
  const sessions = new Map<string, Set<string>>();
  const add = <T>(m: Map<string, Set<T>>, day: string, v: T) => {
    let s = m.get(day);
    if (!s) m.set(day, (s = new Set()));
    s.add(v);
  };
  for (const rel of pages) {
    for (const t of ctx.gitTouches.get(rel) ?? []) {
      if (t.ts >= since && t.ts <= ctx.nowMs) add(commits, osloDay(t.ts), t.commit);
    }
    for (const [lastMs, , kind] of ctx.workEvents(rel) ?? []) {
      if (kind === "pass") continue;
      if (lastMs >= Math.max(since, ctx.sessionsSinceMs) && lastMs <= ctx.nowMs) {
        add(sessions, osloDay(lastMs), ctx.sessionOf?.(rel, lastMs) ?? `t:${lastMs}`);
      }
    }
  }
  const days = [...new Set([...commits.keys(), ...sessions.keys()])].sort();
  return days.map((day) => ({ day, commits: commits.get(day)?.size ?? 0, sessions: sessions.get(day)?.size ?? 0 }));
}
