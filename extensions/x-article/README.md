# X Article Summarizer Extension

Chrome extension that sends X/Twitter articles to Muninn for AI-powered summarization.

## What it does

1. Navigate to an X article page (e.g. `x.com/user/article/123...`)
2. Click the extension icon
3. Click "Summarize"
4. Muninn dashboard opens in a new tab with the summary streaming in real-time

The extension extracts the article text from the page, sends it to Muninn for summarization with Claude, categorizes it, and indexes it in the knowledge base for later search.

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

The extension talks to one endpoint:

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

Response: `{ job_id, dashboard_url }` — the extension opens the dashboard URL in a new tab.
