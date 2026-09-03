/**
 * /wiki reader — the Project facet, end-to-end.
 *
 * A page's `project` is resolved SERVER-side from the wiki's own
 * `.wiki-reader.json` declaration (`resolveProject`, `src/wiki/store.ts`), and
 * the reader renders a facet from the resulting `projects` count map. Two things
 * no unit test can prove live here:
 *
 *   1. **The presence gate.** The chip row exists on a wiki that DECLARES a
 *      project rule and is absent on one that does not — which is every wiki
 *      that predates the declaration, and which must look exactly as it did.
 *   2. **`?project=` as URL state.** This is the reader's first facet deep link,
 *      so the round trip (load → narrowed list with the chip active; a value the
 *      wiki does not know → whole wiki AND the param dropped; a chip click →
 *      the param written in place, `?relPath=` preserved) only exists in a real
 *      browser against a real listing.
 *
 * The recipe is `wiki-status-facet.spec.ts`': two temp roots in one
 * comma-separated `WIKI_EXTRA` on a muninn of this file's own, on the fixed port
 * from `e2e/ports.ts`. It CANNOT ride the shared 3011 server (whose command
 * carries no `WIKI_EXTRA`, and whose `reuseExistingServer` would hand us a dev
 * server without it), and it CANNOT assert against a real wiki — mimir's project
 * rule is real, but this harness mounts only its own throwaway roots and muninn
 * is a public repo, so every page name below is invented.
 *
 * No model calls anywhere — the facet is client-side rendering over the
 * `/api/wiki/pages` payload.
 *
 * ENV PREREQUISITE: the same one every other e2e spec has — a working `.env`
 * (`DATABASE_URL` at minimum) at the repo root, since `src/index.ts` boots the
 * full process. Bun auto-loads it in the spawned child (cwd = repo root).
 *
 * SPAWN ENV: `e2eEnv()` keeps this muninn off Telegram/Slack and blanks the
 * instance-profile flags, so a spawned server behaves the same on every host.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-project-facet");
const BASE = `http://127.0.0.1:${PORT}`;
/** The wiki that DECLARES a project rule. */
const WIKI_WITH = "e2e-projects";
/** The control: the same pages, no `.wiki-reader.json` at all. */
const WIKI_WITHOUT = "e2e-noprojects";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/**
 * The declaration under test. Every field is exercised by a page below, and the
 * folder names are INVENTED — the whole point of the feature is that muninn
 * learns a layout from the wiki rather than naming one, so a fixture reusing a
 * real wiki's folders would hide a hardcoded folder name rather than expose it.
 */
const READER_CONFIG = JSON.stringify(
  {
    project: {
      pathFolders: ["areas"],
      pageFolder: "units",
      filePrefixFolders: ["drafts"],
      frontmatter: [],
      tagFallback: true,
      aliases: { pc: "pomme-core" },
    },
  },
  null,
  2,
);

const PROJECT = "pomme-core";
const OTHER = "quill";
/** The hub page: its own stem IS its project, which is what the article header's
 *  "N pages about …" chip keys off. */
const HUB_REL = `units/${PROJECT}.md`;

function mdPage(title: string, tags?: string[]): string {
  const fm = tags ? [`tags: [${tags.join(", ")}]`] : [];
  return ["---", `title: ${title}`, ...fm, "---", "", `# ${title}`, "", "Body.", ""].join("\n");
}

/**
 * Five pomme-core pages across FOUR of the declaration's resolution rules (the
 * `frontmatter: []` rule is on but matches nothing, by design — an empty field
 * list is what a wiki declaring no frontmatter key looks like):
 *   - `units/pomme-core.md`        rule 2, the page-per-project folder (the HUB)
 *   - `areas/pomme-core/{a,b}.md`  rule 1, a path folder's second segment
 *   - `drafts/pomme-core-rollout`  rule 3, a known project prefixing the stem
 *   - `notes/tagged.md` (tag `pc`) rule 5, the first tag through the aliases
 * …plus a second project (2 pages) and one page belonging to no project at all,
 * so "everything else" is a real state rather than an empty set.
 */
const WITH_PAGES: Record<string, string> = {
  [HUB_REL]: mdPage("Pomme Core"),
  [`areas/${PROJECT}/a.md`]: mdPage("Alpha"),
  [`areas/${PROJECT}/b.md`]: mdPage("Beta"),
  [`drafts/${PROJECT}-rollout.md`]: mdPage("Rollout"),
  "notes/tagged.md": mdPage("Tagged", ["pc"]),
  [`units/${OTHER}.md`]: mdPage("Quill"),
  [`areas/${OTHER}/z.md`]: mdPage("Zeta"),
  "notes/loose.md": mdPage("Loose"),
};
/** Every page pomme-core owns, in the reader's default sort-independent set. */
const PROJECT_RELPATHS = [
  HUB_REL,
  `areas/${PROJECT}/a.md`,
  `areas/${PROJECT}/b.md`,
  `drafts/${PROJECT}-rollout.md`,
  "notes/tagged.md",
];
const TOTAL_PAGES = Object.keys(WITH_PAGES).length; // 8

let server: ChildProcess | undefined;
let rootWith = "";
let rootWithout = "";

async function writePages(root: string, pages: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(pages)) {
    const dest = path.join(root, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body, "utf8");
  }
}

test.beforeAll(async () => {
  rootWith = await mkdtemp(path.join(tmpdir(), "muninn-e2e-projects-"));
  rootWithout = await mkdtemp(path.join(tmpdir(), "muninn-e2e-noprojects-"));
  await writePages(rootWith, WITH_PAGES);
  await writePages(rootWithout, WITH_PAGES);
  // The ONLY difference between the two roots.
  await writeFile(path.join(rootWith, ".wiki-reader.json"), READER_CONFIG, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI_WITH}=${rootWith},${WIKI_WITHOUT}=${rootWithout}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_WITH}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (rootWith) await rm(rootWith, { recursive: true, force: true });
  if (rootWithout) await rm(rootWithout, { recursive: true, force: true });
});

/** Open the reader and the Filters disclosure the facet rows live in, waiting for
 *  the listing that populates them rather than for a fixed delay. */
async function openReader(page: import("@playwright/test").Page, query: string): Promise<void> {
  const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages"), { timeout: 15_000 });
  await page.goto(`${BASE}/wiki?${query}`);
  await listing;
}

const relPathsOf = (page: import("@playwright/test").Page) =>
  page.locator(".wiki-list-item").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-relpath")).sort(),
  );

test.describe("Wiki reader: project facet", () => {
  test("the chip row renders with per-project counts and filters the list", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(TOTAL_PAGES);

    // The facet lives inside the Filters disclosure, closed until a filter is set.
    await page.locator("#wikiFilters summary").click();
    const row = page.locator("#projectChips");
    await expect(row).toBeVisible();
    // Five pages, resolved by four different rules, landing on ONE project.
    await expect(row.locator(`[data-project="${PROJECT}"]`)).toHaveText(`${PROJECT} 5`);
    await expect(row.locator(`[data-project="${OTHER}"]`)).toHaveText(`${OTHER} 2`);
    // Count DESC: the bigger project leads, whatever the alphabet says.
    await expect(row.locator(".wiki-chip").nth(1)).toHaveText(`${PROJECT} 5`);
    // The project-less page has no chip of its own — it is reachable only by
    // clearing the filter.
    await expect(row.locator(".wiki-chip")).toHaveCount(3); // All projects + 2

    await row.locator(`[data-project="${PROJECT}"]`).click();
    expect(await relPathsOf(page)).toEqual([...PROJECT_RELPATHS].sort());
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    await expect(page.locator("#wikiFilterCount")).toHaveText("1");
    // The click is URL state, written in place.
    expect(new URL(page.url()).searchParams.get("project")).toBe(PROJECT);

    // Re-clicking the active chip clears it (the tag/status-row convention).
    await row.locator(`[data-project="${PROJECT}"]`).click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(TOTAL_PAGES);
    expect(new URL(page.url()).searchParams.has("project")).toBe(false);
  });

  test("the facet is absent on a wiki that declares no project rule", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITHOUT}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(TOTAL_PAGES);
    await page.locator("#wikiFilters summary").click();
    // The type row is up, so a hidden project row is a real gate decision and not
    // just an unopened panel.
    await expect(page.locator("#typeChips")).toBeVisible();
    await expect(page.locator("#projectChips")).toBeHidden();
    await expect(page.locator("#projectChips")).toBeEmpty();
    // …and the article header's hub chip is gone with it, on the very page that
    // carries it on the declaring wiki.
    await page.locator(`.wiki-list-item[data-relpath="${HUB_REL}"]`).click();
    await expect(page.locator(".wiki-article-head")).toBeVisible();
    await expect(page.locator("[data-project-hub]")).toHaveCount(0);
  });

  test("a ?project= deep link opens narrowed, with the chip active", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}&project=${PROJECT}`);
    expect(await relPathsOf(page)).toEqual([...PROJECT_RELPATHS].sort());
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    // An active filter auto-opens the disclosure, so the chip explaining the
    // narrowed list is on screen without a click.
    await expect(page.locator("#wikiFilters")).toHaveAttribute("open", "");
    const chip = page.locator(`#projectChips [data-project="${PROJECT}"]`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/active/);
    await expect(page.locator('#projectChips [data-project=""]')).not.toHaveClass(/active/);
    // The link survives a reload as itself.
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(5);
    await expect(page.locator(`#projectChips [data-project="${PROJECT}"]`)).toHaveClass(/active/);
  });

  test("a ?project= the wiki does not know opens the whole wiki and drops the param", async ({
    page,
  }) => {
    // The stale-link rule. Applied, the value would render an empty list under a
    // chip row that cannot contain the chip emptying it — and the URL is the only
    // state there is, so there would be nothing to go back to.
    await openReader(page, `wiki=${WIKI_WITH}&project=nonexistent`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(TOTAL_PAGES);
    await expect(page.locator("#wikiCount")).toHaveText(`${TOTAL_PAGES} / ${TOTAL_PAGES}`);
    expect(new URL(page.url()).searchParams.has("project")).toBe(false);
    await page.locator("#wikiFilters summary").click();
    // "All projects" is the active chip — the row is up, nothing is filtered.
    await expect(page.locator('#projectChips [data-project=""]')).toHaveClass(/active/);
    await expect(page.locator("#projectChips .wiki-chip.active")).toHaveCount(1);
    await expect(page.locator("#wikiFilterCount")).toBeHidden();
  });

  test("the hub page offers 'N pages about <project>' and it filters", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}`);
    await page.locator(`.wiki-list-item[data-relpath="${HUB_REL}"]`).click();
    const hub = page.locator("[data-project-hub]");
    await expect(hub).toHaveText(`5 pages about ${PROJECT}`);
    // A member page of the same project is NOT a hub — the chip is the landing
    // page's affordance, not a badge on all five.
    await page.locator(`.wiki-list-item[data-relpath="areas/${PROJECT}/a.md"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");
    await expect(page.locator("[data-project-hub]")).toHaveCount(0);

    await page.locator(`.wiki-list-item[data-relpath="${HUB_REL}"]`).click();
    await expect(hub).toBeVisible();
    await hub.click();
    expect(await relPathsOf(page)).toEqual([...PROJECT_RELPATHS].sort());
    // The click writes the param IN PLACE: the article the reader is on must not
    // be navigated away from by a facet.
    const url = new URL(page.url());
    expect(url.searchParams.get("project")).toBe(PROJECT);
    expect(url.searchParams.get("relPath")).toBe(HUB_REL);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Pomme Core");
    // …and the Filters disclosure opened, so the chip row explains the narrowing.
    await expect(page.locator("#wikiFilters")).toHaveAttribute("open", "");
    await expect(page.locator(`#projectChips [data-project="${PROJECT}"]`)).toHaveClass(/active/);
  });

  test("Recently opened narrows under the filter, and loses its clear affordance", async ({
    page,
  }) => {
    await openReader(page, `wiki=${WIKI_WITH}`);
    // Two recents in two different projects.
    await page.locator(`.wiki-list-item[data-relpath="areas/${OTHER}/z.md"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Zeta");
    await page.locator(`.wiki-list-item[data-relpath="areas/${PROJECT}/a.md"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");

    const recentRows = page.locator('.wiki-list-item[data-section="recent"]');
    await expect(recentRows).toHaveCount(2);
    // With every facet inert the clear affordance is offered.
    await expect(page.locator("[data-clear-recents]")).toHaveCount(1);

    await page.locator("#wikiFilters summary").click();
    await page.locator(`#projectChips [data-project="${PROJECT}"]`).click();
    // The out-of-project recent no longer resolves against the filtered list.
    await expect(recentRows).toHaveCount(1);
    await expect(recentRows).toHaveAttribute("data-relpath", `areas/${PROJECT}/a.md`);
    /**
     * The load-bearing one (`railFacetsInert`). `clearRecents` empties the STORE,
     * and under a facet the section on screen is a SUBSET of it — so a clear
     * offered here destroys recents for pages the reader never saw. Leaving
     * `project` off that predicate is invisible in every other way.
     */
    await expect(page.locator("[data-clear-recents]")).toHaveCount(0);

    // Clearing the filter brings both the other recent and the affordance back.
    await page.locator('#projectChips [data-project=""]').click();
    await expect(recentRows).toHaveCount(2);
    await expect(page.locator("[data-clear-recents]")).toHaveCount(1);
  });

  test("an article opened under the filter keeps it — in the URL and across a reload", async ({
    page,
  }) => {
    await openReader(page, `wiki=${WIKI_WITH}`);
    await page.locator("#wikiFilters summary").click();
    await page.locator(`#projectChips [data-project="${PROJECT}"]`).click();
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);

    // Opening a row PUSHES a new URL. The rail — chip row included — is still on
    // screen and still narrowed, so a URL built from wiki + relPath alone lies
    // about the screen, and the next listing adopt then believes it.
    await page.locator(`.wiki-list-item[data-relpath="areas/${PROJECT}/a.md"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");
    const url = new URL(page.url());
    expect(url.searchParams.get("relPath")).toBe(`areas/${PROJECT}/a.md`);
    expect(url.searchParams.get("project")).toBe(PROJECT);
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);

    // …and the reload the reader (or a shared link) does next lands on the same
    // page under the same filter.
    await page.reload();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    await expect(page.locator(`#projectChips [data-project="${PROJECT}"]`)).toHaveClass(/active/);
  });

  test("Back restores the project the entry's URL names", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}&project=${PROJECT}`);
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    // A push: this overview entry keeps its own project.
    await page.locator(`.wiki-list-item[data-relpath="${HUB_REL}"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Pomme Core");
    // A chip REPLACES the article entry, so Back is a project change and nothing
    // else — the one state the reader can reach where the URL and the list can
    // disagree.
    await page.locator(`#projectChips [data-project="${OTHER}"]`).click();
    await expect(page.locator("#wikiCount")).toHaveText(`2 / ${TOTAL_PAGES}`);

    await page.goBack();
    expect(new URL(page.url()).searchParams.get("project")).toBe(PROJECT);
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    await expect(page.locator(`#projectChips [data-project="${PROJECT}"]`)).toHaveClass(/active/);
    await expect(page.locator(`#projectChips [data-project="${OTHER}"]`)).not.toHaveClass(/active/);
  });

  test("the breadcrumb crumb's href follows the project filter", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}`);
    await page.locator(`.wiki-list-item[data-relpath="${HUB_REL}"]`).click();
    const crumb = page.locator("a.wiki-bc-wiki");
    await expect(crumb).toBeVisible();
    const crumbProject = async () =>
      new URL((await crumb.getAttribute("href")) || "", BASE).searchParams.get("project");
    expect(await crumbProject()).toBeNull();

    // The crumb is rendered once per ARTICLE; a facet change after that render
    // leaves a middle-click / copy-link handing over the previous filter.
    await page.locator("#wikiFilters summary").click();
    await page.locator(`#projectChips [data-project="${PROJECT}"]`).click();
    expect(await crumbProject()).toBe(PROJECT);
    await page.locator(`#projectChips [data-project=""]`).click();
    expect(await crumbProject()).toBeNull();
  });

  test("a blank ?project= is dropped from the URL", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}&project=`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(TOTAL_PAGES);
    // Not a filter, so not a param — `?project=%20` was already cleaned and
    // `?project=` compared equal to "no filter" and stayed.
    expect(new URL(page.url()).searchParams.has("project")).toBe(false);
  });

  test("Back does not spring the Filters disclosure open", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}`);
    await page.locator("#wikiFilters summary").click();
    await page.locator(`#projectChips [data-project="${PROJECT}"]`).click();
    // An ARTICLE entry, so the chip below REPLACES it and Back is a project move
    // and nothing else — the one popstate branch that repaints the facet.
    await page.locator(`.wiki-list-item[data-relpath="${HUB_REL}"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Pomme Core");
    await page.locator(`#projectChips [data-project="${OTHER}"]`).click();
    await expect(page.locator("#wikiCount")).toHaveText(`2 / ${TOTAL_PAGES}`);

    // The reader collapses the stack deliberately.
    await page.locator("#wikiFilters summary").click();
    await expect(page.locator("#wikiFilters")).not.toHaveAttribute("open", "");

    await page.goBack();
    // The list follows the URL's project...
    expect(new URL(page.url()).searchParams.get("project")).toBe(PROJECT);
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    // ...and Back is not a filter CLICK: it must not re-open what the reader
    // closed. `syncFilters()` auto-opens by default, which is right for the chip
    // and hub-chip callers and wrong here.
    await expect(page.locator("#wikiFilters")).not.toHaveAttribute("open", "");
  });

  test("the by-name fallback URL carries the project too", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}&project=${PROJECT}`);
    await expect(page.locator("#wikiCount")).toHaveText(`5 / ${TOTAL_PAGES}`);
    /**
     * `fetchAndRenderPage` pushes `?relPath=` off the RESOLVED page and falls back
     * to `?page=<name>` only for a response carrying no relPath — which the real
     * route never sends (`relPath` is a required field on every index entry, and
     * `/api/wiki/page` answers straight off it). So the fallback's URL is
     * reachable only by stubbing the response at the network boundary (the
     * `wiki-integrate.spec.ts` precedent); without this case the `project`
     * argument of `pageUrl` is pinned by nothing.
     */
    await page.route(
      (url) => url.pathname === "/api/wiki/page",
      async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as { meta?: Record<string, unknown> };
        if (body.meta) delete body.meta.relPath;
        await route.fulfill({ response: res, json: body });
      },
    );
    await page.locator(`.wiki-list-item[data-relpath="areas/${PROJECT}/a.md"]`).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Alpha");
    const url = new URL(page.url());
    expect(url.searchParams.get("relPath")).toBeNull();
    expect(url.searchParams.get("page")).toBe("a");
    expect(url.searchParams.get("project")).toBe(PROJECT);
  });

  test("writing the param preserves the URL's hash", async ({ page }) => {
    await openReader(page, `wiki=${WIKI_WITH}#wiki-anchor`);
    await page.locator("#wikiFilters summary").click();
    await page.locator(`#projectChips [data-project="${PROJECT}"]`).click();
    const url = new URL(page.url());
    expect(url.searchParams.get("project")).toBe(PROJECT);
    expect(url.hash).toBe("#wiki-anchor");
  });
});
