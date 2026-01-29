PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  member_role_id TEXT NOT NULL,
  leader_role_id TEXT NOT NULL,
  co_leader_role_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  since_ts INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_org_id INTEGER,
  last_left_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS last_org_state (
  user_id TEXT PRIMARY KEY,
  last_org_id INTEGER,
  last_left_at INTEGER,
  last_removed_by TEXT
);

CREATE TABLE IF NOT EXISTS warns (
  warn_id TEXT PRIMARY KEY,
  org_id INTEGER,
  message_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
