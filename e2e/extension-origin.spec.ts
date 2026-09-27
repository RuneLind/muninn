/**
 * `MUNINN_AUTH=off`'s origin guard against a real Chrome extension and a real
 * cross-site page.
 *
 * The YouTube extension (`extensions/youtube`) is loaded unpacked and driven
 * through its own service worker — the popup page sends the same
 * `GET_OPTIONS` / `SUMMARIZE` messages the real popup sends. Its `muninnUrl`
 * setting points at this spec's muninn, a host the manifest does not grant, so
 * the fetches take the CORS path: what the server echoes is what decides them.
 * Measured with a header-echo server: the worker sends
 * `Origin: chrome-extension://<per-install id>` and `Sec-Fetch-Site: cross-site`,
 * which is why the guard admits the whole scheme rather than a listed id.
 *
 * The control is a page on another origin (the stub on a second port) POSTing
 * `text/plain` — a CORS simple request, so the browser sends it with no
 * preflight. The page cannot read the answer, so the refusal is read off the
 * server's own warn line.
 *
 * Extensions need a persistent context and the full Chromium build
 * (`channel: "chromium"`), not the default headless shell, so this spec launches
 * its own browser instead of using the `page` fixture.
 */

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("extension-origin");
const PAGE_PORT = e2ePort("extension-origin/page");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const EXTENSION = path.join(REPO_ROOT, "extensions/youtube");

let server: ChildProcess | undefined;
let serverLog = "";
let stub: http.Server | undefined;
let ctx: BrowserContext | undefined;
let profileDir: string | undefined;

/** The slice of the extension API these page/worker callbacks touch; the repo
 *  carries no `@types/chrome`. */
type ChromeApi = {
  storage: { sync: { set(v: Record<string, string>): Promise<void> } };
  runtime: { sendMessage(m: unknown, cb: (r: Record<string, unknown>) => void): void };
};

test.beforeAll(async () => {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      MUNINN_AUTH: "off",
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (serverLog += String(d)));
  server.stderr!.on("data", (d) => (serverLog += String(d)));

  stub = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>elsewhere</title>");
  });
  await new Promise<void>((r) => stub!.listen(PAGE_PORT, "127.0.0.1", r));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }

  profileDir = mkdtempSync(path.join(os.tmpdir(), "muninn-ext-origin-"));
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
});

test.afterAll(async () => {
  await ctx?.close();
  stub?.close();
  server?.kill("SIGTERM");
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

async function extensionPopup() {
  let [sw] = ctx!.serviceWorkers();
  if (!sw) sw = await ctx!.waitForEvent("serviceworker");
  await sw.evaluate(
    (u) => (globalThis as unknown as { chrome: ChromeApi }).chrome.storage.sync.set({ muninnUrl: u }),
    BASE,
  );
  const popup = await ctx!.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  return (msg: Record<string, unknown>) =>
    popup.evaluate(
      (m) =>
        new Promise<Record<string, unknown>>((r) =>
          (globalThis as unknown as { chrome: ChromeApi }).chrome.runtime.sendMessage(m, r),
        ),
      msg,
    );
}

test.describe("MUNINN_AUTH=off: the origin guard", () => {
  test("the unconfigured extension's options GET reads the answer (CORS echo)", async () => {
    const send = await extensionPopup();
    const res = await send({ type: "GET_OPTIONS" });
    expect(res.error).toBeUndefined();
    expect((res.options as { default_kind: string }).default_kind).toBe("standard");
  });

  test("the extension's preflighted JSON POST reaches the route's own validation", async () => {
    const send = await extensionPopup();
    // No url/videoId: the route answers 400 before any download or model call.
    // A refusal would read "forbidden"; a failed preflight "Failed to fetch".
    const res = await send({ type: "SUMMARIZE" });
    expect(res.error).toBe("Missing required fields: url, video_id");
  });

  test("a cross-site page's text/plain POST is refused before the handler", async () => {
    const page = await ctx!.newPage();
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
    const outcome = await page.evaluate(async (base) => {
      try {
        await fetch(`${base}/api/research/chat`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });
        return "read";
      } catch {
        return "unreadable";
      }
    }, BASE);
    // Unreadable either way (no CORS header for a foreign page); the server line
    // is the evidence the handler never ran.
    expect(outcome).toBe("unreadable");
    await expect
      .poll(() => serverLog, { timeout: 5_000 })
      .toContain("Refused a cross-origin POST /api/research/chat (origin not allowed)");
    expect(serverLog).not.toContain("POST /api/research/chat from");
  });
});
