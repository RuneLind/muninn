/**
 * The organize run's prompt, built from a freshly rebuilt wiki index, the
 * wiki's `log.md` and the previous map. Pure: no IO, no clock but `nowMs`, so
 * the digest is unit-testable without a model.
 *
 * Ported from the activity-agent prototype's `digest()` (muninn
 * `docs/proto/activity-agent/agent.ts`), with three changes: the inputs are the
 * index's own fields rather than a listing snapshot, prose cites a page only as
 * `⟨p12⟩` (the one sigil `normalize.ts` rewrites), and the previous map goes in
 * so ids and names stay put.
 */

import { isMetaStem, pageStemOf } from "../../dashboard/views/components/wiki-filter.ts";
import { normalizeRelPath } from "../rel-path.ts";
import type { TouchRecord, MetadataFilterOutcome } from "../git-dates.ts";
import type { WikiPageMeta } from "../store.ts";
import type { WorkThread } from "../work-focus.ts";
import type { WorkMap } from "./schema.ts";

const DAY = 86_400_000;
/** Pages and commits reach back this far. */
export const WORK_MAP_TOUCH_WINDOW_DAYS = 28;
/** log.md entries reach back this far. */
export const WORK_MAP_LOG_WINDOW_DAYS = 15;
const LOG_ENTRIES_MAX = 120;
const THREAD_SESSIONS_MAX = 6;

/** The page fields the digest reads — a `WikiPageMeta` satisfies it. */
export type DigestPage = Pick<
  WikiPageMeta,
  | "relPath"
  | "title"
  | "type"
  | "project"
  | "plan_status"
  | "status_date"
  | "status_note"
  | "followups"
  | "movesYou"
  | "description"
  | "series"
  | "workedMs"
  | "gitTouchedMs"
  | "parent"
  | "culled"
  | "work"
> & { displayTitle?: string };

export interface DigestInput {
  wiki: string;
  nowMs: number;
  pages: readonly DigestPage[];
  /** `WikiIndex.outgoing`: normalized relPath → normalized target relPaths. */
  outgoing: ReadonlyMap<string, readonly string[]>;
  threads: readonly WorkThread[];
  sessionsSinceMs: number;
  sessionsAsOfMs: number;
  gitTouches: ReadonlyMap<string, readonly TouchRecord[]>;
  metadataFilter?: MetadataFilterOutcome;
  /** `log.md` as text, or null when the wiki has none. */
  logText: string | null;
  /** Resolve a `[[wikilink]]` target to a relPath (`WikiIndex.resolve`). */
  resolveLink: (target: string) => string | undefined;
  previous: WorkMap | null;
}

export interface WorkMapDigest {
  text: string;
  /** relPath → short id. */
  ids: Map<string, string>;
  /** short id → relPath. */
  rel: Map<string, string>;
  /** The active pages, newest work first. */
  active: string[];
  threads: number;
  logEntries: number;
}

/** Newest of the page's worked and touched times. */
function lastWork(p: DigestPage): number {
  return Math.max(p.workedMs ?? 0, p.gitTouchedMs ?? 0);
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Session titles: drop pasted blocks and absolute home paths. */
export function cleanSessionTitle(s: string | undefined): string {
  return clip((s ?? "").replace(/<pasted_content[^>]*>/g, "").replace(/\/Users\/\S+\/(?=[^/\s]+)/g, ""), 110);
}

interface LogEntry {
  day: string;
  kind: string;
  title: string;
  pages: string[];
}

/** `## [YYYY-MM-DD] kind | title` entries with the wikilinks of their first lines. */
export function parseLogEntries(text: string, sinceMs: number, resolveLink: (t: string) => string | undefined): LogEntry[] {
  const out: LogEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^## \[(\d{4}-\d{2}-\d{2})\] ([\w-]+) \| (.*)$/);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    if (!Number.isFinite(at) || at < sinceMs - DAY) continue;
    let body = m[3]!;
    for (let j = i + 1; j < Math.min(i + 4, lines.length) && !lines[j]!.startsWith("## "); j++) body += " " + lines[j];
    const linked = [...body.matchAll(/\[\[([^\]\n]+)\]\]/g)]
      .map((x) => resolveLink(x[1]!.split("|")[0]!.split("#")[0]!.trim()))
      .filter((r): r is string => !!r);
    out.push({ day: m[1]!, kind: m[2]!, title: m[3]!.replace(/\s*—\s*\[\[.*$/, ""), pages: [...new Set(linked)] });
  }
  return out;
}

/** The commits in `touches` at or after `sinceMs`, deduped by hash. */
function commitsSince(touches: readonly TouchRecord[] | undefined, sinceMs: number): TouchRecord[] {
  const seen = new Set<string>();
  const out: TouchRecord[] = [];
  for (const t of touches ?? []) {
    if (t.ts < sinceMs || seen.has(t.commit)) continue;
    seen.add(t.commit);
    out.push(t);
  }
  return out;
}

/**
 * The pages the run organizes: not a bookkeeping page, not an attachment
 * child, and worked or committed in the last 28 days or in a work thread
 * (a child in a thread counts for its parent). Newest work first.
 */
export function activePages(input: Pick<DigestInput, "pages" | "threads" | "nowMs">): DigestPage[] {
  const since = input.nowMs - WORK_MAP_TOUCH_WINDOW_DAYS * DAY;
  const byRel = new Map(input.pages.map((p) => [p.relPath, p]));
  const owner = (rel: string) => byRel.get(byRel.get(rel)?.parent ?? rel);
  const keep = new Set<DigestPage>();
  const eligible = (p: DigestPage | undefined): p is DigestPage =>
    !!p && p.parent === undefined && !isMetaStem(pageStemOf(p.relPath));
  for (const p of input.pages) {
    if (!eligible(p)) continue;
    if ((p.workedMs ?? 0) >= since || (p.gitTouchedMs ?? 0) >= since) keep.add(p);
  }
  for (const t of input.threads) {
    for (const rel of [...t.pages, ...t.touched]) {
      const p = owner(rel);
      if (eligible(p)) keep.add(p);
    }
  }
  return [...keep].sort((a, b) => lastWork(b) - lastWork(a) || a.relPath.localeCompare(b.relPath));
}

export const WORK_MAP_SYSTEM_PROMPT = `You organize a personal engineering wiki's recent activity for its single owner, a developer who runs many parallel AI-agent work sessions and returns to them later. The wiki holds plans (with plan_status: proposed/in-progress/shipped/…), archived reports, explainers, prototypes and reference pages. Your job: turn the activity data into a map the owner trusts.

Rules:
- An EFFORT is one piece of work the owner would name in conversation ("the activity feed", "dark mode", "årsavregning 2025"). Group by what the work is ABOUT and how pages derive from each other (plan → report → follow-up plan, shared series, links, log entries naming them together), not merely by sharing a session — sessions often touch unrelated pages.
- Every active page goes to exactly one effort or to "loose". Prefer 6–16 efforts. Small one-page efforts are fine when the page is truly separate. Use parent for sub-efforts.
- needsYou is ONLY for things that genuinely wait on the owner: an open decision/owner question, a plan marked waits-on-owner, follow-ups open after shipping, in-progress work gone quiet 5+ days, a page that probably drifted because a linked page changed after it. Cite the evidence. No filler; fewer is better; at most 6.
- Stability: when the previous map is given, keep an effort's id (and usually its name) while its pages overlap with what you group now. Mint a new id only for new work.
- Write names and prose in the language the wiki's titles use (Norwegian for a Norwegian wiki). Be concrete; never invent dates, statuses or numbers.

Page ids: pages are given short ids (p1, p2, …). In the id fields — efforts[].pages[].id, efforts[].pages[].derivedFrom, needsYou[].pages and loose — write the bare id exactly as given ("p12"). In prose fields (summary, oneLine, why, next, title, action, related[].why) cite a page ONLY as ⟨p12⟩, with those angle brackets; never write a bare page id in prose.

Effort ids: a short lowercase slug of a–z, 0–9 and "-" (e.g. "rail-activity"). parent, related[].id, themes[].efforts and needsYou[].effort name effort ids.

Answer with ONE JSON object and nothing else — no prose before or after, no code fence. Its shape:
{
  "summary": string,                       // 2–3 sentences: where the owner's attention went lately and what changed
  "needsYou": [{ "title": string, "kind": "decision"|"blocked"|"followup"|"resume"|"stale"|"drift"|"verify",
                 "why": string,            // the evidence, concrete
                 "action": string,         // the one next move, imperative, ≤ 12 words
                 "pages": [page id], "effort": effort id }],
  "themes": [{ "name": string, "efforts": [effort id] }],
  "efforts": [{ "id": effort id, "name": string,   // what the owner would call it, 2–5 words, not a file title
                "aliases": [string],                // other words the owner might search for
                "oneLine": string,                  // where it stands now, ≤ 20 words
                "state": "active"|"cooling"|"quiet"|"shipped"|"blocked"|"proposed",
                "parent": effort id or omitted,
                "pages": [{ "id": page id, "role": "plan"|"report"|"explainer"|"prototype"|"reference"|"followup"|"log"|"spin-off",
                            "derivedFrom": page id or omitted }],   // the page this one grew out of, inside the same effort
                "why": string,                      // why these pages belong together — the evidence
                "confidence": number,               // 0–1
                "next": string,
                "related": [{ "id": effort id, "why": string }] }],
  "loose": [page id]                       // active pages you could not place with confidence
}`;

/**
 * Build the digest. Short ids (`p1`…) keep the prompt small and are mapped
 * back to relPaths by `normalize.ts`; only active pages get one, so every id
 * the model may cite names an active page.
 */
export function buildWorkMapDigest(input: DigestInput): WorkMapDigest {
  const ids = new Map<string, string>();
  const rel = new Map<string, string>();
  const active = activePages(input);
  for (const p of active) {
    const id = `p${ids.size + 1}`;
    ids.set(p.relPath, id);
    rel.set(id, p.relPath);
  }
  const byRel = new Map(input.pages.map((p) => [p.relPath, p]));
  const ownerRel = (r: string) => byRel.get(r)?.parent ?? r;
  const idOf = (r: string) => ids.get(ownerRel(r));
  const listIds = (rs: readonly string[]) => [...new Set(rs.map(idOf).filter((x): x is string => !!x))].join(",");
  const now = input.nowMs;
  const ago = (ms?: number) => (ms ? `${Math.max(0, Math.round(((now - ms) / DAY) * 10) / 10)}d` : "–");
  const touchSince = now - WORK_MAP_TOUCH_WINDOW_DAYS * DAY;

  const pageLines = active.map((p) => {
    const commits = commitsSince(input.gitTouches.get(p.relPath), touchSince);
    const focus = (p.work?.events ?? []).filter((e) => e[2] === "focus").length;
    const bits = [
      `${ids.get(p.relPath)} "${clip(p.displayTitle ?? p.title, 140)}"`,
      p.type,
      p.project && `proj=${p.project}`,
      p.plan_status && `status=${p.plan_status}`,
      p.followups && `followups=${p.followups}`,
      p.movesYou && `waits-on-owner=${p.movesYou}`,
      p.culled && "retired",
      `worked=${ago(p.workedMs)}`,
      `commit=${ago(commits.length ? commits[commits.length - 1]!.ts : p.gitTouchedMs)}`,
      commits.length && `commits28d=${commits.length}`,
      focus && `focusEvents=${focus}`,
      p.series && `series=${p.series}`,
      p.status_date && `statusDate=${p.status_date}`,
      p.status_note && `note: ${clip(p.status_note, 180)}`,
      p.description && `desc: ${clip(p.description, 200)}`,
      `path=${p.relPath}`,
    ];
    return bits.filter(Boolean).join(" | ");
  });

  const threadLines = input.threads.map(
    (t, i) =>
      `T${i + 1} key=${idOf(t.key) ?? "–"} pages=[${listIds(t.pages)}] touched=[${listIds(t.touched)}]` +
      t.sessions
        .slice(0, THREAD_SESSIONS_MAX)
        .map((s) => `\n   session ${ago(s.last)} ago: ${cleanSessionTitle(s.title)}`)
        .join(""),
  );

  const log = input.logText
    ? parseLogEntries(input.logText, now - WORK_MAP_LOG_WINDOW_DAYS * DAY, input.resolveLink).slice(0, LOG_ENTRIES_MAX)
    : [];
  const logLines = log.map((e) => `${e.day} ${e.kind}: ${clip(e.title, 120)} → [${listIds(e.pages)}]`);

  const keyToRel = new Map(input.pages.map((p) => [normalizeRelPath(p.relPath), p.relPath]));
  const linkLines: string[] = [];
  for (const p of active) {
    const targets = (input.outgoing.get(normalizeRelPath(p.relPath)) ?? [])
      .map((k) => keyToRel.get(k))
      .filter((r): r is string => !!r && idOf(r) !== undefined && idOf(r) !== ids.get(p.relPath));
    const list = listIds(targets);
    if (list) linkLines.push(`${ids.get(p.relPath)} → ${list}`);
  }

  const prevLines = (input.previous?.efforts ?? []).map((e) => {
    const inSet = e.pages.map((pg) => ids.get(pg.id)).filter((x): x is string => !!x);
    const outside = e.pages.length - inSet.length;
    const aliases = e.aliases.length ? ` (${e.aliases.join(", ")})` : "";
    return `${e.id}: ${e.name}${aliases}${e.parent ? ` parent=${e.parent}` : ""} — pages [${inSet.join(",")}]${outside ? ` +${outside} not active now` : ""}`;
  });

  const days = (ms: number) => Math.round(ms / DAY);
  const filter = input.metadataFilter;
  const filterLine =
    filter && filter.degraded
      ? ` Tonight the git walk could not filter out every metadata-only commit (${filter.reason === "steps" ? `${filter.pages} page(s) hit the step limit` : "it ran out of time"}), so a burst of lint or stamp commits may show as recent commits.`
      : "";
  const coverageLine =
    `WIKI: ${input.wiki}. Now = ${new Date(now).toISOString().slice(0, 16)}Z. ` +
    `Work threads and session events cover the last ${days(input.sessionsAsOfMs - input.sessionsSinceMs)} days; ` +
    `worked times are all-time; commit times reach back ${WORK_MAP_TOUCH_WINDOW_DAYS} days; log.md entries ${WORK_MAP_LOG_WINDOW_DAYS} days. ` +
    `Older work shows only as commits and log entries.${filterLine}`;

  const sections = [
    coverageLine,
    `\n## Pages active in the last ${WORK_MAP_TOUCH_WINDOW_DAYS} days (newest work first)\n${pageLines.join("\n")}`,
    `\n## Work threads the current rail derives from shared sessions (may be wrong)\n${threadLines.join("\n")}`,
    `\n## log.md, last ${WORK_MAP_LOG_WINDOW_DAYS} days\n${logLines.join("\n")}`,
    `\n## Wikilinks between active pages\n${linkLines.join("\n")}`,
  ];
  if (prevLines.length) {
    sections.push(
      `\n## The previous map (${new Date(input.previous!.runAtMs).toISOString().slice(0, 10)}) — keep an id while its pages overlap\n${prevLines.join("\n")}`,
    );
  }
  return { text: sections.join("\n"), ids, rel, active: active.map((p) => p.relPath), threads: input.threads.length, logEntries: log.length };
}
