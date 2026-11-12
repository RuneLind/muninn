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
 *  4. The slot is a fixed box and the reasons an overlay: on a thirty-row lane
 *     (tight and loose, code spans, links, sub-items) no Done moves in page
 *     coordinates at 1280, 768, 414, 375 or 320 px when the answer lands (any
 *     state, three machines, or none) or row 2's reasons open and close; the
 *     reasons stay in the viewport and on top; the chip is one glyph; Escape,
 *     a second activation, a click outside and focus leaving close them, one
 *     at a time; print hides them; each glyph's tone reads at 4.5:1 in both
 *     explicit and both system themes.
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
import { paintedContrast, token } from "./contrast.ts";
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
  // This spec's own muninn: a port muninn cannot prove restarted yet.
  `5. Restart muninn. <Check migration="086" restart="${PORT}" />`,
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

/**
 * Thirty rows in one lane: a tight list, a paragraph, a loose list. Row lengths
 * step through many widths so some row ends just short of the edge at every
 * viewport; rows end in code spans and links; two hold sub-items (no Done
 * there: Done refuses a nested list). Every state and two machine counts.
 */
const REL_30 = "plans/e2e-checks-thirty.mdx";
const WORDS = "apply the change and then read what the probe says about it before you move on to the next".split(" ");
const words = (n: number) => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ");
const TAGS = ['<Check migration="086" />', '<Check migration="999" />', `<Check migration="086" restart="${PORT}" />`, '<Check migration="086" on="laptop,mini" />', `<Check env="${KEY}" />`];
const tag = (i: number) => TAGS[i % TAGS.length];
const THIRTY_TIGHT = Array.from({ length: 16 }, (_, i) => {
  const n = i + 1;
  if (n === 1) return `1. Go. ${tag(0)}`;
  if (n === 2) return `2. Open the reasons on this row. ${tag(1)}`;
  if (n === 4) return `4. Run \`bun run db:migrate\` ${tag(3)}`;
  if (n === 6) return `6. Read [the runbook](https://example.invalid/runbook) ${tag(5)}`;
  if (n === 9) return `9. Tidy the sub-items. ${tag(8)}\n   - one sub-item\n   - another sub-item`;
  return `${n}. Step ${n}: ${words(3 + ((i * 7) % 29))}. ${tag(i)}`;
});
const THIRTY_LOOSE = Array.from({ length: 14 }, (_, i) => {
  const n = i + 1;
  if (n === 3) return `3. Run \`git push origin main\` ${tag(2)}\n`;
  if (n === 5) return `5. Nest it. ${tag(4)}\n   - a nested row\n`;
  if (n === 8) return `8. See [[e2e-checks]] and [the notes](https://example.invalid/notes) ${tag(7)}\n`;
  return `${n}. Loose ${n}: ${words(2 + ((i * 11) % 31))}. ${tag(i + 1)}\n`;
});
PAGES[REL_30] = lanePage("Check fixture thirty", [...THIRTY_TIGHT, "", "Then, when those hold:", "", ...THIRTY_LOOSE]);

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
    await expect(chip(p, "Apply the old migration")).toHaveText("✓");
    await expect(chip(p, "Apply the old migration")).toHaveAttribute("data-state", "ok");
    await expect(chip(p, "Apply the old migration")).toHaveAttribute("title", "migration=086: migration 086 is applied on this machine's database");
    await expect(chip(p, "Apply the missing migration")).toHaveText("○");
    await expect(chip(p, "Add the key")).toHaveText("○");
    await expect(chip(p, "Add the key")).toHaveAttribute("title", new RegExp(`^env=${KEY}: ${KEY} is not in \\.env`));
    await expect(chip(p, "Restart muninn")).toHaveText("?");
    await expect(chip(p, "Restart muninn")).toHaveAttribute("data-state", "unknown");
    await expect(chip(p, "Restart muninn")).toHaveAttribute("title", new RegExp(`restart=${PORT}: muninn cannot prove this yet`));
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
    await expect(chip(p, "Apply the old migration")).toHaveText("✓");
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
/** Each Done's box on its own row, relative to its `li`; `donePageBoxes` below measures the page, where an earlier row growing counts too. */
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
          await expect(lone.locator(":scope > .step-check > .step-chip")).toHaveText("✓");
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
    await expect(c).toHaveText("?");
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
    await expect(li.locator(".step-chip")).toHaveText("✓");
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

/** Every Done's box in page coordinates: relative to the article's own origin, so a row that grows pushes every later Done and that counts. */
const donePageBoxes = (p: Page) =>
  p.evaluate(() => {
    const art = document.querySelector(".wiki-article:not(.wiki-ask-article)")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll(".wiki-article [data-step-done]")).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x - art.x, y: r.y - art.y, w: r.width, h: r.height };
    });
  });
type Box = { x: number; y: number; w: number; h: number };
/** How far the Done buttons moved between two measures: the worst edge, and how many moved over 1 px. */
function moved(a: Box[], b: Box[]): { max: number; count: number } {
  expect(b.length).toBe(a.length);
  const d = a.map((x, i) => Math.max(Math.abs(x.x - b[i]!.x), Math.abs(x.y - b[i]!.y), Math.abs(x.w - b[i]!.w), Math.abs(x.h - b[i]!.h)));
  return { max: Math.round(Math.max(0, ...d) * 10) / 10, count: d.filter((v) => v > 1).length };
}
const pop = (p: Page) => p.locator(".wiki-article .step-chip-pop:visible");
/** The open popover's box, the viewport's width, and whether its own bottom line is what the page shows there (nothing paints over it, nothing clips it). */
const popBox = (p: Page) =>
  pop(p).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.bottom - 3);
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: innerHeight, onTop: !!hit && el.contains(hit) };
  });
/** Every step on several machines, one of them unknown: the widest answer the route can give. */
const threeMachines = shaped((a) => ({
  ...a,
  steps: (a.steps as Record<string, unknown>[]).map((s) => ({
    ...s,
    state: "unknown",
    machines: ["laptop-with-a-long-name", "mini", "pod"].map((name, k) => ({ name, state: k === 1 ? "unknown" : "ok", why: "", probes: [{ kind: "migration", value: "086", state: "ok", why: `applied on ${name}` }] })),
  })),
}));

test.describe("owner-step check chips: a fixed box, and reasons over the page", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  for (const width of [1280, 768, 414, 375, 320]) {
    test(`on thirty rows nothing the checks do moves any Done: the answer, opening and closing row 2's reasons (${width} px)`, async ({ page: p }) => {
      await p.setViewportSize({ width, height: 900 });
      const g = gate();
      await p.route(CHECKS, async (route) => (await g.wait, route.continue()));
      await openAt(p, REL_30);
      await expect(dones(p)).toHaveCount(28);
      const before = await donePageBoxes(p);
      g.release();
      await expect(chips(p)).toHaveCount(30);
      const answered = await donePageBoxes(p);
      const onAnswer = moved(before, answered);
      console.log(`MOVED ${width}px answer ${JSON.stringify(onAnswer)}`);
      expect(onAnswer, "the answer arriving").toEqual({ max: 0, count: 0 });
      const row2 = row(p, "Open the reasons on this row").locator(".step-chip");
      await row2.click();
      await expect(pop(p)).toHaveCount(1);
      const open = await donePageBoxes(p);
      const box = await popBox(p);
      await p.keyboard.press("Escape");
      await expect(pop(p)).toHaveCount(0);
      const closed = await donePageBoxes(p);
      const m = { answer: moved(before, answered), open: moved(before, open), close: moved(before, closed) };
      console.log(`MOVED ${width}px ${JSON.stringify(m)} pop ${JSON.stringify(box)}`);
      expect(m).toEqual({ answer: { max: 0, count: 0 }, open: { max: 0, count: 0 }, close: { max: 0, count: 0 } });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(box.vw);
      expect(box.onTop).toBe(true);
    });
  }

  for (const width of [1280, 320]) {
    test(`three machines on every step, or no answer at all, moves no Done either (${width} px)`, async ({ page: p }) => {
      await p.setViewportSize({ width, height: 900 });
      const g = gate();
      await p.route(CHECKS, async (route) => (await g.wait, threeMachines(route)));
      await openAt(p, REL_30);
      await expect(dones(p)).toHaveCount(28);
      const before = await donePageBoxes(p);
      g.release();
      await expect(chips(p)).toHaveCount(30);
      const onAnswer = moved(before, await donePageBoxes(p));
      console.log(`MOVED three machines ${width}px ${JSON.stringify(onAnswer)}`);
      expect(onAnswer).toEqual({ max: 0, count: 0 });
      await expect(chips(p).first()).toHaveText("?");
      // No answer: a 500, then the client's wait runs out with nothing drawn.
      const q = await p.context().newPage();
      await q.setViewportSize({ width, height: 900 });
      await q.route(CHECKS, (route) => route.fulfill({ status: 500, body: "{}" }));
      await openAt(q, REL_30);
      await expect(dones(q)).toHaveCount(28);
      const bare = await donePageBoxes(q);
      await q.evaluate(() => new Promise((r) => setTimeout(r, 500)));
      expect(moved(bare, await donePageBoxes(q))).toEqual({ max: 0, count: 0 });
      // And the empty slots hold the same boxes the chips later fill: the answered page's Done buttons sit where the unanswered page's do.
      expect(moved(bare, before)).toEqual({ max: 0, count: 0 });
      await q.close();
    });
  }

  for (const width of [320, 375, 1280]) {
    test(`the reasons stay inside the viewport and over the page, for the chip furthest right, furthest left and last (${width} px)`, async ({ page: p }) => {
      await p.setViewportSize({ width, height: 900 });
      await openAt(p, REL_30);
      await expect(chips(p)).toHaveCount(30);
      await expect(dones(p)).toHaveCount(28);
      const xs = await chips(p).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
      const right = xs.indexOf(Math.max(...xs));
      const left = xs.indexOf(Math.min(...xs));
      // The last row too: its reasons run past the lane's bottom edge, which clips its overflow in the compact block.
      for (const [which, i] of [["right", right], ["left", left], ["last", xs.length - 1]] as const) {
        await chips(p).nth(i).scrollIntoViewIfNeeded();
        const before = await donePageBoxes(p);
        await chips(p).nth(i).click();
        await expect(pop(p)).toHaveCount(1);
        const box = await popBox(p);
        console.log(`POP ${width}px ${which} chip x=${Math.round(xs[i]!)} ${JSON.stringify(box)}`);
        expect(box.left, which).toBeGreaterThanOrEqual(0);
        expect(box.right, which).toBeLessThanOrEqual(box.vw);
        expect(box.onTop, which).toBe(true);
        expect(moved(before, await donePageBoxes(p))).toEqual({ max: 0, count: 0 });
        await chips(p).nth(i).click();
        await expect(pop(p)).toHaveCount(0);
      }
    });
  }

  test("the chip is one glyph; its words are its name and the reasons'", async ({ page: p }) => {
    await openAt(p, REL_B);
    await expect(chips(p)).toHaveCount(4);
    expect(await chips(p).allTextContents()).toEqual(["✓", "?", "✓", "○"]);
    const two = row(p, "Check two machines").locator(".step-chip");
    // This muninn has no MUNINN_MACHINE, so neither machine is proved.
    await expect(two).toHaveAccessibleName("Check: unknown (laptop unknown, mini unknown)");
    await two.click();
    const box = pop(p);
    await expect(box.locator(".step-chip-state")).toHaveText("Check: unknown");
    await expect(box.locator(".step-chip-machine")).toHaveText(["laptop: unknown", "mini: unknown"]);
    await expect(box.locator(".step-chip-why")).toContainText("laptop: migration=086:");
  });

  test("the reasons open on activation only and close on Escape, a second activation, a click outside and focus leaving; one at a time", async ({ page: p }) => {
    await openAt(p, REL_B);
    await expect(chips(p)).toHaveCount(4);
    const li = row(p, "Apply the old migration");
    const c = li.locator(".step-chip");
    const done = li.locator("[data-step-done]");
    const asked: string[] = [];
    p.on("request", (r) => asked.push(r.url()));
    // What reaches the shell: an Escape the chip took, or a click on the chip, does not.
    await p.evaluate(() => {
      const w = window as unknown as { seen: string[] };
      w.seen = [];
      document.addEventListener("keydown", (e) => e.key === "Escape" && w.seen.push("escape"));
      document.querySelector(".wiki-article")!.addEventListener("click", (e) => (e.target as Element).closest(".step-chip") && w.seen.push("click"));
    });
    const seen = () => p.evaluate(() => (window as unknown as { seen: string[] }).seen);
    const popId = await c.getAttribute("aria-controls");
    expect(popId).toMatch(/^step-check-pop-\d+-\d+$/);
    const ids = await chips(p).evaluateAll((els) => els.map((e) => e.getAttribute("aria-controls")));
    expect(new Set(ids).size).toBe(4);
    expect(await p.locator(`[id="${popId}"]`).count()).toBe(1);
    await expect(c).toHaveAttribute("aria-expanded", "false");
    // Focus alone opens nothing.
    await done.focus();
    await p.keyboard.press("Tab");
    await expect(c).toBeFocused();
    await expect(pop(p)).toHaveCount(0);
    await p.keyboard.press("Enter");
    await expect(p.locator(`[id="${popId}"]`)).toBeVisible();
    await expect(c).toHaveAttribute("aria-expanded", "true");
    await expect(c).toHaveAccessibleDescription("migration=086: migration 086 is applied on this machine's database");
    await p.keyboard.press("Escape");
    await expect(pop(p)).toHaveCount(0);
    await expect(c).toBeFocused();
    await expect(c).toHaveAttribute("aria-expanded", "false");
    expect(await seen()).toEqual([]);
    // A second activation closes.
    await p.keyboard.press("Space");
    await expect(pop(p)).toHaveCount(1);
    await p.keyboard.press("Space");
    await expect(pop(p)).toHaveCount(0);
    // A click outside closes.
    await c.click();
    await expect(pop(p)).toHaveCount(1);
    await p.locator(".wiki-article-head h1").click();
    await expect(pop(p)).toHaveCount(0);
    // Focus leaving the chip closes: Tab goes on to the next row's Done.
    await c.focus();
    await p.keyboard.press("Enter");
    await expect(pop(p)).toHaveCount(1);
    await p.keyboard.press("Tab");
    await expect(row(p, "Check two machines").locator("[data-step-done]")).toBeFocused();
    await expect(pop(p)).toHaveCount(0);
    // One at a time.
    await c.click();
    await row(p, "Go.").locator(".step-chip").click();
    await expect(pop(p)).toHaveCount(1);
    await expect(row(p, "Go.").locator(".step-chip-pop")).toBeVisible();
    await expect(c).toHaveAttribute("aria-expanded", "false");
    expect(await seen()).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("print leaves the slot and its reasons out", async ({ page: p }) => {
    await openAt(p, REL_B);
    await expect(chips(p)).toHaveCount(4);
    await row(p, "Go.").locator(".step-chip").click();
    await expect(pop(p)).toHaveCount(1);
    await p.emulateMedia({ media: "print" });
    expect(await p.locator(".wiki-article .step-check").evaluateAll((els) => els.map((e) => getComputedStyle(e).display))).toEqual(["none", "none", "none", "none"]);
    await expect(pop(p)).toHaveCount(0);
  });

  for (const [mode, setup] of [
    ["data-theme=light", async (p: Page) => p.evaluate(() => document.documentElement.setAttribute("data-theme", "light"))],
    ["data-theme=dark", async (p: Page) => p.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"))],
    ["system light", async (p: Page) => p.emulateMedia({ colorScheme: "light" })],
    ["system dark", async (p: Page) => p.emulateMedia({ colorScheme: "dark" })],
  ] as const) {
    test(`each glyph reads at 4.5:1 in its tone (${mode})`, async ({ page: p }) => {
      await openAt(p, REL_B);
      await expect(chips(p)).toHaveCount(4);
      await setup(p);
      await p.mouse.move(0, 0);
      const out: string[] = [];
      for (const [text, state, tok] of [["Go.", "ok", "--tone-good"], ["Apply a long step", "not-yet", "--tone-warn"], ["Check two machines", "unknown", "--text-secondary"]] as const) {
        const c = row(p, text).locator(".step-chip");
        await expect(c).toHaveAttribute("data-state", state);
        expect(await c.evaluate((e) => getComputedStyle(e).color), `${state} colour is ${tok}`).toBe(await token(p, tok));
        const ratio = await paintedContrast(c);
        out.push(`${state} ${ratio.toFixed(2)}`);
        expect(ratio, `${state} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      console.log(`CONTRAST ${mode}: ${out.join(", ")}`);
    });
  }
});
