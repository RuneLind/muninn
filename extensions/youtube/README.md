# YouTube Summarizer Extension

Chrome extension that sends YouTube videos to Muninn for AI-powered summarization.

## What it does

1. Navigate to a YouTube video page
2. Click the extension icon
3. Pick a **Kind** — what the summary should be
4. Tick **Slides** if you want the summary to quote what is on screen
5. Click "Summarize"
6. Muninn dashboard opens in a new tab with the summary streaming in real-time

The server fetches the transcript, summarizes it with Claude, categorizes it, and indexes it in the knowledge base for later search.

### Kind

The popup fills this picker from `GET /api/youtube/options`, so it offers what
your Muninn actually runs — never a fixed list. **Standard** is the default.
**Deep (opus, full thinking)** runs the bigger model with the summarizer bot's
own thinking budget instead of the capture cap, which costs several times as
much and takes noticeably longer; it is offered only where the bot's connector
can honour both halves. A bot with per-bot capture presets adds its own kinds
here.

Your choice is remembered in `chrome.storage.sync` under `summaryKind` and is
re-checked against the server every time the popup opens: a kind your Muninn no
longer offers falls back to the default rather than failing on click. If the
options cannot be read, the popup says
"Could not reach Muninn options — Standard only." and offers Standard alone.

### Slides

Off by default. With it on, Muninn also downloads a video-only 720p rendition,
pulls one frame per cadence tick — roughly one every 20 s on a 10-minute video,
one every ~40 s from there to 40 minutes, and one every ~180 s at the 3-hour cap
— hands them to the model and lets the
summary quote a slide **in place** where it shows something the transcript does
not say (a diagram, code, a table). It adds a download and a few minutes to the
capture, and the transcript is stored under `## Transcript` with `[HH:MM:SS]`
windows so a search hit cites to the minute.

It is refused with a sentence rather than silently skipped: a summarizer bot
whose connector cannot read files answers 503 and the popup says so. Videos
under a minute skip frames (there is nothing on screen a one-minute clip's
transcript does not already carry); the cap is 3 hours.

## Install

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this folder (`extensions/youtube/`)

## Settings

Click "Settings" in the extension popup, or go to the extension's options page.

| Setting | Default | Description |
|---|---|---|
| Muninn URL | `http://localhost:3010` | Dashboard server URL |

## How it works

### Content script (`content.js`)

Runs on YouTube pages. Detects video navigation (including YouTube's SPA transitions via `yt-navigate-finish`) and extracts:
- Video ID from URL params
- Video title from DOM (tries multiple selectors for YouTube's varying markup)

Sends `VIDEO_PAGE` messages to the background worker on navigation.

### Popup (`popup.js`)

When clicked on a YouTube video page:
1. Asks the background worker for cached video state (`GET_STATE`)
2. Falls back to querying the content script directly (`GET_VIDEO_INFO`)
3. Asks the worker for `GET_OPTIONS` and renders the **Kind** picker plus the
   **Slides** tick from the answer, restoring the remembered choices against it
   (`summaryKind` and `frames` in `chrome.storage.sync`)
4. Shows the video title and a "Summarize" button
5. On click, sends `SUMMARIZE` to the background worker
6. Background worker POSTs to the API and opens the dashboard

Loaded as a module: it imports `capture-rules.js`, the rules module the Muninn
repo tests (see **Building** below).

### Background (`background.js`)

Caches video info per tab (used by the popup for fast access). Handles two actions:

`GET_OPTIONS` — GETs `/api/youtube/options` and returns the payload, or
`{error}` so the popup can fall back to Standard.

`SUMMARIZE`:
1. Reads `muninnUrl` from settings
2. POSTs to `/api/youtube/summarize` with `{ title, url, video_id, kind, frames }`
3. Opens the dashboard YouTube page with the job ID

Declared `"type": "module"` in the manifest, since it imports `capture-rules.js`.

## Building

`capture-rules.js` is generated — do not edit it. It is bundled from
`src/youtube/extension-options-rules.ts` in the Muninn repo:

```bash
bun run build:extension
```

Run that after changing the rules module and commit the result; a repo test
rebuilds it and fails when the checked-in copy is stale.

## Manual checks

Nothing in this folder has an automated harness, so after changing the popup,
the worker or the manifest, reload the unpacked extension and confirm:

- **the service worker registers with no error.** On `chrome://extensions`, the
  card shows "service worker" with no red "Errors" badge — the worker is declared
  `"type": "module"` and imports `capture-rules.js`, so a bad path or a syntax
  error there kills every action the popup can take, silently
- the popup populates on a fresh load — the video title, the **Kind** picker and
  the **Slides** tick all appear
- a chosen kind and tick survive closing and reopening the popup
- pointing **Muninn URL** at a port with nothing on it shows
  "Could not reach Muninn options — Standard only." and still offers Standard
- **pointing it at a host that HANGS**, which is a different failure from a
  refused port: use an address that accepts the connection and never answers
  (`http://10.255.255.1:3010`, or a tailnet host that is offline). That address
  is outside the `host_permissions` the manifest grants (`localhost:3010` only),
  which does not spoil the check: CORS is enforced on the RESPONSE, and there is
  none — the fetch hangs until the worker's timeout, exactly as a granted host
  that never answers would. A real capture still needs a granted host. Within a
  few seconds the popup must show the same "Could not reach Muninn options" line,
  **Summarize** must go from disabled to enabled when it does — and **Settings**
  must be clickable the whole time, since that is the only control that can fix
  the URL
- **on a summarizer bot whose connector cannot read frames** (a `copilot-sdk`
  bot), the **Slides** tick renders dimmed with the line "Slides are off: this
  Muninn's summarizer bot uses a connector that cannot read frames." — and
  **Deep** is absent from the **Kind** picker on that bot
- **remembering a kind this Muninn no longer offers**: pick Deep on a bot that
  offers it, then point **Muninn URL** at one that does not. The picker falls
  back and says so ("…is not offered here — using Standard.")
- **on a tab that is not a YouTube video**, the popup shows only "Navigate to a
  YouTube video…" — no picker, and no note about one

## API

The extension talks to two endpoints. First, the picker:

```
GET /api/youtube/options
→ { kinds: [{ id, label }, …], default_kind, frames: { supported } }
```

Then the capture:

```
POST /api/youtube/summarize
Content-Type: application/json   (required — 415 otherwise)
{
  title: "Video Title",
  url: "https://www.youtube.com/watch?v=...",
  video_id: "dQw4w9WgXcQ",
  kind: "standard",
  frames: false
}
```

Response: `{ job_id, dashboard_url }` — the extension opens the dashboard URL in a new tab.

Refusals carry a prose `error` and a machine `code` the popup renders as-is:

| Answer | Meaning |
|---|---|
| 400 `bad_video_id` | `video_id` is not 11 URL-safe base64 characters |
| 400 `bad_frames` | `frames` was sent as something other than `true`/`false` |
| 400 `bad_kind` | `kind` is not one of the kinds this Muninn offers |
| 415 `bad_content_type` | the POST was not `application/json` (the extension always sends it) |
| 503 `frames_unsupported` | the summarizer bot's connector cannot read the frames |
| 200 `duplicate` | already captured — the body carries the existing document |
| 200 `in_flight` | already being captured — the body carries the running job's id |
