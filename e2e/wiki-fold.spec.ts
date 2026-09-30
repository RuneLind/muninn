/**
 * `<Fold>` in the /wiki reader — the surface the plan-page convention is for.
 *
 * Three things only a real page can answer:
 *
 *  1. **The CSS ships and the states are real.** `details`/`summary` render
 *     natively, so a unit test on the HTML says nothing about whether the fold's
 *     body is on screen or whether the duplicate heading is hidden.
 *  2. **A `.md` page folds too.** The renderer never reads the extension, and
 *     half of mimir's plans are `.md`; a spec with only an `.mdx` page could not
 *     tell the two apart.
 *  3. **A `[[wikilink]]` inside a fold body is still a link.** `renderWikiHtml`
 *     restores wikilinks over the RENDERED html, so a new container is exactly
 *     the kind of thing that can silently swallow one.
 *  4. **Nested lists nest in the DOM**, inside a fold, with no `- ` text left
 *     over and the child visibly indented under its parent.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the spawn
 * inherits `DATABASE_URL` (CI passes it inline) and `e2eEnv()` blanks the platform
 * tokens and the host's instance-profile flags, which is what keeps this muninn off
 * Telegram/Slack and off a `MUNINN_WIKI_READONLY=1` host.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-fold");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-fold";

const TARGET_REL = "plans/target-page.md";
const TARGET = ["---", "title: Target page", "---", "", "# Target page", "", "The page a fold body links to.", ""].join("\n");

const MDX_REL = "plans/folded.mdx";
const MDX = [
  "---",
  "title: Folded plan",
  "---",
  "",
  "# Folded plan",
  "",
  "The brief stays open.",
  "",
  '<Fold title="What was measured">',
  "",
  "## What was measured",
  "",
  "The probe returned 149 lines, and see [[target-page]] for the rest.",
  "",
  "</Fold>",
  "",
  '<Fold title="Current state" open="true">',
  "",
  "## A heading that differs",
  "",
  "Nothing built yet.",
  "",
  "</Fold>",
  "",
].join("\n");

const MD_REL = "plans/folded-md.md";
const MD = [
  "---",
  "title: Folded md plan",
  "---",
  "",
  "# Folded md plan",
  "",
  '<Fold title="What was measured">',
  "",
  "## What was measured",
  "",
  "A `.md` page folds exactly like an `.mdx` one.",
  "",
  "</Fold>",
  "",
].join("\n");

// Nested lists inside a fold: ul in ul, ul in ol (at the ordered content column,
// the gate page's "   - **Blokker**" shape), a wikilink in a nested item, and a
// Checklist with a nested task.
const NESTED_REL = "plans/nested-lists.mdx";
const NESTED = [
  "---",
  "title: Nested lists",
  "---",
  "",
  "# Nested lists",
  "",
  '<Fold title="Rules" open="true">',
  "",
  "- top one",
  "  - child a",
  "  - child b links [[target-page]]",
  "- top two",
  "",
  "1. **Published wins.**",
  "2. **Wait.**",
  "   - **Block (rule 2b).** No gate run counts.",
  "3. **Otherwise** the last green run counts.",
  "",
  "<Checklist>",
  "- [x] parent task",
  "  - [ ] child task",
  "</Checklist>",
  "",
  "<Checklist>",
  "- [ ] open parent",
  "  - [x] done child",
  "  - plain child",
  "</Checklist>",
  "",
  "</Fold>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

const open_ = (page: import("@playwright/test").Page, rel: string) =>
  page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-fold-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, TARGET_REL), TARGET, "utf8");
  await writeFile(path.join(root, MDX_REL), MDX, "utf8");
  await writeFile(path.join(root, MD_REL), MD, "utf8");
  await writeFile(path.join(root, NESTED_REL), NESTED, "utf8");

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
  if (root) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki reader: <Fold>", () => {
  test("closed by default, open on open=\"true\", and the body follows the state", async ({ page }) => {
    await open_(page, MDX_REL);
    const folds = page.locator(".wiki-article details.fold");
    await expect(folds).toHaveCount(2);

    const closed = folds.nth(0);
    await expect(closed.locator("summary")).toHaveText("What was measured");
    expect(await closed.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    // Not merely "the attribute is absent": the body must actually be off screen.
    await expect(closed.locator(".fold-body")).toBeHidden();

    const opened = folds.nth(1);
    await expect(opened.locator("summary")).toHaveText("Current state");
    expect(await opened.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(opened.locator(".fold-body")).toBeVisible();
    await expect(opened.locator(".fold-body")).toContainText("Nothing built yet.");

    // Opening the closed one reveals its prose — the whole point of the fold.
    await closed.locator("summary").click();
    await expect(closed.locator(".fold-body")).toContainText("The probe returned 149 lines");
  });

  test("a first heading equal to the title is hidden; a differing one is shown", async ({ page }) => {
    await open_(page, MDX_REL);
    const folds = page.locator(".wiki-article details.fold");
    await folds.nth(0).locator("summary").click();

    const dup = folds.nth(0).locator("h3.fold-heading-dup");
    await expect(dup).toHaveCount(1);
    // Hidden, but still IN the DOM — Explain's `nearestHeading` walks previous
    // siblings for a heading tag, so removing it would move the section.
    await expect(dup).toBeHidden();
    await expect(dup).toHaveText("What was measured");

    const differing = folds.nth(1).locator("h3");
    await expect(differing).toHaveText("A heading that differs");
    await expect(differing).toBeVisible();
  });

  test("a wikilink inside a fold body is still a link", async ({ page }) => {
    await open_(page, MDX_REL);
    const folds = page.locator(".wiki-article details.fold");
    await folds.nth(0).locator("summary").click();
    const link = folds.nth(0).locator(".fold-body a");
    await expect(link).toHaveCount(1);
    expect(await link.evaluate((el) => el.tagName)).toBe("A");
    await link.click();
    await expect(page.locator(".wiki-article")).toContainText("The page a fold body links to.");
  });

  test("a .md page folds exactly like an .mdx one", async ({ page }) => {
    await open_(page, MD_REL);
    const fold = page.locator(".wiki-article details.fold");
    await expect(fold).toHaveCount(1);
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await fold.locator("summary").click();
    await expect(fold.locator(".fold-body")).toContainText("page folds exactly like");
    // `toBeHidden()` passes on ZERO elements, so the count comes first — exactly
    // as in the `.mdx` case above. Without it a fold that never emitted the class
    // (or emitted a different one) satisfied this assertion.
    const dup = fold.locator("h3.fold-heading-dup");
    await expect(dup).toHaveCount(1);
    await expect(dup).toBeHidden();
  });
});

test.describe("Wiki reader: nested lists", () => {
  test("indented items render as child lists inside their parent item", async ({ page }) => {
    await open_(page, NESTED_REL);
    const body = page.locator(".wiki-article details.fold .fold-body");
    await expect(body).toBeVisible();

    // One top-level <ul> holding both top items, the children inside the first.
    const topUl = body.locator(":scope > ul:not(.checklist)");
    await expect(topUl).toHaveCount(1);
    await expect(topUl.locator(":scope > li")).toHaveCount(2);
    const childItems = topUl.locator(":scope > li > ul > li");
    await expect(childItems).toHaveCount(2);
    await expect(childItems.nth(0)).toHaveText("child a");

    // The gate-page shape: a bullet under an ordered item, and the ordered list
    // stays ONE list (3 items), not split around the bullet.
    const ol = body.locator(":scope > ol");
    await expect(ol).toHaveCount(1);
    await expect(ol.locator(":scope > li")).toHaveCount(3);
    await expect(ol.locator(":scope > li").nth(1).locator(":scope > ul > li")).toContainText("Block (rule 2b).");

    // A nested checklist row sits inside its parent row.
    await expect(body.locator("ul.checklist > li.check-parent > ul.checklist > li.check-todo")).toContainText(
      "child task",
    );

    // No literal list markers leak as text.
    const text = await body.innerText();
    expect(text).not.toMatch(/^\s*[-*] /m);
    expect(text).not.toMatch(/^\s+\d+\. /m);

    // The child is visibly indented under its parent, in both lists.
    const left = (l: import("@playwright/test").Locator) => l.evaluate((el) => el.getBoundingClientRect().left);
    expect(await left(childItems.nth(0))).toBeGreaterThan((await left(topUl.locator(":scope > li").nth(0))) + 8);
    const checkChild = body.locator("li.check-parent > ul.checklist > li").first();
    expect(await left(checkChild)).toBeGreaterThan((await left(body.locator("li.check-parent").first())) + 8);
  });

  test("a done row under a todo row takes its OWN colours, and an unmarked child is a plain item", async ({ page }) => {
    await open_(page, NESTED_REL);
    const parent = page.locator(".wiki-article li.check-todo.check-parent").filter({ hasText: "open parent" });
    const child = parent.locator(":scope > ul.checklist > li").filter({ hasText: "done child" });
    await expect(child).toHaveClass(/check-done/);
    // Tokens resolved on a probe in this document, so the assertion follows the
    // theme instead of pinning a literal colour.
    const token = (name: string) =>
      page.evaluate((n) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${n})`;
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, name);
    const success = await token("--status-success");
    const muted = await token("--text-muted");
    expect(success).not.toBe(muted);
    await expect(child.locator(":scope > .check-mark")).toHaveCSS("color", success);
    // The parent's todo colour stays on its own words.
    await expect(parent.locator(":scope > .check-mark")).toHaveCSS("color", muted);
    await expect(parent.locator(":scope > .check-text")).toHaveCSS("color", muted);
    await expect(child).not.toHaveCSS("color", muted);

    const plain = parent.locator(":scope > ul.checklist > li").filter({ hasText: "plain child" });
    await expect(plain).toHaveClass("check-plain");
    await expect(plain.locator(".check-mark")).toHaveCount(0);
    await expect(plain).toHaveCSS("list-style-type", "disc");
  });

  test("a wikilink inside a nested item is still a link", async ({ page }) => {
    await open_(page, NESTED_REL);
    const link = page.locator(".wiki-article li > ul > li a.wiki-link");
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(page.locator(".wiki-article")).toContainText("The page a fold body links to.");
  });
});
