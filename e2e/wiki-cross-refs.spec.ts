/**
 * Cross-page ids in the /wiki reader (living facts PR 4), over a temp wiki of
 * synthetic pages: page B cites A's items as `O1 i [[plans/a]]`, `D1, O1 i
 * [[plans/a]]` and the rest of the acceptance list. What a unit test cannot
 * show: the real bundle wrapping each run before the in-page linker, the one
 * `GET /api/wiki/ref` call per linked page, the hover card filled from it, a
 * click that goes through the reader's page navigation and lands on A's item
 * with the URL carrying `#<anchor>` and the item scrolled into view, and a
 * change to A's item showing on B's next render.
 *
 * Own muninn on its own port, a wiki with a `trackers` block and no
 * `idLabels`. No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is
 * required — the spawn inherits `DATABASE_URL` and `e2eEnv()` blanks the
 * platform tokens and the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-cross-refs");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-cross-refs";

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1} with filler text.\n`);

const pageA = (o1Tail: string) =>
  [
    "---",
    "title: Page A",
    "type: plan",
    "---",
    "",
    "# Page A",
    "",
    '<Query id="o5" question="A lower-case query?" answer="Yes.">',
    "",
    "Body.",
    "",
    "</Query>",
    "",
    '<Query id="Q-3" question="How many cases?" answer="Twelve cases.">',
    "",
    "Body.",
    "",
    "</Query>",
    "",
    '<Query id="O2" question="A query O2?" answer="No.">',
    "",
    "Body.",
    "",
    "</Query>",
    "",
    '<CaseBoard src="a-cases.yaml" />',
    "",
    ...filler(60, "A"),
    "<DecisionLog>",
    "",
    `- **O1** — Should we ship the widget?${o1Tail}`,
    "- **O2** — Twice defined.",
    "- **O5** — The upper-case item.",
    "- **D1** — We ship it.",
    "- **D2** — Ship on Friday.",
    "",
    "</DecisionLog>",
    "",
    ...filler(40, "Tail"),
  ].join("\n");

const PAGE_B = [
  "---",
  "title: Page B",
  "type: plan",
  "---",
  "",
  "# Page B",
  "",
  "One: O1 i [[plans/a]].",
  "",
  "Run: D1, O1 i [[plans/a]].",
  "",
  "Mixed: D2 og Q-3 på [[plans/a]].",
  "",
  "Case: C7 in [[plans/a]].",
  "",
  "Bold: **D1** i [[plans/a]].",
  "",
  "Miss: X9 i [[plans/a]], and D7 i [[plans/a]].",
  "",
  "Key: MELOSYS-8308 på [[plans/a]].",
  "",
  "Word: omtalt i [[plans/a]].",
  "",
  "Suffix: O5 on [[plans/a]].",
  "",
  "Two kinds: O2 i [[plans/a]].",
  "",
  "Prose: Q-1 i prod.",
  "",
  "Bare: O1 and D7.",
  "",
  "<DecisionLog>",
  "",
  "- **O1** — B's own question.",
  "- **D7** — B's own decision.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

const PAGE_C = ["---", "title: Page C", "type: plan", "---", "", "# Page C", "", "Only omtalt i [[plans/a]] and MELOSYS-8308 på [[plans/a]].", ""].join("\n");

let server: ChildProcess | undefined;
let base = "";
let root = "";

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-xrefs-"));
  root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/a.md"), pageA(""), "utf8");
  await writeFile(path.join(root, "plans/a-cases.yaml"), "- id: C7\n  status: hold\n  owner: Fag\n  note: Held out for now\n", "utf8");
  await writeFile(path.join(root, "plans/b.md"), PAGE_B, "utf8");
  await writeFile(path.join(root, "plans/c.md"), PAGE_C, "utf8");
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ trackers: [{ id: "jira", projects: ["MELOSYS"], hosts: ["jira.example.invalid"] }] }),
    "utf8",
  );

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
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
  if (base) await rm(base, { recursive: true, force: true });
});

/** Open a page and record every `/api/wiki/ref` call it makes. */
async function open(page: Page, rel: string): Promise<string[]> {
  const calls: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.pathname === "/api/wiki/ref") calls.push(`${u.searchParams.get("relPath")}:${u.searchParams.get("ids")}`);
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return calls;
}

const xrefs = (page: Page) =>
  page.locator(".wiki-article a.wiki-xref").evaluateAll((as) => as.map((a) => `${a.textContent}→${a.getAttribute("data-relpath")}#${a.getAttribute("data-anchor")}`));

async function hoverText(page: Page, link: ReturnType<Page["locator"]>): Promise<string> {
  await page.mouse.move(0, 0);
  await link.hover();
  const card = page.locator("#wiki-xref-peek");
  await expect(card).toBeVisible();
  // The card for THIS link: the previous one stays until the next shows.
  await expect(card.locator(".wiki-ref-peek-label")).toHaveText((await link.textContent()) ?? "");
  return (await card.textContent()) ?? "";
}

test.describe("Wiki reader: cross-page ids", () => {
  test("each id A defines links to A's item; the rest stays plain; one call for the page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const calls = await open(page, "plans/b.md");
    await expect(page.locator(".wiki-article a.wiki-xref")).toHaveCount(8);
    expect(await xrefs(page)).toEqual([
      "O1→plans/a.md#o1",
      "D1→plans/a.md#d1",
      "O1→plans/a.md#o1",
      "D2→plans/a.md#d2",
      "Q-3→plans/a.md#q-3",
      "C7→plans/a.md#case-c7",
      "D1→plans/a.md#d1",
      // The Query card holds `o5`, so A's item has the allocator's `o5-2`.
      "O5→plans/a.md#o5-2",
    ]);
    // `**D1** i [[…]]`: the link sits inside the bold.
    await expect(page.locator(".wiki-article strong > a.wiki-xref")).toHaveText("D1");
    // Every wrapper is gone once the answer is in.
    await expect(page.locator(".wiki-article .wiki-xref-run")).toHaveCount(0);
    // No link of either kind on an id A does not define (X9), one A defines
    // twice (O2), B's own D7 in a reference, the tracker key, or `Q-1 i prod`.
    const linkTexts = await page.locator(".wiki-article p a, .wiki-article strong a").allTextContents();
    for (const t of ["X9", "O2", "MELOSYS-8308", "Q-1"]) expect(linkTexts, t).not.toContain(t);
    // In-page links: only the bare O1 and D7, to B's own items.
    const inPage = await page
      .locator(".wiki-article a.wiki-ref")
      .evaluateAll((as) => as.map((a) => `${a.textContent}→${(a as HTMLElement).dataset.ref}`));
    expect(inPage).toEqual(["O1→o1", "D7→d7"]);
    // One call, for the one linked page, naming no word and no tracker key.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.startsWith("plans/a.md:")).toBe(true);
    expect(calls[0]).not.toMatch(/omtalt|MELOSYS/);
    expect(errors).toEqual([]);
  });

  test("«omtalt i [[A]]» and a key before a wikilink: no wrapper and no call", async ({ page }) => {
    const calls = await open(page, "plans/c.md");
    await expect(page.locator(".wiki-article a.wiki-link")).toHaveCount(2);
    await page.waitForTimeout(500);
    expect(calls).toEqual([]);
    await expect(page.locator(".wiki-article .wiki-xref-run, .wiki-article a.wiki-xref")).toHaveCount(0);
  });

  test("the hover shows A's first sentence and state, a query its answer, a case its row", async ({ page }) => {
    await open(page, "plans/b.md");
    const link = page.locator(".wiki-article a.wiki-xref").first();
    await expect(link).toBeAttached();
    const o1 = await hoverText(page, link);
    expect(o1).toContain("Page A");
    expect(o1).toContain("Should we ship the widget?");
    expect(o1).toContain("Open");
    const q3 = await hoverText(page, page.locator(".wiki-article a.wiki-xref", { hasText: "Q-3" }));
    expect(q3).toContain("How many cases?");
    expect(q3).toContain("Twelve cases.");
    const c7 = await hoverText(page, page.locator(".wiki-article a.wiki-xref", { hasText: "C7" }));
    expect(c7).toContain("Fag");
    expect(c7).toContain("Held out for now");
  });

  test("a click opens A with #<anchor> in the URL and the item scrolled into view", async ({ page }) => {
    await open(page, "plans/b.md");
    await page.locator(".wiki-article a.wiki-xref").first().click();
    await expect(page).toHaveURL(/relPath=plans%2Fa\.md.*#o1$/);
    await expect(page.locator(".wiki-breadcrumb, #wikiBreadcrumb")).toContainText("Page A");
    const item = page.locator(".wiki-article li.dl-item#o1");
    await expect(item).toBeInViewport();
    expect(await page.locator("#articleWrap").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // A suffixed anchor lands too.
    await page.goBack();
    await expect(page.locator(".wiki-article a.wiki-xref", { hasText: "O5" })).toBeAttached();
    await page.locator(".wiki-article a.wiki-xref", { hasText: "O5" }).click();
    await expect(page).toHaveURL(/#o5-2$/);
    await expect(page.locator(".wiki-article li.dl-item#o5-2")).toBeInViewport();
  });

  test("after A's item closes, B's references show Closed → D2", async ({ page }) => {
    await writeFile(path.join(root, "plans/a.md"), pageA(" Closed 2026-11-01 (D2)."), "utf8");
    try {
      await open(page, "plans/b.md");
      const link = page.locator(".wiki-article a.wiki-xref").first();
      await expect(link).toBeAttached();
      const text = await hoverText(page, link);
      expect(text).toContain("Closed → D2");
      expect(text).toContain("2026-11-01");
      // B's own O1 is still not the target.
      expect(await link.getAttribute("data-relpath")).toBe("plans/a.md");
    } finally {
      await writeFile(path.join(root, "plans/a.md"), pageA(""), "utf8");
    }
  });
});
