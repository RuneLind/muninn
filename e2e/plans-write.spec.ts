/**
 * `/plans` — the board's two writes, end to end.
 *
 * What only a real page can prove, and what each test is here for:
 *
 *   1. **A click reaches mimir.** The priority button POSTs, the plan FILE on
 *      disk gains `priority:`, and the card repaints — three layers that a
 *      route test and a pure test each see only one of.
 *   2. **The second edit works.** The board captured its CAS base at render, so
 *      a client that does not adopt the hash the 200 answered with 409s on the
 *      very next click. Same for the queue: the first nudge BOOTSTRAPS
 *      `plans/queue.yaml` from the `""` base, the second must go off the hash
 *      the first returned.
 *   3. **A real 409 is surfaced, not swallowed.** Both files are edited behind
 *      the page's back, and the board must say "changed on disk — reload" and
 *      recover through its own Reload rather than overwriting.
 *   4. **A readonly instance renders the refusal.** Second muninn, same
 *      fixtures, `MUNINN_WIKI_READONLY=1`: one banner naming the flag, and the
 *      controls DISABLED rather than absent.
 *
 * No model calls, no claude-usage (pointed at a dead port on purpose, so the
 * board is deterministic and money-free), and no contact with the real mimir
 * checkout — both instances register a mkdtemp wiki under the name the board
 * reads (`mimir`).
 *
 * ENV PREREQUISITE / PLATFORM TOKENS: as `wiki-refresh.spec.ts` — a working
 * `.env` at the repo root plus `blankBotTokens()`, so neither instance opens a
 * second Telegram long-poller against the production bot's token.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";
import { PLAN_READONLY_ENV } from "../src/plans/board-writes.ts";

const PORT = 3027;
const RO_PORT = 3028;
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The wiki NAME the board reads — `PLANS_WIKI_NAME`. Registering the temp dir
 *  under it is what keeps this test away from the real checkout. */
const WIKI = "mimir";

const SLUGS = ["alpha-plan", "beta-plan", "gamma-plan"];

function planFile(slug: string, extra = ""): string {
  return `---\ntitle: ${slug}\nplan_status: proposed\nstatus_date: 2026-08-01\n${extra}---\n\n# ${slug}\n\nBody.\n`;
}

async function makeWiki(prefix: string, over: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, "plans"), { recursive: true });
  for (const slug of SLUGS) {
    await writeFile(path.join(root, "plans", `${slug}.mdx`), over[slug] ?? planFile(slug), "utf8");
  }
  return root;
}

function boot(port: number, root: string, env: Record<string, string> = {}): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankBotTokens(),
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
      // A dead ledger: the board renders every column and no money, which is the
      // state these assertions are written against.
      CLAUDE_USAGE_URL: "http://127.0.0.1:8799",
      // `SYNC_REPOS` from the developer's own .env names the REAL mimir; its
      // `wiki` entry is dropped (it matches no registered root here) and the loop
      // only ever runs on an explicit POST, but the empty value says so outright.
      SYNC_REPOS: "",
      ...env,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/plans/board`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let root = "";
let roRoot = "";

const planText = (dir: string, slug: string) =>
  readFile(path.join(dir, "plans", `${slug}.mdx`), "utf8");
const queueText = (dir: string) =>
  readFile(path.join(dir, "plans", "queue.yaml"), "utf8").catch(() => null);

/** Open a card's drawer. The board is a modal-drawer UI; every priority edit
 *  happens in there. */
async function openCard(page: Page, slug: string): Promise<void> {
  await page.locator(`.pb-card[data-slug="${slug}"]`).click();
  await expect(page.locator(".pb-drawer")).toBeVisible();
}

test.beforeAll(async () => {
  root = await makeWiki("muninn-e2e-plans-");
  // The readonly instance gets a fixture that is already edited: a priority in
  // the frontmatter and a ranked column, so BOTH controls have something to be
  // disabled over.
  roRoot = await makeWiki("muninn-e2e-plans-ro-", { "alpha-plan": planFile("alpha-plan", "priority: p1\n") });
  await writeFile(path.join(roRoot, "plans", "queue.yaml"), "proposed:\n  - alpha-plan\n", "utf8");

  server = boot(PORT, root);
  roServer = boot(RO_PORT, roRoot, { [PLAN_READONLY_ENV]: "1" });
  await Promise.all([waitUp(BASE), waitUp(RO_BASE)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  for (const dir of [root, roRoot]) if (dir) await rm(dir, { recursive: true, force: true });
});

test.describe("Plan board: writing back to mimir", () => {
  test("a priority click writes the plan file, and the next click works off the returned hash", async ({
    page,
  }) => {
    await page.goto(`${BASE}/plans`);
    await openCard(page, "alpha-plan");

    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p1"]').click();
    await expect(page.locator(".pb-drawer .pb-priset button[data-key='pri-p1']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(() => planText(root, "alpha-plan")).toContain("priority: p1");

    // The second edit is the one that catches a client holding the render-time
    // hash: it can only succeed against the hash the first 200 answered with.
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p0"]').click();
    await expect.poll(() => planText(root, "alpha-plan")).toContain("priority: p0");
    await expect(page.locator(".pb-drawer .pb-wmsg")).toHaveCount(0);

    // …and clicking the level that is now on disk CLEARS it.
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p0"]').click();
    await expect.poll(() => planText(root, "alpha-plan")).not.toContain("priority:");

    // Back on the board, the card repainted from the write — no reload.
    await page.keyboard.press("Escape");
    await expect(page.locator('.pb-cardwrap[data-slug="alpha-plan"] .pb-pri')).toHaveText("—");
  });

  test("two nudges bootstrap plans/queue.yaml and then update it", async ({ page }) => {
    await rm(path.join(root, "plans", "queue.yaml"), { force: true });
    await page.goto(`${BASE}/plans`);
    // The bootstrap precondition, stated: the first write below goes out with
    // `baseHash: ""`, which the writer accepts ONLY against an absent file.
    expect(await queueText(root)).toBeNull();

    // ▲ on an unranked card RANKS it — the first write, against the `""` base
    // that means "the file does not exist yet".
    await page.locator('.pb-cardwrap[data-slug="beta-plan"] .pb-nudge button[data-dir="up"]').click();
    await expect(page.locator('.pb-cardwrap[data-slug="beta-plan"] .pb-rank')).toHaveText("#1");
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - beta-plan\n");

    await page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-nudge button[data-dir="up"]').click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - beta-plan\n  - gamma-plan\n");

    // ▲ again on the second one swaps the pair — a write off the hash the
    // previous response carried.
    await page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-nudge button[data-dir="up"]').click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - gamma-plan\n  - beta-plan\n");
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-rank')).toHaveText("#1");
    await expect(page.locator("#pbNotice .pb-wmsg")).toHaveCount(0);

    // ▼ off the bottom un-ranks — the write that DELETES the file.
    await page.locator('.pb-cardwrap[data-slug="beta-plan"] .pb-nudge button[data-dir="down"]').click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - gamma-plan\n");
    await page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-nudge button[data-dir="down"]').click();
    await expect.poll(() => queueText(root)).toBeNull();
  });

  test("a plan edited behind the board's back 409s, says so, and recovers on Reload", async ({
    page,
  }) => {
    await page.goto(`${BASE}/plans`);
    await openCard(page, "beta-plan");

    // Somebody else (mimir's own lifecycle script, the other machine, a hand
    // edit) rewrites the file the drawer is holding a hash for.
    await writeFile(
      path.join(root, "plans", "beta-plan.mdx"),
      planFile("beta-plan", "status_note: touched by hand\n"),
      "utf8",
    );

    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p2"]').click();
    const msg = page.locator(".pb-drawer .pb-wmsg");
    await expect(msg).toContainText("this plan changed on disk — reload");
    // Nothing was overwritten: the hand edit is still there and no priority landed.
    const afterRefusal = await planText(root, "beta-plan");
    expect(afterRefusal).toContain("status_note: touched by hand");
    expect(afterRefusal).not.toContain("priority:");

    await msg.locator("button.pb-reload").click();
    await expect(page.locator(".pb-drawer .pb-wmsg")).toHaveCount(0);

    // Fresh hash adopted — the same click now lands.
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p2"]').click();
    await expect.poll(() => planText(root, "beta-plan")).toContain("priority: p2");
  });

  test("a queue.yaml edited behind the board's back 409s on the next nudge", async ({ page }) => {
    await writeFile(path.join(root, "plans", "queue.yaml"), "ready:\n  - alpha-plan\n", "utf8");
    await page.goto(`${BASE}/plans`);
    // The board loaded with THAT file's hash; now it changes again.
    await writeFile(path.join(root, "plans", "queue.yaml"), "proposed:\n  - alpha-plan\n", "utf8");

    await page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-nudge button[data-dir="up"]').click();
    const msg = page.locator("#pbNotice .pb-wmsg");
    await expect(msg).toContainText("the queue changed on disk — reload");
    expect(await queueText(root)).toBe("proposed:\n  - alpha-plan\n");

    await msg.locator("button.pb-reload").click();
    await expect(page.locator("#pbNotice .pb-wmsg")).toHaveCount(0);
    await page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-nudge button[data-dir="up"]').click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - alpha-plan\n  - gamma-plan\n");
    await rm(path.join(root, "plans", "queue.yaml"), { force: true });
  });

  test("a 403 mid-session flips the whole board into the readonly rendering", async ({ page }) => {
    // The one leg the fixtures cannot produce: an instance that was writable at
    // render and refuses at click time (the flag flipped, or the reader is on a
    // tab opened before a restart). Stubbed at the network boundary ONLY —
    // everything the assertion reads is the real client's own reaction.
    await page.route("**/api/plans/priority", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "wiki-readonly", readonly: true }),
      }),
    );
    await page.goto(`${BASE}/plans`);
    await expect(page.locator("#pbNotice")).toBeEmpty();

    await openCard(page, "gamma-plan");
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p1"]').click();

    await expect(page.locator("#pbNotice")).toContainText(`${PLAN_READONLY_ENV}=1`);
    // The whole board is in draft mode now, not just the control that 403'd:
    // the drawer's own basis line is the one that says which mode it is in.
    await expect(page.locator(".pb-drawer")).toContainText("this instance cannot write the wiki");
    expect(await planText(root, "gamma-plan")).not.toContain("priority:");
  });

  test("the localStorage draft is retired where the server writes, and kept where it does not", async ({
    page,
  }) => {
    const DRAFT = JSON.stringify({
      priority: { "gamma-plan": "p3" },
      order: { proposed: ["gamma-plan"] },
    });
    const read = () => page.evaluate(() => localStorage.getItem("muninn.planboard.draft.v1"));

    await page.goto(`${BASE}/plans`);
    await page.evaluate((d) => localStorage.setItem("muninn.planboard.draft.v1", d), DRAFT);
    await page.reload();
    // Gone, and not re-created empty by the board's own stale-column purge.
    expect(await read()).toBeNull();
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-pri')).toHaveText("—");
    await expect(page.locator("#pbDraft")).not.toHaveClass(/pb-visible/);

    // The readonly instance is the one place the draft is still the only thing
    // a reader has, so it survives and still renders.
    await page.goto(`${RO_BASE}/plans`);
    await page.evaluate((d) => localStorage.setItem("muninn.planboard.draft.v1", d), DRAFT);
    await page.reload();
    expect(await read()).not.toBeNull();
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-pri')).toHaveText("p3");
  });

  test("a wiki-readonly instance renders one banner and disables the controls, never hides them", async ({
    page,
  }) => {
    await page.goto(`${RO_BASE}/plans`);
    await expect(page.locator("#pbNotice")).toContainText(`${PLAN_READONLY_ENV}=1`);

    // The ▲▼ over a column queue.yaml ranks are present and disabled — the
    // reason lives in the tooltip, not in an element that vanished.
    const up = page.locator('.pb-cardwrap[data-slug="alpha-plan"] .pb-nudge button[data-dir="up"]');
    await expect(up).toBeVisible();
    await expect(up).toBeDisabled();
    await expect(up).toHaveAttribute("title", new RegExp(PLAN_READONLY_ENV));

    await openCard(page, "alpha-plan");
    const p2 = page.locator('.pb-drawer .pb-priset button[data-key="pri-p2"]');
    await expect(p2).toBeVisible();
    await expect(p2).toBeDisabled();
    await expect(p2).toHaveAttribute("title", new RegExp(PLAN_READONLY_ENV));

    // And the instance really is refusing: the endpoint answers 403 with the flag.
    const res = await page.request.post(`${RO_BASE}/api/plans/priority`, {
      data: { slug: "alpha-plan", priority: "p3", baseHash: "whatever" },
    });
    expect(res.status()).toBe(403);
    expect(await planText(roRoot, "alpha-plan")).toContain("priority: p1");
  });
});
