#!/bin/bash
# Backup Muninn PostgreSQL database
set -euo pipefail

BACKUP_DIR="$(dirname "$0")/../backups"
mkdir -p "$BACKUP_DIR"

CONTAINER="muninn-postgres"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Error: Container '${CONTAINER}' is not running. Run 'bun run db:up' first."
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="muninn_backup_${TIMESTAMP}.sql"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

echo "Backing up from container: ${CONTAINER}"
docker exec "$CONTAINER" pg_dump -U muninn \
  --no-owner \
  --no-privileges \
  --schema=public \
  --data-only \
  muninn > "$FILEPATH"

SIZE=$(wc -c < "$FILEPATH" | tr -d ' ')
echo "Backup saved: backups/${FILENAME} (${SIZE} bytes)"

# Keep only the 10 most recent backups
cd "$BACKUP_DIR"
ls -t muninn_backup_*.sql 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true
echo "Done."
