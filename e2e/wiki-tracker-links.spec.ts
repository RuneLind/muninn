/**
 * /wiki reader — tracker links, end to end (plan "Tracker links in the wiki
 * reader", PR 1: inference, rail pills and the widened Jira facet).
 *
 * Two temp wikis in ONE muninn, the pages invented and the keys synthetic
 * (project `DEMO`, host `example.invalid`) because muninn is a public repo:
 *
 *   - `e2e-trackers` declares a `trackers` block, so its pages learn their keys
 *     from title, file name, tags, links, "created" sentences and `issue:`;
 *   - `e2e-notrackers` declares none and carries one stamped `jira:` page, the
 *     control for the hard rule that a wiki without a tracker keeps today's
 *     stamped-only facet and strip, and shows no pills.
 *
 * The fixture mirrors the plan's anchor page: one page that CREATED three keys
 * (its created-marker line has the anchor's 2/70/138 shape and a dotted URL),
 * carries two tag keys and one body mention, and has `sessions:`; plus a page
 * with inferred keys and no provenance lines, a scalar `jira:` page, an `.html`
 * page, plans (one whose key is only in its file name, one whose key is only
 * under `issue:`), and a page whose title carries `ORA-01407` and a non-project
 * key. No session or PR is shared between two pages. PR 3 extends this file
 * with Connections and Link.
 *
 * No model calls and no writes. `KNOWLEDGE_API_URL` points at a port nothing
 * binds, so the strip's huginn lookup degrades instead of reaching a real
 * corpus.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-tracker-links");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-trackers";
const WIKI_PLAIN = "e2e-notrackers";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const READER_CONFIG = JSON.stringify({
  trackers: [
    {
      id: "jira",
      projects: ["DEMO"],
      hosts: ["example.invalid"],
      frontmatterKeys: ["issue", "tickets"],
      planTitle: "plan(er|en)?(?!\\p{L})",
      planTitleExclude: "testplan|review av",
      createdMarkers: ["opprettet", "created"],
      statusMap: { Ferdig: "done", "Akseptanse test": "review" },
    },
  ],
});

const url = (k: string) => `https://example.invalid/browse/${k}`;

function md(fm: string[], body: string): string {
  return ["---", ...fm, SETTLED_CREATED_LINE, "---", "", body, ""].join("\n");
}

/** The anchor-shaped page: created 101–103, tags 120/121, mentions 122. */
const ANCHOR = "archive/2026-01-10-rotaarsak.mdx";
const ANCHOR_LINE =
  "Status: ferdig 2026-01-05 · grunnlag: kjørt 22.09 (**12 rader**) · Jira opprettet: " +
  `[DEMO-101](${url("DEMO-101")}) (A1 grunnfeil), ` +
  `[DEMO-102](${url("DEMO-102")}) (A2 følgefeil), ` +
  `[DEMO-103](${url("DEMO-103")}) (B) · neste steg: A2.`;

const INFERRED = "notes/inferred-only.md";
const SCALAR = "notes/scalar.md";
const STAMPED = "notes/stamped.md";
const EXPLAINER = "explainers/forklaring.html";
const STEM_PLAN = "plans/2026-01-11-demo-160-plan.md";
const ISSUE_PLAN = "plans/utrulling.md";
const PLAN_A = "plans/arbeidsplan.md";
const PLAN_B = "plans/kjoreplan.md";
const ORA = "notes/ora.md";
const PLAIN = "notes/plain.md";

const PAGES: Record<string, string> = {
  [ANCHOR]: md(
    [
      "title: Hvorfor mangler radene metadata?",
      "tags: [demo-api, demo-120, demo-121]",
      "sessions: [claude-code:00000000-0000-4000-8000-000000000001]",
    ],
    `# Hvorfor mangler radene metadata?\n\n${ANCHOR_LINE}\n\nSe også DEMO-122 for bakgrunn.`,
  ),
  [INFERRED]: md(["title: DEMO-130 og DEMO-131 — notater"], "# Notater\n\nIngen proveniens her."),
  [SCALAR]: md(["title: Skalar", "jira: DEMO-140 (kilde), ny sak under epic DEMO-141 (oppfølging)"], "# Skalar"),
  [STAMPED]: md(["title: Stemplet", "jira: [DEMO-180]"], "# Stemplet"),
  [STEM_PLAN]: md(["title: Utrulling av ny kø", "type: plan"], "# Plan\n\nIngen nøkkel i teksten."),
  [ISSUE_PLAN]: md(["title: Utrullingsplan", "type: plan", "issue: DEMO-170"], "# Utrullingsplan"),
  [PLAN_A]: md(["title: DEMO-101 — arbeidsplan", "type: plan"], "# Arbeidsplan"),
  [PLAN_B]: md(["title: Kjøreplan for utrulling", "type: plan", "tags: [demo-121]"], "# Kjøreplan"),
  [ORA]: md(["title: Fallgruve (ORA-01407) på SAK-4711", "tags: [demo-api]"], "# Fallgruve"),
  [PLAIN]: md(["title: Vanlig side"], "# Vanlig side\n\nIngen saker."),
  [EXPLAINER]:
    "<!doctype html><html><head><title>DEMO-150 forklart</title></head>" +
    `<body><a href="${url("DEMO-199")}">DEMO-199</a></body></html>`,
};

/** Every non-mention key and the pages carrying it — the facet's ground truth. */
const KEY_PAGES: Record<string, string[]> = {
  "DEMO-101": [ANCHOR, PLAN_A],
  "DEMO-102": [ANCHOR],
  "DEMO-103": [ANCHOR],
  "DEMO-120": [ANCHOR],
  "DEMO-121": [ANCHOR, PLAN_B],
  "DEMO-130": [INFERRED],
  "DEMO-131": [INFERRED],
  "DEMO-140": [SCALAR],
  "DEMO-141": [SCALAR],
  "DEMO-150": [EXPLAINER],
  "DEMO-160": [STEM_PLAN],
  "DEMO-170": [ISSUE_PLAN],
  "DEMO-180": [STAMPED],
};

/** The control wiki: one stamped page, and an inferred-shaped page that must
 *  stay key-less there. */
const PLAIN_PAGES: Record<string, string> = {
  [STAMPED]: PAGES[STAMPED]!,
  [INFERRED]: PAGES[INFERRED]!,
};

let server: ChildProcess | undefined;
const roots: string[] = [];

async function writeWiki(pages: Record<string, string>, config?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-trackers-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  if (config) await writeFile(path.join(root, ".wiki-reader.json"), config, "utf8");
  await settleWikiMtimes(root);
  return root;
}

test.beforeAll(async () => {
  const root = await writeWiki(PAGES, READER_CONFIG);
  const rootPlain = await writeWiki(PLAIN_PAGES);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: "http://127.0.0.1:9",
      WIKI_EXTRA: `${WIKI}=${root},${WIKI_PLAIN}=${rootPlain}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function openReader(page: Page, query: string): Promise<void> {
  const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages"), { timeout: 15_000 });
  await page.goto(`${BASE}/wiki?${query}`);
  await listing;
  await expect(page.locator(".wiki-list-item").first()).toBeVisible();
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
const pills = (page: Page, rel: string) => row(page, rel).locator(".wiki-issue-pill[data-issue-key]");

async function listedRelPaths(page: Page): Promise<string[]> {
  return (await page.locator(".wiki-list-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath") ?? ""))).sort();
}

test.describe("Wiki reader: tracker links", () => {
  test("the index carries every relation; the listing drops mentions (API)", async () => {
    const res = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(ANCHOR)}`);
    const body = (await res.json()) as { meta: { issues: { key: string; relations: string[] }[] } };
    const byKey = Object.fromEntries(body.meta.issues.map((r) => [r.key, r.relations]));
    for (const k of ["DEMO-101", "DEMO-102", "DEMO-103"]) expect(byKey[k]![0]).toBe("created");
    expect(byKey["DEMO-120"]).toEqual(["tag"]);
    expect(byKey["DEMO-121"]).toEqual(["tag"]);
    expect(byKey["DEMO-122"]).toEqual(["mention"]);

    const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).json()) as {
      pages: { relPath: string; issues?: { key: string; relations: string[] }[] }[];
      jira: Record<string, number>;
    };
    const anchor = listing.pages.find((p) => p.relPath === ANCHOR)!;
    expect(anchor.issues!.map((r) => r.key)).not.toContain("DEMO-122");
    expect(anchor.issues!.every((r) => !r.relations.includes("mention"))).toBe(true);
    // The facet map is exactly the ground truth — no mention, no ORA, no MEL.
    expect(listing.jira).toEqual(Object.fromEntries(Object.entries(KEY_PAGES).map(([k, v]) => [k, v.length])));
    for (const p of [ORA, PLAIN]) expect(listing.pages.find((x) => x.relPath === p)!.issues).toBeUndefined();
  });

  test("1: pills on every keyed row, dashed when inferred, none on a key-less row, child count unchanged", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    for (const rel of new Set(Object.values(KEY_PAGES).flat())) {
      await expect(row(page, rel).locator(".wiki-issue-pill").first()).toBeVisible();
    }
    for (const rel of [ORA, PLAIN]) await expect(row(page, rel).locator(".wiki-issue-pill")).toHaveCount(0);

    // Stamped is solid; everything else dashed.
    await expect(pills(page, STAMPED)).toHaveClass("wiki-issue-pill");
    await expect(pills(page, SCALAR)).toHaveCount(2);
    for (const p of await pills(page, SCALAR).all()) await expect(p).not.toHaveClass(/inferred/);
    const dashed = await pills(page, INFERRED).first().evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(dashed).toBe("dashed");
    expect(await pills(page, STAMPED).evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");

    // The anchor carries five non-mention keys: two pills and a +3, strongest first.
    await expect(pills(page, ANCHOR)).toHaveCount(2);
    await expect(pills(page, ANCHOR).first()).toHaveAttribute("data-issue-rel", "created");
    await expect(row(page, ANCHOR).locator(".wiki-issue-pill.more")).toHaveText("+3");

    // The pills live INSIDE the title element: the row grows no child.
    const counts = await page.evaluate(
      ([a, b]) =>
        [a, b].map((rel) => document.querySelector(`.wiki-list-item[data-relpath="${rel}"]`)!.children.length),
      [ANCHOR, PLAIN],
    );
    expect(counts[0]).toBe(counts[1]);
    await expect(row(page, ANCHOR).locator(".wiki-list-title .wiki-issue-pills")).toHaveCount(1);
  });

  test("2: a chip's count equals the rows left after clicking it; top 8 plus +N", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    await page.locator("#wikiFilters summary").click();
    const chips = page.locator("#jiraChips");
    await expect(chips).toBeVisible();
    // 13 keys: "All issues", eight chips and the expander.
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(8);
    await expect(chips.locator("[data-jira-more]")).toHaveText("+5 issues");
    await chips.locator("[data-jira-more]").click();
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(13);

    for (const [key, rels] of Object.entries(KEY_PAGES)) {
      const chip = chips.locator(`[data-jira="${key}"]`);
      await expect(chip).toHaveText(`${key} ${rels.length}`);
      await chip.click();
      await expect(page.locator(".wiki-list-item")).toHaveCount(rels.length);
      expect(await listedRelPaths(page)).toEqual([...rels].sort());
      await chips.locator(`[data-jira="${key}"]`).click(); // re-click clears
      await expect(page.locator(".wiki-list-item")).toHaveCount(Object.keys(PAGES).length);
    }
  });

  test("2: a key selected from the URL outside the top 8 is shown", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}&jira=DEMO-180`);
    const chips = page.locator("#jiraChips");
    await expect(chips.locator('[data-jira="DEMO-180"]')).toHaveClass(/active/);
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(9);
    await expect(chips.locator("[data-jira-more]")).toHaveText("+4 issues");
    expect(await listedRelPaths(page)).toEqual([STAMPED]);
  });

  test("11: the stem-only and issue:-only plans show stem and declared; ORA and the non-project key appear nowhere", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    await expect(pills(page, STEM_PLAN)).toHaveAttribute("data-issue-key", "DEMO-160");
    await expect(pills(page, STEM_PLAN)).toHaveAttribute("data-issue-rel", "stem");
    await expect(pills(page, ISSUE_PLAN)).toHaveAttribute("data-issue-key", "DEMO-170");
    await expect(pills(page, ISSUE_PLAN)).toHaveAttribute("data-issue-rel", "declared");
    await page.locator("#wikiFilters summary").click();
    await page.locator("#jiraChips [data-jira-more]").click();
    for (const bad of ["ORA-01407", "SAK-4711", "DEMO-122", "DEMO-199"]) {
      await expect(page.locator(`[data-issue-key="${bad}"]`)).toHaveCount(0);
      await expect(page.locator(`#jiraChips [data-jira="${bad}"]`)).toHaveCount(0);
    }
  });

  test("8: a wiki with no trackers block keeps today's facet and strip, and shows no pills", async ({ page }) => {
    const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_PLAIN}`)).json()) as {
      pages: { issues?: unknown }[];
      jira: Record<string, number>;
    };
    expect(listing.jira).toEqual({ "DEMO-180": 1 });
    expect(listing.pages.every((p) => p.issues === undefined)).toBe(true);

    await openReader(page, `wiki=${WIKI_PLAIN}`);
    await expect(page.locator(".wiki-issue-pill")).toHaveCount(0);
    await page.locator("#wikiFilters summary").click();
    const chips = page.locator("#jiraChips");
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(1);
    await expect(chips.locator('[data-jira="DEMO-180"]')).toHaveText("DEMO-180 1");
    await expect(chips.locator("[data-jira-more]")).toHaveCount(0);

    // The strip's stamped key still renders as the facet control.
    await row(page, STAMPED).click();
    await expect(page.locator('[data-prov-jira="DEMO-180"]')).toBeVisible();
  });
});
