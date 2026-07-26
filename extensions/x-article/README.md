# X Article Summarizer Extension

Chrome extension that sends X/Twitter articles **and video posts** to Muninn for AI-powered summarization.

## What it does

**Articles:**
1. Navigate to an X article page (e.g. `x.com/user/article/123...`)
2. Click the extension icon
3. Click "Summarize"
4. Muninn dashboard opens in a new tab with the summary streaming in real-time

The extension extracts the article text from the page, sends it to Muninn for summarization with Claude, categorizes it, and indexes it in the knowledge base for later search.

**Videos:**
1. Open a tweet that contains a video (e.g. `x.com/user/status/123...` — clicking the video works too, that just adds `/video/1` to the URL)
2. Click the extension icon — it detects the video player and shows "Summarize video"
3. Click it — Muninn downloads the video server-side (yt-dlp), transcribes the audio (whisper), extracts keyframes, and Claude summarizes both speech and visuals

Video summaries land in the same X shelf (`/summaries?source=x-article`) as articles, deduped per tweet. Max video length 3 hours; requires `yt-dlp` on the server's PATH.

## Install

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this folder (`extensions/x-article/`)

## Settings

Click "Settings" in the extension popup, or go to the extension's options page.

| Setting | Default | Description |
|---|---|---|
| Muninn URL | `http://localhost:3010` | Dashboard server URL |

## How it works

### Content script (`content.js`)

Runs on X/Twitter pages. Detects article navigation (including SPA transitions via MutationObserver) and extracts:
- Article ID from URL
- Author handle from URL
- Article title from DOM headings or page title
- Full article text from rendered DOM (multiple extraction strategies for robustness)

### Popup (`popup.js`)

When clicked on an X article page:
1. Queries the content script for article info (`GET_ARTICLE_INFO`)
2. Shows the article title, author, and content extraction status
3. On click, sends `SUMMARIZE` to the background worker with the full article text
4. Background worker POSTs to the API and opens the dashboard

### Background (`background.js`)

Caches article info per tab. Handles the `SUMMARIZE` action:
1. Reads `muninnUrl` from settings
2. POSTs to `/api/x-articles/summarize` with `{ title, url, article_id, author, article_text }`
3. Opens the dashboard X articles page with the job ID

## API

The extension talks to two endpoints:

```
POST /api/x-articles/summarize
{
  title: "Article Title",
  url: "https://x.com/user/article/123...",
  article_id: "123...",
  author: "username",
  article_text: "Full extracted article text..."
}
```

```
POST /api/x-articles/summarize-video
{
  title: "Tweet title (page title)",
  url: "https://x.com/user/status/123..."
}
```

Response for both: `{ job_id, dashboard_url }` — the extension opens the dashboard URL in a new tab. The video endpoint may instead return `{ duplicate: true, dashboard_url }` when the tweet was already summarized; the dashboard URL then shows the existing summary.
