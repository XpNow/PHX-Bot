import { getSetting } from '../db/db.js';
import { listOrgs, getOrgRanks } from '../db/repo.js';

// Returns actor context: {scopeRole, isAdmin, isSupervisor, canWarnManage, org|null, rankKey|null}
// ownerId is guild.ownerId; guild owner always has admin-level access for bootstrap/config.
export function getActorContext(db, member, ownerId = null) {
  const roles = new Set(member.roles.cache.map(r => r.id));
  const roleAdmin = getSetting(db, 'ROLE_ADMIN_ID', '');
  const roleSup = getSetting(db, 'ROLE_SUPERVISOR_ID', '');
  const roleWarn = getSetting(db, 'ROLE_WARN_MANAGER_ID', '');

  const isOwner = ownerId && member.id === ownerId;
  const isSupervisor = isOwner || (roleSup && roles.has(roleSup));
  const isAdmin = isSupervisor || (roleAdmin && roles.has(roleAdmin));
  const canWarnManage = isSupervisor || (roleWarn && roles.has(roleWarn));

  // Find org by base_role_id present on member
  const orgs = listOrgs(db);
  let org = null;
  for (const o of orgs) {
    if (o.base_role_id && roles.has(o.base_role_id)) {
      org = o;
      break;
    }
  }

  let rankKey = null;
  if (org) {
    const ranks = getOrgRanks(db, org.org_id);
    // pick highest level rank role the member has
    let best = null;
    for (const r of ranks) {
      if (r.role_id && roles.has(r.role_id)) {
        if (!best || r.level > best.level) best = r;
      }
    }
    rankKey = best ? best.rank_key : 'MEMBER';
  }

  let scopeRole = 'MEMBER';
  if (isSupervisor) scopeRole = 'SUPERVISOR';
  else if (isAdmin) scopeRole = 'ADMIN';
  else if (rankKey) {
    // mafia leader/co, legal manager ranks
    if (['LEADER','COLEADER','CHIEF','HR','DIRECTOR','DEPUTY'].includes(rankKey)) {
      scopeRole = rankKey;
    } else {
      scopeRole = 'ORG_MEMBER';
    }
  }

  return { scopeRole, isAdmin, isSupervisor, canWarnManage, org, rankKey };
}

export function requireOrgContext(ctx) {
  return !!ctx.org;
}

export function isMafiaManager(ctx) {
  return !!ctx.org && ctx.org.type === 'MAFIA' && ['LEADER','COLEADER'].includes(ctx.rankKey);
}

export function isLegalManager(ctx) {
  return !!ctx.org && ctx.org.type === 'LEGAL' && ['CHIEF','HR','DIRECTOR','DEPUTY'].includes(ctx.rankKey);
}

export function canUseFmenu(ctx) {
  return ctx.isAdmin || ctx.isSupervisor || isMafiaManager(ctx) || isLegalManager(ctx);
}

export function canEditOrg(ctx, org) {
  return ctx.isAdmin || ctx.isSupervisor || (ctx.org && org && ctx.org.org_id === org.org_id);
}

export function canManageMembers(ctx, org) {
  if (!org) return false;
  if (ctx.isAdmin || ctx.isSupervisor) return true;
  if (!ctx.org || ctx.org.org_id !== org.org_id) return false;
  if (org.type === 'MAFIA') return ['LEADER','COLEADER'].includes(ctx.rankKey);
  if (org.type === 'LEGAL') return ['CHIEF','HR','DIRECTOR','DEPUTY'].includes(ctx.rankKey);
  return false;
}

export function canPromoteDemote(ctx, org) {
  if (!org) return false;
  if (ctx.isAdmin || ctx.isSupervisor) return true;
  if (!ctx.org || ctx.org.org_id !== org.org_id) return false;
  // your rule: promote/demote only managers
  if (org.type === 'LEGAL') return ['CHIEF','HR','DIRECTOR','DEPUTY'].includes(ctx.rankKey);
  return false;
}

export function canFalert(ctx) {
  // Mafia-only and requires to be in a mafia org (any member ok) or admin/sup
  if (ctx.isAdmin || ctx.isSupervisor) return true;
  return !!ctx.org && ctx.org.type === 'MAFIA';
}
