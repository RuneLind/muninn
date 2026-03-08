# Jira Research Extension

Chrome extension that sends Jira issues to Muninn for AI-powered analysis.

## What it does

1. Navigate to a Jira issue page
2. Click the extension icon
3. Click "Send til analyse"
4. Muninn opens in a new tab with a dedicated chat thread, pre-loaded with the issue content

The bot analyzes the issue using its knowledge base and MCP tools, then you can continue chatting for follow-ups.

## Install

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this folder (`extensions/jira/`)

## Settings

Click "Settings" in the extension popup, or go to the extension's options page.

| Setting | Default | Description |
|---|---|---|
| Muninn URL | `http://localhost:3010` | Dashboard server URL |
| User ID | *(empty)* | Your Muninn user ID. Set this to skip the user picker when multiple users exist. |

## How it works

### Content script (`content.js`)

Runs on Jira pages. Extracts issue data directly from the DOM (no API needed — uses the authenticated session):
- Issue key, summary, status, type, priority, assignee, reporter
- Description and comments (converted from HTML to markdown)
- Epic link, labels, dates

### Popup (`popup.js`)

When clicked on a Jira page:
1. Asks the content script for the issue data
2. Formats it as markdown text
3. POSTs to `POST /api/research/chat` with `{ bot, title, text, userId?, forceNew? }`
4. Handles server responses:
   - **Success** — opens the returned `chatUrl` in a new tab
   - **`needsUser`** — shows a user picker (when multiple users exist and no `userId` configured)
   - **`threadExists`** — asks whether to reuse the existing thread or create a new one with a timestamp suffix
5. Opens the Muninn chat page with the thread pre-loaded

### Background (`background.js`)

Caches issue data per tab so the popup can retrieve it without re-querying the DOM.

## API

The extension talks to one endpoint:

```
POST /api/research/chat
{
  bot: "melosys",           // bot name
  title: "PROJ-123",        // thread name (issue key)
  text: "# PROJ-123: ...",  // full issue content as markdown
  userId?: "user-id",       // optional, required when multiple users exist
  forceNew?: true           // create new thread even if one with same name exists
}
```

Responses:
- `200` — `{ threadId, conversationId, chatUrl }`
- `400` — `{ needsUser: true, users: [{ id, name }] }` — pick a user
- `409` — `{ threadExists: true, existingThreadId, existingThreadName }` — thread already exists

## Supported Jira instances

The `manifest.json` `host_permissions` controls which Jira domains the extension works on. Currently set to `https://jira.adeo.no/*`. Update this for other Jira instances.
