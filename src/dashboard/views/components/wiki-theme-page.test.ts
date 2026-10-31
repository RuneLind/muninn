import { describe, expect, test } from "bun:test";
import { fixtureTheme, fixtureThemeMap, fixtureThemePages, THEME_RUN_AT } from "../../../test/theme-map-fixture.ts";
import type { ThemeMap } from "../../../wiki/work-map/theme-schema.ts";
import { THEME_CONNECTIONS_SHOWN, THEME_HUBS_SHOWN, THEME_STRIP_WEEKS } from "./wiki-work-card.ts";
import { sourcesNewestFirst, themeView, type ThemePageListing, type ThemeViewInput } from "./wiki-theme-page.ts";

/** Friday of the run's week (W44, Mon 2026-10-26 – Sun 2026-11-01). */
const IN_RUN_WEEK = THEME_RUN_AT + 6 * 3_600_000;
const AFTER_RUN_WEEK = Date.parse("2026-11-03T12:00:00Z");

const HUBS = ["concepts/Hub X.md", "concepts/Hub A.md", "concepts/Hub B.md", "concepts/Hub C.md", "concepts/Hub D.md", "entities/Hub E.md"];
/** Ten stored weeks: more than the card's eight. */
const WEEKS = Array.from({ length: 10 }, (_, i) => {
  const start = new Date(Date.parse("2026-08-24T12:00:00Z") + i * 7 * 86_400_000).toISOString().slice(0, 10);
  return { week: `2026-W${35 + i}`, start, count: i % 3 };
});
/** Eight connected themes: more than the card's six. */
const OTHERS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];

function bigMap(): ThemeMap {
  const base = fixtureThemeMap();
  return {
    ...base,
    themes: [
      { name: "AI & tech", efforts: ["alpha", "beta", "gamma", "delta", ...OTHERS] },
      { name: "Life", efforts: ["life-one"] },
    ],
    efforts: [
      fixtureTheme("alpha", {
        state: "rising",
        pages: [
          { id: "sources/alpha-old.mdx", role: "source" },
          { id: "sources/alpha-new.mdx", role: "source" },
          { id: "sources/alpha-mid.mdx", role: "source" },
        ],
        readFirst: ["sources/alpha-mid.mdx"],
        takeaway: "Alpha's takeaway, see ⟦sources/alpha-new.mdx⟧.",
        disagreement: "One source says more, ⟦sources/alpha-old.mdx⟧ says less.",
        hubs: HUBS,
        weekly: WEEKS,
        related: [{ id: "beta", why: "Both lean on Hub X." }, ...OTHERS.map((id) => ({ id, why: `Why ${id}.` })), { id: "gone-theme", why: "Dropped since." }],
      }),
      ...base.efforts.slice(1),
      ...OTHERS.map((id) => fixtureTheme(id)),
    ],
    retired: [{ id: "old-theme", name: "Old theme", lastActive: Date.parse("2026-09-20T00:00:00Z"), weekly: WEEKS.slice(0, 4), members: ["sources/old-1.mdx"] }],
  };
}

function bigPages(): ThemePageListing[] {
  const rels = new Map<string, ThemePageListing>();
  for (const p of fixtureThemePages()) rels.set(p.relPath, p);
  const add = (relPath: string, created?: string) => rels.set(relPath, { relPath, title: relPath.split("/").pop()!.replace(/\.mdx?$/, ""), ...(created ? { created } : {}) });
  add("sources/alpha-old.mdx", "2026-10-02");
  add("sources/alpha-new.mdx", "2026-10-28");
  add("sources/alpha-mid.mdx", "2026-10-15");
  add("sources/old-1.mdx", "2026-09-20");
  for (const h of HUBS) add(h);
  for (const id of OTHERS) add(`sources/${id}-1.mdx`);
  return [...rels.values()];
}

function view(id: string, over: Partial<ThemeViewInput<ThemePageListing>> = {}) {
  return themeView({
    map: bigMap(),
    pages: bigPages(),
    id,
    wiki: "w",
    startHref: "/wiki?wiki=w",
    hrefFor: (r) => `/wiki?page=${r}`,
    effortHref: (e) => `/wiki?effort=${e}`,
    now: IN_RUN_WEEK,
    ...over,
  });
}

const slots = (html: string) => [...html.matchAll(/class="wiki-wm-slot([^"]*)"/g)].map((m) => m[1]);

describe("themeView", () => {
  test("draws In short, Read first, the disagreement, every hub and the sources newest first", () => {
    const { article } = view("alpha");
    expect(article).toContain('data-kind="themes"');
    expect(article).toContain('<p class="wiki-ef-oneline">One line about alpha.</p>');
    expect(article).toMatch(/Takeaway:<\/span> Alpha&#39;s takeaway, see <a [^>]*data-relpath="sources\/alpha-new.mdx"[^>]*>alpha-new<\/a>\./);
    const readFirst = article.match(/wiki-ef-readfirst.*?<\/section>/)![0];
    expect(readFirst).toContain('data-relpath="sources/alpha-mid.mdx"');
    expect(article).toContain("Where the sources disagree");
    const hubs = [...article.match(/wiki-ef-hubsec.*?<\/section>/)![0].matchAll(/data-relpath="([^"]+)"/g)].map((m) => m[1]);
    expect(hubs.length).toBeGreaterThan(THEME_HUBS_SHOWN);
    expect(hubs).toEqual(HUBS);
    const sources = [...article.match(/wiki-ef-sources.*?<\/section>/)![0].matchAll(/data-relpath="([^"]+)"/g)].map((m) => m[1]);
    expect(sources).toEqual(["sources/alpha-new.mdx", "sources/alpha-mid.mdx", "sources/alpha-old.mdx"]);
  });

  test("leaves out the disagreement section when the theme states none", () => {
    expect(view("gamma").article).not.toContain("Where the sources disagree");
  });

  test("names the domain group in the crumb and rewords the work strings", () => {
    const { article, connections } = view("alpha");
    expect(article).toMatch(/data-effort-home[^>]*>AI &amp; tech<\/a>/);
    expect(article).not.toContain(">Efforts<");
    expect(article).not.toContain("No theme");
    expect(article).toContain("From the theme map organized");
    expect(article).not.toContain("From the work map");
    expect(article).toContain('title="How sure the theme run was that these sources share one theme"');
    expect(article).not.toContain("one piece of work");
    expect(connections).toContain(`Connected themes (${OTHERS.length + 2})`);
    expect(connections).not.toContain("Related efforts");
    expect(connections).toContain('<div class="wiki-ef-conn-title">Domain</div>');
    expect(connections).not.toContain("This effort is in no theme.");
    expect(view("life-one").article).toMatch(/data-effort-home[^>]*>Life<\/a>/);
  });

  test("lists every connected theme, more than the card's six, and marks one no longer in the map", () => {
    const { connections } = view("alpha");
    const linked = [...connections.match(/Connected themes.*?<\/ul>/)![0].matchAll(/data-effort-link="([^"]+)"/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(THEME_CONNECTIONS_SHOWN);
    expect(linked).toEqual(["beta", ...OTHERS]);
    expect(connections).toContain("gone-theme</span><span class=\"wiki-ef-meta\">no longer in the map");
    expect(connections).toContain("Why c8.");
    // Domain lists the group's themes not already connected.
    const domain = connections.slice(connections.indexOf("wiki-ef-domain"));
    expect(domain).toContain("AI &amp; tech: 2 other themes");
    expect([...domain.matchAll(/data-effort-link="([^"]+)"/g)].map((m) => m[1])).toEqual(["gamma", "delta"]);
  });

  test("the weekly strip shows every stored week and marks the run's week running on the reader's clock", () => {
    const html = view("alpha").article;
    const strip = html.match(/wiki-ef-weekly.*?<\/section>/)![0];
    expect(slots(strip)).toHaveLength(WEEKS.length);
    expect(WEEKS.length).toBeGreaterThan(THEME_STRIP_WEEKS);
    expect(strip).not.toContain("earlier");
    // The fixture beta keeps W42–W44: the run's week (W44) runs while the reader is in it…
    const beta = view("beta").article.match(/wiki-ef-weekly.*?<\/section>/)![0];
    expect(slots(beta)).toEqual([" partial", "", " current"]);
    // …and reads partial once it has ended, though the map is the same.
    const later = view("beta", { now: AFTER_RUN_WEEK }).article.match(/wiki-ef-weekly.*?<\/section>/)![0];
    expect(slots(later)).toEqual([" partial", "", " partial"]);
  });

  test("Worth a look shows the item's kind, the runner's count and its hubs; a done item is counted, not shown", () => {
    const beta = view("beta").article;
    expect(beta).toContain("Worth a look");
    expect(beta).toContain('<span class="wiki-ef-kind">drift</span>');
    expect(beta).toContain(">12 new since update</span>");
    expect(beta).toMatch(/wiki-ef-need[^]*wiki-wm-hub"><a [^>]*data-relpath="concepts\/Hub X.md"/);
    const gamma = view("gamma").article;
    expect(gamma).toContain(">2 sources</span>");
    const done = view("beta", { done: new Set(["drift|Hub X is behind its sources"]) }).article;
    expect(done).not.toContain("12 new since update");
    expect(done).toContain("1 item marked done on the What you’re following card.");
  });

  test("a retired theme id opens with its weeks and last sources", () => {
    const { article, connections } = view("old-theme");
    expect(article).toContain("wiki-effort-retired");
    expect(article).toContain("<h1>Old theme</h1>");
    expect(article).toContain("last active 2026-09-20");
    expect(article).toContain('data-relpath="sources/old-1.mdx"');
    expect(slots(article.match(/wiki-ef-weekly.*?<\/section>/)![0])).toHaveLength(4);
    expect(article).toContain("From the theme map organized");
    expect(connections).toContain("retired theme");
    expect(view("Old-Theme").article).toContain("<h1>Old theme</h1>");
  });

  test("an id the map does not hold reads as no longer in the map, matched by name", () => {
    const { article } = view("theme-c1");
    expect(article).toContain("This theme is no longer in the map.");
    expect(article).toContain('data-effort-link="c1"');
    expect(article).toContain("See every theme on the What you’re following card");
  });
});

test("sourcesNewestFirst puts undated sources last, map order within a day", () => {
  const p = (relPath: string, created?: string) => ({ id: relPath, page: { relPath, title: relPath, ...(created ? { created } : {}) } });
  const out = sourcesNewestFirst([p("a"), p("b", "2026-10-01"), p("c", "2026-10-09"), p("d", "2026-10-01"), p("e", "2026-10-09T08:00")]);
  expect(out.map((r) => r.id)).toEqual(["c", "e", "b", "d", "a"]);
});
