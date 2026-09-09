# `src/summaries/`


<!-- moved out of the root CLAUDE.md by /doctor on 2026-09-08 -->

## The `Capture jobs` entry from the root `CLAUDE.md` module table

Shared seam for the capture verticals (youtube / vimeo / x-article / tiktok / x-video / anthropic / article — `article` is pasted text, ingested into `article-summaries`). `runCaptureOneShot` wraps the model call in a `capture:<source>` trace, late-binds bot/model/trace/tokens onto the job's `/agents` run, and caps thinking at `CAPTURE_THINKING_MAX_TOKENS` (8k) for TTFT. **Which captures opt out of that cap is the KIND's answer on YouTube and Vimeo** (`captureThinkingFor(preset)` returns `null` only for `deep`) and the VERTICAL's answer on the two short-video ones, which pass `thinkingMaxTokens: SHORT_VIDEO_THINKING` (`src/video/short-video-kinds.ts`, `null`) on every kind. It is a NAMED constant because `/summaries/prompts` shows the budget as a chip and derives that chip from the preset otherwise — the page said "capped at 8000" on four of the six short-video cells (the two `deep` cells already inherited) while the job sent the bot's own budget; the row now overrides the kind's `thinking` from the same constant, so the two cannot disagree. That is not an oversight in the picker: reading the keyframes IS the reasoning in a frame-reading session, there is no reader waiting on a first token in a background job, and the 8k knee was measured on a text-only YouTube transcript and never against a multi-turn frame-reading call. Routing their `standard` through the cap would have moved every ordinary short-video capture onto an unmeasured budget, with no kind reproducing the previous default — `deep` swaps the model to opus as well, so it is a different call rather than the old one renamed. Summarizers must go through this, never `executeOneShot` bare, or the job goes invisible on `/traces` + `/agents`. **The seam also STORES the prompt it sent** (`src/db/prompt-snapshots.ts`, `kind: 'capture'`, keyed on the trace id and the PASS, with the source url on the row): after the model call, so only a pass that ran leaves a row, gated on `tracingEnabled` because the row is keyed on a trace id, and fail-soft — a capture that summarized correctly never fails over a debugging artefact. The write is awaited only within `SNAPSHOT_WRITE_BUDGET_MS` (1.5 s per pass, so a two-pass capture can pay it twice), then abandoned to its own `catch`: unbounded, a rejected INSERT settled inside whatever `bun test` file ran NEXT and failed an unrelated log assertion, while awaiting it outright would hand a stalled Postgres every capture. The budget catches a FAST rejection; one arriving after it (a `statement_timeout`, a reset connection) still lands wherever the loop is, which is why the capture tests send real UUIDs. The chat caller in `src/core/prompt-assembly.ts` stays unbounded fire-and-forget at `debug` level. The `user_prompt` is capped at 256 KiB with the shared truncation note (`src/summaries/truncation.ts`, lifted out of `src/youtube/frames.ts` when this became its second caller), since a capture prompt carries a transcript. Read back by `/api/prompts/<traceId>?pass=` (the traces modal, deep-linked as `/traces#<traceId>/prompt/<pass>`) and by `GET /api/summaries/prompt?url=`, which finds it by the DOCUMENT rather than the trace — the trace is swept after 7 days and the snapshot is kept for 90 (`PROMPT_SNAPSHOTS_CAPTURE_RETENTION_DAYS`). **The seam also runs the closing-takeaway grounding check** (`src/summaries/takeaway-check.ts`, 2026-09-08): the `> 💬 **Takeaway:**` block is split off the RAW model text, a Sonnet call (`TAKEAWAY_CHECK_MODEL`, through the bot's Haiku router — the request is honoured on the anthropic/CLI backends, passed through on copilot, and WITHHELD on vertex (`checkModelFor`), whose endpoint honours a per-call model too but serves no Anthropic id, so sending it would 400 and fall back to the local CLI) is handed the body and the closer — never the transcript, since the body is what the reader can check and every measured defect was body-contradicted — and an `ungrounded` closer is replaced by the call's rewrite before the envelope parser, the store, the ingest or the card see it. Child span `<pass>:takeaway-check` with `takeaway: grounded|rewritten|removed|check-failed`, carrying the call's model and tokens whenever it ANSWERED (a parse failure included); a failed check keeps the closer and never fails the capture; a result with no closer opens no span — the selection pass is silent, the summary pass records a `no-takeaway` EVENT so a drifted marker cannot pass for a clean run. The check's spend is accumulated onto the job's run (identity untouched); it runs AFTER the summary call and OUTSIDE the YouTube two-pass budget, bounded by the router's 60 s timeout plus its CLI fallback. A marker line inside a fenced OR indented code block is never the closer (`markdownCodeRegions` + a four-space/tab rule that does not fire under a list item, since four spaces there is list continuation; a list-item closer at two spaces and a nested-list closer at four are still found), and the rewrite is gated (`rewriteRefusal`: length, marker, fence, a TAG shape — not any angle bracket, `5 > 3` is prose — blank line) because the body it was derived from is third-party text. A gate refusal is the one failure that does NOT keep the closer: the verdict said ungrounded, so the block is REMOVED (`takeaway: removed`), while a parse failure or a dead router keeps it (`check-failed`). Measured on the Drolshammer CargoNet talk captured as `deep`: the closer overstated two points and inverted a third while the body was right — the prompt line asked for "surprising … punchy" and now asks for a restatement (`summary-structure.ts`). Because the closer can change AFTER it streamed, **every** vertical's store sets `completeReplacesText` and its route `completeCarriesSummary` (Vimeo, article and Anthropic joined the three that already did). `bun scripts/eval-takeaway.ts --doc <collection>/<docId> --check-only` runs the checker on a stored summary; with `--closer old|new --kind … --runs N --out <dir>` it regenerates the summary from the stored transcript under either closer line and grades each result. **In the ANTHROPIC vertical** (`src/anthropic/summarizer.ts` — the only importer today; the `src/video/media.ts` yt-dlp path is a follow-up), **a URL the capture followed because a THIRD PARTY named it** (a tweet's `**Links:**` footer, a destination-keyed candidate row) goes through `src/summaries/safe-fetch.ts`, never a bare `fetch`: scheme allowlist → resolve and judge the ADDRESS → manual redirects re-judged at every hop (max 5 — measured: the ordinary `docs.anthropic.com/**.md` page is 3 hops, and a page that moved off the docs site, e.g. `agents-and-tools/mcp.md`, is 4, so 5 is one hop of headroom) → content-type gate → 2 MB streaming cap, all inside ONE 20 s whole-operation budget that covers the DNS lookup too. Blocked addresses are loopback / private / link-local / CGNAT-tailnet plus `0/8`, everything from `224` up and the documentation+benchmarking ranges on BOTH families (v4 TEST-NET-1/2/3 + `198.18/15`; v6 `2001:db8::/32`, `3fff::/20`, `2001:2::/48`, `2001:10::/28`) — and the v4-in-v6 forms are UNWRAPPED and judged as v4 (`::ffff:`, `::a.b.c.d`, `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), since `64:ff9b::7f00:1` is otherwise just an ordinary-looking v6 literal pointing at 127.0.0.1. The local-use NAT64 prefix `64:ff9b:1::/48` (RFC 8215) is the one wrapper refused WHOLE rather than unwrapped: the embedding length is the operator's choice, and there is no public destination behind a local-use prefix to preserve. A response with NO content-type is refused (we do not sniff); a body over the cap is **truncated, not refused** — the cap bounds the PROCESS and `capContent` still trims the PROMPT, so a 3 MB Wikipedia article stays a summarizable capture. There is no `content-length` pre-check in front of that cap (removed: it compared a gzip/brotli WIRE length against a decompressed cap, so it refused `norvig.com/big.txt` — 6.5 MB of text, 2.3 MB on the wire — while a same-size gzip page truncated). Truncating also ABORTS the hop: each hop gets its own `AbortController` chained off the timeout, because `reader.cancel()` does not close a Bun fetch socket — measured cross-process, a read that returned in 8 ms left the server pushing 52 GB over the next 5 s and stopping only when the client process exited; with the abort, 6 MB. Refusals return `null` and log once, naming the hop, the reason (timeout distinguished from transport failure) and the caller, so the caller degrades exactly as it does on a dead link. Our OWN huginn `baseUrl` (the YouTube transcript endpoint) is deliberately NOT guarded: it is loopback by design.

## Prompt builders, the finish tail, and `/summaries/prompts`

**Every capture's two prompts are PURE BUILDERS the run calls** (2026-09-09), one module per vertical — except the two SHORT-VIDEO ones, which share `src/video/short-video-prompt.ts`: `src/youtube/prompt.ts`, `src/vimeo/prompt.ts`, `src/x-article/prompt.ts` (the TEXT path), `src/article/prompt.ts` and `src/anthropic/prompt.ts`. Each exports a `build…SystemPrompt` and a `…SystemPromptPieces` function, with the builder defined as `joinPromptPieces` over the pieces, so there is one template and not two. Only the FOUR video verticals also export a `build…UserPrompt`: for `x-article`, `article` and `anthropic` the user prompt is the pasted or fetched text itself, so there is nothing to build. The short-video pair's builders take a `ShortVideoPromptSpec` (the platform noun and one clause about what that platform's frames carry) as a first argument — the two modules they replaced were measured copy-paste twins differing in exactly those two strings. They are their OWN modules rather than living in the summarizers for the reason `src/vimeo/limits.ts` exists: a summarizer's import graph is yt-dlp, ffmpeg, playwright-core and the wiki queue, and neither a dashboard view nor a re-run may pull that in to compose a string. `src/vimeo/summarizer.ts` re-exports `buildVimeoSystemPrompt`/`AUTO_CAPTION_RIDER` so every existing importer is unchanged. **Byte-identity is the contract.** The evidence for it is a ONE-OFF: at the extraction, every prompt each vertical's suite sends was dumped on `origin/main` and on the branch and the two dumps diffed — 192 pairs across all seven verticals, identical (the table is in PR #542's body). What `src/summaries/prompt-pieces.test.ts` pins going forward is NARROWER and worth stating exactly: that each `build…SystemPrompt` is the join of its OWN pieces. That catches a builder re-spelled as a second literal beside the pieces; it does NOT catch a change to a piece's content, since both sides of the comparison move together. Anything that must not change the composed string — a piece SPLIT, say — has to bring its own evidence, the way the Vimeo windowed-rider split does (`prompt-pieces.test.ts`: the two halves concatenate to the piece they replaced).

**The POST-MODEL TAIL is one function per vertical, and a RE-RUN MUST CALL IT** — `finishYouTubeSummary` (`src/youtube/finish.ts`), `finishVimeoSummary` (`src/vimeo/finish.ts`) and, for both short-video verticals, `finishShortVideoSummary` (`src/video/short-video-finish.ts`), which takes the vertical's spec. The tail is everything between the model's answer and the ingest EXCEPT the vertical's completion log line, which stays in the summarizer because it reports on the whole JOB (its model, its token totals, its frame counts) — a re-run must therefore write that record itself. Only YouTube's is a structured record: `src/youtube/summarizer.ts` is the single `event: "capture_complete"` emitter and `scripts/replay-youtube.ts` parses it for its `run.json`, so a YouTube re-run that skipped it would leave the replay harness with no run to read. The other three log a plain `Summarized …` line. What the tail does own is not bookkeeping: YouTube's parses the envelope, holds the summary's frame references to that capture's own manifest and the policy's caps (`enforceVisualReferences`), copies what the text quotes out of the dying work dir (`keepReferencedFrames`) and then removes the references the copy could not serve (`dropFrameReferences`). A re-run that re-implemented any of that would store model-invented slide addresses the route 404s, and the model's answer looks fine either way. The differences between them are deliberate and documented in each header — **Vimeo runs NO enforcement pass** (its copy parses the summary itself), TikTok carries the degraded-frame-Reads warn, X-video has neither. Since the short-video merge that last difference is a SPEC FIELD (`visualWarning`) rather than a second file, and the log CATEGORY is one too, so the warn still lands under `muninn.tiktok.summarizer` where a saved query already selects it. A re-run must still pass the vertical's own spec rather than the one it read first. **Four verticals have a tail; three deliberately do not.** The four are YouTube, Vimeo and the two short-video verticals. `x-article`, `article` and `anthropic` parse the envelope inline and have nothing else to do between the answer and the ingest — except `anthropic`, whose one extra step is the `AI_CATEGORIES` clamp, and that stays in its summarizer on purpose: it is a rule about the COLLECTION the job ingests into (huginn's allowlist), not about the model's text, so a re-run that ingested elsewhere must not inherit it. What a tail does NOT do is the JOB's: the ingest, `completeJob`, the source draft and the status moves stay in the summarizer, because a re-run writes into a different job. The one job-store touch it owns the TIMING of is the category, which is why it is an `onCategory` callback: the live card is told before the frame copies are awaited, exactly as it was when the tail was inline.

**`/summaries/prompts`** is the read-side of both: one table, capture sources down and summary kinds across, a cell per combination listing the pieces it receives as chips, and a drawer under the table with the composed system prompt (tinted per span by the piece that produced it), the user-prompt skeleton, the closing-takeaway check prompt, and the `<botDir>/prompts/captureSummary.<id>.md` path with a present / not-present marker. `src/summaries/prompt-matrix.ts` builds the payload (pure — no model call, no write, no DB) and `src/dashboard/views/summaries-prompts-page.ts` renders it, server-side and whole: every drawer is in the HTML from the first byte and the script only toggles `hidden`. **Two rules it lives by.** Nothing on the page spells a prompt — a second copy would agree with itself forever while the captures moved. And the tint is BUILT rather than parsed: the cell carries the pieces, so a line's colour is the piece that produced it by construction, where a regex over the finished text would go wrong on the first reworded rider and go wrong silently. The kinds are `resolveCapturePresets(bot.prompts, bot.connector)` for the `?bot=` bot (default `resolveSummarizerBot`), so a `deep` column is absent exactly where the connector cannot name the opus model. A source with no kind picker gets ONE cell spanning the kinds, carrying `shared envelope, no kind` — the three TEXT verticals today. The `hand-rolled envelope, no kind` wording is still in `noKindChip` and no row uses it: TikTok and X video carried it until the short-video merge put them on the shared envelope's `before`/`after` slots, which is what gave them a kind picker. The page is reached from a small **Prompts** link in `/summaries`' header — its only entry point, since the top-level nav row already carries ten links. Every skeleton is built from ONE fixed placeholder input (a two-window transcript, two frames at 60 s and 120 s with one selection note, invented text — this repo is public). A skeleton also has to STATE the branches it took, or it silently shows half of each vertical: every row carries a `fixed:` line (`PromptMatrixSource.fixedAxes`) naming the axes the page pinned — YouTube windowed + TWO frames + a noted frame + `selected` visual detail, Vimeo auto-captions + English + TWO frames + a noted frame, the two short-video verticals the frames-PRESENT form of their system prompt (their builder takes a `frames` flag since the re-run seam arrived — `false` drops the frame-reading and visual-only rules, names the transcript alone and drops the no-commentary rule's second sentence ("Do not narrate the frames as you read them"), so a pass with no frames never mentions one; the RUN states that flag from the frame LIST, which is what makes a failed extraction degrade the system prompt too) plus a present transcript and present keyframes, `article` author-and-url present, `x-article` nothing (its builder interpolates all three context fields unconditionally, so the old `author and url: both present` line described the placeholder rather than a branch), Anthropic the release framing with no linked-content rider. The frame COUNT is named rather than mere presence because `framesPromptSection` states a cadence (`, one every ~N s of the talk`) only from two frames on. **No row is empty**, and there is one wording for the line: the short-video rows read "no branch" until 2026-09-09, which was true of their SYSTEM prompts and false of their user builders (`buildShortVideoUserPrompt` branches on an empty transcript and on an empty frame list). Only YouTube's user builder takes a visual-detail policy, so only its row and cell name one. The check in `prompt-matrix.test.ts` is ONE-DIRECTIONAL and worth reading as such: every DECLARED axis is verified against the composed prompt, and an axis a builder branches on that no row declares is invisible to it — the lists are maintained by hand from the branch points named in the comment above each row. The tints are the `--tok-*` ramp rather than `--status-*`: these spans are text on `--bg-inset`, the exact pair that ramp is tuned for in both themes, and the status colours failed AA on light (measured 2.74–4.45:1). **A piece id is unique across the whole composed list** — `joinPromptPieces` refuses two content-bearing spans claiming one id, and an empty one, because the envelope's own check sees only its four ids plus the slot entries and a slot spelled `{ id: "context" }` collided with the vertical's own context piece. A WHITESPACE-only span is exempt: Vimeo's intro split leaves the trailing `\n\n` under the `intro` id, one part in two spans, and it carries no chip and no visible tint. **Every piece id needs a `PIECE_TINTS` row**, and a missing one is invisible — an untinted span inherits the block's own colour, still reads correctly, and clears any contrast check, which is exactly how the short-video merge shipped 18 untinted spans across three new ids. So the e2e check asserts each span's resolved colour DIFFERS from a `.pm-prompt` that has no spans, not only that it clears 4.5:1. Ids that name the same PART share a hue and one legend entry: the four riders, and the three numbered rules the envelope's slots hold. Acceptance: `src/summaries/prompt-matrix.test.ts` and `e2e/summaries-prompts.spec.ts`.

## The capture RE-RUN (`POST /api/summaries/rerun`)

**A stored document, summarized again from its own `## Transcript` appendix —
no download, no re-fetch.** The reader's entry point is the `↻ Re-run ▾` menu in
the `/summaries` doc panel; the server half is
`src/dashboard/routes/summaries-rerun.ts`, registered inside the `summaries`
route group (so the `nais` drop is inherited) beside share, export and the
prompt route, for the reason those have their own modules: an adapter over
another layer, with every side-effecting seam injectable so its route tests need
no huginn and no model call.

**The source of truth is the RAW FILE.** huginn's document JSON `text` is a
CLEANED copy — fenced code removed, images rewritten, a breadcrumb prepended —
so a re-run built from it shrinks the document a little on every pass. It reads
`GET /api/document/<c>/<id>?raw=1` (huginn #131) through
`fetchKnowledgeApiText` (`src/ai/knowledge-api-client.ts`), which is
`fetchKnowledgeApi`'s twin with the JSON parse taken out — a sibling and not a
flag, because a caller that got a string back from the JSON function is one
refactor away from reading `.documents` off it.

**The split contract.** `src/summaries/transcript-split.ts` owns
`splitTranscript` — the first level-2 `## Transcript` heading OUTSIDE fenced
code, the export's own rule, moved when the re-run became its third server-side
reader. There is ONE declaration site and every reader addresses it there:
`export.ts` imports it (the shim re-export it briefly carried is gone),
`scripts/replay-youtube.ts` imports it, and `scripts/eval-takeaway.ts`'s naive
`indexOf` was replaced by it. The CLIENT keeps its copy inside
`sum-article-library.ts`'s template literal, and `export.test.ts` still pins the
two against shared fixtures. The appendix comes back TRIMMED: `appendTranscriptSection`
and huginn's Vimeo `body_suffix` add their own separator and trailing newline, so
re-appending an untrimmed one grows the file by a blank line on every pass.
`transcriptIsWindowed` derives the windowed rider from the transcript's OWN
`### [HH:MM:SS]` headings — never from anything the document claims — the same
rule the YouTube capture applies to huginn's answer rather than to its frames
decision.

**The frontmatter re-send rule.** huginn's ingest takes no document id: it
rewrites the whole file from the request body, keys the path on
`<category>/<sanitized title>.md`, and forks a `(2)` sibling when the stored
`url` differs. So a field left out is a field ERASED and a differing url is a
shadow copy of the talk. The re-run therefore RE-SENDS every frontmatter field
the vertical's ingest model accepts, `url` and `date` included, with only
`summary_kind` changed — the per-vertical list is `frontmatterFields` in the
route's own table (Vimeo's nine extras plus `duration_sec`; `vimeo_video_id` is
DERIVED by huginn from the url and is deliberately absent, since it is no request
field). `title` comes from the FILE NAME (no capture vertical writes a `title:`
key, and `sanitize_filename` is idempotent, so a title read out of the path and
posted back resolves to the same path) and `category` from the id's directory,
both PINNED over the model's own `CATEGORY:` line with a log line when they
disagree — either one moving is a second file rather than an edit.

**`parseCaptureFrontmatter`, and why not `parseFrontmatter`.** The wiki store's
parser answers `Record<string, string | string[]>`, which cannot tell huginn's
BARE integer (`duration_sec: 3180`, written bare so the converter serves it as a
number) from a quoted `"3180"` — re-sending the string writes
`duration_sec: "3180"` on the next pass, a frontmatter diff on a run that is
supposed to change one field. The re-run's reader keeps each value's RAW TEXT and
decodes it the way huginn's `frontmatter_scalar` encodes it, and the test asserts
`encode(decode(raw)) === raw` for EVERY value of a full Vimeo document.
`StoredCapture` therefore carries TWO maps — `frontmatter` (decoded, what the
route reads when it needs a value) and `frontmatterRaw` (the on-disk text, what
the ingest body is built from) — because decoding twice is a wrong answer rather
than a no-op: a quoted `caption_lang: "2026"` decodes to `2026`, and decoding
THAT again makes it the NUMBER 2026, which huginn's `Optional[str]` model
refuses. The decoded map can no longer tell a quoted numeral from a bare one.

**Reuse the route rests on, so nothing here is a second copy.** The doc panel
renders the `↻ Re-run ▾` control from a `rerun` FLAG on `SUMMARY_SOURCES`
(projected by `clientSourcesJson`), not from a list of four strings beside it,
and the route asserts at load that the two agree. `encodeDocIdPath`
(`src/summaries/sources.ts`) is the one spelling of "a doc id as a URL path
fragment", read by the share adapter, the export route and this one.
`fetchKnowledgeApi` and `fetchKnowledgeApiText` share their whole request half
through a private core, so a timeout or a status mapping cannot change on one of
them alone. And `extractYouTubeVideoId` lives in the import-free
`src/youtube/url.ts` (`youtube-routes.ts` re-exports it), so reading it does not
drag the YouTube route graph into this module.

**The frames listing hazard.** `finishYouTubeSummary` strips every quote of a
frame that is NOT in the list it is handed, so an incomplete listing silently
narrows what the re-summary may show. `listKeptFrames` therefore lists the WHOLE
kept-frames directory (`~/.muninn/frames/<source>/<id>/`, seconds from the file
names, `note: ""` — no selection notes survive a capture), and that same list
goes to the user-prompt builder and to the tail. The write is UNION-ONLY: nothing
in this path prunes or overwrites that directory, since `removeKeptFrames` is
document-delete's. A connector that cannot read files is refused with **503
`frames_unsupported`** before a job exists (the TikTok/YouTube precedent) rather
than producing a re-run whose slides quietly vanish.

**The same-path copy guard.** On a capture the frames live in a dying work dir,
so source and destination always differ; on a re-run `framesRoot` IS where they
live and `frame.path` IS the destination. `copyKeptFrame`
(`src/summaries/frames.ts`) skips the copy when the two RESOLVE to one path —
`copyFile(p, p)` is measured harmless on macOS/Bun and is unproven on Linux,
where the plausible failure is a truncate-then-write that destroys the only copy
of the frame. It is its own exported function with an injectable copy BECAUSE the
guard is invisible from the filesystem here: without the seam, a test of the
same-path case passes whether the guard is there or not.

**The vertical's own builders and its own tail, and its own JOB.** The prompts
come from `src/<vertical>/prompt.ts` and the post-model tail from
`src/<vertical>/finish.ts` — never re-implemented (CAPPED item 2). The job is
created in the SOURCE vertical's store, so it streams over that vertical's
existing `<apiBase>/stream/:jobId` seam and shows up on the shelf and on
`/agents` like any capture. **Nothing marks it as a re-run on the JOB** — the
trace carries `rerun: "true"`, which is where the question is ever asked; a
shelf badge would be the reason to add a job field, and there is none.
`runCaptureOneShot` is handed the STORED url, so the prompt snapshot lands under
the key `GET /api/summaries/prompt?url=` already reads — one row per document,
not one per run — and the `source` it traces under is the CAPTURE's, not the
`/summaries` source id: the two differ for X video (`capture:x-video` against
the `x-article` shelf), and comparing a re-run with the capture it re-runs is
the one thing that attribute is for.

**One run per document at a time, and the claim is BOUNDED.** A per-`(source,
docId)` in-flight map in the route registration answers **409 `in_flight`** to a
second POST. Two concurrent runs would spend two model calls and then race each
other's ingest for one FILE — huginn rewrites the whole document from the request
body, so the loser's summary is simply gone and which one loses is decided by the
network. The claim is taken after every other refusal (a 409 has to mean a run is
under way) and released in a `finally` on the job.

"Settles" is the connector's promise and not this module's, though: `runRerunJob`
awaits `deps.oneShot`, and a call that never settles pinned the document at 409
for the life of the PROCESS, with no way back but a restart. Each claim therefore
carries a timer sized to the budget that run actually sends —
`rerunLatchBudgetMs` = `max(summarizeTimeoutFor(frames), bot.timeoutMs)` plus a
2-minute slack for the tail and the ingest — and the expiry warns, because
reaching it means a model call outlived its own timeout. The claim is held as a
TOKEN rather than a bare key, so an expiry followed by a fresh POST is safe: the
stalled run's `finally` finds a token that is no longer the one on the key and
releases nothing, where a bare `delete` would open the SECOND run's slot on the
first one's arrival.

**Two refusals that cost nothing and run before any model call.**
`POST /api/summaries/rerun` requires **`application/json` (415 otherwise)**, the
`jira-routes.ts` / `youtube-routes.ts` precedent: Hono parses any body whatever
the header says, and `text/plain` is a CORS *simple* request, so without the gate
a cross-origin page could spend a model call and rewrite a stored document with
the browser never asking. And a title that does not round-trip through huginn's
own file-name rule is **409 `title_not_round_trippable`** — the exact FIXED-POINT
test over a PORT of that rule (`src/summaries/huginn-filename.ts`,
`sanitizeFilenameLikeHuginn`), refusing whenever `sanitize(stem) !== stem`.

The port is the deliberate part. The first shape of this guard checked two
SYMPTOMS instead — trailing whitespace, and a length at or past the 200
truncation cap — on the reasoning that a second implementation of huginn's rule
in muninn has nothing keeping the two in step. Measured against the live corpus
on 2026-09-09, it is too narrow by a wide margin: `sanitize_filename` also
collapses `[\s_]+` to ONE SPACE, so **59 live stems carrying a `_` or a double
space passed it and would fork a second file** (0 of them carry a transcript
today, so none is reachable through this route yet — the guard is for the next
capture, not for the corpus as it stands). The drift risk is answered directly
rather than accepted: `huginn-filename.test.ts` runs a 32-stem fixture set
through the JS port AND through huginn's own interpreter in one test, so a change
on either side is a red test. Three details a port gets wrong and that file pins:
Python's `\s` matches `\x1c`–`\x1f` and NEL and does NOT match U+FEFF (JavaScript's
is the exact opposite on those five); `.strip()` runs AFTER the collapse, so
`String.trim()` — which eats a leading U+FEFF — is the wrong function; and `len()`
counts CODE POINTS, so a 200-emoji stem is 200 to Python and 400 to
`String.length`. The parity case SKIPS where huginn is not on disk (every CI
runner); the fixture cases beside it are unconditional. The options payload
carries the same verdict so the menu can disable the run items with the reason.

The narrowing that comes with it is real and intended: a stem of exactly 200
characters IS a fixed point, and is now accepted where the symptom check refused
it.

**The two SHORT-VIDEO verticals run on their own SPEC.** Since muninn #544 they
are one capture job, one prompt builder and one tail
(`src/video/short-video-{prompt,finish,kinds}.ts`), so their re-run entries pass
`TIKTOK_SPEC` / `X_VIDEO_SPEC` rather than importing a per-source module. Four
things ride on that and each is a way a re-run drifts from the capture it
re-runs: the trace source and the ingest path are read OFF the spec (`spec.id` is
`x-video` while the shelf id is `x-article`); the tail is the spec's, so
`visualWarning` stays TRUE on TikTok and FALSE on X; the KINDS come from
`shortVideoCaptureKinds`, the same `requireThinkingControl: true` set both
capture routes resolve theirs from (extensionally equal to the shared set on a
Claude connector, and NARROWER on Copilot, which carries the opus id but honours
no thinking budget); and the thinking budget is the VERTICAL's
(`SHORT_VIDEO_THINKING`, `null`), not the kind's — those presets say `capped`,
so the shared derivation would have a re-run send an 8k cap where the capture
sends the bot's own budget. The system prompt is built with **`frames: false`**,
the zero-frame form: a re-run has no work dir and no JPEGs, and the
frames-present form orders the model to read images the user prompt lists none
of and then not to narrate them.

**The re-append picks its CAPPER from the stored text.**
`appendTranscriptSection`'s fourth argument is `windowed`, derived by
`transcriptIsWindowed` over the appendix itself — the same evidence the prompt's
own rider rests on. The wrong capper is destructive rather than imprecise: the
window capper's unit is a `\n\n`-separated `### [HH:MM:SS]` bucket, and a FLAT
whisper transcript (which is what the short-video verticals store) has none, so
it is one element that fits no budget and the answer falls through to a head cut
at whatever newline the layout offers — measured, a flat transcript whose first
line is longer than the budget comes back as the ~64-byte truncation note ALONE.

**The frame list is not a cadence.** `framesPromptSection` states the spacing it
derives from the frames it is handed ("one every ~N s of the talk"), which is
true of a capture and false here: a re-run lists whatever the previous summary
QUOTED, so two survivors 30 s and 900 s apart would announce ~870 s — a number
nothing measured, in a sentence the model reasons from. Every vertical's re-run
prompt passes `cadence: false`, which OMITS the clause (never zeroes it); the
capture path is byte-identical without the option and a test pins that.

**`storedVisualDetail` reads the CANONICAL heading pattern.** It is
`VISUAL_REFERENCE_HEADING_RE` — the one the visual-detail pass itself matches on
— walked over prose lines via `mapProseLines`. A stricter local re-spelling read
`## Visual References`, `## **Visual reference**` and an indented heading as "no
appendix", so "Same settings again" silently downgraded a `detailed` document
from 20 visuals to 8 and cut its appendix; without the fence walk a summary
QUOTING the heading inside a code block reads as `detailed`.

**A kind-less document reports `storedKind: null`.** Absent `summary_kind` means
"written before kinds existed", which is not the claim `standard` makes. The
ingest still stamps the default (it IS what runs) and the payload names it as
`defaultKind`, so the menu can say *Same settings again (standard; written
before kinds existed)* without spelling a constant of its own. 1300 of the live
corpus's 1329 documents are in this state.

**Vimeo's output language is resolved, not defaulted.** The stored
`summary_lang` wins; absent (or not a language), it is `resolveOutputLang` over
the stored `caption_lang` AND the transcript text — the same pair the capture
uses, and the text is the deciding evidence because Vimeo really does mis-tag
(an `en-x-autogen` Norwegian talk, measured 2026-09-05). What this replaced was
`summary_lang === "nb" ? "nb" : "en"`, i.e. every pre-`summary_lang` Norwegian
talk re-summarized in English.

**`tags` are re-sent where the ingest model accepts them.** huginn REBUILDS the
line as `category.split("/") + req.tags`, deduped, so a hand-added tag is erased
by any ingest that does not re-send it; the re-run sends the stored list minus
the category parts. What that preserves is the tag SET, not the stored line's
BYTES: `build_summary_tags` always emits the category parts first and deduped, so
a line huginn wrote comes back byte-identical, while a HAND-EDITED one is
rewritten into huginn's own shape on the first pass (`javascript, ai, general`
is re-ingested as `ai, general, javascript`, and a duplicate is dropped) and is a
fixed point from then on.
Vimeo, TikTok and X accept the field; **YouTube's ingest model has none at all**
and `write_summary` is called without one there, so a hand-added tag on a
YouTube document is lost on every ingest, capture and re-run alike. Re-sending a
key pydantic's `extra='ignore'` drops would look like a fix and be inert, so the
loss is stated rather than worked around.

**`recentIngests` is told through a seam** (`src/summaries/recent-ingests.ts`):
each route registration hands over the `rememberIngest` it already has, and the
re-run calls it by source name after a successful ingest. Without it a paste of
the same video right after a re-run is captured a SECOND time, and on YouTube
that forks a shadow copy rather than only doubling the spend. Both verticals'
`rememberIngest` became DELETE-then-set with this PR: their old comment
enumerated why the key could never already be present, and a re-run breaks every
clause of that enumeration.

**No source draft.** A capture fires one from its summarizer; the re-run calls no
summarizer, and drafting a second wiki proposal for a document that already has
one is a duplicate the gate has to reject by hand. Pinned in the e2e by the model
call COUNT (exactly one for a whole re-run), which a drafter would double.

**`full: true` answers 501 on every vertical**, and the menu renders the item
disabled with the reason. The obvious implementation is unreachable by
construction — every vertical's own `POST /summarize` answers `duplicate` for a
document that exists, which a re-run's target always is — and calling the
summarizer function directly gets past that and past the title/category pin as
well, so a model that re-picked a different category would write a SECOND file.
