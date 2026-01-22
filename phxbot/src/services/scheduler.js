import { listExpiringCooldowns, listExpiringWarns, setWarnStatus, clearCooldown } from '../db/repo.js';
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

  const buildWarnEmbed = (payload, warnId, expiresAt) => {
    const lines = [
      `Organizație: ${payload?.org_role_id ? `<@&${payload.org_role_id}>` : (payload?.org_name || "—")}`,
      `Motiv: ${payload?.reason || "—"}`,
      `DREPT PLATA: ${payload?.drept_plata ? "DA" : "NU"}`,
      `SANCTIUNEA OFERITA: ${payload?.sanctiune || "—"}`,
      `Expiră: ${expiresAt ? `<t:${Math.floor(expiresAt/1000)}:f>` : "—"}`,
      `TOTAL WARN: ${payload?.total_warn || "—"}`
    ];
    const emb = new EmbedBuilder().setTitle("⚠️ WARN").setDescription(lines.join("\n"));
    if (warnId) emb.setFooter({ text: `WARN ID: ${warnId}` });
    return emb;
  };

  // Expire cooldowns
  const now = Date.now();
  const expCooldowns = listExpiringCooldowns(db, now);
  const pkRole = getSetting(db, 'pk_role_id');
  const banRole = getSetting(db, 'ban_role_id');
  for (const cd of expCooldowns) {
    const member = await guild.members.fetch(cd.user_id).catch(() => null);
    if (member) {
      if (cd.kind === 'PK' && pkRole) await member.roles.remove(pkRole).catch(() => {});
      if (cd.kind === 'BAN' && banRole) await member.roles.remove(banRole).catch(() => {});
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
