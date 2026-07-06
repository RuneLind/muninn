/// <reference lib="dom" />
/** Browser entrypoint: re-exports the canonical TS helpers onto globalThis
 *  so the dashboard pages' inline `<script>` IIFEs can call them by bare name. */

import { escHtml, escAttr } from "./escape.ts";
import { extractToolInputLabel } from "./tool-helpers.ts";
import { deriveSpanLabelHtml } from "./span-label.ts";
import { summarizeSearchTrace } from "./search-helpers.ts";
import { sseClient, getJson, HttpError } from "./client-runtime.ts";
import {
  formatTime,
  timeAgo,
  deadlineText,
  fmtMs,
  fmtDuration,
  fmtTokens,
  formatSchedule,
} from "./helpers.ts";

Object.assign(globalThis, {
  esc: escHtml,
  escapeHtml: escHtml,
  escapeAttr: escAttr,
  toolInputLabel: extractToolInputLabel,
  deriveSpanLabelHtml,
  summarizeSearchTrace,
  formatTime,
  timeAgo,
  deadlineText,
  fmtMs,
  fmtDuration,
  fmtTokens,
  formatSchedule,
  sseClient,
  getJson,
  HttpError,
});

// Build-hash freshness check. Pages that inject the `muninn-build-hash` meta
// tag get a one-shot banner on the first tab-visibility transition where the
// server's current bundle hash diverges from what the page was rendered with.
// Catches the workflow gotcha where muninn restarted (e.g. branch switched,
// hot-reload picked up new code) but the operator's tab still serves the
// previous inlined bundle. No-op on pages without the meta tag.
(() => {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
  if (typeof fetch !== "function" || typeof location === "undefined") return;
  const meta = document.querySelector('meta[name="muninn-build-hash"]') as HTMLMetaElement | null;
  const initial = meta?.content;
  if (!initial) return;

  let banner: HTMLElement | null = null;
  let alreadyShown = false;

  async function check(): Promise<void> {
    if (alreadyShown) return;
    try {
      const r = await fetch("/api/dashboard-build-hash", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { hash?: string };
      if (data.hash && data.hash !== initial) showBanner(data.hash);
    } catch {
      // Network errors are fine — try again on next visibility change.
    }
  }

  function showBanner(currentHash: string): void {
    alreadyShown = true;
    banner = document.createElement("div");
    banner.setAttribute("role", "alert");
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 14px;" +
      "background:#f59e0b;color:#1a1a1a;font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif;" +
      "text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;";
    banner.textContent =
      `Muninn has updated (build ${initial} → ${currentHash}) — click here to reload for the latest UI.`;
    banner.addEventListener("click", () => location.reload());
    document.body.appendChild(banner);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  // Also check once on script init — covers the case where the tab was
  // already visible when the script ran.
  void check();
})();
