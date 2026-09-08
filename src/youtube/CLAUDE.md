# YouTube — the capture vertical

A YouTube URL to a summarized, indexed, citable video, into the
`youtube-summaries` collection. The entry point is the Chrome extension
(`extensions/youtube/`); the transcript comes from **huginn**
(`GET {knowledgeApiUrl}/api/youtube/transcript/<id>`), the summarization runs
here on `SUMMARIZER_BOT`'s connector, and the finished summary is ingested back
into huginn.

| File | Role |
|---|---|
| `state.ts` | The job store. Statuses `pending · fetching_transcript · downloading · extracting_frames · selecting_frames · summarizing · ingesting · complete · error` — the middle three are the FRAMES path only |
| `frames.ts` | Everything the frames path DECIDES, all of it pure and import-free: `decideYouTubeFrames`, the format/cap/floor constants, `youtubeWatchUrl`, `transcriptUrl`, `youtubeDownloadTimeoutFor`, `capTranscriptWindows`, `appendTranscriptSection` |
| `scan.ts` | The DENSE scan's decision surface, pure: the 5 s grid, the block-signature dedup, the coverage-reserving cap, the contact-sheet layout and its label geometry (`cellLabelText`), the selection prompt + manifest parse, the two-pass budget split, and the `YOUTUBE_FRAME_SCAN` switch |
| `label.ts` | The FONT-FREE label renderer, import-free: a 5×7 glyph table, integer scaling, and a binary PGM strip. `drawtext` needs a libfreetype build the hosts do not have |
| `scan-run.ts` | Its ffmpeg half: one decode pass producing thumbnails + signatures, the labelled tiled sheets (`contactSheetArgs`), the full-height re-grab |
| `summarizer.ts` | The job: probe → transcript → download → frames (dense two-pass, or cadence) → `runCaptureOneShot` → ingest → source-draft |
| `kinds.ts` | `youtubeCaptureKinds` — the offer set this vertical narrows, called by the options route, the `bad_kind` check and the replay harness |
| `extension-options-rules.ts` | The popup's rules, pure and import-free — payload validation, restore-and-revalidate, the restore NOTE, the POST body. Emitted into `extensions/youtube/capture-rules.js` by `bun run build:extension` |
| `extension-build.ts` | That emitter. Bundles for the browser and normalizes bun's cwd-relative module banner, so the byte gate cannot depend on where it ran |
| `../summaries/frames.ts` | The SOURCE-NEUTRAL frames seam this vertical uses whole — the cadence, the served root, the URL shape, the prompt section (and its optional `FramesPromptPolicy`), the id gate, `keepReferencedFrames`, `removeKeptFramesForDocument`, `extractCadenceFramesFromFile`. See `src/vimeo/CLAUDE.md` for its full contract |
| `../summaries/visual-detail.ts` | The Selected/Detailed policy: the enum, the caps, the rubric the prompt states, and `enforceVisualReferences`/`dropFrameReferences`, the pass that holds the answer to it. See **Visual detail** below |

The route is `src/dashboard/routes/youtube-routes.ts`; the huginn half is the
`youtube` push source (`main/ingest/youtube.py`, `POST /api/youtube/ingest`,
collection `youtube-summaries`).

## Slides

**`frames` is a boolean on the route body, off by default.** A non-boolean is
400 `bad_frames`; `true` on a summarizer whose connector lacks
`supportsExtraDirs` is 503 `frames_unsupported` **before a job exists** (the
TikTok precedent). The extension popup carries the tick, remembered in
`chrome.storage.sync` under `frames`.

**The duration is learned BEFORE any bytes move, and that is the whole shape of
this path.** Nothing here has ever known how long a video is — not the route,
not the job, not huginn's transcript endpoint — and `downloadVideo`'s own
`--print-json` line arrives *after* the download it would have to bound. So the
frames path opens with one `yt-dlp --dump-json --skip-download --no-playlist`
probe (`probeVideoInfo`, ~3 s), and its `duration` drives all four things that
are about to be spent: the 3 h cap, the frame budget, the download budget
(`youtubeDownloadTimeoutFor`) and the summarize budget
(`summarizeTimeoutFor`). `decideYouTubeFrames` is that decision as a table, and
**`duration_unknown` is checked before the length cuts on purpose**:
`parseYtDlpJson` maps a missing `duration` to **0** (a live stream reports
none) and a failed probe hands over `null`, so both would otherwise fall under
the "shorter than a minute" cut and be reported as a clip.

**The yt-dlp target is derived from the validated `video_id`
(`youtubeWatchUrl`), never from `body.url`.** This route is CORS-`*` under
`MUNINN_AUTH=off` and the global origin check is mounted only in authenticating
modes, so handing yt-dlp a client-supplied URL would let any page spawn it
against an arbitrary host.

**The frames come from a DENSE SCAN and a SELECTION PASS, not from a cadence**
(the default; `YOUTUBE_FRAME_SCAN=cadence` restores the old sampler). See
**The dense scan** below — the cadence extractor is still what every failure
falls back to, and it is still what runs behind the switch.

**The download is VIDEO-ONLY** (`bv[height<=720][ext=mp4][vcodec^=avc1]/bv[height<=720][ext=mp4]/bv[height<=720]`),
because the transcript comes from huginn and every byte of audio would be paid
for and thrown away; there is no uncapped tail, so an upload with no ≤720p video
rendition degrades to transcript-only rather than pulling 1080p to scale it
down. **The first tier names the CODEC, and mp4 alone was not enough**: mp4 is a
container — measured on `SkVqJ1SGeL0`, `bv[height<=720][ext=mp4]` resolved to
format 398 (`av01`) on a video that also offered 136 (`avc1`), so every ffmpeg
seek paid for an AV1 decode. The tiers below drop the codec again, so a video
with no H.264 rendition still gets frames. The height is
`CAPTURE_FRAME_HEIGHT` (`src/summaries/frames.ts`), spelled out here because
`frames.ts` imports nothing.

The duration cap is enforced **twice** — once by the probe and once by yt-dlp's own
`--break-match-filters duration <= N` (exit 101), for a video that grew between
the two calls. **There is no BYTE cap**, stated rather than papered over:
`--max-filesize` has no exit code of its own, so a caller cannot tell an
over-size refusal from an ordinary failure. What binds is the duration cap and
the whole-operation timeout.

**The download and the ffmpeg pass run under ONE process-wide queue key**
(`framesQueue`, the Vimeo harvest precedent): the route's dedup only holds back
a second capture of the SAME video, so N distinct-id POSTs are N legitimate
captures — and must not be N concurrent 50 MiB downloads on a laptop also
running the dev server, the bots and huginn. A queue, not a try-lock: the second
capture waits and then runs. The section is entered twice (probe; then
download + extract) and is never held across the transcript fetch or the model
turn — what it guarantees is one yt-dlp / ffmpeg at a time, not one capture at a
time.

**There are TWO temp roots, and the split is what keeps the video out of the
model's reach.** `muninn-youtube-<jobId>` (`workDir`) holds the FRAMES and
nothing else, and is what the summary call is handed as `--add-dir`;
`muninn-youtube-media-<jobId>` (`mediaDir`) holds the downloaded rendition, the
scan's several hundred 320 px thumbnails and the contact sheets, and the ROOT is
named in no `extraDirs` at all — only its `select/` subdirectory, and only to the
selection pass. The sheets live there rather than in `workDir` so that neither
the summary call nor a CADENCE fallback is handed ten contact sheets of a scan
it is not being asked about. The video used to live in `workDir`, which is why it had to be unlinked the
instant ffmpeg was done with it — and on the dense path it cannot be, since the
re-grab happens AFTER a model call. It is still released early (right after the
re-grab, or in the cadence extractor's own `finally`), and the job's `finally`
removes BOTH roots recursively, so a selection pass that threw before the
re-grab still leaves no mp4 in `tmpdir()`. Only the frames the summary QUOTES
are copied to `~/.muninn/frames/youtube/<videoId>/<sec>.jpg`
(`keepReferencedFrames`).

**Every frames failure is a WARN plus today's transcript-only capture, with ONE
exception** — a probe that says nothing, a live stream, a video under a minute,
yt-dlp rot, an ffmpeg error, a connector that cannot read files all degrade. The
exception is the two-pass BUDGET GATE: a selection pass that leaves too little
of the announced budget for the summary call fails the job with the stage named,
because nothing can abort an in-flight connector call and launching it anyway
would overrun the number the job stated silently (see **The dense scan**). The
outcome rides the trace as `frames` (`off · on · unsupported · duration_unknown ·
too_short · too_long · failed`) beside `frameCount`, and WHICH sampler ran rides
as `frameScan` (`off · cadence · dense · prep_failed · scan_failed ·
sheets_failed · selection_failed · selection_empty · regrab_failed`).

**Videos under 60 s skip frames, and it is a DURATION cut** — an editorial rule
rather than a spend bound: nothing under a minute is a slide deck, its
transcript already says everything, and the frames would be a talking head. Note
what the cut ADMITS: `frameBudgetFor` hands out 15 ticks up to 60 s and **25** up
to 180 s, so the line sits immediately below its densest sampling — a 61 s video,
the shortest this admits, is measured at 25 frames, one every ~2.4 s. That is
deliberate — a two-minute lightning talk does have slides.

## The dense scan

**A slides capture samples the whole video every 5 seconds and then decides what
to look at properly.** The old shape was one frame per `frameBudgetFor` tick —
30 frames over a 29-minute talk, one every ~59 s — and a chart on screen for
four seconds simply fell between two of them.

The path, in order, with what fails where:

| Step | Where | On failure |
|---|---|---|
| download the ≤720p rendition into `mediaDir` | `framesQueue` section 1 | transcript-only (the existing rule) |
| **scan** — one ffmpeg decode → 320 px thumbnails + a 32×18 gray signature each | same section, `scan-run.ts` | `scan_failed` ⇒ cadence on the SAME download |
| **dedup + cap** — pure, over the signatures | `scan.ts` | — |
| **contact sheets** — 4×3 tiles of 320 px cells, ONE budget for all of them | same section | `sheets_failed` ⇒ cadence, with the scan's real counts |
| **selection pass** — a model call over the sheets, answering a JSON manifest | OUTSIDE every queue section | `selection_failed` ⇒ cadence; an EMPTY manifest is `selection_empty` + a warn, no slides, no fallback |
| **launch gate** — is there budget left for the summary call? | — | **fails the job**, stage named |
| **re-grab** — the chosen seconds at 720p, under ONE aggregate deadline | `framesQueue` section 2 | `regrab_failed` ⇒ cadence, on the cadence BUDGET, with any half-written frames cleared |
| **summary** — the ordinary capture call, over those frames | outside the queue | the existing failure path |

**No model pass ever holds the media queue.** The two ffmpeg halves take their
own sections, the second one AFTER the selection call returned; nothing calls
`framesQueue.run` from inside a held section.

**The sample named `<t>.jpg` IS the video at second t, and that took
`fps=1/N:round=up:start_time=0`.** The filter's default rounding is `near`: an
input frame at time t lands in slot round(t/N) and the slot emits the LAST frame
in it, so slot i carried the picture from just under `i x N + N/2`. Five things
read the number as exact — the file name, the cell the prompt labels, the second
the manifest answers with, the seek the re-grab performs, the URL the reader
loads — and nothing compared them: on the reference rendition 59 of 110
candidates disagreed with an `-ss <t>` re-grab of their own second by more than
the dedup's threshold, and after the fix 111 of 111 agree. `round=up` puts the
frame at exactly `i x N` in slot i; `start_time=0` anchors the grid at absolute
zero so a rendition that starts late does not shift every name by a slot.
`scan-run.test.ts` drives a synthetic clock clip whose luma encodes floor(t), and
the replay harness reports `regrabParity` per run.

⚠️ **That exactness is CONDITIONAL on the source being CFR**, and the condition
is the price of the count-based mapping. Across a source timestamp GAP longer
than the interval, `fps` FILLS the slot by repeating the last frame it decoded
before the gap, so the name is later than the picture. Measured on the clock clip
with the frames between 11.5 s and 19.5 s dropped and the original pts kept: the
sample named 15 carries the frame from second 11, and whether the dedup hides it
depends on the picture rather than on the gap — at one gray level per second the
fill scored 0.000 and was dropped (second 15 simply unrepresented), at forty it
scored 1.000 and was KEPT, named 15 and showing second 11. Nothing downstream can
see it: the count, the label, the manifest and the re-grab all read the same
name. Bounding it means naming samples from each emitted frame's real pts
(`showinfo`) — a change to the sampler, filed rather than made.

**Why a uniform grid and not scene detection.** Measured on the reference video
(1767 s, an article walkthrough with an inset presenter): plain
`select='gt(scene,0.25)'` returns 27 candidates over the whole video and two in
the 120–190 s window, missing two of the three named charts — the presenter
inset moves constantly and swamps a whole-frame scene score. A 10 s grid catches
two of the three; the third is on screen ~166–170 s and the 10 s grid's 170 s
cell is already the next page. A 5 s grid catches all three, and one sequential
decode over the whole file costs **6.7 s wall / 354 samples / ~5 MB**. The
change-aware detector (a stabilization window, region comparison) stays an
experiment and is not built.

**The signature is decoded by ffmpeg, never by Bun.** One `-filter_complex` with
a `split` produces both outputs off the SAME decode — the 320 px thumbnail and a
32×18 grayscale plane written as raw bytes — so the dedup compares 576-byte
arrays and never opens a JPEG. One ffmpeg per sample would be one spawn and one
seek per sample for the same work.

**The dedup is per BLOCK, and the comparison is against the previous KEPT
sample.** A whole-frame mean cannot tell "the presenter's head moved in the
corner inset" from "the slide changed"; splitting the plane into 8×6 blocks and
counting how many moved by ≥12 gray levels separates them by construction — a
talking head is 1 block of 48, a page turn is most of them. No block POSITION is
ever given meaning. Comparing against the previous KEPT sample rather than the
previous SAMPLE is what makes a slow scroll produce one candidate per screenful
instead of none at all. The threshold is **0.15**, calibrated on the reference
video: 354 samples → 111 candidates, with a frame inside all three chart
windows; 0.10 keeps 158 (mostly the inset moving), 0.20 already loses the second
chart's whole window.

**The cap reserves coverage before it ranks change, over TIME rather than over
candidate INDEX.** `YOUTUBE_CANDIDATE_CAP` is 120; past it, a third of the cap
goes to anchors evenly spaced over the video's DURATION — each taking the
candidate nearest its target time — and the rest to the highest-change survivors.
Ranking by change alone hands the whole cap to whichever stretch cuts most, so a
talk whose second half is one long screen-share would arrive at the selection
pass with nothing from its second half. Uniform over index the reserve failed at
exactly that job: anchors follow the candidates rather than the video, so a busy
opening that survives as 300 candidates and a half-hour screen-share that
survives as 30 kept 4 of the 30 — measured.

**Every cell carries its own label, burned in, and the font is HAND-CODED.**
`#<cell> HH:MM:SS` sits in a 30 px strip under each picture, and the prompt says
that label is where `tSeconds` comes from. `drawtext` is not an option — it needs
libfreetype support this machine's ffmpeg and the container images are built
without (`ffmpeg -filters | grep drawtext` finds nothing), so a sheet drawn with
it fails to build on exactly the hosts that matter. `src/youtube/label.ts`
renders the caption instead: a 5×7 glyph table for `0-9 : #` and space, scaled
×3, blitted into a raw **PGM** (`P5`) strip at exactly the cell width, which
ffmpeg reads as an ordinary input. `contactSheetArgs` then `vstack`s each cell
over its own strip, `concat`s the stacked cells into one stream and `tile`s that
— one ffmpeg process per sheet, 2N inputs (cells first, then labels, so cell `i`
pairs with input `n + i`). `setsar=1,format=yuv420p` on both halves pins ONE
explicit pixel format on both branches; it is not what makes them stackable.
Measured on ffmpeg 8.0.1, a raw JPEG cell and a gray PGM strip stack with no
normalisation at all (exit 0, 320×210, auto-negotiated `yuvj444p`) — the
normalisation is there so the sheet's own format is a decision rather than
ffmpeg's negotiation over whatever the rendition happened to be. The strip height
is EVEN by the same kind of choice: strip heights 21/29/30/31 all encode through
the shipped `contactSheetArgs` (1280×603 / 627 / 630 / 633, `yuvj420p`, exit 0),
so `assertLabelFits`' `% 2` check keeps the stacked cell height deterministic and
does not stand in front of a refusal.

The labels exist because the prose list was not enough. Through fix round 1 the
grid-position → second mapping lived only in `selectionPrompt`'s row-major list,
and on both `detailed` runs of the reference video the model applied it wrong:
second 170 called "the coding-agent usage chart" (it is the experiment-velocity
chart), 175 and 180 called charts (both are plain article text), 130 called a
text excerpt (it is the usage-growth chart) — with the sheet image and the list
each verified correct. The list is still there as a second channel, spelled
exactly like the label (`#9 00:02:10 (130)`) so the two are compared by reading;
the prompt says the label wins.

A label failure is a SHEET failure and nothing more: `renderLabelStrip` throws on
a caption that will not fit, which surfaces as `sheets_failed` and a fallback to
the cadence sampler on the video already downloaded. `assertLabelFits` runs at
module load so the constants cannot ship over-wide, and `assertGlyphTable` runs
at `label.ts`'s load so a mistyped glyph row cannot.

`CONTACT_SHEET = {cols: 4, rows: 3, cellWidth: 320}` is the named benchmark
variable; the cells are ROW-MAJOR. A short last sheet is padded by `tile`, its
padding cells carry no label and are simply not listed.

**The read arithmetic, once.** The selection pass reads ⌈120 / 12⌉ = **10**
sheets. The synthesis pass reads the re-grabbed frames, which the manifest caps
at 2 × the visual-detail policy's total — 16 under `selected`, **40** under
`detailed`. Both are under `YOUTUBE_FULL_READ_CAP` (60).

**The manifest is HELD, not trusted.** `parseSelectionManifest` scans EVERY
fenced block and then the whole text, walking brackets in a balanced,
string-aware way, and takes the first array carrying an OBJECT — a pass that
restated the schema in a fence before answering, or whose prose carried a
bracketed phrase of its own ("reading [sheet 1]"), used to throw the whole paid
call away. It then snaps a second off the grid to the scan interval, and drops
one the scan never sampled, a repeat, and anything past the limit; an unknown
category becomes `other` rather than dropping the entry. It answers **`null`**
when nothing parses at all — a failed pass, which falls back — and an array with
no objects in it (`[130, 145]`) counts as nothing parsing. Only a genuinely empty
array is "looked and found nothing", and that is `selection_empty` plus a warn
rather than a silently slide-less `dense` capture.

**The `reason` is held like the numbers are, because it is PROMPT INPUT.** Fix
round 1 put it on the frame's own line in `framesPromptSection`'s list
(`attachSelectionNotes`), where every other line is an address this capture can
serve — so a `\n` in it renders as one more `t=…` line naming a frame nothing can
grab. `holdReason` collapses every run of whitespace, control and format
characters to ONE SPACE (a space, never nothing: removing a byte must not join
two words), trims, and cuts past `SELECTION_REASON_MAX_CHARS` (160) back to the
last word boundary. A non-string is no reason at all, which is the bare category
the note already had for a reasonless entry.

**The deadline is arithmetic, not machinery.** Nothing can abort an in-flight
connector call: `executeOneShot` takes a `timeoutMs` and no signal. So the job
states ONE budget up front (`twoPassBudgetFor` — the selection call's own
timeout, the re-grab's `framesTimeoutFor`, and a full summary call at the
policy's frame cap), and gives each stage its own bound out of it. Two rules
that are easy to get backwards:

- **The summary call gets `summarizeTimeoutFor` and never the remainder.** It is
  the same number a single-pass capture of the same frame list gets; handing it
  what was left made the second call of a two-pass capture the most generously
  bounded call in the vertical (measured 1 398 000 ms against 840 000 ms).
- **The launch gate stays, as defence in depth.** When the remainder is under
  that number the second pass **does not start** and the job fails with the
  stage named — the case the cap cannot see is a selection pass that returned
  after its OWN timeout. Launching anyway would not stop early; it would run its
  own timeout and overrun the number the job announced.

Every other stage is bounded the same way: `buildContactSheets` spends ONE
budget across all ten sheets rather than `scanTimeoutFor(duration)` each, and
`regrabFrames` has one aggregate deadline rather than only per-frame ones. A
re-grab that fails resets the summary budget to the cadence path's own.

**Two trace-ownership paths, by design.** A dense capture makes two model calls,
so `summarizeVideo` opens the root itself (`createCaptureTracer`) and hands it to
both `runCaptureOneShot` calls as `parentTracer`, which makes the seam skip its
own `finish` — `Tracer.finish` has no idempotence guard. The caller then finishes
it exactly once on every exit path (`finishParent` nulls the field, so a second
call is a no-op), with **both passes' spend summed**. Every other capture —
frames off, the cadence switch, and every dense attempt that fell back — is
single-pass and keeps the seam's own root, so a fallback run legitimately writes
two roots: the abandoned two-pass one, finished `error` with what the selection
pass cost, and the seam's own for the summary. The selection span is
`claude:select`, never `claude`: `/models`' observed-model query and
`src/db/traces.ts` both join on that label, and two spans under one root sharing
it would clobber each other in the tracer's own map.

**`attachRun` accumulates.** The job-store spend fields (`inputTokens`,
`outputTokens`, `numTurns`, `toolCount`, `costUsd`) SUM across calls while the
identity fields stay last-write, so the `/agents` card reports the whole job
rather than its last call. Every single-pass vertical is unchanged by
construction: the sum of one value is that value.

**The switch is `YOUTUBE_FRAME_SCAN`** (`dense` by default, `cadence` the kill
switch). An UNRECOGNISED value is `cadence` plus a warn — the opposite of
`resolveServingProfile`'s refuse-to-boot rule and of `optionalEnvFlag`'s
treat-as-off rule, because this variable exists to turn the dense path OFF and a
typo that left it on would be the switch failing at its only job. It is in
`AMBIENT_INSTANCE_ENV`, so no suite inherits it.

**`selecting_frames` is a status of its own** because nothing streams during that
pass: it reads sheets and answers JSON, so a card left on "Extracting frames"
would sit still through a whole model turn.

**The completion line is found by a MARKER.** This vertical now writes a second
line carrying a `model` (the selection pass's), so `event: "capture_complete"` —
not "the last record with a model and a summaryKind" — is what the replay
harness matches; the selection line is `event: "selection_complete"`.

## The transcript with a clock

**`?timestamps=1` is asked for exactly when frames run** (huginn #129): huginn
then returns the transcript as `### [HH:MM:SS]`-headed 120 s windows, the same
shape muninn's Vimeo captures ingest. Never sent blank — an empty value is a
422 — and never on the frames-off path, whose URL and prompt stay byte-identical
to what shipped before slides existed.

⚠️ **What is WINDOWED is what huginn ANSWERED, never what was asked for.** The
#129 endpoint echoes `timestamps: true` when it windowed; a pre-#129 huginn
(127.0.0.1:8321 as this lands) ignores the parameter and answers a plain
transcript with no `timestamps` key. So `timestamped = data.timestamps === true`,
and the `## Transcript` section and the windowed rider ride on THAT — deriving
them from the frames decision put a `### [HH:MM:SS]` rider on a prompt whose
transcript had no headings, and filed a flat wall of text under `## Transcript`
as if it were windowed. It settles the frames-FAILURE case for free: the
transcript is windowed whether or not any frame came out, so the section and the
rider stay and only the slides go away.

**The windowed transcript is appended to the SUMMARY STRING sent to the ingest,
and only there.** huginn's `YouTubeIngestRequest` has no `transcript_markdown`
field — the Vimeo vertical's `body_suffix` route into `write_summary` is
Vimeo-only — so the document body is exactly what is posted as `summary`.
`appendTranscriptSection` puts it under `## Transcript` (level 2: the
`/summaries` article view's `splitTranscript` folds the tail on that heading, and
huginn's `MarkdownHeadingSplitter` cuts the section on the `###` windows inside
it, so a hit in a 40-minute talk cites to the minute), capped at 2 MiB **at a
window boundary** with a line saying so — a byte cut would leave a heading over
half a sentence and carry that timestamp into a chunk that ends mid-word. Three
rules the cap lives by: the note's own bytes come OUT of the budget (the result
never exceeds `maxBytes`, except in the note-alone band under ~100 bytes, where
the note by itself is the whole answer); a FIRST window bigger than the budget keeps a head of
it, never inside a code point, cut at a LINE boundary where the window has more
than one line and at a WORD boundary where it does not — which is huginn's real
shape, `### [HH:MM:SS]` over one unbroken line, and where a line cut kept the
heading and threw the talk away; a truncated answer ALWAYS carries the note, and
below ~100 bytes, where not even the heading fits, the note is what goes, alone
(a head with no note reads as a complete transcript); and `truncated` has a consumer — `summarizeVideo`
warns with both byte counts, or a talk whose second half never reached the
document is invisible outside the stored file. `completeJob`, the shelf card and
the source-page draft get the summary ALONE — **but `setSimilar` does not**: the
`similar` list is computed by huginn from `result["summary"][:2000]`, i.e. from
the string that carries the transcript.

⚠️ **Two consequences of riding the summary string**, both accepted and both
retired by a `transcript_markdown` field on the YouTube ingest (filed
follow-up): huginn's similarity query for this source is
`result["summary"][:2000]` (`main/ingest/registry.py`), so a summary shorter than
2000 characters lets the first transcript window into that query — which is what
the shelf card's "similar" list is ranked by; and `response_fields` echoes the
whole summary back, so the ingest response carries the transcript over HTTP. The
second is also why the ingest's abort budget is sized from the body
(`ingestTimeoutFor`, `src/summaries/summarizer-shared.ts`): 15 s over a 2 MiB
round-trip risks dropping the response after huginn has already written the
document, and that response is the only place the stored doc id appears — which
is what state 3 below is keyed on. Neither consequence touches the stored
document.

## The four dedup states

A video id is in exactly one of four states, and each needs a guard — a state
with no owner is a video captured twice:

| # | State | Guard | Answer |
|---|---|---|---|
| 1 | absent everywhere | — | capture it |
| 2 | claimed in-flight in this process | `inFlight` | `in_flight` + the running job's id |
| 3 | **ingested here, not yet listed by huginn** | `recentIngests` | `duplicate` |
| 4 | listed by huginn | `findExistingByVideoId` | `duplicate` |

**State 3 is huginn's REINDEX WINDOW and it was owned by nothing.** The
`/documents` listing is derived from `index_document_mapping.json`, which moves
only when the reindex enqueued after an ingest has run — seconds to minutes
later — while the in-flight claim is released the instant the capture settles.
`recentIngests` (`videoId → {documentId, existingUrl, at}`) is written from the
`onIngested` hook the summarizer calls on a successful ingest, read BEFORE the
listing, and bounded on both axes (`YOUTUBE_RECENT_INGEST_TTL_MS` 30 min,
`YOUTUBE_RECENT_INGEST_MAX` 200).

**On THIS vertical missing state 3 is worse than a double spend.** huginn's
YouTube ingest writes through `write_categorized_markdown`, which keys on the
FILE PATH (`<category>/<sanitized title>.md`) and then compares the STORED url:
same path + same url overwrites, same path + a DIFFERENT url forks `Title (2).md`
(`main/ingest/_markdown_writer.py`). So a re-capture whose auto-picked category
or resolved title differs by a character writes a second document under a second
path, and one whose url differs forks even where the path matches — which is why
`body.url` is no longer the caller's (below). This map is the only thing in
front of that.

**A `/summaries` Delete invalidates both halves.** `backlog-doc-delete` calls
`notifySummaryDocumentDeleted` after huginn confirmed the move; this vertical's
ONE listener drops the ingest entry, stamps `recentDeletes` (huginn's DELETE is
SOFT — the listing keeps naming the document until its reindex lands, so
forgetting the ingest map alone would only move the stale `duplicate` from state
3 to state 4) and removes the document's kept frames from inside the same
listener, never as a second listener of its own (the dedup half deletes the
ingest entry, so a second listener running after it in Set order would lose the
fast path).

⚠️ **Every `registerYouTubeRoutes` in a TEST passes a temp `framesRoot`**: the
listener set is module-level and never unsubscribed, so a registration with no
root would remove frames under the developer's real `~/.muninn/frames` on the
next test that fires the signal.

## The url, and the title

**Everything stored is built from the validated `video_id`** — `youtubeWatchUrl`
for the job's url, the ingest body, the system prompt's `Video URL:`, the
source-page draft and the dedup memory. `url` stays required (the extension
contract) but is stored NOWHERE: a POST naming video X with a url for video Y
used to store Y's address as X's `existing_url`, so every later capture of Y was
answered `duplicate` with a link to X's document. `summarizeVideo` takes no url
parameter at all, so there is no second place to get this wrong. `title` is
capped at 300 characters (`capYouTubeTitle`) — it is third-party text that
reaches the job card, the `/agents` run name, the prompt and huginn's file name.

## CORS stays

Unlike the Vimeo vertical, `POST /api/youtube/summarize` keeps `applyCors` — the
entry point IS a Chrome extension, which is cross-origin by construction. Stated
because slides put a yt-dlp download, an ffmpeg pass and a 60-image model turn
behind that POST; what bounds it is `MUNINN_ALLOWED_ORIGINS` under
`MUNINN_AUTH`, which is where the extension's own origin is allowlisted.

**`application/json` is REQUIRED (415 otherwise)**, the `jira-routes.ts`
precedent: Hono parses any body whatever the header says, and a `text/plain`
POST is a CORS *simple* request — no preflight — so without the gate a
cross-origin page could start a yt-dlp download, an ffmpeg pass and a 60-image
model turn with the browser never asking. Under `MUNINN_AUTH=off` the CORS
disposition is the wildcard one (`src/auth/cors.ts`) and no origin middleware is
mounted, so the gate forces a preflight but does not by itself bound the spend;
under an authenticating mode the route is admin-zone.

**The id gate is route-WIDE, not frames-only, and runs before the huginn
listing read.** A `video_id` outside the frames seam's charset (11 URL-safe
base64 characters) is 400 `bad_video_id` — the id is already a path segment of
the transcript URL the transcript-only path fetches, and on the frames path it
becomes a directory name and a served address. Every real YouTube id passes, so
the only captures it refuses are ones that would have failed on the transcript
fetch anyway. Refusals use the shape the Vimeo route documents — `{error,
code}`, `error` PROSE and `code` the machine token — so the extension popup,
which renders `detail` then `error`, shows a sentence with no client change.


## Kinds

**A capture writes one KIND, and the route decides which** — `kind` on the body,
absent ⇒ `standard`. A non-string, a PRESENT-but-blank string, or an id this
instance does not offer, is **400 `bad_kind`**, raised above the huginn listing read and above `createJob`
(the Vimeo ordering): a picker value the server does not offer is a refusal
whatever the video, and it must cost neither a round-trip nor a job row. It is
refused rather than quietly summarized as `standard` — the reader would read the
result as the kind they picked. Blank is refused for that same reason and not
folded into "absent": `findCapturePreset` reads a blank id as absent, which is
right for a key that is not there (an older extension, a curl) and wrong for a
picker that failed to fill.

**The kind set is the shared one, narrowed** (`youtubeCaptureKinds` in
`src/youtube/kinds.ts` — the ONE function the picker, the `400 bad_kind` and the
replay harness all call, so none of the three can offer what another refuses).
It passes `requireThinkingControl`, whose rationale — and the accepted
consequence that a Copilot summarizer bot is offered `deep` for Vimeo and
refused it here — is documented once, on that option in `src/summaries/presets.ts`.
A per-bot `captureSummary.<id>.md` kind runs with the default run options and is
never touched by either gate.

**What `deep` means, exactly:** `captureBotConfigFor` swaps in
`CAPTURE_DEEP_MODEL`, and `captureThinkingFor` returns `null` so the capture's
8 k thinking override is not applied at all — *full thinking* is the bot's own
configured budget (jarvis: 40 000), not an unbounded one. The swap happens
BEFORE `runCaptureOneShot`, which is what stamps the requested model onto the
`/agents` card and the trace span, so an in-flight Deep run says opus from its
first frame.

**It applies with slides off, on, skipped or failed.** `inheritThinking` is
`captureThinkingFor(preset) === null || frames.length > 0` — two independent
reasons, either sufficient. The old spelling was `frames.length > 0` alone, so a
yt-dlp or ffmpeg failure on a Deep capture silently reapplied the 8 k cap: a
deep-stamped document written under the capture cap, with one warn to say so.
`standard` keeps its own rule unchanged (the cap unless frames came out).

**What the kind leaves behind:** `summary_kind` on the ingest body — sent for
every kind, `standard` included, so *absent* keeps meaning "written before kinds
existed" — `summaryKind` and `thinking` on the trace span (the connector and the
requested model are the shared seam's, the returned model and the elapsed time
its end), and a completion log line naming the kind, the connector's OWN
reported model (`ClaudeExecResult.model`, `unknown` when it names none) and the
requested one. Never infer the observed model from the request.

## Visual detail

**How much of the video a slides capture may SHOW is a second axis, orthogonal
to the kind** — `visual_detail` on the route body, absent ⇒ `selected`. A
non-string, an unknown id, or a PRESENT-but-blank string is **400
`bad_visual_detail`**, raised beside the `frames` check and so above the bot
resolution, the huginn listing read and `createJob` (the `bad_kind` ordering, for
the `bad_kind` reasons). It is validated even with slides OFF, where it changes
nothing: the value is still either one this instance offers or one it does not,
and accepting a typo because of an unrelated field is worse than a 400. Deep
combines with either policy; the kind says how the summary is WRITTEN.

Both halves live in `src/summaries/visual-detail.ts` — the prompt states the
caps, and the pass enforces exactly those numbers on the answer:

| Policy | Inline | Total | Appendix |
|---|---|---|---|
| `selected` (default) | 8 | 8 | none |
| `detailed` | 8 | 20 | `## Visual reference`, before `## Transcript` |

**The rubric changed, and that is the point of the PR.** "A frame that ADDS
something the transcript did not say" excluded exactly the frames a talk is
about: a speaker reading their own chart aloud disqualified the chart. It is now
"helps explain, compare, verify or revisit a substantive point", charts,
diagrams, code, tables and legible article excerpts are visual evidence, and a
presenter's face in the frame disqualifies nothing (the reference video is an
article walkthrough with an inset presenter). Twenty is an initial product limit
to evaluate, not a measured optimum, and `MAX_INLINE_SLIDES` is NOT raised —
`framesPromptSection` throws on a policy that tries.

**How the vertical opts in:** `framesPromptSection` (the source-neutral seam)
grew an optional POLICY argument that replaces its rules paragraph and nothing
else. Called without one it is byte-identical to what shipped before policies —
Vimeo and every other caller — and a test pins that literally rather than by
`toContain`. The policy is built only where frames CAME OUT, because building it
needs an address and the seam's contract is that a frames-off capture never asks
the id gate anything.

**`detailed`'s must-quote rule rides on the FRAMES' notes, not on the policy.**
`visualDetailPolicy` takes a required `framesHaveNotes` — the summarizer answers
it with `frames.some(f => f.note)` — and states "every frame whose note above
calls it a chart or a diagram MUST appear" only where a frame carries one. Only
the dense scan's selection pass writes notes, so the cadence sampler, every dense
attempt that fell back to it and the `YOUTUBE_FRAME_SCAN=cadence` kill switch
were all being handed a MUST about a channel their prompt does not have. The
argument is REQUIRED rather than defaulted for the same reason: an omission is
how the rule reached those paths in the first place.

**Then the answer is held to it.** `enforceVisualReferences` walks every quote of
a frames address in the summary's PROSE and removes, deterministically and in
document order: a second that was never extracted, another video's id, another
source's frames, a non-canonical spelling (`047.jpg` — the file is `47.jpg` and
the route serves exactly that), a repeat of a second already kept, and anything
past `maxInline` (inline) or `maxTotal` (anywhere). Under `selected` there is no
appendix, so every quote counts against the one cap. ⚠️ **It runs on every
capture, frames on or off** — with nothing extracted, a frames address is by
definition invented, and a transcript-only summary must not promise pictures.
Four rules it lives by, each of them a way the first version disagreed with
itself:

- **A quote is what the COPY would serve, from one pattern.** `frameAddressRegExp`
  (`src/summaries/frames.ts`) — a markdown image OR link whose target starts with
  `/api/frames/` (any source) or this source's legacy prefix, any file name — is
  what this pass parses, what `keepReferencedFrames` keeps by and what the
  export rewrites by. A narrower pattern here left the link form and an alt
  carrying `]` uncapped, unremovable and copied anyway. The canonical-address
  check is one exported helper, `parseFrameAddress`.
- **Fenced blocks and inline code are skipped** by all THREE readers of a quote —
  this pass, the copy (`referencedFrameSeconds`) and the export's finder and
  rewrite (`src/summaries/export.ts`) — from one region set
  (`markdownCodeRegions`, `src/format/markdown-ast.ts` — the fact-check strip's
  walk, not a second fence detector). A quote inside a fence is a documented
  example; counting it spends a cap slot on a picture no reader sees, and a
  fenced block near the top could exhaust the whole policy. The export was
  fence-aware only for one round, and that is both halves of the disagreement in
  one place: it packaged a JPEG for a quote inside a backtick span that nothing
  else counted, and rewrote the address INSIDE the span — altered source text in
  what the reader copies out of the page.
- **The appendix is a SECTION, not one byte sequence.** The heading matches
  case-insensitively at level 2 or 3, with or without bold decoration, a missing
  space or a trailing colon, and is located fence-aware. It is cut WHOLE the
  moment no image survives in it, under EITHER policy: `selected` has no
  appendix at all, `detailed` loses one whose entries the pass removed, and both
  lose one that never held an entry — a heading over captions the pass would
  otherwise return verbatim, since the early return had been on the quote count
  alone. That is what bounds the orphan-caption
  residue: elsewhere a removed image's caption is left standing rather than
  risking real prose, but a caption under a heading with no images left is the
  whole section lying.
- **A kept quote's alt says the time its own file does.** An alt naming another
  time is corrected in place to the parsed second (words around it survive); the
  pass is the one place that knows both numbers.

A removed image takes its LINE when nothing else is on it — a bullet, a numbered
item, a heading marker, a bold label like `**Figure:**` or a blockquote arrow is
residue, not content — and a link WRAPPING an image (`[![alt](frame)](url)`) is
one quote, removed whole.

**Then the copy is checked.** `keepReferencedFrames` takes the pass's OWN
`referenced` list rather than re-reading the text, and copies **per file**: one
frame that cannot be copied costs its own reference and no other. It used to
throw on the first miss, and the summarizer's catch then dropped every reference
in the document while the JPEGs already copied stayed under the served root with
nothing left to serve them. Whatever the copy did NOT keep is dropped from the
text by `dropFrameReferences` before anything stores it; the stored summary, the
ingest body and the source-page draft are all built from that repaired string.

⚠️ **The rewrite happens AFTER the summary has streamed to the card**, so two
store flags carry it to the reader — `completeReplacesText: true` in `state.ts`,
which is where that reasoning lives, and `completeCarriesSummary: true` on this
route's `registerSummaryVertical` call, its replay half. This vertical set
NEITHER before. Driven in `capture-route-job-ordering.test.ts` through the real
route — a `Bun.serve` on an ephemeral port and a `fetch` of the SSE stream —
which is the only place the pair is observable together.

**Four frame counts, kept separate** on the completion log line and in the replay
harness's `run.json`: `extracted` (what the model was shown), `selected` (what it
chose), `referenced` (what survived the caps and the manifest) and `retained`
(what is on disk to serve). Collapsed into one number, a policy that over-quotes
and a model that under-selects are indistinguishable.

Two accepted limits, both plan-stated: the appendix rides the ingest body, which
`appendTranscriptSection` does not bound (that cap is the TRANSCRIPT's), and
huginn ranks `similar` on the first 2000 characters of the summary string, so a
short summary's neighbours are ranked partly on image markdown and captions.

## The options endpoint, and the picker

**`GET /api/youtube/options`** answers `{kinds: [{id, label}…], default_kind,
frames: {supported}, visual_detail: {supported, default, options: [{id,
label}…]}}` — the same resolution the POST validates against, so the extension
renders its picker from the server instead of from a catalog of its own. The
visual-detail block is LABELLED rows for the same reason `kinds` is, and its
`supported` is a constant `true`: nothing about that axis depends on the
connector, so its ABSENCE is the whole signal (a Muninn from before it existed),
and the popup then renders no such control and sends no such field. Two rules:

- **`applyCors`, exactly like the POST.** This module applies CORS inside the
  summarize handler only and registers a preflight only for `/summarize`, while
  the extension's `muninnUrl` is user-editable past the manifest's
  `localhost:3010` grant — so without the header this GET fails silently on
  every other install and the popup falls back to Standard-only, which is the
  one failure the endpoint exists to remove.
- **It stays a CORS *simple* request** — a `GET` with no custom headers — so no
  preflight is needed and none is registered.

The popup's own rules live in `src/youtube/extension-options-rules.ts` because
**the extension has no test harness**: an unusable payload (an older instance, a
proxy answering HTML, an empty list) becomes the Standard-only fallback AND a
sentence saying so; a remembered `kind` is re-validated against the CURRENT
options; a remembered Slides tick does not survive onto an instance that cannot
read frames; and an install from before the picker (`{frames}` and no `kind`) is
the default, not an error. `pickVisualDetail` runs the same re-validation on the
second axis and answers **null** where the instance offers no such capability —
which is what makes `buildSummarizeBody` omit the key rather than send a blank
one the route would refuse, and the popup sends null with Slides OFF too, since
the picker is hidden there and the policy is consulted only where frames came
out. The unreachable fallback offers **`selected` alone** — the `kinds` rule, not
the `framesSupported` one: an over-offered Slides tick is refused out loud (503 +
a sentence), while an instance that does not know `visual_detail` IGNORES the
key, so offering `detailed` there would be a choice that silently did nothing.
Every key the popup restores is NAMED in its `chrome.storage.sync.get` shape:
the object form answers with the shape's keys and nothing else, so a key left out
reads back `undefined` however much the profile holds. The popup
reveals the Visuals row only while Slides is ticked (`renderVisualRow`, called by
both the paint and the tick's own listener), remembers it under `visualDetail`,
and its settle path is driven in `popup-settle.test.ts`. `bun run build:extension` emits it into
`extensions/youtube/capture-rules.js` (`src/youtube/extension-build.ts`, with
`scripts/build-extension.ts` as the CLI wrapper and an `--out` override so the
co-located test can re-run it), and that test
compares the fresh bytes with the checked-in copy — a stale copy fails CI. The
output is bun's own codegen, pinned to CI's `BUN_VERSION`; a bun bump that
changes it is fixed by `bun run build:extension` plus committing the result.
`popup.html` loads `popup.js` as a module and the service worker declares
`"type": "module"`, since both import the emit.

## The replay harness

`bun scripts/replay-youtube.ts` re-runs a real capture as many times and in as
many kinds as you like, without touching the corpus. It exists because the live
vertical makes a comparison impossible three ways over: the route answers
`duplicate` before a job exists, `summarizeVideo` ingests and fires the source
drafter unconditionally, and the remedy that shape suggests — delete the
document, capture again — is what must not be done to production data.

It drives the summarizer directly over seams it already has: `deps`
(`probeVideoInfo` from ffprobe on a local file, `downloadVideo` copying that
file into the work dir, the REAL `extractCadenceFramesFromFile`, a temp
`framesRoot`, `sourceDraft: false` — the one seam this PR added, the route never
passes it) and a stub huginn on loopback that serves a saved transcript and
RECORDS the ingest. The MODEL CALL is real, on the resolved summarizer bot;
with `DATABASE_URL` set it also writes its trace, so the run appears on
`/traces` and `/agents`.

```bash
curl -s 'http://127.0.0.1:8321/api/youtube/transcript/<id>?timestamps=1' > transcript.json
# The selector is YOUTUBE_FRAME_FORMAT_SELECTOR in src/youtube/frames.ts — a
# TypeScript constant, not a shell variable. Copy it if it ever changes.
yt-dlp -f 'bv[height<=720][ext=mp4][vcodec^=avc1]/bv[height<=720][ext=mp4]/bv[height<=720]' \
  --no-playlist -o '<id>.mp4' 'https://www.youtube.com/watch?v=<id>'

bun scripts/replay-youtube.ts --video <id>.mp4 --transcript transcript.json \
  --video-id <id> --title "…" --kind deep --frames \
  --visual-detail selected --scan dense --runs 2 --out ./out
```

Per run it writes `summary.md`, the recorded `ingest.json`, the kept frames and
a `run.json` carrying requested vs observed model, the effective thinking
budget, connector, tokens, cost, elapsed time, the four frame counts
(extracted / selected / referenced / retained), the seconds the STORED text
quotes, and whether a `## Visual reference` appendix landed before
`## Transcript`. `--visual-detail` is validated by the route's own
`isVisualDetail`, so the harness cannot run a policy a capture could not.
Keep the fixtures OUT of the repo — muninn is public.

On the DENSE path it drives the real ffmpeg scan, the real sheets and a real
selection call, and `run.json` grows: `scanMode` and `frameScan` (which sampler
was asked for, and which one ran), `scanSamples` / `candidatesAfterDedup` /
`candidatesAfterCap` / `sheetCount`, the parsed `selectionManifest`,
`selectionPass` and `synthesisPass` as separate spend blocks beside the
accumulated totals, `scanWallMs` / `sheetWallMs` / `regrabWallMs` /
`cadenceWallMs`, `ffmpegWallMs` and `selectionWallMs` (the extraction wall split
at the model call, which is what makes the ffmpeg half comparable between runs),
`regrabParity` (every candidate's sheet thumbnail against an `-ss t` seek of the
same file, through the scan's own comparator — `matches` short of
`candidates - skipped` means the sampler and every consumer of its names
disagree; a comparison that could not be MADE, because the thumbnail is gone or
the re-grab failed, is counted as `skipped` and never as a difference), and
`peakScratchDiskBytes` — `du -sk`, sampled every 2 s WHILE the job runs, because
both temp roots are removed in its `finally` and a measurement afterwards is
always zero. `--scan` writes `YOUTUBE_FRAME_SCAN`
rather than passing a flag down, since that env var is the only channel the
summarizer reads it on.

## Testing

`frames.ts` imports nothing, so `frames.test.ts` runs in the shared chunk beside
`state.test.ts`. **`summarizer.test.ts` has its own `&& bun test` link in the
`test`/`test:unit` chains and MUST keep it** — it `mock.module`s
`../ai/one-shot.ts` and `../gardener/source-drafter-run.ts`, which a large share
of the suite imports transitively (`src/test/mock-isolation.test.ts` pins the
rule). huginn is a real local `Bun.serve` there rather than a mock: the exact
transcript URL and the exact ingest body are both on the wire, and a `fetchImpl`
seam would be a second implementation of the thing under test. yt-dlp and ffmpeg
are injected through `SummarizeVideoOptions.deps`; nothing in the suite
downloads or decodes anything. Route cases live in
`src/dashboard/routes/capture-route-job-ordering.test.ts`, which runs in a
process of its own for the same reason.

`scan.test.ts` is the dense path's decision surface with no ffmpeg and no video
— the signatures are built at the SHIPPED geometry (32×18, 8×6 blocks), because
a test over 4-byte arrays would pass against a comparator that divides by the
wrong number. `label.test.ts` is the glyph renderer over the bytes it produces —
no ffmpeg either, since a PGM is a header and one byte per pixel.
`scan-run.test.ts` drives the real ffmpeg over a 30 s fixture it
generates in-test with `-f lavfi` (a static colour, a cut, a moving pattern) and
`test.skipIf`s itself with a PRINTED line when ffmpeg is absent — CI has no media
binaries, and a silent skip reads as a pass. Neither mocks anything, so both sit
in the shared chunk.

⚠️ **No chain globs `src/youtube/`**: both `test` and `test:unit` enumerate this
directory's files one by one, and `src/test/mock-isolation.test.ts` checks
PRESENCE, not coverage — a new test file here is added to BOTH chains or it
never runs. `extension-options-rules.test.ts` sits in the shared chunk (it mocks
nothing) and calls `buildExtensionRules` (`src/youtube/extension-build.ts`)
IN-PROCESS — no subprocess. It also `process.chdir`s, to prove the emitted bytes
do not depend on the working directory, and restores the cwd in a `finally`.
