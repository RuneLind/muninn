# Watchers Module

Background monitors that check external services at intervals and send alerts via Telegram.

## Architecture

```
Scheduler tick (every 60s)
  → getWatchersDueNow() — interval-based from DB
  → isScheduledTimeDue() — time-of-day filter (hour/minute in config)
  → runChecker() — dispatches to type-specific checker
  → dedup (lastNotifiedIds rolling window, max 600)
  → formatAlerts → sendMessage → saveMessage → updateWatcherLastRun
```

## Watcher Types

| Type | File | Data Source | Model |
|---|---|---|---|
| `email` | `email.ts` | Haiku with Gmail MCP tools | Configurable via `config.model` |
| `news` | `news.ts` | Google News RSS (no AI) | — |
| `x` | `x.ts` | Huginn x-feed collection (knowledge API) | Configurable, Sonnet recommended |
| `anthropic` | `anthropic.ts` | GitHub Atom feeds + llms.txt/blog diff | Haiku gate (Highlights) / Sonnet digest (Daily/Weekly) |
| `wiki-gardener` | `wiki-gardener.ts` | Recent summary collections (knowledge API) | Haiku cluster + bot-connector draft |
| `wiki-linter` | `wiki-linter.ts` | The bot's on-disk wiki tree (no AI) | — |
| `wiki-committer` | `wiki-committer.ts` | The bot's wiki git repo (no AI) | — |
| `consolidation-gardener` | `consolidation-gardener.ts` | The wiki's OWN pages via the Atlas semantic overlay (knowledge API) | Bot-connector synthesis draft (`draftAndPersistSynthesis`) |

## Interest-profile personalization (gate/capture prompts)

The `x`, `anthropic`, and `email` gate/capture/digest prompts carry a hardcoded
BASELINE of criteria (topics for x/anthropic; the notify/don't-notify rules for
email). For **x** specifically, `DEFAULT_X_PROMPT` (Daily) and
`DEFAULT_X_HIGHLIGHTS_PROMPT` name the topic baseline explicitly — AI, LLMs and
agents, developer tools, software engineering, open source, cloud/infrastructure,
and tech industry news, plus an off-topic skip clause (sport, celebrity, politics,
memes, engagement-bait — *regardless of engagement*) — which the injected profile
then augments (never narrows). On top of that,
each run loads a per-user **interest profile** — a periodically-refreshed
distillation of the bot user's active goals + recent memories (`interest_profiles`
table; built by `src/profile/generator.ts` on a scheduler step gated by a
"stale > 7 days" predicate). `withInterestProfile()` (`src/profile/inject.ts`)
appends it as a clearly-delimited section that **augments, never narrows** the
baseline — the anti-filter-bubble guard: baseline topics always qualify on their
own; the profile only RAISES relevance for the user's own interests.

- **Loaded once per watcher run** (not per candidate), via
  `loadInterestProfile(watcher.userId, botName)` — keyed on the **watcher's own
  owner** (the identity the run personalizes against), NOT `bot_default_user`
  (which the web-chat dropdown clobbers via `syncDefaultUser`, and which leaks
  one user's interests into another's alerts on a multi-user bot). Best-effort:
  no user / no profile row / any DB error → returns `null`, and the prompt is
  **byte-identical to today**. `loadInterestProfileForBot(botName)` (the
  `bot_default_user` resolver) survives only as the fallback for the user-less
  **manual gardener drain** (no watcher in scope). The scheduler refresh
  (`maybeRefreshInterestProfile`, `src/scheduler/profile-refresh.ts`) mirrors
  this: it refreshes a stale profile for **every distinct owner of an enabled
  watcher** (`getEnabledWatcherOwners`), not just `bot_default_user`; the
  in-flight guard is keyed `bot:user`. A bot with no enabled watchers refreshes
  nobody.
- Wired at: the anthropic `runGate` + `runDigest` criteria, the X `runAlertPath`
  (highlights/digest) + `runCaptureGate` (capture) prompts, and the `email`
  checker (`checkEmail`). Email's criteria sit mid-prompt (the `CRITICAL` +
  "Return ONLY a JSON array" format contract comes AFTER the user criteria), so
  it wraps the **full assembled prompt** — the profile block lands after the
  format contract, keeping `withInterestProfile`'s "output-format instructions
  above still apply" trailer truthful — rather than wrapping the criteria alone
  (which would put that trailer before the format block). Augment-only holds:
  importance triage still fires on objectively-important mail (payment reminders,
  security alerts) for topics the profile never mentions.
- No config knob — personalization is automatic and silent when a profile exists.
  The profile is visible only via the DB this PR (no dashboard UI yet).

## X/Twitter Watcher — Key Lessons

### Architecture

The X watcher reads from huginn's pre-indexed `x-feed` collection via the knowledge API. It does NOT call the X API — huginn's fetcher + indexer runs separately to keep the collection fresh. The watcher just queries the collection, ranks tweets by engagement score, and sends the top-N to an LLM for digest creation.

> **Legacy note:** The codebase still contains a `fetchFromPython()` path that shells out to `x_fetcher.py` directly. This path is no longer used in production — the collection path (`config.collection: "x-feed"`) is the only active path.

### Rank read (`combined_score`, metadata-preferred)

Tweets are ranked by a per-doc `rankScore` before being sent to the LLM: descending
sort in `fetchFromCollection`, then top-N (default 30, configurable via `config.topN`),
so the LLM receives a pre-ranked, filtered set rather than all recent tweets. The score
originates in huginn — a `combined_score` (engagement × relevance; engagement uses X's
open-sourced signal weights: retweets 20x, replies 13.5x, bookmarks 10x, likes 1x,
normalized by sqrt(views), with boosts for long-form notes, quotes, media).

**How `fetchFromCollection` reads it:** it prefers `Number(data.metadata?.combined_score)`
(guarded by `Number.isFinite`) from the document's whitelisted **metadata**, falling back
to the text-regex `extractRankScore(data.text)` only when metadata is absent/non-numeric.
The `Number(...)` coercion is load-bearing — huginn's `read_frontmatter` serves frontmatter
values as **strings** (e.g. `"0.5991"`), which would sort lexicographically if used raw.

> **Stale-claim correction:** the older doc said the score was extracted from the tweet's
> markdown footer `**Engagement Score:** N`. That never actually worked — `extractRankScore`
> only matches snake_case `combined_score:` / `engagement_score:`, never the footer's
> Title-Case label, and huginn strips YAML frontmatter from the served `text` (so the
> frontmatter scores weren't in `text` either). Net: before the metadata read, every
> collection-path tweet had `rankScore = 0` and the sort was a no-op. The metadata read
> (paired with huginn whitelisting `combined_score` into `metadata`) is what makes ranking
> real. Absent metadata ⇒ byte-identical to the old (0-valued) behavior, so the change is
> safe to land before the huginn whitelist PR.

### Score-ordered document cap (`orderDocsForCap`)

`fetchFromCollection` caps the window at `maxDocs` (80) **before** fetching bodies. That
cap used to slice an id-sorted list — and ids are `YYYY-MM-DD_<handle>_<id>.md`, so within
a day it was **alphabetical by handle**. On 2026-07-24 the 1-day window held 389 docs and
the cut landed in the B's; ranking then ran only over those survivors. The Weekly row fed
80 of ~2,100 week docs, chosen alphabetically.

The listing is now requested with huginn's opt-in **`include_scores`**
(`GET /api/collection/<c>/documents?include_scores=1` — attaches `combined_score` plus its
`relevance_score`/`engagement_score` inputs, coerced to floats server-side) and ordered by
`orderDocsForCap` before the slice. `listingScore` re-parses muninn-side regardless of the
server coercion — a lexicographic sort over `"0.9"` vs `"0.1234"` fails **silently**. It is
deliberately stricter than `Number()`, mirroring huginn's own `float()` + `isfinite` guard:
`null`/`undefined`/`""`/`"   "` and booleans are rejected (`Number()` maps them to a finite
`0`, or `1` for `true`, which would sink a scoreless doc or top the whole listing), and
strings must trim to a **decimal** literal — so `"0x10"` and `"Infinity"` are rejected too.

**Per-doc degrade — positional hold, not all-or-nothing.** The alphabetical order is the
baseline; a doc with no finite score is **pinned to the index it holds there**, and the
scored docs are sorted `combined_score` DESC (tie-break `localeCompare`) into the remaining
slots. The rationale is **kept-set identity with the old behavior**: an unscored doc keeps
exactly the cap odds it had before the change — inside the old cap ⇒ still inside, outside
⇒ still outside. No more, no less. (An earlier version of this note claimed alphabetical
order supplied recency that sinking would invert. That was **false** — `localeCompare` on
`YYYY-MM-DD_…` ids is *oldest*-first, so the newest docs already sat at the tail, and the
old `// oldest first for deterministic cap` comment was accurate. Sinking wouldn't have
inverted recency; it would just have moved unscored docs for reasons unrelated to their
quality.) When **no** doc has a finite score (older huginn, which ignores the unknown query
param) every doc is pinned ⇒ the order is byte-identical to the old alphabetical behavior.

**Coverage is logged, not assumed.** The `Collection: …` info line carries
`scored=<n>/<total>` over the in-window candidate set, and `coverageWarning` warns at **zero**
scored docs (enrichment absent — old huginn) *and* at a nonzero minority below 50% (the
enrichment works but huginn's scorer is behind its fetcher). The second case is the live one:
the Weekly window measured 38.6% coverage, where most cap slots are still filled by pinned
docs and the cut is effectively still alphabetical.

Consequence: `compacted` is re-sorted by the same `combined_score` after fetch, so
top-80-then-top-30 ≡ top-30 — `maxDocs` no longer shapes digest content **at full listing-score
coverage**. The qualifier is real: the listing and the per-doc body fetch resolve scores by
different routes (the per-doc path always resolves a score, falling back to the text-regex
`extractRankScore`), so a partially-scored window still lets `maxDocs` decide which docs are
even fetched. Second-order effect worth naming: the capture batch (`captureCandidates`) is now
the score-top-80 rather than an alphabetical sample — an implicit engagement pre-filter
*upstream* of the capture gate. That is a stated, accepted direction, not an accident.

### X-Article amplification signal (`x-amplification.ts`)

huginn writes the `- **Article:** <permalink>` footer on **every** doc whose tweet or quote
target carries an X Article — the article's own (promoted, discovery-dated) doc AND each
amplifier doc that quote-tweeted it — so `TweetDoc.articleUrl` is a group key. Applied at the
**ranking step** in `fetchFromCollection` (after fetch, before the `topN` slice), it does two
things, both scoped to the **digest listing only** (`compacted` itself is untouched, so the
capture batch, `trackingIds` and the `minScore` gate's `topScore` are byte-identical):

1. **Collapse** — exactly one doc per article reaches the digest. The representative is the
   group's **highest-scoring member, whatever its `docType`** — collapse is never an unforced
   content downgrade. (An earlier cut preferred the article doc regardless of rank; measured
   on the real window that made **5 of 7** multi-doc groups keep a LOWER-scoring doc — worst
   case an amplifier note at rank 40 / 0.6122 dropped for the article doc at rank 112 / 0.5502,
   a self-quote no promotion could ever rescue, so collapse deleted an in-band doc and put
   nothing in the band. 5 of the 7 collapsible carriers are substantive `note` docs of the
   amplifier's own, not near-duplicates.) This also dedups **the same article promoted twice**
   (two discovery dates a week apart are two docs, one group). Without collapse a popular
   article takes N+1 near-identical digest slots — amplifier docs now carry the article's title
   + preview in their quote block (the PR-1 reviewer MED; measured as three adjacent
   near-identical scores).
2. **Promote** — an article referenced by ≥ `amplificationMinAuthors` (3) **distinct
   amplifying authors** takes one of at most `amplificationMaxPromotions` (1) **reserved
   digest slots**, entered at the **bottom** of the top-N band. What gets promoted is the
   group's **article doc**, and it **replaces** the group's representative in the listing.
   Distinct authors are normalized handles (one account quote-tweeting three times is ONE
   author) **excluding the article's owner**, parsed from the permalink
   (`x.com/<owner>/article/<id>`) — an author posting or self-quoting their own article is not
   amplification.

**The one-slot invariant.** An article group occupies exactly ONE listing slot, always. By
default that is the representative at its own rank; on promotion the article doc takes over
that same slot and moves to the band bottom, and the representative leaves the listing (it
joins `collapsed`). Promotion is only *considered* for a group whose representative sits
**outside** the top-N band — a group already represented inside the band needs nothing, and a
second entry would break the invariant. So each promotion pushes exactly one non-group doc out
of the band, and displacement is bounded by `min(maxPromotions, topN)` (the effective cap is
clamped both ways: the insert index never goes negative, and `amplificationMaxPromotions` is
itself validated `0..20`). When the article doc IS the representative, promotion is a pure move
and nothing is replaced.

**Why a reserved slot and not a calibrated score boost.** Measured over the real 2026-07-25
two-day window (476 docs, 100% listing-score coverage): top-30 bar **0.6201**, top-10 bar
**0.6535**, top-80 cut **0.5777**, max **0.7493**. The whole usable band is 0.13 wide, so a
multiplier big enough to lift a mid-band article (rank 67, 0.5903) over the bar (≈ ×1.051)
applied to the day's top article (0.7493) yields 0.7874 — a permanent, unassailable digest
lead for whatever the amplifiers liked. And a multiplier's **displacement is unbounded**: N
qualifying articles push N docs out. A reserved slot inverts both: worst case is exactly
`maxPromotions` displaced docs no matter how junk or how widely quoted the article is, the
promoted doc lands at slot 30 (never the lead), and no score is ever multiplied, so every
other doc's ordering is unchanged.

**Calibration (2026-07-25, real corpus) — window census vs the production population.** The
committed fixture is the 476-doc **2-day window**; production runs `applyAmplification` on
`compacted`, the top-`maxDocs` (80) score-ordered batch. Both numbers matter, and they differ:

- *Window census (476 docs):* 32 article-footer docs in **25 groups**, 7 of them multi-doc, max
  group size **2**, max distinct amplifiers **1** — i.e. **no organically-amplified article
  exists yet** (the fetcher's footer change is days old; the trq212 six-amplifier case predates
  it). The ≥3-author cases in the replay tests are therefore SYNTHETIC extensions of real
  groups, and are labelled as such. The window holds **25 article docs**, of which only **6**
  sit inside the 80-doc cap (ranks 1 / 15 / 26 / 38 / 57 / 67, 0.7493 → 0.5903) — an earlier
  version of this note wrongly said article-class docs "all sat at ranks 1–67".
- *Production population (top-80 batch) — today's real behavior:* **7** article-footer docs in
  **7 groups**, **0 multi-doc groups**, hence **0 collapsed and 0 promotions**, and the digest
  top-30 is identical to the un-amplified baseline. The "collapse drops 7 duplicate slots"
  figure is **window-level only**; on the production path it is 0, and the `Collection: …
  article-collapsed` log field reads **0** on today's data. A nonzero value there is the first
  sign the mechanism has real surface.

**Known v1 limitation — the BINDING constraint.** Amplification cannot rescue an article that
missed the `maxDocs` listing cap (that cap is listing-score based and runs *before* bodies, and
therefore before any `articleUrl`, exist). Concretely: **promotion requires the article doc AND
≥ `amplificationMinAuthors` amplifier docs inside the same 80-doc score-ordered batch.** Not a
dead letter, though — with PR 1's parse lift, amplifiers of AI-relevant articles re-scored at
**0.59–0.65** (pvncher 0.6457, startupideaspod 0.6420, AnatoliKopadze 0.5950) against the 2-day
top-80 cut of **0.5777**, i.e. three of four measured amplifiers clear the cap post-lift. The
fixture still carries their PRE-lift ranks (99–153). Accepted; see the `maxDocs` row for why 80
stays.

**Also known + accepted:**
- **Collapse is NOT bounded by `maxPromotions`** — that knob bounds promotion displacement
  only; a degenerate group of N amplifiers collapses N−1 docs out of the listing. Measured max
  group size today is **2**, so this is theory, and collapse is a de-duplication fix rather
  than a ranking preference.
- **The `minScore` gate's `topScore` still reads `compacted[0]`**, which collapse may have
  dropped from the listing. A deliberate behavioral-parity choice: a collapsed amplifier is
  still a real, fetched tweet the run considered, so the gate keeps behaving exactly as before.
- **On Highlights (`dedupByTweetId: true`) a collapsed amplifier is marked seen without having
  been shown** — `trackingIds` rides `compacted`, not the listing. Accepted: the capture path
  still sees the doc; only the digest listing loses it.

Pure + unit-tested in `x-amplification.test.ts` (grouping, threshold, collapse semantics,
promote-replaces-representative, boundedness incl. the `topN`-clamp cases, config validation,
plus two replays over the committed `__fixtures__/x-feed-2026-07-25-window.json`: the
**production** top-80 slice asserting today's inert output, and the **window** census asserting
pre/post digest composition on synthetic amplification). A promotion logs one line
(`Amplification: promoted <url> (N distinct amplifiers) into rank Y, taking the group's slot at
rank X (replacing <docId>)`); the `Collection: …` info line carries `N article-collapsed`.

### Prompt size is critical

Sonnet times out at 60s with large prompts. The collection path must send **compact one-liners** (`compactTweetText`), not full markdown documents. Full docs caused 180s timeouts even with increased limits. The compact format matches what the direct fetcher produces: `@handle: text (likes, views)\n  URL: url`.

### Collection path gotchas

1. **Date filtering required**: The collection has ALL indexed tweets (800+). Without filtering to today+yesterday by filename date prefix, the watcher sends ancient tweets to the model.
2. **Timezone matters**: Huginn indexes with local dates (Europe/Oslo). Use `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" })` — NOT `toISOString()` which gives UTC and causes off-by-one near midnight.
3. **Document ID prefix**: Huginn prepends `[2026-03-21_handle_id]` to document text. Must strip before sending to model.
4. **Batch fetches**: Huginn is a Python server — don't fire 80 concurrent requests. Batch at 20.

### Dedup

- Tweet IDs tracked as `tw:{tweetId}` in `lastNotifiedIds` (shared rolling window, max 600)
- `trackingIds` on `WatcherAlert` — runner persists these alongside the alert ID
- The alert ID `x-digest-{timestamp}` is always unique (never deduped by ID), but individual tweet IDs in `trackingIds` prevent re-processing
- Collection path filters by `lastNotifiedIds` BEFORE fetching full docs (avoids wasted API calls)

### Config fields (stored in watcher JSONB config)

| Field | Default | Description |
|---|---|---|
| `collection` | `"x-feed"` | Collection name. Required for the active collection path. |
| `model` | Haiku | Model for summarization (e.g. "claude-sonnet-4-6") |
| `timeoutMs` | 300000 | Model call timeout (ms). Set 600000+ for Sonnet with large backlogs. Read by BOTH legs off the same default: the digest call, and the capture leg's completion budget (`min(timeoutMs + 30s, tick 600s) − 60s`). |
| `maxDocs` | 80 | Max documents to fetch from collection per run. The cap is **score-ordered** (see "Score-ordered document cap"), so at full listing-score coverage it no longer shapes digest content — only fetch cost and the capture batch. Below full coverage it still selects which docs are fetched at all. **Calibrated 2026-07-25 and deliberately kept at 80** for the X-Article work: the live 2-day window held 476 docs at **100%** listing-score coverage, 80th-place `combined_score` = **0.5794**, and every article-class doc in the capture band sat at ranks 1/15/26/38/57/67 (0.7493 → 0.5903) — all inside 80. Raising to 200 (cut ≈ 0.500) would admit 10 more articles, all from the low-engagement tail the gate's 0.6 floor rejects anyway, at ~200 doc fetches per 2h run. Revisit only if a `Collection: …` log line shows `newCount` regularly above 80 (the first post-quiet-hours run is the one binding case). |
| `topN` | 30 | Max tweets sent to LLM after engagement ranking |
| `prompt` | `DEFAULT_X_PROMPT` | Custom prompt (overrides default two-tier format) |
| `apiUrl` | `KNOWLEDGE_API_URL` env | Knowledge API URL |
| `windowDays` | 2 | Rolling day window (Europe/Oslo). 1 = today only, 7 = last week. |
| `dedupByTweetId` | `true` | Filter out tweets already in `lastNotifiedIds`. Set `false` on daily/weekly digests that re-rank the full window. |
| `minScore` | — | Pre-LLM gate on `rankScore` (metadata `combined_score` preferred; text-regex `combined_score`/`engagement_score` fallback). If set and top tweet is below, the watcher silently tracks the fetched IDs and skips the LLM call entirely — no message sent. **NB — needs re-tuning:** the seeded X Highlights floor of `0.85` is structurally unreachable (live max `combined_score` ≈ 0.8028), so Highlights silences every run. Re-tune below the post-rescore ceiling once distribution is measured — expect **0.6–0.75**. |
| `quietMode` | `false` | Allows the LLM to reply with literal `SKIP` (any case, optional surrounding markdown/punctuation) to suppress the alert. The fetched IDs are still tracked so the same tweets aren't re-evaluated next run. |
| `captureCandidates` | `false` | Persist high-value **long-form** tweets into the `summary_candidates` inbox (Candidates → Summaries). Collection path only. Runs on the FULL fetched batch, BEFORE and independent of the `minScore`/`quietMode` silencing — a run that alerts nothing can still capture. See "Candidate capture" below. |
| `candidateMinScore` | 0.6 | Inbox capture floor for **top-5%-author** long-form (`x-post`) tweets — long-form tweets scored ≥ this by the capture gate are queued. Independent of the alert `minScore`. |
| `candidateMinScoreNonTop` | 0.75 | Stricter capture floor for **non-top-5%-author** long-form (`x-post`) tweets (unknown authors, and — deliberately — EVERY author when the author-scores file is unavailable). Effective floor is `max(x-post base, candidateMinScoreNonTop)`, raise-only. **Never applies to `**Type:** article` docs** (long-form by construction — see the precedence table below, under "Candidate capture"). Author tier is resolved once per run from huginn's `x-feed-author-scores.json` percentile cuts (`getAuthorTierThresholds`); the tier (top 1% / top 5%, never the raw score) is also injected into the capture-gate prompt as an author-rank prior. Degrade direction is safe — scores-file outage ⇒ fewer captures, never a silent widening. **Never applies to `x-link`** (link-tweets are already top-author-only by eligibility). |
| `amplificationMinAuthors` | 3 | Distinct **amplifying** authors (normalized handles, the article's own owner excluded) required before an article earns a reserved digest slot. See "X-Article amplification signal". Validated at read time — a non-integer / `< 1` value is warned about and dropped back to the default. |
| `amplificationMaxPromotions` | 1 | Reserved digest slots per run — the **bound** on promotion displacement (at most this many docs can ever be pushed out of the digest by a promotion; collapse is separately unbounded). `0` disables promotion; **collapse still runs** (it is a de-duplication fix, not a ranking preference). Validated like the field above, as an integer in **`0..20`** — the upper bound exists because the knob's whole job is to CAP displacement, so a fat-fingered `1e9` must not silently uncap it. At run time the effective value is further clamped to `min(maxPromotions, topN)`. |
| `candidateMinScoreByKind` | — | Per-kind capture-floor overrides `{ "x-post"?, "x-link"? }` (name + semantics mirror the anthropic vertical). `"x-post"` overrides the long-form base floor (else `candidateMinScore`, 0.6) — the non-top raise still stacks on top; `"x-link"` sets the pointer-tweet floor (else 0.7). |
| `captureAmplifyMin` | — (**OFF**) | **Step 2b flag.** Distinct POINTER authors a destination needs before SUB-TIER pointers (authors outside the tracked top-5%, which `isLinkTweet` excludes so they vanish today) can earn it a candidate row. **Unset ⇒ the whole any-tier path is off**: no gate-batch growth, no votes, byte-identical to step 2a. A present-but-invalid value (non-integer, `< 1`, wrong type) is warned about and also treated as OFF — the degrade direction for a mistyped knob must be "no batch growth", never "capture everything". The warn is emitted **once per process per watcher per bad value** (the knob is read on every 2h capture run, and a static config defect repeated forever is noise). Recommended value 3 (`DEFAULT_CAPTURE_AMPLIFY_MIN`); that ≥3-distinct-authors bar IS the compensating control for relaxing the top-author-only gate, so `1` effectively captures every pointer tweet on X. ⚠️ **Enablement gate — not just a preference:** turning it on grows the capture gate's batch by up to **+26** items (`maxDocs` 80 minus today's ~54 eligible floor), and the gate is the leg that ran **~18h with zero successful runs** on 07-25. Enable only once the `x-capture-gate ok` outcome log shows **≥2× duration headroom at current n**, or once chunking has shipped. See "Any-tier amplifier admission" below. |

### Silent alerts and the quality-gate pattern

When `minScore` or `quietMode` suppresses a digest, `checkX` returns a single `WatcherAlert` with `silent: true` and populated `trackingIds`. The runner detects the flag (see runner.ts) and persists the IDs into `lastNotifiedIds` without sending, saving, or logging to `activityLog`. This keeps re-evaluation cost bounded — tweets that were considered and rejected won't be re-fetched next tick.

### Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B — X → shelf)

With `captureCandidates: true` the X Highlights row feeds the SAME `summary_candidates` → `/summaries` → shelf pipeline the anthropic watcher uses, so high-value X content joins the reading shelf. The mechanics mirror the anthropic capture, with X-specific twists:

- **Placement is load-bearing.** `checkX` has two silencing paths that permanently track tweet IDs (the pre-LLM `minScore` early return and the post-LLM `quietMode` SKIP). The live X Highlights row runs `minScore/quietMode`, so most runs silence the whole batch and never re-consider those IDs. Capture therefore runs on the **full fetched batch** (all docs via `FetchResult.docs`, NOT the `topN`-sliced digest subset), **before and independent of** both silencing paths — a run that alerts nothing still captures.
- **Two capture classes fed to ONE gate call:**
  - **`x-post` — long-form** (`isLongFormTweet`): an extracted tweet *body* ≥ 800 chars (measured PRE-truncation, since x-feed docs carry ~350–450 chars of fixed scaffolding) OR a long-form `**Type:**` marker — **`note` OR `article`** (`parseDocType` → `XDocType`; `TweetDoc.docType`, which replaced the old boolean `isNote`). A short plain tweet is its own summary — never captured this way.
    - **X Articles are marker-only by necessity.** huginn's fetcher writes an `**Type:** article` doc whose body is just the article TITLE + a ~190-char preview (≈280–460 chars measured), so the 800-char fallback can NEVER rescue the class — before the marker widening the entire X-Article species was invisible to capture. The doc also carries a dedicated `- **Article:** <url>` footer line, parsed by `extractArticleUrl` into `TweetDoc.articleUrl` and used as the candidate `url` (so `/summaries` links to the article, not the announcing tweet). **The footer is NOT article-only** — huginn writes it on any doc whose tweet OR quote target carries an article (`article_source = tweet if article else qt`), so amplifier notes carry one too; the capture path therefore gates the candidate url on `docType === "article"` (`doc.docType === "article" ? (doc.articleUrl ?? doc.url) : doc.url`). Without that gate a capture-eligible amplifier note would key its row on ANOTHER author's article URL and collide with the promoted article doc on `UNIQUE(source, url)` — the summarizer resolves content by `sourceDocId`, so the row would serve the wrong body under that title. `extractArticleUrl` is likewise anchored to the FOOTER region (lines after the last `---`, line starting `- **Article:**`) so author-controlled body text can't inject a candidate url, and `parseDocType` matches the anchored `- **Type:**` line's value EXACTLY (`note` checked first — a note that links an article stays a `note`). That parse is deliberately **NOT** a widening of `extractDocLinks`/`SKIP_HOSTS`: those links are direct-FETCHED by `pickEnrichmentLink` when summarizing, and an `x.com/…/article/…` URL would only ever yield X's login wall in the prompt. Content resolution is unaffected either way — the summarizer reads `sourceDocId`, never the candidate URL. v1 summarizes from title + preview (thin but honest; real article text needs X auth).
    - The digest/gate prefix `[ARTICLE/NOTE]` is **shared** by both species (it already names both); the legacy `fetchFromPython` path's `tweet_type` check was widened in the same change.
  - **`x-link` — pointer tweets** (`isLinkTweet`, PR 3): NOT long-form, carries ≥1 external destination link (parsed from the doc's **plural** `**Links:**` footer by the shared `extractDocLinks` in `src/summaries/doc-links.ts` — the singular `**Link:**` permalink is on every tweet and is ignored, so a raw link count is never a predicate), AND the author is **top-5% (or top-1%)** of tracked authors (keeps volume + gate cost bounded). A pointer tweet's value is the external link it points at (a 28-min video, an article), not its short text, so the summarizer follows the link — `kind: "x-link"` scopes the summarize path (`src/anthropic/summarizer.ts`) to treat the LINKED content as the primary subject (the enrichment path already wired in PR 2). Long-form wins outright: a tweet that is both long-form and link-carrying is captured as `x-post`. Since step 2a an `x-link` row is keyed on its **normalized destination URL**, not the tweet permalink — see "Destination-URL keying" below.
- **One extra Haiku gate** (`DEFAULT_X_CAPTURE_PROMPT`, the anthropic gate's `{n,score,why}` shape) over the eligible subset (both classes). Each `x-link` post's gate line names its destination (`links to: <domain> — <url>`) so the model weighs the linked content, not just the short tweet text. Candidates scored ≥ their **floor** (see below) are upserted with `source: 'x'`, `title: "@handle: <first line>"`, `candidateSrc: "X (@handle)"`, `kind` (`x-post`/`x-link`), and `sourceDocId` = the huginn `x-feed` doc id (the summarizer fetches `/api/document/x-feed/<id>` for content — tweet URLs aren't directly fetchable).
- **Destination-URL keying for pointer candidates (2026-07-26, X hype-dedup step 2a).** **The candidate `url` is no longer always the tweet URL.** A `x-link` candidate is keyed on the NORMALIZED DESTINATION URL (`destinationGroupKey`, `src/summaries/destination-url.ts`); `x-post` and every anthropic kind are untouched. Why: a "X just dropped …" wave arrives as N pointer tweets from N authors at ≈1 per 2h batch **over days**, so tweet-URL keying yields N near-identical 0.9+ inbox rows and in-batch dedup (the gate prompt's in-list rule) can almost never fire. Keying on the destination collapses the wave to ONE row ACROSS runs.
  - **Group key = `normalize(links[0])`** — the first external link only, matching the gate's `links to:` line and `pickEnrichmentLink`'s single-link design. Two docs listing the same pair in a different order key differently and don't collapse (accepted).
  - **The normalizer** strips the fragment, trailing slashes and tracking params (`utm_*`, `si`, `ref`), **KEEPS the rest of the query**, upgrades `http://`→`https://`, lowercases scheme+host only (never path/query), strips a leading `www.` from the host, and canonicalizes every YouTube shape (`youtu.be/<id>`, `/shorts/`, `/embed/`, `/live/`, `watch?v=`) to `https://youtube.com/watch?v=<id>`. It is deliberately **NOT** `normalizeArticleUrl` (`x-amplification.ts`), which strips the whole query and would collapse every `youtube.com/watch?v=…` into one key.
    - **Host variance is the norm, not the exception:** real x-feed data carries BOTH `anthropic.com` and `www.anthropic.com`, and 12 real http/https collapse pairs — hence the `www.`-strip and the scheme upgrade.
    - **Deliberate non-decisions.** Query params are **NOT sorted**: zero real occurrences of a same-destination pair disagreeing only on param order, and reordering risks order-sensitive servers when the key is later fetched. `ref` is stripped alongside `si`/`utm_*` — the borderline one (a few sites use `ref` as a real selector); on the wave-collapse side of the trade, **watch it**. The `http→https` upgrade **keeps an explicit port**, so a `http://host:8080/x` key is unfetchable as written — zero real occurrences, not worth a special case.
    - A hash **route** is KEPT when the path is empty and the fragment starts with `/` (`site.example/#/post/123` — hash-routed SPAs, where the route IS the address); every other fragment is dropped as today.
  - **Tweet-URL keying is kept** (null group key) when there is no external link, when it doesn't parse / isn't http(s), when the host is x.com/twitter.com/t.co (defence in depth — `extractDocLinks` already filters those), and for a **PDF destination** (`isPdfUrl` — a `.pdf` extension OR a `/pdf/` path SEGMENT, so the extension-less arxiv form `arxiv.org/pdf/2401.00001v1` is fenced too). **Rationale, corrected:** it is NOT that a destination-keyed PDF would summarize raw bytes — enrichment already `res.text()`s the PDF today on the tweet-keyed path, so the model sees identical content either way. The carve-out is **conservative v1 scoping**: the PDF pointer class holds the most-valued summarized candidates on the shelf (the Andrew Ng PDF), and the plan pins its exact current behavior rather than moving two things at once. Real PDF text extraction + destination-keying for PDFs is a **named follow-up**; until then a paper drop gets no wave-collapse (N pointer rows), a stated trade. Long-form is never re-keyed (`kind === "x-link"` implies `docType === null`, since long-form wins the kind resolution outright).
  - **Persisted fields, all from the REPRESENTATIVE** (the best-scoring wave member seen so far): `url` = normalized destination, `sourceDocId` = that member's x-feed doc id, `score`/`why` = its gate output, `title`/`candidateSrc`/`author`/`authorScore` = its, `kind` = `x-link`.
  - **Written through `upsertDestinationCandidate`, NOT the shared `upsertCandidate`.** The shared upsert's conflict path has MIXED precedence (`why`/`title`/`candidate_src` follow the winning score; `source_doc_id`/`author`/`author_score` are newest-non-null-wins `COALESCE`) — correct when the `url` IS the tweet, but on a destination key each admission comes from a DIFFERENT member, so repeated upserts would pair one member's score/why with another's doc and the summary body would come from the member that LOST. The destination writer takes EVERY mutable column from the incoming member under ONE shared predicate (`EXCLUDED.score > stored.score`) — never per-column differing precedence — so the row is always one member's fields, whole.
    - **Re-admittable vs terminal.** A destination key is long-lived, so "never touch a non-`new` row" would let one row POISON its key forever (empirically: an auto-expired row silently swallowed a later 0.97 wave). Re-admittable: `new`, `error` (a transient failure with no automatic retry path), and `dismissed` **with `dismissed_reason = 'expired'`** (auto-expiry after 14 idle days is bookkeeping, not a judgement). Terminal: MANUAL dismissal — the intended dismiss-once bonus, **dismissing the topic once permanently suppresses later wave members** — plus `summarized`/`summarizing`. A winning admission onto a re-admittable row also resets `status = 'new'`, `dismissed_reason = NULL`.
    - **`updated_at` is bumped unconditionally on re-admittable rows**, even on a tie/loss. Load-bearing: a destination under continuous hype would otherwise never refresh its 14-day expiry clock, expire mid-wave, and start poisoning its own key.
    - Expressed as a conflict-path write so the read-compare-write is atomic against two concurrent runs.
  - **Summarizer follow-through** (`src/anthropic/summarizer.ts`, both KIND-GUARDED on `x-link` + a non-x.com candidate url, so no other kind's behavior moves): (1) enrichment prefers the **candidate `url`** over the doc's `links[0]` — a multi-link representative would otherwise summarize the wrong destination; (2) a **stale-doc fallback** fetches the candidate `url` when the representative's x-feed doc no longer resolves (the collection caps at 5000 docs and re-index mints fresh ids) — routed through the ENRICHMENT machinery (`pickEnrichmentLink` → `fetchEnrichmentContent`), not a bare direct fetch, so a YouTube destination gets its transcript instead of a raw JS shell being "summarized" into the terminal `summarized` status. That path also marks the content `destinationOnly`, which flips the base system prompt from the X tweet framing to the article framing (there is no tweet in the body) and swaps in a destination-only framing line. The general "no URL fallback on the source-doc path" rule stands for everything else — it exists for x.com login walls, and a destination-keyed row's url is a non-x.com artifact by construction.
  - **Suppression is terminal, accepted:** collapsed members are marked seen via `dedupByTweetId`; the top-scoring member IS the representative and the digest lane surfaces the others independently.
  - **Transition window is empirically nil:** prod has **0** `new` `x-link` rows (420 `new` are `x-post`), so no mixed-keying cohort to migrate or reconcile.
  - **UI affordance:** the inbox title anchor now opens the DESTINATION while the title still reads `@handle: …`, so a small secondary **post ↗** link is rendered on destination-keyed `x-link` rows (`sum-candidates.ts`), derived from the x-feed doc id shape `<yyyy-mm-dd>_<handle>_<tweetid>.md` (handles may contain `_`, so the parse anchors on the trailing all-digits segment). An unrecognized doc-id shape renders nothing. **Status after step 2b:** the `x_link_amplifiers.tweet_permalink` column now *exists* and holds each recorded pointer member's permalink verbatim, but the inbox link is still DERIVED from the doc id — making it first-class means joining a second table into the candidates listing (a per-row lookup on the `/summaries` hot path) for a link the doc-id parse already produces correctly in every observed shape. Deliberately not wired; the column is there for the day the parse breaks or the shape changes.
  - **The queued-count log counts DISTINCT candidate urls**, not admissions — several pointer tweets in ONE batch can now collapse onto the same key, and this is the metric used to watch whether 2a works.
  - **Watch list:** (a) the first destination-keyed row's summary quality when it goes through the stale-doc fallback path (pure destination content, article framing); (b) the provenance hop when two bots capture the same destination — `watcher_id`/`bot_name` follow the WINNING member, so a row's provenance can move between bots (known, provenance-only, no functional effect); (c) `ref`-stripping false collapses.
  - No migration, no gate-batch growth. Unit-tested in `x.test.ts` (cross-run collapse + coherent representative, multi-link keying, `.pdf` stays tweet-keyed, manual-dismissed row not resurrected, auto-expired row IS re-admitted, distinct queued-count, long-form never re-keyed), `src/summaries/destination-url.test.ts` (the normalizer — www/YouTube canonicalization, hash routes, the widened PDF fence), `src/db/summary-candidates.test.ts` (real-Postgres re-admission semantics: error + expired re-admitted, manual/summarized terminal, tie bumps `updated_at` only), and `src/anthropic/summarizer.test.ts` (enrichment preference + kind guard + stale-doc fallback).
- **Any-tier amplifier admission (2026-07-26, X hype-dedup step 2b) — SHIPPED FLAG-GATED OFF.** Step 2a collapsed a wave of TOP-TIER pointers onto one destination row. **Sub-tier** pointers — same short-tweet-with-a-link shape, but the author is outside huginn's tracked top-5%, so `isLinkTweet` rejects them — still vanish entirely. Step 2b gives them a route in that does NOT relax the bar to "any author": they earn a row by CONSENSUS. With `captureAmplifyMin` unset (the shipped default) **none of this runs** — no batch growth, no votes, no behavior change.
  - **Batch growth is the whole cost, and it is the reason the flag is off.** Enabled, `isAmplifierPointer` adds sub-tier pointers to the ONE capture-gate call, bounded by the existing `maxDocs` (80): up to **+26** items over today's ~54 eligible floor. A sub-tier pointer whose link yields no group key (no parseable external link, an x.com self-link, or a **PDF** destination — step 2a keeps those tweet-keyed) is excluded from the batch too: it could never be admitted, so scoring it would be pure cost. That exclusion is also what satisfies "sub-tier `.pdf` pointers are simply not promoted" — they vanish exactly as today.
  - **Votes (`x_link_amplifiers`, migration `067`, mirrored in `db/init.sql`), keyed `(url_key, author)`.** Every pointer inserts one vote per destination; the PK makes one account pointing five times ONE vote, forever. A pointer the gate OMITTED or scored below the floor still votes (NULL/low score) — **votes and admission are decoupled**, since a pointer is evidence its author pointed regardless of what the gate thought of it. Same-author repeat with a strictly higher score refreshes the recorded member (`> `, so the first arrival keeps a tie). **Null-author pointers are SKIPPED** (the parser's "unknown" handle fallback) — an unattributable vote can't be a DISTINCT author, and counting it would let one unparseable-handle class fake a whole wave.
  - **Why the score/title/why/doc columns exist:** by the time member three arrives, members one and two were consumed and marked seen in EARLIER runs and their x-feed docs are not in this batch. Without the recorded snapshot, "admit from the top-scoring member of the wave" is impossible and the representative could only ever be the current run's pointer.
  - **Only POINTER authors count (CAPPED item 3).** A LONG-FORM post carrying the group URL keeps its own tweet-keyed `x-post` row (judged under step 1's repackaging cap) and records a `pointer = false` vote for **OBSERVABILITY ONLY** — never counted toward `captureAmplifyMin`, never eligible as the representative. Counting long-form voters would let two footnote links + one pointer admit a destination row *alongside* the two x-post rows (the exact duplication this plan removes) and would hollow out the ≥3-authors bar. Enforced in two independent places, because the count alone is not enough: `getAmplifierGroup` counts + ranks `WHERE pointer`, **and** the content columns are POINTER-ONLY on insert (a `pointer = false` vote writes NULL score/title/why/permalink/doc). The second guard is load-bearing — a long-form-FIRST author would otherwise seed the row with essay content at a high score, and their later pointer (a lower, pointer-scored number) could not beat it, handing the representative slot to a long-form post through the back door. `pointer` is otherwise sticky-TRUE, so a long-form-first author is promoted, not disenfranchised.
  - **Admission.** Top-tier pointer ⇒ immediate destination row (step 2a, unchanged). Otherwise, when `count(DISTINCT pointer author) ≥ captureAmplifyMin` **AND** the best recorded POINTER member clears `captureFloorForXLink` (0.7), a row is written FROM THAT MEMBER (its score/why/title/sourceDocId/author) through step 2a's `upsertDestinationCandidate` — so dismissal terminality, error/expired re-admission and the one-coherent-set invariant are INHERITED, not re-decided. The quality bar does not move: three cheerleaders at 0.65 admit nothing. `authorScore` is written NULL (the vote table records no PageRank snapshot; it's a transparency-only column and a sub-tier member's defining property is having no rank worth showing). The check runs at most once per destination per run, and a *top-tier* pointer that fell below the floor triggers it too — its vote is as real as a sub-tier one. **The check is DRAINED AFTER the persist loop, never inline.** Votes are written per item as the loop walks, so an inline check at the first non-directly-admitted pointer of a group cannot see a threshold crossed by a LATER member of the SAME batch — and the group is never re-checked, because the earlier members are consumed and marked seen (empirically: alice in run 1, then bob + carol in one run-2 batch ⇒ 3 distinct authors, best 0.9, ZERO rows). The loop therefore only COLLECTS group keys; the drain runs them once each after every vote in the batch has landed, skipping any destination a direct admission already wrote this run. A suppressed write (the writer's terminality guard: manually dismissed / summarizing / summarized) is reported honestly — `upsertDestinationCandidate` returns whether a row was actually written (`RETURNING id`), and the log reads `suppressed by candidate status` instead of `admitted from @author`.
  - **`passesCaptureFloor` returns false for sub-tier pointers unconditionally**, so the gate's `aboveFloor` field keeps meaning exactly "would be captured by the persist loop"; wave admissions show up as their own `Capture: N pointer authors amplified <url>` info line instead.
  - **Prune:** rows older than ~30 days are dropped by `pruneXLinkAmplifiers`, attached to the same `/summaries` load call site as `expireStaleCandidates` — cleanup therefore depends on dashboard visits (accepted; the miss is unbounded growth of a tiny table, never incorrectness). A dormant group's votes age out and must re-accumulate, which is the intended "wave went cold" behaviour.
  - **Farm-ring risk — documented, not built.** The ≥3-distinct-authors threshold is the ONLY compensating control for relaxing the top-author-only gate, and `author_score` is farm PageRank so it can't be used as a quality prior. The author-scores JSON's `community` field feeding a same-community discount on the distinct-author count is the named **v2 lever**.
  - **Enablement watch list (first week after the flag goes on)** — the things this design knowingly trades away:
    - **(a) In-list dedup competition in the gate prompt.** The capture prompt tells the model "if several posts point at the same resource, keep only the strongest and omit the rest". With the flag ON, sub-tier pointers join that list and compete with a TOP-TIER pointer at the same destination — and if the model omits the top-tier one, that run loses a **direct** admission it would land today. The wave path only recovers it once ≥3 distinct authors have voted. Watch whether top-tier `x-link` direct admissions drop in the first week post-enablement.
    - **(b) Prune is keyed on `first_seen`, not last activity.** An author who keeps pointing at the same destination for >30 days loses their vote to `pruneXLinkAmplifiers`, so a genuinely slow-burn wave may never assemble ≥3 live votes at once. Accepted for the observed wave shape (≈1 member per 2h batch over days, not months); revisit only if a known multi-week wave visibly fails to admit.
    - **(c) Vote writes are serial per-item DB round trips**, inside the persist loop and therefore **outside** the capture budget deadline (which bounds only the gate call). Tens of ms at n=80 — known and accepted, but it is real wall clock added to every capture run once the flag is on.
    - **(d) `author_score` is written NULL on wave admissions even when the best recorded member is top-tier.** The vote table records no capture-time PageRank snapshot, so `/summaries` shows no author tier on those rows. Transparency-only; no functional effect.
  - **Deploy note:** run `bun run db:migrate` **before or with** the restart that ships this. `pruneXLinkAmplifiers` is called unconditionally on the `/summaries` load path (not flag-gated), so an unmigrated DB warn-logs `relation "x_link_amplifiers" does not exist` on every page load until migrated. Harmless (try/caught, never breaks the page) but noisy.
  - Unit-tested in `x.test.ts` (three runs / three distinct sub-tier authors: no row until the third, then one row from the BEST recorded member — not the third and never the long-form voter; the floor still binds; long-form keeps its own row and votes observability-only; the threshold crossed by a later member of the SAME batch still admits exactly one row from the best member; flag unset ⇒ zero votes + zero batch growth + the gate never called, and on a MIXED batch the gate prompt carries only the long-form item; sub-tier `.pdf` never enters the batch; gate-omitted pointer still votes; an amplifier DB failure never breaks capture) and `src/db/x-link-amplifiers.test.ts` (real Postgres: PK idempotence, the strictly-greater refresh rule, NULL-score votes, pointer-only content, sticky-TRUE promotion, group isolation, prune); the writer's written/suppressed return value is covered in `src/db/summary-candidates.test.ts`.
- **One-shot backlog sweep (2026-07-26, X hype-dedup step 3).** Steps 0–2b only change FUTURE capture; the ~420 `new` X candidates already on the shelf were captured under the uncalibrated gate and would otherwise sit there until `expireStaleCandidates(14)`. `scripts/sweep-x-hype-backlog.ts` clears them in one go — dry-run by DEFAULT (`--execute` to write; `--before <date>` cutoff, `--source` to retarget the vertical; both `--flag value` and `--flag=value` forms, and any unrecognized `--token` is a usage error + exit 1 so an `--exeucte` typo can't read as a clean dry-run) — setting `status = 'dismissed', dismissed_reason = 'hype-dedup-sweep'` (`HYPE_DEDUP_SWEEP_REASON`, exported from `src/db/summary-candidates.ts`). **`--execute` REQUIRES an explicit `--before`** (the implicit "now" default is fine for exploring in a dry-run, far too blunt for a bulk write); a date-only `--before` parses as **UTC midnight**. The dry-run prints a per-UTC-day `created_at` breakdown of the eligible set so the operator sees which era they are clearing, and warns (listing the distinct `source` values present) if the source matched zero rows. The WHERE is additionally scoped to **tweet-permalink** URLs (`^https?://((www|mobile)\.)?(x|twitter)\.com/`): the backlog is by definition pre-#385 and therefore tweet-keyed, so a destination-keyed row can never be swept by an over-broad cutoff. A **script, not a migration**: a migration would replay on any environment created later and dismiss a legitimately fresh backlog. `candidateOutcomeStats` gives the reason its own bucket (`dismissedSwept`, rendered as a **Swept** column on the `/summaries` Calibration tab) — counted in `total`, EXCLUDED from the acceptance-rate denominator like `expired`, so a few hundred bulk dismissals can't tank the metric the recalibrated gate is judged against; a sibling `dismissedOther` catch-all ("Other" column) counts any dismissal whose free-text reason is none of manual/expired/swept, so a future reason can't silently fall out of `total`. The sweep reason is also **re-admittable** by `upsertDestinationCandidate` (alongside `expired`) — bulk bookkeeping must never poison a destination key. **Recoverable by SQL only** — nothing is deleted, but there is no un-dismiss endpoint or UI. Post-sweep the shelf is defined by post-ship captures.
- **Capture-gate prompt is CODE-ONLY.** `runCaptureGate` reads `DEFAULT_X_CAPTURE_PROMPT` unconditionally — the watcher row's `config.prompt` reaches ONLY the alert/digest path (`runAlertPath`). So a calibration change to the capture prompt ships with the code, with **no seeded-prompt migration** (unlike the Daily/Highlights alert prompts, whose DB-seeded `prompt` keys had to be stripped on 2026-07-20 to pick up code defaults).
- **Capture-gate calibration (2026-07-26, X hype-dedup step 1).** The `/summaries` candidate shelf was wall-to-wall ALL-CAPS engagement-farm pointer tweets at 0.9–0.95: the displayed score is verbatim the gate output, and the prompt's only anchors were ~1.0 / ~0.7 / ~0.6 — nothing separated 0.9 from 0.95 (measured: corr(gate score, `author_score`) = **−0.001** over 659 candidates; histogram 0.95×41 / 0.90×64 / 0.85×140 / 0.80×122). The frame verdict was that the pointer *content* is wanted — the problem is redundancy + credibility-blind ranking, **not** topical misfire — so this is a calibration change, not a harsher relevance cut. Three prompt edits, asserted in `x.test.ts`:
  - **Repackaging cap (~0.8), LONG-FORM ONLY.** A long-form note whose value is mostly a secondhand repackaging of someone else's artifact (course, paper, article, video, release) is scored BY THAT ARTIFACT and capped at 0.8, unless it adds original analysis/benchmarks/first-hand experience.
  - **The pointer carve-out is load-bearing, not politeness.** The cap explicitly does NOT apply to pointer items (a `links to:` line) — those keep the prompt's existing contract of being scored on the DESTINATION, uncapped, so a pointer to a primary source can still score ≥0.9. Rationale: destination-keyed candidate rows (the later destination-URL-keying step) inherit the representative pointer's gate score, so a blanket ≤0.8 cap would pin every promoted artifact below the **0.85** the inbox's `LIMIT 200` currently cuts at, while uncapped hype threads sat above them — step 1 would suppress exactly what the next step promotes.
  - **Real 0.8/0.9 anchors + in-list dedup.** ≥0.9 is RESERVED for a **primary source ONLY** — the artifact itself (the author's/destination's own work, paper, repo, release, announcement), never coverage of one — so the UI's ≥0.9 "high" band is **biased toward** artifacts. Best-effort, not enforced: there is **no code-side ceiling or clamp** on the returned score, and an identical item scored 0.85 on one run and 0.9 on a straight re-run. The plan's stated fallback if the first week of `ok` lines shows poor cap compliance is a **deterministic post-gate clamp**; it is deliberately not shipped here. Loud framing/ALL-CAPS/engagement volume are explicitly named as non-evidence (ceiling 0.85 without that standing); 0.8 = strong secondhand coverage (and the repackaging ceiling).
    - **The author-rank line is NOT a credibility signal**, and the prompt says so. An earlier cut also licensed ≥0.9 for "material from a top-tier author" — but every eligible pointer carries an `(author rank: top 1%/5%)` line BY CONSTRUCTION (`isLinkTweet` requires `tier != null`) and that rank is farm PageRank (corr **−0.001**), so the disjunct re-authorized exactly the pointers being calibrated away. Hard rule from the plan: `author_score` is never a positive quality prior.
    - **Both ceilings are phrased topic-independently** ("not lifted by how well the item matches the reader's interests"), because `withInterestProfile` appends its "can RAISE relevance" block **LAST** — after the ladder — and that block lives in the shared `src/profile/inject.ts` used by the other watchers, so it must not be narrowed for an x-only fix.
    - **Anti-clustering line.** The shelf's `LIMIT 200` cut sits at 0.85 and 0.85 is already the largest histogram bucket (×140), so a *named* ceiling invites a pile-up: the prompt states 0.85 is a maximum, not a default, and to use intermediate values (0.75, 0.65) freely.
    - In-list dedup, widened past pointer-only wording so long-form recap waves are covered too: "If several posts in this list point at, cover, or announce the same resource or announcement, keep only the one whose content (or destination) is most worth reading — score that one and omit the rest" — cheap in-chunk topic dedup, bounded to ONE gate call's list (it cannot dedup across runs; cross-run dedup is the destination-URL keying step's job).
  - **Watch items — first week of `x-capture-gate ok` lines** (alongside the p95-duration chunking read): (1) **a 0.85 score mode.** If the score histogram now piles at 0.85 the anti-clustering line failed and the ceiling just moved the bucket — that's the trigger for the deterministic post-gate clamp/spread. (2) **an `aboveFloor` volume drop concentrated in non-top long-form.** The repackaging cap plus the 0.75 `candidateMinScoreNonTop` raise leaves that class only the **[0.75, 0.8]** window, so a capture-volume collapse there is a floor/cap collision, not a quality signal — re-cut `candidateMinScoreNonTop` rather than loosening the cap.
- **Per-kind capture floor (single source of truth, `captureFloorForTier` / `captureFloorForXLink`).** Full precedence table:

  | kind | `**Type:**` | author tier | floor |
  |---|---|---|---|
  | `x-post` | `article` | any | base (0.6) — **non-top raise NEVER applies** |
  | `x-post` | `note` / body ≥ 800ch | top1 / top5 | base (0.6) |
  | `x-post` | `note` / body ≥ 800ch | null (non-top) | `max(base, candidateMinScoreNonTop)` (0.75) |
  | `x-link` | any | top1 / top5 | `candidateMinScoreByKind["x-link"]` → 0.7 |

  Base = `candidateMinScoreByKind["x-post"]` → `candidateMinScore` → 0.6. **Why articles are exempt from the non-top raise:** that raise exists to suppress SHORT hype posts from unknown authors that merely clear the 800-char body floor. An X Article is long-form BY CONSTRUCTION, so the raise would filter on a signal that doesn't apply — and would silently kill the whole class (articles from top-5% authors are rare). The exemption skips the *raise*, it never undercuts an explicitly raised base. `x-link` never takes the raise either (link-tweets are top-author-only by eligibility).
- **Author-tier capture floor + gate prior** (`resolveAuthorTier` / `captureFloorForTier`, both pure + unit-tested). The author's PageRank score is the strongest capture prior, so before the floor check the run resolves — once per run — huginn's percentile cuts (`getAuthorTierThresholds`) and each eligible doc's author score (`getAuthorScore`, moved above the loop from the old persist-time lookup). A **top-5% (or top-1%) author** keeps the base `candidateMinScore` (0.6); every other author — unknown, unranked, and **deliberately every author when the scores file is unavailable** (null thresholds ⇒ tier null) — must clear `max(candidateMinScore, candidateMinScoreNonTop)` (default 0.75). One knob, raise-only; the degrade is a SAFE direction (fewer non-top captures), never a silent widening. The resolved tier (**top 1% / top 5%, tier only — never the raw float**) is also appended to each numbered post in the capture-gate prompt as an `author rank:` prior line, so the gate judges content WITH the prior while the deterministic per-tier floor stays the backstop. Not in scope: re-ranking the inbox by author (transparency-only `author_score` snapshot on the row is unchanged).
- **Capture-gate retry + hard completion budget (2026-07-26).** The gate failed **intermittently on 07-22 and 07-24, then continuously from 07-25 15:21 (~18h of zero successful capture runs)**: one Haiku call over the whole eligible list with a hardcoded 90s timeout and no retry, timing out at n=64/57/54/61/54 but **also** at n=6/14/19. The small-n failures **co-occurred with host contention** (a concurrently timed-out scheduler tick / SDK call in the same window), i.e. a spawn/model-latency tail rather than batch size — and a transient contention tail is exactly the failure class a retry remedies. Three changes, all in `x.ts`:
  - **One retry** per gate call (`CAPTURE_GATE_MAX_ATTEMPTS` = 2) and the per-attempt timeout raised **90s → 180s** (`CAPTURE_GATE_TIMEOUT_MS`).
  - **A hard completion budget**, because overrunning the run's time box is catastrophic rather than soft: `withWatcherTimeout` rejects, the runner's catch re-saves the OLD `lastNotifiedIds`, so the whole batch is re-fetched next run and the bulge grows. Invariant (**capture leg only** — the digest leg is unbounded by this and can still blow the net when the pre-digest fetch runs long; known residual, out of scope): `captureBudget = min(watcherNet, TICK_TIMEOUT_MS) − CAPTURE_BUDGET_SAFETY_MARGIN_MS` (60s), where `watcherNet = (config.timeoutMs ?? 300_000) + WATCHER_TIMEOUT_MARGIN_MS` (30s). **The scheduler tick (600s, `TICK_TIMEOUT_MS`) is the TRUE ceiling**, not the watcher net — X Highlights' 630s net loses that race, so its budget is **540s**, not 570s. The net's default is read from the SAME `config.timeoutMs ?? 300_000` the digest leg uses (a row with no configured timeout gets a 270s budget); deriving it from `computeWatcherTimeoutMs`'s unrelated 120s no-config FLOOR gave 60s — worse than the pre-retry flat 90s, with the retry permanently budget-dead. A derived budget below one per-attempt timeout is **warned about at capture entry**, so a degraded config is visible rather than silent. Each attempt gets `min(180s, deadline − now)` (`captureAttemptTimeoutMs`), and an attempt is **never started** when under `CAPTURE_GATE_MIN_ATTEMPT_MS` (**45s**, calibrated from the fastest observed successful call, 22.9s — re-cut it from the first week of `ok` lines) remains. Capture runs CONCURRENTLY with the digest call (started early in `checkX`, awaited in its `finally`), so the run's wall clock is `max(capture, alert)` and no alert reserve is subtracted — only the margin. The deadline is anchored at **`checkX` entry** (effectively the runner's clock) and NOT at capture start, which sits behind up to `maxDocs` (80) per-doc HTTP fetches and would silently overshoot. `computeWatcherTimeoutMs` **and** `TICK_TIMEOUT_MS` live in `src/watchers/timeout.ts` (a zero-value-import module) so checkers can read them without closing a `runner → x → runner` cycle; `watchers/runner.ts` re-exports `computeWatcherTimeoutMs` for legacy callers and `src/scheduler/runner.ts` imports the tick constant from there.
  - **An unconditional per-call outcome log** — the measurement surface, since nothing else records gate duration (`haiku_usage` has no duration column and writes only on success, `spawnHaiku` mints no `claude` span here, and `Capture: queued` only logs when `captured > 0`). One grep-stable prefix, emitted on success AND failure AND budget-exhaustion: `x-capture-gate <ok|failed|budget-exhausted>: n=… [scored=… aboveFloor=…] durationMs=… attempt=k/2 attemptTimeoutMs=… promptChars=… [error=…]`. **The rendered placeholders and the JSONL sink props carry identical names** (`attemptTimeoutMs`, never a rendered-only `timeoutMs` alias) so a mining script written off the documented line finds the field in the sink. `n` (items fed to THIS call) is load-bearing — the chunking decision reads a duration-vs-n correlation, and any later batch growth must be splittable pre/post off this field. `scored` is the USABLE count (`indexScoresByN` size, out-of-range/duplicate `n`s dropped); `aboveFloor` shares `passesCaptureFloor` with the persist loop, so it always means exactly "would be captured". Both are **omitted on non-`ok` lines** (a `0` there is indistinguishable from "ran, scored nothing"). `durationMs` is read the instant `spawnHaiku` returns, so on `ok` lines it is MODEL latency — on `failed` lines it is censored (it equals the attempt timeout), so **correlations must be fit on `ok` lines only**. `attempt` counts attempts actually MADE (a `budget-exhausted` line before attempt 2 reports `1`).
  - **Phase-B chunking threshold:** read the first week of `x-capture-gate` `ok` lines; **chunk when p95 `durationMs` > 90s at current n**.
- **Capture-gate failure stance (decided):** on a capture Haiku error (after the retry), log and proceed with the normal alert path — the run's long-form tweets are lost to the inbox this run (best-effort). We deliberately do NOT hold tweet IDs back from tracking: entangling alert dedup with capture health would re-surface already-alerted tweets. Best-effort throughout — a DB error never breaks the alert path. Dedup rides the table's `UNIQUE(source,url)` + the upstream `lastNotifiedIds` filter.

Summarizer + inbox are source-aware: `resolveContent` fetches the `x-feed` doc when `source_doc_id` is set (X system-prompt variant), the summary still lands on the shared `anthropic-summaries` shelf, and the inbox route (`GET /api/anthropic/candidates`) reads `source: ["anthropic","x"]` with a small source badge per row. `dashboard_url` stays `source=anthropic` for all rows (that param keys the shelf registry, not the candidate origin). Column added in migration `048` (`source_doc_id`, nullable), mirrored in `db/init.sql`.

### 3-watcher pattern (daytime alerts + daily + weekly)

Instead of one X watcher doing everything, run three rows with shared `collection: "x-feed"` but distinct configs. Each has its own `lastNotifiedIds` column so they don't step on each other's dedup.

| Name | Schedule | `windowDays` | `dedupByTweetId` | `minScore` | `quietMode` | Prompt |
|---|---|---|---|---|---|---|
| X Highlights | every 2h (08:00–22:00) | 2 | true | `0.85` (tune; live row runs `0.6`) | `true` | `DEFAULT_X_HIGHLIGHTS_PROMPT` — returns `SKIP` unless genuinely exceptional |
| X Daily Digest | interval 24h + `hour: 12, minute: 0` | 1 | false | — | false | `DEFAULT_X_PROMPT` (two-tier) |
| X Weekly Digest | interval 7d + `hour: 18, minute: 0` | 7 | false | — | false | Custom ("themes of the week" + top picks) |

> **Why Highlights runs `windowDays: 2`, not 1.** It is quiet-hours gated, so at ~22:00 it stops and doesn't run again until ~08:00. On a 1-day window a doc indexed at 19:45 gets ~1–2 runs before the night skip, and by the next morning it is **out of window forever** (the window has rolled to "today"), while `dedupByTweetId` has already filtered it if it *was* seen. The 2-day window is what makes an evening arrival still reachable on the first morning run.

Day-of-week is not a first-class scheduler concept — the weekly watcher's "day" is whichever day of the week it was first run; `isScheduledTimeDue` only gates on hour/minute within a day, and the 7-day interval then determines the next fire.

Existing X watchers keep their current behavior because all new fields are opt-in: `windowDays` defaults to 2 (today+yesterday), `dedupByTweetId` defaults to true, `minScore` and `quietMode` are unset.

### No fallback on model failure

If the model call fails (timeout, crash), the watcher returns `[]` — no Telegram message sent. This is intentional. The raw-text fallback was noisy and confusing. Failed tweets are NOT tracked, so they retry on the next run.

## Runner (runner.ts)

### Manual trigger via force_next_run

The dashboard "Run" button sets `force_next_run = true` in the DB. The next scheduler tick picks it up through the same `runWatchers` path (with tracing). Forced watchers skip `isScheduledTimeDue` and quiet hours. The flag is cleared by `updateWatcherLastRun()`.

### Time-of-day scheduling

Watchers with `config.hour`/`config.minute` only run once per day at/after that time. Uses cached `Intl.DateTimeFormat` (Europe/Oslo). The `isScheduledTimeDue` filter runs AFTER `getWatchersDueNow` (interval-based), so both conditions must be true.

**Warning**: If `config.hour` is set but interval < 24h, the time-of-day constraint wins (runs once daily). The dashboard shows a warning banner for this case.

### Truthful `/agents` connector + model (`watcherConnectorInfo`)

The `/agents` run card shows the backend + model that **actually ran**, not the
bot's chat connector. `watcherConnectorInfo(watcher, botConfig, botFallbackModel)`
(pure, exported, unit-tested) derives it per type:

- `email` / `x` / `anthropic` → **always the Claude CLI** (`"Claude Code"`) on
  `config.model ?? DEFAULT_MODEL`. These checkers run via `spawnHaiku`, which
  unconditionally spawns `claude -p` and never consults the Haiku router — so the
  bot's chat connector (`claude-sdk`) / `HAIKU_BACKEND` resolution (`anthropic`)
  is irrelevant. Stamping the chat connector here (the pre-fix `setConnectorInfo`
  call) was an active lie.
- `wiki-gardener` → labelled from the **bot's own connector/model** — its draft
  (`executeOneShot`, the dominant work) runs there; the Haiku cluster is the
  minor part. `botFallbackModel` (resolved once per batch from
  `loadConfig().claudeModel`) mirrors the fallback every other `setConnectorInfo`
  caller passes.
- `news` / `wiki-linter` → `null` (no model runs, so no chip is stamped).

### Scheduler context

`startScheduler()` stores `{ api, config, botConfig }` per bot in `schedulerContexts` Map. The dashboard's trigger endpoints use `getSchedulerContext(botName)` to get these for manual runs.

### Per-watcher safety-net timeout

Each watcher's `runChecker` call is wrapped in `withWatcherTimeout` so a hung checker (stuck MCP connection, wedged subprocess) can't block the scheduler tick or starve the watchers behind it. `computeWatcherTimeoutMs(watcher)` (defined in `src/watchers/timeout.ts` alongside `TICK_TIMEOUT_MS` + `WATCHER_TIMEOUT_MARGIN_MS`; re-exported from `runner.ts` for its legacy import site, but **new importers should take it from `./timeout.ts` directly** — `checkX` needs those numbers to derive its capture budget and importing them from `runner.ts` would close an import cycle) returns `max(120_000, config.timeoutMs + 30_000)` — a 2-min floor for watchers with no configured timeout, otherwise 30s of headroom ABOVE the checker's own `config.timeoutMs` so a legitimately slow Sonnet/X digest is never cut off prematurely (the net only fires when the inner model timeout is itself stuck). On timeout the existing per-watcher catch advances `last_run_at` (retry-storm prevention), and the orphaned checker promise is swallowed so it doesn't surface as an unhandledRejection.

Due watchers now run **concurrently**: `runWatchers` fans the due list out through `Promise.allSettled(dueWatchers.map(async (watcher) => …))`. This is safe because each watcher owns its own `requestId` (`agentStatus` is per-`requestId` since the Map rework, so parallel runs don't clobber each other's progress), its own `Tracer`, and its own per-watcher timeout + catch — one slow or failing watcher can't block or skip the others. `allSettled` (not `all`) because each iteration is self-contained error-wise; a rejection must never abort the batch.

### Concurrent-duplicate guard (`claimChecker`/`releaseChecker`)

The scheduler tick races `runWatchers` against `TICK_TIMEOUT_MS` (10 min) and releases `tickRunning` when the race settles — but an orphaned checker (a 20-min gardener, a wedged MCP subprocess) keeps running past that. Because `force_next_run`/`last_run_at` only change at run **END**, the next tick re-selects the same watcher and would dispatch a **concurrent duplicate** (the seeded 20-min weekly gardener already exceeds the 10-min tick, so this is a live bug). A module-level in-flight set keyed on the watcher id — claimed BEFORE `runChecker` and released in the RAW checker promise's own `.finally` (NOT the timeout-raced one, which would free the slot while an orphan still runs) — skips the duplicate dispatch until the real work settles. **Escape hatch:** a slot older than `2 × computeWatcherTimeoutMs(watcher)` is force-reclaimed with a loud `log.error` (a never-settling checker would otherwise park that watcher until restart); the reclaim mints a fresh token, so the stale checker's late `.finally` (old token) is a no-op and can't free the new dispatch's slot.

Caveats of the parallel model:
- The **phase dial** (`agentStatus.set("running_watcher")` / `set("sending_telegram")`) is a coarse global indicator and races under parallelism — that's expected. The real per-watcher progress lives in the per-`requestId` waterfall. The dial is reset to `idle` **once** after the whole batch settles (not per-watcher), so an early finisher doesn't flip it to idle while siblings still run.
- Concurrency is **unbounded over the due set**, which is naturally small (watchers due in one tick after the interval + time-of-day filters — typically 1–5). DB writes serialize harmlessly on the pool; the parallelism win is in `runChecker` (Haiku/MCP/HTTP), which doesn't hold a DB connection. If a deployment ever has many watchers firing in the same tick (e.g. first tick after long downtime), add a small bounded-concurrency limiter here.

## Email Watcher (email.ts)

Spawns Haiku with the bot's Gmail MCP tools. The prompt has structural parts (Gmail search, JSON format) that are hardcoded, plus a configurable evaluation criteria section (`config.prompt`). Returns individual `WatcherAlert[]` per email with Gmail message IDs for dedup.

## Anthropic Watcher (anthropic.ts)

Two tiers over the Anthropic firehose, alert-only. The companion *indexing* half (Huginn `anthropic-knowledge`) already content-hash-diffs the same surfaces, so this watcher is Muninn-only.

- **Tier-1** polls the verified GitHub Atom feeds (`DEFAULT_ANTHROPIC_FEEDS`) via a small Atom parser (`parseRssItems` is RSS-2.0-only and returns 0 on Atom). Dedup by entry id (the GitHub URL) against `lastNotifiedIds`; the runner **skips content-hash dedup for `type='anthropic'`** (ids are stable canonical URLs).
- **Tier-2** (opt-in `config.tier2`) snapshot-and-diffs the feed-less surfaces — the `llms.txt` doc-URL set (**549** since Anthropic's 2026-07-21 restructure; it held ~1953 before) + `anthropic.com/{news,engineering,research}` slug sets — against the `watcher_snapshots` table (one row per source). NOT `lastNotifiedIds` (600-capped, shared with Tier-1) and NOT `config` (the dashboard's `updateWatcher` overwrites the whole blob). URLs absent from the snapshot are candidates; each source's first run records the baseline silently.
- **Haiku gate** (opt-in `config.gate`): the new candidates (Tier-1 entries + Tier-2 additions) are scored 0–1 in **one** Haiku call (`DEFAULT_ANTHROPIC_GATE_PROMPT` — weights Claude Code, agents/tools/MCP, retrieval/evals, and new models highest). Only candidates ≥ `minScore` alert, each carrying a one-line "why it matters"; the rest are tracked silently (one `silent: true` alert), so they aren't re-scored next run. The gate is what makes the high-churn commit feeds safe to enable. `config.quietMode` lets the model reply with literal `SKIP` to suppress the whole batch. On a gate error the run returns `[]` and Tier-2 snapshots are **not** advanced, so the additions re-surface and retry.
- **Body excerpt fed to the gate ("alert depth", Learning Center §10).** The gate scores off **content, not just titles**: each candidate carries an optional truncated body slice (`excerpt`, hard-capped at `MAX_EXCERPT_CHARS` = 300) fed in on its own line by `formatCandidateList(cands, { withExcerpt: true })`. Per-source at the cheapest layer: **Tier-1** captures it *for free* from the Atom `<content>`/`<summary>` during `parseAtomEntries` (commit messages / release notes); **Tier-2 docs** are enriched by a small direct `.md` fetch in `enrichDocExcerpts` (the llms.txt URLs are clean-markdown `.md` per L7 — no Huginn id-resolution and no indexing-lag miss for a brand-new doc), bounded to `MAX_DOC_EXCERPT_FETCHES` (10) with a short per-fetch timeout; **Tier-2 blogs** stay title-only (HTML listings, no cheap clean body). Degrades gracefully — no body → title-only (today's behavior), and a doc-fetch error/over-cap is best-effort (logged, never breaks the run). **Gate path only** — the digest (`formatCandidateList` default, no `withExcerpt`) stays title-only so its up-to-DIGEST_MAX_TIER1-item prompt can’t balloon.

**Cold start** (empty `lastNotifiedIds`): the Tier-1 baseline is recorded as a single silent alert and every Tier-2 snapshot is baselined — run 1 fires nothing despite the full doc set. Steady-state runs filter candidates against `lastNotifiedIds` **before** the gate, so the gate only ever sees the delta since the last run.

### Two-layer Tier-2 response guard (2026-07-27, the llms.txt wedge)

**What went wrong.** Anthropic restructured `llms.txt` on 2026-07-21, dropping ~1417 per-SDK
duplicate API-reference URLs (1953 → 549). The single anti-poison guard —
`freshUrls.length < prior.length / 2` — fired, `continue`d, and left the snapshot untouched.
It then fired on **every run since**: 53 consecutive skips across all three anthropic rows,
six days with no diff, no candidate, no digest mention, and **no surface anywhere** —
`last_run_at` kept advancing, because the *watcher* was fine. The blog leg kept working the
whole time, which is exactly what made it invisible.

> **The rule this encodes.** Any defensive skip that can persist across runs needs three
> things: a **counter** (how many consecutive times), a **bound** (after N, do something
> different), and a **surface** (somewhere a human or an alert can see it). A guard with
> none of them converts a temporary anomaly into permanent silent data loss.

**Layer A — stateless response validity (`assertValidTextResponse`, the PRIMARY defence).**
The two threat models the old guard named — a JS challenge, a truncated transfer — are
directly detectable on the response itself, with no reference to history. Before parsing,
`fetchLlmsTxtDocs`/`fetchBlogSlugs` reject a non-2xx, a non-`text/*` content type (and
`text/html` specifically for `llms.txt`), a body under a byte floor
(`LLMS_MIN_BODY_BYTES` 1 KB / `BLOG_MIN_BODY_BYTES` 512 — deliberately generous, since the
file legitimately shrank 72% once and will again), a body that parses to zero doc links,
and a truncated body. A rejection **throws**, so the existing per-source catch treats it as
a FETCH ERROR: skipped, snapshot untouched, and — load-bearing — **the Layer-B counter is
not advanced**, because a broken response is not evidence of a sustained upstream change.
Layer A alone would have let the 07-21 restructure through on day one.

⚠️ **Do NOT implement truncation as "the last line must be a markdown list item."** The real
file ends in PROSE: `For more comprehensive documentation, see [llms-full.txt](…)`. A tail-shape
check rejects every healthy fetch forever — a stateless wedge with no counter and no self-heal,
i.e. the same anti-pattern in a new place. `isTruncatedMarkup` instead looks for an
**unterminated `[…](…` fragment**, pinned by a fixture test against the real 57 KB body
(`__fixtures__/llms-txt-2026-07-27.txt`, `text/plain; charset=UTF-8`, 549 parsed URLs).

**Layer B — the ratio guard, now bounded (`shouldAcceptShrink`, pure + exported).** The
`< prior/2` test is kept as a backstop, but a *sustained, content-stable, removal-dominated*
shrink now self-heals. **All** must hold:

| Condition | Constant | Why |
|---|---|---|
| `(skips ≥ 3 && elapsed ≥ 24h) \|\| elapsed ≥ 72h` | `GUARD_MIN_SKIPS`, `GUARD_MIN_WAIT_MS`, `GUARD_MAX_WAIT_MS` | Run counts alone are cadence-blind: 3 runs is ~6h on the 2h Highlights row but **three weeks** on the 7d weekly row. The conjunction slows the fast row past a plausible upstream incident; the wall-clock ceiling is what unwedges the slow ones. |
| Consecutive samples ≥ 95% Jaccard | `GUARD_STABILITY_JACCARD` | **Content** stability, not size. Equality never fires (the live wedge drifted 541→545→548→549), and a ±10% *size* band is not a stability test at all — a cached truncated body and a challenge page are both deterministic while they last. This is why the guard record stores the previous URL **SET, not a hash**: a hash supports only equality. |
| `\|prior \ fresh\| ≥ 10 × \|fresh \ prior\|` | `GUARD_REMOVAL_DOMINANCE` | Removal-dominance, **not** strict subset. A `fresh ⊆ prior` rule is falsified by the live data — 13 additions (69 on the weekly row) existed on day one, so a subset rule would never fire and the wedge would recur unchanged. A garbage page inventing a URL space is additions-dominated and still rejected. |
| `max(prior.length, fresh.length) ≥ 100` | `GUARD_MIN_SET_SIZE` | The same guard governs `tier2:blog:*`, whose sets are 11–25 URLs; ratio reasoning at n=11 is noise, so **blog sources keep today's behavior exactly**. Gated on the MAX, so a baseline that legitimately falls under 100 doesn't lose its self-heal forever. |

⚠️ **There is deliberately NO absolute cap on additions in the accept predicate**, though the
plan drafted one (`|fresh \ prior| ≤ burstCap`). It re-creates the very wedge this guard
removes: while a source is skipped its `prior` is frozen while upstream keeps publishing, so
`added` only ever GROWS — once past the cap the predicate could never accept again, at any
skip count or elapsed time, recoverable only by hand-editing the snapshot. The live rows
accrue ~2 new URLs/day and the weekly row showed 69 in one window, so a ~2-week outage would
re-wedge the source permanently. Additions-dominated garbage is already rejected by the 10×
dominance test, and a legitimate shrink carrying many additions is bounded by the burst cap
**at the call site**, which carries the remainder instead of refusing the whole fetch.

⚠️ **`isTruncatedMarkup` runs on the llms.txt path ONLY** (`checkTruncation: true`). It is a
markdown heuristic, and the blog listings are 150–420 KB Next.js RSC payloads whose trailing
script chunk is dense with `[`/`]` inside JSON strings — measured, the last `[` sits ~30 bytes
before the last `]` on all three sections. One unbalanced bracket there would wedge the
section permanently and statelessly. It also buys nothing: `parseBlogSlugs` reads `href="…"`
and never consumes markdown links.

**Guard record** — key `` `${src.key}:guard` `` → **`tier2:llms:guard`** (`src.key` already
carries the `tier2:` prefix; `tier2:<key>:guard` would yield `tier2:tier2:llms:guard`).
Shape `{consecutiveSkips, firstSkipAt, lastSample: string[]}` (~40 KB for llms.txt, in a
table already holding 1953-element arrays). It is **diagnostic state, not baseline state**:

- Written **eagerly in `fetchTier2`** on a skip — `persistTier2` runs only after a clean
  gate/digest pass, which a skipped source never reaches.
- **Read on every run**, not just shrunken ones: a stale `consecutiveSkips: 2` surviving
  healthy runs would let the next shrink heal after one skip, defeating both bounds.
- **Cleared only where the baseline actually advances**, via a `clearGuard` flag pushed
  through `fresh` so the reset and the advance land **atomically in `persistTier2`**.
  Otherwise a gate timeout on the accepting run resets the wait and the source could never
  heal under a persistently failing gate. The flag is set only when a record exists, so a
  healthy run writes no spurious delete (this is why `anthropic.test.ts`'s exact-`setCalls`
  assertion still holds unchanged).
- The accept predicate is **re-evaluated each run rather than consumed**, so a run that
  accepts and then fails its gate simply retries.

**On accept the fetch is treated as healthy** — normal diff, candidates, `persistTier2`.
Exactly ONE persist rule applies, and it must be stated because two plausible ones collide:

> **Persist `fresh \ carried`** — the full fresh set minus any additions withheld by the
> burst cap.

Never `prior ∪ emitted` on a shrink: that keeps all 1417 removed URLs, makes the baseline
*larger*, re-trips the ratio guard next run against a baseline that can only grow, and
clears the guard record each time — **a permanent wedge reached through the fix**. Never the
intersection either (a Phase-1 re-baseline device only; it would leave the just-emitted URLs
outside the baseline so they re-diff next run).

**Candidate burst cap — `TIER2_CANDIDATE_BURST_CAP` (40), per source, GATE PATH ONLY.**
`runGate` puts every candidate into ONE uncapped Haiku prompt and a gate failure returns
*without* persisting, so an oversized batch re-forms every run — a second silent wedge. The
cap bounds one source's additions per diff; the remainder is **carried by being withheld
from the persisted snapshot**, so it re-diffs next run and drains over successive runs.
Passed into `fetchTier2` as `config.gate && !config.digest ? CAP : null`, so the digest
path's "**Tier-2 additions are NEVER capped**" invariant (its dedup IS the snapshot, so an
un-surfaced addition is lost forever) is untouched and still pinned by its test. In practice
only `e9bb5502` (Highlights) is affected.

**One-off unwedge:** `scripts/rebaseline-anthropic-llms.ts` (dry-run by default) rewrote each
row's `tier2:llms` snapshot to its own `prior ∩ fresh` — `inter ≤ fresh` always holds, so an
intersection baseline can never re-trip the guard. Per-row and never a global figure: the
rows were **not** in the same state (Highlights/Daily 1953→536 with 13 new; Weekly, already a
run behind at 1894/07-19, 1894→480 with **69** new).

### 3-row digest cadence (Phase 4)

Like the X watcher, the single Anthropic row is split into three rows that share the same sources (the GitHub feeds + Tier-2 surfaces) but differ in cadence and gate behavior. `scripts/setup-anthropic-watchers.ts` reconfigures the existing row → **Anthropic Highlights** and creates the two digest rows (idempotent — skips by name, never re-clobbers a hand-tuned Highlights config).

| Name | Schedule | mode | gate / `minScore` | `quietMode` | `model` | `lookbackDays` | Prompt |
|---|---|---|---|---|---|---|---|
| **Anthropic Highlights** | every 2h | per-item gate + capture | `gate:true`, `minScore 0.8`, `captureCandidates`, `candidateMinScore 0.5`, `autoPromoteScore 0.9` | — | Haiku | 7 | `DEFAULT_ANTHROPIC_GATE_PROMPT` (standard 0.5–1.0 scoring — so the inbox gets the middle band; alert still gates 0.8) |
| **Anthropic Daily Digest** | 24h + `hour:12` | `digest:true` | — | `true` (prompt invites `SKIP`) | Sonnet | 3 | `DEFAULT_ANTHROPIC_DAILY_PROMPT` |
| **Anthropic Weekly Digest** | 7d + `hour:18` | `digest:true` | — | `false` | Sonnet | 16 | `DEFAULT_ANTHROPIC_WEEKLY_PROMPT` |

- **Per-row snapshot windows.** `watcher_snapshots` is keyed by `(watcher_id, key)`, so each row keeps an **independent** Tier-2 baseline. A row's snapshot, advanced at the row's own cadence, *is* its window: Highlights→last-2h delta, Daily→today's additions, Weekly→the week's. (Cost: each row fetches `llms.txt` and holds its own ~1753-URL baseline when it runs — trivial; it's the mechanism, not waste. Rows rarely run in the same tick.)
- **Digest mode** (`config.digest`) rolls a window's candidates into ONE message via a single LLM call instead of per-item alerts. It **caps the Tier-1 portion at 240** (`DIGEST_MAX_TIER1` = 12 feeds × `MAX_PER_FEED` 20 — a safety rail) but **never truncates Tier-2 additions**: Tier-2 dedup is the snapshot, which `persistTier2` advances to the full set unconditionally, so an un-surfaced Tier-2 addition would be lost forever, whereas a dropped Tier-1 item re-surfaces next run via `lastNotifiedIds`. `trackingIds` = the digested set only. On an LLM error the digest returns `[]` without advancing snapshots (the window retries the next *scheduled* run — hence the widened `lookbackDays` as a retry cushion). `quietMode` lets an all-churn day reply `SKIP`.
- **Daytime window for Highlights** is the runner's quiet-hours, NOT `config.hour` — `isScheduledTimeDue` only supports a single once-per-day hour (incompatible with "every 2h"), so Highlights omits `hour` and night-suppression rides `isQuietHours` (same as X Highlights). Absent a configured quiet-hours window the row fires 24/7 every 2h (the `minScore 0.8` gate keeps that rare).
- **Gate-score calibration logging.** The gate path logs one `gate-score n=… score=… min=… surfaced=… …` line per candidate (greppable prefix `gate-score`; `score=omitted` = the model dropped it as churn). Mine the log history after a week of real output to set the final `minScore`.
- **Known structural limit:** Tier-1 is capped at `MAX_PER_FEED` (20) most-recent entries *per fetch* regardless of window, so the Weekly digest only ever sees each busy feed's last ~20 commits — older commits in the week are invisible. Acceptable because the digest is thematic ("themes + top picks"), not exhaustive.

### Config fields (JSONB)

| Field | Default | Description |
|---|---|---|
| `feeds` | `DEFAULT_ANTHROPIC_FEEDS` | Tier-1 Atom feed list (omit to track the code default) |
| `lookbackDays` | 7 | How far back to read each feed (a candidate-set bound, not the dedup key) |
| `tier2` | `false` | Enable the llms.txt + blog slug-set diff |
| `llmsTxtUrl` | `platform.claude.com/llms.txt` | Override the doc index URL |
| `blogSections` | news/engineering/research | anthropic.com listings to diff |
| `gate` | `false` | Score new candidates with Haiku (Highlights/per-item path) |
| `digest` | `false` | Roll the window's candidates into ONE digest message (Daily/Weekly path; mutually exclusive with `gate`) |
| `minScore` | 0.5 | Drop scored candidates below this 0–1 threshold (gate path) |
| `model` | Haiku (`DEFAULT_MODEL`) | Gate/digest model (digest rows use Sonnet) |
| `timeoutMs` | 90000 (code) | Model-call timeout. Set ≥150000 so it clears the runner's 120s watcher-timeout floor (the runner widens its net to `timeoutMs + 30s`). |
| `quietMode` | `false` | Allow literal `SKIP` to suppress the batch/digest |
| `hour` / `minute` | — | Time-of-day gate (Europe/Oslo) for digest rows, read by the runner's `isScheduledTimeDue` |
| `prompt` | gate/daily default | Override the gate or digest criteria |
| `captureCandidates` | `false` | Persist gated candidates into the `summary_candidates` inbox (Candidates → Summaries). Gate path only. Pair with the **standard** gate prompt (`DEFAULT_ANTHROPIC_GATE_PROMPT`) so the 0.5–0.8 middle is scored — the strict Highlights prompt only emits ≥0.8 and would leave the inbox to the alerted items. |
| `candidateMinScore` | 0.5 | Inbox capture floor — candidates scored ≥ this are queued, **independent of `minScore`** (so the relevant-but-not-urgent middle that stays silent on Telegram still lands in the inbox). |
| `candidateMinScoreByKind` | commit 0.7, release 0.8 | Per-kind capture-floor overrides keyed by URL shape (`commit` / `release` / `doc` / `blog`). Unset kinds use max(`candidateMinScore`, built-in kind default); an explicit value wins outright. Exists because Haiku scores keyword-rich GitHub churn 0.55–0.85, so one flat floor either drops good docs or keeps release stubs. Capture-only; alerts keep `minScore`. |
| `autoPromoteScore` | — (off) | Auto-summarize floor (Phase D). A captured candidate scored ≥ this is summarized **in-process** immediately — no manual click — onto the `anthropic-summaries` shelf. **Opt-in**: unset → nothing auto-promotes (the inbox just fills). Requires `captureCandidates`; deduped to rows still `new` (never re-summarizes one already summarizing/summarized). Start high (~0.9–0.95) — each one spends a real Claude call. The kick (`autoPromoteCandidate` in `src/anthropic/summarizer.ts`) resolves the summarizer bot + muninn config itself, since the watcher has neither in scope. |

State table: `watcher_snapshots(watcher_id, key, value JSONB, updated_at)` — keys `tier2:llms` and `tier2:blog:<section>`. Added in migration `046` and mirrored in `db/init.sql` (the `schema-drift.test.ts` guard requires both, identical). `seed`: `scripts/setup-anthropic-watchers.ts` reconfigures the base row → Highlights (`{tier2, gate, minScore:0.8, captureCandidates, candidateMinScore:0.5, autoPromoteScore:0.9}`, standard gate prompt) and creates the Daily/Weekly digest rows (`{tier2, digest, hour, minute, model:sonnet}`).

### Candidate capture → the Candidates → Summaries inbox (Claude Learning Center, Phase B)

The Highlights row's gate already scores + writes a "why" for every new item. With `captureCandidates: true` it also persists each candidate scored ≥ its **kind's capture floor** into **`summary_candidates`** (`src/db/summary-candidates.ts`) — a ranked, pre-annotated reading queue surfaced on `/summaries`. Two cuts on the one score: `minScore` (0.8) → Telegram alert, the capture floor → inbox.

**Shelf-capture policy (2026-07).** The inbox reuses the alert gate's score for a different question ("is a *summary of this page* worth reading?"), and Haiku scores keyword-rich GitHub churn 0.55–0.85 — so capture is source-aware, in `captureGatedCandidates` only: (1) **merge/rollup commits** (`isShelfWorthy`, title `^Merge (pull request|branch(es)|tag|…)` on a `/commit/` URL) are dropped deterministically, whatever their score — a summary of a merge diff is noise (skips log at info, since the adjacent `gate-score` line may say `surfaced=true` for the same item); (2) **per-kind floors** (`captureFloor` + `candidateKind` by URL shape): commits need ≥ 0.7, releases ≥ 0.8, docs/blog stay at `candidateMinScore`. Calibrated against real inbox rows: spec-repo churn scored 0.55–0.68 while every hand-summarized commit scored 0.7+; SDK `v0.x.y` release stubs clustered at 0.75–0.8, and the 0.8 release floor equals the seeded alert `minScore`, so **alerted ⇒ capturable** holds (a release that interrupts on Telegram always has an inbox row to summarize from). Tune per-kind via `candidateMinScoreByKind` after mining `gate-score` logs / `summary_candidates.status` — or read the **Calibration tab** on `/summaries` (display-only), which aggregates that same `summary_candidates` history into per-kind acceptance rates + a suggested `candidateMinScoreByKind` snippet (`candidateOutcomeStats` in `src/db/summary-candidates.ts`; it never writes watcher config — you hand-copy the floors). Acceptance excludes auto-`expired` and pre-051-`unknown` dismissals via the `dismissed_reason` column (migration `051`), counting only human `manual` rejections against summarized rows. Note the layering: the deterministic filter + floors are capture-only (alert logic keeps `minScore` unchanged), while the sharpened gate-prompt LOW list (merge commits, version-stub releases, follow-up corrections) intentionally shifts *scores* for both paths — the prompt is the probabilistic first line, the capture policy the deterministic backstop. Auto-promote inherits the policy for free — its dedup requires a captured row in status `new`, so a filtered candidate can never auto-summarize. So the relevant middle lands in the inbox instead of being dropped silently. Capture is best-effort (a DB error never breaks the alert path) and deduped by the table's `UNIQUE(source,url)` plus the upstream `lastNotifiedIds` filter (each item captured once; re-captures keep the max score, never resurrect a dismissed/summarized row). `status` walks new → summarizing → summarized | dismissed | error; `doc_id` links the resulting `anthropic-summaries` doc (Phase C/D). Table added in migration `047`, mirrored in `db/init.sql`.

**Hybrid curation (Phase D).** A *third* cut on the same score auto-promotes the clear headliners: with `autoPromoteScore` set (≥ ~0.9), every captured candidate at/above it is summarized **in-process right after capture** (`maybeAutoPromote` → `autoPromoteCandidate` → the shared `kickCandidateSummarize` the `/summarize` route also uses), landing on the shelf with no manual click. The mid-band (≥ `candidateMinScore`, < `autoPromoteScore`) waits in the `/summaries` inbox for a hand-pick. Auto-promote is opt-in, fire-and-forget (the slow Claude call never blocks the watcher run), and deduped to rows still `new`. The seed sets it to 0.9 on the Highlights row — but only on a fresh box, since the setup script skips reconfigure when the row already exists.

The stricter `DEFAULT_ANTHROPIC_HIGHLIGHTS_PROMPT` (≥0.8-only) remains exported as a config option for anyone who wants the original quiet-alerting calibration back — but it leaves the inbox to the alerted items only (no middle band), so it's not paired with `captureCandidates`.

## Wiki Gardener (wiki-gardener.ts + src/gardener/)

A weekly watcher that clusters recently-ingested summaries (the four
`SUMMARY_SOURCES` collections) and drafts knowledge-wiki page **proposals** into
the `wiki_proposals` table, plus a **web review gate** (`/wiki/gardener`) that
approves a draft into the wiki (muninn's first wiki write) or rejects it. The
Telegram alert (🌱) names the `/wiki/gardener` route.

Pipeline (`src/gardener/runner.ts` `runGardener`): harvest → cluster →
target-resolve → **map (pass-1)** → draft → shape-gate → persist → notify →
**(web gate) approve → apply**.

- **Harvest** (`harvest.ts`): list docs across the summary collections
  (`GET /api/collection/<c>/documents?include_dates=1`), filter to `date >= now −
  lookbackDays` (default 14) and drop the consumed set (`source_docs` of `applied`
  proposals), then fetch full bodies (batched 20). The listing gives only
  `{id,url,date}`; title/category/author are derived from the fetched body.
- **Cluster** (`cluster.ts`): one Haiku call (`callHaikuWithFallback`, `source:
  "wiki_gardener_cluster"`) with the interest profile injected augment-only.
  Output JSON clusters `{topicKey, kind, domain, label, docIds[], rationale}`.
  The prompt also inlines the **existing concept/entity page titles + aliases**
  (from the wiki index, loaded pre-cluster; source pages excluded, capped at
  500, marked as data not instructions) with a rule to reuse the canonical
  title verbatim for an already-covered topic — that exact-title label is what
  flips target-resolve to `update` instead of creating a near-synonym duplicate
  (the 2026-07-08/07-10 orphan-duplicate defect, fixed in PR #242).
  A pure skip/size/cap filter runs **before any draft call**: unknown docIds
  dropped, `docIds.length >= minClusterSize` (default 3), skip topicKeys with a
  **recently** `rejected` OR a live `draft`/`approved` proposal, cap at
  `maxProposalsPerRun` (default 3).
  - **Rejection SKIP is TTL'd (default 7 days, `GARDENER_DEFAULTS.rejectedSkipDays`
    — a bare constant, not a per-bot config field).** A rejection is a verdict on
    one draft, not a permanent verdict on the topic; before the TTL, healthy
    clusters died on week-old rejections every run. Two seams feed off the single
    rejection history: `rejectedTopicKeys()` (ALL rejections) feeds the
    **cluster-prompt hint** (`rejectedLabels` — informed re-try, so the model
    reuses a prior topicKey instead of coining a near-synonym), and
    `recentlyRejectedTopicKeys(days)` (`resolved_at > now() − rejectedSkipDays`,
    NULL `resolved_at` ⇒ expired/re-tryable) feeds ONLY the **skip set**. TTL-ing
    the hint too would be amnesia — the two are deliberately split in the runner.
    **Sub-TTL ops escape hatch** (a bad-draft rejection on a healthy topic that
    shouldn't wait out even 7 days): move the row OUT of the `rejected` status so
    it leaves the skip predicate immediately — there is deliberately no un-reject UI.
- **Target-resolve** (`target-resolve.ts`): the LOCAL wiki store
  (`getWikiIndex({root: wikiDir})`, loaded before clustering and reused) is the
  oracle — `update` on a normalized title/alias match among **same-domain
  concept/entity pages**. Same-kind matches win outright; a **cross-kind**
  match (PR #247: entity cluster titled like an existing concept page) still
  updates that page, returning a `kind` override the runner uses to re-kind
  the cluster (draft prompt + shape-gate + proposal row) — the wiki's
  classification beats the cluster model's guess. Source/analysis pages and
  cross-domain pages are never match targets (a title collision with them
  stays a `create` — nothing downstream re-checks the existing page's type
  before an update overwrites it). Otherwise `create` (huginn scores are never
  consulted).
- **Map — pass-1 doc→page mapping** (`doc-page-map.ts`, runs AFTER target-resolve,
  BEFORE the size/cap gate): whether a doc gets *clustered at all* is pass-0's roll;
  a doc that squarely belongs on an existing page shouldn't depend on it. A second
  cheap Haiku call (`callDocPageMap` seam, `source: "wiki_gardener_map"`, same
  backend + tracer as the cluster call) maps each harvest-window doc onto AT MOST
  one existing concept/entity page (candidate policy = `resolveTarget`'s; the map
  excerpt `mapExcerptOf` surfaces section HEADINGS so a multi-topic news-roundup doc
  reveals its breadth, unlike the cluster prompt's heading-stripped `excerptOf`).
  `mergeDocPageMappings` folds each valid mapping into `resolvedAll` — **the mapped
  page WINS** (a strong doc→P mapping lands on P regardless of the doc's membership in
  OTHER clusters; the old covered-skip that dropped the mapping whenever the doc sat in
  any update cluster is gone): **deduped** (the mapped page's OWN update cluster already
  contains the doc → the one true no-op), **append** (a resolvedAll update cluster
  already targets that page → add the doc, deduped), else **synthesize** a 1-doc
  update cluster (label = page title, topicKey = slug, resolved through the SAME
  `resolveTarget`; honors the same live/recently-rejected skip set as pass-0 → tallied
  `skip`). Before synthesizing, a **collision guard**: if a DIFFERENT resolvedAll
  cluster already carries the synthesized topicKey (e.g. a pass-0 create whose slug
  coincides — NOT the mapped page's own update, caught by the dedup/append above), the
  synthesis is dropped and tallied `collision` — drafting both would waste a draft call
  since the pass-1 rescue always loses to the pass-0 cluster's earlier
  `insertWikiProposal` `ON CONFLICT (COALESCE(wiki_name, bot_name), topic_key) DO NOTHING`. A doc may end up
  in both a create AND a synthesized update (no cross-mode dedup). Skipped entirely when
  the wiki has no concept/entity pages (no candidates ⇒ no call); best-effort (a
  map-call error degrades to "no mappings", never aborts the run). A `map` stage span
  carries `{mapped, synthesized, appended, deduped, collision, skip_dropped}`; one
  adjacent structured log line reports the outcome. **Known limit:** the
  synthesized/mapped update still competes in the size/cap gate
  unchanged — on a mature wiki where most single docs match an existing page, the
  weekly `maxProposalsPerRun` (3) is the binding constraint on which mapped docs
  actually draft; the backlog drain's higher cap (8) keeps more.
- **Draft** (`draft.ts`): one `executeOneShot` per cluster on the bot's connector
  (explicit `timeoutMs: 300000`, no extraDirs). Summaries are inlined as
  **untrusted** delimited data. The **shape-gate** rejects a draft unless the
  frontmatter parses with required keys, `type` matches the cluster kind, the body
  is non-empty, and `target_path` is **path-confined** (relative, `..`-free,
  inside `wikiDir` under `concepts/`/`entities/`/`life/**` matching the domain, or
  the update target's existing dir). After the gate, an **alias-hijack guard**
  (`stripOwnedAliases`, PR #246) deletes any alias an existing DIFFERENT page
  already owns as title/name/alias (kept aliases preserved raw, never
  re-encoded; update drafts keep their own page's aliases; warn-logged). The
  same strip re-runs at **apply time** against a fresh index (a canonical page
  created while the proposal awaited review still wins its aliases; the target
  path counts as self so create re-runs after a crash-after-write stay
  idempotent).
- **Phantom-source containment (PR 4).** The drafter sees only the target body +
  doc summaries, so it invents `[[source pages]]` that don't exist. Three parts:
  (a) the conventions digest tells it to list source **URLs verbatim**, prefer
  URLs over `[[source page]]` refs, and never fabricate source-page names (a
  resolved `[[ref]]` surviving guard (b) is intentional — softened, not banned);
  (b) a deterministic guard in two halves — *persist-time* `replaceUnresolvedSourceLinks`
  (`draft.ts`, run in the runner after `stripOwnedAliases`, before insert) drops
  frontmatter `sources:` entries that are unresolved `[[wikilinks]]` and appends
  the cluster's real `source_docs` URLs (same raw-preserving edit as the alias
  strip; null index ⇒ every wikilink treated as broken), and *persist-time*
  **body containment** `containBodyLinks`/`containDraftBodyLinks` (`draft.ts`, run
  in the runner after `replaceUnresolvedSourceLinks`, before insert; re-run at
  **apply time** against the fresh index for TOCTOU symmetry with the alias
  re-strip) de-links every unresolvable **body** `[[wikilink]]` to plain bold text
  — `[[Zone 2 Cardio]]` → `**Zone 2 Cardio**`, `[[X|label]]` → `**label**`. This
  is symmetric with the `sources:` guard: a wikilink is a CLAIM that a page exists,
  and only the wiki index can make that claim. Self-referential links (target ==
  the page's own title) are de-linked too (in update mode the page resolves against
  itself, but a page linking itself is never real navigation); NO `[[#Heading]]`
  anchor rewrite (the render emits no heading ids, so an anchor would be a dead
  link that only looks healthy — bold is honest); fenced ```code``` blocks + inline
  `code` spans are left verbatim. **Null index ⇒ SKIP containment** (can't tell
  resolvable from phantom; don't de-link a whole draft on an index outage — warn +
  proceed). The split/rejoin preserves frontmatter bytes verbatim (`stripFrontmatter`
  is lossy). What it de-linked is persisted on the row in the `contained_links`
  JSONB column (`{delinked: string[]}`, migration 061, nullable) and rendered on the
  review gate as a neutral informational `N links auto-de-linked` chip. The legacy
  read-time scanner `scanUnresolvedBodyLinks` (`draft.ts`) survives ONLY as the
  fallback for rows with a NULL `contained_links` (drafted before containment) —
  those still show the old amber `N unresolved links` chip; the draft's own title is
  never flagged; (c) an optional `searchRelated` seam
  (`GardenerDeps` → `SharedGardenerSeams` → `buildGardenerSeams`, one huginn
  `/api/search` per `wikiCollections` collection in brief mode / corrective off,
  merged + capped top-3) inlines a "POSSIBLY-RELATED EXISTING PAGES" block into
  the draft prompt so the model folds into / See-also's siblings instead of
  duplicating. The seam is **omitted entirely when `wikiCollections` is empty**
  (absent seam ⇒ no block, never an unscoped search) — extending the
  `SharedGardenerSeams` Pick is load-bearing (without it the optional seam never
  threads through and the feature silently no-ops). Any `searchRelated` error
  degrades to no block, never aborts the draft.
- **Persist + notify**: each proposal is persisted **as its drafting completes**
  (a mid-run timeout can't strand undrafted proposals). One alert with a
  **per-run-unique id** (`wiki-gardener:<proposal ids>`) — the runner's
  `lastNotifiedIds` dedup runs unconditionally, so a static id would drop every
  run after the first. `skipContentHash` is extended to cover `wiki-gardener`.
- **Weekly-run drop-tally snapshot (drain parity).** `checkWikiGardener` wires the
  runner's `onTally` hook (fires once after clustering, before the draft loop) and
  persists a `WeeklyGardenerRun` (`{finishedAt, clustersFound, kept, dropped,
  dropTally, evictedTopics}`) to `watcher_snapshots` key **`gardener:lastRun`** via
  the existing `setWatcherSnapshot` — DISTINCT from the drain's `backlog:lastRun`
  (`LastBacklogRun`), whose `attemptedDocs`/`fallbackDrafted` shape would collide.
  Written in a `finally` around the run (success AND throw-after-clustering — the
  tally's cluster counts are honest even if a later draft throws), best-effort so a
  snapshot write never masks the run's error. The pure builder `buildWeeklyGardenerRun`
  is exported + unit-tested. `onTally` gained a third arg (`allDropped:
  ClusterDropEntry[]`) so `evictedTopics` is the LOSSLESS structured tail
  (`{topicKey, reason, size}`), not the trace-capped 500-char topics string; the
  drain ignores the arg. Surfaced on `/wiki/gardener` via the GET's `weeklyRun` live
  field + the strip's `weeklyRunHtml` branch ("N clusters found, K kept (reason) — D
  dropped") — the cap-eviction the page previously showed nothing about.

**Review gate + apply (PR 2).** The `/wiki/gardener` dashboard page
(`src/dashboard/routes/wiki-gardener-routes.ts` + `views/wiki-gardener-page.ts` +
the bundled `wiki-gardener-browser.ts` client) lists a bot's proposals with a
rendered markdown preview (reuses `renderWikiHtml`), a current-file→draft unified
diff for `update` mode (`src/gardener/diff.ts`, dependency-free LCS line diff),
the source summaries, and Approve / Reject buttons (draft rows only). The `/wiki`
header carries a 🌱 Gardener link + pending-draft count badge.

- **Status machine** (CAS in `src/db/wiki-proposals.ts`, mirroring dev_runs):
  `draft → approved → applied | stale | error`, and `draft → rejected`. Each
  transition is `UPDATE … WHERE id=… AND status=<from>` returning the row; a lost
  race returns null → **409**. Endpoints: `POST /api/wiki/proposals/:id/{approve,
  reject}` and `GET /api/wiki/proposals?bot=<name>` (all statuses, newest first).
- **Apply** (`src/gardener/apply.ts`, DB-free + temp-dir-testable — the route owns
  the status CAS): update mode first resolves the target against the LOCAL wiki
  index (an unindexed target ⇒ `error` — the row's own path is never trusted as
  its confinement anchor) → re-run path confinement (defense in depth; reserved
  basenames `log.md`/`index.md`/`CLAUDE.md` are always rejected, also at the
  shape-gate) → staleness check (`update`: sha256(current) must equal `base_hash`;
  `create`: target must not exist — either mismatch ⇒ `stale`, no write) →
  `Bun.write` the draft → insert a `log.md` entry **after the `# Activity Log`
  header, before the first `## [`** (`## [YYYY-MM-DD] create|update | <Title>` +
  `- via wiki-gardener, N sources`, Europe/Oslo date; creates log.md if missing) →
  **WIRE STAGE** (`src/gardener/wire.ts` — stops every gardener page shipping as an
  ORPHAN: before this PR the page was written but never linked in) → refresh the
  wiki-store cache (`getWikiIndex refresh`) → fire-and-forget huginn reindex over
  the **union** of the target's collection + every collection the wire stage
  touched (each `life/**` → `wiki-life`, else `wiki`; failures warn, never fail or
  delay the apply) → mark `applied`. `stale`
  rows show an explanation and become eligible again on the next weekly run.
  - **Wire stage** (`buildIndexEntry` / `insertIndexLine` / `buildSeeAlsoEdit`,
    pure + unit-tested; best-effort **per file** — a wiring failure warns and
    continues, the page write stays source of truth): (a) inserts the page's
    `## Concepts` **index.md** bullet (`- [[Title]] — <one-liner>`, one-liner from
    rationale/first body paragraph ≤120 chars) in case-sensitive ASCII order within
    the byte-matched `### AI / Claude / Coding` (domain ai) or `### Health / Learning`
    (domain life) block — **create mode only**; **entity ⇒ skipped** (People/Orgs/
    Products isn't derivable — file manually) and a **missing `###` ⇒ skip, never
    creates a heading**; (b) adds an inbound `## See also` `[[link]]` on up to 3 of
    the proposal's **`related_pages`** that still resolve in the fresh apply-time
    index (creates the `## See also` section if absent). Both edits are idempotent
    (a `[[Title]]` already present ⇒ no-op) and **bypass the base_hash CAS**
    (additive, re-read at apply time — accepted tiny race). `related_pages` is the
    persisted output of the runner's `searchRelated` seam (`jsonb [{title, relPath?}]`,
    migration 062, nullable) — the top-3 related pages that previously only fed the
    draft prompt and were thrown away. **Both the normal write path AND the re-run/
    early-return recovery path run the wire stage** (the crashed pass may never have
    reached it). Legacy rows (`related_pages` NULL) get the index entry only. The
    review gate previews the planned wiring (index line or entity-skip note + the
    pages that will gain a See-also link) in a "Wiring on approve" card, computed
    read-time from `related_pages` + the live index (`wiki-gardener-wiring.ts`).
  (A **manual** counterpart to this fire-and-forget reindex now exists on the
  `/wiki` reader's Index card — `POST /api/wiki/reindex` fans huginn's per-collection
  `/update` over every backing collection and polls `/update-status`; see the
  wiki-routes row in `src/dashboard/CLAUDE.md`.)
- **Recovery + races**: apply is **re-run safe** (target already == draft ⇒
  `applied` without rewriting or duplicating the log entry), and the approve
  endpoint also accepts rows stuck at `approved` (crash between the approve CAS
  and the terminal CAS) — re-approving re-runs apply. Applies are **serialized per
  wiki root** (in-process single-flight), so two create proposals racing to the
  same `target_path` resolve one `applied` / one `stale`. Every terminal CAS
  result is checked — a lost CAS is surfaced as 409, never reported as success.

**Manual "Ingest backlog" drain (PR 2).** The weekly run only clusters a *recent*
window, so the all-time tail of never-ingested summaries grows unbounded (measured
by `src/wiki/ingest-backlog.ts`). The **"Drain a batch (N)"** button on
`/wiki/gardener` drains that tail through the SAME `runGardener` pipeline in bounded
batches — one click replaces a manual ingest session, every judgment call becomes a
reviewable proposal. Clicking the primary button expands an inline informed-consent
confirm panel (`[Start batch] / [Cancel]`, PR 1) — it explains that a click drains a
bounded batch of `min(batchSize, remaining)` (not all N) as a ~10–20 min background AI
job — before any POST fires. The strip renders one honest labeled sentence (total never
ingested · per-source · **eligible now** = `remaining` · **offered in past runs** =
`queued − remaining`, the offered-and-still-queued count that makes the sentence add up,
NOT the raw all-time `offered` · **drafts awaiting review** = client-side count of
`status === "draft"` proposals) from the pure `backlogStripModel` in
`views/components/wiki-gardener-strip.ts` (unit-tested, DOM-free). Mechanics live in
`src/gardener/backlog.ts`:
- **Shared constants** (`BACKLOG_BATCH_SIZE 40`, `BACKLOG_MAX_PROPOSALS 8`,
  `DRAFT_TIMEOUT_MS` — hoisted here from the checker; the weekly checker imports it
  back) so route, helper, and checker can't drift.
- **consumed-complement trick**: rather than teach `harvestDocs` an "only these ids"
  option, the run marks every listed doc EXCEPT the selected batch as consumed, so
  harvest's existing consumed-filter caps to exactly the batch; `lookbackDays` is
  `BACKLOG_LOOKBACK_DAYS` (~10y) so the window filter never drops an old doc. Huginn
  is listed ONCE per run (`assembleBacklog`) and `runGardener.listDocs` is served
  from that memoized snapshot.
- **Batch selection**: newest-first over queued docs, minus already-**offered** keys,
  capped at the batch size. Offered memory is a per-watcher `watcher_snapshots` set
  (`backlog:offered`) persisted **BEFORE** `runGardener` runs (at-most-once — a
  crashed run skips its batch rather than re-offering it and starving the tail). A
  rejected proposal's docs re-enter the queued COUNT but stay offered (never
  re-offered); recovered only by the **Reset** affordance (`backlog-reset` writes an
  empty snapshot). The `Reset offered (N)` button shows whenever `queued − remaining > 0
  && !running` (PR 1 — no longer only in the fully-drained "all offered" state), gated +
  labelled on the SAME offered-and-still-queued count as the strip so it never renders
  `Reset offered (0)`; the all-offered state keeps its "all offered / Reset to re-run"
  wording. The offered set needs the `wiki-gardener` watcher_id (the
  snapshot FK) — no row ⇒ the feature is unavailable (control hidden / 404).
- **Progress + soft cancel** (PR 2): `startBacklogRun` seeds a per-bot
  `BacklogProgress` (`getBacklogProgress`) synchronously when the mutex is acquired
  (`stage: assembling → harvesting → clustering → resolving → drafting`, plus
  `draftsDone`/`draftsTotal`/`currentTopic`) and clears it when the run settles. The
  work fn (under the mutex) threads three optional seams into `runGardener` —
  `onProgress` (writes the progress map at the same points the tracer marks),
  `shouldAbort` (reads `cancelRequested`), `onAborted` (captures the skipped keys).
  `runGardener`'s return type is unchanged (`Promise<WatcherAlert[]>`); the weekly
  checker passes none of these, so its behavior is byte-identical. `shouldAbort` is
  polled at the top of each draft iteration AND once right after clustering (so a
  cancel during harvest/cluster doesn't wait for resolve + the first draft). On abort
  the loop `break`s — already-persisted proposals are kept — and `onAborted` returns
  the not-yet-drafted clusters' docs **minus the docs of clusters that already
  produced a proposal** (clusters may share a doc). The work fn then re-persists the
  offered set = `offeredWithBatch − skippedKeys`, so exactly the cancel-prevented
  docs return to the queue while declined/never-clustered docs stay offered (at-most-
  once preserved — re-offering the ≤8 surviving-but-declined docs would starve the
  tail). `requestBacklogCancel` returns false when no run is in flight (the likely
  cancel-racing-settle case). Deliberate non-goals: no hard-abort of an in-flight
  draft (soft cancel bounds stop latency at ≤ one draft), no SSE (progress rides the
  existing 3s GET poll), no offering-after-drafting. The last-run record grows an
  optional `cancelled: {drafted, of}` field (`of` = `draftsTotal` from the last
  `onProgress`) — distinct from `error`.
- **Crash safety — run journal + recovery** (PR 3): before offering a batch the
  work fn persists a **run journal** to `watcher_snapshots` key `backlog:run`
  (`{startedAt, batchKeys}`), and the settled outcome to `backlog:lastRun` (a durable
  fallback the extended GET reads after a restart drops the in-memory `lastBacklogRuns`
  map). Journal order matters: written **BEFORE** `persistOffered` (a crash between the
  two recovers as a harmless no-op — subtracting keys never offered — whereas the
  reverse would recreate the unjournaled strand). The journal is cleared on a
  success/cancel settle but **deliberately KEPT on the error settle** — a `runGardener`
  throw (huginn 500 mid-harvest, draft-timeout escalation) strands its batch exactly
  like a process crash, so leaving `backlog:run` in place routes the errored batch
  through the same Recover/Dismiss banner (detection is `journal exists && !running`,
  which holds after an error settle too). The settle uses a two-arg `then(onFulfilled,
  onRejected)` so a clear-journal hiccup in the success path can't be miscaught as an
  error outcome. **Interrupted-run detection** (GET, outside the cache): when a journal
  exists and no run is in flight, the GET adds `interrupted: {at, batchSize, drafted}`,
  where `drafted` = journal batch keys found in the bot's proposals' `source_docs` with
  `created_at ≥ startedAt` (the shared pure `draftedKeysSince(proposals, startedAt,
  batchKeys)` scan — the **time bound is load-bearing**: `source_docs` persist on
  terminal rows, so after a Reset a re-batched doc could match an OLDER run's rejected
  proposal and be wrongly counted as drafted, hence never returned). **Recovery**:
  `backlog-recover` returns the undrafted docs (`batchKeys − draftedKeys` — the coarse
  math, chosen because a crash may predate clustering so no cluster info exists) to the
  offered pool and clears the journal; `backlog-dismiss` clears only. Both run under
  the per-bot mutex (run in flight ⇒ 409) — a stale banner's Dismiss in another tab
  must not null a live run's journal. A fresh Ingest
  **auto-recovers a pending journal in-mutex as the work fn's first step** (before
  `assemble()`), NOT as a route pre-flight — a check-then-recover in the route is the
  same lost-update TOCTOU class the reset guard documents (two near-simultaneous clicks
  can interleave a recover's offered-write between another run's offered read and its
  union persist). Under the mutex, recover and the new run's read/persist serialize by
  construction; recovered docs are newest-first candidates for the very batch being
  started, so auto-recover (vs a 409) keeps the one-click UX and is strictly safe. The
  banner's Recover/Dismiss buttons (`data-backlog-action="recover"/"dismiss"`) render
  from the pure `backlogBannerHtml` in `wiki-gardener-strip.ts`.
- **Low-volume source fallback** (R4): the drain can produce zero cluster drafts on
  THREE paths — the insufficient short-circuit (batch < `minClusterSize`, before
  `runGardener`), the harvest floor inside `runGardener` (docs < `minClusterSize` → `[]`),
  and the cluster-size gate zeroing a batch that ran. In every case the work fn falls
  back to drafting the batch docs individually as SOURCE pages (`runSourceFallback`),
  **except** when clusters DID form and pass the gate but every draft failed transiently
  (`keptClusters > 0`): the completed-path fallback is gated on `!(keptClusters > 0)` so
  cluster-worthy docs aren't permanently converted to per-doc source pages (they'd become
  pending and never re-cluster) and the strip shows the honest R1 draft-failure copy
  instead of the "(fallback — nothing clustered)" lie. `keptClusters` is undefined on the
  harvest-floor early return, so that path still falls back (the guard is `!(keptClusters
  > 0)`, not `=== 0`). The fan-out also honors a soft cancel (`shouldStop`) and drives a
  "drafting" progress stage.
  injected as the optional `draftSourceFallback` seam on `StartBacklogRunDeps` and bound
  at the route to the now-exported `draftOneBacklogDoc` (via `defaultSourceBacklogDeps`) —
  NOT bare `draftSourcePage` (needs a body+url the drain discarded) nor
  `runSourceDraftBacklog` (re-takes THIS mutex → null). `assembleBacklog` now also returns
  the selected `BacklogCandidate[]` as `batch`, so the fallback drafts from separate
  `collection`/`id` fields and never parses a `<collection>/<id>` key (slashed doc ids
  like `ai/rag/Foo.md` would corrupt a naive split). The seam fetches each body
  internally; the fan-out caps at `BACKLOG_MAX_PROPOSALS` (8) REAL model attempts (cheap
  covered/skipped don't consume the cap; a per-doc throw is contained → one bad doc never
  aborts the rest). The count is persisted as a DISTINCT `fallbackDrafted` on
  `LastBacklogRun` — never folded into `drafted` (gardener CLUSTER proposals), so the #311
  zero-draft rollback still fires (keyed on `drafted === 0`) and the fallback's drafted
  docs get credited as pending via their own proposals. The strip renders "drafted N
  source pages (fallback — nothing clustered)" (or the insufficient-path variant) when
  `fallbackDrafted > 0`.
- **Dismissed memory** (`backlog:dismissed`, PR 2 prune): a sibling snapshot set of
  `backlog:offered` with different semantics — offered means "a drain already spent a
  batch slot on this", dismissed means "a human said never select this". It is unioned
  into ALL THREE selection seams (the drain's `assembleBacklog` exclusion, the source
  drafter's `selectSourceBacklogDocs`, and the weekly harvest's `consumedDocIds` via the
  exported `weeklyConsumedWithDismissed` — the weekly path's ONLY exclusion seam, so
  without it a doc dismissed today is clustered by the very next weekly run), and it
  WINS over `offered` in the review gate's bucket partition (otherwise `Reset offered`
  would silently un-dismiss it). It is deliberately kept OUT of `assembleBacklog`'s
  returned `offeredBefore`, because the caller persists `offeredBefore ∪ batch` back to
  `backlog:offered`. Edited from the `/wiki/gardener` backlog inspector — see the
  `wiki-gardener-routes.ts` row in `src/dashboard/CLAUDE.md` for the routes, guards,
  counter layering, and the huginn DELETE proxy that pairs with it.
  **`scripts/retire-backlog-tail.ts` stays on the OFFERED set by design** (census
  semantics — "a run has accounted for this", and `Reset offered` un-retires it);
  dismissed is the never-select store that nothing resets implicitly. Folding retire
  onto the dismissed set is deferred past v1.
- **Per-bot gardener mutex** (`runExclusive`): acquired by BOTH the backlog run and
  `checkWikiGardener`. A second backlog click while running returns `{state:"running"}`;
  a weekly fire during a backlog run returns `[]` (logged) — the runner still advances
  `last_run_at`, so that week's organic run is skipped (the in-flight batch covers the
  newest docs). The inline backlog path **never** writes `last_run_at`/`force_next_run`
  and drops `runGardener`'s alerts (no Telegram — the user is at the dashboard).
- **Routes** (`wiki-gardener-routes.ts`): `POST /api/wiki/gardener/backlog-run`,
  `POST /api/wiki/gardener/backlog-cancel`, `POST /api/wiki/gardener/backlog-reset`,
  `POST /api/wiki/gardener/backlog-recover`, `POST /api/wiki/gardener/backlog-dismiss`,
  and the extended `GET /api/wiki/ingest-backlog` (adds `running`/`offered`/`remaining`/
  `lastBacklogRun`/`watcherSeeded`/`progress`/`interrupted` + the batch constants
  `batchSize`/`maxProposals` so the confirm panel never hardcodes them, merged fresh
  OUTSIDE the 5-min cache — never mutating the cached object). `BacklogRouteDeps`'
  offered read/write is generalized to per-key `getSnapshot`/`setSnapshot` (the offered
  set, run journal, and last-run all share `watcher_snapshots`), plus `listProposals`
  for the interrupted-run scan. The shared gardener seams are
  factored into `buildGardenerSeams` (exported from `wiki-gardener.ts`) so the weekly
  checker and the backlog run wire identical fetch/cluster/draft/DB seams. The client
  strip (PR 2) replaces the disabled `Running…` button with a live progress line
  ("⏳ Drafting 3/6 — *topic* · started 14:32 · 3 drafts ready below `[Cancel]`") while
  `progress` is present; a weekly run (`running` true, `progress` null) keeps the plain
  disabled `Running…`. The pure progress-line/outcome builders live in
  `views/components/wiki-gardener-strip.ts` (DOM-free, unit-tested); DOM writes stay in
  `wiki-gardener-browser.ts`.

**Config** (per-bot `config.json` `gardener` block, validated at discovery):
`{ enabled?, minClusterSize?, lookbackDays?, maxProposalsPerRun? }`. Requires the
bot to have `wikiDir` set (a missing `wikiDir` warns and returns no alerts). The
backlog run reuses `minClusterSize` but overrides `lookbackDays`/`maxProposalsPerRun`.

**Seed**: `bun scripts/setup-wiki-gardener.ts [--apply]` creates the jarvis
`wiki-gardener` row — weekly interval, `config.hour: 10` (daytime, clear of quiet
hours), `config.timeoutMs: 2700000` (net headroom for cap 8 drafts at 300s + cluster + harvest;
a timed-out run advances last_run_at and loses the week).

Schema: `wiki_proposals` (migration `057`, mirrored in `db/init.sql`; the
`contained_links` column is migration `061`, `related_pages jsonb` [apply-time
See-also wiring memory] is migration `062`); the `watchers.type` CHECK gains
`'wiki-gardener'` (migration `056`).

## Wiki Linter (wiki-linter.ts + src/wiki/lint.ts)

A weekly **report-only** sibling of the gardener that checks a bot's knowledge
wiki for hygiene issues and emits ONE summarizing Telegram alert (🧹) pointing at
`/wiki/gardener`, which hosts a **Lint findings** section. Findings are
**transient** — recomputed on demand from the wiki tree via `getWikiIndex` + the
`lintWiki` engine; there is **no DB table, no migration, and zero writes** to the
wiki or DB. v1 is purely a report.

- **Lint engine** (`src/wiki/lint.ts`): pure functions over a built `WikiIndex`
  plus per-file content reads. Each finding is `{ check, relPath, message,
  detail? }`. Four checks:
  1. **broken-link** — re-runs `extractWikilinks` + `extractMarkdownLinks` per
     page and resolves against the index (the store's builder silently drops
     unresolved targets, so resolution is recomputed here); `../`-escapes are
     external refs, not broken.
  2. **orphan** — pages with no inbound `backlinks`; reserved basenames
     (`log.md`/`index.md`/`CLAUDE.md`, same set as `src/gardener/draft.ts`) are
     skipped as subjects AND discounted as sole-linkers (an index-of-contents
     must not mask a page nothing else references). Explainers (`.html`) never
     join the graph, so they're excluded as subjects.
  3. **stale-updated** — a frontmatter page (`---` fence) missing `updated:` or
     whose `updated:` is unparseable. Plain no-frontmatter files are skipped
     (not the gardener's page shape); "older than mtime" is NOT flagged.
  4. **missing-sources** — a `concept` page that cites no sources. **Scoping
     note:** the gardener's own draft convention (`draft.ts`) uses a `sources:`
     frontmatter list + a `## See also` section, NOT a `## Sources` heading — so
     the check accepts EITHER a `## Sources` heading OR a non-empty `sources:`
     frontmatter (the conservative reading; a literal `## Sources`-only check
     would flag every gardener-written page). `entity` stubs + reserved files
     are out of scope.
- **Route**: `GET /api/wiki/linter-findings?bot=` (in `wiki-gardener-routes.ts`)
  resolves the bot's `wikiDir` like the proposals route, runs `lintWiki` on
  demand, and returns `{ findings, counts, generatedAt }`. A missing/unreadable
  wiki degrades to a 200 with an `error` field, never a 5xx. `getWikiIndex`
  already TTL-caches, so no extra cache.
- **Watcher** (`wiki-linter.ts`): skips (returns []) when `wikiDir` is unset or
  the wiki is unreadable; otherwise summarizes the counts into one `WatcherAlert`
  (`Wiki lint: 3 broken links, 2 orphans, … — review at /wiki/gardener`) with a
  per-day-stable id `wiki-lint-<YYYY-MM-DD>` (`todayOslo`). The runner's
  `skipContentHash` is extended to `wiki-linter` — the dated id dedups same-day
  re-runs, and skipping content-hash lets an identical count next week still
  notify (content-hash would false-drop a recurring report).
- **Seed**: `bun scripts/setup-wiki-linter.ts [--apply]` — weekly interval,
  `config.hour: 11` (one hour after the gardener's hour-10 slot so the two wiki
  watchers don't fire in the same tick), `config.timeoutMs: 300000` (lint is
  fast — fs + parsing). Idempotent: skips if a `wiki-linter` row already exists.
- Schema: the `watchers.type` CHECK gains `'wiki-linter'` (migration `058`,
  mirrored in `db/init.sql`).

## Wiki Committer (wiki-committer.ts)

A **daily** commit sweeper that catches wiki writes the per-write commit seam
(`src/wiki/commit.ts`) missed: manual edits outside muninn, a crashed
gardener-apply run, and writes SKIPPED because the repo was off its default
branch when they landed (the seam deliberately defers those). It exists because a
wiki repo silently accumulating uncommitted pages is one `git clean` away from
losing them (the 2026-07-23 huginn-jarvis incident).

- Per tick, for the bot's `wikiDir`: resolve the git toplevel (reusing the
  exported `gitToplevel`/`onDefaultBranch` from `commit.ts`, not reimplemented);
  **not-a-repo / off-default-branch ⇒ no-op** (a feature checkout is left for a
  later run). On the default branch, `listWikiSubtreeDirty(top, wikiDir)` runs
  `git status --porcelain -z -- <wikiDir>` (scoped to the wiki subtree, so
  unrelated repo dirt is never touched; `-z` + a `rawStdout` flag on the shared
  `git()` helper because a leading status-column space would be trimmed away and
  corrupt the first entry) and returns the dirty wiki-relative paths + the subset
  that are **deletions** (absent from disk). It commits exactly those via
  `commitWikiChange` under `[sweep] daily wiki sweep: N files` with the file list
  in the commit body (new `opts.bodyLines`), pushing per `wikiAutoCommit.push ??
  true`.
- **Deletions** are committed too: `commitInner`'s exists-on-disk filter would
  drop a removed page, so the sweeper passes them as `opts.deletions` — those
  bypass the filter and `git add -- <path>` stages the deletion (recorded as a
  `D` in the commit). No `.obsidian` exclusion — Obsidian churn is already
  gitignored in the target repo, and a blanket skip would wrongly drop
  legitimately-tracked `.obsidian` config.
- **Report-only otherwise**: emits a `WatcherAlert` (💾) ONLY when it swept
  (low urgency) or when a sweep it attempted FAILED (medium) — quiet when
  clean/off-branch/not-a-repo, matching the linter. Per-day-stable alert id
  (`wiki-sweep-<YYYY-MM-DD>`); the runner's `skipContentHash` covers it so a
  recurring daily sweep with the same summary still notifies.
- **Quiet-hours run-exempt**: the sweeper's side effect is a **git commit, not a
  user notification**, so the runner does NOT skip its run during the owner's
  quiet hours (the common overnight 22–08 window would otherwise silence an
  hour-9 sweeper forever). `wiki-committer` is in the runner's
  `QUIET_HOURS_RUN_EXEMPT` set (`isQuietHoursRunExempt`) — during quiet hours the
  checker RUNS (commits + logs activity) but its Telegram/Slack **alert send is
  suppressed** (the alert still persists in-thread + activity-logs, so the sweep
  stays auditable without an overnight ping). Every other watcher type keeps the
  original whole-run quiet-hours skip.
- **Seed**: `bun scripts/setup-wiki-committer.ts [--apply]` — daily interval
  (24h, a **1-day staleness floor** so a missed window still fires the next day)
  + `config.hour: 9` (daytime, clear of the common overnight quiet-hours window
  AND of the gardener's 10 and linter's 11 slots), `config.timeoutMs: 300000`.
  Idempotent: skips if a `wiki-committer` row exists.
- Schema: the `watchers.type` CHECK gains `'wiki-committer'` (migration `064`,
  mirrored in `db/init.sql`).

**Index-card badge.** The `/wiki` reader's Index card shows an "uncommitted
changes: N" badge when the wiki's git subtree is dirty (`wikiDirtyStat` on
`GET /api/wiki/index-coverage` — a cheap `git status` line count + the oldest
dirty file's mtime; 0 when not a git repo). Amber normally, **red** once the
oldest dirty file is > 24h old (the sweeper should have caught it); absent when
clean.

## Consolidation Gardener (consolidation-gardener.ts)

The **weekly automation leg** of the consolidation gardener. Where the Atlas
rail's **Draft synthesis** button (PR 2) is a manual, one-cluster-at-a-time
trigger, this watcher scans a wiki's semantic overlay on a weekly cadence, finds
the synthesis-CANDIDATE clusters of the wiki's OWN pages, skips clusters already
drafted/approved/applied, ranks the rest, and drafts the top `capPerRun` through
the SAME PR 2 drafter seam (`draftAndPersistSynthesis`, `src/gardener/synthesis-drafter.ts`)
into the `wiki_proposals` gate under kind `synthesis`. Unlike the concept/entity
gardener (which clusters external summary docs into concept pages) this clusters
the wiki's OWN pages into saga-style `type: blog` narrative pages under `blogs/`.

- **Config** (JSONB on the row): `config.wiki` (required — the wiki name, e.g.
  `"mimir"`), `config.threshold` (edge threshold for `computeClusters`, default
  `0.98` = the Atlas slider default), `config.capPerRun` (max real model drafts
  per run, default 2 — a small cap so a single run never floods the gate; the
  tail drains over subsequent weeks).
- **Run** (`checkConsolidationGardener`, injectable `ConsolidationGardenerDeps`
  seams so it's unit-tested without huginn/DB/model): (1) resolve the wiki via
  `findWiki`/`getWikiRegistry` — no entry / no collections ⇒ warn + skip, **no
  alert**; (2) read the wiki index; (3) fetch the semantic overlay via the SHARED
  `getSemanticOverlay` (`src/wiki/atlas-semantic.ts`, the same seam the atlas
  route + the Draft-synthesis button use) — huginn down ⇒ null ⇒ **non-sticky
  skip, no alert spam**; (4) `computeClusters` at threshold, keep only badged
  `candidate` (non-`tooBroad`) clusters; (5) **PRIMARY dedup** — skip clusters
  whose `synthesisTopicKey(label)` is in `getLiveOrAppliedTopicKeysByWiki` (the
  same live-OR-applied skip-list the button's 409 checks, so a button-drafted OR
  applied cluster is never double-proposed); (6) resolve the synthesis bot
  (`resolveWikiSynthesisBot` — mimir → jarvis via pin) for draft attribution;
  (7) `rankCandidates` (size DESC, then narrative-member SHARE, then id — pure +
  unit-tested) and draft the top `capPerRun` **sequentially** through the drafter
  seam. Never throws for a degraded external source — warns + returns `[]`.
- **Alert** (🧩): only when ≥1 proposal actually persisted, with a **per-run-unique
  id** (`consolidation-gardener:<proposal ids>`) naming `/wiki/gardener?wiki=<name>`.
  A **zero-draft run sends NO alert** (nothing to review). The runner's
  `skipContentHash` covers `consolidation-gardener` (belt-and-suspenders with the
  unique id). **NOT quiet-hours run-exempt** — it alerts a human, so a run landing
  in quiet hours is skipped whole (unlike the `wiki-committer` git-commit sweeper).
- **Telemetry**: the runner threads its `watcher:consolidation-gardener` span into
  `checkConsolidationGardener` via `telemetry.tracer`; each draft's traced one-shot
  attaches a `claude` child span under it (mirrors how `wiki-gardener` reuses the
  runner span), so runs land on `/traces` + `/agents` truthfully.
  `watcherConnectorInfo` labels the row from the **bot's own connector/model**
  (like wiki-gardener — the draft `executeOneShot` is the dominant work).
- **Seed**: `bun scripts/setup-consolidation-gardener.ts [--apply]` (default
  `WIKI=mimir`) — weekly interval, `config.hour: 10` (daytime, clear of quiet
  hours, the wiki-gardener slot), `config.timeoutMs: 1200000` (20 min net headroom
  for cap-2 drafts + overlay fetch). `bot_name` = the wiki's resolved synthesis
  bot; `user_id` = that bot's `getBotDefaultUser` mapping — a missing mapping is a
  **FAIL-LOUD** error (watchers.user_id is NOT NULL; the script refuses to insert a
  placeholder owner). Seeded **disabled** for safety (the orchestrator enables it
  at landing); idempotent (skips an existing row for the same wiki). The generic
  `POST /api/watchers/:id/trigger` route is the Run-now path (no new UI).
- **Home attention**: `src/dashboard/home-attention.ts` surfaces pending wiki-keyed
  synthesis drafts per gardener-capable standalone wiki (`countDraftWikiProposalsByWiki`)
  — bot-keyed `getDraftCounts` never sees them (they're keyed by `wiki_name`).
- Schema: the `watchers.type` CHECK gains `'consolidation-gardener'` (migration
  `066`, mirrored in `db/init.sql`).

## Configurable prompts

All watchers support `config.prompt`. Defaults are exported (`DEFAULT_X_PROMPT`, `DEFAULT_EMAIL_PROMPT`) and shown in the dashboard Details tab (labeled "(default)" when using built-in). The dashboard Edit tab pre-fills with the effective prompt.

## Configurable model

`spawnHaiku(prompt, opts)` accepts `opts.model`. Default is Haiku. Watchers pass `config.model` through. Set via dashboard Edit tab. Important: non-Haiku models (Sonnet) need higher `timeoutMs` — Haiku default is 60s.

## Tool-call visibility for Haiku-driven checkers (`spawnHaiku` telemetry)

`spawnHaiku` runs the CLI with `--output-format stream-json --verbose` and parses
it with the same `StreamParser` the chat connector uses, so a Haiku agent's tool
calls surface like a chat turn's. A missing final `result` event (the known CLI
bug) drops to a legacy single-JSON parse (`parseLegacyHaikuOutput`), mirroring
`src/ai/executor.ts`. `HaikuResult` now also carries `toolCalls`, `numTurns`, and
`costUsd` (the latter two optional — direct-SDK Haiku backends leave them unset).

`SpawnHaikuOptions` extends an optional `HaikuTelemetry` seam
(`{ onProgress?, tracer?, captureToolOutputs?, onUsage?, onModelError? }`). The runner builds it per run —
`onProgress = createProgressCallback(requestId, "running_watcher")` fills the
`/agents` Running card's tool mini-log live (and now routes `usage_progress` events
into the run's live token counts), and `tracer = wt` receives tool child
spans (`attachToolSpans`; its `parentLabel` defaults to `"claude"`, which is absent
here so the child spans fall back to the `watcher:<type>` root span) so the traces
waterfall + `getToolUsageStats` pick them up. (The optional 4th `parentLabel` arg
lets the wiki fact-check fan-out attach tool spans under indexed `claude:claim-<i>`
parents instead — the 5 non-factcheck callers keep the default and stay byte-identical.) Threaded through `runChecker` → `checkEmail` / `checkX` (both spawnHaiku sites)
/ `checkAnthropic` (→ `runGate`/`runDigest` → `callAnthropicModel`). The email
watcher's Gmail MCP calls are the primary payoff; X/anthropic gate/digest calls run
no MCP tools, so their mini-log stays empty but `numTurns`/`costUsd` populate.
`wiki-gardener` does not use `spawnHaiku`, so `onProgress`/`onUsage` never fire for
it (no tool mini-log, and — load-bearing — **no tokens on its watcher span's own
attrs**). But it IS handed the telemetry seam now for its `tracer`: `checkWikiGardener`
reuses `telemetry.tracer` (the runner's `watcher:wiki-gardener` span) as
`runGardener`'s `deps.tracer` instead of minting a second, disconnected
`wiki-gardener` root — so the stage spans (harvest/cluster/resolve/draft) and the
per-draft `claude` child span attach directly under `watcher:wiki-gardener`, one
connected `scheduler_tick → watcher:wiki-gardener → stage → claude` tree (see
"Token totals" below). Checkers invoked outside the runner keep working with the
seam absent (`tracer` undefined ⇒ every tracer call is a null-guarded no-op).

**Model-call legibility on `/traces` (#381).** `onModelError` is `onUsage`'s
failure counterpart — fired once per FAILED `spawnHaiku` call (timeout / nonzero
exit / parse error) at the single choke point in `executor.ts`, then rethrown as
before. The runner counts failures in the usage accumulator (`errors` next to
`calls`) and stamps `modelCalls`/`modelErrors` onto the `watcher:<type>` span at
finish, so a run that made no model call (quiet anthropic tick, wiki-committer
git sweep) or whose gate/digest call failed-and-was-swallowed is durably
distinguishable from missing telemetry. A `getRecentTraces` rollup lateral
(mirroring the quiet-skips one) exposes `noModelCall`/`modelErrors` on the tick
row; `fmtBackend`'s blank-cell branch renders a red `model call failed` badge
(beats the quiet-hours label) or a muted `no model call` badge instead of a
dash. The gardener types (`wiki-gardener`/`consolidation-gardener`) are
deliberately NOT stamped — their models run outside spawnHaiku (`executeOneShot`
/ `callHaikuWithFallback` never fire `onUsage`/`onModelError`), so a stamped 0
would lie; their backend surfaces via the depth-agnostic walk lateral over
their `claude` child spans, and their unstamped ticks stay an ambiguous dash.

**Token totals on `/agents` (PR3).** `onUsage` sums a checker's spawnHaiku token
usage across its (possibly multiple, for x/anthropic) calls; the runner stamps the
total + model onto the `watcher:<type>` span attributes and passes them to
`completeRequest`. Because watcher spans are **childless**, `getRecentAgentTraces`
reads `inputTokens`/`outputTokens`/`model` off the watcher span's OWN attributes
(the opposite lookup from the chat child-`claude`-span model join) → they surface
on `/agents` Recent + the completed Running card. The email watcher (~227k input
tokens/run) is the headline payoff. `spawnHaiku` also stamps the telemetry Tracer's
`traceId` onto its `haiku_usage` row (`trace_id` column, migration 060); calls
without telemetry write NULL. The gardener is a special case: its draft
(`executeOneShot`, which never calls `trackUsage`) writes a `wiki_gardener_draft`
`haiku_usage` row at the `callDraft` seam so its dominant token cost isn't lost —
surfaced via the extractor path (`getRecentExtractorUsage` allow-list, alongside
`wiki_gardener_cluster`/`wiki_gardener_triage`), NOT the trace path. The `callDraft`
seam ALSO stamps a `claude` **child** span (via `stampDraftClaudeSpan`) under the
"draft" stage span carrying the draft's model/tokens, and threads `tracer.traceId`
into both `trackUsage` calls + the cluster's `callHaikuWithFallback` so the
`wiki_gardener_cluster`/`_draft` rows join the trace (the #267 join). **This does
not double-count on `/agents` Recent** (the "never both" invariant): the draft
`claude` span is a **child of the "draft" stage span, never the root** — so
`getRecentAgentTraces`' root-child `claude` join (`cs.parent_id = t.id`) can't read
its tokens onto the watcher row — and because the gardener never fires `onUsage`,
the runner stamps **no** token attrs onto the `watcher:wiki-gardener` span itself.
The span is thus token-free on Recent; the `wiki_gardener_*` haiku rows add the
only token numbers. The trace is now a single connected tree (child spans no longer
break the "childless watcher span" assumption `getRecentAgentTraces` relies on for
token reads, precisely because those reads are OWN-attr reads the gardener leaves
unset). The manual drain mirrors this via its own `wiki-gardener-backlog` tracer
(threaded into `buildBacklogGardenerDeps` → `buildGardenerSeams`); its root isn't a
`watcher:%` span, so it never surfaces on the trace-sourced Recent at all.

## Testing

Watcher tests: `runner.test.ts` — tests dedup logic, contentHash, extractProperNouns. Checkers with mockable seams are unit-tested next to their source (`anthropic.test.ts` covers parsing, gate, digest, and the shelf-capture policy against mocked fetch/Haiku/DB; `x.test.ts` similarly). The email checker spawns Haiku with Gmail MCP and is only testable via manual trigger from the dashboard.
