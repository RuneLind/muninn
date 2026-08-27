#!/bin/sh
# Container entrypoint: resolve the database URL, refuse an unprovisioned
# database, migrate, then hand PID 1 to the server.
#
# Everything here is deliberately POSIX sh (the base image is oven/bun:1-debian,
# whose /bin/sh is dash) and deliberately small — the interesting decisions live
# in db/require-provisioned.ts, which is testable.
set -eu

# (1) nais injects the Postgres credentials under a per-instance PREFIX, so the
#     platform hands us DB_URL rather than DATABASE_URL (the manifest asks for it
#     with `envVarPrefix: DB`). Adopt it only when DATABASE_URL is not already
#     set — docker-compose sets DATABASE_URL directly and must win — and only
#     when DB_URL is actually non-empty, because exporting an empty
#     DATABASE_URL would turn "no database configured" into a confusing parse
#     error several layers down.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_URL:-}" ]; then
  export DATABASE_URL="$DB_URL"
  echo "[entrypoint] DATABASE_URL adopted from DB_URL"
fi

# (2) An empty database is an OPERATOR action, not something to migrate into
#     existence — see db/require-provisioned.ts for why the predicate is the
#     `users` table and why this cannot be folded into the migration runner.
bun db/require-provisioned.ts

# (3) Pending migrations. Serialised across replicas by the runner's own
#     advisory lock, so a two-pod rollout applies each migration once.
bun db/migrate.ts

# (4) Hand over to the image's CMD (`bun run start`) — `exec`, so the server
#     becomes PID 1 and receives SIGTERM directly; without it the shell would sit
#     in front of it and the pod would be SIGKILLed at the end of its
#     termination grace period instead of shutting down. `"$@"` rather than a
#     hardcoded command so `docker run <image> <cmd>` and a compose `command:`
#     still work — but an EMPTY `$@` (a compose `command: []`, `docker run
#     --entrypoint ""`) makes `exec` a no-op that exits 0, i.e. a container that
#     migrates the database and then reports success for never having started.
if [ "$#" -eq 0 ]; then
  echo "[entrypoint] nothing to exec — the image's CMD was replaced with an empty command" >&2
  exit 1
fi
exec "$@"
