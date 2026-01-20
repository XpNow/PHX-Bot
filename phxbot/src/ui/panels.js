import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} from 'discord.js';
import { orgColor, COLORS } from './theme.js';

export function accessDeniedPanel() {
  const embed = new EmbedBuilder()
    .setColor(COLORS.ERROR)
    .setTitle('⛔ Access Denied')
    .setDescription('Nu ai acces la acest meniu.');
  return { embeds: [embed], components: [] };
}

export function fmenuRootPanel({ ctx, stats = null }) {
  // ctx: actor context
  if (ctx.isAdmin || ctx.isSupervisor) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.GLOBAL)
      .setTitle('🛠️ CONTROL CENTER — GLOBAL')
      .setDescription(`Acces: **${ctx.isSupervisor ? 'Supervisor' : 'Admin'}**`)
      .addFields(
        { name: 'Quick Stats', value: stats ? `PK: **${stats.pk}** • BAN: **${stats.ban}** • Lockdowns: **${stats.lockdowns}**` : '—', inline: false }
      );

    const select = new StringSelectMenuBuilder()
      .setCustomId('fmenu:select:root')
      .setPlaceholder('Alege o sectiune...')
      .addOptions(
        { label: 'MAFIA PANEL', value: 'div:MAFIA', emoji: '🕶️' },
        { label: 'LEGAL PANEL', value: 'div:LEGAL', emoji: '🚓' },
        { label: 'Global Overview', value: 'global:overview', emoji: '🌍' },
        { label: 'Config', value: 'global:config', emoji: '⚙️' },
        { label: 'Diagnostics', value: 'global:diag', emoji: '🩺' }
      );

    if (ctx.canWarnManage) {
      select.addOptions({ label: 'Warns (Supervisor)', value: 'global:warns', emoji: '⚠️' });
    }

    return {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(select)]
    };
  }

  // Manager scoped
  if (ctx.org) {
    const embed = new EmbedBuilder()
      .setColor(orgColor(ctx.org))
      .setTitle(`${ctx.org.type === 'MAFIA' ? '🕶️ MAFIA PANEL' : '🚓 LEGAL PANEL'} — ${ctx.org.name}`)
      .setDescription(`Scope: **${ctx.org.name} only**`)
      .addFields(
        { name: 'Role', value: `**${ctx.rankKey || 'MEMBER'}**`, inline: true },
        { name: 'Status', value: '✅ Active', inline: true }
      );

    const select = new StringSelectMenuBuilder()
      .setCustomId(`fmenu:select:org:${ctx.org.org_id}`)
      .setPlaceholder('Alege o sectiune...')
      .addOptions(
        { label: 'Roster', value: 'org:roster', emoji: '📋' },
        { label: 'Actions', value: 'org:actions', emoji: '⚙️' },
        { label: 'Cooldowns', value: 'org:cooldowns', emoji: '⏳' },
        { label: 'Search Player', value: 'org:search', emoji: '🔎' }
      );

    if (ctx.org.type === 'MAFIA') {
      select.addOptions({ label: 'Falert', value: 'org:falert', emoji: '🚨' });
    }

    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
  }

  return accessDeniedPanel();
}

export function placeholderPanel(title, desc, color) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc);
  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(back)] };
}

export function simpleOk(content) {
  return { content, ephemeral: true };
}

export function simpleErr(content) {
  return { content, ephemeral: true };
}
