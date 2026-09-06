# Vimeo — the capture vertical

Given a Vimeo URL, produce a summarized, indexed, citable conference talk. PR 1
was the transcript core; PR 2 added the job, the route and the ingest; PR 3 added
the UI entry — the URL field on `/summaries`. v2 added the kind/language picker,
the metadata, the media seam, inline slides and the Whisper fallback.

| File | Role |
|---|---|
| `url.ts` | `resolveVimeoRef` (a bare id OR any URL — the one door callers use), `extractVimeoVideoId` (host-gated), `canonicalVimeoUrl` (the dedup key), `vimeoWatchUrl` (the page to load) |
| `oembed.ts` | `fetchVimeoOembed` — title/author/duration/upload date/thumbnail with **no browser** |
| `vtt.ts` | `parseVttCues`, `vttToSegments`, `segmentsToMarkdown`, `detectCaptionKind` — pure |
| `captions.ts` | `harvestVimeoCaptions` (headless Chromium — captures the caption URLs AND the signed JSON `manifestUrl`), `downloadVtt` (host-pinned to `captions.vimeo.com`), `chooseTrack` (pure) |
| `download.ts` | `downloadPinned` — the ONE host-pinned, bounded byte download (`downloadVtt`'s rules, stated once), parameterised on host, caps and the noun in its messages; `VimeoDownloadError` is the base every refusal extends; it also OWNS the host constants (`VIMEO_CAPTIONS_HOST`, the `VIMEO_MEDIA_HOSTS` allowlist), so `captions.ts` and `media.ts` import a string from the module both already depend on and never from each other |
| `media.ts` | The media seam (v2 PR 3): `fetchVimeoManifest` (host-pinned to the `VIMEO_MEDIA_HOSTS` allowlist — `vod-adaptive-ak.vimeocdn.com`, `skyfire.vimeocdn.com`), `parseVimeoManifest` / `chooseRepresentation` / `segmentIndexAt` / `resolveSegmentUrl` (pure), `downloadRendition` (init + segments → ONE fMP4 ffmpeg reads) |
| `limits.ts` | `VIMEO_MAX_DURATION_SEC` alone, with NO imports — the route, the summarizer AND the server-rendered `/summaries` page read it, and a view importing `summarizer.ts` for one integer would drag playwright-core into the page render |
| `frames.ts` | Slides (v2 PR 4), the VIMEO half only: `VIMEO_FRAME_HEIGHT` (an alias of the seam's `CAPTURE_FRAME_HEIGHT`, kept because `chooseRepresentation` reads it as a manifest constraint) and `extractCadenceFrames` (one 720p segment per tick through `media.ts`, one ffmpeg grab each). Everything source-neutral is `../summaries/frames.ts` — see below |
| `../summaries/frames.ts` | The SOURCE-NEUTRAL frames seam: `FrameSource` (vimeo/youtube + their id charsets), the id gate, `cadenceTimes` / `formatHms` / `frameUrlPath` / `framesPromptSection` / `referencedFrameSeconds` (pure), `keepReferencedFrames` (the quoted ones → `~/.muninn/frames/<source>/<id>/<sec>.jpg`), `removeKeptFrames` + `removeKeptFramesForDocument` (a Delete's counterpart), `framesRootHasEntries`, `framesTimeoutFor`, the ffmpeg argv + grab (`raceKill` is the per-grab kill-and-reject, so a hang is reported as a timeout rather than as `exit 143`), `FRAME_MAX_DURATION_SEC` (the cadence refuses a duration whose ticks would not be servable file names), `extractCadenceFramesFromFile` (a vertical holding the whole video on disk), and the one-time root rename |
| `whisper.ts` | The no-captions fallback (v2 PR 5): `transcribeOpusRendition` (the whole Opus rendition through `media.ts` → ffmpeg → `whisper-cli -l auto -ovtt` → a WebVTT `vttToSegments` windows like a caption track), `whisperUnavailableReason` (the pre-flight — binaries + model — BEFORE any download), `parseDetectedLanguage` / `isEnglishOnlyModel` / the two clocks (pure) |
| `state.ts` | The job store (`createJobStore`), statuses `pending · harvesting_captions · downloading · transcribing · extracting_frames · summarizing · ingesting · complete · error` (`downloading`/`transcribing` only on the Whisper path) |
| `summarizer.ts` | The job: harvest → download → window → `runCaptureOneShot` → ingest → source-draft. `buildVimeoSystemPrompt` composes the envelope around the KIND's structure bullets, then the auto-caption rider, then the language rider LAST |
| `metadata.ts` | `speakerFromTitle` — the last ` - ` segment of a CONFERENCE account's title (`VIMEO_CONFERENCE_ACCOUNTS`, JavaZone today), undefined for everyone else — pure |
| `../summaries/presets.ts` | The capture KINDS (`standard` · `deep` · `talk-notes`), per-bot `prompts/captureSummary.<id>.md` overrides, and the two run levers a kind can pull (`captureThinkingFor`, `captureBotConfigFor`) — pure |
| `../summaries/language.ts` | `talk \| nb \| en`, `resolveOutputLang` (the `talk` rule: transcript text first via `detectTextLang`, caption base tag second via `langFromCaptionTag`), `captionBaseLang` (shared with `chooseTrack`) and the ONE spelling of the bokmål/English rider, which `src/share/prompt.ts` re-exports |
| `fixtures/totto-trust-but-verify.vtt` | Real auto-captions from a public JavaZone talk: 63 KB, 928 cues, 53 min |
| `fixtures/manifest-placeholder.json` | A real manifest's SHAPE (5 video + 2 audio representations in the live manifest's UNSORTED order — 1080, 360, 720, 540, 240 — real codec strings/bitrates/heights/init segments, 12 segments each) with every signed path, id and URL replaced by a placeholder — the test pins that no live `pathsig`/`hmac`/`psid`/UUID survives, and that the order is the live one |

The route is `src/dashboard/routes/vimeo-routes.ts`; the huginn half is the
`vimeo` push source (`main/ingest/vimeo.py`, `POST /api/vimeo/ingest`, collection
`vimeo-summaries`).

## Kind + language (v2 PR 1)

**The route body is `{url, kind?, lang?}`, validated BEFORE oEmbed.** A kind
is looked up in the SUMMARIZER bot's resolved preset set (`resolveCapturePresets`
over its `prompts.captureSummaryVariants`, so a per-bot `captureSummary.<id>.md`
is a kind the route accepts); a language must be one of `talk | nb | en`.
Absent is the default (`standard`, `talk`); present-but-unknown is a 400 carrying
`code: bad_kind` / `bad_lang`, which the card renders from the same sentence map
as every other refusal — never summarized as `standard` on the reader's behalf.
Validated first because the oEmbed call is a network round-trip and the answer
does not depend on the video. The summarizer bot is therefore resolved ABOVE
oEmbed too, which moved the "No bots configured" 500 up with it.

**`talk` is resolved in the SUMMARIZER, not the route — from the TRANSCRIPT
first, the caption tag second.** Both exist only after the harvest.
`resolveOutputLang(pick, captionLang, transcript)` asks `detectTextLang` — a
function-word count over the windowed transcript (`og/ikke/det/er/som…` against
`the/and/is/to/of…`, no word spelled the same in both, ≥`TEXT_LANG_MIN_HITS`
(20) hits, a ≥70 % share AND ≥`TEXT_LANG_MIN_DISTINCT` (6) different markers
on the winning side to call it, `null` otherwise — the distinct floor exists
because composed French and Spanish scored 100 % Norwegian through the single
marker `de`, measured in the review of #525; `de` is out of the set too) — and only when the text
does not say falls back to the tag's BASE subtag (`langFromCaptionTag`:
`no`/`nb`/`nn` ⇒ bokmål, anything else, an empty tag included ⇒ English). The
text comes first because the tag is not a reliable signal: Vimeo tagged the
Kotlin lightning talk's auto-captions `en-x-autogen` while the speech is
Norwegian (measured 2026-09-05), and `talk` produced an English summary of a
Norwegian talk; the text cannot be mis-tagged. When the two disagree the job
logs one info line ("the text wins"). `caption_lang` on the document stays what
Vimeo said — provenance — and `summary_lang` is the resolved language. Nynorsk
speech gets a bokmål summary — the rider knows one Norwegian; a Swedish or
Danish talk shares enough markers to read as Norwegian and lands on the bokmål
rider, the better of the two outcomes on offer; German, Dutch, French and
Spanish measure `null` and the tag decides. Deterministic, no model call. The
"text wins" info line names the caption language's SOURCE (a track tag, or
whisper's detection on the no-captions path) and is logged only for `talk`.
The committed 53-min fixture is Norwegian auto-captions and reads `nb` at a
95 % share, so a `VIMEO_HARVEST_STUB` acceptance run left on `talk` now
produces a bokmål summary where it produced English.
The document carries the RESOLVED language (`summary_lang: nb|en`), never
`talk`, and the kind id (`summary_kind`); huginn allowlists both (huginn #126,
merged first).

**The language rider is the LAST thing in the system prompt** — after the kind's
structure and after the auto-caption rider — for the reason the share prompt puts
its rider after the instruction: the language is the reader's pick (or the talk's
own) and nothing a preset says may un-pick it. `buildVimeoSystemPrompt` is
exported so a test can pin that order.

**A kind is instruction + run options, and a file on disk can only replace the
instruction.** `deep` is `standard`'s structure on `claude-opus-5` with the
thinking cap lifted (`thinkingMaxTokens: null`, the TikTok mechanism); a per-bot
`captureSummary.deep.md` keeps those run options, and a NEW per-bot id runs like
`standard`. The model swap applies only on connectors whose model ids are
Anthropic's (`claude-cli`, `claude-sdk`, `copilot-sdk`); on `openai-compat` the
bot's model stays and the job logs one warn naming that, so a `deep` capture on
an Ollama bot is honest about what ran. `talk-notes` is a `## Timeline` of
`### [HH:MM:SS] <section>` blocks anchored on the transcript's own window
headings, with the shared ingress/takeaways/closer around it so it still reads
as a summary on the shelf. `should-i-watch` is wanted and deliberately not built
(it pays on a backlog day, which needs batch paste); it is one more entry in
`SHIPPED_CAPTURE_PRESETS` when it lands.

**The picker is remembered per browser**, under `muninn.summaries.capture.v1`
(`sum-submit-form.ts`): every `localStorage` read and write is in a try/catch, a
stored value the server no longer offers is ignored per axis (the select keeps
its first option — the server's default — rather than landing on a blank), and
the picker rides on every capture POST, the article-box forward included. No
`selected` attribute is server-rendered: the browser's memory is the script's,
and a server-picked option would win over it.

**A kind the SUMMARIZER bot's connector cannot honour is not offered.**
`resolveCapturePresets(prompts, connector)` drops an opus kind on a connector
outside the Anthropic namespace, so `/summaries` never shows `deep` for an
Ollama/Vertex summarizer and the route 400s a client that posts it anyway —
otherwise the capture would run on the bot's own model and still be stamped
`summary_kind: deep`, a document lying about itself. The summarizer's own
model-stays warn is defence for a hand-built preset, not the product path.

**Measured 2026-09-05 — the retrieval question the plan left open is closed, no
anchor block.** With an ENGLISH summary on a Norwegian talk, Norwegian `?q=`
hits were transcript windows first (0.999/0.996, the summary chunk 0.991 or
absent); with a NORWEGIAN summary the top matched chunks were the summary's on
all three queries (1.0/1.0/1.0; 0.997/0.995/0.994; 0.999/0.961 over a 0.927
transcript window). The Norwegian summary ranks BETTER than the transcript, so
`talk` stays the default and the English `## Key takeaways` anchor is not built.
Table + queries: muninn #520.

## Metadata + deep links (v2 PR 2)

**What oEmbed knew is on the document.** The route already held `author_name`,
`upload_date` and `thumbnail_url` and threw them away; they now ride on
`VimeoJobMeta` and the ingest body as `author`, `upload_date`, `speaker`,
`thumbnail_url` (huginn #127 allowlists the four — `author` globally, which
also surfaces the x/tiktok/article authors that were written and never
served). Each is sent only when NON-EMPTY: huginn writes what it is sent, and
`author: ""` on a document is a wrong fact, not a missing one. `upload_date`
is its own key because `date` is the CAPTURE day the shelf buckets on (#519).

**The speaker is derived, and only from an account whose convention we know.**
Vimeo has no speaker field; JavaZone titles its uploads `<talk> - <speaker>`
(9 of the 10 RSS items on 2026-09-05; the tenth had no ` - ` and yields no
speaker; `… - Handle - Full Name` with a handle), so `speakerFromTitle` takes
the LAST ` - ` segment — but only when `author_name` is in
`VIMEO_CONFERENCE_ACCOUNTS`. An individual's "Kotlin - the good parts" is not
a talk by "the good parts". Two speakers stay one string; the convention has
no separator for them. Derived from oEmbed's own title, never the
url-fallback title, which is an address.

**The shelf card shows the poster frame off the listing it already fetches.**
`/api/summaries/documents` asks huginn for `include_thumbnails=1` beside
`include_dates=1` (one read per document either way), and `thumbnailHtml`
renders an `<img>` only for an `https:` url — the value is a frontmatter
string off a document, and an `<img src>` is a fetch the reader's browser
makes to whatever it names — lazily, so a 200-row shelf does not fetch 200
frames on load.

**Every timestamp in a Vimeo capture is a click into the video.** The article
view (`sum-article-library.ts`, `linkVimeoTimestamps`) rewrites `[HH:MM:SS]`
and `[MM:SS]` in the MARKDOWN — the transcript's `### [HH:MM:SS]` window
headings and anything the summary cites — into `[\[HH:MM:SS\]](https://vimeo.com/<id>#t=<sec>s)`,
which the Vimeo player honours, opened in a new tab like every other outbound
link in the view (`openVimeoLinksInNewTab`, set after render — markdown cannot
say `target`); the label keeps its brackets so the page reads as before. The
url is the DOCUMENT's (`doc.url`), because a `?doc=` deep link — the duplicate
answer's own link — opens the panel with no url at all (measured: plain text).
Fenced code is left alone (a timestamp inside a quoted config is source text;
a fence closes on its OWN marker, so a `~~~` line inside a ``` block is
content), inline backtick and 4-space indented code are not skipped
(accepted, rare), and a bracket already followed by `(` is an existing link. The
video id is a CLIENT mirror of `src/vimeo/url.ts`'s rule over the two shapes
stored documents carry. ⚠️ Both client functions live inside a template
literal: every backslash is DOUBLED in the `.ts` source, and a regex that reads
right there with a single one is a broken page script (measured: the first cut
took the whole `/summaries` inline script down, and the harness test
`sum-article-library.test.ts` — which evaluates the REAL script source — is
what catches it).

## The media seam (v2 PR 3)

**The manifest is the mechanism; the browser screenshot path is closed.** The
plan measured it three ways (0 frames in 3 runs — the player never decodes video
on demand in a headless tab), while the signed JSON manifest the harvest was
already recording as `manifestUrl` answers a bare cookie-less `fetch`: 928 KB for
a 53-minute talk, five H.264 renditions (240p–1080p) and two audio (AAC, Opus),
each 537 segments of ~6 s with `start`/`end`/`size`/`url` and a base64
`init_segment`. `src/vimeo/media.ts` turns that into a file: fetch the manifest,
`chooseRepresentation`, map times to segment indices, `downloadRendition` writes
init + the segments as ONE fragmented MP4. Measured 2026-09-05 through
`scripts/smoke-vimeo-media.ts`: a single 720p segment (486 KB) is a valid fMP4
whose `ffprobe start_time` is the segment's ABSOLUTE position (`1386.08`), so a
frame pulled from it is stamped with its place in the talk with no arithmetic —
and one Opus segment probes as `opus/48000`, which is what PR 5's Whisper
fallback needs. The whole harvest → manifest → segment → JPEG walk is ~4 s.

**One download engine, three hosts' worth of rules.** `downloadVtt`'s body
moved to `download.ts` as `downloadPinned(url, {host, maxBytes, timeoutMs,
what, error})` and is now what the manifest AND every segment go through: https
only, hostname compared exactly, `redirect: "error"`, the budget RACED at every
read, the cap REFUSING and ABORTING the request at the byte it is crossed.
`downloadVtt` is a six-line caller of it (`what: "Caption"`, its own error
subclass, so its callers' `instanceof VimeoVttDownloadError` still holds — the
44 captions tests pass unchanged, bar one stub that faked `text()` and now fakes
`arrayBuffer()`, because the engine reads bytes and the caller decodes). A
second copy of that engine with a different host string is how the two would
have drifted on the next fix round.

**The host pin is judged where the bytes are fetched, never where the URL is
built.** `resolveSegmentUrl` RESOLVES in three steps like a DASH client — the
manifest's `base_url` against the manifest URL (`../../../../../range/prot/`
climbs five directories from the `playlist.json` to `/…/v2/`), the
representation's `base_url` against that, the segment's `url` against that —
each a URL resolution and never a concatenation (`"abc" + "def.mp4"` is not
`abc/def.mp4`; a base with no trailing slash is a file reference the next step
replaces). Every live representation carries `base_url: ""` (measured), so the
non-empty branch is pinned by the test, not by the corpus. It returns a STRING;
`downloadPinned` re-parses and refuses it. A manifest whose `base_url` names another host therefore
resolves there and is refused before any request is sent, with the partial file
never created — pinned in `media.test.ts`. The manifest URL itself is pinned the
same way, so `fetchVimeoManifest` on a `captions.vimeo.com` address is a
`VimeoMediaDownloadError`.

**`chooseRepresentation` is pure and picks the SMALLEST rendition that
suffices.** Video: the smallest height at least the target, the tallest available
when none reaches it — a frame the model reads gains nothing above what it is
scaled to, and a 1080p 6 s segment is ~1.6× the bytes of 720p (592 KB vs 371 KB,
measured). Audio: the requested codec family (`opus` for Whisper — 101 kbps
against AAC's 194 for the same speech), else the lowest average bitrate. A
representation with no segments is never chosen; the manifest's arrays are not
mutated (the live manifest lists renditions UNSORTED — 1080p, 360p, 720p, 540p,
240p, the order the committed fixture keeps — so the sort is load-bearing and
happens on a copy).

**Four bounds on a rendition download, each its own constant — and the sizes
the manifest DECLARES are third-party input too.** `VIMEO_MANIFEST_MAX_BYTES`
(8 MB; a 3 h talk's manifest is ~3.2 MB by the measured rate),
`VIMEO_SEGMENT_MAX_BYTES` (16 MB per segment; the largest measured is 1.2 MB),
`VIMEO_RENDITION_MAX_BYTES` (256 MB — the whole 240p rendition of a 3 h talk is
~176 MB, the whole Opus ~137 MB), and the whole-operation budget
`renditionTimeoutFor(n)` = 30 s + 1.5 s × segments, from which each segment fetch
gets `min(30 s, what is left)` (pinned: a never-settling fetch under a 50 ms
whole budget rejects in ~50 ms measured, under 250 ms asserted, not 30 s). The
rendition cap is checked TWICE on the SAME quantity — the bytes the call will
write, init segment included: on the declared total before the first fetch, so
an oversized request costs nothing, and on the bytes WRITTEN as they arrive —
the first review found the declared check alone let bodies far larger than
their declared sizes through (the pin: `media.test.ts` "the total cap bounds
bytes WRITTEN, not only bytes declared" — the numbers live THERE, not here),
and a negative declared `size` cancel a positive one (parse now refuses
negative `size`, `start`, `end`); the verify pass found the two checks
measuring different things (init in one, not the other), so a cap exactly at
the declared total passed the pre-flight and failed after every fetch (the
pin: "the declared pre-flight and the written check measure the SAME
quantity"). **The declared size is NOT exact.** Every live segment arrives at
declared + 1 byte — measured 2026-09-05 on 20 segments across four of the seven
renditions (720p, 1080p, 240p, Opus), +1 every time: the segment URL's
`range=a-b` is an INCLUSIVE byte range and `size` is `b − a`; init segments
run 678–806 bytes by rendition (the 720p one is 803), so the smoke's
"declared 485 621, wrote 486 425" is 803 + 485 622. A segment that
arrives SHORTER than it declared is refused outright (a truncated fMP4 is a
file ffmpeg reads up to the cut and reports success on — the one failure the
engine's own cap cannot see, since a cap bounds "too much"); the check is `<`
and must stay `<`, because `!==` fails 100% of live captures on the first
segment. When a segment is handed the last sliver of the budget and times out,
the error names the WHOLE operation ("Rendition download timed out after Nms
(k/n segments)") rather than the sliver ("Segment download timed out after
2ms" — true and useless). On any failure the partial file is unlinked.

**Indices need not be contiguous.** A sparse set (one segment per cadence tick,
the PR 4 shape) is a valid fMP4 with gaps whose frames still carry absolute
timestamps; a contiguous run is a playable rendition (the PR 5 shape, and scene
detection's if the skip trigger asks for it). Duplicates are collapsed and the
file is written in INDEX order whatever order the caller asked in. Fetches are
sequential — one socket to the CDN, bytes appended, no reassembly — which the
sparse shape does not notice and the whole-rendition shape pays ~0.15 s per
round trip for (537 Opus segments ≈ 80 s), accepted until measured otherwise.

**The manifest is fetched in the same job as the harvest and never persisted**
— it expires like the VTT (~3.5 h). Nothing in PR 3 calls the seam from the
summarizer yet; PR 4 (frames) and PR 5 (Whisper) are its callers.

```
bun scripts/smoke-vimeo-media.ts --at 1390 --height 720 https://vimeo.com/1223642971
bun scripts/smoke-vimeo-media.ts --audio --at 600 https://vimeo.com/1223642971
```

The smoke harvests the live manifest, downloads ONE segment of the chosen
rendition, `ffprobe`s the file and (video) pulls a JPEG at `--at` — the
mechanism itself, which no offline test can prove. Unknown flags are refused
(exit 2), as in `smoke-vimeo.ts`.

## Slides in the summary (v2 PR 4, cadence tier)

**One 720p frame every ~40 s of talk, read by the model, quoted inline where it
adds something.** The manifest half is `src/vimeo/frames.ts`; **everything a
second vertical would need is `src/summaries/frames.ts`**, which owns the
cadence, the served root, the URL shape, the prompt section, the id gate, the
kept-frame copy and removal, the ffmpeg argv and the file-based
`extractCadenceFramesFromFile`. **The YOUTUBE vertical is that second vertical
now** (`src/youtube/CLAUDE.md`): it holds the whole video on disk, so it uses
`extractCadenceFramesFromFile` and the seam's `youtube` `FrameSource` and adds
only its own pure decisions — the yt-dlp probe that gives it a duration at all,
the video-only format selector, and the `?timestamps=1` transcript. Anything
BOTH verticals need belongs in the seam, never here. The dependency is ONE-WAY — the seam never
imports this module, and a second copy of a constant next door is exactly the
two-literals failure `src/video/media.ts` documents for the frame budget.
`cadenceTimes(duration)` is
`frameBudgetFor(duration)` ticks (the TikTok/X budget — 30 at 10 min, ceiling 60
from 40 min, spacing growing past that) at the MIDPOINTS of equal slices, whole
seconds, so the first frame is not the t=0 title card; `extractCadenceFrames`
fetches, per tick, the ONE 6 s segment covering it through PR 3's
`downloadRendition` (a segment shared by two ticks is fetched once) and pulls
one JPEG with `ffmpeg -ss <t − segment.start> -frames:v 1 -vf scale=-2:min(720\,ih)` —
the seek is RELATIVE to the segment's `start_time`, which is absolute, and the
`min()` is why a rendition BELOW 720p (which `chooseRepresentation` falls back
to when nothing reaches the target) is no longer upscaled into twice the bytes
and twice the image tokens for the same picture. 60 frames
≈ 22 MB of fetches, one budget (`framesTimeoutFor`, 30 s + 3 s/frame), and a
failure on ONE frame fails the pass: a summary that quotes slide 23 and never
saw 24 is a partial record presented as complete. Cadence, not scene
detection, deliberately — the plan's skip trigger decides whether scene
detection is ever built.

**`frames` is a boolean on the route body, off by default, pre-flighted BEFORE
oEmbed.** A non-boolean is 400 `bad_frames`; `true` on a summarizer whose
connector lacks `supportsExtraDirs` is **503 `frames_unsupported`** before a job
exists (the TikTok precedent), rendered by the card from the one sentence map —
slides are opt-out, never a silent skip. On `/summaries` the **Slides checkbox**
(`captureUrlFormHtml`, `framesSupported` from `GET /summaries`'s
`connectorCapabilities(summarizerBot)`) renders DISABLED with the reason in its
title where the route would 503, and a disabled box posts `false` whatever
storage remembers — a tick taken on one instance must not 503 on another. The
tick is remembered under the same `muninn.summaries.capture.v1` key as kind and
language, restored only as a real boolean `true` — and a disabled box never
WRITES `frames`: kind/lang changes persist the whole picker, so a disabled
instance would otherwise erase a tick made on another one.

**The harvest WAITS for the manifest when frames are wanted, and the media
host is an ALLOWLIST.** Measured on the first live frames capture: the caption
URL arrives before the player asks for its playlist, so a harvest that closes
on the captions reports no manifest and a reader who ticked Slides gets none.
`awaitManifestMs` (`VIMEO_MANIFEST_WAIT_MS`, 10 s, inside the harvest budget)
keeps the page playing until the URL lands; transcript-only captures pass
0 and close as before. **The URL's PRIMARY source is the player's `/config`
response** (`request.files.dash.cdns[default_cdn].avc_url` — the AVC-only
manifest, since `chooseRepresentation`'s video branch picks by height and
never by `codecs` — then `url`, read by
`manifestUrlFromPlayerConfig`, host-pinned, body capped at
`VIMEO_PLAYER_CONFIG_MAX_BYTES`), and the player's own
`playlist.json` request is only the fallback — because the player picks DASH
or HLS per page LOAD. Measured 2026-09-06 on `vimeo.com/1223305711`, six
harvests: two loads streamed HLS (`…/playlist/av/primary/sub/<track>/prot/…/playlist.m3u8`
+ `media.m3u8` variants) and never requested the JSON, and the harvest, which
then took the first `/playlist/av/` request, recorded the m3u8 — so
`fetchVimeoManifest` failed on `#EXTM3U` ("Manifest is not JSON") and a
Slides capture landed transcript-only. The m3u8 path cannot be rewritten to
the JSON one (`pathsig` covers the path: 403 with the query, without it, and
with only the signature), but the config names the JSON URL on every load and
it answers 200 during an HLS load. The sniff is `.json`-only now: an HLS-only
load with no readable config reports NO manifest (frames skipped with the
warn) rather than a manifest that fails. And the second acceptance talk (`vimeo.com/1223423400`)
is served from `skyfire.vimeocdn.com`, not `vod-adaptive-ak` — identical
manifest shape, different CDN host, so a single host string missed it
entirely (the wait then expired for nothing). `VIMEO_MEDIA_HOSTS` in
`download.ts` lists both measured hosts; the harvest records a `/playlist/av/`
request only on one of them (`isMediaHostUrl`, the same predicate the download
pin applies, so what is recorded is exactly what will be fetched), and a new
host is added there with the video it was measured on — matched exactly,
never by suffix.

**In the job, frames sit between harvest and summarize as `extracting_frames`,
and every failure is a WARN plus transcript-only, never an error job.** No
`manifestUrl` from the harvest (no readable `/config` inside the wait AND the
player never requested a `playlist.json` — an HLS load never does — or the
config named a host not yet listed; the `VIMEO_HARVEST_STUB` deps deliberately
return none) ⇒
`frames: no_manifest`; extraction throwing ⇒ `frames: failed`; both land on the
trace as `frames` + `frameCount` so the outcome is readable afterwards. The
frame list rides the USER prompt after the transcript (`framesPromptSection`,
the TikTok `t=HH:MM:SS <path>` shape) plus the one rule TikTok does not need:
**a slide is quoted as an image IN PLACE**, by exactly
`![Slide at HH:MM:SS](/api/frames/vimeo/<videoId>/<sec>.jpg)` where `<sec>` is
the frame's file name, only where it adds something the transcript did not
say, at most `MAX_INLINE_SLIDES` (8). The SYSTEM prompt says nothing about
frames, so a frames-off capture's prompt is byte-identical to PR 1's.
`extraDirs: [workDir]` only when there are frames; the summarize timeout is
`summarizeTimeoutFor(frames.length, 600 s)`.

**Only the frames the summary QUOTES survive the job.** `keepReferencedFrames`
parses the summary for this video's `/api/frames/vimeo/<id>/<sec>.jpg` paths —
**and the pre-seam `/api/vimeo/frames/<id>/<sec>.jpg` spelling too**, because
huginn stores the summary markdown verbatim and a re-run over an older document
would otherwise keep nothing — and copies those out of the work dir to
`~/.muninn/frames/vimeo/<videoId>/<sec>.jpg`
(`framesRootDir()`, beside `agent-cwd`) — a quoted path that was never
extracted, or a non-canonical spelling (`047.jpg`, which the route never
serves), is logged and skipped, so the reader gets a broken image rather than
a served file from nowhere — and the work dir (segments + unquoted frames) is
removed in the job's `finally`. The summary text is ingested with the image
markdown intact; the doc panel renders it through `marked`'s default `<img>`,
same-origin. **The document's frames are therefore only live inside muninn's
UI**, which the plan accepted (huginn serves no static files). **A `/summaries`
Delete removes the document's kept frames** (`removeKeptFramesForDocument`,
called from INSIDE this vertical's ONE `onSummaryDocumentDeleted` listener and
deliberately not as a second listener of its own — the dedup half DELETES the
ingest entry, so a listener running after it in Set order would lose the fast
path and send every delete down the listing fallback, orphaning the frames of a
document huginn had already reindexed away): the signal carries a
DOCUMENT id, so the video id comes from the ingest map when the capture was
recent and otherwise from the listing row huginn still serves (its DELETE is
soft — the same reindex window `recentDeletes` exists for); async and
best-effort, a listing that is down leaves the frames in place with a warn —
and the listing is asked only when `<root>/vimeo/` has ANY entry, since frames
are off by default and most deletes have nothing to remove (a 200-row
collection read for a video that kept no frames is the wide read this module
avoids elsewhere) — scoped to the SOURCE's own directory, or a YouTube capture's
kept frames would re-open that read on every Vimeo delete. The id is
charset-gated before anything is removed, so the path is always
`<root>/vimeo/<digits>`. **Accepted consequence:** a source-drafted
wiki page that quoted the capture's slides (`![Slide at …](/api/frames/vimeo/…)`)
outlives the vimeo document, and its images break when the document is
deleted — the frames were only ever served by muninn's UI for the capture,
and a Delete is the reader saying the capture should go. ⚠️ Every `registerVimeoRoutes` in a TEST passes a temp
`framesRoot`: the listener set is module-level and never unsubscribed, so a
registration with no root would remove frames under the developer's real
`~/.muninn/frames` on the next test that fires the signal. The two
acceptance talks' quoted frames measured 725 KB for 8 (81–102 KB each) and
425 KB for 6 (54–87 KB each), byte sums, at 720p.

**`GET /api/frames/:source/:id/:file` is read-only and default-deny by
charset.** Every segment is gated — the SOURCE against the known frame sources,
the id against THAT source's own `idRe` (vimeo digits, youtube 11 URL-safe
base64 characters), the file as `<digits>.jpg` — BEFORE any filesystem access,
and the same gates are an invariant of the SEAM rather than of this route
(`keepReferencedFrames`, `frameUrlPath`, `framesPromptSection` and
`referencedFrameSeconds` all refuse a bad id, and the id is regex-escaped on
top). The resolved path
is checked to stay under **`<root>/<source>/`** on its REAL path (`realpath` on
both sides — the charset gates make the spelling safe by enumeration, and only
the real path sees a symlink planted under the root; pinned with two. The base
is the SOURCE's directory and not the root because the root holds every
vertical, so a link that stays inside it still crosses a boundary: measured,
`<root>/vimeo/77 → <root>/youtube/<id>` served the YouTube frame at a Vimeo
address, on the alias too — which carries no source segment for a reader to
notice it by. Stated residual: a HARDLINK planted under the root is invisible to
`realpath` and still serves. The root has exactly TWO writers and neither makes
one: the one-time `migrateLegacyVimeoFramesRoot`, which renames a pre-existing
tree in once at startup — and refuses a SYMLINKED legacy root, which would
otherwise put a link at the served path — and `keepReferencedFrames` from then
on, which writes plain files it copied itself), everything else is a 404 (never a 400
that confirms the shape), `Cache-Control: private, max-age=86400` (a frame is
(video, second) — re-extracting the same second is the same picture; PRIVATE
because the route is in the admin zone under `MUNINN_AUTH` and a shared cache
must not serve past a 403). It is
registered by `registerFramesRoutes` (`src/dashboard/routes/frames-routes.ts`)
INSIDE the `summaries` route group — vimeo, youtube and summaries are dropped
together on `MUNINN_PROFILE=nais`, so a group of its own would buy nothing but a
`ROUTE_GROUPS` edit and a restructuring of `routes-profile.test.ts`, whose probe
table is literal paths a parameterised route cannot satisfy. The same factory
serves the pre-seam alias **`GET /api/vimeo/frames/:videoId/:file`** over the
same root and the same bytes, for the documents that quote it. A test seam
(`FramesRouteOptions.framesRoot`) points both at a temp root, and a test MUST
pass one.

**`~/.muninn/vimeo-frames` becomes `~/.muninn/frames/vimeo` by a ONE-TIME
rename in `src/index.ts`** (`migrateLegacyVimeoFramesRoot`) — never at module
load and never at route registration, so it runs once per process BOOT rather
than once per test file or per registered app. Being in `src/index.ts` does not
keep it away from the developer's real `$HOME`: a unit test never loads that
module at all, but every e2e-spawned server runs it, and the acceptance run for
this feature really did move the real root. What makes that safe is that the
move is idempotent and a no-op once done, not that it is unreachable. It is a
no-op unless the old root exists and its new place does not; the `nais` answer
is given BEFORE either probe, so nothing under `$HOME` is touched at all there,
not even a stat; a legacy root that is a SYMLINK is refused with a warn naming
it (`rename(2)` moves the link, which would leave a symlink at the served path
pointing outside the root — the route's realpath containment then 404s every
kept frame while the log says "Moved"), as is the case where BOTH roots exist
(merging two roots is a decision this has no basis for); and it is
log-and-continue on any error, since kept frames are a cache of pictures and no
capture may be blocked by a failed move. Stated: rolling back to pre-seam code
strands the frames under the new name. Stated and accepted: a failed move
followed by a new capture leaves BOTH roots present, and every later boot then
takes the refuse branch and warns again — the plan chose refuse-over-merge, and
the warn names both roots and says to move or remove the old one by hand.

**Measured on the two acceptance talks (2026-09-05, the plan's skip trigger):**
Kotlin extension functions (10 min, `en-x-autogen` — Vimeo mis-tagged a
Norwegian talk, so `talk` gave English at the time; the transcript-first
language rule above is the fix) — 30 frames read, 8 quoted, 8/8 carry code or a stack trace
the captions cannot; ES2026 news (10 min, `no-x-autogen`, Norwegian summary) —
30 read, 6 quoted, 5/6 add something; the sixth is a live-coding demo caught
mid-typing, and one slide landed under the neighbouring section. 13 of 14 is
well over the trigger's half, so cadence stands; the two failure shapes seen
(mid-typing state, off-by-one section) are what scene detection would address.

**Residual, declared:** `linkVimeoTimestamps` (PR 2) rewrites `[MM:SS]` in the
markdown, so a model that ignores the "nothing else in the alt text" rule and
writes `![[23:10]](…)` gets its image broken into a link. The prompt states the
exact alt text; on the two acceptance captures, none did.

## The Whisper fallback (v2 PR 5)

**A talk with no caption track is transcribed from its own audio, and the
transcript then takes the caption track's path unchanged.** `summarizer.ts`'s
no-track branch forks on the manifest: no `manifestUrl` ⇒ `no_captions` as
before (nothing to transcribe from); a manifest ⇒ `whisper.ts`
`transcribeOpusRendition` — `chooseRepresentation({kind: "audio", codec:
"opus"})` (101 kbps against AAC's 194 for the same speech), EVERY segment of it
through PR 3's `downloadRendition` as one contiguous fMP4, `ffmpeg` to 16 kHz
mono WAV, then `whisper-cli --model <path> -l auto -ovtt -of <base>`, whose
`<base>.vtt` is read back and handed to `vttToSegments` exactly as a downloaded
caption VTT is. So the `### [HH:MM:SS]` windows, the prompt, `transcript_markdown`
and the retrieval chunks are byte-for-byte the caption shape. Whisper's stdout is
not parsed: the file carries whisper's own cue timing, and the one thing read off
stderr is `auto-detected language: no (p = …)`, printed nowhere else.

**Measured 2026-09-05 on the mini (M4, `ggml-small.bin`):** two minutes of a
Norwegian lightning talk — 20 Opus segments, 1.5 MB — downloaded in 0.6 s,
decoded in 0.2 s, transcribed in 7 s (17× real time), language `no` at p = 0.88,
proper nouns garbled the way auto-captions garble them ("Jepro" for a company
name) — which is why the prompt's auto-caption rider applies to a whisper
transcript too. The clocks are TikTok's, verbatim: `whisperTimeoutFor` = 1 s per
second of talk, floor 2 min (room for `medium` on a slower machine);
`audioDecodeTimeoutFor` = 0.2 s per second, floor 1 min; the download budget is
`renditionTimeoutFor(segments)`. A 3 h talk's Opus is ~137 MB, under
`VIMEO_RENDITION_MAX_BYTES`.

**The harvest waits for the manifest when the player lists NO track — on every
capture — and only then.** `awaitManifestNoCaptionsMs` (`VIMEO_MANIFEST_WAIT_MS`,
10 s) is passed by the summarizer unconditionally, because nothing knows before
the harvest whether captions exist; it is INERT on a captioned video, so a
frames-off capture still closes the browser the moment it has its VTT, and the
Slides tick keeps its own `awaitManifestMs`. The larger of the two applies to a
track-less video. Pinned in `captions.test.ts` both ways.

**Three stable job codes, each a sentence on the card, and the pre-flight comes
BEFORE the download.** `whisper_unavailable` — `whisperUnavailableReason` found
no `ffmpeg`, no `whisper-cli` or no model file (the reason, with its remedy —
`brew install whisper-cpp`, `VIMEO_WHISPER_MODEL_PATH` — is on the warn line;
40 MB of audio for a machine that cannot transcribe it is the wrong order);
`transcription_failed` — download, decode or whisper failed on THIS video (the
ffmpeg/whisper stderr tail in the log, never on the card); `no_speech` — whisper
ran and its VTT has no cues, which is a different fact from a caption file with
no cues (that one stays `no_captions`). A raw throw from the pipeline is never
the job's error text.

**The document says how the transcript came to be.** `caption_kind: "whisper"`
beside `manual` / `auto` / `stub`; `caption_lang` is whisper's DETECTED language
(`no`, `en`, …), `en` on an English-only model (its detection never ran — see
below) and `und` when a multilingual model printed no line; `talk` resolves from
it exactly as from a caption tag, so a Norwegian talk with no captions still
gets a bokmål summary. An explicit `nb`/`en` pick beats the detection, as it
beats a tag. huginn stores the kind verbatim (its `vimeo.py` comment names two
values; no allowlist change was needed).

**The model must be multilingual, and the shared default is not.**
`VIMEO_WHISPER_MODEL_PATH` → `TIKTOK_WHISPER_MODEL_PATH` → `WHISPER_MODEL_PATH`
(default `./models/ggml-base.en.bin`, the Telegram voice model). An `.en` model
(`isEnglishOnlyModel`, the `.en` before the extension) makes whisper ignore
`-l auto` and transcribe Norwegian as English noise, so the run WARNS naming the
variable and records `en`, rather than refusing — the operator's intent was to
capture. On the mini: `~/.muninn/whisper/ggml-small.bin` (466 MB, fetched
interactively — the launchd rule for models applies), `brew install whisper-cpp`
(1.9.2).

**Whisper + frames share one manifest fetch and one work dir; the audio does
not outlive whisper.** `getManifest` in the job memoizes the fetch; the fMP4
and the WAV are unlinked the moment `whisper-cli` exits (a 3 h talk is ~137 MB
of Opus plus ~345 MB of WAV, and with Slides on the work dir is what the model
is handed as `--add-dir`), and the segments go with the dir in the `finally`.
Statuses on that path: `harvesting_captions → downloading → transcribing →
extracting_frames → summarizing → ingesting`.

**The review of #524 (seven findings) and its two fix rounds left these
rules.** (1) *The rendition file is written by one synchronous `appendFileSync`
per segment — no descriptor held across an await — and its size is verified
against the byte count* (`media.ts`, `sizeOnDisk` test seam). Two measured
failures in a process that had launched and closed a Playwright Chromium (the
production shape — the harvest runs first): the `Bun.file().writer()` sink
flushed in the background and reported a failed flush as a loose error nothing
awaited, so the count said 6 418 143 bytes while 2.6–3.1 MB were on disk (3/3,
ffmpeg read the cut as a complete file); and round 1's descriptor opened once
and held across the segment awaits was closed out from under the download —
`EBADF` at segment 53 of 123 (2/2) — by the browser's delayed cleanup closing
an fd number it no longer owned. A descriptor that exists only inside one
synchronous call cannot interleave with that cleanup: 2/2 exact after the
change, same shape. A size mismatch is a `VimeoMediaDownloadError` and the
file is unlinked. (2) *`no_speech` is a FLOOR, not "no cues"*
(`looksSpeechless`, `SPEECH_MIN_WORDS_PER_MINUTE` = 5): whisper hallucinates a
word on silence (20 s of digital silence ⇒ exit 0, `en (p = 0.35)`, one cue
"you"), so zero cues never happens; below 5 words per minute of talk the job
is `no_speech` and no model call is spent (the committed 53-min fixture runs
at 104 wpm). (3) *The Opus claim is a preference*: `chooseRepresentation`
falls back to the cheapest audio when a manifest has no Opus, so an AAC-only
manifest is transcribed from AAC with a warn naming the codec; the sizing
claims above are Opus claims — AAC at 194 kbps × 3 h is ~262 MB, still inside
the 256 MiB (268 MB) cap by ~6 MB, and anything above ~199 kbps × 3 h is
refused by the declared-total pre-flight as `transcription_failed`. (4) *The
pre-flight runs BEFORE the harvest, and `no_captions` is answered BEFORE
`whisper_unavailable`*: a track-less video with no manifest is `no_captions`
on every machine (nothing to transcribe from — the operator remedy would be
irrelevant), and only a video with a MANIFEST to try reports the machine's
missing piece (whether that manifest has an audio rendition is known only
after the fetch the branch skips — a video-only manifest answers
`whisper_unavailable` there and `transcription_failed` on a capable machine);
so the harvest keeps its 10 s manifest wait on a whisper-less
machine too, because without it the first answer would shadow the second.
(5) *On the success path nothing of the audio or frames pass outlives its
step in the work dir*: the fMP4, the WAV and whisper's `.vtt` are unlinked as
soon as they are consumed, and `extractCadenceFrames` removes its segment
files after the last grab — the work dir is what the model is handed as
`--add-dir`, and holds only the JPEGs. A step that FAILS (ffmpeg non-zero, a
whisper killed mid-write, a frame grab throwing) leaves its files for the
job's `rm` of the work dir, and no failed pass reaches `--add-dir`. (6) The docs' operator remedy is spelled without `~` (no
expansion). (7) The "larger of two allowances" test covers both orders.
Stated residual: a track-less harvest spends the 25 s track wait AND up to
10 s of manifest wait inside the 60 s budget, so a watch page that takes
≥25 s to load leaves no room for the manifest and the capture degrades to
`no_captions` rather than being transcribed.

## Rules the VERTICAL lives by (PR 2)

**There is no `fetching_metadata` status.** oEmbed runs in the ROUTE, before a job
exists, because it is what decides whether there is anything to capture at all —
not public ⇒ 422 `not_public`, no duration ⇒ 422 `duration_unknown`, over the 3 h
cap ⇒ 413, already captured ⇒ a `duplicate` body with no `job_id`, already
capturing ⇒ an `in_flight` body carrying the running job's id. A job created
above one of those early returns is never settled and sits for the whole
in-flight grace at the top of `/summaries` with a "running" `/agents` card (the
ordering `capture-route-job-ordering.test.ts` pins for TikTok, YouTube and
Vimeo — three of the six verticals). The metadata is then handed to
`summarizeVimeo`, which never asks oEmbed again.

**oEmbed's duration is the length bound everything downstream is sized from, so
"it did not say" refuses.** `toDurationSec` degrades a missing, non-numeric or
negative `duration` to 0, and 0 passes `> VIMEO_MAX_DURATION_SEC`
unconditionally — and since PR 4 the frame budget (`cadenceTimes`) and the
summarize timeout are computed from the same number, so a 0 would have started
a capture with no cap and no frames. It answers 422 `duration_unknown`, below
the not-public branch (which carries no duration at all).

**State 4 — the dedup key is the VIDEO ID, resolved out of each listed row's url**
(`resolveVimeoRef(d.url)?.id`, the same rule as the youtube sibling). "Every
writer posts `canonicalVimeoUrl(id)`" is true of this route and false of the
collection: the live one already holds rows this route never wrote, including a
bare `https://vimeo.com/`, and a row spelled `vimeo.com/<id>/<hash>` or
`player.vimeo.com/video/<id>` is the same video. A row whose url resolves to no
id matches nothing.

**A video id is in one of FOUR states, and dedup needs a guard for each.** This
is the enumeration, not a list of patches — each row names the guard that owns
it, and a state with no owner is a video captured twice:

| # | State | Guard | Answer |
|---|---|---|---|
| 1 | absent everywhere | — | capture it |
| 2 | claimed in-flight in this process | `inFlight` | `in_flight` + the running job's id |
| 3 | **ingested here, not yet listed by huginn** | `recentIngests` | `duplicate` |
| 4 | listed by huginn | `findExistingByVideoId` | `duplicate` |

**State 2 — the stored-document check is only half of dedup.** Nothing is stored
until a capture finishes, and the huginn listing is an await, so two POSTs of one
url either side of it both found nothing and both captured — and huginn suffixes
`(2)` rather than overwriting, so the corpus kept a shadow copy of the same talk.
`inFlight` is a per-registration claim keyed on the video id, taken
SYNCHRONOUSLY before that lookup and given back when the job settles
(`summarizeVimeo` resolves exactly when `completeJob`/`failJob` has run) or, on
any early return under it, in the handler's `finally` — one 500 must not lock a
video out for the life of the process. A POST arriving before the claim carries a
job id waits for that decision rather than being answered with an id that does
not exist yet.

**State 3 — the REINDEX WINDOW, which was owned by nothing.** The two guards
either side of it end and begin at different instants:
`GET /api/collection/vimeo-summaries/documents` is derived from huginn's
`index_document_mapping.json`, which moves only when the background reindex
enqueued AFTER an ingest has run — seconds to minutes later — while the in-flight
claim is released the moment the capture settles. Measured on a live instance: a
completed capture re-POSTed immediately answered with a FRESH job id and ran a
second full capture, and the corpus HID it, because huginn's writer overwrote the
same category/title/url and only one document remained. So the route keeps a
`recentIngests` map (`videoId → {documentId, existingUrl, at}`), written from the
`onIngested` hook `summarizeVimeo` calls on a successful ingest — the only moment
in the process that knows a document exists — and read BEFORE the huginn listing,
answering a `duplicate` body byte-identical to the listing's (one
`duplicateBody` builder, so the two cannot drift). It is bounded on BOTH axes,
because it is a cache with no invalidation: `VIMEO_RECENT_INGEST_TTL_MS` (30 min,
generous slack over a reindex measured at seconds to a minute or two on this corpus) and `VIMEO_RECENT_INGEST_MAX`
(200 entries, oldest-inserted evicted first). Past either bound the listing is
authoritative again and the worst case is the pre-existing one, a re-capture.
Three details are load-bearing: the hook fires only when huginn returned a
`file_path` (a refused ingest must not make the route claim a document that
exists nowhere), it fires BEFORE `completeJob` (a re-POST racing the terminal job
event must find the entry already written), and it is wrapped in its own
try/catch for the same reason the source-draft trigger is (the job store has no
guard against a second terminal transition, so a throwing hook would turn a
finished capture's card into an error). The hook is a separate parameter and
deliberately NOT a field on `VimeoSummarizerDeps`: passing any `deps` means "this
caller brings its own harvest", which skips the `VIMEO_HARVEST_STUB` resolution
entirely.

**ONE Chromium at a time, process-wide.** `harvestVimeoCaptions` launches a
browser per harvest, so every harvest goes through a module-level
`createQueue()` key in `summarizer.ts`. A QUEUE, not a try-lock: two pastes are
two legitimate jobs and neither may be dropped — the second waits, then runs, and
its own 60 s budget starts when it does.

**The auto-caption rider is appended exactly when `detectCaptionKind` says
`auto`.** Vimeo's machine captions garble proper nouns ("JavaBeen" for JavaBin,
measured), and the failure that matters is a summary confidently naming a
library that was never said. The rider tells the model to DESCRIBE rather than
assert such a name, not to omit it.

**The transcript is ingested, not just summarized.** `transcript_markdown` is
written into the huginn document under a `## Transcript` heading after the
summary, so a search hit in a 50-minute talk can be cited to the minute — but it
is deliberately absent from huginn's ingest RESPONSE and from its similarity
query (`write_summary`'s `body_suffix`). Measured on the first real capture: a
`?q=tiny LLM library` search hits inside that section.

**Each window opens a `### [HH:MM:SS]` HEADING, not a bare bracketed line.**
huginn's `MarkdownHeadingSplitter` cuts that `## Transcript` section on headings
and then at ~1000 chars, and carries the nearest heading into every chunk's
`heading` field. With bare lines only the chunks that happened to START at a
window boundary carried a timestamp — measured, 48 of 75 — so most hits inside a
talk could not be cited to a minute, which is the whole reason the transcript is
ingested.

**`no_captions` is a job ERROR with a stable code, not a crash.** Since v2 PR 5
it means "no usable track AND no manifest to transcribe from" — a video with a
manifest takes the Whisper path instead (its own three codes, above).

**Everything that can fail is INSIDE the job's try; the source-draft trigger is
inside one of its own.** The dep resolution moved in because
`resolveServingProfile` throws on an unrecognised `MUNINN_PROFILE` and the
fixture stat can throw on a permission error — outside, that escaped into the
route's fire-and-forget `.catch` and left the job `pending` forever. The trigger
moved out because it runs AFTER `completeJob`, its first statements are
synchronous (`isWikiReadonly`, `isReadonlyWikiRoot`), and the job store has no
guard against a second terminal transition — so a throw there turned a finished
capture's card from complete into error.

**The status moves inside the queued closure.** `harvesting_captions` announced
before `harvestQueue.run` meant a job waiting its turn reported a Chromium that
was not running, for as long as every harvest ahead of it took.

**The document's `date` is the CAPTURE day, never oEmbed's `upload_date`.**
The `/summaries` shelf buckets and sorts on `date`, and youtube/tiktok/article
stamp today; stamping the upload date filed a talk captured today under the week
it was uploaded, below the fold (#519). `uploadDate` stays on the job meta with
no consumer: it has no frontmatter field yet, because huginn's converter metadata
allowlist is global (the `anthropic` vertical, which prefers the SOURCE's own
publish date, is the precedent for adding one). A title-less oEmbed
answer falls back to the canonical url, because huginn derives the document
FILENAME from the title and `""` would collide with every other title-less
capture.

**No CORS, deliberately.** `registerSummaryVertical` is called with
`corsPreflight: false` and the POST calls no `applyCors`: there is no Chrome
extension for this vertical (PR 3's entry point is same-origin), and a
cross-origin summarize entry is a way for any page to spend the operator's model
budget.

**`MUNINN_PROFILE=nais` drops the group**, for the reason the other capture
verticals are dropped with a different binary: the capture launches a headless
Chromium, and `bunx playwright install chromium` is an operator step on a laptop,
never a build step in the image.

## The UI entry (PR 3)

`/summaries` carries an always-visible one-line **URL field** above the collapsed
"+ Paste article" form (`src/dashboard/views/components/sum-submit-form.ts` —
`captureUrlFormHtml`, `submitCaptureUrl`, `submitCaptureUrlFromInput`). It POSTs
`{url}` to `POST /api/vimeo/summarize` and then reuses the page's ordinary job
card and SSE client verbatim (`showJob` + `connectSSE`), so a Vimeo capture
streams exactly like a YouTube one. This is the whole entry point: **Vimeo is the
one capture vertical with no Chrome extension**, because what it needs is a
headless browser muninn drives itself, not one the reader is sitting in.

**`detectCaptureProvider` is a HINT and lives in the form script.** It answers
`'vimeo'` for any `vimeo.com` / `www.vimeo.com` / `player.vimeo.com` http(s)
address, whatever the path, and its ONE job is deciding whether a bare link
pasted into the ARTICLE textarea is forwardable — pasting into the wrong box
works, and every other bare link keeps the byte-identical Chrome-extension alert
(pinned in `sum-submit-form.test.ts`, which drives the real script). The URL
field itself does **not** consult it and posts whatever was typed: the server's
`resolveVimeoRef` is the single authority on what is a video, and answers 400 for
everything else. A second host test in the client would be a second authority,
which is how `vimeo.com/channels/staffpicks` ends up refused in two different
sentences.

**Every route answer that is not a fresh job renders as a SENTENCE on the card,
from ONE map.** `VIMEO_SENTENCES` + `vimeoSentence` live in
`views/components/sum-job-card.ts` — beside the card that renders them, not in
the form — because the same map serves two callers: the form's rendering of a
route refusal, and `showError`, which turns the `no_captions` CODE a failed job
stores into "This video has no caption track" rather than showing the reader the
word `no_captions`. That translation is scoped to `currentSource === 'vimeo'`, so
another vertical's error text can never be swallowed by a code that happens to
spell the same word.

| Answer | Sentence |
|---|---|
| 400 (unparseable — the route sends no code, so the STATUS names it) | Not a Vimeo video URL |
| 422 `not_public` | Vimeo says this video is not public |
| 422 `duration_unknown` | Vimeo did not report a duration, so the 3h cap cannot be checked |
| 413 `too_long` | Longer than the 3h cap (Xh Ym) — derived from the reported `durationSec` |
| 502 `oembed_failed` | Vimeo did not answer |
| 200 `duplicate` | Already captured — plus a link to `dashboard_url` |
| 200 `in_flight` | Already being captured — plus an attach to the running job |
| 400 `bad_frames` | The Slides flag must be on or off |
| 503 `frames_unsupported` | The summarizer bot cannot read slide frames — untick Slides, or set SUMMARIZER_BOT to a claude-cli / claude-sdk bot |
| job error `no_captions` | This video has no caption track |
| job error `whisper_unavailable` | This video has no caption track, and this machine cannot transcribe it (whisper-cli and a multilingual model are needed — see VIMEO_WHISPER_MODEL_PATH) |
| job error `transcription_failed` | This video has no caption track, and transcribing its audio failed |
| job error `no_speech` | This video has no caption track, and no speech was found in its audio |

Two rendering rules: the input **clears** on an answer that started or adopted a
capture (and on a duplicate, which is likewise nothing to retry) and **keeps its
text** on a refusal, where the reader has something to fix; and the card's banner
grew a second `notice` TONE for the two non-error outcomes rather than a second
element. That tone needed the banner's `border-top` moved out of an inline
`style=` attribute and into the stylesheet — an inline declaration wins over every
stylesheet rule, so the red border survived the tone swap.

`duplicate` is also a badge status (`STATUS_LABELS` + `TERMINAL_STATES` +
`.status-duplicate`) that the SERVER never sends. It exists so the strip can say
"Already captured" without borrowing `complete`, which promises a summary this
card is not going to show.

**The two cap sentences name the SERVER's number, never a literal.** The page
injects `VIMEO_MAX_DURATION_SEC` from `src/vimeo/limits.ts` and the card derives
its label from that (falling back to the `maxSec` the 413 body reports, which is
the same constant); raising the cap used to change the refusal and leave the
sentence claiming the old number. The measurement in `too_long` rounds to the
nearest minute of the WHOLE duration and reads the hours off THAT — rounding the
remainder instead rendered 14 390 s as **"3h 60m"**, because 3 590 s rounds to 60
minutes and 60 is not a minute count. It reads "4h 0m". **The cap's own minutes
are rounded too, and both halves share ONE format** (`3h`, `3h 1m`, `15m` — no
space between number and unit, since the two land in one sentence): flooring the
cap survived the whole suite while every tested cap was a whole number of
minutes, and would name a 10 830 s cap as a flat "3h", 30 s short of the number
the route enforces. The cap omits a zero remainder and the measurement keeps it —
a cap is a named round number, a measurement is a measurement.

**An answer that is not a fresh job never repaints a card with a LIVE stream.**
`showCaptureOutcome` renders the banner (with its tone) and returns; only when
nothing is streaming does it also retitle the card, move the badge and replace
the summary area. Measured before the guard: paste a second link mid-capture,
take the refusal, and twelve seconds later the FIRST job's summary streamed into
a card titled with the url that had failed, under an Error badge, starting
mid-word — `showJob` zeroes `accumulatedText`, so only the tail arrived. The form
half is the same rule: on `in_flight` for a job already streaming it does NOT
call `connectSSE` again. That reconnect closed the working EventSource and opened
a second one which got the state replay and then nothing at all — see the
subscribe rule in `src/summaries/job-store.ts`, whose stale unsubscribe was
evicting it.

**The banner is cleared when a submit starts and when a job completes.** It is
one element carrying answers about DIFFERENT pastes, so a stale refusal used to
stay on screen for the whole next request, and a capture finished with "Already
being captured" still under it. `showJob` clears both classes (`visible` and
`notice`), not just the first.

**The route sends `title` with both job-carrying answers.** A fresh job gets the
oEmbed title (or the canonical url, never `""`); an `in_flight` answer gets the
RUNNING job's title, which is the one the card is already showing. Without it the
card wore the pasted address for the whole capture and a reload replaced it.

**The card's title only becomes an anchor for an `http(s)` url.** `esc` escapes
the attribute and says nothing about the scheme, and one caller passes the
reader's own paste — so `javascript:…` was a live href on an operator page.

End-to-end acceptance is `e2e/summaries-vimeo.spec.ts`: the harvest is the
`VIMEO_HARVEST_STUB` fixture, oEmbed is a local fake over `VIMEO_OEMBED_BASE`,
and the summarize step runs against a throwaway `openai-compat` bot the spec
creates and points at the same fake — so the whole walk to `complete` costs no
model call and no Chromium. That bot lives in an OS **temp** directory the
spawned server is pointed at with `MUNINN_BOTS_DIR`; nothing is written under the
repo's `bots/`, which is state the developer's own `bun run dev` reads and where
discovery order is raw `readdirSync`, not alphabetical.

## Why a headless browser

Four cheaper paths, all measured closed **2026-09-04**. Do not re-try them; if one
of them starts working again that is a finding worth its own measurement, not an
assumption to build on.

| Path | Result |
|---|---|
| `yt-dlp 2026.08.19 --list-subs` | *"The web client only works when logged-in"* — even for a public video |
| `curl player.vimeo.com/video/<id>/config` | 403 "Sorry" page, bot-gated on fingerprint. UA/Referer spoofing makes it **worse** |
| in-page `fetch()` of the same config endpoint from the loaded watch page | 403 — the real player reaches it through a signed iframe context we cannot reproduce |
| the `player.vimeo.com/video/<id>` embed page in headless Chromium | *"We couldn't verify the security of your connection"* — no cheaper than the watch page (measured while diagnosing the UA gate) |
| `curl vimeo.com/api/oembed.json?url=…` | **200.** `title`, `author_name`, `duration`, `upload_date`, `thumbnail_url`. Metadata needs no browser at all; private/deleted answers non-200 |

What works is to let the REAL player do the work and harvest what it fetches:
load `https://vimeo.com/<id>` in a headless Chromium, `play()` it muted, set every
`video.textTracks[i].mode = "hidden"`, and read the signed
`https://captions.vimeo.com/captions/<captionId>.vtt?expires=…&sig=…` URL off the
request stream. It then downloads with a plain cookie-less `fetch`.

**This is the one mechanism here that can rot** — a player change, a rate limit,
an account wall. It has no contract behind it. The Whisper path (v2 PR 5) is
half a rollback: it still needs the harvest for the MANIFEST url, so a caption
outage is survivable and a watch-page outage is not; the other half is dropping
the vertical. The metadata half survives either way,
because oEmbed is a different mechanism entirely. `scripts/smoke-vimeo.ts` is what
tells you which state you are in — run it before assuming a code bug.

## Operator step, both machines

```
bunx playwright install chromium
```

`playwright-core` is a dependency (pinned `1.58.2`), but it ships **no browser
binaries**. Without that command a harvest throws `VimeoBrowserMissingError`,
whose message is that line. The laptop and the mini each need it.

For the Whisper fallback (v2 PR 5), additionally:

```
brew install whisper-cpp
mkdir -p ~/.muninn/whisper
curl -L -o ~/.muninn/whisper/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
VIMEO_WHISPER_MODEL_PATH=/Users/<you>/.muninn/whisper/ggml-small.bin   # in .env — spelled OUT, no `~`
```

The value is read through `optionalEnv` with **no `~` expansion** (unlike the
`WIKI_EXTRA` dialect), so a tilde in `.env` is a path that does not exist and
every no-captions capture answers `whisper_unavailable` pointing back at the
variable. Without the three steps a no-captions capture fails with
`whisper_unavailable` and a warn naming what is missing; captioned captures are
unaffected; a track-less video on such a machine still waits up to 10 s for
the manifest, so the card can say "nothing to transcribe from" when that is
the fact and "cannot transcribe" only when there is audio.

## Rules this module lives by

**The signed URL expires in ~3.5 h. Persist the VTT, never the URL.** Download
inline, in the same operation as the harvest.

**`playwright-core`, imported ONLY through `await import("playwright-core")`
inside `harvestVimeoCaptions`.** Two halves, both load-bearing:
- `playwright-core` rather than `playwright` — the latter ships browser binaries
  and a postinstall.
- Dynamic rather than top-level, because `src/dashboard/routes.ts` statically
  imports every route module: a top-level import would pull a browser driver into
  `MUNINN_PROFILE=nais` boot. `captions.test.ts` pins that TWO ways, neither of
  them a line-shaped regex — the regex version was vacuous against the two
  regressions that would really happen, a module-scope `await import(...)` and a
  side-effect `import "playwright-core";`, both of which passed it:
  `Bun.Transpiler.scanImports` (a parser, so a multi-line import is seen and the
  dynamic one is a different KIND) and a child process that refuses to load any
  `playwright*` module and then imports this one — the property itself, executed.

**`downloadVtt` is HOST-PINNED to `captions.vimeo.com`**, https only, with
`redirect: "error"`, a 2 MB cap and a 20 s budget. The URL comes out of a page a
third party controls, and a host pin that follows redirects is not a host pin —
the first hop can be anywhere. The cap REFUSES rather than truncating: half a VTT
is a transcript with a silent hole in it, and everything downstream would treat it
as complete. (Contrast `src/summaries/safe-fetch.ts`, which truncates: there the
body is enrichment prose and a prefix is still useful.) The cap has two halves and
they are not the same promise: the STREAMED path refuses at the cap, byte by byte,
while a response with a null body has only its declared `content-length` to go on
— nothing else is knowable before buffering. The 20 s budget is RACED at all three
reads (request, streamed body, bodiless body), not left to the abort signal alone:
the signal bounds a transport that honours it, and a `fetchImpl` stub or a stream
that ignores its abort is bounded by nothing else. Measured on bun 1.3.10: a bare
`await` on such a call is failed by the per-test timeout, but the natural
assertion — `await expect(call).rejects.toThrow()` — is not: it hangs the whole
file, which is why the tests race the call against a 1 s settle instead.

**When the budget is the binding clock, "private" and "slow" are the same
evidence.** Each Playwright wait is handed `min(cap, what is left)`, computed
OUTSIDE its try. The one predicate each catch evaluates is "has the deadline
passed": if so, the harvest reports the BUDGET — with a clause saying what else
the failure could mean (the video may be private; it may have no captions; for
`goto`, the site may be slow or unreachable) — rather than a verdict about a
page it observed for less than its window. If not, the failure is classified on
its own evidence: the `<video>` wait as bot page / not public / uninspectable,
the track wait as "no captions" (a legitimate answer), and `goto` as a harvest
error carrying Playwright's own message. Measured on the live talk the whole
harvest takes ~3–4 s, so with the default 60 s budget no wait is cut short unless
the page itself stalls; the caps (goto 30 s, selector 20 s, tracks 25 s) only sum
past the budget when several of them are actually consumed.

**A URL's hash rules differ by WHERE it sits.** A trailing path segment is a hash
only if it looks hex — that rule exists to tell `/<hash>` from `/likes`, and it
applies on `player.vimeo.com` exactly as on `vimeo.com`. `?h=` gets no SHAPE rule
and keeps its case VERBATIM: the parameter is unambiguous, and a value that does
not look hex is still the credential the page needs — refusing it turned a
reachable unlisted video into a 404 that a caller records as "not public". What it
does get is a CHARSET (`[A-Za-z0-9_-]+`), because the value becomes a path SEGMENT
in a URL a browser LOADS and percent-encoding does not cover it:
`encodeURIComponent` leaves `.` alone, so `?h=..` addressed `vimeo.com/<id>/..` —
the homepage — and `?h=.` silently dropped the credential. Off-charset degrades to
NO hash, the same way `/likes` does. The check is repeated in `vimeoWatchUrl`
rather than trusted from the parser, because a `VimeoVideoRef` also arrives
hand-built (`HarvestOptions.hash`). A video
id never has a leading zero, because `/0123` and `/123` would be two dedup keys
for one video.

**A cue's identifier is decided by POSITION, never by shape.** The optional
identifier is the line BEFORE the timing line. Dropping `/^\d+$/` lines is the
obvious shortcut and it is wrong on real captions: the committed fixture's cue at
2204.238 s (36:44) has the TEXT `21` — a speaker reading a number aloud — and a
shape-based parser silently returns 927 cues while every other assertion still
passes. That is why the fixture is a real 928-cue file and not three hand-written
cues.

**Windows sit on ABSOLUTE boundaries** (0, 120, 240 …), not relative to the first
cue, so two captures of the same talk window identically and a `[HH:MM:SS]`
citation means one thing. Cues are GROUPED by boundary rather than compared with
the previous window: a cue that steps back in time opened a second window with the
same start, so `[00:00:00]` was printed twice and the citation named two places.

**The whole harvest lives in ONE budget** (60 s by default, browser launch
included) and every Playwright wait gets what is left of it — never 0, which
Playwright reads as "wait forever". Chromium is launched per harvest and closed in
`finally`; there is no long-lived browser to supervise.

**Track/URL correlation is by causation, not by order.** The request stream
carries URLs and the DOM carries `lang`/`label`, with nothing linking them, so the
tracks are enabled one at a time and the first URL arriving after track *i* is
enabled is track *i*'s. A track that produces no new request (the player may have
prefetched it) falls back to positional assignment from whatever is unclaimed.

**`chooseTrack`: manual beats auto-generated; the talk's own language beats a
translation.** The talk's language is read off an auto-generated track when there
is one — Vimeo generates those from the audio, so their language IS the spoken
one, a fact no manual track carries. Auto-captions garble proper nouns
("JavaBeen" for JavaBin, measured), which is what `detectCaptionKind` exists to
tell a summarizer prompt.

**The `Headless` token is taken out of the browser's own UA, and that reverses
the plan's "no UA override, ever" rule.** That rule came from a curl measurement
against the `/config` endpoint; this is a page load, and on 2026-09-04 the page
load measured the opposite, four ways:

| Launch | Result |
|---|---|
| headless, default UA (`HeadlessChrome/145.0.7632.6`) | Cloudflare's **"Verify to continue"** interstitial — no `<video>`, no captions. Same under `channel: "chromium"`; the `player.vimeo.com` embed page answers *"We couldn't verify the security of your connection"* |
| **headed**, default UA (`Chrome/145.0.0.0`) | the real page, 1 track, the signed caption URL |
| headless, `HeadlessChrome/` → `Chrome/` | **the real page.** This is what ships |
| headless, same UA + `--disable-blink-features=AutomationControlled` | no different either way — the UA token is the whole discriminator |

`deHeadlessUserAgent` is a DERIVATION, not a fingerprint: the string is read out
of the launched binary at runtime and only the automation token is dropped, so
the version and platform stay honest and a Chromium upgrade needs no edit. If it
stops being enough, `harvestVimeoCaptions({headless: false})` is the measured
fallback, and `scripts/smoke-vimeo.ts --headed` is the same lever from the command
line. It needs a display, so it is a laptop lever, not a server one, and a server
deployment of this vertical is a PR 2/3 question.

**What the pod does and does not escape.** `MUNINN_PROFILE=nais` drops the capture
verticals, so no nais request reaches this code — but `playwright-core` is a
**production dependency** and the image is built with `bun install --production`,
so its **9.6 MB ships in every image**, nais included. What the pod avoids is the
browser BINARY (`bunx playwright install chromium` is an operator step, never a
build step) and the code path; the driver package itself is carried. Dropping that
weight would take an optional dependency or a separate image, and neither is in
this PR.

`probeChallenge` (was `looksLikeBotPage`) answers **three** things, not two —
`bot`, `clean`, or `unknown`: an evaluate that fails is not evidence about the
video, and swallowing it into "clean" reported an unreadable page as a private
one. It matches the three measured interstitials on the `h1`, and the same three
against `document.title` **anchored WHOLE**, because a prefix match read the real
video *"Sorry, Not Sorry on Vimeo"* as a bot page. A challenge raises
`VimeoBotBlockedError` (one retry in a fresh CONTEXT — a new cookie jar and
storage, same browser and same UA, so it can shake off a session cookie and can do
nothing about the UA gate) rather than `VimeoNotPublicError`, which is what an
absent `<video>` would otherwise be read as.

**`VimeoBrowserMissingError` is reserved for the ONE launch failure whose remedy is
`bunx playwright install chromium`** — Playwright's own *"Executable doesn't
exist"*. Every other launch failure, and every exhausted budget, is a
`VimeoHarvestError`: sending an operator to install a browser they already have is
worse than the raw error. The same rule downward — an exhausted budget is never
reported as "not publicly playable", and never as "no captions".

That rule needs the deadline asked TWICE, and hoisting the check above the `try`
buys only half of it. Above the `try` covers a budget already spent when a wait
STARTS; the likelier case is the one the wait itself causes — `waitForSelector`
and `waitForFunction` are each handed what is LEFT of the budget, burn it, and
reject with something indistinguishable from "no `<video>` on this page" and "this
video has no captions". So each of those two catches re-checks the deadline
(`remaining(deadline)`) BEFORE classifying anything. The tracks wait is the worse
of the two: with no tracks to pair, nothing further down calls `remaining()` at
all, so the harvest RESOLVED and reported an empty track list for a video whose
tracks were never waited out.

**oEmbed is the duration source.** `v.duration` was not a number at either read on
both talks measured 2026-09-04 (an MSE source), so `VimeoCaptions.durationSec` is 0
on both and 0 means *"the player never said"*, never "a zero-length video".

## Env

| Variable | Default | What it does |
|---|---|---|
| `VIMEO_OEMBED_BASE` | `https://vimeo.com` | Base URL of the oEmbed endpoint, read at call time. PR 3's e2e points it at a local stub so a spec can fake the metadata half over HTTP without faking a browser. |
| `VIMEO_HARVEST_STUB` | — | An **absolute** path to a `.vtt` that stands in for the whole browser half, so an acceptance run drives the vertical end to end with no Chromium and no live Vimeo. It is a backdoor by construction — the process summarizes a file off local disk while reporting a capture of a public video — so it has THREE gates, all required and all failing to a warn plus a real harvest rather than a throw: `resolveServingProfile() === "default"`, an absolute path, and the file existing. **Every stubbed capture warns**, naming the fixture AND the job id, and the document it writes carries `caption_kind: "stub"` — a once-per-process line is a line nobody sees on the capture they are looking at, and a stubbed document must not be indistinguishable in the corpus from a harvested one. The resolution itself is memoized on the two variables it reads (one profile parse, one stat per configuration; a throw is not memoized), and a caller that passes its own `deps` skips it entirely. |

| `VIMEO_WHISPER_MODEL_PATH` | `TIKTOK_WHISPER_MODEL_PATH`, else `WHISPER_MODEL_PATH` | The ggml model the no-captions fallback transcribes with. Must be MULTILINGUAL for a Norwegian talk; the shared default `ggml-base.en.bin` is English-only, and an `.en` model warns and records `caption_lang: en` rather than refusing. |

All three are in `src/test/ambient-env.ts`, so no suite and no e2e-spawned muninn
inherits a developer's value.

## Testing

The chains name the `src/vimeo/*.test.ts` files **individually**, not the
directory. That is load-bearing: `summarizer.test.ts` uses `mock.module` on
`../ai/one-shot.ts` and `../gardener/source-drafter-run.ts`, which a large share
of the suite imports transitively, so it needs its OWN `bun test` process — and
the `src/vimeo/` directory entry the chains used to carry would have swept it
into the first chunk. `url` / `oembed` / `vtt` / `captions` / `state` stay in that
chunk (`media` too — its download half is driven through `fetchImpl`, no
network — and `whisper`, whose download is `fetchImpl` and whose two spawns are
the `run` seam); `summarizer` has its own `&&` link at the end of both chains. The route's
own cases live in `src/dashboard/routes/capture-route-job-ordering.test.ts`,
which already runs in a process of its own for the same reason.

Every test is offline. The browser half is covered three ways —
structurally (no driver is loaded by importing the module), by the pure
`chooseTrack`, and by driving `harvestVimeoCaptions` through its `launcher` test
seam over a stub DOM: the page-side closures are RUN there, so which track ends up
`hidden` and which ends up `disabled` is really asserted rather than matched in
the source text. What is left to the smoke script is the live mechanism itself:

```
bun scripts/smoke-vimeo.ts https://vimeo.com/1223642971
bun scripts/smoke-vimeo.ts --headed --window 60 https://vimeo.com/1223642971
```

Both `--name value` and `--name=value` work, and an unknown or unparseable flag is
REFUSED (exit 2) rather than ignored: a typo'd `--windows=60` that silently kept
the default made the script report on settings nobody chose, and `--timeout=abc`
put a NaN through every Playwright timeout, which Playwright reads as "wait
forever".
