import { describe, expect, test } from "bun:test";
import { WORK_MAP_VERSION, type WorkMap } from "../../../wiki/work-map/schema.ts";
import { joinWorkMap, type JoinedEffortPage } from "../../../wiki/work-map/join.ts";
import { osloDay } from "../../../wiki/work-map/ids.ts";
import {
  activityStrip,
  activityStripHtml,
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

  test("28 days ending on the run's Oslo day, missing days read as zero", () => {
    const days = activityStrip([{ day: ago(3), commits: 2, sessions: 1 }], run);
    expect(days).toHaveLength(STRIP_DAYS);
    expect(days[days.length - 1]!.day).toBe(today);
    expect(days[0]!.day).toBe(ago(27));
    expect(days.find((d) => d.day === ago(3))).toEqual({ day: ago(3), commits: 2, sessions: 1 });
    expect(days.find((d) => d.day === ago(4))).toEqual({ day: ago(4), commits: 0, sessions: 0 });
  });

  test("days 9–28 carry no session count, the newest 8 do", () => {
    const days = activityStrip([{ day: ago(10), commits: 1, sessions: 4 }], run);
    expect(days.filter((d) => d.sessions !== null)).toHaveLength(STRIP_SESSION_DAYS);
    expect(days.find((d) => d.day === ago(10))!.sessions).toBeNull();
    expect(days.find((d) => d.day === ago(7))!.sessions).toBe(0);
    expect(days.find((d) => d.day === ago(8))!.sessions).toBeNull();
  });

  test("a 0-session day says only its commits; an empty day says no activity", () => {
    expect(stripDayLabel({ day: "2026-10-27", commits: 3, sessions: 0 })).toBe("2026-10-27: 3 commits");
    expect(stripDayLabel({ day: "2026-10-27", commits: 1, sessions: 2 })).toBe("2026-10-27: 1 commit, 2 sessions");
    expect(stripDayLabel({ day: "2026-10-01", commits: 0, sessions: null })).toBe("2026-10-01: no activity");
  });

  test("the html marks the commits-only run and never prints 0 sessions", () => {
    const html = activityStripHtml([{ day: ago(1), commits: 3, sessions: 0 }, { day: ago(12), commits: 1, sessions: 0 }], run);
    expect(html).toContain("days 9–28 · commits only");
    expect(html).toContain("Sessions are counted for the last 8 days only");
    expect(html).not.toMatch(/0 sessions?/);
    expect(html).toContain("4 commits on 2 days");
    expect(html.match(/class="wiki-ef-day/g)).toHaveLength(28);
    expect(html.match(/wiki-ef-day[^"]* old/g)).toHaveLength(20);
    expect(html).not.toContain("wiki-ef-sess");
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
    const { article, title } = view(m, "main");
    expect(title).toBe("Main <work>");
    expect(article).toContain("<h1>Main &lt;work&gt;</h1>");
    expect(article).toMatch(/wiki-bc-wiki[\s\S]*Efforts[\s\S]*wiki-ef-crumb-theme">Reader</);
    expect(article).toContain("wm-state-active");
    expect(article).toContain("2 pages (1 no longer in the wiki)");
    expect(article).toContain("confidence 80%");
  });

  test("In short carries the one-liner and the next step; a gone marker is its stem", () => {
    const { article } = view(m, "main");
    expect(article).toMatch(/In short[\s\S]*The main line on <a class="wiki-wm-link"[^>]*data-relpath="plans\/a.mdx">Plan A<\/a>/);
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

  test("pages in lineage order with role and the reader's status pill", () => {
    const { article } = view(m, "main");
    expect(article).toMatch(/data-relpath="plans\/a.mdx">Plan A<\/a><span class="wiki-ef-role">plan<\/span><span class="pill">in-flight<\/span>[\s\S]*data-depth="1" title="Derived from Plan A"[\s\S]*Plan &lt;B&gt;/);
  });

  test("sub-efforts list on the parent; the child's crumbs link back to it", () => {
    expect(view(m, "main").article).toMatch(/Sub-efforts[\s\S]*data-effort-link="child">Effort child/);
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
