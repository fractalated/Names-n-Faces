CREATE TABLE master_students (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  disambiguator TEXT,
  photo_key     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_master_students_name_key ON master_students(name_key);

CREATE TABLE decks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_decks_user ON decks(user_id);

CREATE TABLE deck_entries (
  id                TEXT PRIMARY KEY,
  deck_id           TEXT NOT NULL,
  raw_name_text     TEXT NOT NULL,
  master_student_id TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_deck_entries_deck ON deck_entries(deck_id);
CREATE INDEX idx_deck_entries_master_student ON deck_entries(master_student_id);
