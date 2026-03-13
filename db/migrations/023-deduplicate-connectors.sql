-- Deduplicate connectors: keep one per unique (connector_type, model, base_url),
-- update threads to point to the survivor, delete the rest.

-- Step 1: For each group of duplicates, pick the one with the earliest created_at as survivor.
-- Update any threads pointing to a duplicate to point to the survivor instead.
WITH survivors AS (
  SELECT DISTINCT ON (connector_type, COALESCE(model, ''), COALESCE(base_url, ''))
    id,
    connector_type,
    COALESCE(model, '') AS model_key,
    COALESCE(base_url, '') AS url_key
  FROM connectors
  ORDER BY connector_type, COALESCE(model, ''), COALESCE(base_url, ''), created_at
),
dupes AS (
  SELECT c.id AS dupe_id, s.id AS survivor_id
  FROM connectors c
  JOIN survivors s
    ON c.connector_type = s.connector_type
   AND COALESCE(c.model, '') = s.model_key
   AND COALESCE(c.base_url, '') = s.url_key
  WHERE c.id != s.id
)
UPDATE threads t SET connector_id = d.survivor_id
FROM dupes d WHERE t.connector_id = d.dupe_id;

-- Step 2: Delete the duplicates (now unreferenced by threads)
WITH survivors AS (
  SELECT DISTINCT ON (connector_type, COALESCE(model, ''), COALESCE(base_url, ''))
    id
  FROM connectors
  ORDER BY connector_type, COALESCE(model, ''), COALESCE(base_url, ''), created_at
)
DELETE FROM connectors WHERE id NOT IN (SELECT id FROM survivors);

-- Step 3: Update names to be descriptive (type + model) instead of bot-specific
UPDATE connectors SET name = connector_type || COALESCE(' ' || model, '')
WHERE name LIKE '%-default';

-- Step 4: Add unique constraint to prevent future duplicates
CREATE UNIQUE INDEX idx_connectors_unique_config
  ON connectors (connector_type, COALESCE(model, ''), COALESCE(base_url, ''));
