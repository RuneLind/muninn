/**
 * Fact-check claim retry (↻) — end-to-end smoke in a real browser.
 *
 * What no unit test can prove, and this spec exists for:
 *
 *   1. **The button is actually visible.** The markdown contract is
 *      `### <emoji> Claim n/m` but `formatWebHtml` emits `h${level + 1}`, so the
 *      rendered DOM contract is `<h4>`. An `h3` selector would ship an invisible
 *      affordance that every pure test still passes. The first assertion below is
 *      that the injected row's previous element sibling really is an `H4`.
 *   2. **The affordance survives every repaint** — including the one the retry
 *      itself performs after a splice, and the boot rehydrate from localStorage.
 *   3. **A successful retry rewrites the pane**: the ❓ hole becomes a real
 *      verdict, the meta line's outcome breakdown moves, and the write-action bars
 *      re-derive.
 *
 * **What is stubbed and why.** Exactly ONE model-backed SSE route is stubbed at the
 * network boundary with `page.route` — `/api/wiki/factcheck/claim`, a 180s one-shot
 * (`wiki-integrate.spec.ts`'s precedent). The fact-check RUN itself is never made
 * at all: committed turns are seeded straight into localStorage, so there is no
 * second route to stub. Forcing a REAL timeout is additionally not drivable from
 * outside the process: the per-claim budget is enforced inside each connector
 * (shortening `FACTCHECK_CLAIM_TIMEOUT_MS` forces nothing), and the `oneShot` test
 * seam is not reachable through the route. Everything ELSE here is real — the
 * booted muninn, the real `/api/wiki/factcheck/claim` URL construction, the real
 * client bundle, the real localStorage round-trip.
 *
 * Fact-check turns are seeded straight into `localStorage` (the reader persists
 * committed Ask turns under `wikiAskSession:<wiki>`), so the tested path is the
 * REHYDRATED one — turn restored from storage, ↻ derived from `claimOutcomeByIndex`.
 *
 * ENV PREREQUISITE / PLATFORM TOKENS: identical to `wiki-integrate.spec.ts` — a
 * working `.env` at the repo root, and `blankBotTokens()` so this muninn never
 * opens a second Telegram long-poller against the production bot's token.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";

const PORT = 3026;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_NAME = "e2e-retry";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const PAGE_BODY = [
  "---",
  "title: Retry Note",
  "---",
  "",
  "# Retry Note",
  "",
  "The device ships 2.1M units per year.",
  "",
  "Revenue doubled last year.",
  "",
].join("\n");

/** A committed three-claim answer whose middle claim TIMED OUT — the ❓ hole. */
const LEDE = "Two of the three claims check out; one could not be checked.";
const ANSWER = [
  LEDE,
  "",
  "### ✅ Claim 1/3 — Ships 2.1M units",
  "",
  "Confirmed by the filing.",
  "",
  "Confidence: 88/100",
  "",
  "### ❓ Claim 2/3 — Revenue doubled",
  "",
  "Verification timed out after 110s — the claim was not checked.",
  "",
  "### ❌ Claim 3/3 — Founded in 1990",
  "",
  "The company was founded in 1994.",
].join("\n");

/** The block the stubbed retry returns for claim 2. */
const RETRIED_BLOCK = [
  "### ✅ Claim 2/3 — Revenue doubled",
  "",
  "The 2025 filing reports revenue up 104% year over year.",
  "",
  "Confidence: 82/100",
  "",
  "Sources: [sec.gov](https://sec.gov/filing)",
].join("\n");

const RETRIED_BLOCK_3 = [
  "### ✅ Claim 3/3 — Founded in 1990",
  "",
  "Re-checked: the incorporation record says 1994.",
  "",
  "Confidence: 77/100",
].join("\n");

interface SeedTurn {
  question: string;
  answer: string;
  citations: unknown[];
  cited: number[];
  html: string | null;
  askedAt: number;
  kind: string;
  page: string;
  pageType: string;
  baseHash: string;
  claimCount: number;
  claimOutcomes: Record<string, number>;
  claimOutcomeByIndex: Record<string, string>;
  fcMode?: string;
  fcSel?: string;
  fcCtx?: string;
  claimQuotes?: { index: number; quote: string }[];
  wrote?: string;
}

function seedTurn(over: Partial<SeedTurn> = {}): SeedTurn {
  return {
    question: "Fact check: Retry Note",
    answer: ANSWER,
    citations: [],
    cited: [],
    html: null,
    askedAt: 1_700_000_000_000,
    kind: "factcheck",
    page: "retry-note",
    pageType: "note",
    baseHash: "deadbeef",
    claimCount: 2,
    claimOutcomes: { verified: 2, timeout: 1 },
    claimOutcomeByIndex: { 1: "verified", 2: "timeout", 3: "verified" },
    fcMode: "article",
    claimQuotes: [{ index: 2, quote: "Revenue doubled last year." }],
    ...over,
  };
}

/** One SSE frame. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Stub the retry route with a successful re-verify (a tool event so the
 *  Consulting chips path is exercised, then the verdict block).
 *
 *  `firstDelayMs` holds the FIRST call open, which is how the batch's running
 *  state (and therefore Cancel) is reachable from a test at all. */
async function stubRetry(
  page: Page,
  opts: {
    urls?: string[];
    block?: string;
    status?: number;
    body?: unknown;
    outcome?: string;
    firstDelayMs?: number;
  } = {},
): Promise<void> {
  let calls = 0;
  await page.route(
    (url) => url.pathname === "/api/wiki/factcheck/claim",
    async (route) => {
      opts.urls?.push(route.request().url());
      const nth = calls++;
      if (opts.status && opts.status !== 200) {
        return route.fulfill({
          status: opts.status,
          contentType: "application/json",
          body: JSON.stringify(opts.body ?? {}),
        });
      }
      const index = Number(new URL(route.request().url()).searchParams.get("index"));
      const block = opts.block ?? (index === 3 ? RETRIED_BLOCK_3 : RETRIED_BLOCK);
      if (nth === 0 && opts.firstDelayMs) {
        await new Promise((r) => setTimeout(r, opts.firstDelayMs));
      }
      const body =
        sse("tool", {
          type: "tool",
          state: "start",
          name: "WebFetch",
          label: "Reading",
          detail: "sec.gov",
          url: "https://sec.gov/filing",
          claimIndex: index,
        }) +
        sse("tool", { type: "tool", state: "end", name: "WebFetch", claimIndex: index }) +
        sse("claim_result", {
          type: "claim_result",
          index,
          verdict: "✅",
          outcome: opts.outcome ?? "verified",
          confidence: 82,
          markdown: block,
        }) +
        sse("done", { type: "done", index }) +
        sse("end", {});
      // A cancelled request is aborted client-side; fulfilling it then throws.
      await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {});
    },
  );
}

/** Put turns in localStorage under the reader's session key, then reload so the
 *  boot-time rehydrate picks them up — the REHYDRATED path is the tested one. */
async function seedSession(page: Page, turns: SeedTurn[]): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI_NAME}`, { waitUntil: "domcontentloaded" });
  const wikiName = await page.evaluate(() => (window as { __WIKI_NAME__?: string }).__WIKI_NAME__ ?? "");
  await page.evaluate(
    ([key, json]) => localStorage.setItem(key!, json!),
    [`wikiAskSession:${wikiName || "__default__"}`, JSON.stringify(turns)],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

/** Open the rail's Ask tab and re-show the seeded turn in the article pane. */
async function openSeededTurn(page: Page): Promise<void> {
  await page.locator('.wiki-conn-tab[data-conntab="ask"]').click();
  await page.locator(".wiki-ask-hist-item").first().click();
}

let root: string;
let server: ChildProcess | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-retry-"));
  await writeFile(path.join(root, "retry-note.md"), PAGE_BODY, "utf8");
  await writeFile(path.join(root, "log.md"), "# Log\n", "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankBotTokens(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI_NAME}=${root}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_NAME}`);
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

test.describe("Wiki reader: fact-check claim retry", () => {
  test("the ↻ sits under the rendered h4, and a retry rewrites the hole into a verdict", async ({
    page,
  }) => {
    const urls: string[] = [];
    await stubRetry(page, { urls });
    await seedSession(page, [seedTurn()]);
    await openSeededTurn(page);

    // Exactly one row — the two verified claims get none.
    const row = page.locator(".wiki-fc-retry");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-claim-retry", "2");

    // THE TRAP, pinned: the heading the row anchors to is an <h4>, not an <h3>.
    const anchorTag = await row.evaluate((el) => el.previousElementSibling?.tagName ?? "");
    expect(anchorTag).toBe("H4");
    expect(await page.locator("#askAnswerBody h3").count()).toBe(0);

    // The meta line reports the pre-retry breakdown.
    await expect(page.locator("#askAnswerMeta")).toContainText("2 checked");
    await expect(page.locator("#askAnswerMeta")).toContainText("1 timed out");

    await row.locator(".wiki-fc-retry-btn").click();

    // The ❓ hole is now a real verdict…
    await expect(page.locator("#askAnswerBody")).toContainText("revenue up 104%");
    await expect(page.locator("#askAnswerBody")).not.toContainText("Verification timed out");
    // …the claim stops offering a retry…
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(0);
    // …the meta line re-derives from the outcome map…
    await expect(page.locator("#askAnswerMeta")).toContainText("3 checked");
    await expect(page.locator("#askAnswerMeta")).not.toContainText("timed out");
    // …the lede carries the amendment (this answer is what ➕/integrate commits)…
    await expect(page.locator("#askAnswerBody")).toContainText(
      "Claim 2 was re-checked after the initial run",
    );
    // …the retry's own sources joined the Consulting chips…
    await expect(page.locator("#askToolSources .wiki-fc-src-chip")).toHaveText("sec.gov");
    // …the siblings are untouched…
    await expect(page.locator("#askAnswerBody")).toContainText("Confirmed by the filing.");
    await expect(page.locator("#askAnswerBody")).toContainText("The company was founded in 1994.");
    // …and the write bars re-derived (the ➕ is live on an unwritten turn).
    await expect(page.locator("#wikiFactcheckAppendBtn")).toBeEnabled();

    // The route was called with the claim the reader clicked, echoed from the turn.
    expect(urls).toHaveLength(1);
    const sent = new URL(urls[0]!);
    expect(sent.searchParams.get("index")).toBe("2");
    expect(sent.searchParams.get("total")).toBe("3");
    expect(sent.searchParams.get("title")).toBe("Revenue doubled");
    expect(sent.searchParams.get("quote")).toBe("Revenue doubled last year.");
    expect(sent.searchParams.get("mode")).toBe("article");

    // The rewritten answer is PERSISTED: reload and the rehydrated turn shows the
    // spliced verdict with no ↻ left.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSeededTurn(page);
    await expect(page.locator("#askAnswerBody")).toContainText("revenue up 104%");
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(0);
  });

  test("a sel-mode turn retries in sel mode, threading its persisted selection", async ({ page }) => {
    const urls: string[] = [];
    await stubRetry(page, { urls });
    await seedSession(page, [
      seedTurn({ fcMode: "sel", fcSel: "Revenue doubled last year.", fcCtx: "Retry Note" }),
    ]);
    await openSeededTurn(page);
    await page.locator(".wiki-fc-retry .wiki-fc-retry-btn").click();
    await expect(page.locator("#askAnswerBody")).toContainText("revenue up 104%");

    const sent = new URL(urls[0]!);
    expect(sent.searchParams.get("mode")).toBe("sel");
    expect(sent.searchParams.get("sel")).toBe("Revenue doubled last year.");
    expect(sent.searchParams.get("ctx")).toBe("Retry Note");
  });

  test("a 409 renders the holder's deadline and changes nothing", async ({ page }) => {
    await stubRetry(page, {
      status: 409,
      body: { state: "running", expiresAtMs: Date.now() + 125_000 },
    });
    await seedSession(page, [seedTurn()]);
    await openSeededTurn(page);
    await page.locator(".wiki-fc-retry .wiki-fc-retry-btn").click();

    await expect(page.locator(".wiki-fc-retry-msg")).toContainText("still running");
    await expect(page.locator(".wiki-fc-retry-msg")).toContainText("m left");
    // The persisted answer is byte-untouched and the affordance stays live.
    await expect(page.locator("#askAnswerBody")).toContainText("Verification timed out");
    await expect(page.locator(".wiki-fc-retry .wiki-fc-retry-btn")).toBeEnabled();
  });

  test("a failed retry reports on the row and leaves the answer untouched", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/wiki/factcheck/claim",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            sse("app_error", {
              type: "error",
              message: "The re-check timed out after 180s — the claim was not re-verified.",
            }) + sse("end", {}),
        }),
    );
    await seedSession(page, [seedTurn()]);
    await openSeededTurn(page);
    await page.locator(".wiki-fc-retry .wiki-fc-retry-btn").click();

    await expect(page.locator(".wiki-fc-retry-msg")).toContainText("re-check timed out after 180s");
    await expect(page.locator("#askAnswerBody")).toContainText("Verification timed out");
    await expect(page.locator(".wiki-fc-retry .wiki-fc-retry-btn")).toBeEnabled();
  });

  test("a turn that already wrote to the page shows a DISABLED ↻ with copy, not nothing", async ({
    page,
  }) => {
    await seedSession(page, [seedTurn({ wrote: "append" })]);
    await openSeededTurn(page);
    const row = page.locator(".wiki-fc-retry");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".wiki-fc-retry-btn")).toBeDisabled();
    await expect(row.locator(".wiki-fc-retry-msg")).toContainText("already added to the article");
  });

  test("two unverified claims get a batch bar that runs them one at a time", async ({ page }) => {
    const urls: string[] = [];
    await stubRetry(page, { urls });
    await seedSession(page, [
      seedTurn({
        claimOutcomeByIndex: { 1: "verified", 2: "timeout", 3: "error" },
        claimOutcomes: { verified: 1, timeout: 1, error: 1 },
        claimCount: 1,
      }),
    ]);
    await openSeededTurn(page);

    await expect(page.locator(".wiki-fc-retry")).toHaveCount(2);
    const bar = page.locator("#wikiClaimRetryAll");
    await expect(bar).toContainText("Retry 2 unverified claims");
    await bar.click();

    await expect(page.locator("#askAnswerBody")).toContainText("revenue up 104%");
    await expect(page.locator("#askAnswerBody")).toContainText("incorporation record says 1994");
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(0);
    await expect(page.locator("#askAnswerMeta")).toContainText("3 checked");
    // Sequential, in claim order — never two in flight (the route is per-page
    // single-flight, and interleaved tool chips are unreadable).
    expect(urls.map((u) => new URL(u).searchParams.get("index"))).toEqual(["2", "3"]);
    // Both amendments accumulated into ONE lede line.
    await expect(page.locator("#askAnswerBody")).toContainText(
      "Claims 2 and 3 were re-checked after the initial run",
    );
    // The terminal count RENDERS. It is held on the turn, not the run record —
    // rendered off the run it never appeared at all, because the run is nulled
    // before the last repaint.
    await expect(page.locator("#wikiClaimRetryBar")).toContainText("Re-checked 2 of 2");
  });

  test("Cancel leaves honest copy that SURVIVES the run settling", async ({ page }) => {
    const urls: string[] = [];
    await stubRetry(page, { urls, firstDelayMs: 3000 });
    await seedSession(page, [
      seedTurn({
        claimOutcomeByIndex: { 1: "verified", 2: "timeout", 3: "error" },
        claimOutcomes: { verified: 1, timeout: 1, error: 1 },
        claimCount: 1,
      }),
    ]);
    await openSeededTurn(page);
    await page.locator("#wikiClaimRetryAll").click();

    const cancel = page.locator("#wikiClaimRetryCancel");
    await expect(cancel).toBeVisible();
    await cancel.click();

    // The copy is honest about what cancel can and cannot do…
    const bar = page.locator("#wikiClaimRetryBar");
    await expect(bar).toContainText("finishes on the server");
    await expect(bar).toContainText("~4 min");
    // …and it is STILL there after the aborted claim's stream settles and the run
    // record clears. Rendered off the run it lasted exactly one frame, and what
    // replaced it was an idle bar promising a retry that could only 409.
    await page.waitForTimeout(1500);
    await expect(bar).toContainText("finishes on the server");
    // The batch never launched the second claim.
    expect(urls).toHaveLength(1);
    // Nothing was spliced; the holes are still holes.
    await expect(page.locator("#askAnswerBody")).toContainText("Verification timed out");
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(2);
  });

  test("a claim heading QUOTED inside a code fence is not the splice target", async ({ page }) => {
    // Confirmed in a live browser before the fix: the splice anchored on the
    // fenced copy, ate the closing ``` and rendered the rest of the answer as one
    // code block. `<pre>` count is the assertion that catches exactly that.
    const fenced = [
      LEDE,
      "",
      "### ✅ Claim 1/3 — Ships 2.1M units",
      "",
      "I was asked to check:",
      "",
      "```",
      "### ❓ Claim 2/3 — Revenue doubled",
      "```",
      "",
      "Confirmed by the filing.",
      "",
      "### ❓ Claim 2/3 — Revenue doubled",
      "",
      "Verification timed out after 110s — the claim was not checked.",
      "",
      "### ❌ Claim 3/3 — Founded in 1990",
      "",
      "The company was founded in 1994.",
    ].join("\n");
    await stubRetry(page);
    await seedSession(page, [seedTurn({ answer: fenced })]);
    await openSeededTurn(page);

    const before = await page.locator("#askAnswerBody pre").count();
    expect(before).toBe(1);
    // Only the REAL claim-2 heading gets a row (the fenced one is inside a <pre>).
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(1);
    await page.locator(".wiki-fc-retry .wiki-fc-retry-btn").click();

    await expect(page.locator("#askAnswerBody")).toContainText("revenue up 104%");
    // The fence still opens AND closes — the tail is prose, not code.
    expect(await page.locator("#askAnswerBody pre").count()).toBe(1);
    await expect(page.locator("#askAnswerBody")).toContainText("The company was founded in 1994.");
    await expect(page.locator("#askAnswerBody")).toContainText("Confirmed by the filing.");
  });

  test("an unknown wire outcome cannot destroy the whole persisted outcome map", async ({ page }) => {
    // `isValidOutcomeMap`'s `.every` drops the ENTIRE map on one bad value, taking
    // every OTHER claim's outcome with it — so the wire value is validated before
    // it is written, and falls back to `verified`.
    await stubRetry(page, { outcome: "definitely-not-an-outcome" });
    await seedSession(page, [
      seedTurn({
        claimOutcomeByIndex: { 1: "verified", 2: "timeout", 3: "error" },
        claimOutcomes: { verified: 1, timeout: 1, error: 1 },
        claimCount: 1,
      }),
    ]);
    await openSeededTurn(page);
    await page.locator('.wiki-fc-retry[data-claim-retry="2"] .wiki-fc-retry-btn').click();
    await expect(page.locator("#askAnswerBody")).toContainText("revenue up 104%");

    // Reload: claim 3 still remembers it errored, so it still offers a ↻.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSeededTurn(page);
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(1);
    await expect(page.locator(".wiki-fc-retry")).toHaveAttribute("data-claim-retry", "3");
  });

  test("a turn persisted before the outcome map offers no ↻ at all", async ({ page }) => {
    const legacy = seedTurn();
    delete (legacy as Partial<SeedTurn>).claimOutcomeByIndex;
    await seedSession(page, [legacy]);
    await openSeededTurn(page);
    await expect(page.locator("#askAnswerBody")).toContainText("Verification timed out");
    await expect(page.locator(".wiki-fc-retry")).toHaveCount(0);
    await expect(page.locator("#wikiClaimRetryAll")).toHaveCount(0);
  });
});
