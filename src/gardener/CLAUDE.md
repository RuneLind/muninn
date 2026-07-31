# Gardener — Wiki Page Drafting Pipelines

Three drafting pipelines feed the human review gate at `/wiki/gardener` (approve/reject, CAS). Watcher-side scheduling detail: `src/watchers/CLAUDE.md`.

## Wiki gardener (weekly)

The `wiki-gardener` watcher clusters recent summaries (Haiku + interest profile) and drafts wiki-page proposals into `wiki_proposals`. Approve writes the page into the bot's `wikiDir`, inserts a `log.md` entry, **wires it in** (`wire.ts`: index.md catalog line for concepts + `## See also` backlinks on up to 3 persisted `related_pages`; entities skip the index — surfaced in the gate's wiring preview), and fires the huginn reindex union of touched collections.

Drafts are contained at persist + apply time: unresolvable body wikilinks de-link to bold (`containBodyLinks`), `sources:` is sanitized to http(s)-only with a pending-ingestion callout for URL-less docs.

Requires `wikiDir`; per-bot `gardener` config block; seed via `scripts/setup-wiki-gardener.ts`.

## Consolidation gardener (weekly)

`synthesis-drafter.ts` + the `consolidation-gardener` watcher (seed `scripts/setup-consolidation-gardener.ts`) drafts saga-style `synthesis` proposals across a wiki's OWN pages (semantic clusters of the Atlas overlay) into the same gate, keyed by `wiki_name` — the automation leg of the Atlas "Draft synthesis" button. Topic-key dedup skips clusters already drafted via the button.

## Source drafter (per-article, auto-triggered after every capture)

`source-drafter.ts` takes the drafted page from the one-shot's **return text**, so its model call is fenced against the file-writing tools (`DRAFTER_EXCLUDED_TOOLS` in `drafter-oneshot.ts`) — without that fence the model can satisfy the prompt by writing the `.mdx` to disk and replying "File created successfully…", which parses to no frontmatter title and silently drops the draft (3 lost in one week, 2026-07-28). Note `allowedTools: []` means the FULL surface under `bypassPermissions`; only `excludedTools` binds.

## Write-queue serialization (load-bearing)

**`applyWikiProposal` serializes on the SHARED per-wiki write queue** (`src/wiki/queue.ts`, realpath-keyed on the wiki ROOT) — the same chain `writeWikiPage` holds, because `log.md` is wiki-GLOBAL and the gardener + fact-check append/integrate families are three read-modify-writers of one file (they raced until 2026-07-30). Two rules for anything joining that chain:

1. The section must span read→CAS→write→log.md — a queue entered after the CAS can't close the race.
2. The **commit tail must run outside it** — `commitWikiChange` dispatches its push without awaiting it and the push has no timeout, so one unreachable origin would park every other writer on that wiki for the full stall.

Cataloging policy (`catalogKinds`) and commit/push behavior: see `src/wiki/CLAUDE.md` (`wikiAutoCommit`); code in `src/wiki/commit.ts` + `catalogPage`/`buildIndexEntry` in `wire.ts`.
