-- `wiki_proposals.group_key` — the id the rows of ONE lint finding share.
--
-- A lint fix touches several pages at once (a series key on every member of a
-- cluster, a label on its head), and the review gate must show that as ONE card
-- with one Accept: approving half a series is a worse state than not approving
-- it. Each page keeps its own row — its own `target_path`, its own `base_hash`,
-- its own CAS — and the rows are tied together by this column.
--
-- NULLable, and NULL on every row that existed before this migration: the
-- gardener's concept/entity/source/synthesis proposals are one page each and
-- stay single-row, with the per-row Approve/Reject unchanged.
--
-- No unique index. `topic_key` already carries the live-row uniqueness
-- (`wiki_proposals_wiki_topic_live_idx`), and a lint row's topic key is
-- `<group_key>:<relPath>`, so two rows of one group can never collide there
-- while two GROUPS cannot share a key: the group id is a sha256 prefix over the
-- check id, the sub-rule and the sorted member paths.
--
-- The partial index is for the group endpoints' one query shape — every row of
-- a group, by key — and skips the NULLs, which are the overwhelming majority.
ALTER TABLE wiki_proposals ADD COLUMN group_key TEXT;

CREATE INDEX wiki_proposals_group_key_idx
  ON wiki_proposals (group_key) WHERE group_key IS NOT NULL;
