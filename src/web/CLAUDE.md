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

**The supersede rule covers `/factcheck/append` too, not just integrate.** Claim numbering is PER RUN and every one of these writes rebuilds the whole block, so ANY route that replaces the sentinel region must strip first — otherwise a `<Fact n="2">` left by an earlier run keeps pointing at a `#fc-claim-2` this appendix fills with an unrelated claim, or (on a shorter run) does not contain at all. The CAS does not catch it: `baseHash` is over the raw file, marks included. So the ➕ route strips + counts on the freshly-read body (via `appendBlockToPage`'s `prepareBody` hook — the strip is fact-check policy, not a property of splicing a sentinel block) and reports the count through the shared `supersededMarksNote`, whose per-route tail exists because ➕ removes marks without replacing them while integrate re-marks from its own claims.

Two things that rule is deliberately NOT scoped by. **It runs on `.md` pages too.** "A `.md` page never carries marks" is an invariant of the write paths (integrate only annotates `.mdx`), not of the file: a hand-edit, or a rename from `.mdx`, lands marks on a `.md`, and gating the strip on the extension left exactly that page with every chip dangling off a rebuilt callout. `stripFactWrappers` is identity on a body with no tag, so a mark-free `.md` write stays byte-for-byte what it was — which is the assertion that pins it. And **the COUNT is taken off the strip ITSELF** (`stripSupersededMarks` returns `{body, removed}`, `removed` = `countFactWrappers(current) - countFactWrappers(body)`), so what the note claims is what the write did, on the same bytes. `removed` therefore means "marks removed by this write", INCLUDING a `<Fact>` quoted inside the old appendix (a `Was:` line): the strip is whole-body, so the tag really does come off — and on integrate apply's `!appendCallout && !wroteWrapper` branch the region even survives, stripped. The earlier spelling counted over a `stripFactcheckBlock`ped body while the strip ran on the full one; they disagree the moment removing the region flips FENCE PARITY, because `buildFactcheckAppendix` does not balance fences and an appendix quoting an unterminated ``` opens a fence running to EOF that makes every mark below it documentation. Measured on that fixture: strip removes 0, old count said 2, and the response, the `log.md` line and the commit subject all announced a deletion the file disproved. Both routes take it from that one helper, so ➕ and integrate can never report different numbers for one page. A strip that removed marks is also named in the `log.md` line and the commit subject, not just in the response: the reader who did not click ➕ finds out there only.

**A mark never lands inside a `[[wikilink]]`.** A claim quote resolving to text
inside a link used to be wrapped where it sat, which put the tags between the
brackets — `[[<Fact n="4" v="ok">Some Page</Fact>]]` — making the MARKUP the link
target: the link dies and the chip renders inside the brackets. It shipped into the
jarvis wiki on 2026-08-10 (three links, one page). The rule now, and it splits by
wrapper path because only one of them can express it:

- **Annotate path (`factSpanForm`).** A span that starts inside a link, ends inside
  one, or sits WHOLLY inside one (the shipped shape) EXPANDS to the link's full
  extent (`expandOverWikilinks`) and is wrapped around the ORIGINAL link —
  `<Fact …>[[Some Page]]</Fact>`. Never a piped retarget: which page the label
  should point at is an editorial decision the annotator has no basis for. A span
  that CONTAINS a link whole needs no expansion and is untouched.
- **What counts as a link, and that is two exclusions.** The scan is line-scoped and
  runs over the code-span-MASKED line (`maskLineCodeSpans`, same-length): a
  backticked `` `[[Old Name]]` `` is a page writing ABOUT a link, and reading it as
  one made a correction on that literal unappliable ("would rewrite the link target"
  about a link that does not exist). And a candidate whose interior carries another
  `[[` is rejected and the scan resumes two chars in — the target class admits `[`
  (as every sibling copy does), so `A [[ b [[ c [[Real Page]]` otherwise paired the
  FIRST opener with the only closer and marked 20 characters nobody checked, running
  the mark across a table's `|` in the process. Same shape `firstDanglingWikilinkOpen`
  (`src/wiki/store.ts`) calls dangling.
- **Order, and NO refusal at column 0.** Expansion runs FIRST and `markableRange`
  then guards the EXPANDED range, because `ownsLineStart` is evaluated on the span's
  start and expanding leftwards over a `[[` at column 0 is what flips it. The guard
  keeps its two outcomes (shrink past a list/quote/heading marker, refuse a table
  row) and deliberately has no third one for an expanded span. Measured through the
  shipped `renderWikiHtml`/`web-format` pipeline, BOTH shapes an expansion produces
  render correctly: `<Fact …>[[Some Page]]</Fact> rest.` is an `fc-mark` span around
  a live `<a class="wiki-link">`, and one owning its whole line is the `fc-mark-block`
  div around the same live link (trap 2 above — both forms must look marked). The
  refusal that shipped first cost the mark on the primary defect shape
  (`[[Some Page]] is a good resource.`), on every tier-3 multi-line quote (those
  ranges start at column 0 by construction) and on any span merely expanded
  RIGHTWARDS. Emitting the BLOCK form instead is not the alternative it looks like:
  through the same renderer, `<Fact …>\n[[Some Page]]\n</Fact> rest.` puts prose
  after the closing tag's line and both tags render as escaped literal text. Live
  output is unmoved either way (re-counted 2026-08-30, 89 inline marks on the jarvis
  wiki, 15 at column 0; an old-vs-new run of the shipped pass over every one of them
  diffs to zero).
- **Two marks cannot claim one link.** Two claims quoting different words inside the
  same link expand to the same extent, so the second edit's `old` duplicates the
  first's and it used to die in `applyEdits` as a generic "overlaps an earlier edit" —
  leaving an appendix section no chip points at, and the gate with no explanation.
  The wrapper-vs-wrapper collision is detected on the POST-expansion ranges and named
  ("expanded over the same [[wikilink]] as claim N — one mark carries both"). There
  is deliberately no wrapper-vs-CORRECTION re-test beside it: it is unreachable by
  construction (see the comment in `annotateEdits`' pass 2).
- **Correction path (`wrapCorrectionText`).** Expansion is not expressible there —
  the wrapper covers `edit.new`, which is not in the page, so expanding a correction
  whose `old` sits inside `[[Target]]` would emit `[[<new text>]]`, inventing a link
  target. A correction crossing a link is refused, and the refusal drops the WHOLE
  EDIT: "the correction still applies unwrapped" is this file's default for a
  refused wrapper, and here that default IS the damage (`[[X]]` → `[[Y]]`, silently,
  downstream of every containment seam). It is therefore tested in `annotateEdits`'
  pass-1 loop, before the wrapping branches — most of them (unknown claim, ❓
  verdict, a claim pass 1 already wrapped) never reach `wrapCorrectionText` at all,
  and those are the paths the rewrite hid on. **And it is NOT gated on `.mdx`:**
  `annotateEdits` runs on annotatable pages only, so the propose route's `.md` branch
  ran `dropLinkCrossingCorrections` over the model's corrections — the guard alone,
  no wrapping — or the rewrite applied unchecked on exactly the pages nothing else
  looks at. Gating a containment check on the extension is the same mistake
  `stripFactWrappers` documents above.
- **`repairNestedFactWrappers`** is the post-splice backstop in the apply route's
  transform (the apply also splices client-echoed edits, which no engine tier
  constrains): it re-nests the shape and warns with the page (counts at `warn`, the
  spans themselves at `debug` — they are page content, and a pod's stdout is a shared
  aggregator). Auto-correct, deliberately not a `writeWikiPage` reject — a page
  DOCUMENTING the bug must stay writable, which is also why fenced, inline-code and
  frontmatter occurrences are left alone. It rewrites only what it parses WHOLE: a
  quote-balanced opening tag (`title="a>b"` cut open by a `[^>\n]*` tail moved the
  brackets into the attribute), non-empty inner text (an empty one emitted the bare
  `[[]]`) and a `]]` not followed by another `]` (which left an orphan bracket);
  anything else is reported instead. Its one known gap is a MULTI-LINE nesting, which
  this repair and the lint check are both line-scoped past — no engine tier can
  produce one. The recurrence detector is the `nested-annotation` lint check
  (`src/wiki/lint.ts`; scheduling + measurements in `src/watchers/CLAUDE.md`), which
  shares this file's shape constant `NESTED_MARKUP_RE` with the repair.

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
