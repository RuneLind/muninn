/// <reference lib="dom" />
/**
 * Browser entrypoint for the chat page formatters. Bundled by Bun.build()
 * (see web-format-client.ts) and injected as an IIFE into the chat HTML.
 *
 * `formatWebHtml` and `renderSlackMrkdwn` are re-exported as-is from their
 * canonical modules so the browser uses the SAME functions as the server.
 * `sanitizeHtml` is browser-only because it needs the DOM.
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
  // Component block markup (`web-format.ts`) + any raw component tags an answer
  // might emit before parsing lands them. Without these the sanitizer would
  // flatten components to text on the client re-render.
  "div", "figure", "figcaption",
  "callout", "verdict", "pill", "fileref", "comparisontable",
];

// Class names emitted by the component renderers. `class` is normally stripped
// from every tag but `code`; these are preserved so component styling survives.
const COMPONENT_CLASS_ALLOW = new Set([
  "callout", "callout-info", "callout-warn", "callout-good", "callout-bad",
  "callout-title", "callout-body",
  "verdict", "verdict-yes", "verdict-no",
  "pill", "pill-rec", "pill-warn",
  "figure", "figure-body", "caption", "fileref", "tablewrap",
]);

function classIsComponent(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((t) => COMPONENT_CLASS_ALLOW.has(t));
}

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
        if (attr.name === "class" && classIsComponent(attr.value)) continue;
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

Object.assign(globalThis, { formatWebHtml, renderSlackMrkdwn, sanitizeHtml });
