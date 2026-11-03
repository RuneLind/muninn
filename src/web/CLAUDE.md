# Web Format — Markdown → HTML + Fact-Check Annotation Layer

`src/web/web-format.ts` converts AI markdown to HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). The fact-check annotation pair's code spans `src/web/`, `src/format/`, `src/wiki/` and `src/dashboard/`; the notes below are its one authority page.

## Detail: `src/web/reference/notes.md`

Detail about one function or one component lives in `src/web/reference/notes.md`, which is not loaded automatically. It also covers `src/format/` and the wiki renderer's components. Two ways in, each ending in `Read` with offset and limit on the line numbers you get:

- **Before editing a file:** Grep `notes.md` for the file's basename, with `output_mode: content`, `-n`, `-o` and the pattern `.{0,120}web-format\.ts.{0,120}`.
- **To look up a topic:** find its heading in the index below and Grep for a few plain words of it, never the whole heading. Parens and brackets are regex metacharacters: 12 of this file's 27 headings match nothing verbatim (measured 2026-11-03).

**No hit** on a basename means no note under that name, not no rule: 7 of the 49 `src/format/*.ts` files have no hit here (measured 2026-11-03). Go to the index, then to the neighbouring module's notes: `src/wiki/reference/notes.md`, `src/dashboard/reference/notes.md`, `src/chat/CLAUDE.md`. A module that has not moved its notes yet keeps them in its `CLAUDE.md`.

**Long lines.** Claude Code's Grep tool runs ripgrep with `--max-columns 500`, so a plain search matching a long line returns "Omitted long matching line". The `-o` pattern above returns the text around each match. Keep its window at 120 chars or less, because ripgrep counts the 500-column limit in bytes.

A line too long for `Read` goes to a scratch file first, with the file's full path. From the repo root a bare `notes.md` prints a valid path to an empty file and exits 0. Then `Read` the printed file with offset and limit:

```bash
t=$(mktemp); sed -n '<N>p' src/web/reference/notes.md | fold -w 2000 > "$t"; echo "$t"
```

**History:** `git log --follow -- src/web/reference/notes.md` reaches the old file's commits.

## Rules

- Read the fact-check sections of the notes (Fact-check annotation pair, Write side, Reader interaction layer) before touching any fact-check rendering, the `markdown-ast.ts` strip/count helpers, or `wiki-factcheck-reader.ts`.
- Add a new `tok-*` class to the exported `HIGHLIGHT_TOKEN_CLASSES`, never to the CSS alone.
- Every selector in `COMPONENT_FENCE_CHROME` must also be in `COMPONENT_CLASS_ALLOW` (`chat/views/components/component-class-allow.ts`), or the skip is inert in chat and the block gets a doubled bar there.
- Build a fence's header bar and Copy button in the client enhancer `enhanceCodeBlocks`, never in `web-format.ts`.
- Every render site that inserts `formatWebHtml` output must call `enhanceCodeTabs(root); enhanceCodeBlocks(root);` itself: both are client enhancers and nothing walks the document for them.
- A clone of an enhanced fence goes through `unwrapCodeBlockChrome` and is then re-enhanced: unwrap, then wrap. Stripping the marker alone wraps it again inside the dead button.
- Decide whether a parked sentinel sits in code on the RENDERED HTML (`renderedCodeRegions`, `src/format/rendered-code.ts`), never by scanning the markdown for fences: a scanner cannot see the string the renderer parses, because parking rewrites the body in between.
- The renderer takes page files from the `files` lookup, never from IO.
- Keep `Fold` and the other block-only, wiki-only components out of `COMPONENT_VOCABULARY_RULES`: a model folding half a chat answer is a regression.
- Text a reader view adds that the source does not hold is `data-reader-only` (`READER_ONLY_ATTR`). The selection Explain and fact-check send leaves those nodes out, so the server can locate it in the page source.

## Traps

- ⚠️ `/wiki` injects this HTML unsanitized, but the chat re-renders every bubble through `sanitizeHtml`, which strips a `class` that is not in `COMPONENT_CLASS_ALLOW`. A class missing from that list renders perfectly in the reader and wrong in chat, with every unit test green. The evidence is an e2e that drives the real bundle: `e2e/wiki-code-highlight.spec.ts`, `e2e/chat-card-fences.spec.ts`, `e2e/chat-fold.spec.ts`.
- ⚠️ The text of a code block is data. `code.textContent` is what the Copy button hands over, what `wiki-mermaid.ts` reads to build a diagram and what the fact-check evidence card clones, so a tokenizer that drops a character is a data bug wearing a styling bug's clothes.
- ⚠️ `formatWebHtml` emits no `<p>`. Top-level prose is bare text nodes, and an inline element can be a direct child of `.wiki-article`, so "the block containing X" can resolve to X itself.
- ⚠️ The chat bundle carries this renderer into a browser. A reader-only view (chart, rule tree, system map and the rest) reaches `formatWebHtml` as an option `renderWikiHtml` passes, on `GET /api/wiki/page` alone, so the chat bundle never carries it.
- ⚠️ In chat, `streaming-ui.ts` replaces `innerHTML` on every streaming delta and calls no enhancer until `promoteStreamingBubble`, so DOM state such as a `<details>` element's `open` is rebuilt by the next delta and by any history repaint.

Rules and traps about one function stay in their section of the notes; ` [trap]` in the index below sends you there before you edit that code.

## Index

- What counts as a fenced code block [trap]
- Lists and nested lists
- Syntax highlighting in fenced code blocks [trap]
- Wikilinks and `[n]` citations are parked BEFORE rendering — and restored SCOPED [trap]
- `<Embed src>` — a markdown page carrying a standalone `.html` explainer [trap]
- Code-block chrome (header bar + copy) [trap]
- `<Fold title open>` — a collapsible section [trap]
- Report blocks — `Fold summary=`, `Callout resolved=`, `<Historic>`, line-ref chips
- `<NextMoves>` / `<Lane>` — who has the next move
- Decision chain and PR strip (`views`, the reader's page render only)
- Question grid (`views`, the reader's page render only)
- `<Chart kind>` — a chart over the pipe table it wraps (MDX visual components PR 3)
- `<RuleTree title outcomes>` — a rule drawn as a tree over the list it wraps (MDX visual components PR 4)
- `<Glossary>` — terms marked where the page uses them (MDX visual components PR 5)
- `<CaseBoard view="dots">` — one square per case (MDX visual components PR 5)
- Timeline lanes — the page's dates on one axis (MDX visual components PR 5)
- `<Diagram src>` — an archify diagram (Wiki visuals v2 PR 2)
- `<Steps src>` — a diagram stepped through (Wiki visuals v2 PR 3)
- `<SystemMap>` — an edge table drawn as a map of systems (Wiki visuals v2 PR 4)
- `<Query>` — one prod query as a card [trap]
- `<CaseBoard>` and `<DeltaTable>` — tracked cases and run-to-run numbers
- `<Tldr>`, `<Timeline>`, `<DecisionLog>`, `<RunChecklist>` — list wrappers [trap]
- `<Question>` — an open question as an answer card [trap]
- Fact-check annotation pair [trap]
- Write side [trap]
- Reader interaction layer [trap]
- The `Web format` entry from the root `CLAUDE.md` module table [trap]
