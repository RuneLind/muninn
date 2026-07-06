# TikTok Summarizer Extension

Chrome extension that sends TikTok videos to Muninn for AI-powered summarization —
including visual content (on-screen text, diagrams, demos), not just speech.

## What it does

1. Navigate to a TikTok video page (`/@user/video/<id>`)
2. Click the extension icon
3. Click "Summarize"
4. Muninn dashboard opens in a new tab with the summary streaming in real-time

**Paste-a-URL fallback:** in the For You feed (and other views) TikTok keeps the URL
at `/foryou`, so the content script can't read a `/video/<id>` off the path. In that
case the popup shows a URL field — paste the link to the video (canonical
`/@user/video/<id>` or a `vm.tiktok.com` / `vt.tiktok.com` share link) and click
"Summarize URL". The same field also appears under a detected video as a "Not this
video?" override, for when the feed advanced past the one you wanted.

The server downloads the video, transcribes the audio (whisper), extracts key
frames, summarizes it with Claude, categorizes it, and indexes it in the
knowledge base for later search.

## Install

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this folder (`extensions/tiktok/`)

## Settings

Click "Settings" in the extension popup, or go to the extension's options page.

| Setting | Default | Description |
|---|---|---|
| Muninn URL | `http://localhost:3010` | Dashboard server URL |

## How it works

### Content script (`content.js`)

Runs on TikTok pages. TikTok is a client-side-routed SPA that emits no navigation
event (unlike YouTube's `yt-navigate-finish`), so the script polls `location.href`
for changes and also listens for `popstate`. On each video page it extracts:
- Video ID from the URL path (`/video/<id>`)
- Canonical URL (`origin + pathname`, query/hash stripped)
- Caption/description text as the title from DOM (`data-e2e` selectors), falling
  back to `og:description` / `og:title` / `document.title`

Sends `VIDEO_PAGE` messages to the background worker on navigation.

### Popup (`popup.js`)

When clicked on a TikTok video page:
1. Asks the background worker for cached video state (`GET_STATE`)
2. Falls back to querying the content script directly (`GET_VIDEO_INFO`)
3. Shows the caption and a "Summarize" button
4. On click, sends `SUMMARIZE` to the background worker
5. Background worker POSTs to the API and opens the dashboard

When no video is detected (or as an override under a detected one), the popup shows
a URL field. A pasted link is normalized client-side (scheme added if missing,
host checked against `tiktok.com`) and sent through the same `SUMMARIZE` path; the
server resolves short links and extracts the numeric id from the URL.

### Background (`background.js`)

Caches video info per tab (used by the popup for fast access). Handles the
`SUMMARIZE` action:
1. Reads `muninnUrl` from settings
2. POSTs to `/api/tiktok/summarize` with `{ url, title }`
3. Opens the returned `dashboard_url` (falls back to `/summaries?source=tiktok&job=<id>`)

## API

The extension talks to one endpoint:

```
POST /api/tiktok/summarize
{
  url: "https://www.tiktok.com/@user/video/1234567890123456789",
  title: "Video caption text"
}
```

Response: `{ job_id, dashboard_url }` — the extension opens the dashboard URL in a new tab.
The server extracts the numeric video id from the URL itself.
