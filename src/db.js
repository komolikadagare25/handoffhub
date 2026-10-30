// Uses Node's built-in SQLite (node:sqlite, Node >= 22.13): no native compile step, works on Windows/Render/Docker.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'handoffhub.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

raw.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'meeting',          -- meeting | handoff
  status TEXT NOT NULL DEFAULT 'scheduled',      -- draft | scheduled | completed | archived
  agenda TEXT DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',       -- JSON array of names
  notes TEXT DEFAULT '',                         -- raw unstructured input
  summary TEXT DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings
  kb_links TEXT NOT NULL DEFAULT '[]',           -- JSON array {doc_id,title,reason,score}
  prev_meeting_id INTEGER REFERENCES meetings(id),
  scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner TEXT DEFAULT '',
  due_date TEXT,                                 -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open',           -- open | in_progress | done | cancelled | carried
  outcome TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',         -- manual | ai
  carried_from_id INTEGER REFERENCES action_items(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_meeting ON action_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_items_owner ON action_items(owner);
CREATE INDEX IF NOT EXISTS idx_history_item ON item_history(item_id);
`);

// Thin wrapper keeping the small API the rest of the app uses: prepare() and transaction().
const db = {
  prepare: (sql) => raw.prepare(sql),
  exec: (sql) => raw.exec(sql),
  transaction: (fn) => (...args) => {
    raw.exec('BEGIN');
    try {
      const result = fn(...args);
      raw.exec('COMMIT');
      return result;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  },
};

module.exports = db;