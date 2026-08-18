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
 *      the first returned — and so must the one after a ▼ DELETED the file.
 *   3. **Rapid clicks all land, in order, without losing the keyboard.** The
 *      queue's write chain is only real if a second click can arrive while the
 *      first is in flight; with the ▲▼ disabled meanwhile it could not, and the
 *      focused button was destroyed on every write. Both are asserted here,
 *      against a deliberately slowed endpoint.
 *   4. **A real 409 is surfaced, not swallowed — and not wiped.** Both files are
 *      edited behind the page's back; the board must say "changed on disk —
 *      reload", must not let the next click destroy that message, and must
 *      recover through its own Reload rather than overwriting.
 *   5. **A retired plan is a stale board, not a dead end.** mimir retires and
 *      renames plans constantly; the 404 that produces offers Reload.
 *   6. **A readonly instance renders the refusal**, states it ONCE, and folds
 *      the refused click into the draft rather than losing it.
 *   7. **An unreadable `queue.yaml` is its own mode** — banner, ranking off,
 *      priorities still writing, and only the priority half of the draft
 *      retired.
 *
 * No model calls, no claude-usage (pointed at a dead port on purpose, so the
 * board is deterministic and money-free), and no contact with the real mimir
 * checkout — every instance registers a mkdtemp wiki under the name the board
 * reads (`mimir`).
 *
 * **Fixtures are reset per test** (`beforeEach`, on the writable instance only):
 * these tests write real files, and an ordering dependency between them is a
 * failure that only reproduces in the order Playwright happened to pick.
 *
 * ENV PREREQUISITE / PLATFORM TOKENS: as `wiki-refresh.spec.ts` — a working
 * `.env` at the repo root plus `blankBotTokens()`, so no instance opens a
 * second Telegram long-poller against the production bot's token.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";
import { PLAN_READONLY_ENV } from "../src/plans/board-writes.ts";

// Ports are a shared resource across e2e FILES (Playwright runs them in
// parallel): 3021–3029 are claimed by the wiki/summaries specs, and this file
// booting on 3027/3028 raced `wiki-share`/`summaries-share` into a bind failure
// that surfaced as a 40s "muninn did not start" timeout.
const PORT = 3041;
const RO_PORT = 3042;
const NOQ_PORT = 3043;
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const NOQ_BASE = `http://127.0.0.1:${NOQ_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The wiki NAME the board reads — `PLANS_WIKI_NAME`. Registering the temp dir
 *  under it is what keeps this test away from the real checkout. */
const WIKI = "mimir";

const SLUGS = ["alpha-plan", "beta-plan", "gamma-plan"];
/** A fourth plan, in ANOTHER column: the only way to produce the client-side
 *  prune warning, which is about a slug `queue.yaml` ranks whose plan has moved. */
const READY_SLUG = "delta-plan";

function planFile(slug: string, extra = "", status = "proposed"): string {
  return `---\ntitle: ${slug}\nplan_status: ${status}\nstatus_date: 2026-08-01\n${extra}---\n\n# ${slug}\n\nBody.\n`;
}

async function writeFixtures(root: string, over: Record<string, string> = {}): Promise<void> {
  await mkdir(path.join(root, "plans"), { recursive: true });
  for (const slug of SLUGS) {
    await writeFile(path.join(root, "plans", `${slug}.mdx`), over[slug] ?? planFile(slug), "utf8");
  }
  await writeFile(
    path.join(root, "plans", `${READY_SLUG}.mdx`),
    over[READY_SLUG] ?? planFile(READY_SLUG, "", "ready"),
    "utf8",
  );
}

async function makeWiki(prefix: string, over: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFixtures(root, over);
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
let noqServer: ChildProcess | undefined;
let root = "";
let roRoot = "";
let noqRoot = "";

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

const nudgeBtn = (page: Page, slug: string, dir: "up" | "down") =>
  page.locator(`.pb-cardwrap[data-slug="${slug}"] .pb-nudge button[data-dir="${dir}"]`);

/** Which ▲/▼ (if any) holds the keyboard right now. */
function focusedNudge(page: Page): Promise<{ slug: string | null; dir: string | null } | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.dataset || !el.dataset.dir) return null;
    return { slug: el.dataset.slug ?? null, dir: el.dataset.dir ?? null };
  });
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-plans-"));
  await writeFixtures(root);
  // The readonly instance gets a fixture that is already edited: a priority in
  // the frontmatter and a ranked column, so BOTH controls have something to be
  // disabled over.
  roRoot = await makeWiki("muninn-e2e-plans-ro-", { "alpha-plan": planFile("alpha-plan", "priority: p1\n") });
  await writeFile(path.join(roRoot, "plans", "queue.yaml"), "proposed:\n  - alpha-plan\n", "utf8");
  // The third mode: `queue.yaml` EXISTS and cannot be read. A directory in its
  // place is the deterministic way to say that — `Bun.file().text()` throws
  // EISDIR, which is exactly the `hash: null` the source reports for a file it
  // could not read (a permission bit is not portable under CI's uid).
  noqRoot = await makeWiki("muninn-e2e-plans-noq-");
  await mkdir(path.join(noqRoot, "plans", "queue.yaml"), { recursive: true });

  server = boot(PORT, root);
  roServer = boot(RO_PORT, roRoot, { [PLAN_READONLY_ENV]: "1" });
  noqServer = boot(NOQ_PORT, noqRoot);
  await Promise.all([waitUp(BASE), waitUp(RO_BASE), waitUp(NOQ_BASE)]);
});

/** Only the WRITABLE instance's corpus is reset — the other two are never
 *  written to, and re-creating their fixtures would not be a reset anyway
 *  (the unreadable-queue directory is part of the boot state). */
test.beforeEach(async () => {
  await rm(path.join(root, "plans", "queue.yaml"), { force: true, recursive: true });
  await writeFixtures(root);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  noqServer?.kill("SIGTERM");
  for (const dir of [root, roRoot, noqRoot]) if (dir) await rm(dir, { recursive: true, force: true });
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

  test("a 200 that wrote NOTHING is adopted as-is, not as the click", async ({ page }) => {
    // `written: false` is an honest noop (the same value already set, a clear on
    // a plan carrying none) and it echoes what is ON DISK. The board must render
    // the response, never the request — stubbed, because the route only produces
    // this shape for a state the UI's own toggle avoids.
    await page.route("**/api/plans/priority", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slug: "alpha-plan",
          priority: null,
          hash: "unchanged-hash",
          written: false,
          relPath: "plans/alpha-plan.mdx",
        }),
      }),
    );
    await page.goto(`${BASE}/plans`);
    await openCard(page, "alpha-plan");
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p2"]').click();

    await expect(page.locator(".pb-drawer .pb-priset button[data-key='pri-p2']")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator(".pb-drawer .pb-wmsg")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator('.pb-cardwrap[data-slug="alpha-plan"] .pb-pri')).toHaveText("—");
  });

  test("two nudges bootstrap plans/queue.yaml, update it, and bootstrap again after a delete", async ({
    page,
  }) => {
    await page.goto(`${BASE}/plans`);
    // The bootstrap precondition, stated: the first write below goes out with
    // `baseHash: ""`, which the writer accepts ONLY against an absent file.
    expect(await queueText(root)).toBeNull();

    // ▲ on an unranked card RANKS it — the first write, against the `""` base
    // that means "the file does not exist yet".
    await nudgeBtn(page, "beta-plan", "up").click();
    await expect(page.locator('.pb-cardwrap[data-slug="beta-plan"] .pb-rank')).toHaveText("#1");
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - beta-plan\n");

    await nudgeBtn(page, "gamma-plan", "up").click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - beta-plan\n  - gamma-plan\n");

    // ▲ again on the second one swaps the pair — a write off the hash the
    // previous response carried.
    await nudgeBtn(page, "gamma-plan", "up").click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - gamma-plan\n  - beta-plan\n");
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-rank')).toHaveText("#1");
    await expect(page.locator("#pbNotice .pb-wmsg")).toBeHidden();

    // ▼ off the bottom un-ranks — the write that DELETES the file.
    await nudgeBtn(page, "beta-plan", "down").click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - gamma-plan\n");
    await nudgeBtn(page, "gamma-plan", "down").click();
    await expect.poll(() => queueText(root)).toBeNull();

    // The delete answered `hash: ""` — the bootstrap base again. Without
    // adopting it, the next nudge would post a hash naming a file that is gone.
    await nudgeBtn(page, "alpha-plan", "up").click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - alpha-plan\n");
    await expect(page.locator("#pbNotice .pb-wmsg")).toBeHidden();
  });

  test("five rapid nudges all land, in order, and the keyboard stays on the button", async ({
    page,
  }) => {
    // The endpoint is SLOWED so the clicks really do overlap: the whole point of
    // the write chain is a second move computed from the order the first one
    // landed.
    //
    // **The FOCUS assertion is the one that catches the old disable**, and the
    // ordering assertion is a regression guard rather than the proof: Playwright
    // waits for a disabled button to re-enable before clicking, so it recovers
    // clicks a human loses (measured against the pre-fix client: the file came
    // out in the right order, and focus came back `null` — dropped to `<body>`,
    // because the disabled button could not take it and `restoreNudgeFocus` fell
    // through). Real rapid clicking eats them outright; that is the browser
    // probe's leg, not one Playwright can express.
    await page.route("**/api/plans/order", async (route) => {
      await new Promise((r) => setTimeout(r, 250));
      await route.continue();
    });
    await page.goto(`${BASE}/plans`);

    await nudgeBtn(page, "alpha-plan", "up").click();
    await nudgeBtn(page, "beta-plan", "up").click();
    await nudgeBtn(page, "gamma-plan", "up").click();
    await nudgeBtn(page, "gamma-plan", "up").click();
    await nudgeBtn(page, "gamma-plan", "up").click();

    // All five, in the order they were pressed: rank three, then walk gamma to
    // the top past both of them.
    await expect
      .poll(() => queueText(root), { timeout: 20_000 })
      .toBe("proposed:\n  - gamma-plan\n  - alpha-plan\n  - beta-plan\n");
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-rank')).toHaveText("#1");

    // gamma is at #1 now, so ITS ▲ is spent; the same-card ▼ is where focus
    // belongs. What must never happen is focus on <body>.
    await expect.poll(() => focusedNudge(page)).toEqual({ slug: "gamma-plan", dir: "down" });

    // And a move whose own button survives keeps the button itself: ▼ on the
    // first of three ranked cards leaves that ▼ live.
    await nudgeBtn(page, "gamma-plan", "down").click();
    await expect
      .poll(() => queueText(root), { timeout: 20_000 })
      .toBe("proposed:\n  - alpha-plan\n  - gamma-plan\n  - beta-plan\n");
    await expect.poll(() => focusedNudge(page)).toEqual({ slug: "gamma-plan", dir: "down" });
  });

  test("a plan edited behind the board's back 409s, disables that card, and recovers on Reload", async ({
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

    // The card's hash is proven dead, so its buttons stop offering a click that
    // could only 409 again.
    await expect(page.locator('.pb-drawer .pb-priset button[data-key="pri-p1"]')).toBeDisabled();

    await msg.locator("button.pb-reload").click();
    await expect(page.locator(".pb-drawer .pb-wmsg")).toHaveCount(0);

    // Fresh hash adopted — the same click now lands.
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p2"]').click();
    await expect.poll(() => planText(root, "beta-plan")).toContain("priority: p2");
  });

  test("a queue.yaml edited behind the board's back 409s, and the next click cannot wipe the Reload", async ({
    page,
  }) => {
    await writeFile(path.join(root, "plans", "queue.yaml"), "ready:\n  - delta-plan\n", "utf8");
    await page.goto(`${BASE}/plans`);
    // The board loaded with THAT file's hash; now it changes again.
    await writeFile(path.join(root, "plans", "queue.yaml"), "proposed:\n  - alpha-plan\n", "utf8");

    await nudgeBtn(page, "gamma-plan", "up").click();
    const msg = page.locator("#pbNotice .pb-wmsg");
    await expect(msg).toContainText("the queue changed on disk — reload");
    expect(await queueText(root)).toBe("proposed:\n  - alpha-plan\n");

    // The measured bug: a nudge while that message stood nulled it at QUEUE
    // time, so the Reload button vanished mid-flight and the doomed request went
    // out anyway. The nudges are disabled while it stands, and the message and
    // its button survive.
    await expect(nudgeBtn(page, "beta-plan", "up")).toBeDisabled();
    await expect(nudgeBtn(page, "beta-plan", "up")).toHaveAttribute("title", /out of date/);
    await expect(msg.locator("button.pb-reload")).toHaveCount(1);
    expect(await queueText(root)).toBe("proposed:\n  - alpha-plan\n");

    await msg.locator("button.pb-reload").click();
    await expect(page.locator("#pbNotice .pb-wmsg")).toBeHidden();
    await nudgeBtn(page, "gamma-plan", "up").click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - alpha-plan\n  - gamma-plan\n");
  });

  test("a plan retired behind the board's back offers Reload, not a dead end", async ({ page }) => {
    await page.goto(`${BASE}/plans`);
    await openCard(page, "gamma-plan");

    // mimir's everyday lifecycle: the plan was renamed or archived upstream
    // while this tab was open. The route answers 404 `no plan named …`.
    await rm(path.join(root, "plans", "gamma-plan.mdx"), { force: true });

    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p1"]').click();
    const msg = page.locator(".pb-drawer .pb-wmsg");
    await expect(msg).toContainText('no plan named "gamma-plan"');
    await expect(msg.locator("button.pb-reload")).toHaveCount(1);

    await msg.locator("button.pb-reload").click();
    // The refreshed board simply does not have the card any more, and the
    // drawer showing it closes rather than editing a plan that is gone.
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"]')).toHaveCount(0);
    await expect(page.locator(".pb-drawer")).toHaveCount(0);
  });

  test("a 422 says what the wiki refused, verbatim, and offers no Reload", async ({ page }) => {
    // The one status that means a human must go and fix a file by hand: a
    // refetch would answer with the same broken file.
    await page.route("**/api/plans/order", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "plans/queue.yaml: unparseable YAML at line 3" }),
      }),
    );
    await page.goto(`${BASE}/plans`);
    await nudgeBtn(page, "beta-plan", "up").click();

    const msg = page.locator("#pbNotice .pb-wmsg");
    await expect(msg).toContainText("plans/queue.yaml: unparseable YAML at line 3");
    await expect(msg.locator("button.pb-reload")).toHaveCount(0);
  });

  test("everything a write dropped is listed — the server's drops and the board's own", async ({
    page,
  }) => {
    // `ghost-plan` names no plan at all (the file's documented read-time GC, a
    // SERVER warning); `delta-plan` is a real plan that has moved to another
    // column, which only the CLIENT can see — every slug it posts is a slug the
    // server knows, so the server cannot warn about that one.
    await writeFile(
      path.join(root, "plans", "queue.yaml"),
      "proposed:\n  - ghost-plan\n  - delta-plan\n  - alpha-plan\n",
      "utf8",
    );
    await page.goto(`${BASE}/plans`);
    await nudgeBtn(page, "beta-plan", "up").click();
    await expect.poll(() => queueText(root)).toBe("proposed:\n  - alpha-plan\n  - beta-plan\n");

    const dropped = page.locator("#pbNotice details.pb-banner");
    await expect(dropped).toContainText("the write dropped");
    await dropped.locator("summary").click();
    await expect(dropped).toContainText("delta-plan");
    await expect(dropped).toContainText("ghost-plan");
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
    await expect(page.locator("#pbNotice .pb-banner-warn")).toHaveCount(0);

    await openCard(page, "gamma-plan");
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p1"]').click();

    // The banner is for the FLIP — the payload said writable, the instance does
    // not — and the masthead's write-mode sentence is re-stated with it.
    await expect(page.locator("#pbNotice")).toContainText(`${PLAN_READONLY_ENV}=1`);
    await expect(page.locator("#pbMode")).toContainText("Nothing is written back on this host");
    // The whole board is in draft mode now, not just the control that 403'd:
    // the drawer's own basis line is the one that says which mode it is in.
    await expect(page.locator(".pb-drawer")).toContainText("this instance cannot write the wiki");
    expect(await planText(root, "gamma-plan")).not.toContain("priority:");

    // …and the click that DISCOVERED the refusal is not lost: it lands in the
    // draft, where a readonly board's edits belong. It used to take a second
    // click to draft anything.
    await expect(page.locator('.pb-drawer .pb-priset button[data-key="pri-p1"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-pri')).toHaveText("p1");
    await expect(page.locator("#pbDraft")).toHaveClass(/pb-visible/);
  });

  test("the localStorage draft is retired per AXIS, not all-or-nothing", async ({ page }) => {
    const DRAFT = JSON.stringify({
      priority: { "gamma-plan": "p3" },
      order: { proposed: ["gamma-plan"] },
    });
    const read = () => page.evaluate(() => localStorage.getItem("muninn.planboard.draft.v1"));

    await page.goto(`${BASE}/plans`);
    await page.evaluate((d) => localStorage.setItem("muninn.planboard.draft.v1", d), DRAFT);
    await page.reload();
    // Both axes are the server's here — gone, and not re-created empty by the
    // board's own stale-column purge.
    expect(await read()).toBeNull();
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-pri')).toHaveText("—");
    await expect(page.locator("#pbDraft")).not.toHaveClass(/pb-visible/);

    // The readonly instance is the one place the draft is still the only thing
    // a reader has, so both halves survive and still render.
    await page.goto(`${RO_BASE}/plans`);
    await page.evaluate((d) => localStorage.setItem("muninn.planboard.draft.v1", d), DRAFT);
    await page.reload();
    expect(await read()).not.toBeNull();
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-pri')).toHaveText("p3");

    // The split: with only the QUEUE unwritable, the priority half is the
    // server's and must go, while the order half is the only ranking there is.
    // Keeping both is how a stale draft priority shadowed a server-owned axis.
    await page.goto(`${NOQ_BASE}/plans`);
    await page.evaluate((d) => localStorage.setItem("muninn.planboard.draft.v1", d), DRAFT);
    await page.reload();
    await expect(page.locator('.pb-cardwrap[data-slug="gamma-plan"] .pb-pri')).toHaveText("—");
    const note = page.locator("#pbDraft");
    await expect(note).toHaveClass(/pb-visible/);
    await expect(note).toContainText("hand order");
    await expect(note).not.toContainText("priority draft");
    // …and the reason names the axis it kept, not the one it retired.
    await expect(note).toContainText("plans/queue.yaml could not be read");
  });

  test("an unreadable queue.yaml turns ranking off, says so, and still writes priorities", async ({
    page,
  }) => {
    await page.goto(`${NOQ_BASE}/plans`);
    await expect(page.locator("#pbNotice")).toContainText("plans/queue.yaml exists but could not be read");
    await expect(page.locator("#pbMode")).toContainText("Ranking is off");

    const up = nudgeBtn(page, "beta-plan", "up");
    await expect(up).toBeVisible();
    await expect(up).toBeDisabled();
    await expect(up).toHaveAttribute("title", /could not be read/);

    // The priority axis is untouched by any of that — it writes a different file.
    await openCard(page, "beta-plan");
    await page.locator('.pb-drawer .pb-priset button[data-key="pri-p2"]').click();
    await expect.poll(() => planText(noqRoot, "beta-plan")).toContain("priority: p2");
    await expect(page.locator(".pb-drawer .pb-wmsg")).toHaveCount(0);
  });

  test("a wiki-readonly instance states the refusal ONCE and disables the controls", async ({
    page,
  }) => {
    await page.goto(`${RO_BASE}/plans`);
    // The masthead states it (server-rendered, so a no-JavaScript reader gets
    // it too); the client banner is for a mid-session FLIP only. Both used to
    // render, putting the identical sentence on screen twice.
    await expect(page.locator("#pbMode")).toContainText(`${PLAN_READONLY_ENV}=1`);
    await expect(page.locator("#pbNotice .pb-banner-warn")).toHaveCount(0);

    // The ▲▼ over a column queue.yaml ranks are present and disabled — the
    // reason lives in the tooltip, not in an element that vanished.
    const up = nudgeBtn(page, "alpha-plan", "up");
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
