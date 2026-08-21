-- Only apply this AFTER the legacy R2 photo cleanup has run (see CLAUDE.md /
-- the migration plan) — people.photo_key values become unrecoverable once
-- this table is dropped.
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS collections;
