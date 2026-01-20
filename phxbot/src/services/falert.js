import { getSetting, setSetting } from '../db/db.js';
import { addAudit, listOrgs } from '../db/repo.js';
import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../ui/theme.js';

function minutesFromNowIso(mins) {
  const d = new Date();
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString();
}

function msUntil(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (t - Date.now()) : 0;
}

export async function sendFalert({ client, db, interaction, actor, locatie, detalii, ctx }) {
  const cdMin = parseInt(getSetting(db, 'FALERT_COOLDOWN_MIN', '30'), 10);
  const nextAt = getSetting(db, 'FALERT_NEXT_AT', '');
  if (nextAt) {
    const ms = msUntil(nextAt);
    if (ms > 0) {
      const mins = Math.ceil(ms / 60000);
      return { content: `Falert indisponibil: mai sunt ${mins}m pana se termina cooldown.`, ephemeral: true };
    }
  }

  // Determine channel to post: use AUDIT_CHANNEL_ID as default for alerts, or a separate key
  const alertChannelId = getSetting(db, 'ALERT_CHANNEL_ID', '') || getSetting(db, 'AUDIT_CHANNEL_ID', '');
  if (!alertChannelId) {
    return { content: 'ALERT_CHANNEL_ID/AUDIT_CHANNEL_ID nu este setat in config.', ephemeral: true };
  }

  const channel = await interaction.guild.channels.fetch(alertChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { content: 'Canalul de alerta este invalid sau nu e text.', ephemeral: true };
  }

  // Ping all mafia org base roles (2 pings separate)
  const mafiaOrgs = listOrgs(db, 'MAFIA');
  const roleMentions = mafiaOrgs
    .filter(o => o.base_role_id)
    .map(o => `<@&${o.base_role_id}>`);

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARN)
    .setTitle('🚨 ALERTA RAZIE')
    .setDescription('Toate factiunile, mobilizare imediata!')
    .addFields(
      { name: '📍 Locatie', value: locatie, inline: false },
      { name: '📝 Detalii', value: detalii || '—', inline: false },
      { name: '👤 Raportat de', value: `${actor} (ID: ${actor.id})`, inline: false }
    )
    .setFooter({ text: `Global cooldown activ: ${cdMin} min` })
    .setTimestamp(new Date());

  // send pings in two separate messages (requirement)
  const pingText = roleMentions.join(' ');
  if (pingText) {
    await channel.send({ content: pingText }).catch(() => {});
    await channel.send({ content: pingText }).catch(() => {});
  }
  await channel.send({ embeds: [embed] }).catch(() => {});

  setSetting(db, 'FALERT_NEXT_AT', minutesFromNowIso(cdMin));
  addAudit(db, 'FALERT', actor.id, null, ctx.org?.org_id || null, { locatie, detalii, cooldown_min: cdMin, alertChannelId });

  return { content: '✅ Falert trimis. Cooldown global activ.', ephemeral: true };
}
