## Adding a New Bot

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `bots/<name>/config.json` (connector, model, thinking, timeout overrides)
3. Optionally add `bots/<name>/.mcp.json` and `bots/<name>/.claude/settings.json`
4. Add `TELEGRAM_BOT_TOKEN_<NAME>=...` and `TELEGRAM_ALLOWED_USER_IDS_<NAME>=...` to `.env`
5. Restart — the bot is auto-discovered

A bot is active only if its folder has a `CLAUDE.md` **and** a matching `TELEGRAM_BOT_TOKEN_<NAME>` env var. Field-by-field `config.json` semantics live in the root `CLAUDE.md`; syncing bot folders to their source-of-truth repos is `/muninn-config-sync`.
