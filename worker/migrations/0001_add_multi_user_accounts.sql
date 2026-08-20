CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  slug       TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE INDEX idx_collections_user ON collections(user_id);

ALTER TABLE people ADD COLUMN user_id TEXT;
CREATE INDEX idx_people_user ON people(user_id);
CREATE INDEX idx_people_user_collection ON people(user_id, collection);
