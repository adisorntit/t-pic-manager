'use strict';
// SQLite database using Node's built-in node:sqlite (Node >= 22.13, no npm packages).

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name    TEXT    NOT NULL DEFAULT '',
  password_hash   TEXT    NOT NULL,
  role            TEXT    NOT NULL CHECK (role IN ('admin', 'user')),
  must_change_pw  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS images (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  ext          TEXT    NOT NULL,              -- extension used in the public link (fixed at upload)
  file         TEXT    NOT NULL,              -- stored file path, relative to the images folder
  mime         TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  uploader_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  version      INTEGER NOT NULL DEFAULT 1,    -- bumped on every "replace"
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_created  ON images(created_at);
CREATE INDEX IF NOT EXISTS idx_images_uploader ON images(uploader_id);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 1;');
  return db;
}

/** Run fn inside a transaction. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx };
