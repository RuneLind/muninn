# YouTube Summarizer Extension

Chrome extension that sends YouTube videos to Muninn for AI-powered summarization.

## What it does

1. Navigate to a YouTube video page
2. Click the extension icon
3. Tick **Slides** if you want the summary to quote what is on screen
4. Click "Summarize"
5. Muninn dashboard opens in a new tab with the summary streaming in real-time

The server fetches the transcript, summarizes it with Claude, categorizes it, and indexes it in the knowledge base for later search.

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
3. Shows the video title, a "Summarize" button and the **Slides** tick
   (remembered in `chrome.storage.sync` under `frames`, default off)
4. On click, sends `SUMMARIZE` to the background worker
5. Background worker POSTs to the API and opens the dashboard

### Background (`background.js`)

Caches video info per tab (used by the popup for fast access). Handles the `SUMMARIZE` action:
1. Reads `muninnUrl` from settings
2. POSTs to `/api/youtube/summarize` with `{ title, url, video_id, frames }`
3. Opens the dashboard YouTube page with the job ID

## API

The extension talks to one endpoint:

```
POST /api/youtube/summarize
Content-Type: application/json   (required — 415 otherwise)
{
  title: "Video Title",
  url: "https://www.youtube.com/watch?v=...",
  video_id: "dQw4w9WgXcQ",
  frames: false
}
```

Response: `{ job_id, dashboard_url }` — the extension opens the dashboard URL in a new tab.

Refusals carry a prose `error` and a machine `code` the popup renders as-is:

| Answer | Meaning |
|---|---|
| 400 `bad_video_id` | `video_id` is not 11 URL-safe base64 characters |
| 400 `bad_frames` | `frames` was sent as something other than `true`/`false` |
| 415 `bad_content_type` | the POST was not `application/json` (the extension always sends it) |
| 503 `frames_unsupported` | the summarizer bot's connector cannot read the frames |
| 200 `duplicate` | already captured — the body carries the existing document |
| 200 `in_flight` | already being captured — the body carries the running job's id |
