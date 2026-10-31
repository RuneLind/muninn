/**
 * The `themes` kind's prompt: one line per source page created in the window,
 * one line per hub page two or more of them link, and the previous map's
 * themes. Ported from the probe (`plans/muninn-wiki-theme-map-probe/`,
 * `digest.py` + `system.txt`). Pure: no IO, no clock but `nowMs`.
 *
 * The runner computes every number the model sees (link counts, sources
 * since a hub's `updated:`), so the model never counts. Drift is read from
 * `updated:` and source `created:` dates, never from git touch dates: the
 * source drafter's `## See also` wiring commit touches every hub it links.
 */

import { isMetaStem, pageStemOf } from "../../dashboard/views/components/wiki-filter.ts";
import { normalizeRelPath } from "../rel-path.ts";
import type { WikiPageMeta } from "../store.ts";
import { osloDay } from "./ids.ts";
import type { ThemeMap } from "./theme-schema.ts";

const DAY = 86_400_000;
/** Sources created in this many days (the run day included) are active. */
export const THEME_WINDOW_DAYS = 28;
/** The trend compares the newest this-many days with the rest of the window. */
export const THEME_RECENT_DAYS = 14;
/** Source lines in the digest; the rest are cut with a coverage warning. */
export const THEME_SOURCES_MAX = 300;
/** A hub enters the digest when this many active sources link it. */
export const THEME_HUB_MIN_LINKS = 2;
/** Drift: at least this many active sources created after the hub's `updated:` … */
export const THEME_DRIFT_MIN_SINCE = 20;
/** … and at least this share of its active linking sources. */
export const THEME_DRIFT_MIN_SHARE = 0.5;

/** The page fields the theme digest reads — a `WikiPageMeta` satisfies it. */
export type ThemeDigestPage = Pick<WikiPageMeta, "relPath" | "name" | "title" | "type" | "domain" | "tags" | "created" | "updated" | "gitCreatedMs" | "culled" | "parent"> & {
  displayTitle?: string;
};

export interface ThemeDigestInput {
  wiki: string;
  nowMs: number;
  pages: readonly ThemeDigestPage[];
  /** `WikiIndex.outgoing`: normalized relPath → normalized target relPaths. */
  outgoing: ReadonlyMap<string, readonly string[]>;
  previous: ThemeMap | null;
}

export interface ThemeSource {
  relPath: string;
  /** `YYYY-MM-DD`. */
  created: string;
  domain: "ai" | "life";
}

export interface ThemeHub {
  relPath: string;
  name: string;
  folder: string;
  /** Active sources linking it. */
  links: number;
  /** `updated:` (else `created:`) as `YYYY-MM-DD`; absent when it has neither. */
  updated?: string;
  /** Active linking sources created strictly after `updated`. */
  sinceUpdate: number;
  share: number;
  drift: boolean;
}

export interface ThemeDigest {
  text: string;
  /** short id → relPath, the listed sources only. */
  rel: Map<string, string>;
  ids: Map<string, string>;
  /** Every active source, newest first (cut ones included). */
  active: ThemeSource[];
  /** Active sources left out of the digest by the cap. */
  cut: number;
  /** The digest's hubs, most-linked first. */
  hubs: ThemeHub[];
  /** Lowercased printed hub name (a hub line or a link target) → relPath, for the normalizer. */
  hubByName: Map<string, string>;
  /** Lowercased names that could mean more than one printed page (`printedHubNames`): refused. */
  ambiguousHubNames: Set<string>;
  windowStart: string;
  runDay: string;
}

/** `YYYY-MM-DD` + `n` days (UTC calendar arithmetic). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** A page's creation day: frontmatter `created:` when it starts with a date,
 *  else its first commit's Oslo day; undefined when it has neither. */
export function createdDayOf(p: Pick<ThemeDigestPage, "created" | "gitCreatedMs">): string | undefined {
  const m = p.created?.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m && Number.isFinite(Date.parse(m[1]!))) return m[1]!;
  return p.gitCreatedMs ? osloDay(p.gitCreatedMs) : undefined;
}

/** A source page: `type: source` under `sources/` or `life/sources/`, not an
 *  aggregator (`Sources — *`), not culled, not an attachment. */
export function isThemeSource(p: ThemeDigestPage): boolean {
  if (p.type !== "source" || p.culled || p.parent !== undefined) return false;
  if (!/^(life\/)?sources\//.test(p.relPath)) return false;
  return !/^sources\s+—/i.test(pageStemOf(p.relPath));
}

/** A page a source's link may name as a hub: not a source, not a bookkeeping page. */
export function isHubCandidate(p: ThemeDigestPage): boolean {
  return p.type !== "source" && !/^(life\/)?sources\//.test(p.relPath) && !isMetaStem(pageStemOf(p.relPath)) && !p.culled;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const stemOf = (rel: string) => pageStemOf(rel);

export const THEME_MAP_SYSTEM_PROMPT = `You organize a personal KNOWLEDGE wiki for its single owner. The owner does not write these pages: an automated pipeline turns every video, article or post the owner chose to capture into one source page, and links it to hub pages (concepts, entities). The owner reads the wiki to see trends and learn. Your job: a map of what the owner has been following lately and how the topics connect.

Rules:
- A THEME is a topic the owner is following, named as they would say it ("verification loops for coding agents", "the AI bubble debate"). Group sources by what they are ABOUT, using titles, tags and shared hub links. Every source goes to exactly one theme or to "loose". Prefer 8–16 themes. A theme of one source is allowed only when it is truly separate. Place as many sources as you can: loose is for a source that fits no theme at all.
- Each theme names its anchor hub pages (from the hub list, by their exact name), the 1–3 sources most worth reading first, the takeaway so far (what the sources together say, concrete, ≤ 40 words), and where the sources disagree, when they do.
- connections: pairs of themes that bear on each other, with the reason (shared hubs, one theme's claim affecting another). This is the "connected issues" view: be specific, at most 12.
- worthALook: at most 6 items that deserve the owner's attention: a GAP (a recurring subject with 3+ sources and no hub page), DRIFT (a hub page marked DRIFT in the hub list: many sources arrived after it was last updated), a CONTRADICTION between sources, or a SHIFT (a new thread of thinking that changes an older theme). Use drift ONLY for a hub marked DRIFT, and name that hub in hubs. Cite evidence. Fewer is better.
- Do not count or compute trends yourself; the runner computes counts per week from dates. Never invent numbers.
- Life sources (domain=life) are a separate domain: group them in their own themes, never with AI themes.
- Stability: when the previous map is given, keep a theme's id (and usually its name) while its sources overlap with what you group now. Mint a new id only for a new topic. Retired themes are listed by id and name: when tonight's sources continue one, reuse its id.
Theme ids: a short lowercase slug of a–z, 0–9 and "-" (e.g. "agent-harness-design").
Page ids: cite sources as bare ids ("p12") in id fields (sources, readFirst, loose, worthALook[].sources), and ONLY as ⟨p12⟩ in prose. Hub pages are cited by their exact name.
Answer with ONE JSON object and nothing else — no prose before or after, no code fence:
{"summary": string (2–3 sentences: what the owner's reading was about lately and what is new),
 "themes":[{"id": slug,"name": string,"domain":"ai"|"life","oneLine": string,"hubs":[hub name],"sources":[id],"readFirst":[id],"takeaway": string,"disagreement": string or "","confidence": number}],
 "connections":[{"a": theme id,"b": theme id,"why": string}],
 "worthALook":[{"kind":"gap"|"drift"|"contradiction"|"shift","title": string,"why": string,"action": string,"sources":[id],"hubs":[hub name],"theme": theme id}],
 "loose":[id]}`;

/**
 * A name for every hub page the digest prints (a hub line or a source's link
 * target), unique over that whole set: the bare stem when no other printed
 * page shares it (ignoring case), else `folder/stem`, else the relPath with its
 * extension. `hubByName` maps each lowercased printed name back to its page;
 * `ambiguousHubNames` holds every shorter form a colliding page did not get
 * (its bare stem, its `folder/stem`) and any printed name two pages share, so
 * an answer naming one resolves to nothing instead of an arbitrary page.
 */
export function printedHubNames(rels: Iterable<string>): { nameOf: Map<string, string>; hubByName: Map<string, string>; ambiguousHubNames: Set<string> } {
  const byStem = new Map<string, string[]>();
  for (const r of rels) {
    const k = stemOf(r).toLowerCase();
    byStem.set(k, [...(byStem.get(k) ?? []), r]);
  }
  const nameOf = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [stem, group] of byStem) {
    if (group.length === 1) {
      nameOf.set(group[0]!, stemOf(group[0]!));
      continue;
    }
    ambiguous.add(stem);
    const short = (r: string) => {
      const dir = r.split("/").slice(0, -1).join("/");
      return dir ? `${dir}/${stemOf(r)}` : undefined;
    };
    const shortCount = new Map<string, number>();
    for (const r of group) {
      const q = short(r)?.toLowerCase();
      if (q) shortCount.set(q, (shortCount.get(q) ?? 0) + 1);
    }
    for (const r of group) {
      const q = short(r);
      if (q && shortCount.get(q.toLowerCase()) === 1) nameOf.set(r, q);
      else {
        if (q) ambiguous.add(q.toLowerCase());
        nameOf.set(r, r);
      }
    }
  }
  const owners = new Map<string, string[]>();
  for (const [r, n] of nameOf) owners.set(n.toLowerCase(), [...(owners.get(n.toLowerCase()) ?? []), r]);
  const hubByName = new Map<string, string>();
  for (const [n, rs] of owners) {
    if (rs.length > 1 || ambiguous.has(n)) ambiguous.add(n);
    else hubByName.set(n, rs[0]!);
  }
  return { nameOf, hubByName, ambiguousHubNames: ambiguous };
}

/** The active sources of `pages` at `nowMs`, newest first. */
export function activeSources(pages: readonly ThemeDigestPage[], nowMs: number): ThemeSource[] {
  const runDay = osloDay(nowMs);
  const windowStart = addDays(runDay, -(THEME_WINDOW_DAYS - 1));
  const out: ThemeSource[] = [];
  for (const p of pages) {
    if (!isThemeSource(p)) continue;
    const created = createdDayOf(p);
    if (!created || created < windowStart || created > runDay) continue;
    out.push({ relPath: p.relPath, created, domain: p.domain });
  }
  return out.sort((a, b) => b.created.localeCompare(a.created) || a.relPath.localeCompare(b.relPath));
}

/** Build the theme digest. */
export function buildThemeMapDigest(input: ThemeDigestInput): ThemeDigest {
  const runDay = osloDay(input.nowMs);
  const windowStart = addDays(runDay, -(THEME_WINDOW_DAYS - 1));
  const active = activeSources(input.pages, input.nowMs);
  const listed = active.slice(0, THEME_SOURCES_MAX);
  const ids = new Map<string, string>();
  const rel = new Map<string, string>();
  for (const s of listed) {
    const id = `p${ids.size + 1}`;
    ids.set(s.relPath, id);
    rel.set(id, s.relPath);
  }
  const byRel = new Map(input.pages.map((p) => [p.relPath, p]));
  const keyToRel = new Map(input.pages.map((p) => [normalizeRelPath(p.relPath), p.relPath]));

  // Hub links per active source (every active source counts, cut ones too).
  const hubLinks = new Map<string, string[]>();
  const linkers = new Map<string, ThemeSource[]>();
  for (const s of active) {
    const targets = new Set<string>();
    for (const k of input.outgoing.get(normalizeRelPath(s.relPath)) ?? []) {
      const r = keyToRel.get(k);
      const hp = r ? byRel.get(r) : undefined;
      if (hp && isHubCandidate(hp)) targets.add(hp.relPath);
    }
    hubLinks.set(s.relPath, [...targets]);
    for (const h of targets) linkers.set(h, [...(linkers.get(h) ?? []), s]);
  }

  const hubs: ThemeHub[] = [];
  for (const [h, srcs] of linkers) {
    if (srcs.length < THEME_HUB_MIN_LINKS) continue;
    const hp = byRel.get(h)!;
    const updated = hp.updated?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? createdDayOf(hp);
    const sinceUpdate = updated ? srcs.filter((s) => s.created > updated).length : 0;
    const share = srcs.length ? sinceUpdate / srcs.length : 0;
    hubs.push({
      relPath: h,
      name: stemOf(h),
      folder: h.split("/").slice(0, -1).join("/") || "/",
      links: srcs.length,
      ...(updated ? { updated } : {}),
      sinceUpdate,
      share,
      drift: sinceUpdate >= THEME_DRIFT_MIN_SINCE && share >= THEME_DRIFT_MIN_SHARE,
    });
  }
  hubs.sort((a, b) => b.links - a.links || a.relPath.localeCompare(b.relPath));
  const printed = new Set([...hubs.map((h) => h.relPath), ...listed.flatMap((s) => hubLinks.get(s.relPath) ?? [])]);
  const { nameOf, hubByName, ambiguousHubNames } = printedHubNames(printed);
  for (const h of hubs) h.name = nameOf.get(h.relPath)!;

  const sourceLines = listed.map((s) => {
    const p = byRel.get(s.relPath)!;
    const links = (hubLinks.get(s.relPath) ?? []).map((r) => nameOf.get(r)!).sort((a, b) => a.localeCompare(b));
    return [
      `${ids.get(s.relPath)} "${clip(p.displayTitle ?? p.title, 160)}"`,
      s.domain,
      `created=${s.created}`,
      `tags=${p.tags.join(", ")}`,
      `links=[${links.join("; ")}]`,
    ].join(" | ");
  });
  const hubLines = hubs.map(
    (h) =>
      `${h.name} | ${h.folder} | linked by ${h.links} recent sources | page updated=${h.updated ?? "–"} | ${h.sinceUpdate} created since that update` +
      (h.drift ? " | DRIFT" : ""),
  );

  const prev = input.previous;
  // A member past the cap is still active: "not active now" would tell the model it is gone.
  const activeRels = new Set(active.map((s) => s.relPath));
  const prevLines = (prev?.efforts ?? []).map((t) => {
    const inSet = t.pages.map((pg) => ids.get(pg.id)).filter((x): x is string => !!x);
    const unlisted = t.pages.filter((pg) => !ids.has(pg.id) && activeRels.has(pg.id)).length;
    const gone = t.pages.length - inSet.length - unlisted;
    return (
      `${t.id}: ${t.name} (${t.domain}) — sources [${inSet.join(",")}]` +
      (unlisted ? ` +${unlisted} not listed` : "") +
      (gone ? ` +${gone} not active now` : "")
    );
  });
  const retiredLines = (prev?.retired ?? []).map((r) => `${r.id}: ${r.name} — last active ${new Date(r.lastActive).toISOString().slice(0, 10)}`);

  const head =
    `WIKI: ${input.wiki} (a personal knowledge wiki of captured AI/tech and life sources). Now = ${new Date(input.nowMs).toISOString().slice(0, 16)}Z. ` +
    `Window: sources created in the last ${THEME_WINDOW_DAYS} days (${windowStart} to ${runDay})` +
    (active.length > listed.length ? `; the newest ${listed.length} of ${active.length} are listed` : "") +
    ".";
  const sections = [
    head,
    `\n## Recent sources (newest first)\n${sourceLines.join("\n")}`,
    `\n## Hub pages (concepts/entities) linked by ${THEME_HUB_MIN_LINKS}+ of these sources\n${hubLines.join("\n")}`,
  ];
  if (prevLines.length) {
    sections.push(`\n## The previous map (${new Date(prev!.runAtMs).toISOString().slice(0, 10)}) — keep a theme's id while its sources overlap\n${prevLines.join("\n")}`);
  }
  if (retiredLines.length) {
    sections.push(`\n## Retired themes — themes an earlier map no longer kept (dropped, merged, or their sources went quiet); reuse an id when its topic returns (a reused id is not new)\n${retiredLines.join("\n")}`);
  }
  return { text: sections.join("\n"), rel, ids, active, cut: active.length - listed.length, hubs, hubByName, ambiguousHubNames, windowStart, runDay };
}
