import { getSetting } from '../db/db.js';
import { getCooldown, setCooldown, addAudit } from '../db/repo.js';

function addDaysIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function onMemberRemove({ client, db, member }) {
  const cd = getCooldown(db, member.id);
  if (!cd) return;
  addAudit(db, 'MEMBER_LEFT_DURING_COOLDOWN', null, member.id, cd.last_org_id || null, { type: cd.type, expires_at: cd.expires_at });
}

export async function onMemberAdd({ client, db, member }) {
  const cd = getCooldown(db, member.id);
  if (!cd) return;

  const pkRole = getSetting(db, 'ROLE_PK_ID', '');
  const banRole = getSetting(db, 'ROLE_BAN_ID', '');

  if (cd.type === 'PK') {
    const pkDays = parseInt(getSetting(db, 'PK_DAYS', '3'), 10);
    const newExp = addDaysIso(pkDays);
    setCooldown(db, member.id, 'PK', newExp, cd.last_org_id || null);
    if (pkRole) await member.roles.add(pkRole, 'PK evade => reset').catch(() => {});
    addAudit(db, 'COOLDOWN_EVADE_RESET', null, member.id, cd.last_org_id || null, { old_expires_at: cd.expires_at, new_expires_at: newExp });
    return;
  }

  if (cd.type === 'BAN') {
    if (banRole) await member.roles.add(banRole, 'BAN reapply on rejoin').catch(() => {});
    addAudit(db, 'BAN_REAPPLIED_ON_REJOIN', null, member.id, null, { expires_at: cd.expires_at });
  }
}
