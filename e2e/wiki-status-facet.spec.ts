/**
 * /wiki reader — the plan-status facet and the domain facet, end-to-end.
 *
 * Both are per-wiki presence gates over the same `/api/wiki/pages` payload, so they
 * share this file's multi-root recipe. The domain block is at the foot.
 *
 * The one thing no unit test can prove: the Status chip row and the ⚑ follow-ups
 * toggle appear on a wiki that USES the `plan_status` convention, filter the page
 * list when clicked, and are absent on a wiki that does not use it. The presence
 * gate is the whole point — every wiki that predates the convention (jarvis,
 * melosys-kode-wiki) and mimir mid-backfill must look exactly as it did before.
 *
 * Two constraints shape the setup:
 *   1. **Several wikis, one server.** A gate is a per-wiki decision, so proving it
 *      needs a with-status wiki AND a without-status wiki reachable from the same
 *      reader — hence temp dirs in one comma-separated `WIKI_EXTRA`.
 *   2. **No real wiki.** It CANNOT assert against mimir: no real page carries
 *      `plan_status` until the backfill lands, and this harness mounts only its own
 *      throwaway temp wikis. So it boots its OWN muninn on a dedicated port rather
 *      than riding the shared `webServer` (whose command carries no `WIKI_EXTRA`,
 *      and whose `reuseExistingServer` would hand us a dev server without it).
 *
 * No model calls anywhere — the facet is pure client-side rendering over the
 * `/api/wiki/pages` payload.
 *
 * ENV PREREQUISITE: the same one every other e2e spec has — a working `.env`
 * (`DATABASE_URL` at minimum) at the repo root, since `src/index.ts` boots the
 * full process. Bun auto-loads it in the spawned child (cwd = repo root).
 *
 * SPAWN ENV: `e2eEnv()` keeps this muninn off Telegram/Slack, and blanks the
 * instance-profile flags (`MUNINN_WIKI_READONLY`, `SYNC_REPOS`, `MUNINN_AUTH`…)
 * so a spawned server behaves the same on every host — a
 * second long-poller on a live token 409-fights the running production bot. The
 * reasoning lives in that module.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";

const PORT = e2ePort("wiki-status-facet");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_WITH = "e2e-plans";
const WIKI_WITHOUT = "e2e-plain";
/** A third root, for the domain facet's shrink case ALONE: it loses its `life/`
 *  page mid-test, which would poison the two wikis above for every other case. */
const WIKI_SHRINK = "e2e-shrink";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** A note carrying markup + a quote — it reaches the client UNESCAPED (free prose,
 *  no server validator) and lands in a `title=` attribute, so a missing `esc()`
 *  would break the attribute rather than round-trip. */
const STATUS_NOTE = 'Blocked on <b>#399</b> & "the review"';

function planPage(title: string, fields: Record<string, string>): string {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return ["---", `title: ${title}`, "type: plan", ...fm, "---", "", `# ${title}`, "", "Body.", ""].join(
    "\n",
  );
}

/**
 * shipped 2 · in-flight 1 · blocked 1 · ⚑ 2 · one page with no plan fields at all.
 *
 * `delta` deliberately sits under `life/` — the store derives `domain` from that
 * prefix, so it is the ONLY page outside the `ai` domain. That makes `blocked` a
 * status the `AI` domain chip zeroes, which is exactly the scope switch the
 * "active chip survives at count 0" case needs.
 */
const WITH_PAGES: Record<string, string> = {
  "alpha.md": planPage("Alpha", {
    plan_status: "shipped",
    status_date: "2026-07-30",
    followups: "open",
    status_note: `'${STATUS_NOTE}'`,
  }),
  "beta.md": planPage("Beta", { plan_status: "shipped", followups: "none" }),
  "gamma.md": planPage("Gamma", { plan_status: "in-flight" }),
  "life/delta.md": planPage("Delta", { plan_status: "blocked", followups: "open" }),
  "plain.md": planPage("Plain", {}),
};

/** The control wiki: same shape, zero plan fields — the facet must not appear.
 *  It is also the domain facet's one-domain side (no `life/` page). */
const WITHOUT_PAGES: Record<string, string> = {
  "one.md": planPage("One", {}),
  "two.md": planPage("Two", {}),
};

/** The shrink wiki: two domains at boot, one after the test deletes `life/`. */
const SHRINK_PAGES: Record<string, string> = {
  "one.md": planPage("One", {}),
  "two.md": planPage("Two", {}),
  "life/three.md": planPage("Three", {}),
};

let server: ChildProcess | undefined;
let rootWith = "";
let rootWithout = "";
let rootShrink = "";

test.beforeAll(async () => {
  rootWith = await mkdtemp(path.join(tmpdir(), "muninn-e2e-plans-"));
  rootWithout = await mkdtemp(path.join(tmpdir(), "muninn-e2e-plain-"));
  rootShrink = await mkdtemp(path.join(tmpdir(), "muninn-e2e-shrink-"));
  for (const [root, pages] of [
    [rootWith, WITH_PAGES],
    [rootWithout, WITHOUT_PAGES],
    [rootShrink, SHRINK_PAGES],
  ] as const) {
    for (const [name, body] of Object.entries(pages)) {
      const dest = path.join(root, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, body, "utf8");
    }
  }

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // Both wikis on one server — the gate is per-wiki, so both sides of it have
      // to be reachable from the same reader build.
      WIKI_EXTRA: `${WIKI_WITH}=${rootWith},${WIKI_WITHOUT}=${rootWithout},${WIKI_SHRINK}=${rootShrink}`,
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
  if (rootShrink) await rm(rootShrink, { recursive: true, force: true });
});

test.describe("Wiki reader: plan-status facet", () => {
  test("chips render with counts and filter the list on the wiki that uses plan_status", async ({
    page,
  }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_WITH}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(5);

    // The facet lives inside the Filters disclosure, closed until a filter is set.
    await page.locator("#wikiFilters summary").click();
    const statusRow = page.locator("#statusChips");
    await expect(statusRow).toBeVisible();
    await expect(statusRow).toContainText("shipped 2");
    await expect(statusRow).toContainText("in-flight 1");
    await expect(statusRow).toContainText("blocked 1");
    await expect(statusRow).toContainText("⚑ has follow-ups 2");

    // A status chip filters the list…
    await statusRow.locator('[data-status="shipped"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    await expect(page.locator("#wikiCount")).toHaveText("2 / 5");

    // …and the ⚑ toggle ANDs with it on the other axis: only the shipped plan that
    // still has loose ends survives.
    await statusRow.locator("[data-followups]").click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);
    await expect(page.locator(".wiki-list-item")).toContainText("Alpha");
    await expect(page.locator("#wikiFilterCount")).toHaveText("2");

    // Clearing the status axis leaves the follow-ups axis standing — proof the two
    // are independent filters and not one collapsed vocabulary.
    await statusRow.locator('[data-status=""]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    await expect(page.locator("#wikiFilterCount")).toHaveText("1");
  });

  test("the active status chip survives a scope switch that zeroes its count", async ({ page }) => {
    // The regression: the chip row was built ONLY from the statuses present in the
    // scoped counts, so a domain/type switch that emptied the active status deleted
    // its chip — leaving an empty list, a badge of 1, and nothing highlighted to
    // explain either, with no way back except reloading.
    await page.goto(`${BASE}/wiki?wiki=${WIKI_WITH}`);
    await page.locator("#wikiFilters summary").click();
    const statusRow = page.locator("#statusChips");
    const blocked = statusRow.locator('[data-status="blocked"]');

    await blocked.click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1); // Delta, under life/

    // Narrow to the AI domain, which Delta is not in — `blocked` goes to 0.
    await page.locator('#domainChips [data-domain="ai"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(0);
    await expect(blocked).toBeVisible();
    await expect(blocked).toHaveClass(/active/);
    await expect(blocked).toContainText("blocked 0");
    await expect(page.locator("#wikiFilterCount")).toHaveText("1");

    // …and it is still the way out: "All status" restores the four AI pages.
    await statusRow.locator('[data-status=""]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);
    await expect(page.locator("#wikiCount")).toHaveText("4 / 5");
  });

  test("status pills ride the page rows and the article header, escaped", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_WITH}`);
    const alphaRow = page.locator('.wiki-list-item[data-page="alpha"]');
    await expect(alphaRow.locator(".wiki-status")).toHaveText("shipped");
    await expect(alphaRow.locator(".wiki-status")).toHaveClass(/plan-shipped/);
    await expect(alphaRow.locator(".wiki-followup-flag")).toBeVisible();
    // The two axes stay separable: `beta` is shipped with nothing left over.
    const betaRow = page.locator('.wiki-list-item[data-page="beta"]');
    await expect(betaRow.locator(".wiki-status")).toHaveText("shipped");
    await expect(betaRow.locator(".wiki-followup-flag")).toHaveCount(0);
    // A page carrying no plan_status shows no pill, on a wiki where the facet is live.
    await expect(page.locator('.wiki-list-item[data-page="plain"] .wiki-status')).toHaveCount(0);

    await alphaRow.click();
    const head = page.locator(".wiki-article-head");
    await expect(head.locator(".wiki-status")).toHaveText("shipped");
    await expect(head.locator(".wiki-followup-flag")).toBeVisible();
    // `status_note` survives verbatim through the escape — a broken escape would
    // have truncated this attribute at the embedded quote.
    await expect(head.locator(".wiki-status")).toHaveAttribute(
      "title",
      `2026-07-30 — ${STATUS_NOTE}`,
    );
  });

  test("the facet is absent on a wiki with no plan_status pages", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_WITHOUT}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    await page.locator("#wikiFilters summary").click();
    // The type row is there — the disclosure IS open, so a hidden status row is a
    // real gate decision and not just an unopened panel.
    await expect(page.locator("#typeChips")).toBeVisible();
    await expect(page.locator("#statusChips")).toBeHidden();
    await expect(page.locator("#statusChips")).toBeEmpty();
    await expect(page.locator(".wiki-status")).toHaveCount(0);
    await expect(page.locator(".wiki-followup-flag")).toHaveCount(0);
  });
});

/**
 * The domain (All/AI/Life) chip row, gated the same way and over the same two
 * roots: `domain` is derived from a `life/` path prefix, so only jarvis's wiki
 * spans both values and everywhere else the row is three inert chips.
 */
test.describe("Wiki reader: domain facet", () => {
  test("the row is absent on a wiki with no life/ pages", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_WITHOUT}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    // Not an unrendered page: the search box above the row is up.
    await expect(page.locator("#wikiSearch")).toBeVisible();
    await expect(page.locator("#domainChips")).toBeHidden();
  });

  test("the row shows and filters on a wiki that spans both domains", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_WITH}`);
    const row = page.locator("#domainChips");
    await expect(row).toBeVisible();
    await expect(row.locator('[data-domain=""]')).toHaveClass(/active/);

    await row.locator('[data-domain="life"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);
    await expect(page.locator(".wiki-list-item")).toContainText("Delta");

    await row.locator('[data-domain="ai"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);

    await row.locator('[data-domain=""]').click();
    await expect(page.locator("#wikiCount")).toHaveText("5 / 5");
  });

  test("a listing that loses its life/ pages hides the row AND clears the stale filter", async ({
    page,
  }) => {
    // The failure this pins: hiding the row while `filters.domain` still says
    // `life` leaves the reader an empty list and no visible control to undo it.
    await page.clock.install();
    await page.goto(`${BASE}/wiki?wiki=${WIKI_SHRINK}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);
    const row = page.locator("#domainChips");
    await expect(row).toBeVisible();
    await row.locator('[data-domain="life"]').click();
    await expect(page.locator(".wiki-list-item")).toHaveCount(1);

    await rm(path.join(rootShrink, "life"), { recursive: true, force: true });
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(row).toBeHidden();
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
    await expect(page.locator("#wikiCount")).toHaveText("2 / 2");

    // …and when the domain comes back the row does too, showing the filter the
    // clear above actually left behind rather than the chip the reader last hit.
    await mkdir(path.join(rootShrink, "life"), { recursive: true });
    await writeFile(path.join(rootShrink, "life", "three.md"), SHRINK_PAGES["life/three.md"]!, "utf8");
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(row).toBeVisible();
    await expect(page.locator(".wiki-list-item")).toHaveCount(3);
    await expect(row.locator('[data-domain=""]')).toHaveClass(/active/);
    await expect(row.locator('[data-domain="life"]')).not.toHaveClass(/active/);
  });
});
