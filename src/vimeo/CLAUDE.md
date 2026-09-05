# Vimeo — the capture vertical

Given a Vimeo URL, produce a summarized, indexed, citable conference talk. PR 1
was the transcript core; PR 2 added the job, the route and the ingest; PR 3 added
the UI entry — the URL field on `/summaries`.

| File | Role |
|---|---|
| `url.ts` | `resolveVimeoRef` (a bare id OR any URL — the one door callers use), `extractVimeoVideoId` (host-gated), `canonicalVimeoUrl` (the dedup key), `vimeoWatchUrl` (the page to load) |
| `oembed.ts` | `fetchVimeoOembed` — title/author/duration/upload date/thumbnail with **no browser** |
| `vtt.ts` | `parseVttCues`, `vttToSegments`, `segmentsToMarkdown`, `detectCaptionKind` — pure |
| `captions.ts` | `harvestVimeoCaptions` (headless Chromium), `downloadVtt` (host-pinned), `chooseTrack` (pure) |
| `limits.ts` | `VIMEO_MAX_DURATION_SEC` alone, with NO imports — the route, the summarizer AND the server-rendered `/summaries` page read it, and a view importing `summarizer.ts` for one integer would drag playwright-core into the page render |
| `state.ts` | The job store (`createJobStore`), statuses `pending · harvesting_captions · summarizing · ingesting · complete · error` |
| `summarizer.ts` | The job: harvest → download → window → `runCaptureOneShot` → ingest → source-draft. `buildVimeoSystemPrompt` composes the envelope around the KIND's structure bullets, then the auto-caption rider, then the language rider LAST |
| `../summaries/presets.ts` | The capture KINDS (`standard` · `deep` · `talk-notes`), per-bot `prompts/captureSummary.<id>.md` overrides, and the two run levers a kind can pull (`captureThinkingFor`, `captureBotConfigFor`) — pure |
| `../summaries/language.ts` | `talk | nb | en`, `resolveOutputLang` (the `talk` → caption base tag rule) and the ONE spelling of the bokmål/English rider, which `src/share/prompt.ts` re-exports |
| `fixtures/totto-trust-but-verify.vtt` | Real auto-captions from a public JavaZone talk: 63 KB, 928 cues, 53 min |

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

**`talk` is resolved in the SUMMARIZER, not the route.** It needs the chosen
caption track's tag, which exists only after the harvest. `resolveOutputLang`
reads the BASE subtag: `no`/`nb`/`nn` ⇒ bokmål, anything else (an empty tag
included) ⇒ English. Nynorsk speech gets a bokmål summary — the rider knows one
Norwegian. The document carries the RESOLVED language (`summary_lang: nb|en`),
never `talk`, and the kind id (`summary_kind`); huginn allowlists both
(huginn #126, merged first).

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

**Measured 2026-09-05 (the retrieval question the plan left open):** see the PR
body of the muninn PR that shipped this — the Norwegian `?q=` before/after a
Norwegian summary decides whether an English `## Key takeaways` anchor is added.

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

**oEmbed's duration is the only length bound, so "it did not say" refuses.**
`toDurationSec` degrades a missing, non-numeric or negative `duration` to 0, and
0 passes `> VIMEO_MAX_DURATION_SEC` unconditionally — there is no download to
time out and no frame budget behind it, so a 0 would have started an unbounded
capture. It answers 422 `duration_unknown`, below the not-public branch (which
carries no duration at all).

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

**`no_captions` is a job ERROR with a stable code, not a crash.** A video with no
usable track is a legitimate answer about the video; `manifestUrl` is logged
because it is what PR 4's audio fallback would need and it expires.

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
| job error `no_captions` | This video has no caption track |

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
an account wall. It has no contract behind it. The rollback is PR 4's audio path
(the HLS manifest `harvestVimeoCaptions` already captures as `manifestUrl`, then
ffmpeg + Whisper) or dropping the vertical; the metadata half survives either way,
because oEmbed is a different mechanism entirely. `scripts/smoke-vimeo.ts` is what
tells you which state you are in — run it before assuming a code bug.

## Operator step, both machines

```
bunx playwright install chromium
```

`playwright-core` is a dependency (pinned `1.58.2`), but it ships **no browser
binaries**. Without that command a harvest throws `VimeoBrowserMissingError`,
whose message is that line. The laptop and the mini each need it.

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

Both are in `src/test/ambient-env.ts`, so no suite and no e2e-spawned muninn
inherits a developer's value.

## Testing

The chains name the `src/vimeo/*.test.ts` files **individually**, not the
directory. That is load-bearing: `summarizer.test.ts` uses `mock.module` on
`../ai/one-shot.ts` and `../gardener/source-drafter-run.ts`, which a large share
of the suite imports transitively, so it needs its OWN `bun test` process — and
the `src/vimeo/` directory entry the chains used to carry would have swept it
into the first chunk. `url` / `oembed` / `vtt` / `captions` / `state` stay in that
chunk; `summarizer` has its own `&&` link at the end of both chains. The route's
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
