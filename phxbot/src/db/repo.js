export function listOrgs(db) {
  return db.prepare("SELECT * FROM orgs ORDER BY kind, name").all();
}
export function getOrg(db, orgId) {
  return db.prepare("SELECT * FROM orgs WHERE id=?").get(orgId);
}
export function createOrg(db, { name, kind, member_role_id, leader_role_id, co_leader_role_id }) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO orgs(name,kind,member_role_id,leader_role_id,co_leader_role_id,created_at)
    VALUES(?,?,?,?,?,?)
  `);
  const res = stmt.run(name, kind, member_role_id, leader_role_id, co_leader_role_id || null, now);
  return res.lastInsertRowid;
}
export function deleteOrg(db, orgId) {
  db.prepare("DELETE FROM orgs WHERE id=?").run(orgId);
}
export function upsertMembership(db, userId, orgId, role) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO memberships(user_id, org_id, role, since_ts)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET org_id=excluded.org_id, role=excluded.role, since_ts=excluded.since_ts
  `).run(userId, orgId, role, now);
}
export function removeMembership(db, userId) {
  db.prepare("DELETE FROM memberships WHERE user_id=?").run(userId);
}
export function getMembership(db, userId) {
  return db.prepare("SELECT * FROM memberships WHERE user_id=?").get(userId);
}
export function listMembersByOrg(db, orgId) {
  return db.prepare("SELECT * FROM memberships WHERE org_id=? ORDER BY since_ts DESC").all(orgId);
}

export function upsertLastOrgState(db, userId, orgId, leftAt, removedBy) {
  db.prepare(`
    INSERT INTO last_org_state(user_id, last_org_id, last_left_at, last_removed_by)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET last_org_id=excluded.last_org_id, last_left_at=excluded.last_left_at, last_removed_by=excluded.last_removed_by
  `).run(userId, orgId, leftAt, removedBy || null);
}
export function getLastOrgState(db, userId) {
  return db.prepare("SELECT * FROM last_org_state WHERE user_id=?").get(userId);
}

export function upsertCooldown(db, userId, kind, expiresAt, lastOrgId=null, lastLeftAt=null) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO cooldowns(user_id, kind, expires_at, last_org_id, last_left_at, created_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id, kind) DO UPDATE SET expires_at=excluded.expires_at, last_org_id=excluded.last_org_id, last_left_at=excluded.last_left_at
  `).run(userId, kind, expiresAt, lastOrgId, lastLeftAt, now);
}
export function getCooldown(db, userId, kind) {
  return db.prepare("SELECT * FROM cooldowns WHERE user_id=? AND kind=?").get(userId, kind);
}
export function clearCooldown(db, userId, kind) {
  db.prepare("DELETE FROM cooldowns WHERE user_id=? AND kind=?").run(userId, kind);
}
export function listCooldowns(db, kind) {
  return db.prepare("SELECT * FROM cooldowns WHERE kind=? ORDER BY expires_at ASC").all(kind);
}
export function counts(db) {
  const orgs = db.prepare("SELECT count(*) c FROM orgs").get().c;
  const members = db.prepare("SELECT count(*) c FROM memberships").get().c;
  const pk = db.prepare("SELECT count(*) c FROM cooldowns WHERE kind='PK'").get().c;
  const bans = db.prepare("SELECT count(*) c FROM cooldowns WHERE kind='BAN'").get().c;
  return { orgs, members, pk, bans };
}

export function createWarn(db, warn) {
  db.prepare(`
    INSERT INTO warns(warn_id, org_id, message_id, created_by, created_at, expires_at, status, payload_json)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(
    warn.warn_id,
    warn.org_id ?? null,
    warn.message_id ?? null,
    warn.created_by,
    warn.created_at,
    warn.expires_at ?? null,
    warn.status,
    warn.payload_json
  );
}
export function updateWarnMessageId(db, warnId, messageId) {
  db.prepare("UPDATE warns SET message_id=? WHERE warn_id=?").run(messageId, warnId);
}
export function getWarn(db, warnId) {
  return db.prepare("SELECT * FROM warns WHERE warn_id=?").get(warnId);
}
export function listWarnsByStatus(db, status, limit=20) {
  return db.prepare("SELECT * FROM warns WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, limit);
}
export function setWarnStatus(db, warnId, status) {
  db.prepare("UPDATE warns SET status=? WHERE warn_id=?").run(status, warnId);
}
export function listExpiringWarns(db, nowTs) {
  return db.prepare(`
    SELECT * FROM warns
    WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at ASC
  `).all(nowTs);
}
export function listExpiringCooldowns(db, nowTs) {
  return db.prepare(`
    SELECT * FROM cooldowns
    WHERE expires_at <= ?
    ORDER BY expires_at ASC
  `).all(nowTs);
}
