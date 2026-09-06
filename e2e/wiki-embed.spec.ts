/**
 * `<Embed src="…" />` in the /wiki reader: a markdown page embedding a standalone
 * `.html` explainer (an archify diagram) inside its own body.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The frame actually loads the file.** `enhanceEmbeds` builds a URL from
 *     three parts — the page's relPath (from the /api/wiki/page payload), the
 *     resolver, and `withWiki` — and the route's shadowed-html fallback has to
 *     answer it. Every unit test in that chain is green with the chain broken,
 *     and the symptom is a frame showing the reader's 404 text.
 *  2. **The natural naming works.** `post.mdx` beside `post.html`: the index
 *     drops the `.html` (stem precedence), so a route resolving strictly through
 *     the index 404s exactly the shape a person writes first.
 *  3. **Sandbox is on.** The frame carries the explainer view's sandbox and
 *     nothing more.
 *  4. **An escaping src stays a fallback line** — no frame, no request.
 *
 * No model calls. ENV / SPAWN ENV: as every other spec here — `e2eEnv()` keeps
 * this muninn off Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { EMBED_FRAME_CLASS } from "../src/dashboard/views/components/wiki-embed.ts";

const PORT = e2ePort("wiki-embed");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-embed";
const FRAME = `iframe.${EMBED_FRAME_CLASS}`;

const MARKER = "ARCHIFY-E2E-MARKER-7f3a";
const HTML = `<!doctype html><html><head><title>Arch</title></head><body><h1>${MARKER}</h1><svg width="10" height="10"></svg></body></html>`;

const PAGE_REL = "blogs/2026-09-06-arch.mdx";
const HTML_REL = "blogs/2026-09-06-arch.html";
const PAGE = [
  "---",
  "title: Architecture, embedded",
  "type: blog",
  "---",
  "",
  "# Architecture, embedded",
  "",
  "Prose before.",
  "",
  '<Embed src="./2026-09-06-arch.html" height="500" title="The map" />',
  "",
  "Prose after.",
  "",
].join("\n");

const ESCAPE_REL = "blogs/escape.mdx";
const ESCAPE_PAGE = ["---", "title: Escape", "---", "", '<Embed src="../../etc/x.html" />', ""].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-embed-"));
  await mkdir(path.join(root, "blogs"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, HTML_REL), HTML, "utf8");
  await writeFile(path.join(root, ESCAPE_REL), ESCAPE_PAGE, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
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
  if (root) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki reader: <Embed src>", () => {
  test("the same-stem .html is dropped from the index but still embeds", async ({ page }) => {
    // Precondition for the whole spec: the shape under test IS the shadowed one.
    const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).json()) as {
      pages?: Array<{ relPath: string }>;
    } | Array<{ relPath: string }>;
    const pages = Array.isArray(listing) ? listing : (listing.pages ?? []);
    expect(pages.map((p) => p.relPath)).toContain(PAGE_REL);
    expect(pages.map((p) => p.relPath)).not.toContain(HTML_REL);

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
    const frame = page.locator(FRAME);
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-popups allow-downloads");
    await expect(frame).toHaveAttribute("title", "The map");
    await expect(frame).toHaveAttribute(
      "src",
      new RegExp(`/api/wiki/html\\?relPath=${encodeURIComponent(HTML_REL).replace(/[.]/g, "\\.")}.*wiki=${WIKI}`),
    );
    expect(await frame.evaluate((el) => (el as HTMLElement).style.height)).toBe("500px");
    // The acceptance: the file's own content is on screen inside the frame.
    await expect(page.frameLocator(FRAME).locator("h1")).toHaveText(MARKER);
    // An "open in new tab" link beside the frame, pointing at the SAME url the
    // frame loads — the html is shadowed out of the page list, so this link is
    // the only way a reader reaches the standalone viewer.
    const open = page.locator(".embed-open");
    await expect(open).toHaveCount(1);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", /noopener/);
    expect(await open.getAttribute("href")).toBe(await frame.getAttribute("src"));
    // A quiet secondary affordance: its colour is the muted token, not the
    // article's external-link blue — compared against the token resolved on a
    // body probe, never a literal (a literal passes against the wrong rule).
    const muted = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-muted)";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    await expect(open).toHaveCSS("color", muted);
    // The bytes the link opens top-level carry the sandbox the iframe applies.
    const res = await page.request.get(`${BASE}${await open.getAttribute("href")}`);
    expect(res.headers()["content-security-policy"]).toBe("sandbox allow-scripts allow-popups allow-downloads");
    // …and the page around it kept its prose and its fallback line is gone.
    await expect(page.locator(".wiki-article")).toContainText("Prose after.");
    await expect(page.locator(".embed-fallback")).toHaveCount(0);
  });

  test("a src that escapes the root leaves the fallback line and makes no request", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/wiki/html")) requests.push(r.url());
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(ESCAPE_REL)}`);
    await expect(page.locator(".embed-fallback")).toHaveText(/Embedded page:/);
    await expect(page.locator(FRAME)).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("a navigation to a second embedding page does not stack frames", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
    await expect(page.locator(FRAME)).toHaveCount(1);
    await page.locator(`.wiki-list-item[data-relpath="${ESCAPE_REL}"]`).click();
    await expect(page.locator(".embed-fallback")).toHaveCount(1);
    await page.locator(`.wiki-list-item[data-relpath="${PAGE_REL}"]`).click();
    await expect(page.locator(FRAME)).toHaveCount(1);
    await expect(page.locator(".embed-open")).toHaveCount(1);
  });
});
