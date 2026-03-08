# YouTube Summarizer Extension

Chrome extension that sends YouTube videos to Muninn for AI-powered summarization.

## What it does

1. Navigate to a YouTube video page
2. Click the extension icon
3. Click "Summarize"
4. Muninn dashboard opens in a new tab with the summary streaming in real-time

The server fetches the transcript, summarizes it with Claude, categorizes it, and indexes it in the knowledge base for later search.

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
3. Shows the video title and a "Summarize" button
4. On click, sends `SUMMARIZE` to the background worker
5. Background worker POSTs to the API and opens the dashboard

### Background (`background.js`)

Caches video info per tab (used by the popup for fast access). Handles the `SUMMARIZE` action:
1. Reads `muninnUrl` from settings
2. POSTs to `/api/youtube/summarize` with `{ title, url, video_id }`
3. Opens the dashboard YouTube page with the job ID

## API

The extension talks to one endpoint:

```
POST /api/youtube/summarize
{
  title: "Video Title",
  url: "https://www.youtube.com/watch?v=...",
  video_id: "dQw4w9WgXcQ"
}
```

Response: `{ job_id, dashboard_url }` — the extension opens the dashboard URL in a new tab.
