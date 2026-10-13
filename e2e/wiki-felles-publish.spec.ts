/**
 * ⇪ Felles in the /wiki reader's breadcrumb: the dialog that runs
 * `publiser-felles-wiki.ts` on the open page, or copies its command line.
 *
 * What the unit tests cannot reach: the payload field arriving in the shell
 * (`fellesPublish` → the button), the button only on the allowlisted wiki, the
 * dialog's two runs reaching a real spawn with the checkbox's flag, the remove
 * flow's dry run and confirm reaching `--fjern`, and the
 * copied command naming the served root.
 *
 * `FELLES_WIKI_PUBLISH_BIN` is a STUB `.ts` that prints its argv and exits 0
 * (3 for `FAIL_REL`), so nothing here reaches gcloud or a bucket. For
 * `--status --json` it prints a status in which `REL` is `endret` until a real
 * `--synk` or a real publish of `REL` has run (the `synced` control file), so
 * the sync flow can be driven end to end. Without `--tillat-ident` the status
 * calls `REL` `avvist`. Files in `ctl` steer it: `status-delay` and `run-delay`
 * (ms, default 700), `status-fail` (`--status` exits 2), `synk-refuse`
 * (`--synk` exits 1, as the real script does with a refused page).
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { contrastOf } from "./contrast.ts";
import {
  FELLES_BTN_ID,
  FELLES_STALE_CLASS,
  FELLES_SYNC_BTN_ID,
} from "../src/dashboard/views/components/wiki-felles-publish.ts";

const BTN = `#${FELLES_BTN_ID}`;
/** The refused marker's class, as a literal so the spec loads against a module without it. */
const FELLES_REFUSED_CLASS = "wiki-felles-refused";
const PORT = e2ePort("wiki-felles-publish");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-felles";
const OTHER = "e2e-felles-other";
const REL = "plans/2026-09-29-vedtak.mdx";
const PAGE = ["---", "title: Vedtak", "---", "", "# Vedtak", "", "Body.", ""].join("\n");
/** The stub exits 3 for this page, so a failing run can be driven. */
const FAIL_REL = "plans/2026-09-30-feiler.mdx";
/** The stub's status calls this page `avvist`, unmasked. */
const REFUSED_REL = "plans/2026-10-01-avvist.mdx";

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";
let stub = "";
let ctl = "";

test.beforeAll(async () => {
  root = realpathSync(await mkdtemp(path.join(tmpdir(), "muninn-e2e-felles-")));
  otherRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-felles-other-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, FAIL_REL), PAGE.replace(/Vedtak/g, "Feiler"), "utf8");
  await writeFile(path.join(root, REFUSED_REL), PAGE.replace(/Vedtak/g, "Avvist"), "utf8");
  await writeFile(path.join(otherRoot, "page.md"), "# Other\n", "utf8");
  stub = path.join(root, "..", `felles-stub-${process.pid}.ts`);
  ctl = await mkdtemp(path.join(tmpdir(), "muninn-e2e-felles-ctl-"));
  const page = (relPath: string, tilstand: string, extra: Record<string, unknown> = {}) => ({
    relPath,
    tilstand,
    endredeFiler: [],
    avslag: [],
    advarsler: [],
    ...extra,
  });
  const statusFor = (synced: boolean, ident: boolean) => ({
    "bøtte": "e2e-bucket",
    sider: [
      !ident
        ? page(REL, "avvist", { avslag: ["NAVident"] })
        : page(REL, synced ? "uendret" : "endret", synced ? {} : { endredeFiler: [REL, "plans/2026-09-29-vedtak.data.json"] }),
      page(FAIL_REL, "uendret"),
      page(REFUSED_REL, "avvist", { avslag: ["e-post"] }),
      page("[skjult sti: 1 funn]", "avvist", { avslag: ["fødselsnummer"] }),
    ],
    "foreldreløse": ["plans/gammel.data.json"],
    "muligensForeldreløse": ["plans/kanskje.csv"],
  });
  const statuses: Record<string, unknown> = {};
  for (const synced of [false, true]) for (const ident of [false, true]) statuses[`${synced}/${ident}`] = statusFor(synced, ident);
  await writeFile(
    stub,
    `const ctl = ${JSON.stringify(ctl)};\n` +
      "const has = (n) => Bun.file(ctl + '/' + n).exists();\n" +
      "const num = async (n, d) => ((await has(n)) ? Number(await Bun.file(ctl + '/' + n).text()) : d);\n" +
      "const argv = process.argv.slice(2);\n" +
      "if (argv.includes('--status')) {\n" +
      // The bucket is read when the status starts, as the real listing is, and
      // answered after the delay.
      "  const fail = await has('status-fail');\n" +
      `  const statuses = ${JSON.stringify(statuses)};\n` +
      "  const out = JSON.stringify(statuses[`${await has('synced')}/${argv.includes('--tillat-ident')}`]);\n" +
      "  await Bun.sleep(await num('status-delay', 700));\n" +
      "  if (fail) { console.error('Feil: gcloud mangler'); process.exit(2); }\n" +
      "  console.log(out);\n" +
      "  process.exit(0);\n" +
      "}\n" +
      // Slow enough that the in-flight case can press Escape mid-run.
      "await Bun.sleep(await num('run-delay', 700));\n" +
      "const real = !argv.includes('--dry-run');\n" +
      `if (real && (argv.includes('--synk') || argv.includes(${JSON.stringify("./" + REL)}))) await Bun.write(ctl + '/synced', '1');\n` +
      'console.log("ARGS " + JSON.stringify(argv));\n' +
      'console.log("  https://example.test/wiki?wiki=melosys-felles&relPath=x");\n' +
      "if (argv.includes('--synk') && (await has('synk-refuse'))) process.exit(1);\n" +
      `if (argv.includes(${JSON.stringify(FAIL_REL)}) || argv.includes(${JSON.stringify("./" + FAIL_REL)})) process.exit(3);\n`,
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
  if (ctl) await rm(ctl, { recursive: true, force: true });
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

  test("remove dry-runs first, and only Confirm remove reaches --fjern for real", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    const out = dialog.locator(".wiki-felles-out");
    const confirm = dialog.locator(".wiki-felles-confirm");
    await expect(confirm).toBeHidden();

    await dialog.getByRole("button", { name: "Remove…" }).click();
    await expect(out).toContainText(`ARGS ${JSON.stringify(["--fjern", "--dry-run", "--ja", "--", REL])}`);
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Dry run: this is the object a remove deletes/);
    await expect(confirm).toBeVisible();

    // Cancel withdraws the offer without a run.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();

    await dialog.getByRole("button", { name: "Remove…" }).click();
    await confirm.getByRole("button", { name: "Confirm remove" }).click();
    await expect(out).toContainText(`ARGS ${JSON.stringify(["--fjern", "--ja", "--", REL])}`);
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Removed/);
    await expect(confirm).toBeHidden();
  });

  test("a remove dry run that fails offers no confirm, and any other run withdraws one", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FAIL_REL)}`);
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Delete failed/);
    await expect(dialog.locator(".wiki-felles-confirm")).toBeHidden();
    await page.keyboard.press("Escape");

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await page.locator(BTN).click();
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await expect(dialog.locator(".wiki-felles-confirm")).toBeVisible();
    await dialog.getByRole("button", { name: "Dry run" }).click();
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/Dry run passed/);
    await expect(dialog.locator(".wiki-felles-confirm")).toBeHidden();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the remove controls read at 4.5:1 in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
      await page.locator(BTN).click();
      const dialog = page.locator("dialog.wiki-felles");
      const remove = dialog.getByRole("button", { name: "Remove…" });
      expect(await contrastOf(remove), `${scheme} Remove…`).toBeGreaterThanOrEqual(4.5);
      await remove.click();
      const confirmBtn = dialog.getByRole("button", { name: "Confirm remove" });
      await expect(confirmBtn).toBeVisible();
      expect(await contrastOf(confirmBtn), `${scheme} Confirm remove`).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(dialog.locator(".wiki-felles-confirm span")), `${scheme} confirm text`).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("a wiki not in FELLES_WIKI_PUBLISH_WIKIS has no button", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${OTHER}&relPath=page.md`);
    await expect(page.locator("#wikiShareBtn")).toBeVisible();
    await expect(page.locator(BTN)).toHaveCount(0);
    await expect(page.locator(CHIP)).toHaveCount(0);
  });
});

const CHIP = `#${FELLES_SYNC_BTN_ID}`;

/** Clear every control file, and drop the route's 30 s status cache with a real
 *  (stubbed) run: only a run that could change the bucket drops it. */
async function resetStub(): Promise<void> {
  await rm(ctl, { recursive: true, force: true });
  await mkdir(ctl, { recursive: true });
  for (let i = 0; ; i++) {
    const res = await fetch(`${BASE}/api/wiki/felles-publish`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ wiki: WIKI, relPath: REL, action: "remove", dryRun: false }),
    });
    if (res.status === 200) break;
    // A run a previous test left in flight holds the slot.
    if (res.status !== 409 || i > 20) throw new Error(`reset run answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const control = (name: string, value = "1") => writeFile(path.join(ctl, name), value, "utf8");

test.describe("Wiki reader: Felles sync status", () => {
  test("the chip counts changed pages, and the dialog lists them", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    // The article renders while the status (a 700 ms stub) is still loading.
    await expect(page.locator("#articleWrap h1").first()).toHaveText("Vedtak");
    await expect(page.locator(CHIP)).toHaveText(/^Felles: (checking…|1 changed)$/);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    await expect(dialog).toBeVisible();
    const changed = dialog.locator(".wiki-felles-section.changed");
    await expect(changed.getByRole("link", { name: REL })).toBeVisible();
    await expect(changed).toContainText("plans/2026-09-29-vedtak.data.json");
    // A masked path is text, never a link; refusals and orphans are listed.
    const refused = dialog.locator(".wiki-felles-section.refused");
    await expect(refused).toContainText("[skjult sti: 1 funn]");
    await expect(refused).toContainText("fødselsnummer");
    await expect(refused.getByRole("link")).toHaveText([REFUSED_REL]);
    await expect(dialog.locator(".wiki-felles-section.orphans")).toContainText("plans/gammel.data.json");
    const maybe = dialog.locator(".wiki-felles-section.maybe-orphans");
    await expect(maybe).toContainText("plans/kanskje.csv");
    await expect(maybe).toContainText("may still name them");
    await expect(maybe).not.toContainText("--fjern");
    // A page's own path is not repeated among its files.
    await expect(changed.locator(".wiki-felles-files li")).toHaveText(["page changed", "plans/2026-09-29-vedtak.data.json"]);
    await expect(dialog.getByRole("button", { name: "Publish changed (1)" })).toBeEnabled();
  });

  test("⇪ Felles is marked stale on a changed page only, and navigation repaints it without a refetch", async ({ page }) => {
    await resetStub();
    let statusRequests = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/felles-status")) statusRequests++;
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await expect(page.locator(BTN)).toHaveClass(new RegExp(FELLES_STALE_CLASS));
    await expect(page.locator(BTN)).toHaveAttribute("title", /Published copy is out of date/);

    await page.locator(`.wiki-list-item[data-relpath="${FAIL_REL}"]`).first().click();
    await expect(page.locator(BTN)).toHaveAttribute("data-felles-relpath", FAIL_REL);
    await expect(page.locator(BTN)).not.toHaveClass(new RegExp(FELLES_STALE_CLASS));

    await page.locator(`.wiki-list-item[data-relpath="${REL}"]`).first().click();
    await expect(page.locator(BTN)).toHaveAttribute("data-felles-relpath", REL);
    await expect(page.locator(BTN)).toHaveClass(new RegExp(FELLES_STALE_CLASS));
    expect(statusRequests).toBe(1);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the chip and the dialog's links read at 4.5:1 in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
      await expect(page.locator(CHIP)).toHaveText(/changed$/);
      expect(await contrastOf(page.locator(CHIP)), `${scheme} chip`).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(page.locator(BTN)), `${scheme} stale ⇪ Felles`).toBeGreaterThanOrEqual(4.5);
      await page.locator(CHIP).click();
      const link = page.locator("dialog.wiki-felles-sync-dialog .wiki-felles-section a").first();
      await expect(link).toBeVisible();
      expect(await contrastOf(link), `${scheme} link`).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("Publish changed sends --synk, and the chip and the marker refresh", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    const out = dialog.locator(".wiki-felles-out");

    await dialog.getByRole("button", { name: "Dry run" }).click();
    await expect(out).toContainText(`ARGS ${JSON.stringify(["--synk", "--dry-run", "--tillat-ident", root])}`);
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Dry run passed/);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");

    await dialog.getByRole("button", { name: "Publish changed (1)" }).click();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
    await expect(out).toContainText(`ARGS ${JSON.stringify(["--synk", "--tillat-ident", root])}`);
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Published the changed pages/);
    await expect(page.locator(CHIP)).toHaveText("Felles: 0 changed");
    await expect(dialog.getByRole("button", { name: "Publish changed (0)" })).toBeDisabled();
    await expect(dialog.locator(".wiki-felles-section.changed")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(BTN)).not.toHaveClass(new RegExp(FELLES_STALE_CLASS));
  });

  test("unchecking --tillat-ident reloads the dialog's status with the flag off", async ({ page }) => {
    await resetStub();
    const flags: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/felles-status")) flags.push(new URL(r.url()).searchParams.get("allowIdent") ?? "");
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    await expect(dialog.getByRole("button", { name: "Publish changed (1)" })).toBeEnabled();
    await dialog.getByRole("checkbox").uncheck();
    // Without the flag the page is refused, so nothing is left to publish.
    await expect(dialog.getByRole("button", { name: "Publish changed (0)" })).toBeDisabled();
    await expect(dialog.locator(".wiki-felles-section.refused")).toContainText(REL);
    expect(flags).toContain("0");
    // The chip and the marker keep the default.
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await dialog.getByRole("checkbox").check();
    await expect(dialog.getByRole("button", { name: "Publish changed (1)" })).toBeEnabled();
  });

  test("a publish while the first status is still loading refreshes the chip and clears the marker", async ({ page }) => {
    await resetStub();
    await control("status-delay", "2500");
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: checking…");
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Published/);
    await page.keyboard.press("Escape");
    // The status sent before the publish must not be the last word.
    await expect(page.locator(CHIP)).toHaveText("Felles: 0 changed", { timeout: 10_000 });
    await expect(page.locator(BTN)).not.toHaveClass(new RegExp(FELLES_STALE_CLASS));
  });

  test("a dry run in the page dialog does not refetch the status", async ({ page }) => {
    await resetStub();
    let statusRequests = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/felles-status")) statusRequests++;
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    await dialog.getByRole("button", { name: "Dry run" }).click();
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/Dry run passed/);
    await page.waitForTimeout(500);
    expect(statusRequests).toBe(1);
  });

  test("a sync whose only failure is a refused page reads as done, not as an error", async ({ page }) => {
    await resetStub();
    await control("synk-refuse");
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    const line = dialog.locator(".wiki-felles-status");

    await dialog.getByRole("button", { name: "Dry run" }).click();
    await expect(line).toHaveText(
      "Dry run: all changed pages would be published. 2 refused page(s) would not — see Refused. Nothing was uploaded.",
    );
    await expect(line).toHaveClass(/\bok\b/);

    await dialog.getByRole("button", { name: "Publish changed (1)" }).click();
    await expect(line).toHaveText("All changed pages were published. 2 refused page(s) were not — see Refused.");
    await expect(line).toHaveClass(/\bok\b/);
    await expect(page.locator(CHIP)).toHaveText("Felles: 0 changed");
  });

  test("Publish changed stays disabled until a fresh status arrives", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    const syncBtn = dialog.locator('[data-felles="sync"]');
    await syncBtn.click();
    await expect(dialog.locator(".wiki-felles-out")).toContainText("--synk");
    // The run is back, the status behind its count is not (the stub takes 700 ms).
    expect(await syncBtn.isDisabled()).toBe(true);
    await expect(syncBtn).toHaveText("Publish changed (0)");
    await expect(syncBtn).toBeDisabled();
  });

  test("a status that fails after a run keeps Publish changed disabled and says why", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    await control("status-fail");
    await dialog.getByRole("button", { name: "Publish changed (1)" }).click();
    await expect(dialog.locator(".wiki-felles-out")).toContainText("--synk");
    await expect(page.locator(CHIP)).toHaveText("Felles: status failed");
    await expect(dialog.locator('[data-felles="sync"]')).toBeDisabled();
    await expect(dialog.locator(".wiki-felles-refresh")).toContainText("gcloud mangler");
  });

  test("a failed status keeps the last good markers", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await expect(page.locator(BTN)).toHaveClass(new RegExp(FELLES_STALE_CLASS));
    await control("status-fail");
    await page.locator(`.wiki-list-item[data-relpath="${FAIL_REL}"]`).first().click();
    await expect(page.locator(BTN)).toHaveAttribute("data-felles-relpath", FAIL_REL);
    await page.locator(BTN).click();
    const dialog = page.locator("dialog.wiki-felles");
    // A real run that exits 3: it could have changed the bucket, so the status reloads.
    await dialog.getByRole("button", { name: "Publish" }).click();
    await expect(dialog.locator(".wiki-felles-status")).toHaveText(/^Upload failed/);
    await page.keyboard.press("Escape");
    await expect(page.locator(CHIP)).toHaveText("Felles: status failed");
    await page.locator(`.wiki-list-item[data-relpath="${REL}"]`).first().click();
    await expect(page.locator(BTN)).toHaveAttribute("data-felles-relpath", REL);
    await expect(page.locator(BTN)).toHaveClass(new RegExp(FELLES_STALE_CLASS));
  });

  test("a keyboard retry keeps focus on the chip, and the slot is a polite live region", async ({ page }) => {
    await resetStub();
    await control("status-fail");
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: status failed");
    await page.locator(CHIP).focus();
    await rm(path.join(ctl, "status-fail"), { force: true });
    await page.keyboard.press("Enter");
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(FELLES_SYNC_BTN_ID);
    await expect(page.locator("#wikiFellesSync")).toHaveAttribute("aria-live", "polite");
  });

  test("a refused page gets its own marker", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REFUSED_REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await expect(page.locator(BTN)).toHaveClass(new RegExp(FELLES_REFUSED_CLASS));
    await expect(page.locator(BTN)).not.toHaveClass(new RegExp(FELLES_STALE_CLASS));
    await expect(page.locator(BTN)).toHaveAttribute("title", "Local copy is refused by the scanner — the published copy is older");
    expect(await contrastOf(page.locator(BTN)), "refused ⇪ Felles").toBeGreaterThanOrEqual(4.5);
  });

  test("the dialog's links do nothing while a sync runs", async ({ page }) => {
    await resetStub();
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FAIL_REL)}`);
    await expect(page.locator(CHIP)).toHaveText("Felles: 1 changed");
    await page.locator(CHIP).click();
    const dialog = page.locator("dialog.wiki-felles-sync-dialog");
    const link = dialog.locator(".wiki-felles-section.changed").getByRole("link", { name: REL });
    const box = await link.boundingBox();
    if (!box) throw new Error("no link box");
    await control("run-delay", "2500");
    await dialog.getByRole("button", { name: "Publish changed (1)" }).click();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    await expect(page.locator(BTN)).toHaveAttribute("data-felles-relpath", FAIL_REL);
    expect(page.url()).toContain(encodeURIComponent(FAIL_REL));
  });
});
