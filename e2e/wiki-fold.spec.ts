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
