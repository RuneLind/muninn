import { escapeHtml } from "../../../format/markdown-core.ts";

/**
 * Minimal Slack mrkdwn → HTML renderer for messages from Slack conversations
 * displayed in the web chat. Bundled into the browser via web-format-browser.ts;
 * also imported by tests directly.
 */
export function renderSlackMrkdwn(text: string): string {
  const links: { url: string; label: string }[] = [];
  let t = text.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) => {
    links.push({ url, label });
    return "%%SLINK" + (links.length - 1) + "%%";
  });
  t = escapeHtml(t)
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~([^~]+)~/g, "<del>$1</del>")
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    t = t.replace(
      "%%SLINK" + i + "%%",
      `<a href="${escapeHtml(link.url)}" target="_blank">${escapeHtml(link.label)}</a>`,
    );
  }
  return t;
}
