/**
 * /wiki reader — the plan-status facet, end-to-end.
 *
 * The one thing no unit test can prove: the Status chip row and the ⚑ follow-ups
 * toggle appear on a wiki that USES the `plan_status` convention, filter the page
 * list when clicked, and are absent on a wiki that does not use it. The presence
 * gate is the whole point — every wiki that predates the convention (jarvis,
 * melosys-kode-wiki) and mimir mid-backfill must look exactly as it did before.
 *
 * Two constraints shape the setup:
 *   1. **Two wikis, one server.** The gate is a per-wiki decision, so proving it
 *      needs a with-status wiki AND a without-status wiki reachable from the same
 *      reader — hence two temp dirs in one comma-separated `WIKI_EXTRA`.
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
 * PLATFORM TOKENS: `blankBotTokens()` keeps this muninn off Telegram/Slack — a
 * second long-poller on a live token 409-fights the running production bot. The
 * reasoning lives in that module.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";

const PORT = 3023;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_WITH = "e2e-plans";
const WIKI_WITHOUT = "e2e-plain";
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

/** shipped 2 · in-flight 1 · blocked 1 · ⚑ 2 · one page with no plan fields at all. */
const WITH_PAGES: Record<string, string> = {
  "alpha.md": planPage("Alpha", {
    plan_status: "shipped",
    status_date: "2026-07-30",
    followups: "open",
    status_note: `'${STATUS_NOTE}'`,
  }),
  "beta.md": planPage("Beta", { plan_status: "shipped", followups: "none" }),
  "gamma.md": planPage("Gamma", { plan_status: "in-flight" }),
  "delta.md": planPage("Delta", { plan_status: "blocked", followups: "open" }),
  "plain.md": planPage("Plain", {}),
};

/** The control wiki: same shape, zero plan fields — the facet must not appear. */
const WITHOUT_PAGES: Record<string, string> = {
  "one.md": planPage("One", {}),
  "two.md": planPage("Two", {}),
};

let server: ChildProcess | undefined;
let rootWith = "";
let rootWithout = "";

test.beforeAll(async () => {
  rootWith = await mkdtemp(path.join(tmpdir(), "muninn-e2e-plans-"));
  rootWithout = await mkdtemp(path.join(tmpdir(), "muninn-e2e-plain-"));
  for (const [name, body] of Object.entries(WITH_PAGES)) {
    await writeFile(path.join(rootWith, name), body, "utf8");
  }
  for (const [name, body] of Object.entries(WITHOUT_PAGES)) {
    await writeFile(path.join(rootWithout, name), body, "utf8");
  }

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankBotTokens(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // Both wikis on one server — the gate is per-wiki, so both sides of it have
      // to be reachable from the same reader build.
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
