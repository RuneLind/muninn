/**
 * F26 (architecture review 2026-11-16) in a real browser: a `<Question id>`
 * holding `>` and markup, on a page whose glossary term the id then uses. The
 * card's `qcard-…` anchor was written unescaped and the glossary pass split
 * the tag at the raw `>`, so the reader's unsanitized `innerHTML` made the
 * markup in the id a live element whose handler ran. The card's anchor is now
 * slugged and the glossary tokenizer is quote-aware.
 *
 * What a unit test cannot show: the route renders with views on (the anchor
 * and the glossary marks only exist there) and the client inserts the HTML,
 * where a browser either parses the id as text or runs it.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: `e2eEnv()` blanks the platform
 * tokens and the instance-profile flags. One muninn over one temp wiki.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-reader-html-gate");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-html-gate";
const PAGE_REL = "plans/gate.mdx";

// Synthetic: invented ids and wording. `src=data:,x` fails to load without a
// request, so the handler fires and the server sees no 404.
const HOSTILE_ID = "O1>Hold <img src=data:,x data-pwn onerror=window.__pwn=1>";
const PAGE = [
  "---",
  "title: Gate page",
  "type: plan",
  "---",
  "",
  "# Gate page",
  "",
  `<Question id="${HOSTILE_ID}">`,
  "",
  "**Is this one safe?**",
  "",
  "</Question>",
  "",
  '<Question id="Q-16">',
  "",
  "**A plain id?**",
  "",
  "</Question>",
  "",
  "We Hold the line here.",
  "",
  "<Glossary>",
  "",
  "- **Hold** — kept back",
  "",
  "</Glossary>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-html-gate-"));
  await mkdir(path.join(base, "plans"), { recursive: true });
  await writeFile(path.join(base, PAGE_REL), PAGE, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${base}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
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
  if (base) await rm(base, { recursive: true, force: true });
});

test.describe("Wiki reader: a hostile <Question id> stays text", () => {
  test("no element from the id reaches the DOM and its handler never runs", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
    const cards = page.locator(".wiki-article section.question");
    await expect(cards).toHaveCount(2);
    // The glossary pass ran over the page: the term in the prose is marked.
    await expect(page.locator(".wiki-article .gl-term").first()).toBeVisible();

    // Give a load error the time to fire its handler, were there one.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    await expect(page.locator("img[data-pwn]")).toHaveCount(0);

    // The id reads as text, the answer route's key stays the raw id, and the
    // anchor is slugged; a plain id keeps the anchor its deep links name.
    await expect(cards.first().locator(".q-id")).toContainText("O1>");
    await expect(cards.first()).toHaveAttribute("data-question-id", HOSTILE_ID);
    await expect(cards.first()).toHaveAttribute("id", "qcard-o1-hold-img-src-data-x-data-pwn-onerror-window-__pwn-1");
    await expect(cards.nth(1)).toHaveAttribute("id", "qcard-q-16");
    expect(errors).toEqual([]);
  });
});
