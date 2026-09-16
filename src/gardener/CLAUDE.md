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

### Summary code blocks — what the drafters read (2026-09-15)

huginn's JSON `text` removes every fenced block. The capture trigger passes the summarizer's own output in-process, so it always had the code; run-now, the backlog and per-doc re-drafts, and the weekly harvest read huginn, so they go through `fetchSummaryDoc` (`summary-doc.ts`): the source file via `?raw=1` (`readSummarySourceText`, cleaned copy as the fallback) with the `## Transcript` appendix cut, on the fallback copy too. That still did not keep code on capture drafts — the prompt said "synthesize, don't transcribe" — so `SOURCE_CONVENTIONS_DIGEST` carries a VERBATIM MATERIAL rule: quoted prompts, configs and snippets go into the page as fenced code, whole up to 40 lines. Census and re-draft numbers: mimir `plans/muninn-summary-code-in-wiki.mdx`. Measure with `scripts/measure-summary-code.ts` — `--proposal <id>` and `--page <relPath>` score a stored draft and a page on disk with no model call, `--survey` scores every applied source page (that is how the candidate list is regenerated, not copied from the plan), and `--redraft <collection>/<docId>` calls the model and persists nothing.

### Backfilling a page that already lost its blocks (2026-09-16)

The pages drafted before that rule keep their paraphrase — and the drafter answers `covered` for every one of them, since an applied source page puts the doc's url in the wiki. So `draftSourcePage` takes an optional `update: { relPath, currentText }` (`SourceUpdateTarget`) and `scripts/backfill-summary-code.ts` drives it. Update mode is the gardener runner's update idiom on the source drafter, and it flips five create-mode rules that are each wrong when the page being written is the one the doc already has: the coverage check is skipped (it is the REASON to run), the page at the target path is the update target rather than a collision, `stripOwnedAliases` gets `selfRelPath` (else the page's own aliases read as hijacked and are stripped), the shape gate confines to the page's exact path (so a `life/sources/` page is not moved under `sources/`), and the row is `mode: "update"` + `baseHash` — which the `/wiki/gardener` gate already renders as a current→draft diff and `applyWikiProposal` already CASes.

Two things the mechanism will not do. It does not RENAME: a reviser that returns a different `title:` is skipped (`titleMatchKey`, so typography drift is not a rename), because the page keeps the title it was reviewed under. And it does not re-draft: the prompt is `buildSourceRevisePrompt`, which hands the model the current page plus the blocks it is MISSING — measured by `missingCodeBlocks`, not judged by the model — and tells it to change nothing else. That checklist is load-bearing: the first spelling asked the reviser to find what was missing, and it answered by returning the page with only `updated:` bumped, both config blocks still lost. With the checklist the same page came back 2/2, and a five-page batch went 1/19 blocks kept → 19/19.

Nothing in that path writes to a wiki — it persists proposals a human approves, and it writes no `source_draft_attempts` row either: that ledger is keyed `(bot, collection, doc)` and upserts every column, so a backfill row REPLACES the capture attempt that links the doc to its applied proposal — for a doc that demonstrably has a page. Measured: the batch that proved this mechanism erased five capture rows before the write was removed.

`judgeBackfill` (`source-backfill.ts`) decides what may be persisted, and it checks BOTH promises, because a score over code blocks can only see one of them: the blocks came back (kept blocks and found lines, neither allowed to drop, and a no-op refused), AND the rest of the page survived (`proseRetention` — the fraction of the page's prose SENTENCES still present verbatim). Sentences, not lines: a good revision splits one paragraph around a restored block. Measured 2026-09-16 — the five good revisions score 1.0, 1.0, 1.0, 1.0 and 28/29, while a full re-draft of one of the same pages scores 3/3 on code blocks and **0 of 29** on prose. That is the case the code score cannot see and the reviewer of 39 diffs should not have to.

Two properties of that measure are load-bearing and non-obvious. **Both sides run ONE pipeline** (`proseText`: frontmatter and fences out, wikilink and bold syntax reduced to their words, whitespace collapsed, THEN split into paragraphs and sentences). That is not tidiness — every defect this guard has shipped was the same shape, the two sides normalized differently, and the second one put 17 of 932 live source pages below the floor against THEMSELVES (worst 0.750): a `**bold span crossing a sentence. Boundary**` (10 of the 17) or a `[[Coding vs. Software Engineering Distinction]]` (7) left a dangling marker on one side only. Simulated against the design's own output — a fenced block inserted every seventh line — that pipeline refused 269 of the 932 pages; the one below refuses none. One pipeline closes the class by construction: sentences are substrings of the text they were split out of, so a page retains itself whatever its markup does. The paragraph sentinel is the one thing the haystack does NOT carry — it is a split marker for the page side, and leaving it in made a paragraph break the reviser introduces read as deleted prose. And it measures SURVIVAL, not sameness: prose the reviser adds is invisible to it, deliberately, because every restored block is introduced by a one-line lead the prompt asks for.

### Attempt ledger — why a doc has no page (2026-07-31)

Three of the four outcomes (`covered`/`skipped`/`error`) persist NO `wiki_proposals` row, so the doc reappears in the `/wiki/gardener` backlog indistinguishable from one the drafter never ran on — the reason lived only in a log line. **`runSourceDraftForInput` (the one seam every entry point funnels through) records every attempt** to `source_draft_attempts` (`src/db/source-draft-attempts.ts`, migration 068): one row per `(bot, collection, doc)`, latest wins, best-effort (a ledger write must never fail the draft it describes). The `?docs=1` backlog rows carry it (`attachDraftAttempts`); an empty map degrades to the byte-identical pre-ledger payload. A drafter added anywhere else is invisible again — the backfill script is the one caller that reaches the model around that seam, and it records its own attempt under `trigger_source = backfill` for exactly that reason.

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

### The queue does not bind external editors — and the 2026-08-16 "clobber" never happened

The jarvis wiki's own `log.md` carries a note claiming the gardener "committed twice
during this lint and clobbered an earlier version of this entry", with
`insertLogEntry`'s read-modify-write named as the mechanism. **That note is wrong,
and it is wrong twice over.** Reconstructed from the wiki's git history (which can
refute a clobber of COMMITTED content only — an overwrite of an uncommitted edit
before 21:31:27 would leave no trace; the stronger closure is that `applyWikiProposal`
had already joined the shared write queue on 2026-07-30, before the incident, so no
in-process race existed to lose an earlier version either):

- 21:31:27 — the gardener's last apply; the manual lint entry is not yet on disk.
- 21:32:54 — the source-drafter's own commit contains **both** its new entry and the
  manual lint entry. Its read-modify-write picked the manual entry up and
  *preserved* it, splicing its own block above it (newest-first).
- 21:35:08 — the lint session, seeing its entry no longer at the top of the file,
  concludes it was clobbered and writes a longer replacement.

Both versions are in `log.md` today, ~19 lines apart. The entry was **displaced one
position downward, not deleted** — the failure was a misreading of a newest-first
splice, and the residue is a duplicated entry plus a false root-cause note that a
later session then "confirmed" against this file, cementing the wrong mechanism.

The stronger check, measured with `--numstat` (2026-08-30): across the wiki's
entire history, **8** commits delete lines from `log.md`. Five delete a `## `
HEADING and all five are human lint/rename commits; the other three delete
bullets only — two human edits and ONE `[sync]` loop commit (`731beb1`), which
carried the human's own 21:59 rewrite of the concurrency note from the other
machine. So the honest invariant is: **no unattended writer has ever deleted a
log HEADING, and none has removed a line it did not itself author** — not "no
writer commit ever deleted a line". Re-derive with

```
git log --all --format='%H|%ad|%s' --date=short -- data/wiki/log.md | while IFS='|' read -r h d s; do
  n=$(git show --numstat --format='' "$h" -- data/wiki/log.md | awk '{print $2}'); [ "${n:-0}" != 0 ] && echo "$d $n $s"; done; true
```

(NB an earlier spelling grepped `^-[^-]`, which is blind to deleted markdown
BULLETS — `- **x**` renders as `-- **x**` in a diff — and undercounted 8 as 5.
Any grep over this file also needs `-a`: macOS grep judges `log.md` binary in
the default locale and silently returns empty without it. The trailing `true`
keeps the pipeline exit 0 under `set -e`.)

**So no lock was built, and none should be.** The in-process race is already closed by
the shared write queue above, and the read sits immediately before the write inside
that span (`apply.ts` step 4). The rebase-side loss is closed too: the wiki declares
`log.md merge=union` and the sync loop warns when a wiki does not
(`logMergeUnionWarning`, `src/sync/run.ts`) — a union merge duplicates at worst, never
drops. The one shape left is an editor or agent saving a whole-file buffer it read
before the gardener's write. **No muninn-side lock can bind that**, advisory or
otherwise: the writer is another process that never asked us. A lock would buy nothing
and could park the weekly run.

**No detector either, deliberately.** The cheap restart-proof design — compare the
on-disk `log.md` against `git show HEAD:log.md` and warn on a heading that vanished —
was measured against the history above and dropped: it would not have fired in the
21:31→21:35 incident window (both writer commits are pure insertions) — it WOULD
have fired at 22:33 that day, on the human's own disambiguating rename, which is
the noise argument demonstrating itself — it has zero true positives in the corpus, and the only
window in which it *can* fire is while a human is deliberately editing log headings,
so its precision is ~0 by construction. It would also put a `git` subprocess inside the
per-wiki write critical section, which rule 2 above exists to keep subprocess-free. If
this is revisited, that noise argument is the thing to refute first.

**Operational rule, for humans and agents editing `log.md` or `index.md` by hand:**
commit the edit immediately, and expect an unattended writer to splice its own entry
*above* yours between your read and your save — your entry moving down the file is
normal and is not a loss.
