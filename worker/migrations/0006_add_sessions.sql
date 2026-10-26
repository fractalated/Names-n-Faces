-- Server-side login sessions, replacing stateless HMAC-signed tokens so a
-- login can be revoked (logout, "log out of all devices", account deletion).
-- id is the SHA-256 hash of the random token the client holds — the raw
-- token is never stored. remember = 1 for "Keep me signed in on this device"
-- (30 days, sliding from last use); 0 for a plain 12-hour sign-in.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  remember     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
