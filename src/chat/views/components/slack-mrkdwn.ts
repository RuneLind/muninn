import { Placeholders, escapeHtml } from "../../../format/markdown-core.ts";

/**
 * Bundled into the browser via web-format-browser.ts; also imported by tests
 * directly (which is why it's split out from the browser entrypoint —
 * sanitizeHtml in web-format-browser.ts pulls in the DOM lib).
 */
export function renderSlackMrkdwn(text: string): string {
  const ph = new Placeholders();
  let t = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) =>
    // `rel="noopener"` alongside the existing `target="_blank"`: a rendered link
    // here is untrusted model/source output, and an opener handle lets the opened
    // page rewrite this one's location. Safe for every consumer (the chat page and
    // the share dialog's Slack preview) — it removes a capability, adds none.
    ph.add(
      "SLINK",
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`,
    ),
  );
  t = escapeHtml(t)
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~([^~]+)~/g, "<del>$1</del>")
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  return ph.restore(t);
}
