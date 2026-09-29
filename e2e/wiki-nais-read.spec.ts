/**
 * The wiki READ slice as a team member sees it on the nais pod:
 * `MUNINN_PROFILE=nais`, `MUNINN_AUTH=local` at role `user`, and one wiki
 * registered read-only (`WIKI_EXTRA` + `WIKI_READONLY_ROOTS`), the shape of the
 * bucket mirror.
 *
 * What a unit test cannot see and this spec asserts: the page renders a
 * Norwegian `.mdx` — a `<Callout>` and a client-rendered mermaid SVG — in both
 * colour schemes, the browser makes NO request that answers 4xx/5xx (a control
 * or panel reaching a dropped route would, as Hono's 404 or the zone's 403),
 * logs no console error, and shows none of the controls the profile dropped.
 *
 * The browser drives 127.0.0.1, which takes the loopback bypass: the pinned
 * identity at role `user` with no credential — exactly the role under test.
 * No model calls and nothing written. The mermaid bundle loads from the
 * CDN, as it does for every reader.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { WIKI_READ_SLICE_HIDDEN_SELECTOR } from "../src/dashboard/views/components/wiki-read-slice.ts";

const PORT = e2ePort("wiki-nais-read");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "melosys-felles";
const PAGE_REL = "plans/testside.mdx";

const PAGE = [
  "---",
  "title: Testside for felles wiki",
  "tags: [test, melosys]",
  "---",
  "",
  "# Testside for felles wiki",
  "",
  "Særnorske bokstaver: æ, ø og å. Blåbærsyltetøy på brødskiva.",
  "",
  '<Callout tone="info" title="Merk">',
  "Denne siden er speilet fra en bøtte og kan bare leses.",
  "</Callout>",
  "",
  "## Flyt",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Søknad mottatt] --> B{Gyldig?}",
  "  B -->|Ja| C[Vedtak fattet]",
  "  B -->|Nei| D[Avvist]",
  "```",
  "",
  "Se også [[annen-side]].",
  "",
].join("\n");
const OTHER = ["---", "title: Annen side", "---", "", "# Annen side", "", "Lenker tilbake til [[testside]].", ""].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async ({}, info) => {
  info.setTimeout(60_000);
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-nais-read-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, "annen-side.md"), OTHER, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_PROFILE: "nais",
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: "e2e-wiki-nais-read-secret-not-real",
      MUNINN_LOCAL_USER: "e2e-nais-reader",
      MUNINN_LOCAL_ROLE: "user",
      MUNINN_ADMIN_IDENTS: "A123456",
      MUNINN_ALLOWED_ORIGINS: BASE,
      WIKI_EXTRA: `${WIKI}=${root}`,
      WIKI_READONLY_ROOTS: root,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("nais muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

/** Record every same-origin response that failed, and every console error. */
function watch(page: Page): { failed: string[]; errors: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.origin === BASE && res.status() >= 400) failed.push(`${res.status()} ${res.request().method()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors };
}

/** How many controls from the dropped surface are on screen. */
async function visibleDroppedControls(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
      .map((el) => el.id || el.className || el.tagName);
  }, WIKI_READ_SLICE_HIDDEN_SELECTOR);
}

for (const scheme of ["light", "dark"] as const) {
  test(`a role-user renders the page in ${scheme} — Callout, mermaid, no dead controls`, async ({ browser }, info) => {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    const seen = watch(page);

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
    await expect(page.locator(".callout-info .callout-title")).toHaveText("Merk");
    await expect(page.locator("#articleWrap")).toContainText("Blåbærsyltetøy på brødskiva");
    await expect(page.locator("#articleWrap svg").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#articleWrap svg").first()).toContainText("Søknad mottatt");
    // The rail's own read surface is there…
    await expect(page.locator(".wiki-conn-tab.active")).toHaveText("Connections");
    // …and the Ask tab, which reaches /api/wiki/ask, is not.
    await expect(page.locator('[data-conntab="ask"]')).toBeHidden();
    // Let lazy loaders (Similar, coverage footer) fire if anything would.
    await page.waitForTimeout(1_500);

    expect(await visibleDroppedControls(page)).toEqual([]);
    expect(seen.failed).toEqual([]);
    expect(seen.errors).toEqual([]);
    // The scheme actually applied: the body background follows it.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r = 0, g = 0, b = 0] = (bg.match(/\d+/g) ?? []).map(Number);
    const luminance = (r + g + b) / 3;
    expect(scheme === "dark" ? luminance < 100 : luminance > 150, `body background ${bg}`).toBe(true);

    await info.attach(`reader-${scheme}.png`, { body: await page.screenshot(), contentType: "image/png" });
    await context.close();
  });
}

test("the overview makes no request outside the read slice, and has no Atlas tab — even linked", async ({ page }) => {
  const seen = watch(page);
  const paths: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin === BASE) paths.push(u.pathname);
  });

  await page.goto(`${BASE}/wiki?wiki=${WIKI}&view=atlas`);
  await expect(page.locator(".wiki-tab.active")).toHaveText("Hubs");
  await expect(page.locator('.wiki-tab[data-tab="atlas"]')).toHaveCount(0);
  await page.waitForTimeout(1_500);

  expect(paths.filter((p) => p.startsWith("/api/wiki/") && p !== "/api/wiki/pages")).toEqual([]);
  expect(await visibleDroppedControls(page)).toEqual([]);
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
});
