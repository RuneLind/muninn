## Adding a New Bot

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `bots/<name>/config.json` (connector, model, thinking, timeout overrides)
3. Optionally add `bots/<name>/.mcp.json` and `bots/<name>/.claude/settings.json`
4. Add platform tokens to `.env`: `TELEGRAM_BOT_TOKEN_<NAME>` + `TELEGRAM_ALLOWED_USER_IDS_<NAME>` for Telegram, and/or `SLACK_BOT_TOKEN_<NAME>` + `SLACK_APP_TOKEN_<NAME>` (+ `SLACK_ALLOWED_USER_IDS_<NAME>`) for Slack
5. Restart — the bot is auto-discovered

A bot is active only if its folder has a `CLAUDE.md` **and** tokens for at least one platform: `TELEGRAM_BOT_TOKEN_<NAME>`, or both `SLACK_BOT_TOKEN_<NAME>` and `SLACK_APP_TOKEN_<NAME>`. Field-by-field `config.json` semantics live in the root `CLAUDE.md`; syncing bot folders to their source-of-truth repos is `/muninn-config-sync`.
