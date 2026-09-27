/**
 * The culled bit (`signal: none`) in the STORE: how it is read, how attachment
 * children inherit it, how a culled successor stops adopting rule-4 children,
 * and where `superseded_by:` resolves for the reader's banner. Driven against a
 * real `buildWikiIndex` over a temp wiki, since every rule reads a built index.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetWikiCacheForTest, aliasWorkedPaths, buildWikiIndex, readCull, type WikiIndex } from "./store.ts";
import { toListing } from "../dashboard/routes/wiki-routes.ts";
import { DEFAULT_ACTIVITY_WEIGHTS, rankActivity } from "../dashboard/views/components/wiki-activity-rank.ts";
import type { WikiListing } from "../dashboard/views/components/wiki-filter.ts";
import { groupSeries, seriesMembersOf } from "../dashboard/views/components/wiki-groups.ts";
import { buildSeriesMenu, headMoveWrites } from "../dashboard/views/components/wiki-series-menu.ts";
import { registerWikiSeriesRoutes } from "../dashboard/routes/wiki-series-routes.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "./registry-memo.ts";
import { sha256 } from "../gardener/util.ts";
import { Hono } from "hono";
import { lintWiki } from "./lint.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-culled-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await mkdir(path.join(root, "archive"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = (rel: string, text: string) => Bun.write(path.join(root, rel), text);
const md = (fm: string[], body = "Prose.") => ["---", ...fm, "---", "", body, ""].join("\n");
const pageOf = (index: WikiIndex, rel: string) => index.pages.find((p) => p.relPath === rel)!;

describe("readCull", () => {
  test("only `none` culls — case-folded, a trailing comment dropped", () => {
    expect(readCull("none", "old")).toEqual({ culled: true, cullReason: "old" });
    expect(readCull(" None # retired 09-27", undefined)).toEqual({ culled: true });
    expect(readCull("high", "kept")).toEqual({});
    expect(readCull(undefined, "reason without a signal")).toEqual({});
  });

  test("a QUOTED value followed by a comment still culls", () => {
    expect(readCull('"none" # retired', undefined)).toEqual({ culled: true });
    expect(readCull("'none'   # retired 09-27", "why")).toEqual({ culled: true, cullReason: "why" });
  });

  test("a block-scalar indicator reason is absent, not the reason", () => {
    expect(readCull("none", ">")).toEqual({ culled: true });
  });
});

describe("the culled bit on a built index", () => {
  test("frontmatter `signal: none` + `signal-reason` cull a markdown page; `signal: high` does not", async () => {
    await write("archive/gone.md", md(["title: Gone", "signal: none", "signal-reason: folded into the plan"]));
    await write("archive/loud.md", md(["title: Loud", "signal: high"]));
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "archive/gone.md").culled).toBe(true);
    expect(pageOf(index, "archive/gone.md").cullReason).toBe("folded into the plan");
    expect(pageOf(index, "archive/loud.md").culled).toBeUndefined();
  });

  test("an .html page is culled by the wiki-signal meta NEXT TO <title>, never by one past the sniffed prefix", async () => {
    await write(
      "archive/near.html",
      '<!doctype html><html><head><title>Near</title><meta name="wiki-signal" content="none">' +
        '<meta name="wiki-signal-reason" content="a scaffold"><style>body{}</style></head><body>x</body></html>',
    );
    // A large <style> block first pushes the tag past the 4 KB head sniff.
    const bigStyle = `<style>${"/* padding */ .x{color:red}\n".repeat(300)}</style>`;
    await write(
      "archive/far.html",
      `<!doctype html><html><head><title>Far</title>${bigStyle}<meta name="wiki-signal" content="none"></head><body>x</body></html>`,
    );
    expect(bigStyle.length).toBeGreaterThan(4096);
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "archive/near.html").culled).toBe(true);
    expect(pageOf(index, "archive/near.html").cullReason).toBe("a scaffold");
    expect(pageOf(index, "archive/far.html").culled).toBeUndefined();
  });
});

describe("the .html wiki-signal sniff reads a REAL tag only", () => {
  const head = (inner: string) =>
    `<!doctype html><html><head><title>T</title>${inner}</head><body>x</body></html>`;

  test("a commented-out tag, a tag inside a <script> string and a data-name attribute do not cull", async () => {
    await write("archive/comment.html", head('<!-- <meta name="wiki-signal" content="none"> -->'));
    await write(
      "archive/script.html",
      head(`<script>const tag = '<meta name="wiki-signal" content="none">';</script>`),
    );
    await write("archive/style.html", head('<style>/* <meta name="wiki-signal" content="none"> */</style>'));
    await write("archive/dataname.html", head('<meta data-name="wiki-signal" content="none">'));
    await write("archive/datacontent.html", head('<meta name="wiki-signal" data-content="none">'));
    // Control: the real tag after a comment and a script still culls.
    await write(
      "archive/real.html",
      head('<!-- note --><script>let x = 1;</script><meta name="wiki-signal" content="none">'),
    );
    const index = await buildWikiIndex(root);

    for (const rel of ["comment", "script", "style", "dataname", "datacontent"]) {
      expect({ rel, culled: pageOf(index, `archive/${rel}.html`).culled }).toEqual({ rel, culled: undefined });
    }
    expect(pageOf(index, "archive/real.html").culled).toBe(true);
  });

  test("a `<!--` inside a <script> string opens no comment: the real tag after the script still culls", async () => {
    await write(
      "archive/script-opener.html",
      head('<script>var s = "<!--";</script><meta name="wiki-signal" content="none">'),
    );
    // …and a `<script>` inside a comment opens no script body.
    await write(
      "archive/comment-script.html",
      head('<!-- <script> --><meta name="wiki-signal" content="none">'),
    );
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "archive/script-opener.html").culled).toBe(true);
    expect(pageOf(index, "archive/comment-script.html").culled).toBe(true);
  });

  test("an UNTERMINATED comment or script body runs to the end of the sniffed prefix: a tag after it is text", async () => {
    await write("archive/open-comment.html", head('<!-- draft <meta name="wiki-signal" content="none">'));
    await write("archive/open-script.html", head('<script>let t = \'<meta name="wiki-signal" content="none">\';'));
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "archive/open-comment.html").culled).toBeUndefined();
    expect(pageOf(index, "archive/open-script.html").culled).toBeUndefined();
  });

  test("the REASON is read through the same strict sniff: a commented-out reason is no reason", async () => {
    await write(
      "archive/reason.html",
      head('<meta name="wiki-signal" content="none"><!-- <meta name="wiki-signal-reason" content="draft note"> -->'),
    );
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "archive/reason.html").culled).toBe(true);
    expect(pageOf(index, "archive/reason.html").cullReason).toBeUndefined();
  });
});

describe("pairAttachments and the culled bit", () => {
  const html = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body>x</body></html>`;

  test("an attachment child (twin, prototype) of a culled page is culled too, with the parent's reason", async () => {
    await write("plans/x.mdx", md(["title: X", "signal: none", "signal-reason: done"]));
    await write("plans/x.html", html("X diagram"));
    await write("plans/x-prototype.html", html("X prototype"));
    const index = await buildWikiIndex(root);

    for (const rel of ["plans/x.html", "plans/x-prototype.html"]) {
      const child = pageOf(index, rel);
      expect(child.parent).toBe("plans/x.mdx");
      expect(child.culled).toBe(true);
      expect(child.cullReason).toBe("done");
    }
  });

  test("a culled successor adopts NO rule-4 child: the superseded page lists at top level", async () => {
    await write("plans/new.md", md(["title: New", "signal: none", "signal-reason: retired too"]));
    await write("plans/old.md", md(["title: Old", "superseded_by: [[new]]"]));
    const index = await buildWikiIndex(root);

    const old = pageOf(index, "plans/old.md");
    expect(old.parent).toBeUndefined();
    expect(old.pairedBy).toBeUndefined();
    // …and it stays live: a rule-4 child never inherits.
    expect(old.culled).toBeUndefined();
    expect(pageOf(index, "plans/new.md").children).toBeUndefined();
  });

  test("control: the same pair with a LIVE successor folds; a culled child under it stays culled", async () => {
    await write("plans/new.md", md(["title: New"]));
    await write("plans/old.md", md(["title: Old", "superseded_by: [[new]]", "signal: none"]));
    const index = await buildWikiIndex(root);

    const old = pageOf(index, "plans/old.md");
    expect(old.parent).toBe("plans/new.md");
    expect(old.culled).toBe(true);
    // The live parent does not catch its child's cull.
    expect(pageOf(index, "plans/new.md").culled).toBeUndefined();
  });
});

describe("supersededBy — resolved in ANY folder", () => {
  test("a wikilink path, a bare stem and a relative path each resolve to the successor's relPath", async () => {
    await write("plans/successor.mdx", md(["title: The successor"]));
    await write("archive/a.md", md(["title: A", "superseded_by: [[plans/successor]]"]));
    await write("archive/b.md", md(["title: B", "superseded_by: successor"]));
    await write("archive/c.md", md(["title: C", "superseded_by: ../plans/successor.mdx"]));
    await write("archive/d.md", md(["title: D", "superseded_by: [[nowhere]]"]));
    const index = await buildWikiIndex(root);

    for (const rel of ["archive/a.md", "archive/b.md", "archive/c.md"]) {
      expect(pageOf(index, rel).supersededBy).toBe("plans/successor.mdx");
      // Cross-folder: the pairing pass does NOT fold these (rule 4 is same-folder).
      expect(pageOf(index, rel).parent).toBeUndefined();
    }
    expect(pageOf(index, "archive/d.md").supersededBy).toBeUndefined();
  });

  test("a BARE name resolves in the page's own folder first — the page the rail folds it under", async () => {
    // Both `archive/b.md` and `plans/b.md` exist; `archive/` registers first, so
    // the wiki-wide first-wins resolve answers the wrong one.
    await write("archive/b.md", md(["title: Archive B"]));
    await write("plans/b.md", md(["title: Plans B"]));
    await write("plans/a.md", md(["title: A", "superseded_by: \"[[b]]\""]));
    // A bare name with NO same-folder page still resolves wiki-wide.
    await write("plans/c.md", md(["title: C", "superseded_by: only-in-archive"]));
    await write("archive/only-in-archive.md", md(["title: Only"]));
    // A PATH form keeps resolving across folders.
    await write("plans/e.md", md(["title: E", "superseded_by: [[archive/b]]"]));
    const index = await buildWikiIndex(root);

    const a = pageOf(index, "plans/a.md");
    expect(a.parent).toBe("plans/b.md");
    expect(a.supersededBy).toBe("plans/b.md");
    expect(pageOf(index, "plans/c.md").supersededBy).toBe("archive/only-in-archive.md");
    expect(pageOf(index, "plans/e.md").supersededBy).toBe("archive/b.md");
  });

  test("a bare name SPELLING an extension names the page rule 4 folds it under, not the file as written", async () => {
    await write("plans/b.md", md(["title: B"]));
    await write("plans/b.html", "<!doctype html><html><head><title>B diagram</title></head><body>x</body></html>");
    await write("plans/html-spelled.md", md(["title: H", "superseded_by: b.html"]));
    await write("plans/mdx-spelled.md", md(["title: M", "superseded_by: b.mdx"]));
    const index = await buildWikiIndex(root);

    for (const rel of ["plans/html-spelled.md", "plans/mdx-spelled.md"]) {
      expect({ rel, parent: pageOf(index, rel).parent }).toEqual({ rel, parent: "plans/b.md" });
      expect({ rel, banner: pageOf(index, rel).supersededBy }).toEqual({ rel, banner: "plans/b.md" });
    }
  });

  test("a spelled .html with NO markdown page of that stem names the .html in the page's own folder", async () => {
    // archive/ registers first, so a wiki-wide lookup would answer the wrong one.
    await write("archive/c.html", "<!doctype html><html><head><title>Archive C</title></head><body>x</body></html>");
    await write("plans/c.html", "<!doctype html><html><head><title>Plans C</title></head><body>x</body></html>");
    await write("plans/d.md", md(["title: D", "superseded_by: c.html"]));
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "plans/d.md").parent).toBeUndefined();
    expect(pageOf(index, "plans/d.md").supersededBy).toBe("plans/c.html");
  });

  test("a same-folder .mdx successor wins over a wiki-wide .mdx of the same stem", async () => {
    // (An `archive/b.md` would shadow `plans/b.mdx` out of the index altogether.)
    await write("archive/b.mdx", md(["title: Archive B"]));
    await write("plans/b.mdx", md(["title: Plans B"]));
    await write("plans/a.md", md(["title: A", "superseded_by: b"]));
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "plans/a.md").parent).toBe("plans/b.mdx");
    expect(pageOf(index, "plans/a.md").supersededBy).toBe("plans/b.mdx");
  });

  test("a bare name naming the page ITSELF falls through to the wiki-wide lookup", async () => {
    await write("archive/b.md", md(["title: Archive B"]));
    await write("plans/b.md", md(["title: Plans B", "superseded_by: b"]));
    const index = await buildWikiIndex(root);

    expect(pageOf(index, "plans/b.md").parent).toBeUndefined();
    expect(pageOf(index, "plans/b.md").supersededBy).toBe("archive/b.md");
  });
});

describe("aliasWorkedPaths", () => {
  const dirs = new Set(["archive", "plans"]);

  test("a path alias tries .md then .mdx; one with an extension is used as written; a bare name is no path", () => {
    expect(aliasWorkedPaths("archive/old-plan", dirs)).toEqual(["archive/old-plan.md", "archive/old-plan.mdx"]);
    expect(aliasWorkedPaths("[[archive/Old-Plan|label]]", dirs)).toEqual(["archive/old-plan.md", "archive/old-plan.mdx"]);
    expect(aliasWorkedPaths("./old-plan.mdx", dirs)).toEqual(["old-plan.mdx"]);
    expect(aliasWorkedPaths("Alternative name", dirs)).toEqual([]);
  });

  test("a slash alias whose first segment is no directory of this wiki is a TITLE alias, not a path", () => {
    expect(aliasWorkedPaths("claude.ai/design", dirs)).toEqual([]);
    expect(aliasWorkedPaths("coleam00/Archon", dirs)).toEqual([]);
    expect(aliasWorkedPaths("/ultrareview", dirs)).toEqual([]);
    // The real melosys-kode-wiki spelling: no extension, an existing folder.
    expect(
      aliasWorkedPaths("archive/melosys-eessi/2026-05-24-melosys-7821-avvikle-basic-auth-sak-plan-review", dirs),
    ).toEqual([
      "archive/melosys-eessi/2026-05-24-melosys-7821-avvikle-basic-auth-sak-plan-review.md",
      "archive/melosys-eessi/2026-05-24-melosys-7821-avvikle-basic-auth-sak-plan-review.mdx",
    ]);
  });

  test("the alias's folder segment is compared without case", () => {
    expect(aliasWorkedPaths("Archive/Old-Plan", dirs)).toEqual(["archive/old-plan.md", "archive/old-plan.mdx"]);
  });

  test("a spelled extension (.md, .mdx, .html) is used as written", () => {
    expect(aliasWorkedPaths("archive/x.html", dirs)).toEqual(["archive/x.html"]);
    expect(aliasWorkedPaths("archive/x.md", dirs)).toEqual(["archive/x.md"]);
    expect(aliasWorkedPaths("x.html", dirs)).toEqual(["x.html"]);
  });
});

describe("Activity drops culled pages — through the store's effective value", () => {
  test("a culled page AND its live .html twin (no meta of its own) leave Activity; a fresh live page stays", async () => {
    await write("plans/retired.mdx", md(["title: Retired", "signal: none"]));
    await write("plans/retired.html", "<!doctype html><html><head><title>Retired diagram</title></head><body>x</body></html>");
    await write("plans/live.mdx", md(["title: Live"]));
    const index = await buildWikiIndex(root);
    const listing = index.pages.map((p) => toListing(index, p) as unknown as WikiListing);
    // The twin carries no cull of its own on disk; the listing says culled.
    expect(listing.find((p) => p.relPath === "plans/retired.html")!.culled).toBe(true);

    const ranked = rankActivity(listing, DEFAULT_ACTIVITY_WEIGHTS, Date.now()).map((r) => r.page.relPath);
    expect(ranked).toContain("plans/live.mdx");
    expect(ranked).not.toContain("plans/retired.mdx");
    expect(ranked).not.toContain("plans/retired.html");
  });
});

describe("ONE census-inclusive series head: lint, the rail fold, the reader header, the series menu and editor, continue at", () => {
  // Plan M2: the series CENSUS includes culled pages, so a culled member can be
  // the head and name the fold. Lint never EDITS a culled page — it normalises
  // the LIVE members to the head's spelling and label instead.
  const NOW = Date.parse("2026-09-20T12:00:00Z");
  const series = (title: string, o: { date: string; key?: string; label?: string; plan?: boolean; culled?: boolean }, body = "Prose.") =>
    md(
      [
        `title: ${title}`,
        `status_date: ${o.date}`,
        ...(o.plan ? ["plan_status: in-flight"] : []),
        ...(o.key ? [`series: ${o.key}`] : []),
        ...(o.label ? [`series_label: ${o.label}`] : []),
        ...(o.culled ? ["signal: none"] : []),
      ],
      body,
    );
  const listingOf = async () => {
    const index = await buildWikiIndex(root);
    return index.pages.map((p) => toListing(index, p) as unknown as WikiListing);
  };
  /** Everything a reader sees name the one series: the fold, the header, the menu, `▸`/continue-at. */
  const railView = async (openRel: string) => {
    const listing = await listingOf();
    const groups = groupSeries(listing, listing, NOW);
    expect(groups).toHaveLength(1);
    const g = groups[0]! as { label: string; latestRel?: string };
    const described = seriesMembersOf(listing, "work", NOW);
    const header = described.head;
    const menu = buildSeriesMenu(listing, openRel, NOW)!;
    return {
      fold: g.label,
      header: header?.seriesLabel || header?.series,
      menu: menu.label,
      headRel: menu.headRel,
      latest: g.latestRel,
      continueAt: described.latest?.relPath,
    };
  };
  const seriesFindings = async () => {
    const index = await buildWikiIndex(root);
    return (await lintWiki(index, { now: () => NOW })).findings.filter((f) => f.check === "series-inconsistent");
  };
  const editsOf = (fs: Awaited<ReturnType<typeof seriesFindings>>) =>
    fs.flatMap((f) => f.fix?.edits ?? []).map((e) => `${e.relPath} ${"key" in e ? e.key : ""}=${"value" in e ? e.value : ""}`).sort();

  test("label: lint keeps the culled head's label the fold, header and menu show; after the fix they still agree", async () => {
    await write("plans/dead.mdx", series("Dead", { date: "2026-09-18", key: "work", label: "Dead label", culled: true }));
    await write("plans/keep.mdx", series("Keep", { date: "2026-09-12", key: "work", label: "Keep label", plan: true }));
    await write("plans/old.mdx", series("Old", { date: "2026-09-10", key: "work", label: "Old label" }));

    const [f, ...rest] = await seriesFindings();
    expect(rest).toHaveLength(0);
    expect(f!.detail).toContain('keeping "Dead label" on plans/dead.mdx');
    expect(f!.relPath).not.toBe("plans/dead.mdx");
    expect(editsOf([f!])).toEqual(["plans/keep.mdx series_label=null", "plans/old.mdx series_label=null"]);
    expect(await railView("plans/keep.mdx")).toMatchObject({
      fold: "Dead label",
      header: "Dead label",
      menu: "Dead label",
      headRel: "plans/dead.mdx",
    });

    // Apply the fix (drop the two live labels): lint goes silent and every surface still reads the kept label.
    await write("plans/keep.mdx", series("Keep", { date: "2026-09-12", key: "work", plan: true }));
    await write("plans/old.mdx", series("Old", { date: "2026-09-10", key: "work" }));
    expect(await seriesFindings()).toHaveLength(0);
    expect(await railView("plans/keep.mdx")).toMatchObject({ fold: "Dead label", header: "Dead label", menu: "Dead label" });
  });

  test("spelling: lint normalises the live members to the culled newest plan's spelling, which every surface shows", async () => {
    await write("plans/dead.mdx", series("Dead", { date: "2026-09-18", key: "WORK", plan: true, culled: true }));
    await write("plans/live.mdx", series("Live", { date: "2026-09-12", key: "work", plan: true }));
    await write("plans/odd.mdx", series("Odd", { date: "2026-09-10", key: "Work" }));

    const [f, ...rest] = await seriesFindings();
    expect(rest).toHaveLength(0);
    expect(f!.relPath).not.toBe("plans/dead.mdx");
    expect(editsOf([f!])).toEqual(["plans/live.mdx series=WORK", "plans/odd.mdx series=WORK"]);
    expect(await railView("plans/live.mdx")).toEqual({
      fold: "WORK",
      header: "WORK",
      menu: "WORK",
      headRel: "",
      // continue at / `▸` name the newest plan of the whole census — the culled one.
      latest: "plans/dead.mdx",
      continueAt: "plans/dead.mdx",
    });

    // Apply the fix: lint goes silent, the surfaces are unchanged.
    await write("plans/live.mdx", series("Live", { date: "2026-09-12", key: "WORK", plan: true }));
    await write("plans/odd.mdx", series("Odd", { date: "2026-09-10", key: "WORK" }));
    expect(await seriesFindings()).toHaveLength(0);
    expect((await railView("plans/live.mdx")).fold).toBe("WORK");
  });

  test("the newest-PLAN rung picks the head: a culled plan outranks a newer live non-plan for spelling, join and continue at", async () => {
    // z-dead is the newest PLAN but not the newest member; a-blog (no plan_status) is newer.
    await write("plans/z-dead.mdx", series("Dead", { date: "2026-09-12", key: "WORK", plan: true, culled: true }, "See [[Blog]]."));
    await write("plans/a-blog.mdx", series("Blog", { date: "2026-09-18", key: "Work" }, "See [[B]] and [[Dead]]."));
    await write("plans/b.mdx", series("B", { date: "2026-09-14", plan: true }, "See [[Blog]]."));

    const fs = await seriesFindings();
    // 8.3(a) normalises the live blog, 8.3(c) joins b — both to the culled plan's spelling.
    expect(editsOf(fs)).toEqual(["plans/a-blog.mdx series=WORK", "plans/b.mdx series=WORK"]);
    expect(fs.every((f) => f.relPath !== "plans/z-dead.mdx")).toBe(true);
    const view = await railView("plans/a-blog.mdx");
    expect(view).toMatchObject({ fold: "WORK", header: "WORK", menu: "WORK", latest: "plans/z-dead.mdx", continueAt: "plans/z-dead.mdx" });
  });

  test("control: a culled member that ALONE declares the series still names it on the rail", async () => {
    await write("plans/dead.mdx", series("Dead", { date: "2026-09-18", key: "work", label: "Dead label", culled: true }));
    const listing = await listingOf();
    expect(groupSeries(listing, listing, NOW)[0]!.label).toBe("Dead label");
    expect(seriesMembersOf(listing, "work", NOW).head?.seriesLabel).toBe("Dead label");
  });

  describe("the series editor agrees with the head the fold shows", () => {
    const app = () => {
      const a = new Hono();
      registerWikiSeriesRoutes(a, { lockWaitMs: 50 });
      return a;
    };
    const post = async (body: Record<string, unknown>) => {
      const rel = body.relPath as string;
      const baseHash = sha256(await Bun.file(path.join(root, rel)).text());
      return app().request("/api/wiki/series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wiki: "w", baseHash, ...body }),
      });
    };
    beforeEach(() => {
      __setWikiRegistryForTest([{ name: "w", root, source: "extra" }]);
    });
    afterEach(() => {
      __resetWikiRegistryForTest();
      __resetWikiCacheForTest();
    });

    test("a culled labelled head + a live unlabelled member: the fold names the head, and the menu's head move names the live member without a 409", async () => {
      await write("plans/dead.mdx", series("Dead", { date: "2026-09-18", key: "work", label: "Dead label", culled: true }));
      await write("plans/live.mdx", series("Live", { date: "2026-09-12", key: "work", plan: true }));

      const before = await railView("plans/live.mdx");
      expect(before).toMatchObject({ fold: "Dead label", header: "Dead label", menu: "Dead label", headRel: "plans/dead.mdx" });

      // Naming the live member while the head still carries the label is the fork the
      // editor refuses — and the 409 names the page the fold is showing.
      const fork = await post({ relPath: "plans/live.mdx", series: "work", seriesLabel: "New name" });
      expect(fork.status).toBe(409);
      expect(await fork.json()).toMatchObject({ twoHeaded: true, headRelPath: before.headRel });

      // The menu's own head move: clear the head the menu showed, then label the live member.
      const listing = await listingOf();
      const writes = headMoveWrites(buildSeriesMenu(listing, "plans/live.mdx", NOW)!, "plans/live.mdx", "New name");
      expect(writes.map((w) => w.relPath)).toEqual(["plans/dead.mdx", "plans/live.mdx"]);
      for (const w of writes) {
        const res = await post({ ...w });
        expect(res.status).toBe(200);
      }
      expect(await railView("plans/live.mdx")).toMatchObject({
        fold: "New name",
        header: "New name",
        menu: "New name",
        headRel: "plans/live.mdx",
      });
      expect(await seriesFindings()).toHaveLength(0);
    });
  });
});
