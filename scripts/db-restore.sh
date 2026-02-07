#!/bin/bash
# Restore Javrvis PostgreSQL database from backup
set -euo pipefail

BACKUP_DIR="$(dirname "$0")/../backups"
CONTAINER="javrvis-postgres"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "Error: Container '${CONTAINER}' is not running. Run 'bun run db:up' first."
  exit 1
fi

# If no argument, show available backups and use the latest
if [ -z "${1:-}" ]; then
  echo "Available backups:"
  ls -1t "$BACKUP_DIR"/javrvis_backup_*.sql 2>/dev/null | while read -r f; do
    echo "  $(basename "$f")  ($(wc -c < "$f" | tr -d ' ') bytes)"
  done
  FILEPATH=$(ls -1t "$BACKUP_DIR"/javrvis_backup_*.sql 2>/dev/null | head -1)
  if [ -z "$FILEPATH" ]; then
    echo "No backups found in backups/"
    exit 1
  fi
  echo ""
  echo "Using latest: $(basename "$FILEPATH")"
else
  FILEPATH="${BACKUP_DIR}/${1}"
  if [ ! -f "$FILEPATH" ]; then
    echo "Backup not found: $FILEPATH"
    exit 1
  fi
fi

echo ""
read -p "This will clear all tables and restore from backup. Continue? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "Truncating tables..."
docker exec -i "$CONTAINER" psql -U javrvis javrvis -c "
  DO \$\$
  DECLARE r RECORD;
  BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
  END \$\$;
"

echo "Restoring from $(basename "$FILEPATH")..."
docker exec -i "$CONTAINER" psql -U javrvis javrvis < "$FILEPATH"

echo "Restore complete."
