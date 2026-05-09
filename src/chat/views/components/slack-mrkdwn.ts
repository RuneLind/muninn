import { Placeholders, escapeHtml } from "../../../format/markdown-core.ts";

/**
 * Bundled into the browser via web-format-browser.ts; also imported by tests
 * directly (which is why it's split out from the browser entrypoint —
 * sanitizeHtml in web-format-browser.ts pulls in the DOM lib).
 */
export function renderSlackMrkdwn(text: string): string {
  const ph = new Placeholders();
  let t = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) =>
    ph.add("SLINK", `<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(label)}</a>`),
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
