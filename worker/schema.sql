-- Local/dev bootstrap only. Production schema evolves via worker/migrations/*.sql
-- (applied with `wrangler d1 migrations apply`) — do not run this file against a
-- live/production database, since the DROP TABLE statements below discard data.

DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS collections;
DROP TABLE IF EXISTS users;

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

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo_key TEXT NOT NULL,
  collection TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_people_collection ON people(collection);
CREATE INDEX idx_people_user ON people(user_id);
CREATE INDEX idx_people_user_collection ON people(user_id, collection);
