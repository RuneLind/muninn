# Vimeo — the capture vertical

Given a Vimeo URL, produce a summarized, indexed, citable conference talk. PR 1
was the transcript core; PR 2 added the job, the route and the ingest. No UI
entry yet — the route is curl-driven until PR 3 adds the URL field on
`/summaries`.

| File | Role |
|---|---|
| `url.ts` | `resolveVimeoRef` (a bare id OR any URL — the one door callers use), `extractVimeoVideoId` (host-gated), `canonicalVimeoUrl` (the dedup key), `vimeoWatchUrl` (the page to load) |
| `oembed.ts` | `fetchVimeoOembed` — title/author/duration/upload date/thumbnail with **no browser** |
| `vtt.ts` | `parseVttCues`, `vttToSegments`, `segmentsToMarkdown`, `detectCaptionKind` — pure |
| `captions.ts` | `harvestVimeoCaptions` (headless Chromium), `downloadVtt` (host-pinned), `chooseTrack` (pure) |
| `state.ts` | The job store (`createJobStore`), statuses `pending · harvesting_captions · summarizing · ingesting · complete · error` |
| `summarizer.ts` | The job: harvest → download → window → `runCaptureOneShot` → ingest → source-draft |
| `fixtures/totto-trust-but-verify.vtt` | Real auto-captions from a public JavaZone talk: 63 KB, 928 cues, 53 min |

The route is `src/dashboard/routes/vimeo-routes.ts`; the huginn half is the
`vimeo` push source (`main/ingest/vimeo.py`, `POST /api/vimeo/ingest`, collection
`vimeo-summaries`).

## Rules the VERTICAL lives by (PR 2)

**There is no `fetching_metadata` status.** oEmbed runs in the ROUTE, before a job
exists, because it is what decides whether there is anything to capture at all —
not public ⇒ 422, over the 3 h cap ⇒ 413, already captured ⇒ a `duplicate` body
with no `job_id`. A job created above one of those early returns is never settled
and sits for the whole in-flight grace at the top of `/summaries` with a
"running" `/agents` card (the ordering `capture-route-job-ordering.test.ts` pins
for every capture vertical). The metadata is then handed to `summarizeVimeo`,
which never asks oEmbed again.

**The dedup key is `canonicalVimeoUrl(id)`, compared as a whole string.** Every
writer of this collection posts that url, so the stored value IS the key by
construction; re-extracting an id from each listing row would be a second, weaker
copy of the same rule. An unlisted-hash paste therefore still matches.

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

**`no_captions` is a job ERROR with a stable code, not a crash.** A video with no
usable track is a legitimate answer about the video; `manifestUrl` is logged
because it is what PR 4's audio fallback would need and it expires.

**oEmbed's `upload_date` is a datetime; huginn's `date` is a day.** `ingestDate`
takes the day half and omits the field entirely when it cannot — huginn then
stamps today, which sorts, where a malformed date does not. A title-less oEmbed
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
| `VIMEO_HARVEST_STUB` | — | An **absolute** path to a `.vtt` that stands in for the whole browser half, so an acceptance run drives the vertical end to end with no Chromium and no live Vimeo. It is a backdoor by construction — the process summarizes a file off local disk while reporting a capture of a public video — so it has THREE gates, all required and all failing to a warn plus a real harvest rather than a throw: `resolveServingProfile() === "default"`, an absolute path, and the file existing. One warn line per distinct resolution, so a long-running dev server keeps saying which fixture it is serving. |

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
