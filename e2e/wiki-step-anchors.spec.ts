/**
 * Anchors on a `<RunChecklist>` step (`**R11 …**` → `#alpha-r11`) and on a
 * `<Fold id>`, in the /wiki reader over a temp wiki of two pages. Proves what a
 * unit test cannot: that each way of reaching a step inside a CLOSED fold opens
 * the fold, scrolls to the step and flashes it in the real bundle — a fresh
 * load on the hash, an in-page `](#alpha-r11)` link (twice: a second click on
 * the same hash fires no `hashchange`), and a `[[page#anchor|…]]` link from
 * another page, which used to render as a missing-page span.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the
 * spawn inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and
 * the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-step-anchors");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-step-anchors";
const STEPS_REL = "plans/steps.mdx";
const OTHER_REL = "plans/other.mdx";

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} avsnitt ${i + 1} med fylltekst.\n`);

const STEPS = [
  "---",
  "title: Steps page",
  "type: plan",
  "---",
  "",
  "# Steps page",
  "",
  "Neste: [R11 i alpha](#alpha-r11). Hele repoet: [service-a](#alpha).",
  "",
  ...filler(60, "Første"),
  '<Fold id="alpha" title="service-a" summary="gjenstår R11">',
  "",
  ...filler(30, "Fold"),
  '<RunChecklist id="alpha">',
  "",
  "- [x] **R1 Vindu.** Teamet er varslet.",
  "- [ ] **R11 Release.** Tag the release.",
  "",
  "</RunChecklist>",
  "",
  "</Fold>",
  "",
  ...filler(60, "Andre"),
].join("\n");

const OTHER = ["---", "title: Other page", "type: plan", "---", "", "# Other page", "", "Se [[plans/steps#alpha-r11|R11 i alpha]].", ""].join(
  "\n",
);

let server: ChildProcess | undefined;
let base = "";

function watch(page: Page): { failed: string[]; errors: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    const similarDegrade = u.pathname === "/api/wiki/similar" && res.status() === 404;
    if (u.origin === BASE && res.status() >= 400 && !similarDegrade) failed.push(`${res.status()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors };
}

const open = async (page: Page, relPath: string, hash = "") => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(relPath)}${hash}`);
  // Top-level prose renders as bare text, not `<p>`: wait for a link each page has.
  await expect(page.locator(".wiki-article a").first()).toBeAttached();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

const fold = (page: Page) => page.locator("details.fold#alpha");
const step = (page: Page) => page.locator(".run-checklist li#alpha-r11");

async function expectRevealed(page: Page): Promise<void> {
  await expect(fold(page)).toHaveAttribute("open", "");
  await expect(step(page)).toBeInViewport();
  await expect(step(page)).toHaveClass(/wiki-hash-flash/);
}

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-step-anchors-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, STEPS_REL), STEPS, "utf8");
  await writeFile(path.join(root, OTHER_REL), OTHER, "utf8");

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

test.describe("Wiki reader: RunChecklist step and Fold anchors", () => {
  test("a fresh load on a step's hash opens its fold and flashes the step", async ({ page }) => {
    const seen = await open(page, STEPS_REL, "#alpha-r11");
    await expectRevealed(page);
    expectClean(seen);
  });

  test("an in-page link to a step opens its closed fold, on every click", async ({ page }) => {
    const seen = await open(page, STEPS_REL);
    await expect(fold(page)).not.toHaveAttribute("open", "");
    const link = page.locator('.wiki-article a[href="#alpha-r11"]');
    await expect(link).toHaveClass(/wiki-ref/);
    await link.click();
    await expectRevealed(page);
    expect(new URL(page.url()).hash).toBe("#alpha-r11");

    // The reader closes the fold and goes back up: the same link opens it again.
    await fold(page).evaluate((d) => ((d as HTMLDetailsElement).open = false));
    await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
    await expect(step(page)).not.toBeInViewport();
    await link.click();
    await expectRevealed(page);

    // A link to the fold itself opens it too.
    await fold(page).evaluate((d) => ((d as HTMLDetailsElement).open = false));
    await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
    await page.locator('.wiki-article a[href="#alpha"]').click();
    await expect(fold(page)).toHaveAttribute("open", "");
    await expect(fold(page)).toBeInViewport();
    expectClean(seen);
  });

  test("a [[page#anchor]] link from another page lands on the step inside its closed fold", async ({ page }) => {
    const seen = await open(page, OTHER_REL);
    const link = page.locator(".wiki-article a.wiki-link", { hasText: "R11 i alpha" });
    await expect(link).toHaveAttribute("data-anchor", "alpha-r11");
    await expect(link).toHaveAttribute("href", `/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(STEPS_REL)}#alpha-r11`);
    await expect(page.locator(".wiki-article .wiki-link-missing")).toHaveCount(0);
    await link.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("relPath")).toBe(STEPS_REL);
    expect(new URL(page.url()).hash).toBe("#alpha-r11");
    await expectRevealed(page);
    expectClean(seen);
  });
});
