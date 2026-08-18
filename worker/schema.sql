DROP TABLE IF EXISTS people;

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo_key TEXT NOT NULL,
  collection TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_people_collection ON people(collection);
