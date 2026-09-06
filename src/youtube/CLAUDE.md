# YouTube — the capture vertical

A YouTube URL to a summarized, indexed, citable video, into the
`youtube-summaries` collection. The entry point is the Chrome extension
(`extensions/youtube/`); the transcript comes from **huginn**
(`GET {knowledgeApiUrl}/api/youtube/transcript/<id>`), the summarization runs
here on `SUMMARIZER_BOT`'s connector, and the finished summary is ingested back
into huginn.

| File | Role |
|---|---|
| `state.ts` | The job store. Statuses `pending · fetching_transcript · downloading · extracting_frames · summarizing · ingesting · complete · error` — the middle two are the FRAMES path only |
| `frames.ts` | Everything the frames path DECIDES, all of it pure and import-free: `decideYouTubeFrames`, the height/format/cap/floor constants, `youtubeWatchUrl`, `transcriptUrl`, `youtubeDownloadTimeoutFor`, `capTranscriptWindows`, `appendTranscriptSection` |
| `summarizer.ts` | The job: probe → transcript → download → frames → `runCaptureOneShot` → ingest → source-draft |
| `../summaries/frames.ts` | The SOURCE-NEUTRAL frames seam this vertical uses whole — the cadence, the served root, the URL shape, the prompt section, the id gate, `keepReferencedFrames`, `removeKeptFramesForDocument`, `extractCadenceFramesFromFile`. See `src/vimeo/CLAUDE.md` for its full contract |

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

**The download is VIDEO-ONLY** (`bv[height<=720][ext=mp4]/bv[height<=720]`),
because the transcript comes from huginn and every byte of audio would be paid
for and thrown away; there is no uncapped tail, so an upload with no ≤720p video
rendition degrades to transcript-only rather than pulling 1080p to scale it
down. The cap is enforced **twice** — once by the probe and once by yt-dlp's own
`--break-match-filters duration <= N` (exit 101), for a video that grew between
the two calls. **There is no BYTE cap**, stated rather than papered over:
`--max-filesize` has no exit code of its own, so a caller cannot tell an
over-size refusal from an ordinary failure. What binds is the duration cap and
the whole-operation timeout.

**The video file is unlinked the moment the ffmpeg pass returns**, in a
`finally` so a failed pass unlinks too: `workDir` is what the model is handed as
`--add-dir`, and a 90 MB mp4 sitting in it through a ten-minute turn is bytes
the turn can read and nothing wants it to. The frames go in `workDir/frames`;
only the ones the summary QUOTES are copied to
`~/.muninn/frames/youtube/<videoId>/<sec>.jpg` (`keepReferencedFrames`), and the
work dir dies in the job's own `finally`.

**Every frames failure is a WARN plus today's transcript-only capture, never a
failed job** — a probe that says nothing, a live stream, a video under a minute,
yt-dlp rot, an ffmpeg error, a connector that cannot read files. The outcome
rides the trace as `frames` (`off · on · unsupported · duration_unknown ·
too_short · too_long · failed`) beside `frameCount`.

**Videos under 60 s skip frames, and it is a DURATION cut.** `frameBudgetFor`
still hands out 15 ticks below a minute, so the budget would sample a
40-second clip every 2.7 s — a download, 15 ffmpeg runs and 15 image reads for a
video whose transcript already says everything.

## The transcript with a clock

**`?timestamps=1` is asked for exactly when frames run** (huginn #129): huginn
then returns the transcript as `### [HH:MM:SS]`-headed 120 s windows, the same
shape muninn's Vimeo captures ingest. Never sent blank — an empty value is a
422 — and never on the frames-off path, whose URL and prompt stay byte-identical
to what shipped before slides existed. A frames pass that then FAILS keeps the
windowed transcript it already fetched: it is the better document either way,
and re-fetching the plain form to undo the decision would be a second round-trip
for a worse result.

**The windowed transcript is appended to the SUMMARY STRING sent to the ingest,
and only there.** huginn's `YouTubeIngestRequest` has no `transcript_markdown`
field — the Vimeo vertical's `body_suffix` route into `write_summary` is
Vimeo-only — so the document body is exactly what is posted as `summary`.
`appendTranscriptSection` puts it under `## Transcript` (level 2: the
`/summaries` article view's `splitTranscript` folds the tail on that heading, and
huginn's `MarkdownHeadingSplitter` cuts the section on the `###` windows inside
it, so a hit in a 40-minute talk cites to the minute), capped at 2 MiB **at a
window boundary** with a line saying so — a byte cut would leave a heading over
half a sentence and carry that timestamp into a chunk that ends mid-word.
`completeJob`, the shelf card, `setSimilar` and the source-page draft all get
the summary ALONE.

⚠️ **Two consequences of riding the summary string**, both accepted and both
retired by a `transcript_markdown` field on the YouTube ingest (filed
follow-up): huginn's similarity query for this source is
`result["summary"][:2000]`, so a summary shorter than 2000 characters lets the
first transcript window into that query; and `response_fields` echoes the whole
summary back, so the ingest response carries the transcript over HTTP. Neither
touches the stored document or anything muninn reads.

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
YouTube ingest writes through `write_categorized_markdown`, which dedups by FILE
PATH (`<category>/<sanitized title>.md`) and not by url — so a re-capture whose
auto-picked category or resolved title differs by a character leaves a SECOND
document in the corpus. (Where they match it overwrites, which is what made the
same bug invisible on the Vimeo side.) This map is the only thing in front of
that. Do not describe huginn as overwriting.

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

## CORS stays

Unlike the Vimeo vertical, `POST /api/youtube/summarize` keeps `applyCors` — the
entry point IS a Chrome extension, which is cross-origin by construction. Stated
because slides put a yt-dlp download, an ffmpeg pass and a 60-image model turn
behind that POST; what bounds it is `MUNINN_ALLOWED_ORIGINS` under
`MUNINN_AUTH`, which is where the extension's own origin is allowlisted.

**The id gate is route-WIDE, not frames-only, and runs before the huginn
listing read.** A `video_id` outside the frames seam's charset (11 URL-safe
base64 characters) is 400 `bad_video_id` — the id is already a path segment of
the transcript URL the transcript-only path fetches, and on the frames path it
becomes a directory name and a served address. Every real YouTube id passes, so
the only captures it refuses are ones that would have failed on the transcript
fetch anyway. Refusals use the shape the Vimeo route documents — `{error,
code}`, `error` PROSE and `code` the machine token — so the extension popup,
which renders `detail` then `error`, shows a sentence with no client change.

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
