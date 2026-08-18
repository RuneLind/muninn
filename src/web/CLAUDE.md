# Web Format — Markdown → HTML + Fact-Check Annotation Layer

`src/web/web-format.ts` converts AI markdown to HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). This file also documents the **fact-check annotation pair**, whose code spans `src/web/`, `src/format/`, `src/wiki/`, and `src/dashboard/` — this is the one authority page for it.

## Fact-check annotation pair

- `<Fact n="4" v="bad">passage</Fact>` (inline, paired + self-closing) marks a fact-checked passage with a verdict-tinted underline plus a `<button class="fc-chip">`.
- `<FactCheck date=… ok=… warn=… bad=… unknown=…>` renders the appendix as a **collapsed** `<details>` whose per-claim children are wrapped in `<section id="fc-claim-N">` (the ids the reader's client clones into an evidence card, so the evidence lives on the page exactly once instead of being stuffed into `data-` attrs on every chip).

Verdict is DENORMALIZED onto the `Fact` tag on purpose: a streaming block renderer cannot look ahead to the appendix to colour a chip, and one write emits both sides so they can't drift.

**Two rendering traps:**
1. `Fact` is the ONLY inline component wrapping PROSE, so `renderInline` intercepts it and parks just the generated tags, leaving the body in the stream for the bold/link/escape passes; routing it through `inlineComponent` (as `Verdict`/`Pill` correctly are) renders `**1.32 kg**` as literal asterisks.
2. A `Fact` owning its whole trimmed line is claimed by the BLOCK parser (`tryParseComponent` runs before any line-render), so it gets a verdict-coloured left rail instead of an underline — both forms must look marked.

Styles in `src/format/component-styles.ts`; plain-text fallbacks in `telegram-format.ts`/`slack-format.ts`.

The `unknown=` count is the ❓ claims — they get NO `<Fact>` mark and NO appendix section, so without the count a deadline-truncated run renders as a clean ✓/⚠/✗ page; it reads "N not checked" (`FACT_COUNT_WORD`) rather than "unverified", which sounds like a ruling.

## Write side

`stripFactWrappers` (in `src/format/markdown-ast.ts`, beside the tag-shape authority) + `annotateEdits` (`src/wiki/integrate-edits.ts`) + `buildFactcheckAppendix` (`src/wiki/factcheck-context.ts`) — see the fact-check integrate section of `src/dashboard/CLAUDE.md`.

The `stripFactWrappers`/`countFactWrappers` pair — and `isFactWrapperText`, the ONE wrapper-shape authority behind every payload gate on the write path — live in `src/format/markdown-ast.ts` and are **zone-aware**: a `<Fact>` tag inside frontmatter, a fenced code block or an inline backtick span is documentation, not markup, and survives the strip that the integrate apply writes back to disk.

**The supersede rule covers `/factcheck/append` too, not just integrate.** Claim numbering is PER RUN and every one of these writes rebuilds the whole appendix, so ANY route that replaces the sentinel block on an annotatable `.mdx` page must strip first — otherwise a `<Fact n="2">` left by an earlier run keeps pointing at a `#fc-claim-2` this appendix fills with an unrelated claim, or (on a shorter run) does not contain at all. The CAS does not catch it: `baseHash` is over the raw file, marks included. So the ➕ route's annotatable branch strips + counts on the freshly-read body (via `appendBlockToPage`'s `prepareBody` hook — the strip is fact-check policy, not a property of splicing a sentinel block, and the `.md` blockquote branch passes no hook and stays byte-identical) and reports the count through the shared `supersededMarksNote`, whose per-route tail exists because ➕ removes marks without replacing them while integrate re-marks from its own claims.

Golden fixture: `src/wiki/__fixtures__/factcheck-annotated-page.mdx` (+ the acceptance triple `factcheck-creatine-{original.mdx,answer.md,quotes.json}` and the shared `Was:` originals in `factcheck-creatine-originals.ts`).

## Reader interaction layer

`src/dashboard/views/components/wiki-factcheck-reader.ts` (`enhanceFactCheck`, called from `wiki-browser.ts` beside `enhanceMermaid`/`enhanceCodeTabs`):

- Chip → evidence card: a deep CLONE of `#fc-claim-N` with ids, the `data-code-tabs-enhanced` marker and h1–h6 tags stripped — headings are demoted to `div role="heading"` so the reader's `nearestHeading` selection walk can't adopt "❌ Claim 4/8" as a section title.
- A `.fc-toolbar` summary strip whose lead is cloned from the appendix's own `summary.fc-strip` (one authority for the wording — "N not checked" rides along).
- A layer toggle flipping `fc-off` on `.wiki-article` (CSS-class only, nothing rebuilt; `fc-off` also hides the toolbar's own summary, leaving just the toggle).

**Insertion is the trap:** `formatWebHtml` emits NO `<p>`, so top-level prose is bare text nodes and an inline `.fc-chip` is a DIRECT child of `.wiki-article` — "the block containing the chip" resolves to the chip itself and splices the card mid-sentence (5 of the fixture's 8 chips). `resolveInsertionPoint` therefore advances forward through the following siblings to the next BLOCK-tag element (allowlist; `null` ⇒ append) so the card lands after the whole inline run.

Details that are deliberate, not accidental:
- The toolbar is built even on a page with marks but no appendix (toggle-only — otherwise those chips are inert with no way to turn them off).
- The toggle carries NO `aria-pressed` (its label is the state; both would announce "Hide…, pressed").
- The card gets `id="fc-card-N"` + `aria-controls` on the expanded chip; its left rail is tinted by the claim's verdict.
- Escape closes the card ONLY when focus is already inside the card / its chip / the article (otherwise it steals focus from the search box); focus returns to the chip with `preventScroll` unless the close was keyboard-initiated from within the card.
- Toolbar/card/`fc-off` CSS is the reader-only `factcheckReaderCss` (`component-styles.ts`), injected by `wiki-page.ts` alone — chat and `/research` ship only the shared `.fc-mark`/`.fc-chip`/`.fc-block` rules.

Smoked in `e2e/wiki-factcheck-reader.spec.ts`, unit-tested against a DOM shim in `wiki-factcheck-reader.test.ts`.
