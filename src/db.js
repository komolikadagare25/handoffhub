const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'handoffhub.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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

module.exports = db;
