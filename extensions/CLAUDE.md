# Extensions

Chrome extensions that act as clients to the Muninn dashboard API. Each subfolder is a standalone Chrome extension (load via `chrome://extensions` → "Load unpacked").

## Structure

```
extensions/
├── CLAUDE.md         ← this file
├── jira/             ← Jira issue → research chat
│   └── README.md     ← per-extension docs
└── youtube/          ← YouTube video → summarize
    └── README.md
```

## Shared conventions

### Settings storage

All extensions use `chrome.storage.sync` with `muninnUrl` as the key for the dashboard URL:

```javascript
const DEFAULTS = {
  muninnUrl: 'http://localhost:3010',
};
const settings = await chrome.storage.sync.get(DEFAULTS);
```

Never use `javrvisUrl` (legacy name). The settings key and the HTML element ID must match.

### Options page

Every extension has an options page with at least a "Muninn URL" field. Use the label "Muninn URL", not "Server URL" or "Dashboard URL".

### No build step

Extensions are vanilla JS — no TypeScript, no bundler. Load directly from the folder in Chrome dev mode. Keep them simple.

### API calls

Extensions call Muninn dashboard endpoints (defined in `src/dashboard/routes.ts`). The `host_permissions` in `manifest.json` must include the Muninn URL pattern (default `http://localhost:3010/*`).

### Error handling

Show errors in a status element in the popup. Never silently fail — the user needs to know what went wrong.

## Adding a new extension

1. Create `extensions/<name>/` with the standard Chrome extension files
2. Use `muninnUrl` for the dashboard URL setting
3. Add a `README.md` documenting installation, settings, and the API endpoint(s) used
4. Add `host_permissions` for both the target site and `http://localhost:3010/*`
