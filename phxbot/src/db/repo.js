import { nanoid } from 'nanoid';
import { nowIso } from './db.js';

export function upsertOrg(db, org) {
  const stmt = db.prepare(`
    INSERT INTO orgs (org_id, name, type, base_role_id, is_active, created_at)
    VALUES (:org_id, :name, :type, :base_role_id, :is_active, CURRENT_TIMESTAMP)
    ON CONFLICT(org_id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      base_role_id = excluded.base_role_id,
      is_active = excluded.is_active
  `);

  stmt.run({
    org_id: org.org_id,
    name: org.name,
    type: org.type,
    base_role_id: org.base_role_id ?? null,
    is_active: org.is_active ?? 1,
  });
}

export function listOrgs(db, type = null) {
  if (type) {
    return db.prepare('SELECT * FROM orgs WHERE type=? AND is_active=1 ORDER BY name').all(type);
  }
  return db.prepare('SELECT * FROM orgs WHERE is_active=1 ORDER BY type, name').all();
}

export function getOrgById(db, org_id) {
  return db.prepare('SELECT * FROM orgs WHERE org_id=?').get(org_id) || null;
}

export function setOrgRankRole(db, org_id, rank_key, role_id, level) {
  db.prepare(
    `INSERT INTO org_ranks(org_id, rank_key, role_id, level)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(org_id, rank_key) DO UPDATE SET role_id=excluded.role_id, level=excluded.level`
  ).run(org_id, rank_key, role_id, level);
}

// Alias used by UI layer
export function upsertOrgRank(db, org_id, rank_key, role_id, level) {
  return setOrgRankRole(db, org_id, rank_key, role_id, level);
}

// Soft-delete an organization (keeps audit history). Clears rank mapping + lockdown.
export function deleteOrg(db, org_id) {
  db.prepare('UPDATE orgs SET is_active=0 WHERE org_id=?').run(org_id);
  db.prepare('DELETE FROM org_ranks WHERE org_id=?').run(org_id);
  db.prepare('DELETE FROM lockdowns WHERE org_id=?').run(org_id);
}

export function getOrgRanks(db, org_id) {
  return db.prepare('SELECT * FROM org_ranks WHERE org_id=? ORDER BY level DESC').all(org_id);
}

export function getMembership(db, user_id) {
  return db.prepare('SELECT * FROM memberships WHERE user_id=?').get(user_id) || null;
}

export function setMembership(db, user_id, org_id, rank_key) {
  db.prepare(
    `INSERT INTO memberships(user_id, org_id, rank_key, updated_at)
     VALUES(?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET org_id=excluded.org_id, rank_key=excluded.rank_key, updated_at=excluded.updated_at`
  ).run(user_id, org_id, rank_key);
}

export function clearMembership(db, user_id) {
  db.prepare('DELETE FROM memberships WHERE user_id=?').run(user_id);
}

export function getCooldown(db, user_id) {
  return db.prepare('SELECT * FROM cooldowns WHERE user_id=?').get(user_id) || null;
}

export function setCooldown(db, user_id, type, expires_at, last_org_id) {
  db.prepare(
    `INSERT INTO cooldowns(user_id, type, expires_at, last_org_id, updated_at)
     VALUES(?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET type=excluded.type, expires_at=excluded.expires_at, last_org_id=excluded.last_org_id, updated_at=excluded.updated_at`
  ).run(user_id, type, expires_at, last_org_id);
}

export function clearCooldown(db, user_id) {
  db.prepare('DELETE FROM cooldowns WHERE user_id=?').run(user_id);
}

export function setLastOrg(db, user_id, org_id) {
  db.prepare(
    `INSERT INTO last_org(user_id, last_org_id, last_in_org_at, updated_at)
     VALUES(?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET last_org_id=excluded.last_org_id, last_in_org_at=excluded.last_in_org_at, updated_at=excluded.updated_at`
  ).run(user_id, org_id);
}

export function getLastOrg(db, user_id) {
  return db.prepare('SELECT * FROM last_org WHERE user_id=?').get(user_id) || null;
}

export function setLockdown(db, org_id, mode, expires_at = null) {
  db.prepare(
    `INSERT INTO lockdowns(org_id, mode, expires_at, updated_at)
     VALUES(?, ?, ?, datetime('now'))
     ON CONFLICT(org_id) DO UPDATE SET mode=excluded.mode, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
  ).run(org_id, mode, expires_at);
}

export function getLockdown(db, org_id) {
  return db.prepare('SELECT * FROM lockdowns WHERE org_id=?').get(org_id) || null;
}

export function clearLockdown(db, org_id) {
  db.prepare('DELETE FROM lockdowns WHERE org_id=?').run(org_id);
}

export function addAudit(db, action, actor_id, target_id, org_id, details = {}) {
  const id = nanoid();
  db.prepare(
    `INSERT INTO audit(id, action, actor_id, target_id, org_id, details_json, created_at)
     VALUES(?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(id, action, actor_id, target_id, org_id, JSON.stringify(details));
  return id;
}

export function listRecentErrors(db, limit = 10) {
  return db.prepare("SELECT * FROM audit WHERE action='ERROR' ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function upsertRateLimit(db, scope_role, action, max_count, window_seconds) {
  db.prepare(
    `INSERT INTO rate_limits(scope_role, action, max_count, window_seconds, updated_at)
     VALUES(?, ?, ?, ?, datetime('now'))
     ON CONFLICT(scope_role, action) DO UPDATE SET max_count=excluded.max_count, window_seconds=excluded.window_seconds, updated_at=excluded.updated_at`
  ).run(scope_role, action, max_count, window_seconds);
}

export function getRateLimit(db, scope_role, action) {
  return db.prepare('SELECT * FROM rate_limits WHERE scope_role=? AND action=?').get(scope_role, action) || null;
}

export function logRateHit(db, scope_role, action) {
  db.prepare(
    `INSERT INTO rate_hits(user_id, scope_role, action, created_at)
     VALUES('', ?, ?, datetime('now'))`
  ).run(scope_role, action);
}

export function addWarn(db, org_id, created_by, message_id, payload, expires_at = null) {
  const warn_id = `MW-${new Date().getUTCFullYear()}-${String(Math.floor(Math.random()*1000000)).padStart(6,'0')}`;
  db.prepare(
    `INSERT INTO warns(warn_id, org_id, message_id, created_by, created_at, expires_at, status, payload_json)
     VALUES(?, ?, ?, ?, datetime('now'), ?, 'ACTIVE', ?)`
  ).run(warn_id, org_id, message_id, created_by, expires_at, JSON.stringify(payload));
  return warn_id;
}

export function setWarnStatus(db, warn_id, status) {
  db.prepare('UPDATE warns SET status=?, updated_at=datetime(\'now\') WHERE warn_id=?').run(status, warn_id);
}

export function listActiveWarns(db, org_id) {
  return db.prepare("SELECT * FROM warns WHERE org_id=? AND status='ACTIVE' ORDER BY created_at DESC").all(org_id);
}

export function listExpiringWarns(db) {
  return db.prepare("SELECT * FROM warns WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at <= datetime('now')").all();
}

export function listExpiringCooldowns(db) {
  return db.prepare("SELECT * FROM cooldowns WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").all();
}

export function isUserInAnyOrg(db, user_id) {
  return !!getMembership(db, user_id);
}

export function isUserInCooldown(db, user_id) {
  return !!getCooldown(db, user_id);
}

// ---- Stats & listing helpers ----
export function countOrgsByType(db) {
  const rows = db.prepare("SELECT type, COUNT(1) as c FROM orgs WHERE is_active=1 GROUP BY type").all();
  const out = { MAFIA: 0, LEGAL: 0, TOTAL: 0 };
  for (const r of rows) {
    out[r.type] = r.c;
    out.TOTAL += r.c;
  }
  return out;
}

export function countMembersByOrgType(db) {
  // Memberships join orgs to separate mafia vs legal counts.
  const rows = db.prepare(
    "SELECT o.type as type, COUNT(1) as c FROM memberships m JOIN orgs o ON o.org_id=m.org_id WHERE o.is_active=1 GROUP BY o.type"
  ).all();
  const out = { MAFIA: 0, LEGAL: 0, TOTAL: 0 };
  for (const r of rows) {
    out[r.type] = r.c;
    out.TOTAL += r.c;
  }
  return out;
}

export function listMembershipsByOrg(db, org_id) {
  return db
    .prepare('SELECT user_id, rank_key, updated_at FROM memberships WHERE org_id=? ORDER BY rank_key, user_id')
    .all(org_id);
}

export function listCooldownsByOrg(db, org_id, type = null) {
  if (type) {
    return db
      .prepare('SELECT * FROM cooldowns WHERE last_org_id=? AND type=? ORDER BY expires_at ASC')
      .all(org_id, type);
  }
  return db.prepare('SELECT * FROM cooldowns WHERE last_org_id=? ORDER BY expires_at ASC').all(org_id);
}

export function listCooldownsAll(db, type = null) {
  if (type) return db.prepare('SELECT * FROM cooldowns WHERE type=? ORDER BY expires_at ASC').all(type);
  return db.prepare('SELECT * FROM cooldowns ORDER BY expires_at ASC').all();
}

