/**
 * After validation, the runner normalizes the model's answer in a fixed order
 * (plan `muninn-wiki-work-map`, Design, «Output»):
 *
 *  1. Slugify every effort id and every reference to one, then drop an effort
 *     whose id still fails `EFFORT_ID_RE`.
 *  2. Drop a second effort with an id already used. A page of an effort
 *     dropped at step 1 or 2 goes to loose unless step 5 places it.
 *  3. Map short page ids to relPaths; drop an unknown page id and a reference
 *     to an effort that does not exist.
 *  4. Apply declared efforts (P6) — an ordered hook, a no-op until then.
 *  5. A page in two efforts stays in the first and leaves the rest.
 *  6. Clear a `derivedFrom` naming a page outside its effort, or closing a cycle.
 *  7. Clear a `parent` naming no effort (or closing a cycle).
 *  8. Drop an effort left with no pages.
 *  9. Compute daily activity.
 *
 * Steps 3 and 7 run again after step 8, since a dropped effort can leave a
 * reference to it. The model is never asked for numbers: step 9 counts them.
 */

import type { TouchRecord } from "../git-dates.ts";
import type { WorkEvent } from "../work-focus.ts";
import { EFFORT_ID_RE, type WorkMap, type WorkMapAnswer, type WorkMapDaily, type WorkMapEffort } from "./schema.ts";

const DAY = 86_400_000;
const OSLO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
export const osloDay = (ms: number) => OSLO_DAY.format(new Date(ms));

/** NFKD, `å`→`aa`, `ø`→`o`, `æ`→`ae`, lowercase, `_` and spaces → `-`, other
 *  marks and characters dropped, dashes collapsed and trimmed. */
export function slugifyEffortId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/å/g, "aa")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Step 4's seam: P6 moves declared pages into their declared efforts here. */
export type DeclaredEffortsHook = (efforts: NormalEffort[]) => NormalEffort[];

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
  declared?: DeclaredEffortsHook;
}

export type NormalizedMap = Pick<WorkMap, "summary" | "needsYou" | "themes" | "efforts" | "loose">;

/** Rewrite `⟨p12⟩` to the reader's `⟦relPath⟧` marker; an unknown id loses
 *  its brackets. Only that sigil is touched, so a bare `p12` in prose stays. */
export function linkifySigils(text: string, rel: ReadonlyMap<string, string>): string {
  return text.replace(/⟨(p\d+)⟩/g, (_m, id: string) => (rel.has(id) ? `⟦${rel.get(id)}⟧` : id));
}

export function normalizeWorkMapAnswer(answer: WorkMapAnswer, ctx: NormalizeContext): NormalizedMap {
  const link = (s: string) => linkifySigils(s, ctx.rel);

  // Steps 1 and 2 drop an effort but not its pages: those go to loose.
  const dropped: string[] = [];
  const keep = (e: NormalEffort, ok: boolean) => (ok ? true : (dropped.push(...e.pages.map((p) => p.id)), false));

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
    .filter((e) => keep(e, EFFORT_ID_RE.test(e.id)));
  let themes = answer.themes.map((t) => ({ name: t.name, efforts: t.efforts.map(slugifyEffortId) }));
  let needsYou = answer.needsYou.map((n) => ({ ...n, effort: n.effort === undefined ? undefined : slugifyEffortId(n.effort) }));

  // 2. A second effort with a used id goes.
  const seen = new Set<string>();
  efforts = efforts.filter((e) => keep(e, seen.has(e.id) ? false : (seen.add(e.id), true)));

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
  let loose = [...answer.loose, ...dropped].map(toRel).filter((r): r is string => !!r);
  const dropDangling = () => {
    const known = new Set(efforts.map((e) => e.id));
    efforts = efforts.map((e) => ({ ...e, related: e.related.filter((r) => known.has(r.id) && r.id !== e.id) }));
    themes = themes.map((t) => ({ ...t, efforts: t.efforts.filter((id) => known.has(id)) })).filter((t) => t.efforts.length > 0);
    needsYou = needsYou.map((n) => (n.effort !== undefined && known.has(n.effort) ? n : { ...n, effort: undefined }));
  };
  dropDangling();

  // 4. Declared efforts (P6).
  if (ctx.declared) efforts = ctx.declared(efforts);

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

  // 8. An effort with no pages goes; then the references to it.
  efforts = efforts.filter((e) => e.pages.length > 0);
  dropDangling();
  clearParents();

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
    loose,
  };
}

/**
 * Per day of the last 28 (Europe/Oslo), the distinct commits touching the
 * effort's pages — one commit on three of them counts once, metadata stamps
 * included — and the distinct session events on them inside the sessions
 * window. Only days with activity are listed, oldest first.
 */
export function dailyActivity(
  pages: readonly string[],
  ctx: Pick<NormalizeContext, "nowMs" | "sessionsSinceMs" | "gitTouches" | "workEvents">,
): WorkMapDaily[] {
  const since = ctx.nowMs - 28 * DAY;
  const commits = new Map<string, Set<string>>();
  const sessions = new Map<string, Set<number>>();
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
      if (lastMs >= Math.max(since, ctx.sessionsSinceMs) && lastMs <= ctx.nowMs) add(sessions, osloDay(lastMs), lastMs);
    }
  }
  const days = [...new Set([...commits.keys(), ...sessions.keys()])].sort();
  return days.map((day) => ({ day, commits: commits.get(day)?.size ?? 0, sessions: sessions.get(day)?.size ?? 0 }));
}
