#!/bin/bash
# Restore config files from the private muninn-config repo into muninn.
# Usage: bun run config:restore
#
# This copies .env and bot folders back into the muninn working directory.
# Useful when setting up on a new machine or after a fresh clone.

set -euo pipefail

MUNINN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_REPO="$HOME/source/private/muninn-config"

if [ ! -d "$CONFIG_REPO/.git" ]; then
  echo "Error: Config repo not found at $CONFIG_REPO"
  echo "Clone it first: git clone <url> $CONFIG_REPO"
  exit 1
fi

echo "Restoring config from $CONFIG_REPO → $MUNINN_DIR"

# Restore .env
if [ -f "$CONFIG_REPO/.env" ]; then
  cp "$CONFIG_REPO/.env" "$MUNINN_DIR/.env"
  echo "  ✓ .env"
fi

# Restore bot folders
for bot_dir in "$CONFIG_REPO"/bots/*/; do
  [ -d "$bot_dir" ] || continue
  bot_name=$(basename "$bot_dir")

  dest="$MUNINN_DIR/bots/$bot_name"
  mkdir -p "$dest"

  rsync -av --delete \
    --exclude '.DS_Store' \
    "$bot_dir" "$dest/" \
    --quiet

  echo "  ✓ bots/$bot_name/"
done

echo ""
echo "Done. Config restored."
