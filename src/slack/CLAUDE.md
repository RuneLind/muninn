# Slack Integration — Architecture & Rules

> See also: skills `slack-bolt-patterns` for deeper reference.

**Debugging rule of thumb:** the four message contexts (DMs, threads, channels, Assistant API) each have different API constraints and capabilities. Check Slack app configuration settings (like the 'Agent or Assistant' toggle) as a potential root cause before writing code fixes.

## File Overview

| File | Role |
|---|---|
| `index.ts` | Bolt app setup, all four event handlers, thread tracking wiring, context fetching |
| `handler.ts` | Central message pipeline: auth → prompt → Claude → extract posts → format → send |
| `slack-format.ts` | Converts Claude markdown to Slack mrkdwn (different syntax!) |
| `cache.ts` | User-identity + channel-ID caches; `resolveSlackUser`, `resolveChannelId`, `makePostToChannel` |
| `message-fetcher.ts` | `fetchChannelMessages` / `fetchThreadMessages` — recent context for @mentions and threads |
| `registry.ts` | Global bot-name → Bolt `App` registry, used by the watcher runner for proactive posting |
| `thread-tracker.ts` | In-memory tracker of threads the bot has replied in (24h TTL) for re-tag-free follow-ups |

## Four Handler Paths

Every Slack message enters through one of four paths in `index.ts`. All four call the same `handleMessage()` from `handler.ts`, but with different parameters:

### 1. Assistant DM (`assistant.userMessage`)
- Platform: `slack_assistant`
- Triggered by: Slack's built-in Assistant sidebar DM
- `say()`: Bolt's Assistant `say` (posts in assistant thread)
- `setStatus()`: Bolt's Assistant `setStatus` (native thinking indicator)
- `postToChannel`: `makePostToChannel(app.client, tag)` — uses `app.client` (NOT destructured `client`)

### 2. @mention in channel (`app_mention`)
- Platform: `slack_channel`
- Triggered by: `@BotName` in a channel message
- `say()`: `client.chat.postMessage()` in thread
- `setStatus()`: `client.assistant.threads.setStatus()` (thinking bubble)
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context
- Side effects: tracks thread, fetches recent channel/thread messages for context

### 3. Thread follow-up (`app.message` with tracked thread)
- Platform: `slack_channel`
- Triggered by: reply in a thread where bot previously responded
- No @mention needed — thread is tracked in `activeThreads` map
- Fetches thread messages via `conversations.replies` for context
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

### 4. DM via `app.message` (channel starts with "D")
- Platform: `slack_dm`
- Triggered by: direct message NOT through Assistant sidebar
- Shows "_Tenker..._" message, then replaces with response via `chat.update()`
- `postToChannel`: `makePostToChannel(client, tag)` — `client` from event context

## Channel Context at @mention

When the bot is @mentioned, it fetches recent messages for context before responding:
- If in a thread (`event.thread_ts` exists): uses `conversations.replies` to get thread messages
- If top-level: uses `conversations.history` to get recent channel messages (last 15)
- Context is passed as `recentChannelMessages` to `handleMessage()` and appended to the system prompt

**The bot does NOT passively listen to channels.** It only responds when explicitly @mentioned or in tracked threads.

## Critical: `client` Scoping

The `client` (WebClient) is available differently depending on handler:

| Handler | `client` source |
|---|---|
| `assistant.userMessage` | **`app.client`** (closure) — NOT destructured from callback |
| `app_mention` | Destructured from event context: `({ event, client })` |
| `app.message` | Destructured from event context: `({ message, say, client })` |

**The Assistant handler does NOT provide `client` in its callback context.** Always use `app.client` there. This was the root cause of postToChannel failing in Assistant DMs.

## postToChannel Flow

When `postToChannel` is provided to `handleMessage()`:

1. Handler appends `SLACK_POST_CAPABILITY` to system prompt (tells Claude the XML syntax)
2. Claude responds with `<slack-post channel="#name">content</slack-post>` tags
3. `extractChannelPosts()` parses both complete and incomplete tags (two-pass regex)
4. Each post is sent via `postToChannel(channel, formatSlackMrkdwn(message))`
5. `makePostToChannel` resolves `#name` → channel ID via `resolveChannelId()` (cached)
6. Failed posts are appended as error messages to the DM response
7. The `<slack-post>` tags are stripped from the DM response text

**All four handlers pass `postToChannel`.** If any handler is missing it, Claude's `<slack-post>` directives get treated as regular text, stripped by `formatSlackMrkdwn`, and the content ends up in the DM instead of the target channel.

## Text Normalization

Before processing, handler.ts converts Slack's internal channel references:
- `<#C0ADMP9CYG7|bot-testing>` → `#bot-testing`
- `<#C0ADMP9CYG7>` → `#C0ADMP9CYG7` (no name available)

This matters because Claude sees `#channel-name` in the user's message and uses it in `<slack-post channel="#channel-name">`.

## Thread Tracking

In-memory `activeThreads` map with 24-hour TTL:
- Key: `"channel:threadTs"`
- Value: last activity timestamp
- Max 500 entries, auto-prunes expired
- **Lost on restart** (not persisted to DB)

## Thinking Indicators

| Path | Method | Behavior |
|---|---|---|
| Assistant DM | `setStatus("Thinking...")` | Native Slack thinking bubble |
| @mention | `assistant.threads.setStatus()` | Native Slack thinking bubble in thread |
| Thread follow-up | `assistant.threads.setStatus()` | Same as @mention |
| DM (app.message) | `chat.postMessage("_Tenker..._")` → `chat.update()` | Fake thinking message, replaced |

`assistant.threads.setStatus()` requires the Slack app to have "Agent or Assistant" enabled. Always wrap in try-catch.

## Formatting: Markdown → mrkdwn

Claude outputs markdown. Slack uses mrkdwn (different!):
- `**bold**` → `*bold*`
- `*italic*` → `_italic_` — a single `*` is BOLD in mrkdwn, so an unconverted italic word arrives looking like a second bold word
- `## heading` → `*heading*` (bold line)
- `~~strike~~` → `~strike~`
- `[text](url)` → `<url|text>`
- Code blocks and inline code preserved as-is

Four ordering rules in `renderInline` are load-bearing, all measured:

1. **The link rewrite runs BEFORE the emphasis passes.** It used to run last, which meant the emphasis passes ran over a MARKDOWN LINK's raw URL — `[docs](https://ex.com/a**b**c)` came back with a rewritten URL. (Only `[text](url)` links are protected this way; a BARE URL in prose is still in the stream for the `**bold**` and `~~strike~~` passes. The italics pass can no longer touch it — see rule 2.) Only the generated `<url|` and `>` delimiters are parked (the sentinels carry no `<`/`>`, so the trailing tag-strip leaves them); the LABEL stays in the stream, so bold/italics still render inside link text. A link whose target is not `http(s)`/`mailto` emits its label only — Slack renders a non-scheme `<…|…>` oddly.
2. **The italics pass runs BEFORE the `**x**` → `*x*` rewrite**, and its guards are not optional. Placed after, even a `(?<!\*)…(?!\*)`-guarded pattern re-reads the just-produced `*b*` and inverts the emphasis (`**b** and *i*` → `_b_ and _i_`). The pattern is compiled from `RAW_EMPHASIS_SOURCES.italic` in `src/format/markdown-core.ts` under a STRICT word-flanking rule: the opening `*` must follow start-of-line / whitespace / an opening bracket / `«` / `-`, its content must open on a letter, digit, emoji or opening punctuation and close on a letter, digit, emoji or trailing punctuation, and the closing `*` must be followed by end / whitespace / closing punctuation / `-` / `»`. A looser earlier version paired two unrelated asterisks across non-word characters and mangled paths (`/usr/…`), SQL (`SELECT *, count(*)`), regexes (`^.*$`), escaped asterisks and bare URLs.

   **The email renderer builds its rule from the same pieces, not from the same string.** It HTML-escapes *before* it emphasizes, so a quote content-edge reaches its pattern as `&quot;`; `markdown-core.ts` therefore compiles two variants from one builder — `RAW_EMPHASIS_SOURCES` (Slack, raw text) and `ESCAPED_EMPHASIS_SOURCES` (email, plus the two quote ENTITIES as content-opening edges). One home, two vocabularies, no third copy. An earlier attempt to serve both with a bare `&` in the shared edge class opened *every* entity and made `*&*`, `*<b>*` and `*<Callout>*` italicize on email while Slack left or stripped them.

   The rule is maintained against **two tables** in `src/format/markdown-all-platforms.test.ts` — must-emphasize and must-stay-inert — and a widening has to be argued against both. Its first version was strict enough to reject ordinary prose (a quoted phrase, a parenthetical, any span ending in `,` or `.`, `*C#*`), which is what the second round fixed. One deliberate flip came with it: `a (*b*) in parens` now emphasizes, because `(` had to join the allowed preceders. The third round *narrowed* it again: `"` and `'` left the allowed preceders, because an opening `*` immediately inside a quote is a quoted literal, not a delimiter — `use "*" and "*" as wildcards` and `sep='*' and end='*'` were being paired into one span. Quotes stay in the content-edge sets, so `*"quoted phrase"*` still italicizes.

   Known misses, left inert on purpose: raw-HTML-adjacent italics (`<span>*i*</span>` — the tag-strip runs after the italics pass, so the flanks are `>` and `<`); quotes inside quotes (`he said "*hi*" loudly`, the price of the round-3 narrowing, and now symmetric across both platforms rather than a silent divergence); and mixed nesting that does *not* compose into one span (`a ***b** c*`, `***a* and *b***`), which needs a real inline parser. Residual divergence, documented rather than chased: raw *tags* are handled differently on the two platforms (Slack strips, email escapes), so `*x<*` stays literal here and closes on email. One quote-shaped divergence was closed in round 4: `&quot;` is now an allowed FOLLOWER in the email variant, so `he called it ***critical***"` renders on both instead of only on Slack (a raw `"` was already a legal follower; email had escaped it before the pattern ran).

3. **`***triple***` is rewritten to `*_x_*` BEFORE both single passes**, under the SAME flanking guards. Neither single pass can see it whole: the non-greedy `\*\*(.+?)\*\*` bold pattern claims the first two stars and stops at the next two, leaving the third dangling. Its source (`RAW_EMPHASIS_SOURCES.triple`) comes from the same builder as the italics rule, because an *unguarded* triple rule re-opens the entire inert table three stars wide — `/usr/…` globs, bare URLs, `2 *** 3`, escaped stars and mid-word pairs were all mangled at three stars while the italics rule protected them at one.

   **Whatever the guarded emphasis rules reject is then parked LITERAL** (`parkLeftoverStarRuns`, called after the triple pass and before the bold pass). Guarding alone bought nothing: the rejects simply fell through to the `\*\*(.+?)\*\*` bold pass, which has no flanking guards and cannot grow any — it must keep matching `**bold**` anywhere — and mangled them just as badly, silently dropping stars. So the invariant is: **a run of 3+ asterisks is claimed by an emphasis rule, or it is literal.** `****four****` renders as itself. The argued cost is `**bold*** trailing`, which used to render bold with a stray star and is now literal; the input is malformed either way, and dropping a star the writer typed is the outcome this whole rule set exists to prevent.

4. **The two COMPOSITION shapes are matched, not parked** (round 4). `**bold *italic***` and `***italic* bold**` mix a two-star and a three-star delimiter, so no single-delimiter rule sees either whole. The `***` run in them is a *real delimiter*, and parking it — which is what rule 3 alone did — orphans the `**` at the other end. The orphan then pairs with the NEXT `**` on the line and **inverts every bold after it**; executed on `**bold with *italic*** then **second bold** and **third bold** end`, email emitted `<strong>bold with *italic*** then </strong>second bold<strong> and </strong>third bold** end` — three bolds wrong, a literal `**` leaked, and an adjoining link swallowed into the inverted span. `origin/main` and the earlier round rendered all three bolds correctly, so the park was a regression on multi-bold lines, and this shape is common in LLM-written prose (a wiki sweep over mimir + huginn-jarvis returns 20+ real lines, e.g. `**OpenAI treats it as a *tool***`).

   So `markdown-core.ts` builds two more rules from the same guard pieces (`boldThenItalic`, `italicThenBold`) and both formatters run them **before** the triple rule and the park. The full inert table is swept against each of them in isolation in `markdown-all-platforms.test.ts` — they are the widest patterns in the file, spanning two star runs each, so that sweep is the one a future widening has to survive. `**x *y***` moved out of the known-miss list as a result; `a ***b** c*` and `***a* and *b***` stay there, since they genuinely do not compose.

Also load-bearing: the trailing catch-all tag-strip excludes NUL (`/<\/?[^>\x00]+>/g`) so a tag body can never run through a placeholder sentinel — without that a `<` inside a link label swallowed the parked `>` and every character up to the next `>` in the message.

**That exclusion has a cost side, and it is the accepted half of a trade.** A tag-shaped span that *contains* a parked placeholder is no longer strippable — the sentinel inside it fails `[^>\x00]+`, so the whole span survives into the posted message instead of being removed. Measured:

| Input | Output |
|---|---|
| `plain <span> stripped` | `plain  stripped` (stripped, as before) |
| ``a <span title=`code`> b`` | ``a <span title=`code`> b`` (survives — backticked attr is a parked inline-code span) |
| `a <div data=[lab](https://x.com)> b` | `a <div data=<https://x.com\|lab>> b` (survives — the label parked link delimiters) |

This is deliberate: the alternative is the measured data-loss bug above, where a stray `<` ate real prose up to the next `>` anywhere in the message. A leaked tag is visible in a message the user reads; deleted prose is not. Pinned in `slack-format.test.ts` so a future "tidy-up" of the strip has to argue with the trade rather than rediscover it.

Telegram and web keep an older, weaker italics rule that still has the `2 * 3` defect; the four formatters' columns are pinned side by side in `src/format/markdown-all-platforms.test.ts`, which is where that divergence is documented.

## Common Pitfalls

1. **Missing `postToChannel`**: If a handler doesn't pass it, channel posting silently fails
2. **Wrong `client` reference**: Assistant handler must use `app.client`, not destructured `client`
3. **`assistant.threads.setStatus` errors**: Requires "Agent or Assistant" app setting — always try-catch
4. **Channel ID resolution**: `resolveChannelId` paginates through all channels — cached after first lookup
5. **Thread tracking lost on restart**: `activeThreads` is in-memory only
6. **Incomplete `<slack-post>` tags**: Claude may get cut off — second-pass regex handles this
