# Jira Research Extension

Chrome extension that sends Jira issues to Muninn for AI-powered analysis.

## What it does

1. Navigate to a Jira issue page
2. Click the extension icon
3. Click "Send til analyse"
4. Muninn opens in a new tab with a dedicated chat thread, pre-loaded with the issue content

The bot analyzes the issue using its knowledge base and MCP tools, then you can continue chatting for follow-ups.

### Test mode (no Jira issue)

Open the popup **off** a Jira issue page and instead of a dead end you get an editable
**testoppgave** textarea (pre-filled with a default task) plus the same user/variant/model
selectors. Click "Send testanalyse" to drive the whole loop (analyse → spec → bygg → e2e)
manually against a fake task. The default text states up front that there is no Jira issue,
so the agent builds from the description rather than trying to look it up. The synthetic
`TEST: …` thread name never matches the `[A-Z]+-\d+` issue-key pattern, so the run gets a
unique `research-<id>` key and skips the (would-be fake) Jira knowledge-base ingest.

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

Runs on Jira Cloud pages (`nav.atlassian.net`). Reads the issue from the Jira
Cloud REST API v3 (`/rest/api/3/issue/<KEY>?expand=renderedFields`) using the
user's authenticated browser session (`credentials: 'include'` — no API token).
This mirrors huginn's Playwright fetcher, which uses a logged-in browser context
solely to call the same `/rest/api/3` endpoints; the content script already runs
inside that authenticated session, so it calls REST directly.

- Issue key, summary, status, type, priority, assignee, reporter
- Description and comments (`renderedFields` HTML → markdown via `htmlToMarkdown`)
- Epic (from the issue's `parent`, the Cloud convention), labels, dates

The issue key is read from `/browse/<KEY>`, board `?selectedIssue=<KEY>`, or the
`/issues/<KEY>` route. If the REST call fails, a minimal payload (key + page
title) is sent so the flow degrades gracefully instead of dead-ending.

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

Minimal service worker that listens for content script messages to prevent "message port closed" warnings. The popup queries the content script directly via `sendToTab()`.

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

Built for **Jira Cloud** (`nav.atlassian.net`). The `manifest.json`
`host_permissions` and the content-script `matches` are both set to
`https://nav.atlassian.net/*`, and `content.js` uses the Cloud REST API v3.

NAV migrated off `jira.adeo.no` (Server/Data Center, now decommissioned) to
`nav.atlassian.net` (Cloud), so the old Server DOM-scraping path was removed
entirely. To point at another Cloud site, change the host in `manifest.json`
(both `host_permissions` and `matches`) — the REST v3 path is the same on every
`*.atlassian.net` tenant.
