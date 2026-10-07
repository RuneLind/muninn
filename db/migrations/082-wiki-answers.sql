-- Answer cards (answer cards PR 2): an answer to a `<Question>` on a wiki page,
-- one row per VERSION. An edit adds `version + 1` under the same `answer_id`;
-- nothing rewrites a row except `exported_at` (the copy-out, PR 4) and
-- `redacted_at` (an admin redact, PR 5, which also empties body and choice on
-- every version). The primary key is what turns a concurrent second edit into a
-- 409: both writers read version N and insert N + 1, and one of them loses.
--
-- Keyed by the wiki NAME, the page's relPath and the question id the page
-- already uses; nothing writes the page. `question_hash` is sha256 of the
-- parsed `<Question>` body plus its choices at write time, so a later reader
-- can tell an answer to an edited question.
--
-- `author_user_id` carries no foreign key: with `MUNINN_AUTH=off` there is no
-- user (the author is `WIKI_ANSWER_OWNER`, a display name), and an answer is a
-- record of who wrote it, which a deleted user must not erase.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + constraints + index, or
-- schema-drift.test.ts reds.
CREATE TABLE IF NOT EXISTS wiki_answers (
  answer_id        UUID NOT NULL,
  version          INTEGER NOT NULL CHECK (version >= 1),
  wiki             TEXT NOT NULL,
  rel_path         TEXT NOT NULL,
  question_id      TEXT NOT NULL,
  author_user_id   TEXT,
  author_oid       TEXT,
  author_nav_ident TEXT,
  author_name      TEXT NOT NULL,
  choice           TEXT,
  body             TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 8000),
  question_hash    TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  exported_at      TIMESTAMPTZ,
  redacted_at      TIMESTAMPTZ,
  PRIMARY KEY (answer_id, version)
);

CREATE INDEX IF NOT EXISTS idx_wiki_answers_page ON wiki_answers (wiki, rel_path, question_id);
