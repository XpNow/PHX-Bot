import { listExpiringCooldowns, listExpiringWarns, setWarnStatus, clearCooldown } from '../db/repo.js';
import { getSetting } from '../db/db.js';
import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../ui/theme.js';

export function runSchedulers({ client, db }) {
  setInterval(() => tick({ client, db }).catch(() => {}), 60 * 1000);
  tick({ client, db }).catch(() => {});
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
        }
      }

    }
  }
}
