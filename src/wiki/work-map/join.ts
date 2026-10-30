/**
 * `joinWorkMap(map, pages)` — the one helper every work-map surface joins the
 * stored map to the live listing through. By relPath, so a page renamed or
 * deleted since the run drops out of its effort rather than linking nowhere.
 */

import path from "node:path";

import { normalizeRelPath } from "../rel-path.ts";
import { declaredEffortOf, roleFromFolder } from "./ids.ts";
import type { WorkMap, WorkMapEffort } from "./schema.ts";

export interface JoinedEffortPage<P> {
  id: string;
  role: WorkMapEffort["pages"][number]["role"];
  derivedFrom?: string;
  page: P;
}

export type JoinedEffort<P> = Omit<WorkMapEffort, "pages"> & { pages: JoinedEffortPage<P>[] };

export type JoinedWorkMap<P> = Omit<WorkMap, "efforts" | "loose" | "needsYou"> & {
  efforts: JoinedEffort<P>[];
  needsYou: (WorkMap["needsYou"][number] & { pages: string[] })[];
  loose: P[];
};

/**
 * Keep only map pages the listing still holds, each joined to its page; a
 * `derivedFrom` naming a page that dropped out is cleared. An effort left with
 * no pages stays (the card can still say it existed); a page's relPath is
 * rewritten to the listing's spelling. A prose marker `⟦relPath⟧` to a page
 * the listing no longer holds becomes its file stem (the map keeps no titles).
 * A duplicate effort id keeps the first effort, so every surface sees unique ids.
 *
 * A listed page that declares an effort the map holds in `efforts` (P6) joins
 * it at once, so a page declared after the run shows under its effort before
 * the next one: it leaves the effort or loose list the map put it in, keeping
 * its role but not its `derivedFrom`; a page outside the map's page list gets
 * its folder's role (`roleFromFolder`). An id only in `retired`, or in
 * neither, moves nothing.
 */
export function joinWorkMap<P extends { relPath: string; effort?: string }>(map: WorkMap, pages: readonly P[]): JoinedWorkMap<P> {
  const byKey = new Map(pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const find = (rel: string) => byKey.get(normalizeRelPath(rel));
  const text = (s: string) =>
    s.replace(/⟦([^⟧]+)⟧/g, (_m, rel: string) => {
      const page = find(rel);
      return page ? `⟦${page.relPath}⟧` : path.posix.basename(rel).replace(/\.[^.]+$/, "");
    });
  const efforts = map.efforts.filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i).map((e) => {
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
      };
    });
  let loose = map.loose.map(find).filter((p): p is P => !!p);
  const ids = new Set(efforts.map((e) => e.id));
  for (const page of pages) {
    const slug = declaredEffortOf(page);
    if (slug === undefined || !ids.has(slug)) continue;
    const key = normalizeRelPath(page.relPath);
    const target = efforts.find((e) => e.id === slug)!;
    if (target.pages.some((p) => normalizeRelPath(p.id) === key)) continue;
    let role: JoinedEffortPage<P>["role"] = roleFromFolder(page.relPath);
    for (const e of efforts) {
      const at = e.pages.findIndex((p) => normalizeRelPath(p.id) === key);
      if (at < 0) continue;
      role = e.pages[at]!.role;
      e.pages.splice(at, 1);
    }
    loose = loose.filter((p) => normalizeRelPath(p.relPath) !== key);
    target.pages.push({ id: page.relPath, role, page });
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
