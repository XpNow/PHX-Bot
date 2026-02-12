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
  member_cap INTEGER,
  co_leader_cap INTEGER,
  extra_role_ids TEXT NOT NULL DEFAULT '',
  pk_cooldown_days INTEGER,
  transfer_cooldown_days INTEGER,
  no_cooldown_after_days INTEGER,
  no_cooldown_types TEXT NOT NULL DEFAULT '',
  allow_coleaders_set_rank INTEGER NOT NULL DEFAULT 0,
  coleader_can_promote_members INTEGER NOT NULL DEFAULT 0,
  coleader_can_demote_members INTEGER NOT NULL DEFAULT 0,
  coleader_can_manage_coleaders INTEGER NOT NULL DEFAULT 0,
  setrank_whitelist_user_ids TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS global_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS transfer_requests (
  request_id TEXT PRIMARY KEY,
  from_org_id INTEGER NOT NULL,
  to_org_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  cooldown_expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT PRIMARY KEY,
  last_seen_at INTEGER,
  last_left_at INTEGER
);

CREATE TABLE IF NOT EXISTS org_delegates (
  org_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  can_promote_coleader INTEGER NOT NULL DEFAULT 1,
  can_demote_coleader INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
