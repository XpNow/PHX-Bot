PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('MAFIA','LEGAL')),
  base_role_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS org_ranks (
  org_id TEXT NOT NULL,
  rank_key TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  PRIMARY KEY (org_id, rank_key),
  FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  rank_key TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('PK','BAN')),
  expires_at TEXT NOT NULL,
  last_org_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS last_org (
  user_id TEXT PRIMARY KEY,
  last_in_org_at TEXT NOT NULL,
  last_org_id TEXT
);

CREATE TABLE IF NOT EXISTS lockdowns (
  org_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('NONE','RECRUIT','FULL')),
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rate_limits (
  scope_role TEXT NOT NULL,
  action TEXT NOT NULL,
  max_count INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_role, action)
);

CREATE TABLE IF NOT EXISTS rate_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  scope_role TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  org_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warns (
  warn_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  message_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','REMOVED')),
  payload_json TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(org_id) ON DELETE CASCADE
);
