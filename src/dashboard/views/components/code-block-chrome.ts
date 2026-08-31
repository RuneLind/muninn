/// <reference lib="dom" />
/**
 * Client-side chrome for a fenced code block: a header bar carrying the
 * language label and a copy-to-clipboard button.
 *
 * Runs in the /wiki reader (article + Ask/Explain panes), the /research answer
 * pane, the fact-check evidence card and web chat — in chat that means EVERY
 * render site, bot bubbles plus the three cards (Jira draft, Jira Research,
 * research-action prompt), each of which has to call this itself: nothing walks
 * the document for them, and a site that omits the call ships bare fences with
 * every unit test green. NOT every `formatWebHtml` surface: `/jira` renders
 * server-side with no client enhancer at all, so its fences stay bare — a
 * deliberate gap, not an oversight.
 *
 * ⚠️ The `OWN_CHROME` skip below depends on classes SURVIVING the chat
 * sanitizer, which is a coupling in the other direction: all four selectors in
 * `COMPONENT_FENCE_CHROME` must be in `COMPONENT_CLASS_ALLOW`
 * (`chat/views/components/component-class-allow.ts`) or `closest()` cannot match in
 * chat and the block gets the doubled bar anyway. Two of them were missing when
 * #494 shipped, because before it those classes were styling-only.
 *
 * ⚠️ **This is deliberately an ENHANCER, not server-rendered markup.** The chat
 * re-renders every bubble through `sanitizeHtml`, which strips `class` off every
 * tag but `code` unless the value is in `COMPONENT_CLASS_ALLOW`. Measured
 * through the real bundled sanitizer: a server-emitted `<div class="fence">`
 * wrapper survives as a bare `<div>` — `div` IS in the web tag allowlist — with
 * every `fence`/`fence-bar`/`fence-lang`/`fence-copy` class GONE, so the bar and
 * the button render unstyled and the button carries no listener (markup cannot
 * bring one), i.e. a dead Copy button in chat and a perfect one in the reader.
 * Because the enhancer runs after `innerHTML = sanitizeHtml(…)`, everything it
 * builds is past that gate. `enhanceCodeTabs` exists for the same reason; this
 * module mirrors its shape deliberately:
 *
 *  - No-op when a root has no `pre > code` — nothing loads, nothing runs.
 *  - Idempotent via a marker attribute. The re-enhance paths are the wiki
 *    article swap, the Ask-pane history repaint and the chat's own history
 *    render — NOT the streaming delta loop, which sets `innerHTML` and calls no
 *    enhancer at all (`streaming-ui.ts` enhances once, in
 *    `promoteStreamingBubble`).
 *  - Fail-safe: with the enhancer absent the server's plain `<pre><code>` still
 *    renders and is still selectable. The chrome is additive, never required.
 *
 * Fences are skipped for three reasons. **`language-mermaid` — and this skip is
 * LOAD-BEARING, not defensive.** `enhanceMermaid` is asynchronous (it injects a
 * CDN script and awaits it), so at every call site this enhancer runs while the
 * mermaid `pre` is still a `pre`; "we run after mermaid" does not hold, and
 * without the skip a diagram would be wrapped in a header bar reading MERMAID on
 * the HAPPY path, not just a failed one. **A component that owns its own
 * chrome** (`OWN_CHROME` below). And **an empty body**, which has nothing to
 * copy.
 */

import type { ComponentName } from "../../../format/markdown-ast.ts";
import { copyText } from "./copy-path.ts";

/** Marks a wrapped fence. Also the "already done" test. */
const ENHANCED = "data-fence-enhanced";

/** How long the button reads "Copied" before reverting. */
const COPIED_MS = 1600;

const COPY_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="9" rx="1.6"></rect>' +
  '<path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v6a1.5 1.5 0 0 0 1.5 1.5H4"></path></svg>';

const CHECK_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 8.5 6.5 12 13 4.5"></path></svg>';

/**
 * The fence language, from the `language-*` class the markdown renderer emits.
 * Returns `""` for a fence with no info string — the bar still renders, because
 * it carries the copy button, but the label slot stays empty.
 */
export function fenceLanguage(code: Element): string {
  for (const cls of Array.from(code.classList)) {
    if (cls.startsWith("language-")) return cls.slice("language-".length);
  }
  return "";
}

/**
 * Which block component wraps a fence in chrome of its OWN — a tab bar, a
 * file-name header, a bordered tree box — and therefore must NOT get a second
 * header bar stacked inside the first.
 *
 * ⚠️ This is a `Record` over the component vocabulary ON PURPOSE, not a
 * hand-kept selector list. It was a list twice and was incomplete both times:
 * first `.code-tabs` alone, so `<AnnotatedCode>` and `<FileTree>` pages —
 * which exist in mimir today — rendered a doubled bar; then those three, so a
 * standalone `<Tab>` still did. As a `Record<ComponentName, …>` a component
 * added to `COMPONENT_NAMES` is a COMPILE error here until someone classifies
 * it, which is the repo's default-deny idiom (`zones.ts`, `route-groups.ts`).
 *
 * `null` means "owns no chrome, so a fence inside it is an ordinary fence" —
 * a `<Callout>` holding a code block is prose around code, and the reader
 * wants the bar there. The type import is erased at build, so this costs the
 * browser bundle nothing.
 */
export const COMPONENT_FENCE_CHROME: Record<ComponentName, string | null> = {
  CodeTabs: ".code-tabs",
  Tab: ".code-tab-standalone", // a <Tab> OUTSIDE a <CodeTabs> renders its own labelled box
  AnnotatedCode: ".annotated-code",
  FileTree: ".filetree",
  Callout: null,
  Verdict: null,
  Pill: null,
  Figure: null,
  FileRef: null,
  ComparisonTable: null,
  Meter: null,
  Diff: null,
  Checklist: null,
  Fact: null,
  FactCheck: null,
};

const OWN_CHROME = ownChromeSelector(COMPONENT_FENCE_CHROME);

/**
 * The `closest()` selector list, derived so it can never drift from the map.
 * Exported so the empty case — which no module-level const can reach — is
 * reachable from a test.
 */
export function ownChromeSelector(map: Record<string, string | null>): string {
  return Object.values(map)
    .filter((sel): sel is string => sel !== null)
    .join(", ");
}

/**
 * Whether this fence gets chrome. Exported for the unit tests, and `ownChrome`
 * is injectable for the same reason: the guard against an empty selector is
 * otherwise unreachable, since the module-level value is derived from a Record
 * that is never all-`null` in production.
 */
export function shouldEnhanceFence(
  pre: Element,
  code: Element,
  ownChrome: string = OWN_CHROME,
): boolean {
  if (pre.getAttribute(ENHANCED)) return false;
  if (fenceLanguage(code) === "mermaid") return false;
  // `closest("")` throws a SyntaxError, and an all-`null` Record — a legal,
  // compile-clean edit of the map above — makes OWN_CHROME exactly that. The
  // throw escapes `enhanceCodeBlocks` at the first fence, taking the statements
  // chained after it at several call sites with it.
  if (ownChrome && pre.closest(ownChrome)) return false;
  // An empty fence has nothing to copy, and `writeText("")` RESOLVES — so the
  // button reported success while silently emptying the reader's clipboard.
  if (!(code.textContent ?? "").trim()) return false;
  return true;
}

function setButtonState(btn: HTMLElement, state: "idle" | "done" | "failed"): void {
  btn.classList.toggle("is-done", state === "done");
  btn.classList.toggle("is-failed", state === "failed");
  const label = state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  const icon = state === "done" ? CHECK_ICON : COPY_ICON;
  btn.innerHTML = `${icon}<span>${label}</span>`;
  btn.setAttribute("aria-label", `${label} code block`);
}

/**
 * Remove the chrome from every fence under `root`, restoring the bare `pre`.
 *
 * The second half of the same class as `COMPONENT_FENCE_CHROME`: a fence that
 * is ALREADY wrapped and then cloned carries the wrapper, the bar and a dead
 * button (listeners are not cloned) — and stripping the idempotency marker so
 * the enhancer re-runs then wraps it a SECOND time, inside the dead one. That
 * is measured, not theoretical: it is what the first attempt at the fact-check
 * evidence-card fix shipped, two stacked bars with the outer Copy inert.
 *
 * So a clone site calls this FIRST and re-enhances after — unwrap, then wrap.
 * `enhanceCodeTabs` needs no counterpart because it only binds listeners onto
 * server markup; this enhancer builds the markup, which is the whole
 * difference and the reason copying that idiom was wrong.
 */
export function unwrapCodeBlockChrome(root: ParentNode): void {
  // ⚠️ THE SELECTOR BELOW IS WHAT MAKES NESTING WORK — not this `.reverse()`.
  // Measured: dropping `.reverse()` leaves the DOM byte-identical on all eleven
  // shapes probed, because the unqualified `querySelector("pre")` finds the
  // INNER `pre` from the outer wrapper and hoists it, collapsing both. The
  // reverse is belt-and-braces (it makes the innermost collapse first, which is
  // the order that stays correct if the selector is ever narrowed), and saying
  // so matters: crediting it as the mechanism is what would let someone
  // re-narrow the selector "for safety" — the single edit that turns the
  // `fence.remove()` below from tidy-up into data loss.
  const fences = Array.from(root.querySelectorAll("div.fence")).reverse();
  for (const fence of fences) {
    // Deliberately NOT `:scope > pre`. The direct-child form finds nothing when
    // the `pre` sits deeper — a nested pair, or hand-written chrome — and then
    // the branch below DELETES the block. The two lines are coupled.
    const pre = fence.querySelector("pre");
    if (!pre) {
      // Reached only for a wrapper that genuinely holds no code: a bar and a
      // button that can never copy anything. ⚠️ Coupled to the selector above —
      // narrow it and this deletes real code blocks instead (measured:
      // `pres=0, text=""` on a fence whose `pre` is one level deeper).
      fence.remove();
      continue;
    }
    pre.removeAttribute(ENHANCED);
    fence.replaceWith(pre);
  }
}

/** Wire every not-yet-enhanced fence under `root`. */
export function enhanceCodeBlocks(root: ParentNode): void {
  root.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (!pre || !shouldEnhanceFence(pre, code)) return;
    pre.setAttribute(ENHANCED, "1");

    const lang = fenceLanguage(code);

    const wrap = document.createElement("div");
    wrap.className = "fence";

    const bar = document.createElement("div");
    bar.className = "fence-bar";

    const label = document.createElement("span");
    label.className = "fence-lang";
    label.textContent = lang;

    const btn = document.createElement("button");
    btn.className = "fence-copy";
    btn.type = "button";
    setButtonState(btn, "idle");

    let revert: ReturnType<typeof setTimeout> | undefined;
    btn.addEventListener("click", () => {
      // `textContent` is the fence source verbatim — `highlight.ts`'s
      // round-trip property is what makes that true even though the body is a
      // token stream. Copying innerHTML or a re-render would ship spans.
      void copyText(code.textContent ?? "").then((ok) => {
        setButtonState(btn, ok ? "done" : "failed");
        if (revert) clearTimeout(revert);
        revert = setTimeout(() => {
          // An article swap or thread switch within COPIED_MS detaches the
          // button; writing into it then is harmless but pointless.
          if (btn.isConnected) setButtonState(btn, "idle");
        }, COPIED_MS);
      });
    });

    bar.appendChild(label);
    bar.appendChild(btn);

    // Insert the wrapper where the `pre` is, then move the `pre` inside it —
    // `replaceWith` + `appendChild` in this order keeps the fence in document
    // position, which a detach-then-append would lose.
    pre.replaceWith(wrap);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
  });
}
