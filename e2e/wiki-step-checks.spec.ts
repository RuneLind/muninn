/**
 * The owner-step check chips (mimir plan muninn-wiki-owner-step-checks, PR 2).
 * The probes are unit-tested (`src/wiki/step-checks/`), the route against a
 * temp wiki (`wiki-step-checks.test.ts`) and the chip's DOM half in happy-dom
 * (`wiki-step-checks-dom.test.ts`); what only the real reader and a real
 * muninn can show:
 *
 *  1. A step whose `env` key is in no `.env` reads «not yet»; one whose
 *     migration the e2e database has applied reads «checked»; one whose
 *     migration does not exist reads «not yet»; a step that names `restart`
 *     (which muninn cannot prove yet) reads «unknown» although its migration
 *     holds; a step with no tag gets none.
 *  2. The chip sits in the reader-only slot: the Done button's accessible name
 *     is the step's text alone, and Done still removes a chipped row, after
 *     which the page's chips come back for the steps left.
 *  3. With the route's answer shaped by `page.route`: a chip landing late never
 *     moves Done (its box at 1280 and 375 px, tight, loose and short rows, and
 *     the chip after Done whichever answer comes first); a two-machine step
 *     with one machine unknown is not drawn as checked; a wrong hash, a 500, a
 *     malformed body and an answer released after the reader moved on draw
 *     nothing; copying a chipped row copies what it copies with no chip; the
 *     chip is named in words, describes its reasons and is reached by Tab.
 *
 * One muninn on its own port (Done's scope needs WORK_MAP_WIKIS and
 * WIKI_ANSWER_WIKIS; the migration probe reads the test database), a temp git
 * wiki. Made-up fixtures. The server runs from the repo root, so the env probe
 * reads that `.env`'s key NAMES; a CI runner has none, which reads «not yet»
 * as well. ENV PREREQUISITE: `bun run db:setup:test` (it baselines every
 * migration, so 086 is applied).
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { token } from "./contrast.ts";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-step-checks");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-step-checks";
const REL = "plans/e2e-checks.mdx";
const KEY = "E2E_STEP_CHECK_KEY_NOBODY_SETS";

const PAGE = [
  "---\ntitle: Check fixture\n---\n",
  "<NextMoves>\n",
  '<Lane kind="you">\n',
  `1. Add the key. <Check env="${KEY}" />`,
  '2. Apply the old migration. <Check migration="086" />',
  '3. Apply the missing migration. <Check migration="999" />',
  "4. Water the plants.",
  '5. Restart muninn. <Check migration="086" restart="3010" />',
  "\n</Lane>\n",
  "</NextMoves>\n",
].join("\n");

const REL_B = "plans/e2e-checks-b.mdx";
const REL_C = "plans/e2e-checks-c.mdx";
const REL_L = "plans/e2e-checks-loose.mdx";
const lanePage = (title: string, steps: string[]) => [`---\ntitle: ${title}\n---\n`, "<NextMoves>\n", '<Lane kind="you">\n', ...steps, "\n</Lane>\n", "</NextMoves>\n"].join("\n");
const B_STEPS = [
  '1. Apply the old migration. <Check migration="086" />',
  '2. Check two machines. <Check migration="086" on="laptop,mini" />',
  '3. Go. <Check migration="086" />',
  '4. Apply a long step whose words run on for a while, so the row ends close to the edge of a narrow screen. <Check migration="999" />',
];
const PAGES: Record<string, string> = {
  [REL_B]: lanePage("Check fixture B", B_STEPS),
  // The same rows as B, other bytes: a stale answer for B would pair here.
  [REL_C]: lanePage("Check fixture C", B_STEPS),
  // A loose list; its third step holds a paragraph, so Done refuses it and its chip stays after its text.
  [REL_L]: lanePage("Check fixture loose", ['1. Apply the loose step. <Check migration="086" />', "", '2. Go. <Check migration="999" />', "", '3. Apply the step with a paragraph. <Check migration="086" />', "", "   A paragraph under it."]),
};

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env: GIT_ENV });

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-step-checks-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  for (const [rel, text] of Object.entries(PAGES)) await writeFile(path.join(root, rel), text, "utf8");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "e2e");
  git(root, "config", "user.email", "e2e@example.invalid");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_DIR: "",
      WIKI_EXTRA: `${WIKI}=${root}`,
      WORK_MAP_WIKIS: WIKI,
      WIKI_ANSWER_WIKIS: WIKI,
      WIKI_ANSWER_OWNER: "Test Owner (T000001)",
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${WIKI}`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

const row = (p: Page, text: string) => p.locator(".wiki-article .nm-lane.nm-you .nm-body li", { hasText: text });
const chip = (p: Page, text: string) => row(p, text).locator(":scope > .step-check > .step-chip");

async function openPage(p: Page): Promise<void> {
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(p.locator(".wiki-article .next-moves")).toBeVisible();
  await p.locator(".wiki-article .nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
}

test.describe.serial("owner-step check chips", () => {
  test("each tagged step shows what its probes proved; the untagged one shows nothing", async ({ page: p }) => {
    await openPage(p);
    await expect(chip(p, "Apply the old migration")).toHaveText("✓ checked");
    await expect(chip(p, "Apply the old migration")).toHaveAttribute("data-state", "ok");
    await expect(chip(p, "Apply the old migration")).toHaveAttribute("title", "migration=086: migration 086 is applied on this machine's database");
    await expect(chip(p, "Apply the missing migration")).toHaveText("○ not yet");
    await expect(chip(p, "Add the key")).toHaveText("○ not yet");
    await expect(chip(p, "Add the key")).toHaveAttribute("title", new RegExp(`^env=${KEY}: ${KEY} is not in \\.env`));
    await expect(chip(p, "Restart muninn")).toHaveText("? unknown");
    await expect(chip(p, "Restart muninn")).toHaveAttribute("data-state", "unknown");
    await expect(chip(p, "Restart muninn")).toHaveAttribute("title", /restart=3010: muninn cannot prove this yet/);
    await expect(row(p, "Water the plants").locator(".step-check")).toHaveCount(0);
    await expect(p.locator(".wiki-article .step-chip")).toHaveCount(4);
  });

  test("the chip takes no part in Done's name, and Done removes a chipped row", async ({ page: p }) => {
    await openPage(p);
    const li = row(p, "Apply the missing migration");
    await expect(chip(p, "Apply the missing migration")).toBeVisible();
    const done = li.locator("[data-step-done]");
    await expect(done).toHaveAccessibleName("Done: Apply the missing migration.");
    await expect(row(p, "Apply the old migration").locator("[data-step-done]")).toHaveAccessibleName("Done: Apply the old migration.");
    await done.click();
    await expect(li.locator(".wiki-step-done-lines")).toContainText('3. Apply the missing migration. <Check migration="999" />');
    await li.locator("[data-step-done-confirm]").click();
    await expect(row(p, "Apply the missing migration")).toHaveCount(0);
    expect(await readFile(path.join(root, REL), "utf8")).not.toContain("missing migration");
    // The page rendered again with the new hash: the steps left get their chips.
    await p.locator(".wiki-article .nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await expect(chip(p, "Apply the old migration")).toHaveText("✓ checked");
    await expect(p.locator(".wiki-article .step-chip")).toHaveCount(3);
  });
});

async function openAt(p: Page, rel: string): Promise<void> {
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article .next-moves")).toBeVisible();
  await p.locator(".wiki-article .nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
}

const CHECKS = "**/api/wiki/step-checks?*";
const dones = (p: Page) => p.locator(".wiki-article [data-step-done]");
const chips = (p: Page) => p.locator(".wiki-article .step-chip");
/**
 * Each Done's box on its own row: relative to its `li`, so a chip that wraps
 * onto a second line of an EARLIER row (content below that row's Done, which
 * moves every later row down) is not read as this row's Done moving.
 */
const doneBoxes = (p: Page) =>
  dones(p).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    const li = e.closest("li")!.getBoundingClientRect();
    return { x: r.x - li.x, y: r.y - li.y, w: r.width, h: r.height };
  }));
/** A route that answers only when `release` runs. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}
/** Answer the checks route with the real answer passed through `shape`, under `status`. */
const shaped = (shape: (a: Record<string, unknown>) => unknown, status = 200) => async (route: Route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, status, body: JSON.stringify(shape(await res.json())) });
};
/** The page has had the answer and the client its turn to draw. */
async function answered(p: Page, done: Promise<unknown>): Promise<void> {
  await done;
  await p.evaluate(() => new Promise((r) => setTimeout(r, 300)));
}

test.describe("owner-step check chips, answer shaped", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  for (const width of [1280, 375]) {
    for (const [rel, rows, chipCount] of [[REL_B, 4, 4], [REL_L, 2, 3]] as const) {
      test(`a chip landing after Done leaves Done where it was (${width} px, ${rel})`, async ({ page: p }) => {
        await p.setViewportSize({ width, height: 900 });
        const g = gate();
        await p.route(CHECKS, async (route) => (await g.wait, route.continue()));
        await openAt(p, rel);
        await expect(dones(p)).toHaveCount(rows);
        const before = await doneBoxes(p);
        g.release();
        await expect(chips(p)).toHaveCount(chipCount);
        const after = await doneBoxes(p);
        if (rel === REL_L) {
          const lone = row(p, "Apply the step with a paragraph");
          await expect(lone.locator("[data-step-done]")).toHaveCount(0);
          await expect(lone.locator(":scope > .step-check > .step-chip")).toHaveText("✓ checked");
        }
        before.forEach((b, i) => {
          expect(Math.abs(after[i]!.x - b.x), `row ${i} x ${b.x}→${after[i]!.x}`).toBeLessThanOrEqual(1);
          expect(Math.abs(after[i]!.y - b.y), `row ${i} y ${b.y}→${after[i]!.y}`).toBeLessThanOrEqual(1);
        });
      });
    }
  }

  test("a chip that lands before Done still ends up after it", async ({ page: p }) => {
    const g = gate();
    await p.route("**/api/wiki/step-done?*", async (route) => (await g.wait, route.continue()));
    await openAt(p, REL_B);
    await expect(chips(p)).toHaveCount(4);
    g.release();
    await expect(dones(p)).toHaveCount(4);
    await expect(p.locator(".wiki-article .nm-body li > [data-step-done] + .step-check > .step-chip")).toHaveCount(4);
  });

  test("a two-machine step with one machine unknown is not drawn as checked", async ({ page: p }) => {
    await p.route(
      CHECKS,
      shaped((a) => ({
        ...a,
        steps: (a.steps as Record<string, unknown>[]).map((s) =>
          s.row === 1
            ? {
                ...s,
                state: "unknown",
                machines: [
                  { name: "laptop", state: "ok", why: "", probes: [{ kind: "migration", value: "086", state: "ok", why: "applied" }] },
                  { name: "mini", state: "unknown", why: "", probes: [{ kind: "migration", value: "086", state: "unknown", why: "no peer" }] },
                ],
              }
            : s,
        ),
      })),
    );
    await openAt(p, REL_B);
    const c = row(p, "Check two machines").locator(".step-chip");
    await expect(c).toHaveText("laptop ✓ · mini ?");
    await expect(c).toHaveAttribute("data-state", "unknown");
    await expect(c).toHaveAccessibleName("Check: unknown (laptop checked, mini unknown)");
    const color = await c.evaluate((e) => getComputedStyle(e).color);
    expect(color).not.toBe(await token(p, "--tone-good"));
    expect(color).toBe(await token(p, "--text-secondary"));
  });

  for (const [what, handler] of [
    ["an answer for other page bytes", shaped((a) => ({ ...a, hash: "0".repeat(64) }))],
    // A 500 carrying a well-formed answer: only the status says no.
    ["a 500", shaped((a) => a, 500)],
    ["a body that is not JSON", async (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: "{not json" })],
    ["a body of the wrong shape", shaped((a) => ({ ...a, steps: "nope" }))],
  ] as const) {
    test(`${what} draws no chip`, async ({ page: p }) => {
      const errors: string[] = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.route(CHECKS, handler);
      const got = p.waitForResponse((r) => r.url().includes("/api/wiki/step-checks"));
      await openAt(p, REL_B);
      await answered(p, got);
      await expect(dones(p)).toHaveCount(4);
      await expect(chips(p)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test("an answer released after the reader moved to another page draws nothing there", async ({ page: p }) => {
    const g = gate();
    await p.route(CHECKS, async (route) => {
      if (route.request().url().includes(encodeURIComponent(REL_C))) return route.fulfill({ status: 500, body: "{}" });
      await g.wait;
      await route.continue();
    });
    await openAt(p, REL_B);
    await expect(dones(p)).toHaveCount(4);
    await p.locator(`.wiki-list-item[data-relpath="${REL_C}"]`).first().click();
    await expect(p.locator(".wiki-article-head h1")).toHaveText("Check fixture C");
    await p.locator(".wiki-article .nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await expect(dones(p)).toHaveCount(4);
    const late = p.waitForResponse((r) => r.url().includes("/api/wiki/step-checks") && r.url().includes(encodeURIComponent(REL_B)));
    g.release();
    await answered(p, late);
    await expect(chips(p)).toHaveCount(0);
  });

  test("copying a chipped row copies exactly what the row copies with no chip", async ({ page: p }) => {
    await openAt(p, REL_B);
    const li = row(p, "Apply the old migration");
    await expect(li.locator(".step-chip")).toHaveText("✓ checked");
    await expect(li.locator("[data-step-done]")).toBeVisible();
    const copy = async () => {
      await li.evaluate((el) => {
        const s = getSelection()!;
        s.removeAllRanges();
        const r = document.createRange();
        r.selectNodeContents(el);
        s.addRange(r);
      });
      await p.keyboard.press("ControlOrMeta+c");
      return p.evaluate(() => navigator.clipboard.readText());
    };
    const chipped = await copy();
    await li.evaluate((el) => el.querySelector(".step-check")!.remove());
    const bare = await copy();
    expect(bare).toBe("Apply the old migration.Done");
    expect(chipped).toBe(bare);
  });

  test("the chip is named in words, describes its reasons, follows Done in tab order and asks nothing", async ({ page: p }) => {
    await openAt(p, REL_B);
    const li = row(p, "Apply the old migration");
    const c = li.locator(".step-chip");
    const done = li.locator("[data-step-done]");
    await expect(c).toHaveAccessibleName("Check: checked");
    await expect(c).toHaveAccessibleDescription("migration=086: migration 086 is applied on this machine's database");
    await expect(done).toHaveAccessibleName("Done: Apply the old migration.");
    await expect(row(p, "Go.").locator(".step-chip")).toHaveAccessibleName("Check: checked");
    await expect(row(p, "Apply a long step").locator(".step-chip")).toHaveAccessibleName("Check: not yet");
    await done.focus();
    await p.keyboard.press("Tab");
    await expect(c).toBeFocused();
    const box = await done.boundingBox();
    const asked: string[] = [];
    p.on("request", (r) => asked.push(r.url()));
    const why = li.locator(".step-chip-why");
    await expect(why).toBeHidden();
    await p.keyboard.press("Enter");
    await expect(why).toBeVisible();
    await expect(why).toHaveText("migration=086: migration 086 is applied on this machine's database");
    await expect(c).toHaveAttribute("aria-expanded", "true");
    expect(await done.boundingBox()).toEqual(box);
    await p.keyboard.press("Space");
    await expect(why).toBeHidden();
    await expect(li.locator(".wiki-step-done-panel")).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});
