import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export function openDb() {
  const dbPath = process.env.DB_PATH || "./data/phxbot.sqlite";
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function ensureSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
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
    since_ts INTEGER NOT NULL
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
  CREATE TABLE IF NOT EXISTS global_state (key TEXT PRIMARY KEY, value TEXT);
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
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);
    CREATE INDEX IF NOT EXISTS idx_cooldowns_expires_at ON cooldowns(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cooldowns_kind_expires_at ON cooldowns(kind, expires_at);
    CREATE INDEX IF NOT EXISTS idx_warns_status_created_at ON warns(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_warns_status_expires_at ON warns(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status);
    CREATE INDEX IF NOT EXISTS idx_transfer_requests_cooldown ON transfer_requests(cooldown_expires_at);
    CREATE INDEX IF NOT EXISTS idx_org_delegates_org ON org_delegates(org_id);
  `);

  function ensureColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  ensureColumn("orgs", "kind", "kind TEXT NOT NULL DEFAULT 'ILLEGAL'");
  ensureColumn("orgs", "leader_role_id", "leader_role_id TEXT NOT NULL DEFAULT ''");
  ensureColumn("orgs", "co_leader_role_id", "co_leader_role_id TEXT");
  ensureColumn("orgs", "member_role_id", "member_role_id TEXT NOT NULL DEFAULT ''");
  ensureColumn("orgs", "member_cap", "member_cap INTEGER");
  ensureColumn("orgs", "co_leader_cap", "co_leader_cap INTEGER");
  ensureColumn("orgs", "extra_role_ids", "extra_role_ids TEXT NOT NULL DEFAULT ''");
  ensureColumn("orgs", "pk_cooldown_days", "pk_cooldown_days INTEGER");
  ensureColumn("orgs", "transfer_cooldown_days", "transfer_cooldown_days INTEGER");
  ensureColumn("orgs", "no_cooldown_after_days", "no_cooldown_after_days INTEGER");
  ensureColumn("orgs", "no_cooldown_types", "no_cooldown_types TEXT NOT NULL DEFAULT ''");
  ensureColumn("orgs", "allow_coleaders_set_rank", "allow_coleaders_set_rank INTEGER NOT NULL DEFAULT 0");
  ensureColumn("orgs", "coleader_can_promote_members", "coleader_can_promote_members INTEGER NOT NULL DEFAULT 0");
  ensureColumn("orgs", "coleader_can_demote_members", "coleader_can_demote_members INTEGER NOT NULL DEFAULT 0");
  ensureColumn("orgs", "coleader_can_manage_coleaders", "coleader_can_manage_coleaders INTEGER NOT NULL DEFAULT 0");
  ensureColumn("orgs", "setrank_whitelist_user_ids", "setrank_whitelist_user_ids TEXT NOT NULL DEFAULT ''");
  ensureColumn("transfer_requests", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");

  const orgCols = db.prepare("PRAGMA table_info(orgs)").all().map(r => r.name);
  if (orgCols.includes("type")) {
    db.exec("UPDATE orgs SET kind=type WHERE kind IS NULL OR kind=''");
  }

  const defaults = [
    ["audit_channel_id", ""],
    ["warn_channel_id", ""],
    ["bot_channel_id", ""],
    ["admin_role_id", ""],
    ["supervisor_role_id", ""],
    ["config_role_id", ""],
    ["pk_role_id", ""],
    ["ban_role_id", ""],
    ["brand_text", "Phoenix Faction Manager"],
    ["brand_icon_url", ""],
    ["watchdog_enabled", "true"],
    ["watchdog_interval_min", "30"],
    ["watchdog_startup_delay_ms", "5000"],
    ["watchdog_accept_offline_role_removal", "true"],
    ["watchdog_drift_logs", "true"],
    ["watchdog_drift_sample", "12"],
    ["org_reapply_on_join", "true"],
    ["cooldown_reapply_on_join", "true"],
    ["role_op_concurrency", "3"],
    ["stale_membership_days", "14"],
    ["pk_backfill_default_ms", String(3 * 24 * 60 * 60 * 1000)],
    ["ban_backfill_default_ms", String(30 * 24 * 60 * 60 * 1000)],
    ["audit_index_window_ms", String(120 * 1000)],
    ["audit_index_limit", "50"],
    ["transfer_fail_audit_dedupe_ms", String(2 * 60 * 1000)],
    ["accept_manual_org_role_changes", "false"],
    ["accept_manual_cooldown_role_changes", "false"],
    ["policy_org_roles_downtime", "REVERT"],
    ["policy_cooldowns_downtime", "REVERT"],
    ["transfer_cooldown_ms", String(60 * 60 * 1000)],
    ["org_switch_cooldown_ms", String(3 * 60 * 60 * 1000)],
    ["transfer_request_expiry_ms", String(24 * 60 * 60 * 1000)],
    ["transfer_complete_retry_count", "2"],
    ["transfer_complete_retry_backoff_ms", String(60 * 1000)],
  ];
  const upsert = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
  for (const [k,v] of defaults) upsert.run(k,v);

  db.prepare("INSERT OR IGNORE INTO global_state(key,value) VALUES(?,?)").run("schema_version", "2");
}

export function getSetting(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row?.value ?? "";
}
export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value ?? "");
}

export function getGlobal(db, key) {
  const row = db.prepare("SELECT value FROM global_state WHERE key=?").get(key);
  return row?.value ?? "";
}
export function setGlobal(db, key, value) {
  db.prepare("INSERT INTO global_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value ?? "");
}
