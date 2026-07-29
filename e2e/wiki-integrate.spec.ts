/**
 * Fact-check v4 "Integrate into article" — end-to-end smoke.
 *
 * The point of this spec is the one thing no unit test can prove: after the
 * accept flow, the CORRECTED sentence is in the reloaded article and the
 * pre-edit sentence is gone. (The callout is the ➕ feature's business, not
 * this one's.)
 *
 * Two constraints shape the setup:
 *   1. **No model calls.** The propose route runs a real 25–90s one-shot, so it
 *      is stubbed with `page.route` and a canned edit list whose `resolvedText`
 *      matches the scratch page verbatim. The APPLY call is deliberately NOT
 *      stubbed — the real CAS, the real per-wiki write queue and the real write
 *      are what we're smoking.
 *   2. **No writes to a real wiki.** The spec boots its OWN muninn on a separate
 *      port with `WIKI_EXTRA` pointed at a throwaway temp wiki, rather than
 *      riding the shared `webServer` (whose command carries no `WIKI_EXTRA`, and
 *      whose `reuseExistingServer` would happily hand us a dev server without
 *      it). The temp dir is not a git repo, so the apply exercises the
 *      `committed:false / not-a-repo` copy path too.
 *
 * Fact-check turns are seeded straight into `localStorage` (the reader persists
 * committed Ask turns under `wikiAskSession:<wiki>`), so no SSE fact check — and
 * therefore no web-tool model calls — is needed to get a turn on screen.
 *
 * ENV PREREQUISITE: the same one every other e2e spec has — a working `.env`
 * (`DATABASE_URL` + a bot token) at the repo root, since `src/index.ts` boots the
 * full process. Bun auto-loads it in the spawned child (cwd = repo root).
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3021;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_NAME = "e2e-scratch";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const ORIGINAL_SENTENCE = "The device ships 4M units per year.";
const CORRECTED_SENTENCE = "The device ships 2.1M units per year.";

const PAGE_BODY = [
  "---",
  "title: Scratch Note",
  "---",
  "",
  "# Scratch Note",
  "",
  ORIGINAL_SENTENCE,
  "",
  "Unrelated prose that must survive untouched.",
  "",
].join("\n");

/** A committed fact-check answer carrying ONE ❌ claim (the integrate gate needs
 *  a `### <emoji> Claim n/m` heading block, not a stray emoji). */
const FACTCHECK_ANSWER = [
  "One claim is contradicted by the filing.",
  "",
  "### ❌ Claim 1/1 — Ships 4M units",
  "",
  "The filing reports 2.1M units.",
  "",
  "Sources: [sec.gov](https://sec.gov/x)",
].join("\n");

/** An all-✅ answer — the gate must render NO integrate button for it. */
const CLEAN_ANSWER = [
  "Everything checks out.",
  "",
  "### ✅ Claim 1/1 — Ships 2.1M units",
  "",
  "Confirmed by the filing.",
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
  bodyLen: number;
  claimCount: number;
  wrote?: string;
}

let root: string;
let server: ChildProcess | undefined;
let baseHash: string;

function seedTurn(over: Partial<SeedTurn> = {}): SeedTurn {
  return {
    question: "Fact check: Scratch Note",
    answer: FACTCHECK_ANSWER,
    citations: [],
    cited: [],
    html: null,
    askedAt: 1_700_000_000_000,
    kind: "factcheck",
    page: "note",
    pageType: "note",
    baseHash,
    bodyLen: PAGE_BODY.length,
    claimCount: 1,
    ...over,
  };
}

/** Put turns in localStorage under the reader's session key, then reload so the
 *  boot-time rehydrate picks them up. */
async function seedSession(page: Page, turns: SeedTurn[]): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI_NAME}`, { waitUntil: "domcontentloaded" });
  // Read the case-corrected wiki name the page actually injected — that, not our
  // query string, is what keys the session.
  const wikiName = await page.evaluate(() => (window as { __WIKI_NAME__?: string }).__WIKI_NAME__ ?? "");
  await page.evaluate(
    ([key, json]) => localStorage.setItem(key!, json!),
    [`wikiAskSession:${wikiName || "__default__"}`, JSON.stringify(turns)],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

/** Open the rail's Ask tab (the session-history list lives there, hidden behind
 *  the default Connections tab) and re-show the seeded turn in the article pane. */
async function openSeededTurn(page: Page): Promise<void> {
  await page.locator('.wiki-conn-tab[data-conntab="ask"]').click();
  await page.locator(".wiki-ask-hist-item").first().click();
}

/** Stub ONLY the propose call (a real model one-shot). Apply hits the real server. */
async function stubPropose(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/wiki/factcheck/integrate",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          edits: [
            {
              claimIndex: 1,
              verdict: "❌",
              old: "ships 4M units per year",
              new: "ships 2.1M units per year",
              reason: "The filing reports 2.1M units.",
              start: 0,
              end: 0,
              tier: "exact",
              resolvedText: "ships 4M units per year",
              beforeCtx: "The device ",
              afterCtx: ".",
            },
          ],
          dropped: [{ edit: { old: "an unrelated quote" }, reason: "no longer found in the page" }],
          budget: { bodyLen: PAGE_BODY.length, maxEdits: 12, maxEditChars: 2000, maxChangedChars: 2000 },
          hasSentinelBlock: false,
        }),
      }),
  );
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-wiki-"));
  await writeFile(path.join(root, "note.md"), PAGE_BODY, "utf8");
  await writeFile(path.join(root, "log.md"), "# Log\n", "utf8");
  baseHash = createHash("sha256").update(readFileSync(path.join(root, "note.md"), "utf8")).digest("hex");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
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

test.describe("Fact-check: integrate into article", () => {
  test("proposed edits preview, accept, and the corrected sentence lands in the article", async ({
    page,
  }) => {
    await stubPropose(page);
    await seedSession(page, [seedTurn()]);

    // Re-open the seeded turn from the session history, then integrate.
    await openSeededTurn(page);
    const openBtn = page.locator("#wikiFactcheckIntegrateBtn");
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // Preview: the diff shows the RESOLVED span on the old side, the correction
    // on the new side, and the dropped rejection is disclosed rather than hidden.
    const panel = page.locator("#wikiFcIntPanel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("1 proposed edit");
    await expect(panel.locator(".d-del")).toContainText("ships 4M units per year");
    await expect(panel.locator(".d-add")).toContainText("ships 2.1M units per year");
    await expect(panel.locator(".wiki-fc-int-dropped")).toContainText("1 not applied");

    // Accept — a REAL apply against the scratch wiki (real CAS, real write).
    await page.locator("#wikiFcIntAccept").click();

    // THE assertion: a successful apply reloads the checked page in the reader,
    // and the reloaded article carries the correction, not the original.
    const article = page.locator("#articleWrap");
    await expect(article).toContainText(CORRECTED_SENTENCE);
    await expect(article).not.toContainText(ORIGINAL_SENTENCE);
    await expect(article).toContainText("Unrelated prose that must survive untouched.");

    // Re-opening the turn shows the retired button — derived from the turn's
    // (now persisted) `wrote` flag — with the honest "no git repo" outcome copy.
    await openSeededTurn(page);
    const doneLabel = page.locator(".wiki-fc-int-done");
    await expect(doneLabel).toContainText("Integrated 1 edit");
    await expect(doneLabel).toContainText("not committed");
    // The other write action is retired too — an integrate staled this baseHash.
    await expect(page.locator("#wikiFactcheckAppendBtn")).toBeDisabled();
    await expect(page.locator("#wikiFactcheckAppendBar")).toContainText("re-run the fact check");

    // …and on disk, which is what the wiki actually is.
    const onDisk = readFileSync(path.join(root, "note.md"), "utf8");
    expect(onDisk).toContain(CORRECTED_SENTENCE);
    expect(onDisk).not.toContain(ORIGINAL_SENTENCE);
  });

  test("an all-✅ fact check renders no integrate button", async ({ page }) => {
    await seedSession(page, [
      seedTurn({ question: "Clean check", answer: CLEAN_ANSWER, askedAt: 1_700_000_000_001 }),
    ]);
    await openSeededTurn(page);
    // The ➕ append button still renders (any fact check can be annotated) —
    // only the prose-editing action is gated on a correctable claim.
    await expect(page.locator("#wikiFactcheckAppendBtn")).toBeVisible();
    await expect(page.locator("#wikiFactcheckIntegrateBtn")).toHaveCount(0);
  });

  test("a turn that already appended a callout renders integrate disabled", async ({ page }) => {
    await seedSession(page, [
      seedTurn({ question: "Already appended", wrote: "append", askedAt: 1_700_000_000_002 }),
    ]);
    await openSeededTurn(page);
    // Derived from the PERSISTED `wrote` flag — this turn was never appended in
    // this browser session, so a DOM-only disable would have come back live.
    const disabled = page.locator(".wiki-fc-int-open");
    await expect(disabled).toBeVisible();
    await expect(disabled).toBeDisabled();
    await expect(page.locator(".wiki-fc-integrate")).toContainText("re-run the fact check");
    await expect(page.locator("#wikiFactcheckAppendBar")).toContainText("Added to article");
  });
});
