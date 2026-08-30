# Web Format — Markdown → HTML + Fact-Check Annotation Layer

`src/web/web-format.ts` converts AI markdown to HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). This file also documents the **fact-check annotation pair**, whose code spans `src/web/`, `src/format/`, `src/wiki/`, and `src/dashboard/` — this is the one authority page for it.

## What counts as a fenced code block

`parseBlocks` (`src/format/markdown-ast.ts`) extracts every fence into a
`FenceStore` and leaves a `\x00CB<marker><idx>\x00` placeholder, which the block
walker turns back into a `code_block` only when the placeholder is the WHOLE line
(`store.placeholder` is anchored). The extractor is therefore a **line walker**,
not a regex sweep — anything left on a placeholder's line breaks the restore and
serves a raw U+0000 to the browser with the code block gone. Measured across the
two wikis on 2026-08-30 before the walker landed — every `.md`/`.mdx` under
`mimir/` and under `huginn/huginn-jarvis/data/wiki/`, excluding `.git` and
`node_modules` — **42 of 1571 pages leaked 130 NULs**, from two ordinary shapes:
an indented fence (the "code block inside a numbered list") and a fence
delimiter starting mid-line. Both wikis are live working trees and most of the
jarvis wiki is untracked, so the page count drifts daily; mimir `d7b6cdb` /
huginn `7d69031` name the moment rather than a checkout anyone can restore.

**The grammar is tabulated, not described.** `markdown-ast.test.ts`'s "the fence
grammar, tabulated" enumerates every axis — opener indent, run length, info
string, mid-line, closer indent/run/tail, unclosed, the scan memo's edge — and
fails if an axis loses its last row. Read it rather than trusting the summary
below: a review round on this change produced five findings that were all the
same defect, a property of the grammar asserted in a comment instead of computed.

The parts that bite:

- An **opener owns its line**, with at most 3 leading spaces. A 4th space is
  indented code to CommonMark; this AST has no indented-code block, so such a
  line degrades to a paragraph rather than to a fence.
- A **closer is a bare run** of the same character, at least as long as the
  opener's, with nothing but spaces after it. So a 4-backtick fence really does
  need 4 backticks to close, and ```` ``` and more ```` closes nothing.
- The **body is dedented** by the opener's own indent.
- A backtick fence's **info string may not contain a backtick**, so a prose line
  that starts with inline code (```` ```x``` ````) opens nothing. Without that
  rule it swallows the page down to the next bare closer.
- An **unclosed fence is not extracted** — pre-existing behaviour, the old regex
  needed a closer too. It does *not* mean the body is literal: those lines reach
  the ordinary block parser, so a heading, a list or a `<Callout>` inside an
  unclosed fence renders. CommonMark would run it to EOF as code instead; that
  is a separate change (exactly one page in 1571 carries an unclosed fence).
- A **closer obeys the same ≤3-space indent bound as the opener**, so a closer
  indented 4+ spaces closes nothing and the region degrades to markdown.
- Tildes (`~~~`) are **not** fences here. Neither wiki contains one; adding them
  is a separate change with its own corpus diff.

Two things ride on this that are easy to miss. `lang` is the info string's
leading `[A-Za-z0-9_+#.-]*` run and nothing wider, because
`bot/telegram-format.ts` interpolates it into `class="language-${lang}"` with no
escaping — pinned by the hostile-info-string cases in
`markdown-all-platforms.test.ts`, not by this paragraph.

**The placeholder marker is chosen per parse, and the input is never rewritten.**
`chooseCodeMarker` scans once for the longest run of `~` following a `\x00CB` and
uses one more, so the input provably cannot spell this parse's placeholder. That
matters because U+0000 *does* occur in the corpus — the live jarvis `log.md`
carries two literal NUL bytes — and a `\x00CB<n>\x00` in the input used to deref
`codeBlocks[n]` for an `n` no fence wrote and **throw**, taking down the shared
renderer for chat, Telegram, Slack and email at once.

That was first defended with a sanitiser, and the sanitiser is the lesson: three
review rounds each patched it and each patch had its own defect — one `replace`
pass *manufactures* a live placeholder out of a nested spelling (`\x00C` +
`\x00CB0\x00` + `B0\x00` → `\x00CB0\x00`) and throws; a loop bounded at 10 stops
early at nesting depth 10 and leaves a raw NUL, or, beside any real fence, a
**forged duplicate** of that fence's block; unbounded, it terminates but is
quadratic in *time* (measured 4.8 s on 320 KB of that shape, blocking the whole
process, per streaming delta). The class behind all three was a **forgeable
namespace** that had to be defended by scrubbing. A marker the input cannot spell
removes the need to scrub: nothing is rewritten, so nothing can be reassembled,
mis-forged, or re-scanned, and a literal `\x00CB0\x00` on a page simply stays the
text it always was. `wiki/render.ts` and `wiki/ask-render.ts` park their own
`\x00` sentinels across this call and are unaffected either way.

**Nothing but a backtick refuses an opener**, and that restraint is load-bearing.
A refused opener does not leave "just that line as prose": the fence's closing
delimiter stays in the stream and is itself an opener, so the rest of the
document re-pairs one delimiter over. A review round added a second refusal — an
info string holding a parked wikilink sentinel, to save the link from being
discarded with the rest of the info string — and it swallowed the following prose
and the next code block into one lang-less block. Everything past the lang token
is discarded, sentinel included; that is CommonMark's rule, the same one that
drops `title="x"`.

## Syntax highlighting in fenced code blocks

`code_block` (and `AnnotatedCode`, through the shared `codeFenceHtml`) runs the body through `highlightCode` (`src/format/highlight.ts`), which emits `<span class="tok-*">` for seven token classes; the colors are `--tok-*` in `shared-styles.ts`, so both themes come from one palette and a theme flip costs nothing at render time. Languages are the ones the wikis actually use (ts/js/kotlin/java, sql, shell, json, yaml); `html`, `mermaid`, `diff` and anything unknown fall through to plain `escapeHtml`.

Two properties it is written to hold, both pinned in `highlight.test.ts`:

1. **The rendered text is byte-identical to the source.** `textContent` is what a copy button hands over and what `wiki-mermaid.ts` reads back to build a diagram, so a tokenizer that drops a character is a data bug wearing a styling bug's clothes. Unknown input, unterminated strings and oversized bodies all fall through rather than being partially consumed.
2. **Everything it does not tokenize is still escaped.** It replaced an `escapeHtml(code)` call and is a drop-in for it. The component-fuzz cases that assert "injected markup comes through escaped" now assert on `stripTokenSpans(...)` (`src/test/highlighted-code.ts`) — the fence body is a token stream, so the escaped text is no longer one contiguous substring.

⚠️ **The chat sanitizer is the coupling that bites.** `/wiki` injects this HTML unsanitized (trusted disk content), but the chat re-renders every bubble through `sanitizeHtml` (`web-format-browser.ts`), which strips `class` off a `<span>` unless the value is allowlisted — so a token class missing from `COMPONENT_CLASS_ALLOW` renders perfectly in the reader and colorless in chat, with every unit test green. That list therefore spreads `HIGHLIGHT_TOKEN_CLASSES` in rather than retyping the names, and `e2e/wiki-code-highlight.spec.ts` drives the real bundled `sanitizeHtml` on the real chat page. **Any new `tok-*` class must be added to that exported array, never to the CSS alone.**

## Wikilinks and `[n]` citations are parked BEFORE rendering — and restored SCOPED

`src/wiki/render.ts` and `src/wiki/ask-render.ts` are the only two passes that
swap a construct for a `\x00`-delimited sentinel before `formatWebHtml` and
restore it by regex over the RENDERED HTML. The restore was not scoped to prose,
so a wikilink written inside a fence or inside backticks came back as a live
clickable `<a>` INSIDE `<pre><code>` with the `[[` `]]` gone from the code's own
text. Both passes now decide PER SENTINEL: outside code it becomes the link,
inside code it becomes the source text, escaped. That restore is TEXT-exact, not
render-exact: `code.textContent` is byte-identical to what an unparked render
produces — which is the acceptance — but the restored run is not tokenized, so a
`[[Page]]` inside a `ts` fence is uncoloured where the surrounding code is not.

The failure this closes is not cosmetic. `code.textContent` is what #494's Copy
button hands over, what `wiki-mermaid.ts` reads to build a diagram and what the
fact-check evidence card clones, so the button handed the reader
`// see Some Page` where the file says `// see [[Some Page]]`. `[1]` is ordinary
syntax in almost every language an Ask answer quotes, so the citation half had
the same shape: `arr[1]` in a fence became a chip and lost its subscript.

Measured 2026-08-30 over mimir + the jarvis wiki (1561 pages): **1495 wikilinks
sit inside code across 57 pages, 522 of them in INLINE spans** — in the jarvis
wiki inline is 99% of the cases, so fences alone would have left the majority
unfixed.

⚠️ **The decision is made on the RENDERED HTML** (`renderedCodeRegions`,
`src/format/rendered-code.ts`), never by scanning the markdown for fences. A
markdown-side scanner was written first, derived from the renderer's own fence
and inline-code regexes, and it was still wrong — because it cannot see the
string the renderer parses: parking rewrites the body in between. Four measured
divergences, all four now regression tests in `render.test.ts`:

- **CRLF.** `parseBlocks` normalizes `\r\n` before matching, so a raw-body scan
  finds no fence at all in a CRLF file and the original bug survives untouched.
- **A backtick inside a wikilink TARGET or LABEL** (`[[x`y]]` — the regex admits
  both). Parking removes it, every later backtick on the line re-pairs one
  position over, an inline span appears that the scan never saw, and a sentinel
  lands inside it.
- **The same shift read backwards**: a link the scan believed was inside code
  stopped being parked, and a working prose link rendered as literal brackets.
  A regression, in the direction the guard exists to prevent.
- **A line SHAPED like a fence delimiter that is not one.** A backtick run that
  does not start its line, or whose info string holds a backtick, opens no fenced
  block (CommonMark), so the line stays PROSE and its own backticks pair into an
  inline span; a line-wise scan reads the same line as a delimiter and puts the
  region somewhere else. (Before `parseBlocks`' extractor became a line walker
  the same input diverged for a different reason: the mid-line placeholder joined
  the text either side onto one line.)

⚠️ **What reading the output costs instead: the scan has to know every container
the renderer uses for code, and there are TWO.** The first revision assumed one,
`<code>`, and was wrong twice — both found by review, not by reasoning:

- **`<Diff>` emits no `<code>` at all.** Its fence becomes
  `<div class="diff-line …">` per line, so a `<code>`-only scan reported no code
  and a wikilink inside a diff came back as a live link — a REGRESSION against
  the markdown-side scanner, which matched the raw ` ```diff ` fence wherever it
  sat. `<Diff>` is live in mimir today.
- **`<code>` NESTS.** `<FileRef>` wraps its already-rendered inline children in
  `<code class="fileref">`, so `` <FileRef>`a` [[P]]</FileRef> `` produces a
  `<code>` inside a `<code>`; pairing an open tag with the NEXT `</code>` closed
  the outer region at the inner's close and left the rest of the FileRef outside
  every region. An earlier revision of this page called non-nesting "the
  RENDERER's property rather than an assumption". It was neither.

So the container set is pinned by a DERIVED test rather than by this list being
hand-maintained: `rendered-code.test.ts` renders a probe inside a fence and
inside a backtick span for EVERY name in `COMPONENT_NAMES` and asserts it lands
in a region, so a component introducing a third container fails there instead of
silently in a reader's browser — the `COMPONENT_FENCE_CHROME` default-deny idiom.
One consequence worth knowing: a `[[wikilink]]` written directly inside a
`<FileRef>` renders literal now, because a FileRef IS a `<code>`.

Cost, measured warm on the same corpus: **18 µs/page, 29 ms for all 1562
rendered pages; 1.8 ms of the 36.2 ms render of the largest page in either wiki
(960 KB).**

The share path had already reached the same conclusion from the other side:
`flattenWikiLinks` (`src/wiki/store.ts`) is code-region-aware for the stated
reason that "a documented `[[wikilink]]` or a relative path in a code sample
survives". The READ path was the odd one out, not the innovator.

⚠️ **This is also why `highlight.ts`'s `SENTINEL` rule is load-bearing rather
than defensive.** A sentinel reaching a fence body is the ORDINARY case here, and
the restore can only put the source text back if the tokenizer left the sentinel
intact and findable.

⚠️ **Known residual, stated because this change is what makes it visible.**
`extractWikilinks` — the LINK GRAPH — does not special-case code and says so
deliberately. So a wikilink that appears only inside a fence now renders as text
while still contributing an outgoing link and a backlink: the reader sees no link
in the article and one in the Connections rail. Measured over both wikis, that is
**7 resolving targets on 5 pages** — the other 529 code-only targets resolve to
nothing and were already invisible to the graph. Not fixed here on purpose:
changing the extractor moves backlinks across every wiki at once, and a fence
that names a page is arguably a reference worth graphing. A separate decision,
not an oversight.

The acceptance, in `render.test.ts` and `ask-render.test.ts`: **a fence's text
equals the bytes on disk**, asserted on the resolvable case as well as the
unresolvable one — only the first tells a real fix from "the dead
`wiki-link-missing` span went away" — plus the browser-level half in
`e2e/wiki-code-highlight.spec.ts`, which reads the CLIPBOARD, the only assertion
that proves what actually leaves the page.

## Code-block chrome (header bar + copy)

The bar and the copy button are built by a CLIENT enhancer,
`enhanceCodeBlocks` (`src/dashboard/views/components/code-block-chrome.ts`),
never by `web-format.ts`. That is forced by the same sanitizer coupling as the
token classes above, one step further. Measured through the real bundled
sanitizer: a server-emitted `<div class="fence">` wrapper is NOT flattened to
text (`div` is in the web tag allowlist) — it survives as a bare `<div>` with
every `fence*` class stripped, so the bar and the button render unstyled and the
button carries no listener, i.e. a dead Copy button in chat and a perfect one in
`/wiki`. Because the enhancer runs after `innerHTML = sanitizeHtml(…)`,
everything it builds is past that gate — the `enhanceCodeTabs` precedent, and the
reason both exist.

⚠️ **The skip in rule 3 below depends on the same allowlist, in the opposite
direction.** `closest(OWN_CHROME)` reads a CLASS, so every selector in
`COMPONENT_FENCE_CHROME` must also be in `COMPONENT_CLASS_ALLOW`
(`chat/views/components/component-class-allow.ts`) or the skip is inert in chat and
the block gets the doubled bar there. `annotated-code` and `filetree` were
missing when #494 shipped — before it those classes were styling-only, and the
allowlist said so in as many words — so a `<AnnotatedCode>` answer in web chat
grew a stacked bar while `/wiki` was correct. Both are allowlisted now, and
`e2e/chat-card-fences.spec.ts` drives the real bundle to keep it that way.

Five rules it lives by, each a defect it prevents:

1. **Idempotent via a marker attribute.** The re-enhance paths are the wiki
   article swap, the Ask-pane history repaint and the chat's history render —
   NOT the streaming delta loop, which sets `innerHTML` and calls no enhancer
   (`streaming-ui.ts` enhances once, in `promoteStreamingBubble`). Without the
   marker a repaint wraps the same fence again: three passes, three nested
   `.fence` wrappers.
2. **`language-mermaid` is skipped, and that skip is LOAD-BEARING.**
   `enhanceMermaid` is asynchronous — it injects a CDN script and awaits it — so
   at every call site this enhancer runs while the mermaid `pre` is still a
   `pre`. "We run after mermaid" does not hold; without the skip a diagram is
   wrapped in a header bar reading MERMAID on the HAPPY path.
3. **A component that owns its own chrome is skipped.** This was a hand-kept
   selector list twice and was incomplete both times — `.code-tabs` alone (so
   `<AnnotatedCode>`/`<FileTree>` pages in mimir grew a doubled bar), then
   those three (so a standalone `<Tab>` still did). It is a
   `Record<ComponentName, string | null>` now, so a component added to
   `COMPONENT_NAMES` is a COMPILE error until classified — the `zones.ts` /
   `route-groups.ts` default-deny idiom. `null` means "a fence in here is an
   ordinary fence" (a `<Callout>` holding code wants the bar).
4. **An empty fence gets no button.** `navigator.clipboard.writeText("")`
   RESOLVES, so the button reported success while silently emptying whatever
   the reader had on the clipboard.
5. **The copy button copies `code.textContent`**, which is the fence source
   verbatim only because of `highlightCode`'s round-trip property — the body is
   a token stream now, so copying `innerHTML` would ship spans into the
   reader's clipboard. `navigator.clipboard` is unavailable over plain HTTP to
   anything but localhost, i.e. exactly how this dashboard is reached on a
   tailnet, so the `execCommand` path is the PRIMARY one there and is unit-
   tested; the e2e runs on `127.0.0.1` and can only ever exercise the other.

⚠️ **Every render site that inserts `formatWebHtml` output must call the pair
itself** — `enhanceCodeTabs(root); enhanceCodeBlocks(root);` — because both are
client enhancers and nothing walks the document for them. Three chat sites did
not, from before this chrome existed: the Jira draft card
(`components/jira-card.ts`), the Jira Research card and the research-action
prompt card (both in `chat/views/page.ts`), so their fences rendered as bare
`pre` blocks with no bar, no Copy and no CodeTabs wiring while every unit test
stayed green — a Jira description routinely carries SQL and log fences. The
failure is invisible server-side, so the acceptance is `e2e/chat-card-fences.spec.ts`
(real page, real bundle, seeded rows, no model call); `jira-card.test.ts` pins the
call and the node it is handed. `/jira` is still the one deliberate gap: it renders
server-side with no client enhancer at all.

A cloned fence is the same class seen from the other side, and copying the
CodeTabs idiom for it is WRONG: `enhanceCodeTabs` only binds listeners onto
server markup, so strip-marker-and-re-run is correct there, while this enhancer
BUILDS the wrapper the clone already carries (with a dead button — listeners
are not cloned). Marker-strip alone makes it wrap a second time inside the dead
one: two bars, two Copy buttons, the outer inert. `wiki-factcheck-reader.ts`
therefore calls `unwrapCodeBlockChrome(clone)` and re-enhances — unwrap, then
wrap.

The chat scopes the wrapper's margin to zero (`.web-content .fence`): `.msg-body`
is `white-space: pre-wrap`, so the source newlines already render a blank line
and the shared 14px doubles it — the rule the chat sheet states for every other
block.

The CSS lives in `shared-styles.ts` beside the token colours. ⚠️ Its selectors
are element-qualified (`div.fence > pre`) on purpose: page sheets are injected
AFTER the shared block, `wiki-page.ts` defines `.wiki-article pre`, and at equal
specificity the later rule wins — so `.fence pre` would lose to the very fill it
replaces. `--bg-code` separates in each theme's own direction (dark goes lighter
than the page, light keeps its well), because `--bg-inset` sits ~2 L* BELOW
`--bg-panel` on dark and left the block with no visible edge at all.

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
- **What counts as a link is whatever the RENDERER resolves, and that is ONE
  exclusion.** The scan is line-scoped and runs over the RAW line. A candidate whose
  interior carries another `[[` is rejected and the scan resumes two chars in — the
  target class admits `[` (as every sibling copy does), so `A [[ b [[ c [[Real Page]]`
  otherwise paired the FIRST opener with the only closer and marked 20 characters
  nobody checked, running the mark across a table's `|` in the process. Same shape
  `firstDanglingWikilinkOpen` (`src/wiki/store.ts`) calls dangling. **Inline code is
  NOT excluded**, and a masked spelling of this scan was a shipped defect: masking
  it made the annotator splice `` `[[<Fact …>Old Name</Fact>]]` ``, i.e. the
  forbidden shape. A backticked link is expanded over and a correction crossing one
  is dropped, exactly as for an unbackticked link.

  ⚠️ **The RENDER-side reason recorded here was true and is now obsolete, and the
  fence sentence beside it was never true.** It read: `renderWikiHtml` substitutes
  wikilinks over the raw body before `formatWebHtml` sees a backtick, so
  `` `[[Old Name]]` `` renders as a live `<a>` inside the `<code>` (measured
  2026-08-30, correct at the time) — *"Fences need no handling here (already an
  exclusion zone), and they are genuinely different: `formatWebHtml` renders a
  fenced block as code, so the substitution is invisible inside one."* The
  exclusion zone is real but it belongs to the **write** path (`matchMaskBody`,
  `integrate-edits.ts`); the **read** path had no such zone and substituted BEFORE
  anything was decided to be code, so a wikilink in a fence was substituted exactly
  like one in a backtick span — a resolvable target became a live clickable link
  inside `<pre><code>` with the brackets gone from the code's own text. That
  sentence is why the bug survived a year. `renderWikiHtml`/`renderAskAnswerHtml`
  scope their RESTORE to prose now (`renderedCodeRegions`,
  `src/format/rendered-code.ts`), so a backticked or fenced link renders as the
  bytes on disk. The ANNOTATOR's behaviour
  is unchanged by that — it still expands over the whole link, because splicing
  inside the brackets is the forbidden shape whether the result is a dead link or
  literal tags in a code span.
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
- **The repair and the lint disagree about INLINE CODE, deliberately.** The repair
  fixes a nesting inside a backtick span (per the renderer measurement above, it is
  live damage: a dead `wiki-link-missing` inside a `<code>`); the lint check masks
  inline code and does NOT report one. The lint's exclusion is kept because pages
  document this bug in quoted examples — measured 2026-08-30, mimir's own plan for
  this fix carries four `[[<Fact` occurrences, two inside a ```markdown fence and
  two in inline code spans, and a check that fires on its own plan document is a
  check nobody reads. It is acceptable because the write side can no longer produce the
  shape inside a code span on any live input (`wikilinkSpansIn` scans the raw line, so a
  backticked link is expanded over — with one measured pathological exception: a `[[[[`
  multi-opener makes writer and renderer diverge and CAN nest; 0 occurrences across both
  corpora 2026-08-30, see the `wikilinkSpansIn` NB) and the backstop repairs the
  client-echoed ones before they reach disk. The residual the lint will not see is a HAND-WRITTEN inline-code
  nesting. FENCED occurrences are skipped by both, and that one is not an asymmetry:
  a fenced block renders as code, so the substitution never happens inside it.

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
