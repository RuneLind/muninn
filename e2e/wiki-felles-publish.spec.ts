/**
 * ⇪ Felles in the /wiki reader's breadcrumb: the dialog that runs
 * `publiser-felles-wiki.ts` on the open page, or copies its command line.
 *
 * What the unit tests cannot reach: the payload field arriving in the shell
 * (`fellesPublish` → the button), the button only on the allowlisted wiki, the
 * dialog's two runs reaching a real spawn with the checkbox's flag, and the
 * copied command naming the served root.
 *
 * `FELLES_WIKI_PUBLISH_BIN` is a STUB `.ts` that prints its argv and exits 0, so
 * nothing here reaches gcloud or a bucket.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { FELLES_BTN_ID } from "../src/dashboard/views/components/wiki-felles-publish.ts";

const BTN = `#${FELLES_BTN_ID}`;
const PORT = e2ePort("wiki-felles-publish");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-felles";
const OTHER = "e2e-felles-other";
const REL = "plans/2026-09-29-vedtak.mdx";
const PAGE = ["---", "title: Vedtak", "---", "", "# Vedtak", "", "Body.", ""].join("\n");

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";
let stub = "";

test.beforeAll(async () => {
  root = realpathSync(await mkdtemp(path.join(tmpdir(), "muninn-e2e-felles-")));
  otherRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-felles-other-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(otherRoot, "page.md"), "# Other\n", "utf8");
  stub = path.join(root, "..", `felles-stub-${process.pid}.ts`);
  await writeFile(
    stub,
    // Slow enough that the in-flight case can press Escape mid-run.
    "await Bun.sleep(700);\n" +
    'console.log("ARGS " + JSON.stringify(process.argv.slice(2)));\n' +
      'console.log("  https://example.test/wiki?wiki=melosys-felles&relPath=x");\n',
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
      WIKI_EXTRA: `${WIKI}=${root},${OTHER}=${otherRoot}`,
      FELLES_WIKI_PUBLISH_BIN: stub,
      FELLES_WIKI_PUBLISH_WIKIS: WIKI,
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
  if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
  if (stub) await rm(stub, { force: true });
});

test.describe("Wiki reader: ⇪ Felles", () => {
  test("dry run and publish reach the script with the checkbox's flag", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Dry run" }).click();
    const out = dialog.locator(".wiki-felles-out");
    await expect(out).toContainText(`ARGS ${JSON.stringify(["--dry-run", "--tillat-ident", root, "./" + REL])}`);
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/Dry run passed/);
    await expect(out.locator("a")).toHaveAttribute("href", /^https:\/\/example\.test\//);

    await dialog.getByRole("checkbox").uncheck();
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(out).toContainText(`ARGS ${JSON.stringify([root, "./" + REL])}`);
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Published/);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the dialog cannot be closed while a run is in flight", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    await dialog.getByRole("button", { name: "Dry run" }).click();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
    // Chrome makes a REPEATED Escape non-cancelable (close-watcher anti-abuse),
    // so the third one closes the dialog whatever `cancel` does.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/Dry run passed/);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  test("copies the command line for the served root", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    await dialog.getByRole("button", { name: /Copy command/ }).click();
    await expect(dialog.getByRole("button", { name: /Copied/ })).toBeVisible();
    // `__WIKI_ROOT__` is the registered spelling, which on macOS may differ from
    // the realpath only by `/private`; compare against what the page was served.
    const servedRoot = await page.evaluate(() => (globalThis as { __WIKI_ROOT__?: string }).__WIKI_ROOT__);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `bun ${stub} --tillat-ident ${servedRoot} ${REL}`,
    );
  });

  test("a wiki not in FELLES_WIKI_PUBLISH_WIKIS has no button", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${OTHER}&relPath=page.md`);
    await expect(page.locator("#wikiShareBtn")).toBeVisible();
    await expect(page.locator(BTN)).toHaveCount(0);
  });
});
