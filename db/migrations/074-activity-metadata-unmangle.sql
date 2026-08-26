-- Backfill for pre-fix rows where saveActivity stored metadata as a JSON-STRING inside JSONB.
--
-- `saveActivity` passed `JSON.stringify(metadata)` as a jsonb parameter, so the value was
-- encoded a second time on its way into the column and every row held a JSON *string* scalar
-- rather than the object. Every `metadata->>'key'` read therefore matched nothing —
-- `getActivityForJob`'s `watcherId` lookup, and the `metadata->>'audit'` query
-- `src/auth/audit.ts` documents as the way to find an admin-audit row. The write side is
-- fixed (`sql.json(...)`); this is the history.
--
-- `#>> '{}'` extracts the inner unquoted text from the JSONB string, which is then parsed
-- back into proper JSONB. (A plain `::text::jsonb` cast is a NO-OP here: it preserves the
-- JSONB string type instead of unwrapping it.) Same shape as migration 033, which did this
-- for `watchers.config`.
--
-- ⚠️ ROW BY ROW, with a per-row exception handler, and that is the whole reason this is a
-- DO block rather than migration 033's one-line UPDATE: the inner text is not guaranteed to
-- be valid JSON. `metadata` is written from arbitrary call-site objects and a single row whose
-- payload does not re-parse would abort the entire statement — and, since the runner applies a
-- migration as one unit, the entire migration, permanently, for every instance carrying that
-- row. An unparseable row is left exactly as it is: still a string scalar, still readable by
-- the parse-on-read fallback, and no worse off than before this file existed.
--
-- Data-only. Nothing here belongs in `db/init.sql` — the drift guard diffs STRUCTURE, and a
-- fresh database has no pre-fix rows to repair.
DO $$
DECLARE
  r          RECORD;
  repaired   INT := 0;
  unparsable INT := 0;
BEGIN
  FOR r IN
    SELECT id, metadata #>> '{}' AS raw
      FROM activity_log
     WHERE jsonb_typeof(metadata) = 'string'
  LOOP
    BEGIN
      UPDATE activity_log SET metadata = r.raw::jsonb WHERE id = r.id;
      repaired := repaired + 1;
    EXCEPTION WHEN others THEN
      -- Not valid JSON. Leave the row untouched rather than failing the migration.
      unparsable := unparsable + 1;
    END;
  END LOOP;
  RAISE NOTICE 'activity_log metadata backfill: % row(s) repaired, % left as-is (not valid JSON)',
    repaired, unparsable;
END $$;
