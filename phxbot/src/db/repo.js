export function listOrgs(db) {
  return db.prepare("SELECT * FROM orgs ORDER BY kind, name").all();
}
export function getOrg(db, orgId) {
  return db.prepare("SELECT * FROM orgs WHERE id=?").get(orgId);
}
export function createOrg(db, { name, kind, member_role_id, leader_role_id, co_leader_role_id }) {
  const now = Date.now();
  const cols = db.prepare("PRAGMA table_info(orgs)").all().map(r => r.name);
  const hasKind = cols.includes("kind");
  const hasType = cols.includes("type");
  let stmt;
  let res;
  if (hasKind && hasType) {
    stmt = db.prepare(`
      INSERT INTO orgs(name,kind,type,member_role_id,leader_role_id,co_leader_role_id,created_at)
      VALUES(?,?,?,?,?,?,?)
    `);
    res = stmt.run(name, kind, kind, member_role_id, leader_role_id, co_leader_role_id || null, now);
  } else if (hasKind) {
    stmt = db.prepare(`
      INSERT INTO orgs(name,kind,member_role_id,leader_role_id,co_leader_role_id,created_at)
      VALUES(?,?,?,?,?,?)
    `);
    res = stmt.run(name, kind, member_role_id, leader_role_id, co_leader_role_id || null, now);
  } else if (hasType) {
    stmt = db.prepare(`
      INSERT INTO orgs(name,type,member_role_id,leader_role_id,co_leader_role_id,created_at)
      VALUES(?,?,?,?,?,?)
    `);
    res = stmt.run(name, kind, member_role_id, leader_role_id, co_leader_role_id || null, now);
  } else {
    throw new Error("Missing orgs schema columns (kind/type).");
  }
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
    ON CONFLICT(user_id) DO UPDATE SET
      org_id=excluded.org_id,
      role=excluded.role,
      since_ts=CASE
        WHEN memberships.org_id = excluded.org_id THEN memberships.since_ts
        ELSE excluded.since_ts
      END
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
export function listMemberships(db) {
  return db.prepare("SELECT * FROM memberships").all();
}

export function updateOrgMemberCap(db, orgId, capValue) {
  db.prepare("UPDATE orgs SET member_cap=? WHERE id=?").run(capValue ?? null, orgId);
}

export function updateOrgEditable(db, orgId, payload) {
  const fields = [
    "member_role_id",
    "leader_role_id",
    "co_leader_role_id",
    "member_cap",
    "co_leader_cap",
    "extra_role_ids",
    "pk_cooldown_days",
    "transfer_cooldown_days",
    "no_cooldown_after_days",
    "no_cooldown_types"
  ];
  const sets = [];
  const vals = [];
  for (const key of fields) {
    if (!(key in payload)) continue;
    sets.push(`${key}=?`);
    vals.push(payload[key]);
  }
  if (!sets.length) return { changes: 0 };
  vals.push(orgId);
  return db.prepare(`UPDATE orgs SET ${sets.join(", ")} WHERE id=?`).run(...vals);
}

export function listOrgDelegates(db, orgId) {
  return db.prepare("SELECT * FROM org_delegates WHERE org_id=? ORDER BY created_at DESC").all(orgId);
}

export function getOrgDelegate(db, orgId, userId) {
  return db.prepare("SELECT * FROM org_delegates WHERE org_id=? AND user_id=?").get(orgId, String(userId));
}

export function upsertOrgDelegate(db, orgId, userId, flags = {}, createdBy = null) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO org_delegates(org_id, user_id, can_promote_coleader, can_demote_coleader, created_by, created_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(org_id, user_id) DO UPDATE SET
      can_promote_coleader=excluded.can_promote_coleader,
      can_demote_coleader=excluded.can_demote_coleader,
      created_by=excluded.created_by,
      created_at=excluded.created_at
  `).run(orgId, String(userId), flags.can_promote_coleader ? 1 : 0, flags.can_demote_coleader ? 1 : 0, createdBy, now);
}

export function removeOrgDelegate(db, orgId, userId) {
  return db.prepare("DELETE FROM org_delegates WHERE org_id=? AND user_id=?").run(orgId, String(userId));
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
  return db.prepare("DELETE FROM cooldowns WHERE user_id=? AND kind=?").run(userId, kind);
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

export function listWarnsByOrg(db, orgId, status = null, limit = 500) {
  const oid = Number(orgId);
  if (!Number.isFinite(oid)) return [];
  if (status) {
    return db
      .prepare("SELECT * FROM warns WHERE org_id=? AND status=? ORDER BY created_at DESC LIMIT ?")
      .all(oid, status, limit);
  }
  return db
    .prepare("SELECT * FROM warns WHERE org_id=? ORDER BY created_at DESC LIMIT ?")
    .all(oid, limit);
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

export function createTransferRequest(db, req) {
  db.prepare(`
    INSERT INTO transfer_requests(
      request_id, from_org_id, to_org_id, user_id, status,
      requested_by, approved_by, created_at, approved_at, cooldown_expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.request_id,
    req.from_org_id,
    req.to_org_id,
    req.user_id,
    req.status,
    req.requested_by,
    req.approved_by ?? null,
    req.created_at,
    req.approved_at ?? null,
    req.cooldown_expires_at ?? null
  );
}
export function getTransferRequest(db, requestId) {
  return db.prepare("SELECT * FROM transfer_requests WHERE request_id=?").get(requestId);
}
export function findActiveTransferByUser(db, userId) {
  return db.prepare(`
    SELECT * FROM transfer_requests
    WHERE user_id=? AND status IN ('PENDING','APPROVED')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId);
}
export function listTransfersByUser(db, userId, limit = 10) {
  return db.prepare(`
    SELECT * FROM transfer_requests
    WHERE user_id=?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);
}
export function listPendingTransfersForOrg(db, toOrgId, limit = 20) {
  return db.prepare(`
    SELECT * FROM transfer_requests
    WHERE to_org_id=? AND status='PENDING'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(toOrgId, limit);
}
export function listPendingTransfers(db, limit = 200) {
  return db.prepare(`
    SELECT * FROM transfer_requests
    WHERE status='PENDING'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}
export function listReadyTransfers(db, nowTs, limit = 50) {
  return db.prepare(`
    SELECT * FROM transfer_requests
    WHERE status='APPROVED' AND cooldown_expires_at IS NOT NULL AND cooldown_expires_at <= ?
    ORDER BY cooldown_expires_at ASC
    LIMIT ?
  `).all(nowTs, limit);
}
export function updateTransferRequestStatus(db, requestId, status, updates = {}) {
  db.prepare(`
    UPDATE transfer_requests
    SET status=?,
        approved_by=COALESCE(?, approved_by),
        approved_at=COALESCE(?, approved_at),
        cooldown_expires_at=COALESCE(?, cooldown_expires_at),
        retry_count=COALESCE(?, retry_count)
    WHERE request_id=?
  `).run(
    status,
    updates.approved_by ?? null,
    updates.approved_at ?? null,
    updates.cooldown_expires_at ?? null,
    updates.retry_count ?? null,
    requestId
  );
}

export function incrementTransferRetryCount(db, requestId) {
  return db.prepare(`
    UPDATE transfer_requests
    SET retry_count = COALESCE(retry_count, 0) + 1
    WHERE request_id=?
  `).run(requestId);
}


export function cancelActiveTransfersByUser(db, userId, cancelledBy = null, cancelledAt = Date.now()) {
  return db.prepare(`
    UPDATE transfer_requests
    SET status='CANCELLED',
        approved_by=COALESCE(?, approved_by),
        approved_at=COALESCE(?, approved_at),
        cooldown_expires_at=COALESCE(cooldown_expires_at, ?)
    WHERE user_id=? AND status IN ('PENDING','APPROVED')
  `).run(cancelledBy, cancelledAt, cancelledAt, userId);
}

export function upsertUserPresence(
  db,
  userId,
  { lastSeenAt = null, lastLeftAt = null, clearLeft = false } = {}
) {
  db.prepare(`
    INSERT INTO user_presence(user_id, last_seen_at, last_left_at)
    VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_seen_at=COALESCE(excluded.last_seen_at, user_presence.last_seen_at),
      last_left_at=CASE
        WHEN ? THEN NULL
        WHEN excluded.last_left_at IS NOT NULL THEN excluded.last_left_at
        ELSE user_presence.last_left_at
      END
  `).run(userId, lastSeenAt, lastLeftAt, clearLeft ? 1 : 0);
}
export function getUserPresence(db, userId) {
  return db.prepare("SELECT * FROM user_presence WHERE user_id=?").get(userId);
}
