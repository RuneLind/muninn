/**
 * /wiki reader — «Walk me through», end-to-end.
 *
 * What no unit test can see: which headings get the 🧭 button in the real
 * rendered article (top-level ones, not one inside a fold or a code fence), the
 * POST the click sends, and the panel's state table driven through real clicks —
 * one request per click while loading, success, the all-dropped error, an abort
 * on close, an A→B switch, a navigation mid-run, a fresh call on reopen, no
 * button on a read-only wiki, and legible text in both themes.
 *
 * NO MODEL CALLS: `POST /api/wiki/walkthrough` is stubbed at the network
 * boundary with canned SSE bodies. Each stubbed response can be HELD until the
 * test releases it, which is how the abort and switch rows are reached.
 *
 * It boots its OWN muninn on a dedicated port (`e2e/ports.ts`) with two temp
 * `WIKI_EXTRA` wikis, the second listed in `WIKI_READONLY_ROOTS`.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";

const PORT = e2ePort("wiki-walkthrough");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-walkthrough";
const RO_WIKI = "e2e-walkthrough-ro";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const GUIDE = [
  "---",
  "title: Guide",
  "type: concept",
  "---",
  "",
  "# Guide",
  "",
  "## How it works",
  "",
  "The gardener clusters summaries into wiki-page proposals every week.",
  "",
  "```",
  "## Not a heading",
  "```",
  "",
  '<Fold title="More">',
  "",
  "## Inside a fold",
  "",
  "Folded prose.",
  "",
  "</Fold>",
  "",
  "## Usage",
  "",
  "Open the review gate and approve or reject each proposal.",
  "",
  "## How it works",
  "",
  "A second section with the same heading text.",
  "",
].join("\n");

const OTHER = ["---", "title: Other", "type: concept", "---", "", "# Other", "", "## Elsewhere", "", "Other prose.", ""].join("\n");

function sse(events: [string, unknown][]): string {
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}
const done = (heading: string, tag: string) =>
  sse([
    [
      "done",
      {
        heading,
        steps: [
          { title: `${tag} step one`, text: `${tag} explains the first passage.`, quote: `${tag} quote one.` },
          { title: `${tag} step two`, text: `${tag} explains the second passage.`, quote: `${tag} quote two.` },
        ],
        quiz: [
          { question: `${tag}: who approves?`, choices: ["The gardener", "A human"], answer: 1, quote: `${tag} answer quote.` },
        ],
        dropped: [{ kind: "step", reason: "quote_not_in_section" }],
      },
    ],
    ["end", {}],
  ]);
const allDropped = sse([
  ["app_error", { type: "error", code: "all_dropped", message: "The model wrote steps that do not quote this section, so none of them is shown. Try again." }],
  ["end", {}],
]);

let server: ChildProcess | undefined;
let root = "";
let roRoot = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-wt-"));
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-wt-ro-"));
  await writeFile(path.join(root, "guide.md"), GUIDE, "utf8");
  await writeFile(path.join(root, "other.md"), OTHER, "utf8");
  await writeFile(path.join(roRoot, "guide.md"), GUIDE, "utf8");
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${RO_WIKI}=${roRoot}`,
      WIKI_READONLY_ROOTS: roRoot,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (roRoot) await rm(roRoot, { recursive: true, force: true });
});

interface Held {
  body: Record<string, unknown>;
  route: Route;
  release: (sseBody: string) => Promise<void>;
}

/** Stub the walkthrough route. With `hold`, each request waits for the test to
 *  call `release`; otherwise `respond(body)` answers at once. */
async function stub(page: Page, opts: { hold?: boolean; respond?: (body: Record<string, unknown>) => string } = {}) {
  const held: Held[] = [];
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/wiki/walkthrough*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    posted.push(body);
    const fulfill = async (b: string) => {
      try {
        await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: b });
      } catch { /* the page aborted it */ }
    };
    if (opts.hold) held.push({ body, route, release: fulfill });
    else await fulfill(opts.respond ? opts.respond(body) : done(String(body.heading), "A"));
  });
  return { held, posted };
}

const btn = (page: Page, heading: string, nth = 0) =>
  page.locator(`.wiki-article > :is(h2,h3,h4) [data-walkthrough-btn][data-wt-heading="${heading}"]`).nth(nth);

async function openGuide(page: Page, wiki = WIKI): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=guide.md`);
  await expect(page.locator(".wiki-article h3").first()).toBeVisible();
}

test.describe("Wiki reader: walk me through", () => {
  test("buttons sit on top-level headings only, never in a fold or a fence", async ({ page }) => {
    await openGuide(page);
    const all = page.locator("[data-walkthrough-btn]");
    await expect(all).toHaveCount(3);
    expect(await all.evaluateAll((els) => els.map((e) => e.getAttribute("data-wt-heading")))).toEqual([
      "How it works",
      "Usage",
      "How it works",
    ]);
    await expect(page.locator("details [data-walkthrough-btn], pre [data-walkthrough-btn]")).toHaveCount(0);
  });

  test("success: one request with the section's identity, steps then quiz; an answer locks", async ({ page }) => {
    const { posted } = await stub(page);
    await openGuide(page);
    await btn(page, "How it works", 1).click();
    const panel = page.locator("#wikiWalkthrough");
    await expect(panel.locator(".wiki-wt-step")).toHaveCount(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ relPath: "guide.md", heading: "How it works", ordinal: 1, count: 2 });
    expect(typeof posted[0]!.hash).toBe("string");
    await expect(panel.locator(".wiki-wt-step blockquote.wiki-wt-quote").first()).toHaveText("A quote one.");
    await expect(panel.locator(".wiki-wt-dropped")).toContainText("1 item was left out");
    // Wrong answer: marked wrong, the right one shown, the quote revealed, the question locked.
    await panel.locator(".wiki-wt-choice", { hasText: "The gardener" }).click();
    await expect(panel.locator(".wiki-wt-verdict.is-wrong")).toContainText("A human");
    await expect(panel.locator(".wiki-wt-verdict blockquote")).toHaveText("A answer quote.");
    await expect(panel.locator(".wiki-wt-choice[disabled]")).toHaveCount(2);
    // Opaque panel.
    const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("repeat clicks while loading send one request; close aborts and a late answer renders nothing", async ({ page }) => {
    const { held, posted } = await stub(page, { hold: true });
    await openGuide(page);
    const b = btn(page, "Usage");
    await b.click();
    await b.click();
    await b.click();
    await expect(page.locator("#wikiWalkthrough .wiki-wt-status")).toBeVisible();
    await expect.poll(() => posted.length).toBe(1);
    await page.locator("#wikiWalkthroughClose").click();
    await expect(page.locator("#wikiWalkthrough")).toHaveCount(0);
    await held[0]!.release(done("Usage", "LATE"));
    await page.waitForTimeout(300);
    await expect(page.locator("#wikiWalkthrough")).toHaveCount(0);
    await expect(page.getByText("LATE step one")).toHaveCount(0);
  });

  test("reopening a section after close makes a fresh call", async ({ page }) => {
    const { posted } = await stub(page);
    await openGuide(page);
    await btn(page, "Usage").click();
    await expect(page.locator("#wikiWalkthrough .wiki-wt-step")).toHaveCount(2);
    await page.locator("#wikiWalkthroughClose").click();
    await btn(page, "Usage").click();
    await expect(page.locator("#wikiWalkthrough .wiki-wt-step")).toHaveCount(2);
    expect(posted).toHaveLength(2);
  });

  test("A → B: only B's answer ever renders", async ({ page }) => {
    const { held } = await stub(page, { hold: true });
    await openGuide(page);
    await btn(page, "How it works", 0).click();
    await expect.poll(() => held.length).toBe(1);
    await btn(page, "Usage").click();
    await expect.poll(() => held.length).toBe(2);
    // B answers first, then A's late answer arrives — it must not replace B.
    await held[1]!.release(done("Usage", "BBB"));
    await expect(page.locator("#wikiWalkthrough").getByText("BBB step one")).toBeVisible();
    await held[0]!.release(done("How it works", "AAA"));
    await page.waitForTimeout(300);
    await expect(page.locator("#wikiWalkthroughTitle")).toContainText("Usage");
    await expect(page.getByText("AAA step one")).toHaveCount(0);
  });

  test("every step dropped: an error, nothing partial", async ({ page }) => {
    await stub(page, { respond: () => allDropped });
    await openGuide(page);
    await btn(page, "Usage").click();
    await expect(page.locator("#wikiWalkthrough .wiki-wt-error.is-dropped")).toContainText("do not quote this section");
    await expect(page.locator("#wikiWalkthrough .wiki-wt-step")).toHaveCount(0);
  });

  test("navigating away mid-run renders nothing into the new page", async ({ page }) => {
    const { held } = await stub(page, { hold: true });
    await openGuide(page);
    await btn(page, "Usage").click();
    await expect.poll(() => held.length).toBe(1);
    // The reader's own in-page navigation (pushState + fetch), not a reload.
    await page.locator('#wikiList [data-relpath="other.md"]').first().click();
    await expect(page.locator(".wiki-article h3", { hasText: "Elsewhere" })).toBeVisible();
    await expect(page.locator("#wikiWalkthrough")).toHaveCount(0);
    await held[0]!.release(done("Usage", "GONE"));
    await page.waitForTimeout(300);
    await expect(page.getByText("GONE step one")).toHaveCount(0);
    await expect(page.locator("#wikiWalkthrough")).toHaveCount(0);
  });

  test("a read-only wiki renders no button at all", async ({ page }) => {
    await openGuide(page, RO_WIKI);
    await expect(page.locator(".wiki-article h3").first()).toBeVisible();
    await expect(page.locator("[data-walkthrough-btn]")).toHaveCount(0);
  });

  test("button and panel are legible in light and dark", async ({ page }) => {
    await stub(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openGuide(page);
      const b = btn(page, "Usage");
      await b.hover();
      expect(await paintedContrast(b, { withOpacity: true }), `${scheme} button`).toBeGreaterThanOrEqual(3);
      await b.click();
      const panel = page.locator("#wikiWalkthrough");
      await expect(panel.locator(".wiki-wt-step")).toHaveCount(2);
      expect(await paintedContrast(panel.locator(".wiki-wt-step p").first()), `${scheme} step text`).toBeGreaterThanOrEqual(4.5);
      expect(await paintedContrast(panel.locator(".wiki-wt-quote").first()), `${scheme} quote`).toBeGreaterThanOrEqual(4.5);
      await panel.locator(".wiki-wt-choice", { hasText: "A human" }).click();
      expect(await paintedContrast(panel.locator(".wiki-wt-choice.is-right")), `${scheme} right choice`).toBeGreaterThanOrEqual(4.5);
      expect(await paintedContrast(panel.locator(".wiki-wt-verdict.is-right")), `${scheme} verdict`).toBeGreaterThanOrEqual(4.5);
      await page.locator("#wikiWalkthroughClose").click();
    }
  });

  test("the error state is legible in light and dark", async ({ page }) => {
    await stub(page, { respond: () => allDropped });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openGuide(page);
      await btn(page, "Usage").click();
      const err = page.locator("#wikiWalkthrough .wiki-wt-error");
      await expect(err).toBeVisible();
      expect(await paintedContrast(err), `${scheme} error`).toBeGreaterThanOrEqual(4.5);
      await page.locator("#wikiWalkthroughClose").click();
    }
  });
});
