/**
 * The class names the chat sanitizer lets through.
 *
 * Its own module, and dependency-free, for one reason: `sanitizeHtml` lives in
 * `web-format-browser.ts`, which is a `Bun.build` ENTRYPOINT whose last line is
 * `Object.assign(globalThis, …)`. Importing that file from a `bun test` to read
 * this set defines six browser globals in the test process — `sanitizeHtml`
 * among them, a DOM-dependent function on `globalThis` in a DOM-less runner.
 * Measured, and harmless today; it is still not a side effect a unit test should
 * pay for reading a `Set` of strings.
 *
 * ⚠️ **`classIsComponent` requires EVERY token to be listed.** The sanitizer
 * strips the whole `class` attribute unless every space-separated token is in
 * here, so a two-token class needs both — `code-tabs-tab is-active` is why
 * `is-active` is a member. That rule is what makes
 * `componentClassAllowCoversOwnChrome` (`code-block-chrome.test.ts`) derive its
 * check from the RENDERED markup rather than from the `COMPONENT_FENCE_CHROME`
 * selector string: a selector naming one token of a two-token class would pass a
 * string check and still be stripped in the browser.
 */

import { HIGHLIGHT_TOKEN_CLASSES } from "../../../format/highlight.ts";

/**
 * Class names emitted by the component renderers. `class` is normally stripped
 * from every tag but `code`; these are preserved so component styling survives.
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
