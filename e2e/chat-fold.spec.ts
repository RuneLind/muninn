/**
 * `<Fold>` through the CHAT page's own sanitizer.
 *
 * The repo has no browser test env (no jsdom, no happy-dom) and `sanitizeHtml`
 * is not exported — it is defined inside `web-format-browser.ts`, a `Bun.build`
 * entrypoint whose last line publishes it on `globalThis`. So the one place its
 * attribute allowlist can be driven is the real chat page with the real bundle,
 * exactly as `chat-card-fences.spec.ts` does for the fence enhancers.
 *
 * What only this can see: the sanitizer's attribute loop is an allowlist, so
 * without a `details[open]` clause an author's `open="true"` fold arrives in chat
 * COLLAPSED — and `classIsComponent` drops the whole `class` unless every token
 * is allowlisted, so a missing `fold-heading-dup` renders the section heading a
 * fold's title already repeats. Both are green in every unit test.
 *
 * No DB row, no model call: the spec calls the two published functions directly.
 *
 * **It boots its own muninn rather than reusing the config's server on 3011**
 * because what it asserts is the CHAT BUNDLE, and `bun --watch` never rebuilds a
 * client bundle — a reused dev server would serve whichever build was current when
 * that server started, so a green run would say nothing about the code in the tree.
 *
 * ENV / SPAWN ENV: no `.env` is required — the spawn inherits `DATABASE_URL` (CI
 * passes it inline) and `e2eEnv()` blanks the platform tokens and the host's
 * instance-profile flags, which is what keeps this muninn off Telegram/Slack.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("chat-fold");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const CLOSED = '<Fold title="What was measured">\n\nThe probe returned 149 lines.\n\n</Fold>';
const OPEN = '<Fold title="Current state" open="true">\n\nNothing built yet.\n\n</Fold>';
const DUP = '<Fold title="What was measured">\n\n## What was measured\n\nThe probe returned 149 lines.\n\n</Fold>';
const DIFF = '<Fold title="Measurements">\n\n## What was measured\n\nThe probe returned 149 lines.\n\n</Fold>';

let server: ChildProcess | undefined;

test.beforeAll(async () => {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/chat`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

test.describe("Chat: <Fold> through the real sanitizer", () => {
  test("a fold survives sanitizeHtml with its state, its classes and its body", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () =>
        typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function" &&
        typeof (globalThis as { sanitizeHtml?: unknown }).sanitizeHtml === "function",
    );

    const out = await page.evaluate(
      ({ closed, open, dup, diff }) => {
        const g = globalThis as unknown as {
          formatWebHtml: (s: string) => string;
          sanitizeHtml: (h: string, isWeb: boolean) => string;
        };
        const render = (src: string) => {
          const host = document.createElement("div");
          // The component CSS is scoped to `.web-content` on this page, and the
          // hide rule is what the duplicate-heading assertion below reads.
          host.className = "web-content";
          host.innerHTML = g.sanitizeHtml(g.formatWebHtml(src), true);
          document.body.appendChild(host);
          const details = host.querySelector("details");
          const heading = host.querySelector("h3");
          const result = {
            hasDetails: !!details,
            isOpen: !!(details as HTMLDetailsElement | null)?.open,
            detailsClass: details?.className ?? "",
            bodyClass: host.querySelector("div.fold-body")?.className ?? "",
            summary: host.querySelector("summary")?.textContent ?? "",
            text: host.textContent ?? "",
            headingClass: heading?.className ?? "",
            // The reason `fold-heading-dup` has to survive the sanitizer: the
            // class is the ONLY thing hiding the doubled label.
            headingVisible: heading ? getComputedStyle(heading).display !== "none" : null,
          };
          host.remove();
          return result;
        };
        return { closed: render(closed), open: render(open), dup: render(dup), diff: render(diff) };
      },
      { closed: CLOSED, open: OPEN, dup: DUP, diff: DIFF },
    );

    // Closed by default, with both classes intact and the body still present.
    expect(out.closed.hasDetails).toBe(true);
    expect(out.closed.isOpen).toBe(false);
    expect(out.closed.detailsClass).toBe("fold");
    expect(out.closed.bodyClass).toBe("fold-body");
    expect(out.closed.summary).toBe("What was measured");
    expect(out.closed.text).toContain("The probe returned 149 lines.");

    // `open="true"` — the attribute the sanitizer's allowlist has to keep.
    expect(out.open.isOpen).toBe(true);
    expect(out.open.summary).toBe("Current state");

    // The duplicate heading keeps its class, and the class actually hides it.
    expect(out.dup.headingClass).toBe("fold-heading-dup");
    expect(out.dup.headingVisible).toBe(false);
    expect(out.dup.text).toContain("The probe returned 149 lines.");

    // A heading that differs from the title is untouched and visible.
    expect(out.diff.headingClass).toBe("");
    expect(out.diff.headingVisible).toBe(true);
  });
});
