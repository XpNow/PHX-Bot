import * as repo from "../db/repo.js";
import { getSetting } from "../db/db.js";
import { enqueueRoleOp } from "../infra/roleQueue.js";

const _cooldownTouch = new Map();

const _dupLeadershipRoleWarn = new Map();
const _leadershipConflictWarn = new Map();

function _canWarnOnce(map, key, windowMs) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < windowMs) return false;
  map.set(key, now);
  return true;
}


function _cdKey(userId, kind, action) {
  return `${userId}:${kind}:${action}`;
}

function _canTouchCooldown(userId, kind, action, windowMs = 1_000) {
  const k = _cdKey(userId, kind, action);
  const last = _cooldownTouch.get(k) || 0;
  const now = Date.now();
  if (now - last < windowMs) return false;
  _cooldownTouch.set(k, now);
  return true;
}

function computeRank(member, org, leaderRole, coLeaderRole) {
  if (leaderRole && member.roles.cache.has(leaderRole)) return "LEADER";
  if (coLeaderRole && member.roles.cache.has(coLeaderRole)) return "COLEADER";
  return "MEMBER";
}

function formatRel(tsMs) {
  return `<t:${Math.floor(Number(tsMs) / 1000)}:R>`;
}

function fmtOpResult(res) {
  if (!res) return "necunoscut";
  if (res.ok) {
    if (res.skipped) return "OK (skip)";
    if (res.deduped) return "OK (deduped)";
    return "OK";
  }
  return `EȘEC (${res.reason || "UNKNOWN"})`;
}

function settingBool(db, key, def = false) {
  const raw = String(getSetting(db, key) || "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return def;
}

export function diffMemberOrgsFromDiscord(member, orgs) {
  const hits = [];
  for (const org of orgs) {
    if (!org?.member_role_id) continue;
    if (!member.roles.cache.has(org.member_role_id)) continue;
    hits.push(org);
  }
  return hits;
}

export async function syncMemberOrgsDiscordToDb({ db, guild, member, audit }) {
  const orgs = repo.listOrgs(db);
  const hits = diffMemberOrgsFromDiscord(member, orgs);

  const roleToOrgs = new Map();
  const pushOwner = (roleId, org, kind) => {
    if (!roleId) return;
    const k = String(roleId);
    const arr = roleToOrgs.get(k) || [];
    arr.push({ org, kind });
    roleToOrgs.set(k, arr);
  };

  for (const org of orgs) {
    if (org?.leader_role_id) pushOwner(org.leader_role_id, org, "Leader");
    if (org?.co_leader_role_id) pushOwner(org.co_leader_role_id, org, "Co-Leader");
  }

  const dupRoleIds = new Set();
  for (const [rid, owners] of roleToOrgs.entries()) {
    if ((owners?.length || 0) > 1) dupRoleIds.add(String(rid));
  }

  for (const rid of dupRoleIds) {
    if (!member.roles.cache.has(rid)) continue;
    if (!_canWarnOnce(_dupLeadershipRoleWarn, rid, 10 * 60 * 1000)) continue;
    const owners = roleToOrgs.get(rid) || [];
    await audit?.(
      "⚠️ Config: rol conducere duplicat",
      [
        `**Rol:** <@&${rid}>`,
        `**Problemă:** același rol de conducere este folosit în mai multe organizații`,
        `**Organizații:** ${owners.map(x => `**${x.org?.name ?? x.org?.id ?? "?"}** (${x.kind})`).join(", ")}`,
        `**Impact:** pot apărea alerte de conflict la setări de rank / sincronizări`
      ].join("\n")
    );
  }

  const leadershipConflicts = [];
  for (const org of orgs) {
    if (!org?.member_role_id) continue;
    const hasMain = member.roles.cache.has(org.member_role_id);
    if (hasMain) continue;

    const leadRid = org.leader_role_id ? String(org.leader_role_id) : null;
    const coRid = org.co_leader_role_id ? String(org.co_leader_role_id) : null;

    const hasLead = leadRid && !dupRoleIds.has(leadRid) && member.roles.cache.has(leadRid);
    const hasCo = coRid && !dupRoleIds.has(coRid) && member.roles.cache.has(coRid);

    if (hasLead || hasCo) leadershipConflicts.push({ org, hasLead, hasCo });
  }

  if (leadershipConflicts.length) {
    if (_canWarnOnce(_leadershipConflictWarn, member.id, 2 * 60 * 1000)) {
      await audit?.(
        "⚠️ Conflict: rol conducere fără rol org",
        [
          `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
          `**Problemă:** are Leader/Co-Leader fără rolul principal al organizației`,
          `**Roluri detectate:** ${leadershipConflicts
            .map(x => `**${x.org.name}** (${x.hasLead ? "Leader" : ""}${x.hasLead && x.hasCo ? "/" : ""}${x.hasCo ? "Co-Leader" : ""})`)
            .join(", ")}`
        ].join("\n")
      );
    }
  }


  if (hits.length > 1) {
    await audit?.(
      "⚠️ Conflict: roluri multiple",
      [
        `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
        `**Răspuns:** nu modific DB până se rezolvă conflictul`,
        `**Roluri detectate:** ${hits.map(o => `**${o.name}**`).join(", ")}`
      ].join("\n")
    );
    return { ok: false, conflict: true, count: hits.length };
  }

  if (hits.length === 0) {
    const prev = repo.getMembership(db, member.id);
    if (!prev) return { ok: true, action: "NOOP", prevOrgId: null };

    const acceptManual = settingBool(db, "accept_manual_org_role_changes", false);
    if (acceptManual) {
      repo.removeMembership(db, member.id);
      await audit?.(
        "🧭 Schimbare manuală rol org",
        [
          `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
          `**Rol schimbat:** role org lipsă în Discord`,
          `**Decizie:** **ACCEPTED by policy**`,
          `**Policy:** accept_manual_org_role_changes=true`,
          `**Executor:** necunoscut`
        ].join("\n")
      );
      return { ok: true, action: "DB_REMOVE", prevOrgId: prev.org_id };
    }

    const prevOrg = repo.getOrg(db, prev.org_id);
    const prevRoleId = prevOrg?.member_role_id ? String(prevOrg.member_role_id) : null;
    let res = null;
    if (prevRoleId) {
      res = await enqueueRoleOp({ member, roleId: prevRoleId, action: "add", context: "org:manual-remove:revert" });
    }
    await audit?.(
      "🧭 Schimbare manuală rol org",
      [
        `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
        `**Rol:** ${prevRoleId ? `<@&${prevRoleId}>` : "—"}`,
        `**Decizie:** **REVERTED by policy**`,
        `**Policy:** accept_manual_org_role_changes=false`,
        `**Executor:** necunoscut`,
        `**Rezultat:** ${fmtOpResult(res)}`
      ].join("\n")
    );
    return { ok: true, action: "REVERTED", prevOrgId: prev.org_id };
  }

  const org = hits[0];
  const leaderRole = org.leader_role_id || null;
  const coLeaderRole = org.co_leader_role_id || null;
  const role = computeRank(member, org, leaderRole, coLeaderRole);
  const prev = repo.getMembership(db, member.id);

  if (prev && String(prev.org_id) === String(org.id) && String(prev.role) === String(role)) {
    return { ok: true, action: "NOOP", orgId: org.id, role, prevOrgId: prev?.org_id ?? null };
  }

  const acceptManual = settingBool(db, "accept_manual_org_role_changes", false);
  const isManualAdd = !prev;
  const isManualSwitch = !!(prev && String(prev.org_id) !== String(org.id));

  if ((isManualAdd || isManualSwitch) && !acceptManual) {
    const newRoleId = org?.member_role_id ? String(org.member_role_id) : null;
    const prevOrg = prev ? repo.getOrg(db, prev.org_id) : null;
    const prevRoleId = prevOrg?.member_role_id ? String(prevOrg.member_role_id) : null;

    let removeRes = null;
    let addRes = null;

    if (newRoleId) {
      removeRes = await enqueueRoleOp({ member, roleId: newRoleId, action: "remove", context: "org:manual-add-switch:revert:remove-new" });
    }
    if (isManualSwitch && prevRoleId) {
      addRes = await enqueueRoleOp({ member, roleId: prevRoleId, action: "add", context: "org:manual-add-switch:revert:add-prev" });
    }

    const changeType = isManualAdd ? "ADD" : "SWITCH";
    await audit?.(
      "🧭 Schimbare manuală rol org",
      [
        `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
        `**Tip schimbare:** ${changeType}`,
        `**Rol nou detectat:** ${newRoleId ? `<@&${newRoleId}>` : "—"}`,
        `**Rol precedent:** ${prevRoleId ? `<@&${prevRoleId}>` : "—"}`,
        `**Decizie:** **REVERTED by policy**`,
        `**Policy:** accept_manual_org_role_changes=false`,
        `**Executor:** necunoscut`,
        `**Rezultat remove nou:** ${fmtOpResult(removeRes)}`,
        ...(isManualSwitch ? [`**Rezultat add precedent:** ${fmtOpResult(addRes)}`] : [])
      ].join("\n")
    );

    return { ok: true, action: "REVERTED", orgId: org.id, role, prevOrgId: prev?.org_id ?? null };
  }

  repo.upsertMembership(db, member.id, org.id, role);
  return { ok: true, action: "UPSERT", orgId: org.id, role, prevOrgId: prev?.org_id ?? null };
}

export async function enforceCooldownsDbToDiscord({ db, guild, member, audit }) {
  const acceptManualCooldown = settingBool(db, "accept_manual_cooldown_role_changes", false);
  const pkRole = getSetting(db, "pk_role_id");
  const banRole = getSetting(db, "ban_role_id");
  const now = Date.now();
  const orgSwitch = repo.getCooldown(db, member.id, "ORG_SWITCH");
  const orgSwitchActive = !!(orgSwitch && Number(orgSwitch.expires_at) > now);

  if (orgSwitchActive && pkRole && !member.roles.cache.has(pkRole)) {
    if (acceptManualCooldown) {
      repo.clearCooldown(db, member.id, "ORG_SWITCH");
      await audit?.("🧭 Schimbare manuală cooldown", `**Țintă:** <@${member.id}> (\`${member.id}\`)\n**Rol:** <@&${pkRole}>\n**Tip:** TRANSFER\n**Decizie:** **ACCEPTED by policy**\n**Policy:** accept_manual_cooldown_role_changes=true\n**Executor:** necunoscut`);
      return { ok: true };
    }
    if (_canTouchCooldown(member.id, "ORG_SWITCH", "add")) {
      const res = await enqueueRoleOp({ member, roleId: pkRole, action: "add", context: "cooldown:transfer:enforce" });
      if (res?.ok) {
        await audit?.(
          "🔁 Cooldown sincronizat",
          [
            `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
            `**Tip:** **TRANSFER**`,
            `**DB:** ✅ activ (expiră ${formatRel(orgSwitch.expires_at)})`,
            `**Discord:** ❌ rol lipsea → ✅ rol adăugat`,
            `**Rezultat:** ${fmtOpResult(res)}`
          ].join("\n")
        );
      }
    }
  }

  const pk = repo.getCooldown(db, member.id, "PK");
  if (pk && pk.expires_at > now && pkRole) {
    if (!member.roles.cache.has(pkRole)) {
      if (acceptManualCooldown) {
        repo.clearCooldown(db, member.id, "PK");
        await audit?.("🧭 Schimbare manuală cooldown", `**Țintă:** <@${member.id}> (\`${member.id}\`)\n**Rol:** <@&${pkRole}>\n**Tip:** PK\n**Decizie:** **ACCEPTED by policy**\n**Policy:** accept_manual_cooldown_role_changes=true\n**Executor:** necunoscut`);
        return { ok: true };
      }
      if (_canTouchCooldown(member.id, "PK", "add")) {
        const res = await enqueueRoleOp({ member, roleId: pkRole, action: "add", context: "cooldown:pk:enforce" });
        if (res?.ok) {
          await audit?.(
            "🔁 Cooldown sincronizat",
            [
              `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
              `**Tip:** **PK**`,
              `**DB:** ✅ activ (expiră ${formatRel(pk.expires_at)})`,
              `**Discord:** ❌ rol lipsea → ✅ rol adăugat`,
              `**Rezultat:** ${fmtOpResult(res)}`
            ].join("\n")
          );
        } else if (res && !res.ok) {
          await audit?.(
            "⚠️ Cooldown drift (nu s-a putut repara)",
            [
              `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
              `**Tip:** **PK**`,
              `**DB:** ✅ activ (expiră ${formatRel(pk.expires_at)})`,
              `**Discord:** ❌ rol lipsește`,
              `**Acțiune încercată:** readăugare rol`,
              `**Rezultat:** ${fmtOpResult(res)}`
            ].join("\n")
          );
        }
      }
    }
  } else {
    const pkExpired = !!(pk && Number(pk.expires_at) <= now);
    if (pkRole && member.roles.cache.has(pkRole) && (!pk || pkExpired) && !orgSwitchActive) {
      if (_canTouchCooldown(member.id, "PK", "remove")) {
        const res = await enqueueRoleOp({ member, roleId: pkRole, action: "remove", context: "cooldown:pk:cleanup" });
        if (res?.ok) {
          if (pk) repo.clearCooldown(db, member.id, "PK");
          await audit?.(
            "🧹 Cooldown curățat",
            [
              `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
              `**Tip:** **PK**`,
              `**DB:** ${pk ? (pkExpired ? `⚠️ expirat (${formatRel(pk.expires_at)})` : "❌ lipsă") : "❌ lipsă"}`,
              `**Discord:** ✅ rol prezent → ✅ rol eliminat`,
              `**Rezultat:** ${fmtOpResult(res)}`
            ].join("\n")
          );
        }
      }
    } else if (pkExpired) {
      repo.clearCooldown(db, member.id, "PK");
    }
  }

  const ban = repo.getCooldown(db, member.id, "BAN");
  if (ban && ban.expires_at > now && banRole) {
    if (!member.roles.cache.has(banRole)) {
      if (acceptManualCooldown) {
        repo.clearCooldown(db, member.id, "BAN");
        await audit?.("🧭 Schimbare manuală cooldown", `**Țintă:** <@${member.id}> (\`${member.id}\`)\n**Rol:** <@&${banRole}>\n**Tip:** BAN\n**Decizie:** **ACCEPTED by policy**\n**Policy:** accept_manual_cooldown_role_changes=true\n**Executor:** necunoscut`);
        return { ok: true };
      }
      if (_canTouchCooldown(member.id, "BAN", "add")) {
        const res = await enqueueRoleOp({ member, roleId: banRole, action: "add", context: "cooldown:ban:enforce" });
        if (res?.ok) {
          await audit?.(
            "🔁 Cooldown sincronizat",
            [
              `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
              `**Tip:** **BAN**`,
              `**DB:** ✅ activ (expiră ${formatRel(ban.expires_at)})`,
              `**Discord:** ❌ rol lipsea → ✅ rol adăugat`,
              `**Rezultat:** ${fmtOpResult(res)}`
            ].join("\n")
          );
        } else if (res && !res.ok) {
          await audit?.(
            "⚠️ Cooldown drift (nu s-a putut repara)",
            [
              `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
              `**Tip:** **BAN**`,
              `**DB:** ✅ activ (expiră ${formatRel(ban.expires_at)})`,
              `**Discord:** ❌ rol lipsește`,
              `**Acțiune încercată:** readăugare rol`,
              `**Rezultat:** ${fmtOpResult(res)}`
            ].join("\n")
          );
        }
      }
    }
  } else {
    const banExpired = !!(ban && Number(ban.expires_at) <= now);
    if (banRole && member.roles.cache.has(banRole) && (!ban || banExpired)) {
      if (_canTouchCooldown(member.id, "BAN", "remove")) {
        const res = await enqueueRoleOp({ member, roleId: banRole, action: "remove", context: "cooldown:ban:cleanup" });
        if (res?.ok) {
          if (ban) repo.clearCooldown(db, member.id, "BAN");
          await audit?.(
            "🧹 Cooldown curățat",
            [
              `**Țintă:** <@${member.id}> (\`${member.id}\`)`,
              `**Tip:** **BAN**`,
              `**DB:** ${ban ? (banExpired ? `⚠️ expirat (${formatRel(ban.expires_at)})` : "❌ lipsă") : "❌ lipsă"}`,
              `**Discord:** ✅ rol prezent → ✅ rol eliminat`,
              `**Rezultat:** ${fmtOpResult(res)}`
            ].join("\n")
          );
        }
      }
    } else if (banExpired) {
      repo.clearCooldown(db, member.id, "BAN");
    }
  }

  return { ok: true };
}
