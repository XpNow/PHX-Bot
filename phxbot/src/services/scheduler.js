import { listExpiringCooldowns, listExpiringWarns, setWarnStatus, clearCooldown, listCooldowns, upsertCooldown } from '../db/repo.js';
import { getSetting } from '../db/db.js';
import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../ui/theme.js';

const DRIFT_CHECK_MS = 10 * 60 * 1000;
const PK_MS = 3 * 24 * 60 * 60 * 1000;
const BAN_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;
let lastDriftCheck = 0;

export function runSchedulers({ client, db }) {
  // every 60s
  setInterval(() => tick({ client, db }).catch((err) => console.error("[SCHEDULER] tick failed:", err)), 60 * 1000);
  // immediate
  tick({ client, db }).catch((err) => console.error("[SCHEDULER] initial tick failed:", err));
}

function setWarnStatusLine(description, statusLine) {
  const lines = description ? description.split("\n") : [];
  const idx = lines.findIndex(line => line.startsWith("Status:"));
  if (idx >= 0) {
    lines[idx] = statusLine;
  } else {
    lines.push(statusLine);
  }
  return lines.join("\n");
}

async function tick({ client, db }) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  // Expire cooldowns
  const now = Date.now();
  const expCooldowns = listExpiringCooldowns(db, now);
  const pkRole = getSetting(db, 'pk_role_id');
  const banRole = getSetting(db, 'ban_role_id');
  for (const cd of expCooldowns) {
    const member = await guild.members.fetch(cd.user_id).catch(() => null);
    if (member) {
      if (cd.kind === 'PK' && pkRole && member.roles.cache.has(pkRole)) {
        const removed = await member.roles.remove(pkRole).catch((err) => {
          console.error(`[SCHEDULER] PK remove failed for ${cd.user_id}:`, err);
          return false;
        });
        if (!removed) continue;
      }
      if (cd.kind === 'BAN' && banRole && member.roles.cache.has(banRole)) {
        const removed = await member.roles.remove(banRole).catch((err) => {
          console.error(`[SCHEDULER] BAN remove failed for ${cd.user_id}:`, err);
          return false;
        });
        if (!removed) continue;
      }
    }
    clearCooldown(db, cd.user_id, cd.kind);
  }

  // Expire warns: edit message + mark EXPIRED
  const warnChannelId = getSetting(db, 'warn_channel_id');
  if (warnChannelId) {
    const channel = await guild.channels.fetch(warnChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const expWarns = listExpiringWarns(db, now);
      for (const w of expWarns) {
        try {
          const msg = await channel.messages.fetch(w.message_id).catch(() => null);
          if (msg) {
            const embed = msg.embeds?.[0];
            const eb = new EmbedBuilder(embed?.data ?? {});
            const nextDesc = setWarnStatusLine(eb.data.description || "", "Status: 🟥 EXPIRATĂ");
            eb.setDescription(nextDesc)
              .setColor(COLORS.ERROR)
              .setFooter({ text: `EXPIRATĂ • ${new Date().toISOString()}` });
            await msg.edit({ embeds: [eb] }).catch(() => {});
          }
          setWarnStatus(db, w.warn_id, 'EXPIRED');
        } catch {
          // ignore
        }
      }

    }
  }

  const nowTs = Date.now();
  if (nowTs - lastDriftCheck >= DRIFT_CHECK_MS) {
    lastDriftCheck = nowTs;
    await driftCheckCooldownRoles({ guild, db, nowTs });
  }
}

async function driftCheckCooldownRoles({ guild, db, nowTs }) {
  const pkRole = getSetting(db, 'pk_role_id');
  const banRole = getSetting(db, 'ban_role_id');
  if (!pkRole && !banRole) return;

  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    console.error('[SCHEDULER] cooldown drift fetch failed:', err);
    return;
  }

  const pkRows = listCooldowns(db, 'PK');
  const banRows = listCooldowns(db, 'BAN');
  const pkMap = new Map(pkRows.map(r => [r.user_id, r]));
  const banMap = new Map(banRows.map(r => [r.user_id, r]));

  if (pkRole) {
    for (const row of pkRows) {
      if (row.expires_at <= nowTs) continue;
      const member = members.get(row.user_id);
      if (member && !member.roles.cache.has(pkRole)) {
        await member.roles.add(pkRole).catch((err) => {
          console.error(`[SCHEDULER] PK drift add failed for ${row.user_id}:`, err);
        });
      }
    }
    for (const member of members.values()) {
      if (!member.roles.cache.has(pkRole)) continue;
      if (!pkMap.has(member.id)) {
        const expiresAt = nowTs + PK_MS;
        upsertCooldown(db, member.id, 'PK', expiresAt, null, nowTs);
      }
    }
  }

  if (banRole) {
    for (const row of banRows) {
      if (row.expires_at <= nowTs) continue;
      const member = members.get(row.user_id);
      if (member && !member.roles.cache.has(banRole)) {
        await member.roles.add(banRole).catch((err) => {
          console.error(`[SCHEDULER] BAN drift add failed for ${row.user_id}:`, err);
        });
      }
    }
    for (const member of members.values()) {
      if (!member.roles.cache.has(banRole)) continue;
      if (!banMap.has(member.id)) {
        const expiresAt = nowTs + BAN_MS_DEFAULT;
        upsertCooldown(db, member.id, 'BAN', expiresAt, null, nowTs);
      }
    }
  }
}
