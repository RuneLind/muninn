# Web Format — Markdown → HTML + Fact-Check Annotation Layer

`src/web/web-format.ts` converts AI markdown to HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). This file also documents the **fact-check annotation pair**, whose code spans `src/web/`, `src/format/`, `src/wiki/`, and `src/dashboard/` — this is the one authority page for it.

## What counts as a fenced code block

`parseBlocks` (`src/format/markdown-ast.ts`) extracts every fence into a
`FenceStore` and leaves a `\x00CB<id>\x00` placeholder, which the block walker
turns back into a `code_block` only when the placeholder is the WHOLE line
(`CODE_PLACEHOLDER_RE` is anchored). The extractor is therefore a **line walker**,
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

**Placeholder ids are DISJOINT from the input's, and the input is never
rewritten.** One linear scan (`takenCodeIds`) reads every id a `\x00CB<n>\x00` in
the input already spells — by *value*, so a padded `\x00CB007\x00` cannot steal
slot 7 — and the allocator never issues one of them. A forged placeholder
therefore names a slot nothing filled, `store.blocks.get(id)` is `undefined`, and
the walker leaves the line as the text it always was.

That matters because U+0000 *does* occur in the corpus — the live jarvis `log.md`
carries two literal NUL bytes — and a `\x00CB<n>\x00` in the input used to deref
slot `n` and **throw**, taking down the shared renderer for chat, Telegram, Slack
and email at once. **Four designs have defended this and the first three each
shipped their own defect**, which is why the current one looks the way it does:

1. a one-pass sanitiser — *manufactures* a live placeholder out of a nested
   spelling (`\x00C` + `\x00CB0\x00` + `B0\x00` → `\x00CB0\x00`) and throws;
2. the same loop bounded at 10 — at nesting depth 10 it stops early and leaves a
   raw NUL, or, beside any real fence, a **forged duplicate** of that block;
3. unbounded — terminates, but quadratic in *time* (4.8 s on 320 KB, blocking the
   process, per streaming delta);
4. a per-parse `~` **marker** compiled into a per-parse regex — unforgeable, but
   the pattern grew with the input and JavaScriptCore caps a pattern at 2²⁰: a
   1.05 MB page threw `regular expression too large` out of **all six** entry
   points — web, wiki, ask, Telegram, Slack and **email**, the one an earlier
   count of "five renderers" left out, and it threw like the rest (measured to
   the character — 1 048 558 tildes parse, 1 048 559 throw).

Three of those defend a forgeable namespace by rewriting the input and one by
growing the pattern. Disjoint ids need neither: nothing is rewritten, nothing is
built from input, and the placeholder stays a constant handful of characters.
The **total deref is the mechanism, not a backstop** — it is what a forged id
lands on, reachable from a one-line page and pinned as such. `wiki/render.ts` and
`wiki/ask-render.ts` park their own `\x00` sentinels across this call; they carry
no `\x00CB`, so they cannot move an id, and a fallen-through placeholder carries
no `WIKIPAGELINK`/`ASKCITE`, so it cannot collide with either restore.

**Nothing but a backtick refuses an opener**, and that restraint is load-bearing.
A refused opener does not leave "just that line as prose": the fence's closing
delimiter stays in the stream and is itself an opener, so the rest of the
document re-pairs one delimiter over. A review round added a second refusal — an
info string holding a parked wikilink sentinel, to save the link from being
discarded with the rest of the info string — and it swallowed the following prose
and the next code block into one lang-less block. Everything past the lang token
is discarded, sentinel included; that is CommonMark's rule, the same one that
drops `title="x"`.

## Lists and nested lists

`parseList` (`src/format/markdown-ast.ts`) builds one `ul`/`ol` block per list.
`items[k]` is an item's text; `nested[k]` is what sits under it, in source order:
child lists, fenced code and further paragraphs of the item. Renderers get it
through `ListNest`: nested `<ul>`/`<ol>`/`<pre>`/`<p>` inside the `<li>` on web
and email, two spaces per level with a `◦` bullet (numbers kept) on Telegram and
Slack, where code stays unindented and a paragraph follows a blank line at the
item's hanging indent.

- **Opening.** A top-level list opens on `-`, `*` or `N.` (1–9 digits; `+` never
  opens one) indented at most 3 spaces. An indented one opens only at a block
  start (first line, after a blank line, a fence or a heading), so unfenced YAML
  under `config:` and a wrapped `   2024. That…` line stay text. A column-0 item
  opens a list under prose whatever its number (`**Label**` / `4. …` is a list,
  as before nesting); the interruption rule below is for child lists only.
- **Nesting.** An item line indented to the deepest item's child column (2+
  spaces under a bullet, the content column under `N.`) opens a child list.
  Directly under item text the same interruption rule applies, so a wrapped
  `  2024. …` or `  + …` line is text of the item. After a blank line any marker
  opens one. The other marker kind at the same depth starts a second sublist
  under the same item. Nesting stops at 4 levels.
- **Continuation.** A non-item line directly under an item, indented into the
  top-level item, joins the deepest item after a `\n` (a line break in the chat's
  `pre-wrap`, a space in the wiki reader, `<br>` in email, a hanging indent on
  Telegram/Slack). Indent past the content column is kept. An unindented line, a
  table row or a component tag ends the list, as before.
- **Item paragraphs.** After a blank line or a fence in an item, a non-item line
  indented to an open item's content column is a new paragraph (`ListParagraph`)
  of the deepest such item, and the list goes on after it: `2. second` / blank /
  `   more.` / `3. third` is one list of three. Lines directly under it continue
  the paragraph. Indented less than the top-level item's content column, it ends
  the list.
- **Blank lines.** A blank line ends the list unless the next line is an item
  that nests or is a sibling, a fence indented into an item, or an item
  paragraph. Such a list is `loose`: Telegram/Slack keep a blank line between its
  items; web and email render it tight.
- **Fences.** A fence whose opener is indented to an item's child column is code
  in that item, and the list continues after it. Openers indent at most 3
  spaces from column 0, so a fence under a NESTED item (opener at 4+) is not a
  fence: after a blank line its lines, backticks included, are a paragraph of
  that item; directly under the item they are continuation text.
- **Numbers.** `start` is the first item's number (`0.` included). An item that
  does not directly follow its previous item's line keeps its source number in
  `values[k]` (`<li value>`), which is where the old parser split the list and
  restarted. Directly consecutive items count on, as before. The chat sanitizer
  (`web-format-browser.ts`) keeps a numeric `start` and `value`.
- **Columns.** Tabs expand to the next multiple of 4; 5+ spaces after a marker
  put the content column one past the marker (CommonMark).
- **Not items.** `* * *` and `- - -` are rules (at most 3 spaces of indent);
  `***` stays text.

A `<Checklist>` nests the same way (`ChecklistRow.children`): a nested row
without `[ ]`/`[x]` is a plain item (`check-plain`), a nested ordered list keeps
its numbers, and every task row wraps its text in `check-text`: the row is a flex
box, so unwrapped text runs, `<code>` and `<strong>` each became a flex item and a
long row rendered as columns; on a parent row the wrapper also keeps its todo
colour from reaching the rows under it (the mark rules use child combinators). A task
row is a flex box and does not advance an `<ol>` counter, so on the web every row
of an ordered sublist carries its number as `value`.

Slack blanks an empty bullet item where it renders it (`textListItems`'
`blankEmpty`) and a bare `-`/`*`/`•` prose line in the `text` renderer; nothing
after rendering reads code content.

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
  block (CommonMark), so the line stays PROSE and its own backtick runs pair by the
  exact-N rule (an unmatched ``` stays literal); a line-wise scan reads the same
  line as a delimiter and puts the region somewhere else. (Before `parseBlocks`'
  extractor became a line walker the same input diverged for a different reason:
  the mid-line placeholder joined the text either side onto one line.)

Inline code spans pair by CommonMark's rules, but per line: a run of N backticks
closes only on exactly N, an unmatched run stays literal, and one U+0020 is
stripped from each end when both ends are U+0020 and the content is not all
U+0020. A backtick after an odd number of backslashes cannot open a span (the
rest of its run opens one shorter); a closer ignores backslashes. The backslash
itself stays visible, since the renderer processes no backslash escapes.
CommonMark also pairs across a paragraph's soft breaks; this renderer
does not (a known divergence). The fact-check strip shares that grammar via
`src/format/code-spans.ts`.

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

## `<Embed src>` — a markdown page carrying a standalone `.html` explainer

`<Embed src="./x.html" height="640" title="…" />` (self-closing, block-level; `src/format/embed.ts`) lets an `.mdx` page carry an archify diagram or any standalone explainer INSIDE its body, so the narrative page keeps the graph membership an `.html` file never gets (frontmatter, wikilinks, backlinks, Ask/Fact check/Share) while the diagram stays the full interactive viewer. **The server render emits NO iframe**: `formatWebHtml` does not know which page it is rendering, so it cannot resolve a relative `src`, and chat's `sanitizeHtml` has no `iframe` anyway — it emits `<figure class="embed" data-embed-*>` around a fallback line naming the file, and only the wiki reader's `enhanceEmbeds` (`views/components/wiki-embed.ts`) swaps that line for the explainer view's exact sandboxed frame (`EXPLAINER_SANDBOX` = `allow-scripts allow-popups allow-downloads`, no `allow-same-origin`), resolved against the OPEN page's relPath (`..` allowed, escaping the root refused ⇒ the line stays). The gate accepts only a relative `.html` path — no scheme, leading slash, query or fragment — and an invalid tag (bad `src`, OR a `height` that is not 1–5 digits — in-range digits are clamped to 200–4000, not refused) renders as `embed-invalid` ("invalid embed") with no `data-embed-src` at all. **The route half:** `GET /api/wiki/html` resolves through the index first and, when the index lists nothing for a `?relPath=` ending in `.html`, falls back to the path itself — containment judged on the `realpath` of BOTH root and file, since `path.resolve` is lexical and a symlink under the root pointing outside it passed that check and was served (the index never lists a symlink, so the fallback is the only path that reaches one); a NUL byte in `relPath` is a 400 — because the natural shape, `post.mdx` beside `post.html`, is exactly the one stem precedence (`.md` > `.mdx` > `.html`) DROPS from the index, and an index-only lookup 404'd it. `name` lookups get no fallback. **The enhancer also appends an "Open in new tab ↗" link** with the frame's own url — for the same-stem shape it is the only way to the standalone viewer — and because that loads the html as a TOP-LEVEL document, the route's 200 sends `Content-Security-Policy: sandbox <EXPLAINER_SANDBOX>` (the text refusals carry none): the sandbox travels with the bytes, so the new tab is opaque-origin exactly like the frame and a wiki-hosted script cannot reach `/api/*` with the reader's session, while `allow-downloads` keeps the viewer's Export menu working (without it: no download, no error). `EXPLAINER_SANDBOX` lives in its own dependency-free `src/wiki/explainer-sandbox.ts` because the bridge-script module carries a literal `</script>` that closes the inlined reader bundle's tag mid-bundle (pinned in `wiki-render.test.ts`). Slack/Telegram/email render the fallback line as text.

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

## `<Fold title open>` — a collapsible section

`<Fold title="What was measured">` … `</Fold>` is a block component with the
Callout grammar (stands alone, blank line either side, markdown body). Web render
is `<details class="fold"><summary>title</summary><div class="fold-body">…</div></details>`,
CLOSED unless `open="true"` — always double-quoted, because a bare `open` is not
a component tag in this grammar (`COMPONENT_OPEN_RE` parses attributes and
requires quotes) and the section then renders with its tags visible. An empty
title renders `Details`. Email, Telegram and Slack have nothing to collapse, so
they render the title as a run-in heading with the body open, the way the
`<FactCheck>` appendix degrades.

Three couplings, each of which is what a fold is bought with:

- **`MAX_COMPONENT_DEPTH` is 3, not 2.** A fold wrapping a section costs every
  component inside it one level, so at 2 a `CodeTabs > Tab` inside a fold would
  render as a fallback panel while the same markup outside one renders tabs. The
  cap exists for the chat's per-delta re-render, so it was measured
  (`scripts/bench-component-depth.ts`, a plan-shaped page replayed as 200 growing
  prefixes): the two caps land **within a few percent of each other and the sign
  flips between replays**, at ~0.1–0.25 ms per delta either way. Measured
  2026-09-07. No direction is claimed — three independent replays disagreed about
  which cap was faster, which is the finding.
- **The sanitizer needs an `open` clause and three classes.** `sanitizeHtml`'s
  attribute loop is an allowlist, so without `details[open]` an author's expanded
  fold arrives in chat collapsed, and `classIsComponent` drops the whole `class`
  unless every token is in `COMPONENT_CLASS_ALLOW` — `fold`, `fold-body` and
  `fold-heading-dup`. Driven through the real bundle in `e2e/chat-fold.spec.ts`.
- **The doubled label is suppressed, not deleted.** The retrofit convention keeps
  the section's own `##` heading INSIDE the fold (huginn's breadcrumbs cite it,
  Explain's `nearestHeading` finds it, the strip-and-diff guard compares it), so a
  fold titled after its section shows the same words twice. When the body's first
  non-blank block is a heading whose trimmed source equals the title, it renders
  with `fold-heading-dup`, which the fold CSS HIDES — the element stays in the DOM
  because `nearestHeading` walks previous siblings and removing it would move every
  paragraph after it into the previous section. Every other heading renders.
  ⚠️ **It is WEB-ONLY.** Telegram, Slack and email have no CSS, so they print the
  label twice — the run-in title and then the body's own heading. Deliberate: the
  suppression is a `display: none` rule, and the alternative on those surfaces is
  DELETING a heading from the text, which is the thing the web path refuses to do.

⚠️ **A fold the reader toggles in CHAT collapses again on the next streaming delta
and on any history repaint** — `streaming-ui.ts` replaces `innerHTML`, so the
`<details>` element (and its `open` state) is rebuilt. Same class as the existing
fact-check block, and low-impact because `Fold` is outside the model vocabulary:
a chat fold only ever arrives via `/research` markdown, a peer message or a paste.
Not fixed here; fixing it means state the repaint restores, not a render change.

`Fold` is renderer-only and deliberately ABSENT from `COMPONENT_VOCABULARY_RULES`
(defined in `src/research/answer.ts`, imported by `src/ai/prompt-builder.ts`):
folding is an authoring convention for wiki plan pages, and a model folding half a
chat answer is a regression.

**A `.md` page renders one too** — the renderer never reads the extension — which
is why `findExclusionZones`' `isMdx` is derived from
`pageHasComponentVocabulary(relPath, diskBytes)` rather than from the extension:
see the `wiki-routes.ts` row of `src/dashboard/CLAUDE.md`.

## Report blocks — `Fold summary=`, `Callout resolved=`, `<Historic>`, line-ref chips

Four wiki-authoring additions, all block-only and all outside `COMPONENT_VOCABULARY_RULES`:

- **`<Fold title="…" summary="…">`** — a one-line teaser in `<span class="fold-summary">` INSIDE `<summary>`, so it shows while the fold is closed. The duplicate-heading test still compares the title alone. Email/Telegram/Slack render `title — summary` as the run-in line.
- **`<Callout … resolved="YYYY-MM-DD">`** — a strict, real calendar date (`parseResolvedDate`, over the shared `isCalendarDay` in `src/format/calendar-day.ts`) turns the callout into `<details class="callout callout-good callout-resolved">` whose `<summary>` reads `✓ <date> · <title>`, body collapsed. Any other value is ignored and the callout renders as before, in its own tone. The other surfaces put `✓ <date> · <title>` (`resolvedLeadText`) above the open body.
- **`<Historic since="…" note="…">`** — a new component: `<section class="historic">` with a `historic-stamp` line (`↻ since · note`) and the body in `historic-body`, which the CSS dims by colour (`--text-soft`, headings `--text-secondary`) until hover/focus-within — not by opacity, which faded a chip inside to 2.50:1 (light) and 3.65:1 (dark). The stamp sits OUTSIDE the dimmed box so it reads at full contrast. Other surfaces lead with `(historic: since — note)` (`historicLeadText`). A `Historic > Fold > Callout` renders; one more level hits `MAX_COMPONENT_DEPTH` (3), so a `CodeTabs > Tab` inside a fold inside a Historic degrades to its fallback panel. The reader header shows `↻ N historic` (counted off the rendered article by `views/components/wiki-report-blocks.ts`), and a click opens any closed `<details>` around the first one and scrolls to it.
- **Line-ref chips** — reader only, server-side in `renderWikiHtml` (`src/wiki/code-refs.ts`), never in `formatWebHtml`. A **path ref** (`path/File.kt:12`, `File.kt:12-14`, `build.gradle.kts:52,66-67`, en-dash ranges, Unicode names) becomes `code.code-ref` anywhere; a path with no `/` needs a source/config extension from `SOURCE_EXTENSIONS` (or `Makefile`/`Dockerfile*`), so `jarvis.local:8080` and `java.lang:12` stay code. A **bare ref** (`:12`, `:12-40`, `:12, :34`) chips only inside a **pure ref group**: a parenthesised run of nothing but refs and separators (`,` `;` `og` `and`), wrapped — leading space and parens included — in `span.code-ref-group`. A span in a fence, in a `FileRef` (the `renderedCodeRegions` nesting seam) or already in the author's `<a>` is never wrapped in a second link. With a valid frontmatter `code_at: <owner>/<repo>@<7–40 hex sha>` (case-insensitive, lowercased) a path holding `/` links to the GitHub blob at its first line or range: an elided (`.../`) or relative segment, or line 0, chips without a link, a leading segment equal to the repo is dropped, a reversed range is ordered and each segment is percent-encoded. The `line refs` toggle (`views/components/wiki-report-blocks.ts`, shown only on a page with a group) hides the GROUPS alone (`.wiki-article.code-refs-off .code-ref-group`), stored per viewer as `muninn.wiki.lineRefs.v1`, so hiding never leaves `()` or a sentence without its port. `code_at` is in `METADATA_ONLY_FRONTMATTER_KEYS`: re-pinning is not a content edit.

The attribute values (`summary`, `since`, `note`, `title`) are plain text on the web, Telegram and email, escaped as text, so markdown in them renders literally. Slack is the exception: its formatter passes them through `renderInline`, so `title="**bold** and [l](https://x.io)"` renders as mrkdwn (`*…and <https://x.io|l>*`).

The muted text (`fold-summary`, `historic-stamp`, the chips) uses `--text-soft`: `--text-muted` measures under 4.5:1 on the light `--bg-surface` fold fill. `e2e/wiki-report-blocks.spec.ts` pins the token and the contrast in both themes.

## `<NextMoves>` / `<Lane>` — who has the next move

Block-only, wiki-only (not in `COMPONENT_VOCABULARY_RULES`). A `<NextMoves>` holds `<Lane kind="you|waiting|draft|blocked" who="…" since="…">` blocks whose bodies are ordinary markdown. **Authors write steps as list items**: a lane counts its open list items, never its prose.

- **Reading a lane is one function**, `laneFromAttrs` (`markdown-ast.ts`): `kind` is case-folded, and an unknown or missing kind reads as `waiting` with `known: false`; `who` falls back to `LANE_DEFAULT_LABEL` (English — `who` is where the page's language goes) and is also kept as authored (`who`, null when absent). `since` (`parseLaneSince`) takes ISO `YYYY-MM-DD` or the kode-wiki's `DD.MM.YYYY`, normalised to an ISO calendar day; any other value is kept as `sinceRaw` and shown as written, with no age, so a typo never silently disappears.
- **The count** (`items`) is the lane's OPEN steps: every top-level list item that is not `[x]`/`[X]` (a `[ ]` marker is stripped from the text), plus every unchecked top-level row of a `<Checklist>` directly in the lane. Nested items are not steps, and neither is an empty item (`- [ ]` with no text). A lane holding only prose, a table or a callout counts **0** — an empty-state line such as "Ingenting å gjøre nå." must not flag the page (review round 1 reversed the earlier "prose = one step"). The web renderer's `data-count`, the reader's pills and the index's `movesYou` all read that one count.
- **Settled sections do not count.** A `<NextMoves>` inside a `<Historic>` or a resolved `<Callout>` (`isSettledSection`) still renders, but `countedNextMovesLanes` — the one walk the index and `/plans` read — skips it, and the reader's pills skip a block that matches `SETTLED_SECTION_SELECTOR` (`section.historic, details.callout-resolved`). `wiki-report-blocks.test.ts` pins that the selector is exactly those two parts and that each matches this renderer's markup; `e2e/wiki-next-moves.spec.ts` drives both (a lane under `Fold > Historic` and under a resolved `Callout`, 0 pills each).
- **Web**: `<section class="next-moves">` (a size container) → `.nm-grid.nm-cols-N` → one `.nm-lane.nm-<kind>` per lane with `data-kind`, `data-count`, `data-since` (ISO), `data-who` (when authored), a head (`nm-who`, `nm-count`, `nm-since`; `nm-since-raw` for an unparseable `since`) and `nm-body`. The renderer picks the columns from the number of CARD lanes so no count leaves a card alone on a row: 1–3 in one row, 4 as 2×2, 5+ auto-fit; under a 520 px container the grid is one column. A `blocked` lane is not a card: it renders as a full-width, dashed, transparent strip in `.nm-strips` BELOW the grid, whatever its source position. A lane list carrying `[x]`/`[ ]` markers renders through the Checklist markup (`✓`/`✗` marks, `check-done`/`check-todo`; an unmarked item in it is a `check-plain` row) — never a literal `[x]`. An unknown kind adds `nm-kind-unknown`. Non-lane blocks inside `<NextMoves>` render above the grid in `nm-intro`. The `you` lane carries the accent left rule; its label is `--accent-light` because `--accent` as text is under 4.5:1 on the dark panel.
- **Ages are client-side.** The server emits the date only; the reader (`views/components/wiki-report-blocks.ts`, `decorateLaneAges`) turns every dated lane's head into `since N d` (the date itself for a FUTURE day — `daysSince` answers null there, never `0 d`), and appends a `not sent · N d` chip (`.nm-age`) to each open top-level item of a draft lane, counting the viewer's calendar days (`daysSince`, DST-safe, `setFullYear` so years below 100 are not the 1900s). Cached HTML therefore never carries a stale age, and chat (which runs no enhancer) shows the date.
- **Degrades**: a `<NextMoves>` with no `<Lane>` renders its body plain; a `<Lane>` outside one renders as a bold label line (`laneLeadText`) over its body, with no card and no count. **A `<NextMoves>` inside another, at any depth, is not a block**: `tryParseComponent` refuses it, so its tag lines render as literal escaped text and its lanes as stray lanes. Two levels of lanes would otherwise count in the reader's pills (which summed every `.nm-lane`) and not in the index (whose walk never descends into a block) — measured `✋ 3` against `movesYou: 1`. The reader also counts only each top-level block's own lanes (`:scope > .nm-grid > .nm-lane`, `:scope > .nm-strips > .nm-lane`, skipping a block nested in a block), which is redundant while the parser rule holds.
- **Other surfaces**: Slack, Telegram and email render each lane as a bold label line (`Label — since <date>`) followed by its items. The label, and a `since` that is not a date, are the author's plain text, escaped on every target: `escapeHtml` on web, Telegram and email, and `slackLiteral` on Slack — `&`/`<`/`>` as entities (so `<!channel>` is not a mention) and the mrkdwn delimiters `*`, `_`, `~`, `` ` `` swapped for look-alikes (U+2217, U+FF3F, U+223C, U+02CB), since mrkdwn has no backslash escape and a literal `*and*` would close the bold early. Never `renderInline`. The task-mark rendering is web-only: the text targets show `[x]` as written.
- **Depth**: the `NextMoves`/`Lane` pair costs NO depth level, once per path (`childNesting` in the parser): `Fold > Historic > NextMoves > Lane > Checklist` and `Fold > NextMoves > Lane > Callout` both render under `MAX_COMPONENT_DEPTH = 3`. A second `<NextMoves>` on the path is not a block at all (above), so the free pair cannot repeat and the cap still bounds the parse.
- **Chat** renders the grid: the `nm-*` classes are in `COMPONENT_CLASS_ALLOW`.
- **Header pills** (`enhanceReportBlocks`): one per kind with steps, labelled with the first counted lane's own `who` — `✋ Du · 3`, `⏳ Venter på fag · 2`, `✉ Utkast, ikke sendt · 2 · 1 d` — so the pill states the page's perspective, not the viewer's; only a lane with no `who` gets the English default (`✋ N for you`, `⏳ waiting · N`, `✉ N not sent · <oldest age> d`). Each opens any closed `<details>` around its first lane and scrolls to it. Blocked lanes get no pill.

`e2e/wiki-next-moves.spec.ts` pins the layout (three cards in one row plus the blocked strip at 1440, one column at 390 in focus mode), the pills, the ages under a fixed clock and timezone, settled (Historic and resolved Callout), nested and prose-only lanes, the pill = `movesYou` = board badge agreement, task marks, the superseded/abandoned board cards, and the contrast of every lane text and pill in both themes.

## `<Query>` — one prod query as a card

Block-only, wiki-only (not in `COMPONENT_VOCABULARY_RULES`). `<Query id question answer csv sql run uses>` wraps the reading (any markdown). Pure helpers: `src/format/query-block.ts`; CSV parser: `src/format/csv.ts`.

- **Web**: `<section class="query" id="<anchor>">` with a header (id link, question, answer, `run`, `uses` chips), the body, the result table and a closed `<details class="query-sql">`. The anchor is the NFC id keeping Unicode letters, combining marks and digits, lower-cased (`Q-8` → `q-8`, `Spørring 8` → `spørring-8`); a repeat within one render gets the first free `-2`, `-3` — every card's own slug is reserved first, so `Q-8`, `Q-8`, `Q-8-2` render `q-8`, `q-8-3`, `q-8-2`, and a card whose slug a `CaseBoard` row already holds (`<Query id="Case-A">` beside case `A`) takes the next free suffix too — decided by a pass over `formatWebHtml`'s finished output (`uniqueAnchors`, run after `uniqueCaseAnchors`) — not at render time, because `foldBodyHtml` renders a fold's body twice and keeps one copy. A card without `id` renders with a `Query without id` line and no anchor. Self-closing `<Query … />` is allowed (a result-only query). The reader opens the folds around a `#id` from the URL after the article renders (not on an in-place reload of the same page, such as the fact-check ➕ write), and on `hashchange` (`views/components/wiki-hash-target.ts`, any in-article id).
- **SQL source**: the `sql=` file when set (every body fence stays); otherwise the FIRST `sql` fence that is a direct child of the body moves into the disclosure (`splitQuerySql`).
- **Files come from a lookup, never from IO here.** `formatWebHtml(text, { files })` holds the page's `PageFiles` in a module slot for the synchronous call; `renderWikiHtml` forwards `opts.files`, which only `GET /api/wiki/page` builds (`src/wiki/page-files.ts`). No lookup (chat, gardener preview, digest) ⇒ `Result not loaded here: <file>`. A missing file and one outside the root both read `File not available: <file>`.
- **CSV** (`parseCsv`): LF, CRLF or a lone CR end a row; the final line end makes no row; an empty unquoted line is skipped only when the header has 2+ columns (in a one-column file it is an empty value, psql's NULL); a quoted `""` record is always kept; an unterminated quote returns `warning: "unterminated-quote"`, shown as a line above the table. An empty file renders `Empty file: <file>`.
- **Table**: escaped cells (a line end inside a cell — body or header — is `&#10;`, shown by `white-space: pre-line` and untouched by `collapseBlockSpacing`), header verbatim, at most `QUERY_CSV_MAX_ROWS` (2,000) rows plus a `showing 2,000 of N rows — sorting reorders the rows shown` line, inside a 24rem scroll box with a sticky header. Header-click sorting is the reader's `enhanceQueryTables` (`views/components/wiki-query-table.ts`). Each non-empty cell is (a) a plain number (`parseCellNumber`: a sign or U+2212 minus; a decimal dot or a decimal comma, `2,5` = 2.5; space/NBSP/narrow-NBSP thousands, `1 000`; comma thousands only in exact groups of three, `1,500` = 1500 and `1,234,567.25` — except that `0,ddd` is always a decimal, and a column holding any unambiguous decimal comma (`,d`, `,dd`, `,dddd+`, `0,ddd`) reads its `d,ddd` cells as decimals too), (b) a number of shape (a), white space and ONE unit token of letters, `%` or currency symbols (`0.5 kr`, `-10 x`, `12 %`, `1 500 NOK`), or a number of shape (a) with a glued `%` (`12%`, unit `%`; the shared `parseCellValue`, so since the DeltaTable PR a glued-`%` column sorts by value where it sorted by collation before), or (c) anything else. A column whose cells are all (a) sorts by value; all (a) or (b) with ONE shared unit sorts by the number's value; such a column is marked `query-num` and right-aligned. Every other column sorts by `Intl.Collator("nb", {numeric: true})`, which compares each digit run as a number, up to 254 digits (`MEL-9` < `MEL-10`, `10.0.0.9` < `10.0.0.10`, `v1.9` < `v1.10`, `1.9.2026` < `1.10.2026`, ISO dates and datetimes in time order). The one cost: a decimal or negative inside a free-text cell of a column that is not (a)/(b) sorts by collation, so `0.5 kr` lands before `0.25 x` in a mixed-unit column. A value-sorted column compares `Number`s, so two integers past 2^53 that round to one value tie and keep file order. The comparator returns −1/0/1, never NaN or ±Infinity. Stable, empty and `NULL`/`[NULL]` cells last in both directions, `aria-sort` on the sorted header, idempotent.
- **Other surfaces** read no file: `Q-8 — <question>` (bold only when there is an id or a question), `Svar: <answer>`, the body, `Resultat: Q-8.csv`. A `` `code` `` span in the question or answer is `<code>` on Telegram and email and keeps its backticks on Slack; the rest is escaped as before.
- **Depth**: `Fold > Query > Fold` parses (depth 0–2).
- **Chat** renders the card (the `query-*` classes are in `COMPONENT_CLASS_ALLOW`) with the not-loaded line.

Muted lines (`query-meta`, `query-rows`, `query-unavailable`, `query-warning`, `query-truncated`, the sort mark) use `--text-soft`; `e2e/wiki-query.spec.ts` pins token and 4.5:1 in both themes, the sort, and the containment refusals.

**The Query explorer** (`views/components/wiki-query-explorer.ts`, reader only): a run of two or more `section.query` siblings with only whitespace between them gets a `.qx-bar` before its first card — a search box (every whitespace-separated term must occur in the card's id, question, answer, body or `uses` values, case-insensitive, NFC; no diacritic folding, and a term is a substring, so `Q-1` also matches `Q-10`) and one `aria-pressed` chip per `uses` value in the run, inside a `role="group"` box labelled "Filter by uses" (none pressed shows all; pressed chips show a card using ANY of them). **What makes a run:** sibling cards with nothing but whitespace between them. A heading, a paragraph or any other text between two cards splits the run, and cards inside a `<Fold>` are siblings only of each other, so they form a run of their own. An HTML comment never splits or joins one: the renderer escapes `<!-- … -->` into visible text. A filtered-out card is `hidden`. `revealHashTarget` dispatches a bubbling `wiki:reveal` (`REVEAL_EVENT`) on the hash target first; a hidden card in a run clears its run's filter on it — search box and chips both — so `#q-n` always lands on a visible card (a re-click on the same hash fires no `hashchange` and reveals nothing). Idempotent (`data-qx` on the cards). No server change.

**In-page references** (`views/components/wiki-ref-links.ts`, reader only, no server change beyond the fragment link below): after the other enhancers and before the hash reveal, the reader links every bare id the page defines — a DecisionLog item's chip text (`D4`, `S1`), a Query card's id (`Q-8`), a CaseBoard case id — and every quoted section title (`«Q2-oppskrift»`, `“…”`, `"…"`) whose words equal a `<Fold>` title or a heading. Ids match whole and case-sensitively (`Q-1` not inside `Q-10`, `D4` not inside `D4-saken`); a quote naming no section is scanned for ids inside it. Every fold and heading without an id gets GitHub's heading slug (`headingSlug`; repeats `-1`, `-2` in document order), so the `](#slug)` links kode-wiki pages already carry resolve; a fold wins over a same-titled heading, and **a key two targets share links nowhere** — a title two folds share (which also keeps a heading of that title from taking it) (fagavklaring's fourteen «Om spørringen»), or an id two DecisionLogs both define (the server suffixes the second anchor `d1-2`, but prose saying `D1` cannot say which). **Not linked:** text in `a`, code, headings, a fold's `summary`, form controls, `svg`/mermaid and `.query-result` (a CSV table is data — on fagavklaring it was 178 of 550 links); a reference inside its own target. Hover (200 ms) or keyboard `:focus-visible` shows a peek card (`.wiki-ref-peek`, `position: fixed`, inside `.wiki-article`, `role="tooltip"` with the link's `aria-describedby` — **not** `role="dialog"`, which `MODAL_SELECTOR` in `wiki-panes.ts` reads as an open modal and which blocked the graph `g` shortcut while a card showed) with the target copied id-free: a decision's text, a query's question/answer/meta, a case row, or a section's teaser plus its opening ~400 characters — **text nodes included, because a paragraph renders as a bare text run, not a `<p>`**. Click (or the card's **Go to ↓**) pushes a hash entry with `pushState` (so the reader's own `hashchange` handler stays out) and calls `revealHashTarget`; **Back** — the `.wiki-ref-back` pill or the browser — restores the scroll position the jump left, matched on popstate by the full URL. On touch the first tap peeks. Escape with a card open is taken in the CAPTURE phase on `window` and stops there — focus mode's own Escape would otherwise also exit focus mode — without `preventDefault`, so only the browser's default action survives — a focused field's own Escape LISTENER does not run while a card is open (no reader field has a native Escape default today), and returning focus to the link does not reopen the card. A card left detached by a pane swap that skipped `enhanceRefLinks` owns no Escape. Accepted: with a card open beside another Escape owner (fact-check card, ★ menu), the first Escape closes only the card. A jump from a legacy `?page=` URL first rewrites that entry to `?relPath=`: wiki-browser's popstate takes the in-place branch only when `relPath` matches, so Back would otherwise refetch the page and land at the top. The stack is dropped when the pane no longer holds the article (an Ask answer, the start view). The card copies no `details`, `iframe`, Query card or CaseBoard, and disables copied checkboxes. `hidePeek` clears its state BEFORE `remove()`: removing a card that holds focus fires `focusout`, which re-enters it, and a second `remove()` throws. A server-rendered `<a href="#id">` joins in only when its target is inside the article and of a kind the peek knows (a `#wikiList` link stays a plain link). `formatWebHtml` renders `[label](#fragment)` as a same-tab link (a fragment with whitespace stays text); the CHAT sanitizer strips any non-http `href`, and now replaces an `<a>` left without one: by a `<span>` carrying its class when an allowlisted class survived (a DecisionLog `dl-id`, Query `query-id` or CaseBoard `cb-id` chip keeps its pill — unwrapping it glued `D4` to the decision text), by its bare text otherwise (`[x](#d4)`), instead of a link-styled anchor that goes nowhere. On `/research` and a wiki Ask answer, which do not sanitize, it stays a live same-tab hash link. `revealHashTarget` opens the target itself when it is a `<details>` (a fold addressed by its own id) and flashes it with `wiki-hash-flash` — `:target` cannot tint on a fresh load, because the article renders after the browser matched the hash. The class comes off on the target's OWN `animationend` (the event bubbles from descendants). Pinned by `e2e/wiki-ref-links.spec.ts`; the matcher and slug are unit-tested.

## `<CaseBoard>` and `<DeltaTable>` — tracked cases and run-to-run numbers

Block-only, wiki-only (not in `COMPONENT_VOCABULARY_RULES`). Both read their file through the same `PageFiles` lookup and loader as `<Query>`; an unreadable file is one line inside the block, never the page. **Each attribute reads only its own file kind** (`PAGE_FILE_KIND_EXTENSIONS` in `src/format/query-block.ts`): `Query csv=` and `DeltaTable src=` a `.csv`, `Query sql=` a `.sql`, `CaseBoard src=` a `.yaml`/`.yml`. The renderer checks the ref lexically (`lookupPageFile(files, ref, kind)`), and the loader checks the ref against the kinds that name it and the realpath against the ref's own kind, so `<Query sql="x.yml">` and a `runs.csv` symlinked to a `.yaml` both read `File type not allowed`.

- **`<CaseBoard src="cases.yaml" />`** (`src/format/case-board.ts`): the file is ONE YAML document holding a list of `{id, status, owner?, note?, refs?}`, parsed by `Bun.YAML.parse` (read off `globalThis`, since the chat bundle carries this renderer into a browser that never has a file). A `---` after the first content line, or content after a `...` document end, is several documents and reads `Multiple YAML documents (---); use one list`; a leading `---` and a trailing `...` are fine. Read off the text: Bun's result for several documents is a list of their values, which a list of lists also is. Status is case-folded against `hold`/`wait`/`wrong`/`none`/`ok`; anything else, or none, is an `unknown` pill titled with what was written. An entry that is not a mapping with an `id` key is skipped and counted (`N entries without an id skipped`); an empty id (`id:`, `~`, `null`) is skipped under its own line. **YAML reads some unquoted values as numbers**: `id: 0123` is 123, `0x1F` is 31, `1e3` is 1000, `.inf` is infinity. Such an id still renders, as YAML read it, and ONE warning line names every such value with its field (`id 123, owner 7, refs 12`) and says to quote them. A `note`, `owner` or ref that is a list or a mapping is dropped and counted in its own line. A plain (unquoted) `note` ends at ` #` — YAML reads the rest as a comment — so quote a note that holds one. A YAML error or a non-list top level is one line (`YAML error: Unexpected token: cases.yaml`, `Expected a list of cases: …`). Render: `<section class="caseboard">`, a count strip of the non-zero statuses in that order plus `unknown` (`2 hold · 1 wait · 43 none`), then `.cb-group`s in the same order, one `.cb-row id="case-<slug>"` per case (id link, pill, owner, `note` as inline markdown, `refs` as plain chips). At most 500 rows (`CASEBOARD_MAX_CASES`) with a `showing 500 of N cases` line; the strip counts every case. Every count on the board goes through `formatCount` (`209,710`). **Case anchors**: `case-` + `anchorSlug(id)`, a repeat suffixed `-2`, `-3` among the board's cases in FILE order, before the status grouping (`parseCaseBoard`), so a status change never moves a suffix; every case's own anchor is reserved first, so `A`, `A`, `A-2` render `case-a`, `case-a-3`, `case-a-2`. A second board repeating an earlier board's anchor gets the next free suffix (`uniqueCaseAnchors`, a pass over the output). **A case and a Query card never share an id**: the case passes run first and `uniqueAnchors` then gives a card whose slug a case holds the next free suffix, so a case never renames itself for a card. A YAML `note` is not page markdown: a `[[wikilink]]` in it stays literal.
- **`<DeltaTable src="runs.csv" better="…" decimal="…" />`** or with a pipe table as its body (`src/format/delta-table.ts`). **The table convention:** the first column is the row label, every later column is one run, oldest on the left; only the LAST TWO run columns that hold a value in some row are compared, so a column headed for a run not made yet (`| T | a | b | 29.10 |` with no data under `29.10`) still renders and is skipped; do not add a change column of your own (it would be compared as the newest run). A table with one run per ROW is not supported. The block adds a `Δ <prev> → <last>` column: absolute (the larger of the two cells' decimals, their unit; a `%` unit is a change in percentage points, `+3 pp`) and the percent of `|prev|` to one decimal, none for a zero base. A change that rounds to zero at its decimals — the absolute at the cells' decimals (`1e-7` → `2e-7`), the percent at one decimal (`+0.001%`) — is written with three significant digits, and the tone comes from the unrounded difference. Cells are read by `parseCellValue` (`src/format/cell-number.ts`), the reading the Query table's client sort uses: a number, a number plus one unit token after white space, or a number with a glued `%` (`12%`; no other glued unit). **A cell's comma, enumerated** (`deltaRowContexts` over `commaKind`): (i) an unambiguous decimal — `,d`, `,dd`, `,dddd+`, `0,ddd`, `1 500,5` — is a decimal; (ii) unambiguous grouping — `1,234,567`, `1,234.5` — is thousands; (iii) a bare `d,ddd`/`dd,ddd`/`ddd,ddd` is ambiguous and reads by, in order: the **`decimal="comma"|"dot"`** attribute; else the ROW's run cells (any (i) cell ⇒ decimal, any (ii) cell ⇒ thousands); else every row's run cells, by the same test; else thousands. A set of cells holding both an (i) and a (ii) cell gives no context, so the next step decides. `decimal=` moves only (iii) cells — `decimal="dot"` leaves `2,5 → 3,1` at `+0,6` — and any other value renders a `dt-warning` line (`Unknown decimal value: …`). So `| Snitt | 1,250 sek | 1,375 sek |` beside `| Maks | 2,5 sek | 3,1 sek |` is `+0,125 sek`, an English `1,500 → 1,750` with no decimal anywhere is `+250`, and a `1,309` count beside a `81,38 sek` row reads `+0,035` unless the table says `decimal="dot"`. The absolute delta writes a comma when its reading is a decimal comma (either cell, or the row's context); the PERCENT separator is per table: a comma when any run cell writes an unambiguous decimal comma, or with `decimal="comma"`. A pipe-body cell is read past ONE wrapping `**…**`, `__…__`, `*…*` or `_…_`, so a bold Sum row keeps its delta and still renders bold. A column blank in the header AND in every row is dropped — a trailing comma on a CSV line makes one — except the label column; a blank header cell over a value keeps its column. A row with a non-empty cell past the header's last cell as written (an escaped `\|` in a pipe body, an over-long CSV line; `parseCsv` pads the header and reports `headerWidth`) is cut to the header width and gets a `more cells than the header` cell (`dt-overflow`) in the delta column — added for it when the table has no delta — instead of a delta. An empty/NULL/non-numeric cell, or two different units, give an empty delta cell. **`better`** is `lower` or `higher` for every row, or a per-row list `better="Metadatafeil=lower; Kandidater=higher"`, matched against the row label trimmed, case-insensitive, NFC, past one wrapping emphasis and with backticks removed (so `` `antallUtenTreff` `` matches `antallUtenTreff=…`); a row the list does not name gets no tone. A label cannot contain `;` (the separator); it may contain `=`, since the direction is read after the last one. A label that matches no row (`better names no row: Kandidatr`) and a label given twice (`better names a row more than once: …`, the last direction wins) each render a `dt-warning` line; a CSV's labels are checked against the rows shown. Any other value renders a `dt-warning` line (`Unknown better value: …`) and no tone. A toned delta is `dt-good`/`dt-bad` (`--tok-str` / `--status-error`) AND carries a visible `✓`/`✗` marker with an accessible name (`role="img"`, `aria-label` better/worse), and the Δ header names the direction (`lower is better`, or `✓ better, ✗ worse — per row`), so good and bad do not rest on colour alone. No change is `dt-flat`. A CSV takes `parseCsv` and the 2,000-row cap through the same reader the Query result uses (`readCsvFile` in `web-format.ts`). With `src` the whole body renders above the table; without it the first direct-child table is the data and the rest renders above it. Fewer than two run columns with a value ⇒ no delta column and a `Two runs are needed for a delta` line. Not handled: semicolon-separated CSVs, thousands grouping in the delta output, and precision past 2^53.
- **Other surfaces** read no file: `Cases: cases.yaml` / `Table: runs.csv` after the body (on Slack the file name is a code span, as the Query `Resultat:` line's is, so `_` and `*` stay as written), and `CaseBoard without src` for a board with no `src`, as on the web; a pipe-table DeltaTable renders as the surface's table with no delta column.
- **Chat** renders both (classes in `COMPONENT_CLASS_ALLOW`) with the not-loaded line for a file. The chat sanitizer strips `role`/`aria-label`, so a chat delta keeps its visible `✓`/`✗` but not the accessible name.

Muted text (`cb-owner`, `cb-ref`, `cb-sep`, `dt-delta-runs`, `dt-delta-dir`, `dt-pct`, `dt-overflow`, `qx-count`) uses `--text-soft`; `e2e/wiki-caseboard.spec.ts` pins token and 4.5:1 in both themes, plus distinct good/bad/flat colours, the markers, pills, chips and the 390px focus layout (the explorer's own children included).

## `<Tldr>`, `<Timeline>`, `<DecisionLog>`, `<RunChecklist>` — list wrappers

Block-only, wiki-only (not in `COMPONENT_VOCABULARY_RULES`), no file read. The grammars are enumerated tables in `src/format/genre-lists.ts`, and its test file holds them as accepted/rejected rows.

- **`<Tldr label="…">`**: the body in a lead box (`section.tldr`, full border with an accent top rule, not a callout's left bar); `label` defaults to `TL;DR`. Placed where the author wrote it.
- **Separator** after a leading date or id: the end of the item; any whitespace (a newline and U+00A0 included), then text; or one of `—` `–` `-` `:` with optional whitespace on either side. So `**D3**—text` and an id alone on the item's first line both count; `D1x` does not.
- **`<Timeline>`** (classes `gtl-*`, because chat's inspector styles `.timeline`/`.tl-item` unscoped): every top-level item of every list directly in the body. The date table, each optionally in one `**…**` that may hold a trailing `:` (`**30.09.2026:**`): `YYYY-MM-DD` with an optional ` HH:MM` and `Z`; `D.M.YYYY`/`DD.MM.YYYY`; and `D.M`/`DD.MM` without a year, only in bold or right before `:`/`—`/`–` (so `1.2 million` stays text; checked against a leap year, so `29.02` passes and `31.04` does not). A real date plus a separator sits on the rail with the date as written as its marker (`gtl-dated`); anything else is `gtl-undated`. Ranges (`**27.–28.09**`) stay undated. Other body blocks render in place.
- **`<DecisionLog>`**: same walk. An item starting with `**<1–3 letters><1–4 digits>**` (or a struck `~~**D1**~~`, which dims) plus a separator gets the id as a chip and `id="<lower-cased id>"`; a whole-item or whole-text `~~strike~~`, or `superseded by Dn` / `erstattet av Dn` (any case) outside code spans, adds `dl-dim`. An item without an id is `dl-noid`, with no anchor. `uniqueLogAnchors` runs last over the output: a repeated id, or one any other element holds (a Query card, a case row), gets `-2`, `-3`.
- **`<RunChecklist>`**: every direct-child list (`ul` or `ol`, an ordered one keeping its numbers) is a step list, and other body blocks render in place between them. The header counts done of the steps over all step lists (`runChecklistSteps` in `markdown-ast.ts`, which leaves out an empty `- [ ]`; a NextMoves lane counts the same rows' unchecked ones). It reads `3 av 7 steg` when an entry under a step carries a Norwegian label (Kommando, Forventet, Stopp hvis), else `3 of 7 steps`. A plain nested entry starting with a label word (Kommando, Command, Forventet, Expect, Expected, Stopp hvis, Stop if; first letter in either case, the rest as written) as `Word:`, `**Word:**` or `**Word**:`, then a space or the end, is a labelled `rc-row`; other entries stay a nested list, keeping their numbers. A command that is exactly one single-backtick span renders as a one-line `<pre><code>`, so the reader's fence chrome gives it a copy button. Below 520px viewport width the label stacks above its value.
- **A fence under a labelled entry is not a code block.** The list parser does not take a fence that deep: with no blank line before it, the fence text joins the entry as literal text, and an entry whose label is alone on its line (`- Kommando:`) loses its label, since the label must be followed by a space or the end; after a blank line it is a literal paragraph inside the entry. Put the fence directly under the step, as a sibling of the labelled rows.
- **Other surfaces**: Tldr is `<label>:` then the body (one trailing `:` on the label is dropped first); Timeline and DecisionLog are the list as written; RunChecklist is the checklist fallback for each step list, the blocks between them in place, labelled entries as ordinary items. Chat renders all four (classes in `COMPONENT_CLASS_ALLOW`); the sanitizer strips the `id`s.

Muted text (`rc-count`, `rc-label`, `dl-dim`) uses `--text-soft`; `e2e/wiki-genre-blocks.spec.ts` pins token and 4.5:1 in both themes, the rail markers, the anchors and the 390px focus layout (no descendant, inline code included, past the article's right edge; inline code in the four blocks wraps with `overflow-wrap: anywhere`). `genre-lists.test.ts` pins that chat's own stylesheet has no rule for any class the four blocks emit.

## `<Question>` — an open question as an answer card

Block-only, wiki-only (not in `COMPONENT_VOCABULARY_RULES`). `<Question id="O3" choices="A|B" to="Name (IDENT)|Name">` wraps the question as the reader should read it. The pure, browser-safe parser is `src/format/question.ts`; the label table (`en`/`no`) is `src/format/question-labels.ts`. The renderer, the wiki linter and the answer route (answer cards PR 2) all read a page through those two modules.

- **State lives in the page's `<DecisionLog>`, never on the block (D6).** `formatWebHtml` runs a pre-pass over the whole page AST (`questionStates`) before it renders any card, since the log usually sits below the question inside a fold. The ONE closing form, outside code spans: whole-word, case-sensitive `Closed`/`Lukket`, a date (`YYYY-MM-DD` or `D.M`/`DD.MM`, optional `.YYYY`, a real calendar day), then `(Dn)` as the next token. `Reopened`/`Gjenåpnet` plus a date reopens. The white space between tokens may hold ONE line break (a hard-wrapped item), never a blank line and never a code span: spans are masked with line breaks (`maskLineCodeSpans`, `src/format/code-spans.ts`), and a span is at least three characters. The item is read in NFC, with its nested sub-bullets and paragraphs as part of it. The last canonical phrase in the item wins. A close naming a `D` id some `<DecisionLog>` on the page defines is `decided`; any other id is `closed`. With no canonical phrase, an item `parseLogItem` dims is `closed`, else `open`. The first item carrying an id decides it; lint names the later ones. A D id defined only in a nested sub-item is not a decision the page defines: it gets no anchor, so its `→ Dn` link would land nowhere. `parseQuestionPage` is the one page parse the renderer, the linter and PR 2's route share. The accepted and rejected shapes are a table in `src/format/question.test.ts`.
- **The card carries NO `id` attribute and is not an ID target** (`wiki-ref-links.ts` `ID_TARGETS`): with one, `uniqueLogAnchors` would rename the DecisionLog item `o3-2`. Its `q-id` chip links the item's FINAL anchor (`retargetQuestionLinks`, after `uniqueLogAnchors`, so a Query card holding `o3` leaves the chip on `#o3-2`), and the `→ Dn` link likewise. An id with no DecisionLog item is a plain `span.q-id`, not a link to nothing. The reader's ref-link enhancer adopts the chip, so its colour comes from `a.wiki-ref` (`--accent-light`).
- **The hash input** (`ParsedQuestion.hashInput`, PR 2's `question_hash`) is the normalized body plus the parsed choices. The body joins a paragraph or list item across soft wraps, so a reflow does not change it; code-block content and indentation, heading levels, list markers and paragraph boundaries are kept. `to=""` or `to="|"` names nobody and falls back to `questions_to:`.
- **A `[[wikilink]]` in `choices=` or `to=`** reaches the data attributes as source text: `renderWikiHtml` restores a parked sentinel inside an attribute value as the escaped literal, never as link HTML. Both lists split on `|` outside `[[…]]` (`splitQuestionList`), so `to="[[Page|Alias]] (X1)"` is one target; a reader of `data-question-to`/`-choices` splits with the same function.
- **Two shapes.** With the wiki render option (`question: {questionsTo, language, answerable, owner}`, built by `questionRenderOptionsFor` in `src/wiki/render.ts` and passed by `GET /api/wiki/page` only) it is the card: `section.question.q-<open|closed|decided|noid>`, the label, the id, the state pill (`Decided → D99` links `#d99`), the body, and a `q-for` line naming who it is for (`to=` overrides frontmatter `questions_to:`; neither ⇒ `WIKI_ANSWER_OWNER` on an answerable wiki, else no line). The data attributes are the seam the reader's client hydrates: `data-question-id`, `-state`, `-decision`, `-lang`, `-choices`, `-to` (names only — no ident reaches the page; nothing client-side reads one), `-to-source` (`block`/`page`/`owner`/`none`) and `data-wiki-answerable` (false on a duplicated id, which the POST refuses). Without the option — chat, the gardener preview, the digest — it is `section.question.question-plain`: label, id and body, no state.
- **Answerable per wiki (PR 2).** `/api/wiki/page` passes `answerable` from `WIKI_ANSWER_WIKIS` and, on such a wiki, adds `answers: {answerable, canExport}` to its JSON (`canExport`: role admin; auth off is admin; no owner field, since `WIKI_ANSWER_OWNER` may carry an ident) — but only for a viewer whose zone admits both `GET` and `POST /api/wiki/answers` (`viewerMayUseAnswers`, which asks `decideZone` itself). Since PR 5 role `user` gets the field on `MUNINN_PROFILE=nais`, where the read slice opens GET and POST `/api/wiki/answers` (`WIKI_READ_SLICE_METHOD_ENTRIES`), with `canExport: false`; on `default` role `user` still gets none and makes no answers request. The client keys its controls on that field, never on `wikiToolsRegistered` or the read-only selectors (D14).
- **The answer store (PR 2)**: table `wiki_answers` (migration 082), one row per version, `src/db/wiki-answers.ts`; routes in `src/dashboard/routes/wiki-answers.ts`, their own group `wiki-answers`. The POST resolves the page through the read slice's scope (`resolveScopedPage`), parses it with `parseQuestionPage`, and refuses: a wiki outside `WIKI_ANSWER_WIKIS` (403), an unknown page or question (404), a duplicated id or a closed question (409), a choice outside the parsed set plus `not-sure`, or any choice on a question that declares no `choices` (400 `bad_choice`), a NUL or an unpaired surrogate in `body` or `choice` (400 `bad_text`), a body over 8000 characters (400). A registered wiki whose directory is gone is 503 `wiki_unavailable`, not `no_page`. The author is the session identity, or `WIKI_ANSWER_OWNER` with auth off (unset ⇒ 503); author fields in the body are ignored. An `answerId` edit carries `baseVersion`, the version the client edited from (missing or not a positive integer: 400 `bad_base_version`), and is accepted only from the same `author_user_id` (any write with auth off), never on an admin's say-so. It is stored as exactly `baseVersion + 1`: a base that is not the latest version is 409 `version_conflict`, and of several edits racing from one base the primary key lets exactly one land, the rest 409. The response's `version` is the next edit's base. `question_hash` is sha256 of `hashInput`. The GET returns the latest version per answer with `versionCount`, `exported` (latest version's `exported_at`), `redacted` and the viewer's `mine`, never the author's oid or NAV ident; `&versions=1` adds `earlier` for the author and an admin only. A page whose `choices` spells `not-sure` itself collapses onto the fixed value. Each answer also carries a server-computed `asked` (D2, the O2 v1 rule): its author matched against the question's CURRENT targets (the stored `question_hash` is not consulted) (`resolveQuestionTargets`: `to=`, else `questions_to:`, else the owner — the same function the card's `q-for` line reads) on the NAV ident when both sides carry one, else on the name, NFC-normalized with format characters (`\p{Cf}`: zero-width space, soft hyphen) dropped, case-folded and whitespace-collapsed (`isAskedAuthor`); null when the question names nobody or is gone from the page. `WIKI_ANSWER_OWNER` is read in the target format: `Name (IDENT)` stores the name as the author and keeps the ident for matching.
- **The scanner and redact (PR 5)**: a non-blank `body` (new answer or edit; `choice` is never scanned) goes through `WIKI_ANSWER_SCANNER`'s `scanAnswer(text)` before it is stored (`src/wiki/answer-scanner.ts`): findings ⇒ 422 `{error: "scanner_refused", code, reasons, moreReasons?}` with the scanner's own strings, at most 20 of them and each cut to 300 characters (`moreReasons` counts the rest); a scanner that cannot run (unset on `nais`, a relative path, no export, a throw, a non-array or a sparse one, no answer within `ANSWER_SCAN_TIMEOUT_MS` (5 s)) ⇒ 503 `scanner_unavailable`, never clean. A synchronous infinite loop in a scanner blocks the process and cannot be bounded from inside it. The scan runs last, after every refusal that does not depend on the text (unknown answer, not the author, redacted, stale base), so a flagged edit that would be refused anyway gets that refusal. A scanner's thrown message is never logged (it may quote the answer); its path and error class are, at most once a minute per kind and path. On `default` it runs only when the variable is set. A body that is only white space is stored empty. The three answer POSTs refuse a body over 128 KiB (`WIKI_ANSWER_BODY_LIMIT`, sized from the largest valid answer sent ASCII-escaped, 96 KB) with 413 before parsing it. `POST /api/wiki/answers/redact` `{answerId}` (admin: zone default-deny plus a handler check; JSON-gated; not keyed on `WIKI_ANSWER_WIKIS`, so cleanup survives a wiki leaving the list) empties `body` and `choice` on every version and sets `redacted_at`; unknown ⇒ 404, a repeat ⇒ 200 `alreadyRedacted: true`. An edit and a redact serialize per answer (`src/db/CLAUDE.md`), so an edit that loses to a redact is 409 `answer_redacted`, never an unredacted version after it.
- **Retention (PR 5b, D17)**: `wiki_answers` is a transit buffer — the page and its git history are the record. `sweepWikiAnswerRetention` (`src/db/wiki-answers.ts`) deletes EVERY version of an answer whose latest version was exported more than `WIKI_ANSWER_RETENTION_DAYS` ago, or never exported and saved more than `WIKI_ANSWER_UNEXPORTED_DAYS` ago (an answer exported then edited is unexported), and of every redacted answer. Page-blind, so orphans fall under the same rules. Each age rule runs only when its variable is set, the redacted rule when either is; both unset (the laptop) ⇒ no sweep. Hourly on its own timer (`src/wiki/answer-retention.ts`), not the scheduler tick, which runs only for a Telegram bot and so never on a pod. One transaction per answer under the edit's lock with the rule re-checked, and an edit whose base version is gone is refused 409, so a racing edit leaves the whole answer or nothing (`wiki-answers-retention.test.ts`).
- **The card client (PR 3)**: `views/components/wiki-answer-cards.ts` (DOM) over the pure `wiki-answer-card-model.ts`, run by the reader after `enhanceRefLinks` (so an answer's text is never ref-linked). It does nothing — no fetch — unless the page payload carries `answers.answerable`, and touches only cards with `data-wiki-answerable="true"`. `enhanceAnswerCards` returns a handle (`answers()`, `unexportedCount()`, `loaded()`, `refresh()`, `onChange(cb)`) for PR 4's export button, and is idempotent: a wired section carries `data-answer-cards`, and a second call wires nothing and returns the same handle. One `GET …&versions=1` per page, reloaded after every save. Four rules: **only the newest answers request paints** (a sequence number; an older response is dropped); **a reload repaints only the cards whose data changed**, and a repaint keeps every open log fold; focus on a control the repaint replaces — in the answers (Edit, a log fold, and the edit form nested there), the new-answer composer or the message line (Load again) — returns to that control with its caret and selection, or to the card when the control is gone or disabled (an edit Save the server refuses ends on the card; Load again keeps focus while its load is out, being `aria-disabled`, not `disabled`); focus anywhere else — nothing, outside the card, the question text, the id or decision link, the card itself — is left alone (one e2e per cell, the table in `e2e/wiki-answer-card.spec.ts`); **an edit's `baseVersion` is the version the reader clicked Edit on**, captured then, so a newer version saved meanwhile is a 409, never a silent overwrite; **a card is repainted the moment its POST settles** — the saved answer is folded into the list at once (`mergeSavedAnswer`), and when the reload then fails the card says the answer was saved and offers "Load again". **Five states**: Decided and Closed are the server's pill; otherwise no live (unredacted) answer is Open, any answer whose latest version is neither exported nor redacted is Answered, the rest Copied (`data-answer-state`, `q-answered`/`q-copied`). A closed card hides the composer and Edit, keeps its answers, and adds an `N new` badge (`q-new`) for the unexported, unredacted ones. The **composer** (radios for the parsed choices plus Not sure yet and a Clear choice button once one is picked, a textarea, a code-point counter against `QUESTION_ANSWER_MAX` with a line saying why Save is disabled past it, Save) shows until the viewer has an answer to that question; after that the viewer edits it, in an editor under the answer. One request in flight per card. **Edit** appears on `mine` answers of an open card and starts from the stored choice only while the card still offers it. A 409 `version_conflict` keeps the reader's text, reloads, shows the newer answer above it and rebases the editor on it, so saving again is a deliberate replace. Any other refusal shows the server's `error` sentence and keeps the draft. Focus moves to the answer's Edit after Save (unless the reader moved elsewhere meanwhile) and after Cancel. An answer shows author, local time, asked / not asked (a muted outline, none when `asked` is null), `edited N×` (`versionCount − 1`), the choice chip and the body as escaped plain text (`white-space: pre-wrap`); every `·` separator rides inside its part. The **log fold** (`q-log`) appears only when the server sent `earlier`. An admin (`canExport`) gets **Redact…** on each unredacted answer whose editor is not open, which opens an inline confirm (`q-redact-confirm`: the prompt, tied to the group and to Redact by `aria-describedby`, then Redact and Cancel — no browser dialog) held on the card record. Escape inside the confirm is its Cancel; Edit closes it; a reload that shows its answer redacted or gone closes it. Focus cells for the confirm, in the same table: Redact… opens it with focus on Cancel; Cancel or Escape puts focus back on that answer's Redact…; a redact the server refuses shows a reason by status in the card's language (403, 404, no answer, other) and puts focus back on that answer's Redact…; a redact that works repaints the answer redacted at once and the card holds focus (its Redact… is gone), and when the reload then fails the card says the answer was redacted and offers "Load again". A scanner refusal shows its reasons in the card's message line, with `(+N more)` for the ones the server left out. Strings come from `question-labels.ts` in the card's `data-question-lang`. CSS is the reader-only `questionReaderCss` (`component-styles.ts`), injected by `wiki-page.ts` alone.
- **The export (PR 4)**: `GET /api/wiki/answers/export?wiki=&relPath=` returns `{block, rows, count, orphanCount, again, orphanExport}` for every answer on the page whose latest version is neither exported nor redacted (the card's own `unexportedCount` rule), carrying that latest version, and marks nothing; `again` is the page's last batch `{block, rows, count}` (the rows of its latest `exported_at`, newest version per answer among them, a redacted one as `redacted`, stamped with that `exported_at`), so the reader needs one GET; `orphanExport` is the wiki's orphans as a block of their own `{block, rows, count}`. `&again=1` returns that batch alone, with `orphanCount`. Every GET on an answerable wiki runs the orphan scan ONCE, also when the page has nothing to copy. `?wiki=&orphans=1` lists the wiki's orphans, each with `answerId`, `relPath`, `questionId`, `authorName`, `version`, `createdAt`, `time` (the block's `DD.MM.YYYY HH:MM`), `choice`, `body` and `reason` (`page_gone`/`question_gone`) — enough to copy one by hand; no `asked`, since the question that named who was asked is gone. **An orphan** (O4) is an answer whose LATEST version is neither exported nor redacted and whose relPath no longer resolves, or whose question id is gone from the page while its DecisionLog item is not closed (each distinct relPath parsed once). An exported answer already reached the agent, so a plan moved to `archive/` after its answers were copied adds nothing to the count. `POST /api/wiki/answers/export/confirm` `{wiki, relPath, rows: [[answerId, version], …]}` (1–500 rows, versions 1…2147483647, JSON-gated) resolves the page as the GET does and sets `exported_at = now()` in ONE statement on the listed rows of THAT page and each listed answer's earlier versions where still null — only for a listed `(answerId, version)` that exists on the page, so a version the answer does not have, or an answer on another page, marks nothing. One confirm shares one timestamp, a version saved after the GET stays unexported and a retry marks 0; it answers `{marked}`. **`{wiki, orphans: true, rows}`** (no `relPath`, 400 with one) is the orphan copy's confirm: the route recomputes the wiki's orphans itself and marks only a listed `(answerId, version)` that is the latest version of an orphan right now, on that orphan's own page, plus its earlier versions, in one statement; anything else in `rows` marks nothing. Both are admin only twice over: outside every user zone (PR 5 opens only the bare `/api/wiki/answers` path), and the handlers check the role themselves. The block (`src/wiki/answer-export.ts`): an `<!-- answers · <wiki> · <relPath> · exported <YYYY-MM-DD HH:MM> -->` header, per answer `### <id> — <name> (asked|not asked), <DD.MM.YYYY HH:MM>, chose <choice>, version <n>` (no `chose` without a choice, no label when `asked` is null, `redacted` in place of choice and body) and the body as a `>` blockquote, every line prefixed (CRLF and CR read as line breaks) and otherwise untouched, then `<!-- orphaned answers in <wiki>: N -->`. The orphan block has one `<!-- orphaned answers · <wiki> · exported <YYYY-MM-DD HH:MM> -->` header, no trailer, and each heading ends ` · <relPath>, page gone|question gone`. Times are Europe/Oslo; the labels are English on every wiki. ⚠️ The reader shows an HTML comment as literal text, so an agent writes the answers into a page without the two comment lines (the skills say so). The button (`views/components/wiki-answer-export.ts`, mounted in the breadcrumb row by the reader when `answers.canExport`, unmounted by `renderBreadcrumb`/`hideBreadcrumb` and when a change notice finds it detached): "Copy new answers (N)" with N the unexported answers the cards show, disabled at 0, "Copy again", and "Copy orphaned answers (N)" when the wiki has any. The block is fetched once the cards' first load lands and after every `onChange` — never twice per mount — so the click writes the clipboard synchronously through `copyText`, with the header's time rewritten to the click (`restampAnswerExport`). The confirm stamps the rows with the database's `now()` after the write and a round trip, so the minute Copy again prints can be the next one. A block whose rows differ from the unexported answers the cards show is never copied: the click reloads the cards (whose change notice fetches the block) and says to click again. The confirm runs only after the write succeeds; then rows it marked never go into a block again in that page view, no prefetch started before the confirm may land, Copy again holds the text just copied, and `refresh()` flips the cards to Copied. A failed write marks nothing. A load or stale message clears on the next good fetch. The orphan button runs the same copy-then-confirm over `orphanExport`; its block is stale when it holds a row this view already confirmed (a Copy new answers can mark an orphan whose question left this page), and the click then fetches instead. After an orphan confirm the cards reload and the block is fetched again, also when that reload fails. Acceptance: `e2e/wiki-answer-export.spec.ts`; the click orderings: `wiki-answer-export-mount.test.ts`.
- **Labels follow `.wiki-reader.json` `language`** (`en` default, `no`): `Stilt til`, `Åpent`/`Avgjort`/`Lukket`. A bad value warns and falls back to `en`.
- **Other surfaces**: Telegram, Slack and email render a `Question O3` lead line (English, no state) over the body; email draws it in a bordered box.
- **Lint** (`question-block`, `src/wiki/lint.ts`): a `<Question>` with no id, an id no DecisionLog item carries, an id two `<Question>` blocks share, an id two DecisionLog items carry, an item holding a near-miss close (`closeNearMisses`: a whole-word `Closed`/`Lukket`/`Reopened`/`Gjenåpnet` that starts no canonical phrase, or any whole-word `Besvart`/`Answered`), worded from the state the card shows, and a `questions_to:` written as a YAML block list (`parseFrontmatter` reads only the inline form). Only items that have a `<Question>` are checked, so the free-text closes already in the wikis stay silent. A finding's line is its block's open tag, found by the parser's own test (`COMPONENT_OPEN_RE` on the trimmed line, not self-closing, closed on its line or below, outside fences and frontmatter; an indented tag or one inside an HTML comment counts, as it does for the parser), and placed per id: the Nth block carrying an id gets the Nth tag line carrying it when the two counts agree, else no line.
- **Chat** allowlists `question`, `question-plain`, `q-head`, `q-label`, `q-id` and `q-body` — the plain shape's classes.

`e2e/wiki-answer-card.spec.ts` drives the PR 3 client over the real route and test database: answer, edit and log fold, a closed and a reopened card, a double-click, a stale edit from a second browser (draft kept, then a deliberate re-save), an edit whose base moved under a reload, two reloads in reverse order, a save whose reload fails, a failed first load, focus after Save/Cancel and across a reload, a stale stored choice and Clear choice, the `mine` gate, the in-flight guard by itself, a wiki outside `WIKI_ANSWER_WIKIS` (no answers request), `no` labels, token + 4.5:1 in both themes for the new text-on-tint pairs (the over-cap line and Clear choice included, "not asked" off the warning tint), and the 390px focus layout with no stranded `·`. `e2e/wiki-question-card.spec.ts` drives the reader over a temp wiki: Open, Decided → D99, Closed and reopened cards, the `no` labels, the `o3` anchor left alone, and token + 4.5:1 in both themes for the `--text-soft` lines, the `--accent-light` labels (the no-item `span.q-id` among them, since the enhancer restyles a linked chip) and the state pill on each tint.

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

**Where a mark may LAND — the mark-mode rescue.** A wrapper-only anchor is placed from the claim extractor's quote, and that quote spells a sentence the way it READS (`Norepinephrine acts as…`) while the page spells it with markup (`**Norepinephrine** acts as…`). The exact match misses, `collapseWithMap`'s tier-2 rescue finds it, and the mapped-back range then starts AFTER the opening `**` and consumes the closing one. `collapsedRescueRisk` refuses that — correctly, for a SPLICE. A wrapper splices nothing (`renderInline` leaves a `<Fact>` body in the stream for the bold/link passes, so `<Fact …>**Bold** rest</Fact>` renders as `**Bold** rest` did), so `applyEdits` takes a `RescueMode`: `"splice"` everywhere except `annotateEdits`' pass-2 LOCATOR call, which passes `"mark"`. Three guards make that safe, and all three are load-bearing — the first shipped spelling had only the middle one and two review passes reproduced corrupted RENDERED html:

1. `growOverEmphasisRuns` completes only a construct the range ALREADY cuts (odd run count), one contiguous run, one side, per delimiter character. Growing unconditionally steals a neighbour's delimiters — `See **Alpha**|the middle words|**Beta**` renders as crossed `<strong>`/`<span>` tags.
2. The EMPHASIS family (`*`, `_`, backtick) is checked by run PARITY instead of count equality; the BRACKET family (`[`, `]`, `(`, `)`) keeps count equality in both modes, because wrapping half a `[label](url)` puts the tag inside link markup. The EMPHASIS family is the explicit list and the BRACKET family is derived from it — that direction, so a delimiter added to `RESCUE_DELIMS` for a new construct defaults to the STRICT path rather than silently joining the lenient one.
3. `markSpanRefusal` decides whether the span may be wrapped by **asking the code that will read it**, as THREE properties in a fixed order — the enumeration replaced three per-finding patches. (a) **No new nested annotation**: the mark must not land inside a `[[wikilink]]` TARGET, tested with the SHARED `NESTED_MARKUP_RE` as a DELTA (an already-broken page keeps its claims). `formatWebHtml` resolves no wikilink, so this whole family is invisible to (c); the reachable shape is a range abutting a DANGLING `[[`, which `renderWikiHtml` — having no dangling rejection — pairs with the next `]]`, escaping the opening tag into the link text and orphaning the closer (measured). (b) **The write is reversible**: `stripFactWrappers(wrapped)` must equal `stripFactWrappers(body)`. The strip is zone-aware, so a tag inside an inline code span is preserved by design and the wrapper becomes an orphan that no later run can remove — and (c) is structurally blind to it on a table row, where `parsePipeCells` splits at a `|` inside backticks on BOTH sides so neither render ever pairs the span. (c) **Render-equivalence**: it splices the wrapper the emit site will actually write (one shared `wrapperTextFor`, so the prediction and the write cannot drift), renders both bodies through `formatWebHtml`, strips the mark's own chrome and compares. Equal ⇒ allowed. This replaced three rounds of delimiter bookkeeping, each of which was a MODEL of the renderer and each of which was wrong in a different direction — refusing `user_id` and `2 * 3`; refusing an `*` list bullet; refusing a wholly-bolded sentence (the commonest wrapper anchor there is) while having no rule at all for `[label](url)`, so marking a URL destroyed the link. Worst case measured at 40 ms (a 24 KB page × the claim cap × two renders each), against a 90 s model call. The ONE exemption is a span expanded over a whole `[[…]]`, and it waives **(b) and (c), never (a)** — because (b) and (c) are one disagreement rather than two: `formatWebHtml` and `stripFactWrappers` both read the backticks around a `[[Page]]` as code, while `renderWikiHtml` substitutes the link first, so the reader has a live link where those two have a code span. Marking it whole is the documented trade (cosmetic damage instead of a rewritten link target). ⚠️ **The exemption's flag must describe the FINAL range, not the fact that expansion fired**: the guard runs after expansion and can narrow past the link — the table-cell trim discards a whole cell — and a flag left standing there turns the render comparison OFF for a range holding no link at all. It shipped `<Fact …>` as literal text inside a `<code>`, the exact shape row A of the state-space table exists to refuse, while telling the reviewer the mark had been "expanded to cover the whole [[wikilink]]".

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
- **A table row is TRIMMED to its widest cell, not refused.** A `<Fact>` across the
  pipes really does destroy the table, but a CELL has a wrapper form like any other
  prose — so `markableRange` runs `longestCellRange` (the `longestLineRange` shape
  with the cell separator in place of the newline) instead of refusing. Measured on
  `life/sources/Neurochemical Focus Stack…mdx`, the page the mark-anchoring work came
  from: 4 of its 8 claims were whole-row quotes, every one of whose widest cells marks
  cleanly. The trim runs on any span whose LINE is a table row (`isTableRow`, exported
  from `markdown-ast.ts` so the annotator asks the block parser rather than
  re-spelling the predicate), not only one that owns the line start: a span crossing
  ONE cell boundary needed it just as much and was refused one layer down, at the
  render comparison. Nothing is weakened — the trim's whole job is to hand
  `markSpanRefusal` a range with no `|` in it, and the DELIMITER row needs no rule of
  its own (marking `---` stops `isSeparatorRow` matching, the table stops being a
  table, and the two renders differ). **The predicate is the parser's RUN rule**
  (`isTableRow` + `isSeparatorRow`, both exported from `markdown-ast.ts`): `isTableRow`
  alone is true of a lone `| a | b |` line, which renders as a paragraph, and trimming
  there told the reviewer the mark was "trimmed to one table cell" about a table that
  does not exist. The note likewise fires only when a cell BOUNDARY was actually
  crossed — not on the edge-whitespace trim every branch does.
  **A cell boundary is a `|` OUTSIDE a `[[wikilink]]`**, and that exclusion is
  load-bearing: `[[Target|Label]]` carries a pipe of its own, `renderWikiHtml`
  substitutes the whole link before the table parser runs, and splitting there hands
  the mark a fragment containing the `]]` but not the `[[` — the opening tag lands in
  the link target, whose alias class swallows it. That is the nested-annotation
  damage arriving through the one door the whole-link expansion cannot close:
  expansion runs BEFORE the trim, never after it. Such a cell is then refused anyway
  by the render comparison (`formatWebHtml` resolves no wikilink, so it spreads the
  cell across two `<td>`s) — a false refusal, accepted, because the alternative costs
  a live link. Both directions measured; the state-space table in
  `integrate-mark-growth.test.ts` carries the row.
  A mark written across the pipes BEFORE this trim (#500) is on disk still; the
  `unrendered-fact-mark` lint check (`src/wiki/lint.ts`) reports any page whose
  `countFactWrappers` differs from the `fc-mark` elements `formatWebHtml` renders.
- **Order, and NO refusal at column 0.** Expansion runs FIRST and `markableRange`
  then guards the EXPANDED range, because `ownsLineStart` is evaluated on the span's
  start and expanding leftwards over a `[[` at column 0 is what flips it. The guard
  keeps its two outcomes (shrink past a list/quote/heading marker, trim a table row
  to its widest cell) and deliberately has no third one for an expanded span. Measured through the
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

**Insertion is the trap:** `formatWebHtml` emits NO `<p>` (the wiki renderer's `paragraphGaps` pass in `src/wiki/render.ts` turns the `\n\n` it leaves between two prose paragraphs into `<br><br>`, outside code regions, because `.wiki-article` is not `pre-wrap` the way `.msg-body` is and every run of plain paragraphs rendered as one block until 2026-09-21), so top-level prose is bare text nodes and an inline `.fc-chip` is a DIRECT child of `.wiki-article` — "the block containing the chip" resolves to the chip itself and splices the card mid-sentence (5 of the fixture's 8 chips). `resolveInsertionPoint` therefore advances forward through the following siblings to the next BLOCK-tag element (allowlist) so the card lands after the whole inline run. It returns **`{parent, before}`**, not a bare `{before}`: `parent` is the chip's nearest `.fold-body` ancestor when there is one and the layer otherwise, and `before: null` means append to THAT parent. Without the parent, a chip inside an open `<Fold>` resolved to the layer-level `<details>` and the evidence card landed after the whole fold, pages from the passage. The `.fold-body` lookup is guarded by `layer.contains` — `closest` climbs out of the layer, so a chip in a detached or Ask-pane fold body would otherwise resolve to a parent the article does not own (pinned by its own test; it survived the first mutation round unpinned). The one call site, `toggleChip`, inserts with `point.parent.insertBefore`; `buildCard` and `demoteHeadings` are untouched.

Details that are deliberate, not accidental:
- The toolbar is built even on a page with marks but no appendix (toggle-only — otherwise those chips are inert with no way to turn them off).
- The toggle carries NO `aria-pressed` (its label is the state; both would announce "Hide…, pressed").
- The card gets `id="fc-card-N"` + `aria-controls` on the expanded chip; its left rail is tinted by the claim's verdict.
- Escape closes the card ONLY when focus is already inside the card / its chip / the article (otherwise it steals focus from the search box); focus returns to the chip with `preventScroll` unless the close was keyboard-initiated from within the card.
- Toolbar/card/`fc-off` CSS is the reader-only `factcheckReaderCss` (`component-styles.ts`), injected by `wiki-page.ts` alone — chat and `/research` ship only the shared `.fc-mark`/`.fc-chip`/`.fc-block` rules.

Smoked in `e2e/wiki-factcheck-reader.spec.ts`, unit-tested against a DOM shim in `wiki-factcheck-reader.test.ts`.


<!-- moved out of the root CLAUDE.md by /doctor on 2026-09-08 -->

## The `Web format` entry from the root `CLAUDE.md` module table

Markdown → HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). Fenced code blocks are **syntax-highlighted** through `src/format/highlight.ts` — seven `tok-*` classes, colored from `--tok-*` in `shared-styles.ts`, over the languages the wikis actually use; unknown languages (and `mermaid`, which the reader turns into a diagram) fall through to plain escaping. ⚠️ **The two passes that park a construct BEFORE this pipeline — `renderWikiHtml`'s `[[wikilink]]` and `renderAskAnswerHtml`'s `[n]` citation, both restored by regex over the RENDERED HTML — scope that RESTORE, via `renderedCodeRegions` in `src/format/rendered-code.ts`: outside code the sentinel becomes the link, inside code it becomes the source text.** Without that they were not scoped to prose at all: a resolvable `[[Page]]` inside a fence or inside backticks became a live `<a>` INSIDE `<pre><code>` with the brackets gone from the text, which is altered SOURCE — `code.textContent` is what the copy button hands over. The decision is made on the rendered output and deliberately NOT by scanning the markdown for fences: a scanner cannot see the string the renderer parses, because parking rewrites the body in between (measured: CRLF, a backtick inside a wikilink target, and a mid-line fence each break it, one of them by DE-linking working prose). ⚠️ The chat's `sanitizeHtml` strips a `<span>`'s `class` unless allowlisted, so a token class is added to the exported `HIGHLIGHT_TOKEN_CLASSES` (which `COMPONENT_CLASS_ALLOW` spreads in) and never to the CSS alone — otherwise it renders in `/wiki` and not in chat. The **header bar + copy button** are a client enhancer (`enhanceCodeBlocks`, `views/components/code-block-chrome.ts`) for the harder version of the same reason: `sanitizeHtml` has no `div` in its tag allowlist, so a server-emitted fence wrapper flattens code blocks to plain text in chat. It is idempotent (article swaps and history repaints re-enhance) and skips three things: `language-mermaid` (LOAD-BEARING — `enhanceMermaid` is async, so the `pre` is still a `pre` when this runs); any component that owns its own chrome, via a `Record<ComponentName, string|null>` (`COMPONENT_FENCE_CHROME`) so a new block component is a COMPILE error until classified, rather than the hand-kept list that was incomplete twice; and empty fences (`writeText("")` resolves, so the button emptied the reader's clipboard while reporting success). It copies `textContent` — verbatim source only because of the tokenizer's round-trip property. A CLONE of an enhanced fence must go through `unwrapCodeBlockChrome` first (unwrap, then wrap): the clone carries the wrapper and a dead button, so a marker-strip-and-re-run wraps it again INSIDE the dead one. Also owns the **fact-check annotation pair** (`<Fact>` inline marks + `<FactCheck>` appendix) — the render/write/reader pipeline has several load-bearing traps; **read the fact-check sections above before touching any fact-check rendering, `markdown-ast.ts` strip/count helpers, or `wiki-factcheck-reader.ts`**. `<Fold title="…">` … `</Fold>` is the collapsible section the wiki plan-page convention folds agent detail under — a closed `<details>` on the web (`open="true"`, always double-quoted, renders it expanded), a run-in bold heading with the body open on email/Telegram/Slack, and the reason `MAX_COMPONENT_DEPTH` is 3; it is renderer-only and deliberately absent from `COMPONENT_VOCABULARY_RULES`. `<Embed src="./x.html" />` embeds a standalone `.html` explainer (an archify diagram) inside a markdown page: server render = data attributes + a fallback line, the wiki reader swaps in the explainer view's sandboxed iframe, and `/api/wiki/html` serves a same-stem `.html` the index dropped by exact relPath (`src/format/embed.ts`, `views/components/wiki-embed.ts`).
