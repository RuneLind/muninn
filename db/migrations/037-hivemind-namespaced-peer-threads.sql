-- Phase 4: peer thread names become `peer:<namespace>/<basename>`. Existing
-- rows are all from Phase 1+2+3 traffic on the `private` namespace, so the
-- rename is lossless. Idempotent — only matches names that don't already
-- contain a slash after `peer:`.
UPDATE threads
SET name = 'peer:private/' || substring(name from 6)
WHERE name LIKE 'peer:%'
  AND substring(name from 6) NOT LIKE '%/%';
