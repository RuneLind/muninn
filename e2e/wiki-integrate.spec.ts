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
 * (`DATABASE_URL` at minimum) at the repo root, since `src/index.ts` boots the
 * full process. Bun auto-loads it in the spawned child (cwd = repo root).
 *
 * PLATFORM TOKENS: this spec's muninn must NOT start any Telegram/Slack bot — a second
 * long-poller on the same token 409-fights the running production jarvis
 * (reproduced). `blankBotTokens()` handles it; the reasoning lives in that module.
 * The SHARED `webServer` in `playwright.config.ts` (port 3011) now uses the same
 * helper — it was left leaking by the PR that introduced this spec, and closing
 * that gap is what promoted the helper to `e2e/blank-bot-tokens.ts`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";

const PORT = 3021;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_NAME = "e2e-scratch";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const ORIGINAL_SENTENCE = "The device ships 4M units per year.";
const CORRECTED_SENTENCE = "The device ships 2.1M units per year.";

// The callout-path scratch page: same prose, plus a STALE persisted fact-check
// block. The apply must REPLACE it in place — one block on disk afterwards, never
// two — while the prose edit lands in the same write.
const SENTINEL_START = "<!-- factcheck:start -->";
const SENTINEL_END = "<!-- factcheck:end -->";
const CALLOUT_PAGE_BODY = [
  "---",
  "title: Callout Note",
  "---",
  "",
  "# Callout Note",
  "",
  ORIGINAL_SENTENCE,
  "",
  SENTINEL_START,
  "> [!factcheck] Fact check (2026-01-01)",
  "> **Stale verdict from an older run.**",
  SENTINEL_END,
  "",
].join("\n");

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

// The ANNOTATED path's scratch page — a native `.mdx`, the only extension that
// carries inline `<Fact>` marks (a `.md` page is read raw outside the reader, where
// JSX-ish tags would be literal text). Every new behaviour in this slice is
// .mdx-only, and every OTHER fixture page here is `.md`.
const MDX_WARRANTY = "Every unit ships with a two-year warranty.";
const MDX_PAGE_BODY = [
  "---",
  "title: Mdx Note",
  "---",
  "",
  "# Mdx Note",
  "",
  ORIGINAL_SENTENCE,
  "",
  MDX_WARRANTY,
  "",
  "Unrelated prose that must survive untouched.",
  "",
].join("\n");

/** Two claims: one ❌ (corrected + marked) and one ✅ (marked only). */
const MDX_ANSWER = [
  "One claim is contradicted by the filing; the other holds up.",
  "",
  "### ❌ Claim 1/2 — Ships 4M units",
  "",
  "The filing reports 2.1M units.",
  "",
  "Confidence: 90/100",
  "",
  "Sources: [sec.gov](https://sec.gov/x)",
  "",
  "### ✅ Claim 2/2 — Two-year warranty",
  "",
  "Confirmed by the published warranty terms.",
  "",
  "Confidence: 85/100",
].join("\n");

/** An all-✅ answer on an ANNOTATABLE page — the gate relaxes there (the marks and
 *  the appendix are real output), so the button MUST render. */
const MDX_CLEAN_ANSWER = [
  "Everything checks out.",
  "",
  "### ✅ Claim 1/1 — Two-year warranty",
  "",
  "Confirmed by the published warranty terms.",
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
  /** Phase-1 extraction quotes, keyed by the 1-based claim index. Persisted on the
   *  turn because the `claims` SSE event they arrive on is dropped at `done`; the
   *  propose POST re-sends them, which is what the seed→rehydrate→POST test covers. */
  claimQuotes?: { index: number; quote: string }[];
  /** Server-derived `.mdx`-ness of the checked page — what relaxes the all-✅ gate. */
  annotatable?: boolean;
}

let root: string;
let server: ChildProcess | undefined;
let baseHash: string;
let calloutBaseHash: string;
let mdxBaseHash: string;

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

/** Stub ONLY the propose call (a real model one-shot). Apply hits the real server.
 *  `onBody` observes the intercepted REQUEST — the only place the client's posted
 *  payload (claim quotes included) is visible without a live model call. */
async function stubPropose(page: Page, onBody?: (body: Record<string, unknown>) => void): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/wiki/factcheck/integrate",
    (route) => {
      if (onBody) {
        try {
          onBody(JSON.parse(route.request().postData() || "{}") as Record<string, unknown>);
        } catch {
          onBody({});
        }
      }
      return route.fulfill({
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
          budget: {
            bodyLen: PAGE_BODY.length,
            maxEdits: 12,
            maxEditChars: 2000,
            maxChangedChars: 2000,
            // The real propose route always echoes this on the full path — keep the
            // stub's shape honest so the spec can't pass against a payload the
            // server never produces.
            proposedChangedChars: 23,
          },
          hasSentinelBlock: false,
        }),
      });
    },
  );
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-wiki-"));
  await writeFile(path.join(root, "note.md"), PAGE_BODY, "utf8");
  await writeFile(path.join(root, "callout-note.md"), CALLOUT_PAGE_BODY, "utf8");
  await writeFile(path.join(root, "mdx-note.mdx"), MDX_PAGE_BODY, "utf8");
  await writeFile(path.join(root, "log.md"), "# Log\n", "utf8");
  baseHash = createHash("sha256").update(readFileSync(path.join(root, "note.md"), "utf8")).digest("hex");
  calloutBaseHash = createHash("sha256")
    .update(readFileSync(path.join(root, "callout-note.md"), "utf8"))
    .digest("hex");
  mdxBaseHash = createHash("sha256")
    .update(readFileSync(path.join(root, "mdx-note.mdx"), "utf8"))
    .digest("hex");

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

  test("persisted claim quotes ride the propose POST (seed → localStorage → rehydrate → POST)", async ({
    page,
  }) => {
    // The whole persistence chain in one assertion: the quotes arrive on the
    // transient `claims` SSE event, are lifted onto the turn, survive localStorage
    // + the rehydrate validator, and are re-posted on a click made long after the
    // stream ended. Nothing else re-derives them, so a break anywhere is silent.
    let proposeBody: Record<string, unknown> | null = null;
    await stubPropose(page, (b) => {
      proposeBody = b;
    });
    const quotes = [{ index: 1, quote: "The device ships 4M units per year." }];
    await seedSession(page, [seedTurn({ askedAt: 1_700_000_000_004, claimQuotes: quotes })]);
    await openSeededTurn(page);
    await page.locator("#wikiFactcheckIntegrateBtn").click();
    await expect(page.locator("#wikiFcIntPanel")).toBeVisible();
    await expect
      .poll(() => (proposeBody as { quotes?: unknown } | null)?.quotes)
      .toEqual(quotes);
  });

  test("an all-✅ fact check on a .md page renders no integrate button", async ({ page }) => {
    await seedSession(page, [
      seedTurn({ question: "Clean check", answer: CLEAN_ANSWER, askedAt: 1_700_000_000_001 }),
    ]);
    await openSeededTurn(page);
    // The ➕ append button still renders (any fact check can be annotated) —
    // only the prose-editing action is gated on a correctable claim.
    await expect(page.locator("#wikiFactcheckAppendBtn")).toBeVisible();
    await expect(page.locator("#wikiFactcheckIntegrateBtn")).toHaveCount(0);
  });

  test("an all-✅ fact check on an ANNOTATABLE .mdx page DOES render the button", async ({ page }) => {
    // The relaxation, from the other side: on `.mdx` an all-✅ check still has real
    // output — every confirmed passage gets its inline mark plus the appendix — so
    // the ≥1-❌/⚠️ gate drops to ≥1 parsed claim WITH a verbatim quote to mark.
    await seedSession(page, [
      seedTurn({
        question: "Clean mdx check",
        answer: MDX_CLEAN_ANSWER,
        page: "mdx-note",
        baseHash: mdxBaseHash,
        bodyLen: MDX_PAGE_BODY.length,
        annotatable: true,
        claimQuotes: [{ index: 1, quote: MDX_WARRANTY }],
        askedAt: 1_700_000_000_006,
      }),
    ]);
    await openSeededTurn(page);
    await expect(page.locator("#wikiFactcheckIntegrateBtn")).toBeVisible();
  });

  test("an all-✅ .mdx check with NO claim quotes says why instead of offering the button", async ({
    page,
  }) => {
    // The annotate-only path's anchors ARE the quotes, so a quote-less turn could
    // only ever reach an empty preview — the bar states that instead.
    await seedSession(page, [
      seedTurn({
        question: "Clean mdx check, no quotes",
        answer: MDX_CLEAN_ANSWER,
        page: "mdx-note",
        baseHash: mdxBaseHash,
        bodyLen: MDX_PAGE_BODY.length,
        annotatable: true,
        askedAt: 1_700_000_000_008,
      }),
    ]);
    await openSeededTurn(page);
    await expect(page.locator("#wikiFactcheckIntegrateBtn")).toHaveCount(0);
    await expect(page.locator(".wiki-fc-integrate")).toContainText("nothing to mark");
  });

  test("the ANNOTATED apply writes marks + appendix, and re-running never nests", async ({ page }) => {
    // ACCEPTANCE 3. Everything new in this slice is `.mdx`-only, and the assertion
    // that matters is the ON-DISK BYTES plus the rendered chip↔section pairing —
    // a chip whose `#fc-claim-N` target is missing is a dead affordance.
    const proposal = {
      edits: [
        {
          claimIndex: 1,
          verdict: "❌",
          old: "ships 4M units per year",
          // A CORRECTION carries its mark inside `new` — one write emits both sides.
          new: '<Fact n="1" v="bad">ships 2.1M units per year</Fact>',
          reason: "The filing reports 2.1M units.",
          tier: "exact",
          resolvedText: "ships 4M units per year",
          beforeCtx: "The device ",
          afterCtx: ".",
        },
        {
          claimIndex: 2,
          verdict: "✅",
          old: MDX_WARRANTY,
          // A WRAPPER-ONLY annotation: `new` is exactly the wrapper around
          // `resolvedText`, which is what makes it cost 0 against the budget.
          new: `<Fact n="2" v="ok">${MDX_WARRANTY}</Fact>`,
          reason: "marks the checked passage",
          tier: "exact",
          resolvedText: MDX_WARRANTY,
          beforeCtx: "",
          afterCtx: "",
        },
      ],
      dropped: [],
      budget: {
        bodyLen: MDX_PAGE_BODY.length,
        maxEdits: 20,
        maxEditChars: 2000,
        maxChangedChars: 2000,
        proposedChangedChars: 23,
      },
      hasSentinelBlock: false,
      annotatable: true,
    };
    await page.route(
      (url) => url.pathname === "/api/wiki/factcheck/integrate",
      (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(proposal) }),
    );
    // Observe (never stub) the apply — the real write is what's under test.
    let applyBody: { appendCallout?: boolean; answer?: string } | null = null;
    page.on("request", (req) => {
      if (req.url().includes("/api/wiki/factcheck/integrate/apply") && req.method() === "POST") {
        applyBody = JSON.parse(req.postData() || "{}");
      }
    });

    await seedSession(page, [
      seedTurn({
        question: "Fact check: Mdx Note",
        answer: MDX_ANSWER,
        page: "mdx-note",
        baseHash: mdxBaseHash,
        bodyLen: MDX_PAGE_BODY.length,
        claimCount: 2,
        annotatable: true,
        askedAt: 1_700_000_000_007,
      }),
    ]);
    await openSeededTurn(page);
    await page.locator("#wikiFactcheckIntegrateBtn").click();

    // The panel groups the wrapper-only mark instead of showing a no-op diff card,
    // and the appendix is stated as unavoidable rather than offered as a checkbox.
    const panel = page.locator("#wikiFcIntPanel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("1 passage marked");
    await expect(panel.locator(".wiki-fc-int-anno")).toContainText("Mark 1 checked passage inline");
    await expect(panel.locator(".wiki-fc-int-callout.fixed")).toContainText(
      "fact-check appendix will be added",
    );
    await expect(page.locator("#wikiFcIntCallout")).toHaveCount(0);

    await page.locator("#wikiFcIntAccept").click();

    // The answer rides the apply UNCONDITIONALLY on an annotated write — the
    // checkbox defaults OFF on a clean page and would have shipped dead chips.
    await expect.poll(() => (applyBody as { answer?: string } | null)?.answer).toContain("Claim 1/2");
    expect((applyBody as unknown as { appendCallout?: boolean })!.appendCallout).toBe(true);

    // ── ON-DISK BYTES ──
    await expect
      .poll(() => readFileSync(path.join(root, "mdx-note.mdx"), "utf8"))
      .toContain('<Fact n="1" v="bad">');
    const onDisk = readFileSync(path.join(root, "mdx-note.mdx"), "utf8");
    expect(onDisk).toContain('<Fact n="1" v="bad">ships 2.1M units per year</Fact>');
    expect(onDisk).toContain(`<Fact n="2" v="ok">${MDX_WARRANTY}</Fact>`);
    expect(onDisk).not.toContain(ORIGINAL_SENTENCE);
    expect(onDisk).toContain("Unrelated prose that must survive untouched.");
    // The appendix: component form (NOT the `.md` blockquote), with both claims and
    // this write's own `Was:` line.
    expect(onDisk).toContain('<FactCheck date=');
    expect(onDisk).toContain('ok="1"');
    expect(onDisk).toContain('bad="1"');
    expect(onDisk).not.toContain("> [!factcheck]");
    expect(onDisk).toContain("Was: ships 4M units per year");
    // Severity order — the ❌ claim leads.
    expect(onDisk.indexOf("Claim 1/2")).toBeLessThan(onDisk.indexOf("Claim 2/2"));
    // Nothing nested, one block.
    expect(onDisk).not.toMatch(/<Fact\b[^>]*>(?:(?!<\/Fact>)[\s\S])*?<Fact\b/);
    expect(onDisk.split(SENTINEL_START).length - 1).toBe(1);

    // ── RENDERED HTML: every chip has its section ──
    const article = page.locator("#articleWrap");
    // NB not the whole sentence: the chip is rendered right after the marked span,
    // so the trailing period is no longer contiguous with the corrected text.
    // (The pre-edit text is deliberately still on the page — in the appendix's
    // `Was:` line, which is the whole point of that line.)
    await expect(article).toContainText("ships 2.1M units per year");
    const pairing = await page.evaluate(() => {
      const attrs = (sel: string, attr: string): string[] => {
        const out: string[] = [];
        document.querySelectorAll(sel).forEach((el) => {
          const v = el.getAttribute(attr);
          if (v) out.push(v);
        });
        return out;
      };
      const chips = attrs("#articleWrap [data-fact]", "data-fact");
      const sections = attrs("#articleWrap section[data-claim]", "data-claim");
      return { chips, sections };
    });
    expect(pairing.chips.length).toBeGreaterThan(0);
    for (const n of new Set(pairing.chips)) {
      expect(pairing.sections).toContain(n);
      // The id the client clones into the evidence card must exist, exactly once.
      await expect(page.locator(`#fc-claim-${n}`)).toHaveCount(1);
    }

    // ── RE-RUN: the write is an overlay, so a second apply cannot nest ──
    const rehash = createHash("sha256")
      .update(readFileSync(path.join(root, "mdx-note.mdx"), "utf8"))
      .digest("hex");
    const res = await page.request.post(`${BASE}/api/wiki/factcheck/integrate/apply`, {
      data: {
        wiki: WIKI_NAME,
        page: "mdx-note",
        baseHash: rehash,
        answer: MDX_ANSWER,
        edits: [
          {
            claimIndex: 2,
            verdict: "✅",
            old: MDX_WARRANTY,
            new: `<Fact n="2" v="ok">${MDX_WARRANTY}</Fact>`,
            reason: "marks the checked passage",
          },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const after = readFileSync(path.join(root, "mdx-note.mdx"), "utf8");
    expect(after).not.toMatch(/<Fact\b[^>]*>(?:(?!<\/Fact>)[\s\S])*?<Fact\b/);
    // Claim 1's mark is gone (not in this run's edit set) and claim 2's is intact —
    // exactly ONE of each tag, never a doubled wrapper.
    expect((after.match(/<Fact\b[^>]*>/g) ?? []).length).toBe(1);
    expect(after).toContain(`<Fact n="2" v="ok">${MDX_WARRANTY}</Fact>`);
    // The correction itself survives — the strip removes marks, never prose.
    expect(after).toContain(CORRECTED_SENTENCE);
  });

  test("the callout path: refresh-labelled checkbox, paired apply body, ONE block on disk", async ({
    page,
  }) => {
    // Stub propose for the callout scratch page, reporting a page that ALREADY
    // carries a fact-check block.
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
            dropped: [],
            budget: {
              bodyLen: CALLOUT_PAGE_BODY.length,
              maxEdits: 12,
              maxEditChars: 2000,
              maxChangedChars: 2000,
              proposedChangedChars: 23,
            },
            hasSentinelBlock: true,
          }),
        }),
    );
    // Observe (never stub) the apply request — the real write must still happen.
    let applyBody: { appendCallout?: boolean; answer?: string } | null = null;
    page.on("request", (req) => {
      if (req.url().includes("/api/wiki/factcheck/integrate/apply") && req.method() === "POST") {
        applyBody = JSON.parse(req.postData() || "{}");
      }
    });

    await seedSession(page, [
      seedTurn({
        question: "Fact check: Callout Note",
        page: "callout-note",
        baseHash: calloutBaseHash,
        bodyLen: CALLOUT_PAGE_BODY.length,
        askedAt: 1_700_000_000_003,
      }),
    ]);
    await openSeededTurn(page);
    await page.locator("#wikiFactcheckIntegrateBtn").click();

    // A page that already carries a block ⇒ the checkbox defaults CHECKED and says
    // "refresh", not "add" (which would read as stacking a second block).
    const callout = page.locator("#wikiFcIntCallout");
    await expect(callout).toBeChecked();
    await expect(page.locator(".wiki-fc-int-callout")).toContainText(
      "refresh the existing summary callout",
    );

    await page.locator("#wikiFcIntAccept").click();

    // The apply carried the PAIRED fields — the callout must ride this write, since
    // applying the edits stales the very baseHash a follow-up append would need.
    await expect
      .poll(() => (applyBody as { appendCallout?: boolean } | null)?.appendCallout)
      .toBe(true);
    expect((applyBody as unknown as { answer?: string })!.answer).toContain("Claim 1/1");

    const article = page.locator("#articleWrap");
    await expect(article).toContainText(CORRECTED_SENTENCE);

    // On disk: the corrected prose, EXACTLY ONE sentinel block, and the stale
    // verdict replaced rather than stacked.
    const onDisk = readFileSync(path.join(root, "callout-note.md"), "utf8");
    expect(onDisk).toContain(CORRECTED_SENTENCE);
    expect(onDisk).not.toContain(ORIGINAL_SENTENCE);
    expect(onDisk.split(SENTINEL_START).length - 1).toBe(1);
    expect(onDisk.split(SENTINEL_END).length - 1).toBe(1);
    expect(onDisk).not.toContain("Stale verdict from an older run.");
    expect(onDisk).toContain("The filing reports 2.1M units.");
  });

  test("a propose resolving after a turn switch never paints into the other turn's bar", async ({
    page,
  }) => {
    // The write-action bars are SINGLETON nodes owned by whichever turn is on
    // screen. A ~90s propose that resolves after the reader switched turns must
    // not repaint them: doing so revived turn A's live ✎ button inside turn B's
    // RETIRED bar, where a click fires a doomed one-shot against the wrong page.
    await page.route(
      (url) => url.pathname === "/api/wiki/factcheck/integrate",
      async (route) => {
        await new Promise((r) => setTimeout(r, 1500)); // stand-in for the real one-shot
        await route.fulfill({
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
            dropped: [],
            budget: {
              bodyLen: PAGE_BODY.length,
              maxEdits: 12,
              maxEditChars: 2000,
              maxChangedChars: 2000,
              proposedChangedChars: 23,
            },
            hasSentinelBlock: false,
          }),
        });
      },
    );
    // History renders newest-first (the list walks the array backwards), so the
    // LAST seeded turn is item 0.
    await seedSession(page, [
      seedTurn({ question: "Retired turn", wrote: "append", askedAt: 1_700_000_000_004 }),
      seedTurn({ question: "Correctable turn", askedAt: 1_700_000_000_005 }),
    ]);
    await page.locator('.wiki-conn-tab[data-conntab="ask"]').click();
    const items = page.locator(".wiki-ask-hist-item");

    await items.nth(0).click(); // the correctable turn
    const live = page.locator("#wikiFactcheckIntegrateBtn");
    await expect(live).toBeVisible();
    await live.click();
    await expect(live).toBeDisabled(); // "Proposing edits…"

    // Switch to the already-appended turn while the propose is still in flight.
    await items.nth(1).click();
    const retired = page.locator(".wiki-fc-int-open");
    await expect(retired).toBeDisabled();

    // Let the propose land. Its success path AND its `finally` both refresh the
    // bars — for the OTHER turn, so nothing here may change.
    await page.waitForTimeout(2500);
    await expect(page.locator("#wikiFactcheckIntegrateBtn")).toHaveCount(0);
    await expect(retired).toBeDisabled();
    await expect(page.locator(".wiki-fc-integrate")).toContainText("re-run the fact check");
    // The preview panel is turn-keyed too — it must not paint under this turn.
    await expect(page.locator("#wikiFcIntPanel")).toHaveCount(0);
    // …and the retired turn's ➕ bar keeps its own derived state.
    await expect(page.locator("#wikiFactcheckAppendBar")).toContainText("Added to article");
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
