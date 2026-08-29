# Gardener — Wiki Page Drafting Pipelines

Three drafting pipelines feed the human review gate at `/wiki/gardener` (approve/reject, CAS). Watcher-side scheduling detail: `src/watchers/CLAUDE.md`.

## Wiki gardener (weekly)

The `wiki-gardener` watcher clusters recent summaries (Haiku + interest profile) and drafts wiki-page proposals into `wiki_proposals`. Approve writes the page into the bot's `wikiDir`, inserts a `log.md` entry, **wires it in** (`wire.ts`: index.md catalog line for concepts + `## See also` backlinks on up to 3 persisted `related_pages`; entities skip the index — surfaced in the gate's wiring preview), and fires the huginn reindex union of touched collections.

Drafts are contained at persist + apply time: unresolvable body wikilinks de-link to bold (`containBodyLinks`), `sources:` is sanitized to http(s)-only with a pending-ingestion callout for URL-less docs.

The index one-liner is truncated at a WIKILINK-SAFE boundary (`truncateOneLiner`, `wire.ts`): a bare 119-char slice can land inside `[[Some Page]]` and ship a dangling `[[`, which a line-based `\[\[([^\]]+)\]\]` scan then matches across the newline, consuming the NEXT entry's link. Truncate, never repair — appending `]]` invents a target the summary never asserted, and `insertIndexLine`'s idempotence check reads `[[Title]]` substrings. The **dangling-open cut runs regardless of length**: the invariant is "a one-liner never contains a partial link", not "truncation never creates one", and the rationale is model-written — a 40-char one carrying a bare `[[` or a nested `[[Foo [[Bar]]` shipped verbatim past a `length <= ONE_LINER_MAX` early return, whereupon the linter reported the gardener's own write. Three rules: the backup goes to the FIRST dangling opener via the SHARED `firstDanglingWikilinkOpen` (`src/wiki/store.ts`), which the linter's `index-truncation` check also runs — one predicate, so the writer and the detector cannot disagree; the cut is by code point (`truncateUnits`), since a bare `slice` through an emoji writes a lone surrogate into `index.md`; and a rationale that degenerates under `ONE_LINER_MIN` after the safe cut falls back to the first body paragraph, which is why that source choice happens AFTER truncation. Measurements + the detector: **`src/watchers/CLAUDE.md`** owns those numbers.

Requires `wikiDir`; per-bot `gardener` config block; seed via `scripts/setup-wiki-gardener.ts`.

## Consolidation gardener (weekly)

`synthesis-drafter.ts` + the `consolidation-gardener` watcher (seed `scripts/setup-consolidation-gardener.ts`) drafts saga-style `synthesis` proposals across a wiki's OWN pages (semantic clusters of the Atlas overlay) into the same gate, keyed by `wiki_name` — the automation leg of the Atlas "Draft synthesis" button. Topic-key dedup skips clusters already drafted via the button.

Its model call is **fenced** (`runFencedOneShot`, see Source drafter below) — the drafted page is the call's RETURN TEXT, so a reachable `Write` loses it. The seven observability strings the seam is parameterized with are pinned by a test (`SYNTHESIS_ONESHOT_IDENTITY`, plus one case that reads `traceName`/`platform` off the REAL trace root rather than the literal object); unlike the source drafter it has NO text-only retry, so a fence-less connector (openai-compat) has no second line of defence. copilot-sdk forwards the Claude tool names verbatim to `createSession({ excludedTools })` with no mapping, so its effective fence is unverified. Note the fence excludes BUILT-IN tools only — the cloned config keeps `dir`, so the bot's MCP servers still start under `bypassPermissions`; that is pre-existing seam behavior, not something this drafter changes.

## Source drafter (per-article, auto-triggered after every capture)

`source-drafter.ts` takes the drafted page from the one-shot's **return text**, so its model call is fenced against the file-writing tools (`FENCED_EXCLUDED_TOOLS` in `src/core/fenced-one-shot.ts`, re-exported as `DRAFTER_EXCLUDED_TOOLS`; the synthesis drafter above and the fact-check integrate proposer share the same seam) — without that fence the model can satisfy the prompt by writing the `.mdx` to disk and replying "File created successfully…", which parses to no frontmatter title and silently drops the draft (3 lost in one week, 2026-07-28). Note `allowedTools: []` means the FULL surface under `bypassPermissions`; only `excludedTools` binds.

### Attempt ledger — why a doc has no page (2026-07-31)

Three of the four outcomes (`covered`/`skipped`/`error`) persist NO `wiki_proposals` row, so the doc reappears in the `/wiki/gardener` backlog indistinguishable from one the drafter never ran on — the reason lived only in a log line. **`runSourceDraftForInput` (the one seam every entry point funnels through) records every attempt** to `source_draft_attempts` (`src/db/source-draft-attempts.ts`, migration 068): one row per `(bot, collection, doc)`, latest wins, best-effort (a ledger write must never fail the draft it describes). The `?docs=1` backlog rows carry it (`attachDraftAttempts`); an empty map degrades to the byte-identical pre-ledger payload. A drafter added anywhere else is invisible again.

Both collision skips carry the BLOCKING PAGE (`findCollidingPage` returns the page, not a boolean) so the row deep-links it. **`POST /api/wiki/gardener/source-draft-doc`** re-runs one doc with an optional `title` override: the drafter uses it verbatim and **forgoes the collision retry** — that retry's SKIP branch is exactly what drops these docs, and it must not overrule a title a human chose. An override that is also taken is answered from the index before any model call; `sanitizeTitleOverride` collapses whitespace + drops quotes, since the value is interpolated into the prompt.

## Write-queue serialization (load-bearing)

**`applyWikiProposal` serializes on the SHARED per-wiki write queue** (`src/wiki/queue.ts`, realpath-keyed on the wiki ROOT) — the same chain `writeWikiPage` holds, because `log.md` is wiki-GLOBAL and the gardener + fact-check append/integrate families are three read-modify-writers of one file (they raced until 2026-07-30). Two rules for anything joining that chain:

1. The section must span read→CAS→write→log.md — a queue entered after the CAS can't close the race.
2. The **commit tail must run outside it** — `commitWikiChange` dispatches its push without awaiting it, and the push is bounded only by `GIT_NETWORK_TIMEOUT_MS` (60s, added with the repo-sync loop), so one unreachable origin would park every other writer on that wiki for up to a minute.

Cataloging policy (`catalogKinds`) and commit/push behavior: see `src/wiki/CLAUDE.md` (`wikiAutoCommit`); code in `src/wiki/commit.ts` + `catalogPage`/`buildIndexEntry` in `wire.ts`.
