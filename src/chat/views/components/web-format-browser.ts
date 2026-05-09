/// <reference lib="dom" />
/**
 * Browser entrypoint for the chat page formatters. Bundled by Bun.build()
 * (see web-format-client.ts) and injected as an IIFE into the chat HTML.
 *
 * `formatWebHtml` and `renderSlackMrkdwn` are re-exported as-is from their
 * canonical modules so the browser uses the SAME functions as the server —
 * no manual port to keep in sync. `sanitizeHtml` is browser-only because
 * it relies on the DOM.
 *
 * All three are attached to `globalThis` so the surrounding inline script
 * (CHAT_SCRIPT in page.ts) can call them by bare name.
 */

import { formatWebHtml } from "../../../web/web-format.ts";
import { renderSlackMrkdwn } from "./slack-mrkdwn.ts";

const TG_TAGS = ["b", "strong", "i", "em", "u", "s", "del", "code", "pre", "a", "br", "span"];
const WEB_TAGS = [
  ...TG_TAGS,
  "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
  "p", "details", "summary",
];

/** Sanitize HTML — allow only safe tags and attributes. Requires DOM. */
function sanitizeHtml(html: string, isWeb: boolean): string {
  const allowedTags = isWeb ? WEB_TAGS : TG_TAGS;
  const tmp = document.createElement("div");
  tmp.innerHTML = html;

  function walk(node: Node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (!allowedTags.includes(tag)) {
        const text = document.createTextNode(el.textContent || "");
        node.replaceChild(text, el);
        continue;
      }
      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        if (tag === "a" && attr.name === "href" && /^https?:\/\//.test(attr.value)) continue;
        if (tag === "a" && (attr.name === "target" || attr.name === "rel")) continue;
        if (tag === "code" && attr.name === "class") continue;
        el.removeAttribute(attr.name);
      }
      if (tag === "a") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener");
      }
      walk(el);
    }
  }
  walk(tmp);
  return tmp.innerHTML;
}

type GlobalWithFormatters = typeof globalThis & {
  formatWebHtml: typeof formatWebHtml;
  renderSlackMrkdwn: typeof renderSlackMrkdwn;
  sanitizeHtml: typeof sanitizeHtml;
};
const g = globalThis as GlobalWithFormatters;
g.formatWebHtml = formatWebHtml;
g.renderSlackMrkdwn = renderSlackMrkdwn;
g.sanitizeHtml = sanitizeHtml;
