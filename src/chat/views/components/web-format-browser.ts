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
import { enhanceCodeTabs } from "../../../dashboard/views/components/code-tabs.ts";
import {
  enhanceCodeBlocks,
  unwrapCodeBlockChrome,
} from "../../../dashboard/views/components/code-block-chrome.ts";
import { HIGHLIGHT_TOKEN_CLASSES } from "../../../format/highlight.ts";

const TG_TAGS = ["b", "strong", "i", "em", "u", "s", "del", "code", "pre", "a", "br", "span"];
const WEB_TAGS = [
  ...TG_TAGS,
  "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
  "p", "details", "summary",
  // The FactCheck appendix wraps each claim's evidence in a <section>; without
  // it the client re-render flattens the whole appendix to text.
  "section",
  // Component block markup (`web-format.ts`) + any raw component tags an answer
  // might emit before parsing lands them. Without these the sanitizer would
  // flatten components to text on the client re-render.
  "div", "figure", "figcaption",
  "callout", "verdict", "pill", "fileref", "comparisontable",
  // CodeTabs needs its <button> tabs to survive so the enhancer can wire them.
  "button",
];

/**
 * Class names emitted by the component renderers. `class` is normally stripped
 * from every tag but `code`; these are preserved so component styling survives.
 *
 * Exported for ONE reason: `COMPONENT_FENCE_CHROME`'s own-chrome skip
 * (`code-block-chrome.ts`) resolves a class through `closest()`, so a selector
 * mapped there but missing here is a skip that is inert IN CHAT ONLY — the
 * `Record` compiles, its own unit tests pass, and the doubled bar comes back on
 * the one surface none of them can see. `code-block-chrome.test.ts` derives that
 * check over the Record rather than re-listing the components, which is the same
 * reason the Record is a Record.
 */
export const COMPONENT_CLASS_ALLOW = new Set([
  "callout", "callout-info", "callout-warn", "callout-good", "callout-bad",
  "callout-title", "callout-body",
  "verdict", "verdict-yes", "verdict-no",
  "pill", "pill-rec", "pill-warn",
  "figure", "figure-body", "caption", "fileref", "tablewrap",
  // CodeTabs markup — kept so the enhancer can find/switch tabs and the CSS
  // applies. (The other tier-1 blocks render as unstyled-but-present markup in
  // the chat re-render, matching the Meter precedent.)
  "code-tabs", "code-tabs-bar", "code-tabs-tab", "code-tabs-panels",
  "code-tabs-panel", "code-tabs-fallback", "code-tab-standalone", "code-tab-label",
  "is-active",
  // ⚠️ `annotated-code` and `filetree` are here for BEHAVIOR, not styling, and
  // that changed with #494: `shouldEnhanceFence` skips a fence whose
  // `closest(OWN_CHROME)` matches one of `COMPONENT_FENCE_CHROME`'s selectors,
  // and `closest` reads the CLASS. Stripped here, the selector can never match
  // in chat, so an `<AnnotatedCode>`/`<FileTree>` answer grows a `.fence-bar`
  // stacked inside the component's own header — the exact doubled bar that
  // Record exists to prevent, on the one surface its unit tests cannot see.
  // (`code-tabs`/`code-tab-standalone`, the other two selectors, were already
  // allowlisted for the tab wiring and were never exposed.) The inner classes
  // ride along so the block is not left unstyled once it is left unwrapped —
  // `annotated-code-file` included, which the first cut of this list dropped:
  // with the outer box styled and the filename header not, a `<AnnotatedCode
  // file="…">` answer rendered its filename as bare body text flush above the
  // code, i.e. WORSE than the uniformly-unstyled block it replaced.
  // `componentClassAllowCoversOwnChrome` in `code-block-chrome.test.ts` is what
  // stops the behavioral half of this drifting again; the inner styling classes
  // are checked by the same file's exhaustive-render case.
  "annotated-code", "annotated-code-file", "annotated-code-panel",
  "annotated-code-notes", "filetree",
  // Fact-check annotation (`<Fact>` marks + the collapsed `<FactCheck>` appendix).
  // `fc-chip-label` in particular is load-bearing: it is the visually-hidden
  // screen-reader label, so a stripped class turns "Claim 1 — confirmed" into
  // visible prose in the middle of the paragraph.
  "fc-mark", "fc-mark-block", "fc-mark-ok", "fc-mark-warn", "fc-mark-bad", "fc-mark-unknown",
  "fc-chip", "fc-chip-ok", "fc-chip-warn", "fc-chip-bad", "fc-chip-unknown", "fc-chip-label",
  "fc-block", "fc-block-body", "fc-strip", "fc-strip-lead",
  "fc-count", "fc-count-ok", "fc-count-warn", "fc-count-bad", "fc-claim",
  // Syntax highlighting. Imported from the module that EMITS them rather than
  // retyped: a `tok-*` class added there and forgotten here renders colorless
  // in chat while looking perfect in /wiki — a bug visible on one surface only.
  ...HIGHLIGHT_TOKEN_CLASSES,
]);

/** The only `id` the sanitizer lets through — the fact-check appendix's per-claim
 *  anchor, which the chip's expand-on-click resolves by id. */
const FC_CLAIM_ID_RE = /^fc-claim-\d+$/;

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
        // Fact-check wiring: the chip needs its claim pointer + expanded state,
        // the claim section needs the anchor the chip resolves, and the chip's
        // glyph stays hidden from assistive tech (the label span carries it).
        if (tag === "button" && (attr.name === "data-fact" || attr.name === "aria-expanded")) continue;
        if (tag === "section" && attr.name === "data-claim") continue;
        if (tag === "section" && attr.name === "id" && FC_CLAIM_ID_RE.test(attr.value)) continue;
        if (attr.name === "aria-hidden" && attr.value === "true") continue;
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

Object.assign(globalThis, { formatWebHtml, renderSlackMrkdwn, sanitizeHtml, enhanceCodeTabs, enhanceCodeBlocks, unwrapCodeBlockChrome });
