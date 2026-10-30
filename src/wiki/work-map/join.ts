/**
 * `joinWorkMap(map, pages)` — the one helper every work-map surface joins the
 * stored map to the live listing through. By relPath, so a page renamed or
 * deleted since the run drops out of its effort rather than linking nowhere.
 */

import path from "node:path";

import { normalizeRelPath } from "../rel-path.ts";
import { declaredEffortOf, pageNewerThanRun, pageNewestMs, roleFromFolder, type DatedPage } from "./ids.ts";
import type { WorkMap, WorkMapEffort } from "./schema.ts";

export interface JoinedEffortPage<P> {
  id: string;
  role: WorkMapEffort["pages"][number]["role"];
  derivedFrom?: string;
  page: P;
  /** Placed by the reader from the page's `effort:`, not by the run (P6). */
  joined?: true;
}

export type JoinedEffort<P> = Omit<WorkMapEffort, "pages"> & {
  pages: JoinedEffortPage<P>[];
  /** Map pages of this effort that now declare another effort, and where to. */
  movedOut: { id: string; to: string }[];
};

export type JoinedWorkMap<P> = Omit<WorkMap, "efforts" | "loose" | "needsYou"> & {
  efforts: JoinedEffort<P>[];
  needsYou: (WorkMap["needsYou"][number] & { pages: string[] })[];
  loose: P[];
};

/** The listing fields the join reads. */
export type JoinablePage = { relPath: string; effort?: string } & DatedPage;

/**
 * Keep only map pages the listing still holds, each joined to its page; a
 * `derivedFrom` naming a page that dropped out is cleared. An effort left with
 * no pages stays (the card can still say it existed); a page's relPath is
 * rewritten to the listing's spelling. A prose marker `⟦relPath⟧` to a page
 * the listing no longer holds becomes its file stem (the map keeps no titles).
 * A duplicate effort id keeps the first effort, so every surface sees unique ids.
 *
 * Declared pages (P6) join at once, so a page written today shows under its
 * effort before the next run. For a listed page whose valid `effort:` names S,
 * where S is in the map's `efforts` or `retired`:
 * - a map page (in an effort or in loose) declaring another effort leaves it
 *   (recorded in that effort's `movedOut`) and, when S is in `efforts`, joins
 *   S keeping its role but not its `derivedFrom`;
 * - a page the map does not hold joins S only when it is newer than the run
 *   ({@link pageNewerThanRun}), with its folder's role; older declared pages
 *   stay out of the reader as they stay out of the map;
 * - a page declaring a retired id shows on that id's effort page only.
 * Joined pages list first in their effort, newest first. An unknown or invalid
 * id moves nothing.
 */
export function joinWorkMap<P extends JoinablePage>(map: WorkMap, pages: readonly P[]): JoinedWorkMap<P> {
  const byKey = new Map(pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const find = (rel: string) => byKey.get(normalizeRelPath(rel));
  const text = (s: string) =>
    s.replace(/⟦([^⟧]+)⟧/g, (_m, rel: string) => {
      const page = find(rel);
      return page ? `⟦${page.relPath}⟧` : path.posix.basename(rel).replace(/\.[^.]+$/, "");
    });
  const efforts: JoinedEffort<P>[] = map.efforts
    .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
    .map((e) => {
      const joined: JoinedEffortPage<P>[] = [];
      for (const pg of e.pages) {
        const page = find(pg.id);
        if (!page) continue;
        const from = pg.derivedFrom !== undefined ? find(pg.derivedFrom) : undefined;
        joined.push({ id: page.relPath, role: pg.role, ...(from ? { derivedFrom: from.relPath } : {}), page });
      }
      return {
        ...e,
        oneLine: text(e.oneLine),
        why: text(e.why),
        next: text(e.next),
        related: e.related.map((r) => ({ ...r, why: text(r.why) })),
        pages: joined,
        movedOut: [],
      };
    });
  let loose = map.loose.map(find).filter((p): p is P => !!p);

  const byId = new Map(efforts.map((e) => [e.id, e]));
  const retired = new Set((map.retired ?? []).map((r) => r.id));
  const looseKeys = new Set(loose.map((p) => normalizeRelPath(p.relPath)));
  const arrivals = new Map<string, JoinedEffortPage<P>[]>();
  for (const page of pages) {
    const slug = declaredEffortOf(page);
    if (slug === undefined || (!byId.has(slug) && !retired.has(slug))) continue;
    const key = normalizeRelPath(page.relPath);
    const home = efforts.find((e) => e.pages.some((p) => normalizeRelPath(p.id) === key));
    if (home?.id === slug) continue;
    const inMap = home !== undefined || looseKeys.has(key);
    if (!inMap && !pageNewerThanRun(page, map.runAtMs)) continue;
    let role: JoinedEffortPage<P>["role"] = roleFromFolder(page.relPath);
    if (home) {
      const at = home.pages.findIndex((p) => normalizeRelPath(p.id) === key);
      role = home.pages[at]!.role;
      home.pages.splice(at, 1);
      home.movedOut.push({ id: page.relPath, to: slug });
    }
    if (looseKeys.has(key)) loose = loose.filter((p) => normalizeRelPath(p.relPath) !== key);
    if (!byId.has(slug)) continue;
    arrivals.set(slug, [...(arrivals.get(slug) ?? []), { id: page.relPath, role, page, joined: true }]);
  }
  for (const [slug, list] of arrivals) {
    const target = byId.get(slug)!;
    list.sort((a, b) => pageNewestMs(b.page) - pageNewestMs(a.page));
    target.pages = [...list, ...target.pages];
  }

  return {
    ...map,
    summary: text(map.summary),
    efforts,
    needsYou: map.needsYou.map((n) => ({
      ...n,
      title: text(n.title),
      why: text(n.why),
      action: text(n.action),
      pages: n.pages.map(find).filter((p): p is P => !!p).map((p) => p.relPath),
    })),
    loose,
  };
}

/**
 * What the listing says about declared pages that a join reads: each valid
 * declaration with whether the page is newer than the run. The card re-joins
 * when this changes though the run did not.
 */
export function declarationKey(pages: readonly JoinablePage[], runAtMs: number): string {
  return pages
    .flatMap((p) => {
      const slug = declaredEffortOf(p);
      return slug === undefined ? [] : [`${normalizeRelPath(p.relPath)}\u0000${slug}\u0000${pageNewerThanRun(p, runAtMs) ? 1 : 0}\u0000${pageNewestMs(p)}`];
    })
    .sort()
    .join("\u0001");
}
