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
| `frames.ts` | Everything the frames path DECIDES, all of it pure and import-free: `decideYouTubeFrames`, the format/cap/floor constants, `youtubeWatchUrl`, `transcriptUrl`, `youtubeDownloadTimeoutFor`, `capTranscriptWindows`, `appendTranscriptSection` |
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

**Videos under 60 s skip frames, and it is a DURATION cut** — an editorial rule
rather than a spend bound: nothing under a minute is a slide deck, its
transcript already says everything, and the frames would be a talking head. Note
what the cut ADMITS: `frameBudgetFor` hands out 15 ticks up to 60 s and **25** up
to 180 s, so the line sits immediately below its densest sampling — a 61 s video,
the shortest this admits, is measured at 25 frames, one every ~2.4 s. That is
deliberate — a two-minute lightning talk does have slides.

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
never exceeds `maxBytes`); a FIRST window bigger than the budget keeps a head of
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
