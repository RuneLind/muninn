# Web Format — Markdown → HTML + Fact-Check Annotation Layer

`src/web/web-format.ts` converts AI markdown to HTML for web chat. Server and browser run the same function: `src/chat/views/components/web-format-browser.ts` imports it and `web-format-client.ts` bundles that, so there is no copy to keep in sync. The fact-check annotation pair's code spans `src/web/`, `src/format/`, `src/wiki/` and `src/dashboard/`; the notes below are its one authority page.

## Detail: `src/web/reference/notes.md`

Detail about one function or one component lives in `src/web/reference/notes.md`, which is not loaded automatically. It also covers `src/format/` and the wiki renderer's components. A `src/<module>/CLAUDE.md` cited inside `notes.md` may now mean that module's `reference/notes.md`. The counts in this section are this file's own (measured 2026-11-03).

- **Search it this way, never plain:** `rg -n -o '.{0,120}<term>.{0,120}' src/web/reference/notes.md`. With the Grep tool: `output_mode: content`, `-o`, the same pattern and that path. Keep the window at 120 chars or less. Lines are long: plain `rg` prints each whole line and plain Grep returns "Omitted long matching line". Do not use `grep -o` here: in a Claude Code shell it returns nothing for this pattern and exits 1, which reads as no note.
- **Before editing a file:** search its basename and the exported functions you are changing; few hits is not full coverage: `web-format.ts` gets 4 lines, none about a component trap. **To look up a topic:** find its heading in the index and search a few plain words of it, never the whole heading.
- **No hit:** zero hits on a basename means no note under that name, not no rule: 7 of the 49 non-test `src/format/*.ts` files have none. Search the file's stem and exported names, then the index, then the neighbouring module's `notes.md`, or its `CLAUDE.md` where it has none; `rg -l <term> src -g '{CLAUDE,notes}.md'` finds which.
- **Read a hit:** `Read` from the hit's line with a limit of about 30 lines, not the whole section: sections run to 32k chars (`<Query>`). A line over about 5,000 chars (8 here, the longest 17,053) goes through this fold step first, with the file's full path. From the repo root a bare `notes.md` prints a valid path to an empty file and exits 0. Then `Read` the printed file with offset and limit, or search it with the same windowed form, `rg -n -o '.{0,120}<term>.{0,120}' <printed path>`: a later Bash call has lost `$t`, and plain `rg` there costs about 2 KB a matching line. `fold -s` breaks at spaces, because plain `fold` splits a path token across lines:

```bash
t=$(mktemp); sed -n '<N>p' src/web/reference/notes.md | fold -s -w 2000 > "$t"; echo "$t"
```

**History:** `git log --follow -- src/web/reference/notes.md` reaches the old file's commits.

## Rules

- Read the fact-check sections of the notes (Fact-check annotation pair, Write side, Reader interaction layer) before touching any fact-check rendering, the `markdown-ast.ts` strip/count helpers, or `wiki-factcheck-reader.ts`.
- Add a new `tok-*` class to the exported `HIGHLIGHT_TOKEN_CLASSES`, never to the CSS alone.
- Every selector in `COMPONENT_FENCE_CHROME` must also be in `COMPONENT_CLASS_ALLOW` (`src/chat/views/components/component-class-allow.ts`), or the skip is inert in chat and the block gets a doubled bar there.
- Build a fence's header bar and Copy button in the client enhancer `enhanceCodeBlocks`, never in `web-format.ts`.
- A new render site that inserts finished `formatWebHtml` or `renderWikiHtml` output calls `enhanceCodeTabs(root); enhanceCodeBlocks(root);` itself: both are client enhancers and nothing walks the document for them. A streaming delta loop deliberately does not: it sets `innerHTML` on each delta, and the finished render enhances once (`promoteStreamingBubble` in `streaming-ui.ts`). Existing finished sites without the pair: `/jira`, the gardener preview, the What's-new card, the `/summaries` fact-check answer.
- A clone of an enhanced fence goes through `unwrapCodeBlockChrome` and is then re-enhanced: unwrap, then wrap. Stripping the marker alone makes `enhanceCodeBlocks` wrap the `pre` in a second `div.fence`: two bars, two Copy buttons, the outer inert.
- Decide whether a parked sentinel sits in code on the RENDERED HTML (`renderedCodeRegions`, `src/format/rendered-code.ts`), never by scanning the markdown for fences: a scanner cannot see the string the renderer parses, because parking rewrites the body in between.
- The renderer takes page files from the `files` lookup, never from IO.
- Keep `Fold` and the other block-only, wiki-only components out of `COMPONENT_VOCABULARY_RULES`: a model folding half a chat answer is a regression.
- When a new reader view adds text the source does not hold, mark that chrome `data-reader-only` (`READER_ONLY_ATTR`): the selection Explain and fact-check send leaves those nodes out, so the server can locate it in the page source. Existing chrome does not all carry it: a Question card's `q-label`, `.fence-bar` and `.qx-bar` do not. A label that stays selectable and must not take a glossary mark joins `SKIP_CLASSES` (`src/format/glossary-view.ts`).

## Traps

- ⚠️ `/wiki` injects this HTML unsanitized, but the chat re-renders every bubble through `sanitizeHtml`, which flattens any tag outside `WEB_TAGS` to its text and removes every attribute it does not allowlist: a `class` not in `COMPONENT_CLASS_ALLOW`, and `data-*` and `id` apart from the few it names. Markup that falls outside those lists renders perfectly in the reader and wrong in chat, with every unit test green. The evidence is an e2e that drives the real bundle: `e2e/wiki-code-highlight.spec.ts`, `e2e/chat-card-fences.spec.ts`, `e2e/chat-fold.spec.ts`.
- ⚠️ The text of a code block is data. `code.textContent` is what the Copy button hands over, what `wiki-mermaid.ts` reads to build a diagram and what the fact-check evidence card clones, so a tokenizer that drops a character is a data bug wearing a styling bug's clothes.
- ⚠️ Prose from `formatWebHtml` is bare text at top level and in component bodies, as in `<div class="callout-body">\none\n\ntwo\n</div>`, so `.callout-body p` matches no body prose. `<p>` appears only inside list items, which a component body can hold, and in a component's own labels and notices. An inline element can be a direct child of `.wiki-article`, so "the block containing X" can resolve to X itself.
- ⚠️ The chat bundle carries this renderer into a browser, so what `web-format.ts` imports statically has to run there: `case-board.ts` reads `Bun.YAML` off `globalThis` for that reason. The decision chain, PR strip and question grid ARE in the bundle, imported statically and called only with `views: true`. Chart, rule tree, system map, case dots, diagram, steps and timeline lanes reach `formatWebHtml` as options `renderWikiHtml` passes on `GET /api/wiki/page`, so the bundle does not carry them. Glossary marks are a post-pass in `renderWikiHtml`, outside `formatWebHtml`.
- ⚠️ In chat, `streaming-ui.ts` replaces `innerHTML` on every streaming delta and calls no enhancer until `promoteStreamingBubble`, so DOM state such as a `<details>` element's `open` is rebuilt by the next delta and by any history repaint.

Rules and traps about one function stay in their section of the notes; ` [trap]` in the index below sends you there before you edit that code.

## Index

` [trap]` marks a section that records a failure or hazard; an unmarked section can still hold a rule, so search before you edit.

- What counts as a fenced code block [trap]
- Lists and nested lists [trap]
- Syntax highlighting in fenced code blocks [trap]
- Wikilinks and `[n]` citations are parked BEFORE rendering — and restored SCOPED [trap]
- `<Embed src>` — a markdown page carrying a standalone `.html` explainer [trap]
- Code-block chrome (header bar + copy) [trap]
- `<Fold title open>` — a collapsible section [trap]
- Report blocks — `Fold summary=`, `Callout resolved=`, `<Historic>`, line-ref chips [trap]
- `<NextMoves>` / `<Lane>` — who has the next move [trap]
- Decision chain and PR strip (`views`, the reader's page render only) [trap]
- Question grid (`views`, the reader's page render only) [trap]
- `<Chart kind>` — a chart over the pipe table it wraps (MDX visual components PR 3)
- `<RuleTree title outcomes>` — a rule drawn as a tree over the list it wraps (MDX visual components PR 4)
- `<Glossary>` — terms marked where the page uses them (MDX visual components PR 5) [trap]
- `<CaseBoard view="dots">` — one square per case (MDX visual components PR 5)
- Timeline lanes — the page's dates on one axis (MDX visual components PR 5) [trap]
- `<Diagram src>` — an archify diagram (Wiki visuals v2 PR 2) [trap]
- `<Steps src>` — a diagram stepped through (Wiki visuals v2 PR 3) [trap]
- `<SystemMap>` — an edge table drawn as a map of systems (Wiki visuals v2 PR 4)
- `<Query>` — one prod query as a card [trap]
- `<CaseBoard>` and `<DeltaTable>` — tracked cases and run-to-run numbers [trap]
- `<Tldr>`, `<Timeline>`, `<DecisionLog>`, `<RunChecklist>` — list wrappers [trap]
- `<Question>` — an open question as an answer card [trap]
- Fact-check annotation pair [trap]
- Write side [trap]
- Reader interaction layer [trap]
- The `Web format` entry from the root `CLAUDE.md` module table [trap]
