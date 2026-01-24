import { getSetting } from '../db/db.js';
import {
  getMembership,
  getCooldown,
  setMembership,
  clearMembership,
  setCooldown,
  clearCooldown,
  setLastOrg,
  getOrgById,
  getOrgRanks,
  addAudit
} from '../db/repo.js';

function addDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export async function addMemberToOrg({ db, guild, actor, targetUserId, org }) {
  const existing = getMembership(db, targetUserId);
  if (existing) {
    throw new Error('Acest membru este deja într-o organizație.');
  }
  const cd = getCooldown(db, targetUserId);
  if (cd) {
    const exp = cd.expires_at ? cd.expires_at : 'necunoscut';
    throw new Error(`Acest membru este în cooldown până la ${exp}.`);
  }

  const member = await guild.members.fetch(targetUserId).catch(() => null);
  if (!member) throw new Error('Nu pot găsi membrul pe server (user invalid sau nu este in guild).');

  if (org.base_role_id) {
    await member.roles.add(org.base_role_id, 'Org add (phxbot)');
  }

  const ranks = getOrgRanks(db, org.org_id);
  const memberRank = ranks.find(r => r.rank_key === 'MEMBER');
  if (memberRank?.role_id) {
    await member.roles.add(memberRank.role_id, 'Org rank add (phxbot)');
  }

  setMembership(db, targetUserId, org.org_id, 'MEMBER');
  addAudit(db, 'ADD_MEMBER', actor.id, targetUserId, org.org_id, { org: org.name });
  return member;
}

export async function removeMemberFromOrg({ db, guild, actor, targetUserId, org, withPk }) {
  const existing = getMembership(db, targetUserId);
  if (!existing || existing.org_id !== org.org_id) {
    throw new Error('Acest membru nu este în organizația ta.');
  }

  const member = await guild.members.fetch(targetUserId).catch(() => null);
  if (!member) {
    clearMembership(db, targetUserId);
    setLastOrg(db, targetUserId, org.org_id);
    if (withPk) {
      const pkDays = parseInt(getSetting(db, 'PK_DAYS', '3'), 10);
      setCooldown(db, targetUserId, 'PK', addDaysIso(pkDays), org.org_id);
    }
    addAudit(db, withPk ? 'REMOVE_MEMBER_PK' : 'REMOVE_MEMBER', actor.id, targetUserId, org.org_id, { org: org.name, missingGuildMember: true });
    return null;
  }

  const ranks = getOrgRanks(db, org.org_id);
  for (const r of ranks) {
    if (r.role_id && member.roles.cache.has(r.role_id)) {
      await member.roles.remove(r.role_id, 'Org rank remove (phxbot)').catch(() => {});
    }
  }
  if (org.base_role_id && member.roles.cache.has(org.base_role_id)) {
    await member.roles.remove(org.base_role_id, 'Org base remove (phxbot)').catch(() => {});
  }

  clearMembership(db, targetUserId);
  setLastOrg(db, targetUserId, org.org_id);

  if (withPk) {
    const pkDays = parseInt(getSetting(db, 'PK_DAYS', '3'), 10);
    const pkRole = getSetting(db, 'ROLE_PK_ID', '');
    setCooldown(db, targetUserId, 'PK', addDaysIso(pkDays), org.org_id);
    if (pkRole) {
      await member.roles.add(pkRole, 'Apply PK cooldown (phxbot)').catch(() => {});
    }
    addAudit(db, 'REMOVE_MEMBER_PK', actor.id, targetUserId, org.org_id, { org: org.name, pkDays });
  } else {
    addAudit(db, 'REMOVE_MEMBER', actor.id, targetUserId, org.org_id, { org: org.name });
  }

  return member;
}

export async function clearExpiredCooldownForUser({ db, guild, userId }) {
  const cd = getCooldown(db, userId);
  if (!cd) return;
  const pkRole = getSetting(db, 'ROLE_PK_ID', '');
  const banRole = getSetting(db, 'ROLE_BAN_ID', '');
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    if (cd.type === 'PK' && pkRole) await member.roles.remove(pkRole, 'PK expired').catch(() => {});
    if (cd.type === 'BAN' && banRole) await member.roles.remove(banRole, 'BAN expired').catch(() => {});
  }
  clearCooldown(db, userId);
}

export async function applyBanOrg({ db, guild, actor, targetUserId, months }) {
  const existing = getMembership(db, targetUserId);
  if (existing) {
    const org = getOrgById(db, existing.org_id);
    if (org) {
      await removeMemberFromOrg({ db, guild, actor, targetUserId, org, withPk: false });
    } else {
      clearMembership(db, targetUserId);
    }
  }
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  const expiresAt = d.toISOString();
  setCooldown(db, targetUserId, 'BAN', expiresAt, null);
  const banRole = getSetting(db, 'ROLE_BAN_ID', '');
  const member = await guild.members.fetch(targetUserId).catch(() => null);
  if (member && banRole) {
    await member.roles.add(banRole, 'Apply BAN cooldown (phxbot)').catch(() => {});
  }
  addAudit(db, 'BAN_FACTIONS', actor.id, targetUserId, null, { months, expiresAt });
  return expiresAt;
}
