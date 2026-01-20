import { listExpiringCooldowns, listExpiringWarns, setWarnStatus } from '../db/repo.js';
import { clearExpiredCooldownForUser } from './orgService.js';
import { getSetting } from '../db/db.js';
import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../ui/theme.js';

export function runSchedulers({ client, db }) {
  // every 60s
  setInterval(() => tick({ client, db }).catch(() => {}), 60 * 1000);
  // immediate
  tick({ client, db }).catch(() => {});
}

async function tick({ client, db }) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  // Expire cooldowns
  const expCooldowns = listExpiringCooldowns(db);
  for (const cd of expCooldowns) {
    await clearExpiredCooldownForUser({ db, guild, userId: cd.user_id });
  }

  // Expire warns: edit message + mark EXPIRED
  const warnChannelId = getSetting(db, 'WARN_CHANNEL_ID', '');
  if (warnChannelId) {
    const channel = await guild.channels.fetch(warnChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const expWarns = listExpiringWarns(db);
      for (const w of expWarns) {
        try {
          const msg = await channel.messages.fetch(w.message_id).catch(() => null);
          if (msg) {
            const embed = msg.embeds?.[0];
            const eb = new EmbedBuilder(embed?.data ?? {})
              .setColor(COLORS.WARN)
              .setFooter({ text: (embed?.footer?.text || '') + ` • STATUS: EXPIRAT la ${new Date().toISOString()}` });
            await msg.edit({ embeds: [eb] }).catch(() => {});
          }
          setWarnStatus(db, w.warn_id, 'EXPIRED');
        } catch {
          // ignore
        }
      }
    }
  }
}
