import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export function openDb() {
  const dbPath = process.env.DB_PATH || "./data/phxbot.sqlite";
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

export function ensureSchema(db) {
  // Minimal schema/migration safety (no-timeout, no-crash)
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
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
  CREATE TABLE IF NOT EXISTS global_state (key TEXT PRIMARY KEY, value TEXT);
  `);

  // Defaults
  const defaults = [
    ["audit_channel_id", ""],
    ["alert_channel_id", ""],
    ["warn_channel_id", ""],
    ["admin_role_id", ""],
    ["supervisor_role_id", ""],
    ["pk_role_id", ""],
    ["ban_role_id", ""],
    ["rate_limit_per_min", "20"]
  ];
  const upsert = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
  for (const [k,v] of defaults) upsert.run(k,v);
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
