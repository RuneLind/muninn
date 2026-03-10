#!/bin/bash
# Sync ignored config files to the private muninn-config repo.
# Usage: bun run config:sync [--commit]
#
# Files synced:
#   .env                      — environment secrets
#   bots/*/                   — bot personas, config, MCP, permissions, skills
#     (excluding reports/)      (generated research reports are skipped)
#
# The --commit flag auto-commits with a timestamped message.

set -euo pipefail

MUNINN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_REPO="$HOME/source/private/muninn-config"

if [ ! -d "$CONFIG_REPO/.git" ]; then
  echo "Error: Config repo not found at $CONFIG_REPO"
  echo "Initialize it with: mkdir -p $CONFIG_REPO && cd $CONFIG_REPO && git init"
  exit 1
fi

echo "Syncing config from $MUNINN_DIR → $CONFIG_REPO"

# Sync .env
if [ -f "$MUNINN_DIR/.env" ]; then
  cp "$MUNINN_DIR/.env" "$CONFIG_REPO/.env"
  echo "  ✓ .env"
fi

# Sync bot folders (all except jarvis which is in the main repo)
for bot_dir in "$MUNINN_DIR"/bots/*/; do
  bot_name=$(basename "$bot_dir")

  # Skip jarvis — it's tracked in the main repo
  if [ "$bot_name" = "jarvis" ]; then
    continue
  fi

  dest="$CONFIG_REPO/bots/$bot_name"
  mkdir -p "$dest"

  # Sync everything except reports/ (generated content)
  rsync -av --delete \
    --exclude 'reports/' \
    --exclude '.DS_Store' \
    "$bot_dir" "$dest/" \
    --quiet

  echo "  ✓ bots/$bot_name/"
done

# Remove bot folders from config repo that no longer exist in muninn
for config_bot_dir in "$CONFIG_REPO"/bots/*/; do
  [ -d "$config_bot_dir" ] || continue
  bot_name=$(basename "$config_bot_dir")
  if [ ! -d "$MUNINN_DIR/bots/$bot_name" ]; then
    rm -rf "$config_bot_dir"
    echo "  ✗ bots/$bot_name/ (removed — no longer exists)"
  fi
done

echo ""

# Show status
cd "$CONFIG_REPO"
if git diff --quiet --exit-code && git diff --cached --quiet --exit-code && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "No changes to commit."
  exit 0
fi

git status --short

# Auto-commit if --commit flag is passed
if [ "${1:-}" = "--commit" ]; then
  git add -A
  git commit -m "Config sync $(date +%Y-%m-%d\ %H:%M)"
  echo ""
  echo "Committed."
else
  echo ""
  echo "Run 'bun run config:sync -- --commit' to auto-commit,"
  echo "or cd $CONFIG_REPO and commit manually."
fi
