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
import { aliasWorkedPaths, buildWikiIndex, readCull, type WikiIndex } from "./store.ts";
import { toListing } from "../dashboard/routes/wiki-routes.ts";
import { DEFAULT_ACTIVITY_WEIGHTS, rankActivity } from "../dashboard/views/components/wiki-activity-rank.ts";
import type { WikiListing } from "../dashboard/views/components/wiki-filter.ts";

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
