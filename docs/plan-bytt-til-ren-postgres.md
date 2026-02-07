# Plan: Bytt fra Supabase til ren PostgreSQL

## Bakgrunn

Supabase kjører **12 Docker-containere** (Studio, Auth, Storage, Realtime, REST, Kong, etc.)
men vi bruker kun **PostgreSQL + pgvector**. Ingen Supabase-klient i koden — alt går via
`postgres` npm-pakken direkte.

## Portoversikt (unngå konflikter)

| Port | Brukes av |
|------|-----------|
| 5432 | melosys postgres |
| 5433 | melosys postgres_felleskodeverk |
| **5434** | **← Javrvis (ny)** |
| 54322 | Supabase (fjernes) |

## Steg

### 1. Lag `docker-compose.yml` i prosjektet

Én container: `pgvector/pgvector:pg17` med named volume for persistent data.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: javrvis-postgres
    ports:
      - "5434:5432"
    environment:
      POSTGRES_USER: javrvis
      POSTGRES_PASSWORD: javrvis
      POSTGRES_DB: javrvis
    volumes:
      - javrvis-pgdata:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U javrvis"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  javrvis-pgdata:
```

Fordeler:
- Én container i stedet for 12
- Named volume `javrvis-pgdata` overlever `docker compose down` (bare `down -v` sletter den)
- Init-script kjøres automatisk ved første oppstart

### 2. Konsolider migrasjoner til `db/init.sql`

Slå sammen de 5 migrasjonene til én init-fil:

- `00001_initial_schema.sql` — tabeller: messages, activity_log, memories
- `00002_add_pgvector.sql` — `CREATE EXTENSION vector` + embedding-kolonne
- `00003_add_activity_metadata.sql` — metadata på activity_log
- `00004_goals.sql` — goals-tabell
- `00005_scheduled_tasks.sql` — scheduled_tasks-tabell

Disse konkateneres til `db/init.sql` som Docker kjører ved første `up`.

### 3. Oppdater `.env`

```diff
- DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
+ DATABASE_URL=postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis
```

### 4. Oppdater backup/restore-skript

Endre container-søk fra `supabase_db_` til `javrvis-postgres`:

```bash
# backup: enklere — kjent containernavn
CONTAINER="javrvis-postgres"

# restore: bruk docker exec i stedet for supabase db reset
```

### 5. Oppdater npm-scripts i `package.json`

```diff
  "scripts": {
+   "db:up": "docker compose up -d",
+   "db:down": "docker compose down",
    "db:backup": "bash scripts/db-backup.sh",
    "db:restore": "bash scripts/db-restore.sh",
  }
```

### 6. Fjern Supabase

- Slett `supabase/`-mappen (config, migrations, .gitignore)
- Fjern eventuell `supabase`-dependency
- Stopp Supabase: `supabase stop`

### 7. Oppdater dokumentasjon

- `CLAUDE.md`: Bytt `supabase start` → `bun run db:up`, oppdater DB-info
- Fjern referanser til Supabase overalt

## Migreringssti (bevare eksisterende data)

1. `bun run db:backup` (ta backup av nåværende data)
2. `supabase stop` (stopp Supabase)
3. Legg inn ny `docker-compose.yml` og `db/init.sql`
4. `bun run db:up` (start ny Postgres)
5. `bun run db:restore` (restore backup inn i ny DB)
6. Verifiser at `bun run dev` fungerer

## Endrede filer

| Fil | Endring |
|-----|---------|
| `docker-compose.yml` | **Ny** — én Postgres-container |
| `db/init.sql` | **Ny** — konsoliderte migrasjoner |
| `.env` | Oppdater DATABASE_URL |
| `scripts/db-backup.sh` | Ny containernavn |
| `scripts/db-restore.sh` | Ny containernavn, fjern supabase-avhengighet |
| `package.json` | Legg til `db:up`, `db:down` |
| `CLAUDE.md` | Oppdater DB-seksjon |
| `supabase/` | **Slett** |

## Kode som IKKE endres

- `src/db/client.ts` — bruker allerede `postgres` npm-pakken med connection string fra env
- All annen kode i `src/` — null endringer nødvendig

## Risiko

- **Lav**: Eneste reelle endring er connection string. All kode er database-agnostisk.
- Named volume betyr at data overlever `docker compose down` (men ikke `down -v`).
- Backup-scriptet vi allerede har sikrer mot tap.
