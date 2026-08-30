# Gardener — Wiki Page Drafting Pipelines

Three drafting pipelines feed the human review gate at `/wiki/gardener` (approve/reject, CAS). Watcher-side scheduling detail: `src/watchers/CLAUDE.md`.

## Wiki gardener (weekly)

The `wiki-gardener` watcher clusters recent summaries (Haiku + interest profile) and drafts wiki-page proposals into `wiki_proposals`. Approve writes the page into the bot's `wikiDir`, inserts a `log.md` entry, **wires it in** (`wire.ts`: index.md catalog line for concepts + `## See also` backlinks on up to 3 persisted `related_pages`; entities skip the index — surfaced in the gate's wiring preview), and fires the huginn reindex union of touched collections.

Drafts are contained at persist + apply time: unresolvable body wikilinks de-link to bold (`containBodyLinks`), `sources:` is sanitized to http(s)-only with a pending-ingestion callout for URL-less docs.

The index one-liner is truncated at a WIKILINK-SAFE boundary (`truncateOneLiner`, `wire.ts`): a bare 119-char slice can land inside `[[Some Page]]` and ship a dangling `[[`, which a line-based `\[\[([^\]]+)\]\]` scan then matches across the newline, consuming the NEXT entry's link. Truncate, never repair — appending `]]` invents a target the summary never asserted, and `insertIndexLine`'s idempotence check reads `[[Title]]` substrings. The **dangling-open cut runs regardless of length**: the invariant is "a one-liner never contains a partial link", not "truncation never creates one", and the rationale is model-written — a 40-char one carrying a bare `[[` or a nested `[[Foo [[Bar]]` shipped verbatim past a `length <= ONE_LINER_MAX` early return, whereupon the linter reported the gardener's own write. Three rules: the backup goes to the FIRST dangling opener via the SHARED `firstDanglingWikilinkOpen` (`src/wiki/store.ts`), which the linter's `index-truncation` check also runs — one predicate, so the writer and the detector cannot disagree about what "dangling" means (they DO differ on normalization: the lint strips inline code spans first, the writer decides on raw text — the writer is the strict side, so a rationale quoting `` `[[` `` in a code span is over-cut rather than ever shipping debris); the cut is by code point (`truncateUnits`), since a bare `slice` through an emoji writes a lone surrogate into `index.md`; and a rationale that degenerates under `ONE_LINER_MIN` after the safe cut falls back to the first body paragraph, which is why that source choice happens AFTER truncation. Measurements + the detector: **`src/watchers/CLAUDE.md`** owns those numbers.

Requires `wikiDir`; per-bot `gardener` config block; seed via `scripts/setup-wiki-gardener.ts`.

## Consolidation gardener (weekly)

`synthesis-drafter.ts` + the `consolidation-gardener` watcher (seed `scripts/setup-consolidation-gardener.ts`) drafts saga-style `synthesis` proposals across a wiki's OWN pages (semantic clusters of the Atlas overlay) into the same gate, keyed by `wiki_name` — the automation leg of the Atlas "Draft synthesis" button. Topic-key dedup skips clusters already drafted via the button.

Its model call is **fenced** (`runFencedOneShot`, see Source drafter below) — the drafted page is the call's RETURN TEXT, so a reachable `Write` loses it. The seven observability strings the seam is parameterized with are pinned by a test (`SYNTHESIS_ONESHOT_IDENTITY`, plus one case that reads `traceName`/`platform` off the REAL trace root rather than the literal object); unlike the source drafter it has NO text-only retry, so a fence-less connector (openai-compat) has no second line of defence. copilot-sdk forwards the Claude tool names verbatim to `createSession({ excludedTools })` with no mapping, so its effective fence is unverified. Note the fence excludes BUILT-IN tools only — the cloned config keeps `dir`, so the bot's MCP servers still start under `bypassPermissions`; that is pre-existing seam behavior, not something this drafter changes.

## Source drafter (per-article, auto-triggered after every capture)

`source-drafter.ts` takes the drafted page from the one-shot's **return text**, so its model call is fenced against the file-writing tools (`FENCED_EXCLUDED_TOOLS` in `src/core/fenced-one-shot.ts`, re-exported as `DRAFTER_EXCLUDED_TOOLS`; the synthesis drafter above and the fact-check integrate proposer share the same seam) — without that fence the model can satisfy the prompt by writing the `.mdx` to disk and replying "File created successfully…", which parses to no frontmatter title and silently drops the draft (3 lost in one week, 2026-07-28). Note `allowedTools: []` means the FULL surface under `bypassPermissions`; only `excludedTools` binds.

### Attempt ledger — why a doc has no page (2026-07-31)

Three of the four outcomes (`covered`/`skipped`/`error`) persist NO `wiki_proposals` row, so the doc reappears in the `/wiki/gardener` backlog indistinguishable from one the drafter never ran on — the reason lived only in a log line. **`runSourceDraftForInput` (the one seam every entry point funnels through) records every attempt** to `source_draft_attempts` (`src/db/source-draft-attempts.ts`, migration 068): one row per `(bot, collection, doc)`, latest wins, best-effort (a ledger write must never fail the draft it describes). The `?docs=1` backlog rows carry it (`attachDraftAttempts`); an empty map degrades to the byte-identical pre-ledger payload. A drafter added anywhere else is invisible again.

Both collision skips carry the BLOCKING PAGE (`findCollidingPage` returns the page, not a boolean) so the row deep-links it. **`POST /api/wiki/gardener/source-draft-doc`** re-runs one doc with an optional `title` override: the drafter uses it verbatim and **forgoes the collision retry** — that retry's SKIP branch is exactly what drops these docs, and it must not overrule a title a human chose. An override that is also taken is answered from the index before any model call; `sanitizeTitleOverride` collapses whitespace + drops quotes, since the value is interpolated into the prompt.

## Stem collisions — the apply path refuses, at approve time

`store.ts`'s precedence rule (`.md` > `.mdx` > `.html`) DROPS the loser when two
same-stem pages have DIFFERENT extensions, so one of them simply disappears from the
reader: unreachable, contributing no backlinks, with `[[Stem]]` silently resolving to
the winner. Measured 2026-08-29 on the jarvis wiki: a source page was
drafted first as `sources/<Stem>.mdx`, an approved ENTITY proposal then landed
`entities/<Stem>.md`, and the source page vanished.

**No drafter-side check could have prevented that** — the drafter ran first, and
`applyWikiProposal` had no stem check at all: its only create-mode guard is
path-EXACT (`current !== null` ⇒ `stale: "target path already exists"`). So the guard
lives in TWO places, and both are load-bearing.

**On the APPROVE ROUTE, pre-CAS** — where a human can act on the refusal. Four
clauses:

- **`status === "draft"` ONLY.** The gate renders Approve/Reject on that status and
  nothing else, so a 409 on any other status is a refusal with no verb behind it: an
  `approved` crash-recovery row (whose whole purpose is to be re-runnable) 409s
  forever, and a terminal `error`/`rejected`/`stale` row is told about a collision
  instead of the truth, which is that it is not reviewable.
- **Above the draft→approved CAS**, the same position and the same reason as the
  read-only refusal beside it: a refusal after the flip strands the row in
  `approved` with no verb. The row stays a draft and a re-click just refuses again.
  There is no new terminal STATE — there is no model at apply time to rename with,
  so the answer is a refusal a human acts on. (The in-queue half below does carry
  its own `ApplyOutcome` variant, `collision`; that constraint was about the row's
  STATUS, and the route answers that variant by putting the row back to `draft`.)
- **CREATE mode only.** An update rewrites a page that already exists; a twin
  standing elsewhere is a pre-existing collision the write did not create, and
  refusing would make that page permanently un-updatable.
- **`refresh: true` on the index READ — this guard's own, not the apply's.** The
  store's index is a 5-minute TTL cache,
  and measured, the exact historical incident REPRODUCES with the guard installed
  if the twin lands through a non-refreshing path (a pull, the sync loop, a hand
  edit) while the cache is warm. An approve is human-paced; every comparable write
  seam already refreshes (`page-write.ts`, `sync/run.ts`). A null index degrades to
  a skipped check with a warn — and so does a THROWING `buildWikiIndex`, which
  otherwise escaped past the route's own try/catch as a Hono 500 on a row that
  stayed a draft with no explanation. An unresolvable wiki root logs the skip too.

Refusal shape: `409 {error, collision: true}` — the `{error, readonly}` convention,
since the gate renders `data.error` verbatim. `collision` is the whole machine
marker; the blocking page's path and title also rode as fields and nothing read
them, the same reason this file dropped `outcome: "forbidden"`.

**Inside `applyWikiProposal`'s write queue, before the create-mode write** — because
the route guard sits OUTSIDE that queue and each gate card only disables its OWN
buttons, so two colliding proposals approved together both pass it and the second
write lands the twin. It reuses the same predicate over the in-queue index and
returns the `collision` `ApplyOutcome` carrying the route's own refusal sentence
(`stemCollisionMessage`, one spelling for both paths). This is also what covers the
one case the route guard deliberately skips: an `approved` crash-recovery re-run
whose twin appeared inside the crash window.

Two rules on that half, both corrected after review:

- **A collision must NOT burn the row.** The first cut returned `{outcome: "error"}`,
  which the route's fall-through handed to `markWikiProposalError` and answered 500:
  the row landed TERMINAL, the gate rendered no verb, and the reviewer lost the
  remedy — on a refusal where nothing was written and the wiki is what needs fixing.
  So `collision` is its own outcome, and the route answers it by CAS-ing the row
  **`approved → draft`** (`revertWikiProposalToDraft`, the one CAS here that does not
  stamp `resolved_at`) and returning the pre-CAS guard's exact 409 body. A re-click
  then just refuses again, harmlessly. This is the same policy the route already
  stated for the read-only refusal beside it — "flipping it to error would burn a
  perfectly good draft on a policy answer" — and it is why the pre-CAS guard's "no
  new `ApplyOutcome`" constraint stopped binding: its rationale was rows stranded in
  `approved` with no verb, which reverting removes.
- **The in-queue index is NOT built with `refresh: true`.** Freshness for the race
  this covers comes from the PREVIOUS apply: every write path awaits
  `deps.refreshIndex()` before releasing the queue, so the second of two concurrent
  approves reads a cache the first refreshed after writing. Refreshing again would
  rebuild the whole index (245 ms on jarvis) inside the shared per-wiki write queue
  on every approve — the one thing that queue's docblock says not to grow. Residual,
  accepted and stated in the code: a twin landing OFF-PATH (a pull, a hand edit)
  inside the TTL window is missed by this check on an `approved` re-run, the one path
  the route's own refreshing guard does not cover.

**`findStemTwin` (`source-drafter.ts`) is the ONE stem-twin resolver** — the drafter's
`findCollidingPage`, its title-override pre-flight, the approve route and the apply
re-check all call it. A twin BLOCKS on exactly two conditions:

1. **It would SHADOW, or be shadowed by, the new page** — same stem, DIFFERENT
   `extRank`. `.html` is IN, both directions: an apply landing `blogs/<Stem>.md` over
   an existing `blogs/<Stem>.html` makes the explainer vanish just as quietly, and
   measured 2026-08-30 that `.md`-over-`.html` shape is the only shadow live on the
   six real roots.
2. **It sits in the SAME FOLDER under the same stem** — today implied by (1), stated
   because it is the rule a reader expects.

**A SAME-EXTENSION twin in a DIFFERENT folder is ALLOWED**, deliberately narrowing
the first cut (which refused every same-stem markdown pair on a "one title
namespace" argument). `store.ts` supports that shape on purpose — it keeps both
pages behind a `displayTitle` prefix — and mimir carries 4 such groups over 9 pages,
so refusing them made a consolidation proposal for another
`projects/<x>/architecture.md` permanently unapprovable, and on the drafter side it
burned the one collision retry and refused human-chosen titles. Reserved basenames
(`index`/`log`/`CLAUDE`) are exempt, and every stem comparison folds through NFC
(`stemKey`) so an NFD filename on macOS is not invisible to an NFC query.

The linter's `stem-collision` check (`src/watchers/CLAUDE.md`, which OWNS the census
numbers for both shapes) is the continuous regression guard — with one deliberate
scope split, stated on both ends: the guard counts `.html`, the lint does not,
because the guard refuses a write that would create a shadow while the lint reports
pre-existing pairs a human kept.

## Write-queue serialization (load-bearing)

**`applyWikiProposal` serializes on the SHARED per-wiki write queue** (`src/wiki/queue.ts`, realpath-keyed on the wiki ROOT) — the same chain `writeWikiPage` holds, because `log.md` is wiki-GLOBAL and the gardener + fact-check append/integrate families are three read-modify-writers of one file (they raced until 2026-07-30). Two rules for anything joining that chain:

1. The section must span read→CAS→write→log.md — a queue entered after the CAS can't close the race.
2. The **commit tail must run outside it** — `commitWikiChange` dispatches its push without awaiting it, and the push is bounded only by `GIT_NETWORK_TIMEOUT_MS` (60s, added with the repo-sync loop), so one unreachable origin would park every other writer on that wiki for up to a minute.

Cataloging policy (`catalogKinds`) and commit/push behavior: see `src/wiki/CLAUDE.md` (`wikiAutoCommit`); code in `src/wiki/commit.ts` + `catalogPage`/`buildIndexEntry` in `wire.ts`.
