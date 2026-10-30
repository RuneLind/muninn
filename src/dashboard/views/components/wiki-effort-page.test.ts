import { describe, expect, test } from "bun:test";
import { WORK_MAP_VERSION, type WorkMap } from "../../../wiki/work-map/schema.ts";
import { joinWorkMap, type JoinedEffortPage } from "../../../wiki/work-map/join.ts";
import { osloDay } from "../../../wiki/work-map/ids.ts";
import {
  activityStrip,
  activityStripHtml,
  canonicalEffortParam,
  effortStatusHtml,
  effortUrl,
  effortView,
  lineageOrder,
  lookupEffort,
  stripDayLabel,
  STRIP_DAYS,
  STRIP_SESSION_DAYS,
  type EffortPageListing,
} from "./wiki-effort-page.ts";
import { workCardHtml } from "./wiki-work-card.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Effort = WorkMap["efforts"][number];
function effort(id: string, pages: (string | [string, string])[], extra: Partial<Effort> = {}): Effort {
  return {
    id,
    name: `Effort ${id}`,
    aliases: [],
    oneLine: "",
    state: "active",
    pages: pages.map((p) => (Array.isArray(p) ? { id: p[0], role: "plan" as const, derivedFrom: p[1] } : { id: p, role: "plan" as const })),
    why: "",
    confidence: 0.8,
    next: "",
    related: [],
    daily: [],
    ...extra,
  };
}

function map(over: Partial<WorkMap> = {}): WorkMap {
  return {
    version: WORK_MAP_VERSION,
    wiki: "w",
    runAtMs: NOW - 2 * HOUR,
    model: "m",
    coverage: { sessionsSinceMs: NOW - 8 * DAY, sessionsAsOfMs: NOW, touchWindowDays: 28, activePages: 3, threads: 1, logEntries: 1, digestChars: 1, warnings: [] },
    summary: "",
    needsYou: [],
    themes: [],
    efforts: [],
    loose: [],
    ...over,
  };
}

const PAGES: EffortPageListing[] = [
  { relPath: "plans/a.mdx", title: "Plan A", plan_status: "in-flight" },
  { relPath: "plans/b.mdx", title: "Plan <B>" },
  { relPath: "plans/c.mdx", title: "Plan C" },
  { relPath: "plans/d.mdx", title: "Plan D" },
];
const href = (rel: string) => `/wiki?relPath=${encodeURIComponent(rel)}`;
const effortHref = (id: string) => `/wiki?effort=${id}`;

function view(m: WorkMap, id: string, over: Partial<Parameters<typeof effortView>[0]> = {}) {
  return effortView({
    map: m,
    pages: PAGES,
    id,
    wiki: "w",
    startHref: "/wiki?wiki=w",
    hrefFor: href,
    effortHref,
    pill: (p) => (p.plan_status ? `<span class="pill">${p.plan_status}</span>` : ""),
    now: NOW,
    ...over,
  });
}

function jp(id: string, derivedFrom?: string): JoinedEffortPage<{ relPath: string }> {
  return { id, role: "plan", ...(derivedFrom ? { derivedFrom } : {}), page: { relPath: id } };
}

describe("lineageOrder", () => {
  test("a derivedFrom chain follows its root depth-first, children in map order", () => {
    const rows = lineageOrder([jp("c", "b"), jp("a"), jp("b", "a"), jp("d", "a")]);
    expect(rows.map((r) => [r.page.id, r.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["d", 1],
    ]);
  });

  test("an orphan (derivedFrom outside the effort) is a root in map order", () => {
    const rows = lineageOrder([jp("x", "elsewhere"), jp("a"), jp("b", "a")]);
    expect(rows.map((r) => [r.page.id, r.depth])).toEqual([
      ["x", 0],
      ["a", 0],
      ["b", 1],
    ]);
  });

  test("a cycle still shows every page once", () => {
    const rows = lineageOrder([jp("a", "b"), jp("b", "a"), jp("c")]);
    expect(rows.map((r) => r.page.id).sort()).toEqual(["a", "b", "c"]);
    expect(rows).toHaveLength(3);
  });
});

describe("activityStrip", () => {
  const run = NOW - 2 * HOUR;
  const today = osloDay(run);
  const ago = (n: number) => osloDay(run - n * DAY);

  test("the Oslo days the 28-day window touches (29 for this run), ending on the run's day; missing days read as zero", () => {
    const days = activityStrip([{ day: ago(3), commits: 2, sessions: 1 }], run);
    expect(days).toHaveLength(STRIP_DAYS + 1);
    expect(days[days.length - 1]!.day).toBe(today);
    expect(days[0]!.day).toBe(ago(28));
    expect(days.find((d) => d.day === ago(3))).toEqual({ day: ago(3), commits: 2, sessions: 1 });
    expect(days.find((d) => d.day === ago(4))).toEqual({ day: ago(4), commits: 0, sessions: 0 });
  });

  test("days before the sessions window carry no session count; from its first Oslo day on (9 days for this run) they do", () => {
    const days = activityStrip([{ day: ago(10), commits: 1, sessions: 0 }], run);
    expect(days.filter((d) => d.sessions !== null)).toHaveLength(STRIP_SESSION_DAYS + 1);
    expect(days.find((d) => d.day === ago(10))!.sessions).toBeNull();
    expect(days.find((d) => d.day === ago(9))!.sessions).toBeNull();
    expect(days.find((d) => d.day === ago(8))!.sessions).toBe(0);
  });

  test("a stored session count before the window is shown, not dropped, and opens the session run there", () => {
    const days = activityStrip([{ day: ago(10), commits: 1, sessions: 4 }], run);
    expect(days.find((d) => d.day === ago(10))!.sessions).toBe(4);
    expect(days.find((d) => d.day === ago(11))!.sessions).toBeNull();
    expect(days.find((d) => d.day === ago(9))!.sessions).toBe(0);
  });

  test("a 0-session day says only its commits; an empty day says no activity", () => {
    expect(stripDayLabel({ day: "2026-10-27", commits: 3, sessions: 0 })).toBe("2026-10-27: 3 commits");
    expect(stripDayLabel({ day: "2026-10-27", commits: 1, sessions: 2 })).toBe("2026-10-27: 1 commit, 2 sessions");
    expect(stripDayLabel({ day: "2026-10-01", commits: 0, sessions: null })).toBe("2026-10-01: no activity");
  });

  test("the html marks the commits-only run and never prints 0 sessions", () => {
    const html = activityStripHtml([{ day: ago(1), commits: 3, sessions: 0 }, { day: ago(12), commits: 1, sessions: 0 }], run);
    expect(html).toContain("earlier · commits only");
    expect(html).toContain("Sessions are counted from 2026-10-21 on.");
    expect(html).not.toMatch(/0 sessions?/);
    expect(html).toContain("4 commits on 2 days");
    expect(html.match(/class="wiki-ef-day/g)).toHaveLength(29);
    expect(html.match(/wiki-ef-day[^"]* old/g)).toHaveLength(20);
    expect(html).not.toContain("wiki-ef-sess");
  });

  // The run at 10:00 on 10-29 (Oslo, UTC+1): `dailyActivity`'s rolling windows
  // reach back into 10-21 for sessions and 10-01 for commits.
  test("a stored session count on the 8-day window's first, partial day is kept", () => {
    const days = activityStrip([{ day: "2026-10-21", commits: 0, sessions: 2 }], run);
    expect(days.find((d) => d.day === "2026-10-21")).toEqual({ day: "2026-10-21", commits: 0, sessions: 2 });
    const html = activityStripHtml([{ day: "2026-10-21", commits: 0, sessions: 2 }], run);
    expect(html).toContain("2 sessions since 2026-10-21");
    expect(html).toContain('title="2026-10-21: 2 sessions"><span class="wiki-ef-sess"');
  });

  test("a stored commit count on the 28-day window's first, partial day is kept", () => {
    const days = activityStrip([{ day: "2026-10-01", commits: 1, sessions: 0 }], run);
    expect(days[0]).toEqual({ day: "2026-10-01", commits: 1, sessions: null });
    expect(activityStripHtml([{ day: "2026-10-01", commits: 1, sessions: 0 }], run)).toContain("1 commit on 1 day");
  });

  test("a stored day older than the 28-day window widens the strip instead of vanishing", () => {
    const days = activityStrip([{ day: "2026-09-29", commits: 2, sessions: 0 }], run);
    expect(days[0]).toEqual({ day: "2026-09-29", commits: 2, sessions: null });
    expect(days).toHaveLength(31);
  });

  test("a memo shorter than 8 days counts sessions from its own first day", () => {
    const days = activityStrip([], run, Date.parse("2026-10-24T08:00:00Z"));
    expect(days.find((d) => d.day === "2026-10-23")!.sessions).toBeNull();
    expect(days.find((d) => d.day === "2026-10-24")!.sessions).toBe(0);
  });

  test("a session day the sessions memo never covered keeps its count, and the session run starts there", () => {
    const days = activityStrip([{ day: "2026-10-22", commits: 0, sessions: 1 }], run, Date.parse("2026-10-24T08:00:00Z"));
    expect(days.find((d) => d.day === "2026-10-21")!.sessions).toBeNull();
    expect(days.find((d) => d.day === "2026-10-22")!.sessions).toBe(1);
    expect(days.find((d) => d.day === "2026-10-23")!.sessions).toBe(0);
  });

  test("a memo reaching past the 28-day window leaves no commits-only run, and the note drops out", () => {
    const html = activityStripHtml([], run, run - 40 * DAY);
    expect(html).not.toContain("commits only");
    expect(html).not.toContain("Days before");
    expect(html).toContain("since 2026-10-01 · commits and sessions");
  });

  test("the strip's accessible name puts a period between the summary and the note", () => {
    const html = activityStripHtml([{ day: ago(1), commits: 3, sessions: 0 }], run);
    expect(html).toContain('aria-label="3 commits on 1 day. Days before 2026-10-21 count commits only."');
    expect(activityStripHtml([], run)).toContain('aria-label="No commits or sessions in the last 28 days. Days before');
    expect(html).toMatch(/class="wiki-ef-strip"[^>]* tabindex="0"/);
  });

  /** The strip's two runs as rendered: label, cell days, session dots. */
  const runs = (html: string) =>
    [...html.matchAll(/<div class="wiki-ef-run( old)?"[^>]*><div class="wiki-ef-run-label">([^<]*)<\/div><div class="wiki-ef-cells">(.*?)<\/div><\/div>/g)].map((m) => ({
      old: m[1] === " old",
      label: m[2]!,
      days: [...m[3]!.matchAll(/title="(\d{4}-\d\d-\d\d)/g)].map((d) => d[1]!),
      dots: (m[3]!.match(/wiki-ef-sess/g) ?? []).length,
    }));
  const MIN = 60_000;

  test("a stored session on the last day before the window opens the session run there, never inside commits only", () => {
    // Run 2026-10-29 10:00Z; the 8-day window opens on 10-21, the session is on 10-20.
    const daily = [{ day: "2026-10-20", commits: 1, sessions: 2 }];
    const html = activityStripHtml(daily, run);
    const [old, recent] = runs(html);
    expect(old!.dots).toBe(0);
    expect(old!.days[old!.days.length - 1]).toBe("2026-10-19");
    expect(recent!.days[0]).toBe("2026-10-20");
    expect(old!.label).toBe("earlier · commits only");
    expect(recent!.label).toBe("since 2026-10-20 · commits and sessions");
    expect(recent!.days).toHaveLength(10);
    expect(recent!.dots).toBe(1);
    expect(html).toContain("1 commit on 1 day · 2 sessions since 2026-10-20");
    expect(html).toContain('aria-label="1 commit on 1 day · 2 sessions since 2026-10-20. Days before 2026-10-20 count commits only."');
    expect(html).not.toContain("last 8 days");
  });

  test("a stored session two days before the window still lands in the session run, with every day after it", () => {
    const html = activityStripHtml([{ day: "2026-10-19", commits: 0, sessions: 4 }], run);
    const [old, recent] = runs(html);
    expect(old!.dots).toBe(0);
    expect(recent!.days[0]).toBe("2026-10-19");
    expect(recent!.days).toHaveLength(11);
    expect(recent!.dots).toBe(1);
    expect(activityStrip([{ day: "2026-10-19", commits: 0, sessions: 4 }], run).find((d) => d.day === "2026-10-20")!.sessions).toBe(0);
  });

  test("a memo older than the run, reaching back to D-9 (2026-10-25, the autumn DST day): the session run starts on the memo's day", () => {
    // Run 2026-10-25 23:30 Oslo (CET); the memo is 40 min older, so it starts 10-17 23:50 Oslo (CEST).
    const r = Date.parse("2026-10-25T22:30:00Z");
    const since = r - 8 * DAY - 40 * MIN;
    const daily = [{ day: "2026-10-17", commits: 0, sessions: 1 }, { day: "2026-09-28", commits: 2, sessions: 0 }];
    expect(activityStrip(daily, r, since)).toHaveLength(28);
    // The memo covered 10-17 even with nothing stored there: 0, not null.
    expect(activityStrip([], r, since).find((d) => d.day === "2026-10-17")!.sessions).toBe(0);
    const html = activityStripHtml(daily, r, since);
    const [old, recent] = runs(html);
    expect(old!.days[0]).toBe("2026-09-28");
    expect(old!.dots).toBe(0);
    expect(old!.days).toHaveLength(19);
    expect(recent!.days[0]).toBe("2026-10-17");
    expect(recent!.label).toBe("since 2026-10-17 · commits and sessions");
    expect(recent!.days[recent!.days.length - 1]).toBe("2026-10-25");
    expect(recent!.days).toHaveLength(9);
    expect(recent!.dots).toBe(1);
    expect(html).toContain("2 commits on 2 days · 1 session since 2026-10-17");
  });

  test("the spring DST run (2026-03-29) spans 30 days, 10 of them counting sessions, and says no day count", () => {
    // Run 2026-03-30 00:30 Oslo (CEST): the 28-day window opens 03-01 23:30 CET, the 8-day one 03-21 23:30 CET.
    const r = Date.parse("2026-03-29T22:30:00Z");
    const html = activityStripHtml([{ day: "2026-03-25", commits: 1, sessions: 1 }], r, r - 8 * DAY);
    const [old, recent] = runs(html);
    expect(old!.days).toHaveLength(20);
    expect(old!.days[0]).toBe("2026-03-01");
    expect(recent!.days).toHaveLength(10);
    expect(recent!.days[0]).toBe("2026-03-21");
    expect(recent!.label).toBe("since 2026-03-21 · commits and sessions");
    expect(html).toContain("1 commit on 1 day · 1 session since 2026-03-21");
    expect(html).not.toContain("last 8");
  });

  test("a run late on 2026-10-30 (CET, window opening in CEST) spans 28 days, 8 counting sessions", () => {
    const r = Date.parse("2026-10-30T22:30:00Z");
    const [old, recent] = runs(activityStripHtml([], r, r - 8 * DAY));
    expect(old!.days).toHaveLength(20);
    expect(old!.days[0]).toBe("2026-10-03");
    expect(recent!.days).toHaveLength(8);
    expect(recent!.label).toBe("since 2026-10-23 · commits and sessions");
  });

  test("a session day gets its dot; an empty effort says so", () => {
    expect(activityStripHtml([{ day: ago(0), commits: 0, sessions: 2 }], run)).toContain("wiki-ef-sess");
    expect(activityStripHtml([], run)).toContain("No commits or sessions in the last 28 days.");
  });
});

describe("lookupEffort and the dropped page", () => {
  const m = map({
    efforts: [effort("new-name", ["plans/a.mdx"], { name: "Shipping pipeline", aliases: ["Old Name", "Fable ops"] }), effort("other", ["plans/b.mdx"])],
  });

  test("a current id is found", () => {
    expect(lookupEffort(joinWorkMap(m, PAGES), "other").kind).toBe("found");
  });

  test("a dropped id matching an alias's slug links that effort", () => {
    const r = lookupEffort(joinWorkMap(m, PAGES), "old-name");
    expect(r.kind === "dropped" && r.matches.map((e) => e.id)).toEqual(["new-name"]);
    const v = view(m, "old-name");
    expect(v.article).toContain("no longer in the map");
    expect(v.article).toContain('data-effort-link="new-name"');
    expect(v.article).toContain("data-effort-home");
  });

  test("a dropped id matching the slugified name links that effort", () => {
    const r = lookupEffort(joinWorkMap(m, PAGES), "shipping-pipeline");
    expect(r.kind === "dropped" && r.matches.map((e) => e.id)).toEqual(["new-name"]);
  });

  test("a dropped id with no match links only the start view", () => {
    const v = view(m, "gone-for-good");
    expect(v.article).toContain("no longer in the map");
    expect(v.article).not.toContain("data-effort-link");
    expect(v.article).toContain("Your work card");
  });

  // Efforts whose name and aliases slugify to "" (non-Latin, punctuation, emoji).
  const blank = map({
    efforts: [effort("drift", ["plans/a.mdx"]), effort("jp", ["plans/b.mdx"], { name: "日本語", aliases: ["—", "🚀"] })],
  });

  test("an empty id matches no effort through an empty name or alias slug", () => {
    const r = lookupEffort(joinWorkMap(blank, PAGES), "");
    expect(r.kind === "dropped" && r.matches.map((e) => e.id)).toEqual([]);
  });

  test("an id that slugifies to empty is dropped with no alias match", () => {
    for (const id of ["日本語", "—", "🚀"]) {
      const r = lookupEffort(joinWorkMap(blank, PAGES), id);
      expect(r.kind === "dropped" && r.matches.map((e) => e.id)).toEqual([]);
    }
    expect(view(blank, "🚀").article).not.toContain("data-effort-link");
  });

  test("a case variant of a current id is found", () => {
    const r = lookupEffort(joinWorkMap(blank, PAGES), "Drift");
    expect(r.kind === "found" && r.effort.id).toBe("drift");
  });

  test("a case variant of an alias slug links that effort", () => {
    const r = lookupEffort(joinWorkMap(m, PAGES), "Old-Name");
    expect(r.kind === "dropped" && r.matches.map((e) => e.id)).toEqual(["new-name"]);
  });

  test("canonicalEffortParam: blank is none, a variant is its slug, an unsluggable id stays as typed", () => {
    expect(canonicalEffortParam(null)).toBeNull();
    expect(canonicalEffortParam("")).toBeNull();
    expect(canonicalEffortParam("  ")).toBeNull();
    expect(canonicalEffortParam("Work-Map")).toBe("work-map");
    expect(canonicalEffortParam("drift")).toBe("drift");
    expect(canonicalEffortParam("日本語")).toBe("日本語");
  });

  // `slugifyEffortId` collapses `--` and trims a trailing `-`, but
  // `EFFORT_ID_RE` accepts both, so a hand-edited map can hold such an id.
  const raw = map({ efforts: [effort("a--b", ["plans/a.mdx"]), effort("c-", ["plans/b.mdx"]), effort("a-b", ["plans/a.mdx"], { name: "Other" })] });

  test("an id the slug changes is found by exact match, ahead of its slug", () => {
    for (const id of ["a--b", "c-", "a-b"]) {
      const r = lookupEffort(joinWorkMap(raw, PAGES), id);
      expect(r.kind === "found" && r.effort.id).toBe(id);
    }
    const v = view(raw, "a--b");
    expect(v.article).not.toContain("no longer in the map");
    expect(v.article).toContain('data-effort="a--b"');
  });

  test("canonicalEffortParam keeps any schema-valid id as typed", () => {
    expect(canonicalEffortParam("a--b")).toBe("a--b");
    expect(canonicalEffortParam("c-")).toBe("c-");
  });

  test("an unknown id is escaped wherever it shows", () => {
    const v = view(m, '<img src=x onerror="1">');
    expect(v.article).not.toContain("<img");
    expect(v.article).toContain("&lt;img");
  });
});

describe("effortView", () => {
  const m = map({
    themes: [{ name: "Reader", efforts: ["main", "sib", "rel"] }],
    needsYou: [
      { title: "Decide ⟦plans/a.mdx⟧", kind: "decision", why: "Two drafts.", action: "Pick one.", pages: [], effort: "main" },
      { title: "Elsewhere", kind: "followup", why: "", action: "", pages: [], effort: "sib" },
      { title: "Done one", kind: "verify", why: "", action: "", pages: [], effort: "main" },
    ],
    efforts: [
      effort("main", ["plans/a.mdx", ["plans/b.mdx", "plans/a.mdx"], "plans/gone.mdx"], {
        name: "Main <work>",
        oneLine: "The main line on ⟦plans/a.mdx⟧.",
        next: "Ship ⟦plans/gone.mdx⟧.",
        why: "They share ⟦plans/b.mdx⟧.",
        related: [
          { id: "rel", why: "Feeds it." },
          { id: "vanished", why: "" },
        ],
      }),
      effort("child", ["plans/c.mdx"], { parent: "main", state: "cooling" }),
      effort("sib", ["plans/d.mdx"]),
      effort("rel", ["plans/d.mdx"], { state: "shipped" }),
    ],
  });

  test("head: crumbs with the theme, name, state, page count with gone pages, confidence", () => {
    const { article } = view(m, "main");
    expect(article).toContain("<h1>Main &lt;work&gt;</h1>");
    expect(article).toMatch(/wiki-bc-wiki[\s\S]*Efforts[\s\S]*wiki-ef-crumb-theme">Reader</);
    expect(article).toContain("wm-state-active");
    expect(article).toContain("2 pages (1 no longer in the wiki)");
    expect(article).toContain("confidence 80%");
  });

  test("In short carries the one-liner and the next step; a gone marker is its stem", () => {
    const { article } = view(m, "main");
    expect(article).toMatch(/In short[\s\S]*The main line on <a class="wiki-wm-link"[^>]*data-relpath="plans\/a.mdx"[^>]*>Plan A<\/a>/);
    expect(article).toMatch(/Next:<\/span> Ship gone\./);
  });

  test("Needs you lists only this effort's items, minus those marked done", () => {
    const done = new Set(["verify|Done one"]);
    const { article } = view(m, "main", { done });
    expect(article).toContain("Two drafts.");
    expect(article).not.toContain("Elsewhere");
    expect(article).not.toContain("Done one");
    expect(article).toContain("1 item marked done on the Your work card.");
  });

  test("Needs you shows each item from its own place in the map, not the effort's first item", () => {
    const { article } = view(m, "main");
    expect(article).toContain('<span class="wiki-ef-kind">verify</span><span class="wiki-ef-need-title">Done one</span>');
    expect(article.split("Two drafts.").length - 1).toBe(1);
  });

  test("pages in lineage order with role and the reader's status pill", () => {
    const { article } = view(m, "main");
    expect(article).toMatch(/data-relpath="plans\/a.mdx"[^>]*>Plan A<\/a><span class="wiki-ef-role">plan<\/span><span class="pill">in-flight<\/span>[\s\S]*data-depth="1" title="Derived from Plan A"[\s\S]*Plan &lt;B&gt;/);
  });

  test("sub-efforts list on the parent; the child's crumbs link back to it", () => {
    expect(view(m, "main").article).toMatch(/Sub-efforts[\s\S]*data-effort-link="child"[^>]*>Effort child/);
    expect(view(m, "child").article).toMatch(/wiki-ef-crumbs[\s\S]*data-effort-link="main"[^>]*>Main &lt;work&gt;<\/a><\/nav>/);
  });

  test("connections: related efforts with their why, a vanished one as text, then the theme's others", () => {
    const { connections } = view(m, "main");
    expect(connections).toMatch(/Related efforts \(2\)[\s\S]*data-effort-link="rel"[\s\S]*Feeds it\.[\s\S]*vanished[\s\S]*no longer in the map/);
    // `rel` is already listed as related, so the theme lists only `sib`.
    expect(connections).toMatch(/Also in Reader \(1\)[\s\S]*data-effort-link="sib"/);
    expect(connections.match(/data-effort-link="rel"/g)).toHaveLength(1);
  });

  test("an effort in no theme says so", () => {
    expect(view(m, "child").connections).toContain("This effort is in no theme.");
  });

  test("the activity strip and why together render", () => {
    const { article } = view(m, "main");
    expect(article).toContain("Activity, last 28 days");
    expect(article).toMatch(/Why together[\s\S]*They share/);
  });

  test("the strip counts sessions from the run's own coverage when it is shorter than 8 days", () => {
    const short = map({ ...m, coverage: { ...m.coverage, sessionsSinceMs: Date.parse("2026-10-26T08:00:00Z") } });
    expect(view(short, "main").article.match(/wiki-ef-day[^"]* old/g)).toHaveLength(25);
  });
});

test("status and URL helpers", () => {
  expect(effortStatusHtml({ wiki: "w", startHref: "/wiki", id: "x" }, "no-map")).toContain("no work map");
  expect(effortStatusHtml({ wiki: "w", startHref: "/wiki", id: "x" }, "error", "HTTP 500")).toContain("wikiEffortRetry");
  expect(effortUrl("my wiki", "a-b")).toBe("/wiki?wiki=my%20wiki&effort=a-b");
  expect(effortUrl("", "a")).toBe("/wiki?effort=a");
});

test("the Your work card links effort names when given effortHref, and keeps text without", () => {
  const m = map({ efforts: [effort("p", ["plans/a.mdx"]), effort("k", ["plans/b.mdx"], { parent: "p" })] });
  const base = { body: { map: m, organizable: false }, pages: PAGES, now: NOW, done: new Set<string>(), hrefFor: href, refresh: { phase: "idle" as const } };
  const linked = workCardHtml({ ...base, effortHref });
  expect(linked).toContain('<a class="wiki-wm-effort-name" href="/wiki?effort=p" data-effort-link="p">');
  expect(linked).toContain('data-effort-link="k"');
  expect(workCardHtml(base)).not.toContain("data-effort-link");
});

test("a parent cycle reads as the card reads it: no parent crumb, and no sub-effort row on either side", () => {
  // Normalize clears parent cycles, so this map is hand-edited.
  const efforts = [
    effort("x", ["plans/a.mdx"], { parent: "y" }),
    effort("y", ["plans/b.mdx"], { parent: "x" }),
    effort("k", ["plans/c.mdx"], { parent: "y", state: "cooling" }),
    effort("lift", ["plans/d.mdx"], { parent: "q", state: "active" }),
    effort("q", ["plans/e.mdx"], { state: "shipped" }),
  ];
  const m = map({ efforts });
  const crumbLinks = (id: string) => [...(view(m, id).article.match(/<nav class="wiki-ef-crumbs"[\s\S]*?<\/nav>/)?.[0] ?? "").matchAll(/data-effort-link="([^"]+)"/g)].map((x) => x[1]);
  const subs = (id: string) => [...(view(m, id).article.match(/<ul class="wiki-ef-subs">[\s\S]*?<\/ul>/)?.[0] ?? "").matchAll(/data-effort-link="([^"]+)"/g)].map((x) => x[1]);
  expect(crumbLinks("x")).toEqual([]);
  expect(crumbLinks("y")).toEqual([]);
  expect(subs("x")).toEqual([]);
  expect(subs("y")).toEqual([]);
  // `k` hangs off a cycle member, so its chain never reaches a root: top-level.
  expect(crumbLinks("k")).toEqual([]);
  // A Moving child of a closed-lane parent is lifted top-level on the card, yet
  // the parent page lists it and its own crumb names the parent: both agree.
  expect(subs("q")).toEqual(["lift"]);
  expect(crumbLinks("lift")).toEqual(["q"]);
});

describe("focus keys", () => {
  /** The opening tag of every element a keyboard reaches. */
  const focusables = (html: string) => [...html.matchAll(/<(?:a|button)\b[^>]*>|<\w+\b[^>]*\btabindex="[^"]*"[^>]*>/g)].map((x) => x[0]);
  const keys = (html: string) => focusables(html).map((t) => t.match(/\bdata-focus-key="([^"]*)"/)?.[1]);
  const m = map({
    themes: [{ name: "Reader", efforts: ["main", "sib"] }],
    needsYou: [{ title: "Decide ⟦plans/a.mdx⟧", kind: "decision", why: "", action: "", pages: [], effort: "main" }],
    efforts: [
      effort("main", ["plans/a.mdx", ["plans/b.mdx", "plans/a.mdx"]], { oneLine: "On ⟦plans/a.mdx⟧.", related: [{ id: "sib", why: "" }] }),
      effort("child", ["plans/c.mdx"], { parent: "main" }),
      effort("sib", ["plans/d.mdx"], { aliases: ["Old sib"] }),
    ],
  });
  const head = { wiki: "w", startHref: "/wiki?wiki=w", id: "main" };
  const panes = (over: Partial<Parameters<typeof effortView>[0]> = {}) => [
    ...["main", "child", "old-sib"].flatMap((id) => {
      const v = view(m, id, over);
      return [v.article, v.connections];
    }),
    ...(["loading", "no-map", "error"] as const).map((k) => effortStatusHtml({ ...head, startHref: over.startHref ?? head.startHref }, k)),
  ];

  test("every focusable element in every pane carries a key, unique within its pane", () => {
    expect(panes().flatMap(keys).length).toBeGreaterThan(20);
    for (const html of panes()) {
      const ks = keys(html);
      expect(ks.every((k) => typeof k === "string" && k !== "")).toBe(true);
      expect(new Set(ks).size).toBe(ks.length);
    }
    // The strip and the wiki crumb are among them.
    const article = view(m, "main").article;
    expect(focusables(article).some((t) => t.includes("wiki-ef-strip") && /data-focus-key=/.test(t))).toBe(true);
    expect(focusables(article).some((t) => t.includes("wiki-bc-wiki") && /data-focus-key=/.test(t))).toBe(true);
  });

  test("two prose links to one page get different keys", () => {
    const prose = focusables(view(m, "main").article).filter((t) => t.includes('class="wiki-wm-link"') && t.includes('data-relpath="plans/a.mdx"'));
    expect(prose).toHaveLength(2);
    expect(new Set(keys(prose.join(""))).size).toBe(2);
  });

  test("a facet change, which rewrites every href, keeps every key", () => {
    const faceted = panes({
      startHref: "/wiki?wiki=w&project=p",
      hrefFor: (rel) => href(rel) + "&project=p",
      effortHref: (id) => effortHref(id) + "&project=p",
    });
    expect(faceted.flatMap(keys).every((k) => !!k)).toBe(true);
    expect(faceted.map(keys)).toEqual(panes().map(keys));
  });
});

describe("the retired effort page (P6)", () => {
  const m = map({ efforts: [effort("live", ["plans/a.mdx"])], retired: [{ id: "drift", name: "Drift <old>", lastActive: Date.parse("2026-09-14T10:00:00Z") }] });
  const pages: EffortPageListing[] = [
    ...PAGES.slice(0, 2),
    { relPath: "plans/c.mdx", title: "Plan C", effort: "drift" },
    { relPath: "plans/d.mdx", title: "Plan D", effort: "other" },
  ];

  test("lookupEffort answers a retired id, exact or as its slug, before the dropped fallback", () => {
    const joined = joinWorkMap(m, pages);
    expect(lookupEffort(joined, "drift").kind).toBe("retired");
    expect(lookupEffort(joined, "Drift").kind).toBe("retired");
    expect(lookupEffort(joined, "gone").kind).toBe("dropped");
  });

  test("shows the name, the last-active date and the listing's pages that declare it", () => {
    const v = effortView({ map: m, pages, id: "drift", wiki: "w", startHref: "/wiki", hrefFor: href, effortHref, now: NOW });
    expect(v.article).toContain("wiki-effort-retired");
    expect(v.article).toContain("<h1>Drift &lt;old&gt;</h1>");
    expect(v.article).toContain("last active 2026-09-14");
    expect(v.article).toContain('data-relpath="plans/c.mdx"');
    expect(v.article).not.toContain('data-relpath="plans/d.mdx"');
  });

  test("a map written before P6 (no `retired`) still parses and an id is dropped", () => {
    const old = map({ efforts: [effort("live", ["plans/a.mdx"])] });
    expect(lookupEffort(joinWorkMap(old, pages), "drift").kind).toBe("dropped");
  });
});

describe("moved and gone pages after a declaration (P6)", () => {
  const RUN = NOW - 2 * HOUR;
  const old = { gitCreatedMs: RUN - 40 * DAY, gitTouchedMs: RUN - 30 * DAY };

  test("a moved page is shown as moved, not counted as gone; a real deletion still is, beside a joined page", () => {
    // e: a (stays), b (deleted), c (moves to f); n joins e after the run.
    const m = map({ runAtMs: RUN, efforts: [effort("e", ["plans/a.mdx", "plans/b.mdx", "plans/c.mdx"]), effort("f", ["plans/d.mdx"])] });
    const pages: EffortPageListing[] = [
      { relPath: "plans/a.mdx", title: "Plan A", ...old },
      { relPath: "plans/c.mdx", title: "Plan C", effort: "f", ...old },
      { relPath: "plans/d.mdx", title: "Plan D", ...old },
      { relPath: "plans/n.mdx", title: "Plan N", effort: "e", gitDirty: true, mtimeMs: NOW },
    ];
    const { article } = view(m, "e", { pages });
    expect(article).toContain("2 pages (1 no longer in the wiki)");
    expect(article).toContain("Moved to another effort");
    expect(article).toMatch(/data-relpath="plans\/c\.mdx"[^]*moved to <a class="wiki-ef-elink" href="\/wiki\?effort=f" data-effort-link="f"[^>]*>Effort f<\/a>/);
    // The joined page lists first.
    expect(article.indexOf('data-relpath="plans/n.mdx"')).toBeLessThan(article.indexOf('data-relpath="plans/a.mdx"'));
    // On f's page the moved page is an ordinary page.
    expect(view(m, "f", { pages }).article).toContain("2 pages<");
  });

  test("an effort every page moved out of says so instead of «no longer in the wiki»", () => {
    const m = map({ runAtMs: RUN, efforts: [effort("e", ["plans/a.mdx"]), effort("f", ["plans/d.mdx"])] });
    const pages: EffortPageListing[] = [
      { relPath: "plans/a.mdx", title: "Plan A", effort: "f", ...old },
      { relPath: "plans/d.mdx", title: "Plan D", ...old },
    ];
    const { article } = view(m, "e", { pages });
    expect(article).toContain("0 pages<");
    expect(article).not.toContain("no longer in the wiki");
    expect(article).toContain("Every page of this effort moved to another effort since the run.");
  });

  test("the card drops an effort a move left empty off its lanes, but keeps one emptied by deletion", () => {
    const m = map({ runAtMs: RUN, efforts: [effort("moved", ["plans/a.mdx"]), effort("deleted", ["plans/gone.mdx"]), effort("f", ["plans/d.mdx"])] });
    const pages = [
      { relPath: "plans/a.mdx", title: "Plan A", effort: "f", ...old },
      { relPath: "plans/d.mdx", title: "Plan D", ...old },
    ];
    const html = workCardHtml({ body: { map: m, organizable: false }, pages, now: NOW, done: new Set(), hrefFor: href, refresh: { phase: "idle" } });
    expect(html).not.toContain('data-effort-id="moved"');
    expect(html).toContain('data-effort-id="deleted"');
    expect(html).toContain('data-effort-id="f"');
  });

  test("on the card, a page joined to a 7-page effort shows among the first six, not behind «+N more»", () => {
    const seven = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((s) => `plans/${s}.mdx`);
    const m = map({ runAtMs: RUN, efforts: [effort("big", seven)] });
    const pages = [
      ...seven.map((rel, i) => ({ relPath: rel, title: `Page ${i + 1}`, ...old })),
      { relPath: "plans/today.mdx", title: "Written today", effort: "big", gitDirty: true, mtimeMs: NOW },
    ];
    const html = workCardHtml({ body: { map: m, organizable: false }, pages, now: NOW, done: new Set(), hrefFor: href, refresh: { phase: "idle" } });
    const list = html.slice(html.indexOf('data-effort-id="big"'));
    const shown = list.slice(0, list.indexOf("wiki-wm-more"));
    expect(shown).toContain(">Written today</a>");
    expect(list).toContain("+2 more");
  });
});

describe("the Pages note over every (joined, moved, gone, remaining) combination", () => {
  const RUN = NOW - 2 * HOUR;
  const old = { gitCreatedMs: RUN - 40 * DAY, gitTouchedMs: RUN - 30 * DAY };
  const NOTE_RE = /<h2 class="wiki-ef-h">Pages<\/h2><div class="wiki-ef-note">([^<]*)<\/div>/;
  const pagesWord = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
  /** The one true note for an effort that shows no rows, or none when it shows any. */
  const expected = (rows: number, moved: number, gone: number): string | null => {
    if (rows > 0) return null;
    if (moved > 0 && gone > 0) return `None of this effort’s pages are here now: ${moved} moved to another effort, ${gone} no longer in the wiki.`;
    if (moved > 0) return "Every page of this effort moved to another effort since the run.";
    if (gone > 0) return "None of this effort’s pages are in the wiki any more.";
    return "This effort has no pages.";
  };
  const counts = [0, 1, 2];
  for (const joined of counts)
    for (const moved of counts)
      for (const gone of counts)
        for (const remaining of counts) {
          test(`joined ${joined}, moved ${moved}, gone ${gone}, remaining ${remaining}`, () => {
            const ids = (kind: string, n: number) => Array.from({ length: n }, (_, i) => `plans/${kind}${i}.mdx`);
            const m = map({ runAtMs: RUN, efforts: [effort("a", [...ids("r", remaining), ...ids("m", moved), ...ids("g", gone)]), effort("b", [])] });
            const pages: EffortPageListing[] = [
              ...ids("r", remaining).map((relPath) => ({ relPath, title: relPath, ...old })),
              ...ids("m", moved).map((relPath) => ({ relPath, title: relPath, effort: "b", ...old })),
              ...ids("j", joined).map((relPath) => ({ relPath, title: relPath, effort: "a", gitDirty: true, mtimeMs: NOW })),
            ];
            const { article } = view(m, "a", { pages });
            const rows = joined + remaining;
            expect(article).toContain(`${pagesWord(rows)}${gone > 0 ? ` (${gone} no longer in the wiki)` : ""}<`);
            const note = article.match(NOTE_RE)?.[1] ?? null;
            expect(note).toBe(expected(rows, moved, gone));
            expect(article.includes("Moved to another effort")).toBe(moved > 0);
            if (moved > 0) expect(article).toContain(`Moved to another effort <span class="wiki-ef-count">${moved}</span>`);
          });
        }
});
