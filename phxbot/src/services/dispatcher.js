import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder
} from 'discord.js';
import { getActorContext, canUseFmenu, canManageMembers, canFalert } from '../util/access.js';
import { fmenuRootPanel, accessDeniedPanel, placeholderPanel, simpleErr, simpleOk } from '../ui/panels.js';
import {
  listOrgs,
  getOrgById,
  getCooldown,
  getMembership,
  getLastOrg,
  addAudit,
  upsertOrg,
  upsertOrgRank,
  deleteOrg,
  countOrgsByType,
  countMembersByOrgType,
  listMembershipsByOrg,
  listCooldownsByOrg
} from '../db/repo.js';
import { getSetting, setSetting } from '../db/db.js';
import { orgColor, COLORS } from '../ui/theme.js';
import { addMemberToOrg, removeMemberFromOrg } from './orgService.js';
import { sendFalert } from './falert.js';

// In-memory pending flows (ephemeral UI). Safe for single-process bot.
// (Kept for future multi-step flows; current build uses only modals + Copy ID.)

const PER_PAGE = 15;


export async function handleSlashCommand({ client, db, interaction }) {
  if (interaction.commandName === 'fmenu') {
    await interaction.deferReply({ ephemeral: true });
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const ctx = getActorContext(db, member, interaction.guild.ownerId);
    if (!canUseFmenu(ctx)) {
      await interaction.editReply(accessDeniedPanel());
      return;
    }
    const stats = await computeQuickStats(db);
    await interaction.editReply(fmenuRootPanel({ ctx, stats }));
    return;
  }

  if (interaction.commandName === 'falert') {
    await interaction.deferReply({ ephemeral: true });
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const ctx = getActorContext(db, member, interaction.guild.ownerId);
    if (!canFalert(ctx)) {
      await interaction.editReply(simpleErr('Nu ai acces la /falert.'));
      return;
    }
    const locatie = interaction.options.getString('locatie', true);
    const detalii = interaction.options.getString('detalii', false) || '';
    const res = await sendFalert({ client, db, interaction, actor: interaction.user, locatie, detalii, ctx });
    await interaction.editReply(res);
    return;
  }
}

export async function handleComponentInteraction({ client, db, interaction }) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const ctx = getActorContext(db, member, interaction.guild.ownerId);

  // Back to root
  if (interaction.customId === 'fmenu:back:root') {
    await interaction.update(fmenuRootPanel({ ctx, stats: await computeQuickStats(db) }));
    return;
  }

  // Config back buttons
  if (interaction.isButton() && interaction.customId === 'global:config:back') {
    await interaction.update(configPanel({ db, ctx }));
    return;
  }
  if (interaction.isButton() && interaction.customId === 'cfg:org:back:list') {
    await interaction.update(configOrgsPanel({ db, ctx }));
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('cfg:org:back:')) {
    const orgId = interaction.customId.split(':').pop();
    const org = getOrgById(db, orgId);
    await interaction.update(configOrgDetailPanel({ db, org }));
    return;
  }

  // Root select (admin/sup)
  if (interaction.isStringSelectMenu() && interaction.customId === 'fmenu:select:root') {
    const v = interaction.values[0];
    if (v.startsWith('div:')) {
      const type = v.split(':')[1];
      await interaction.update(orgPickerPanel({ db, ctx, type }));
      return;
    }
    if (v === 'global:overview') {
      await interaction.update(globalOverviewPanel({ db, ctx }));
      return;
    }
    if (v === 'global:config') {
      await interaction.update(configPanel({ db, ctx }));
      return;
    }
    if (v === 'global:diag') {
      await interaction.update(diagnosticsPanel({ db, ctx, guild: interaction.guild }));
      return;
    }
    if (v === 'global:warns') {
      if (!ctx.canWarnManage) {
        await interaction.reply({ content: 'Nu ai acces la Warns.', ephemeral: true });
        return;
      }
      await interaction.update(placeholderPanel('⚠️ Warns', 'Warns panel (v0.1 starter).', COLORS.WARN));
      return;
    }
  }

  // Config section select
  if (interaction.isStringSelectMenu() && interaction.customId === 'fmenu:select:config') {
    const v = interaction.values[0];
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.reply({ content: 'Nu ai acces la Config.', ephemeral: true });
      return;
    }
    if (v === 'cfg:channels') {
      await interaction.update(configChannelsPanel({ db, ctx }));
      return;
    }
    if (v === 'cfg:roles') {
      await interaction.update(configRolesPanel({ db, ctx }));
      return;
    }
    if (v === 'cfg:orgs') {
      await interaction.update(configOrgsPanel({ db, ctx }));
      return;
    }
    if (v === 'cfg:ratelimits') {
      await interaction.update(placeholderPanel('⏱️ Rate Limits', 'Rate limits UI (coming next). Pentru moment se poate seta din DB.', COLORS.GLOBAL));
      return;
    }
  }

  // Config: quick-set by ID buttons (channels/roles) - works even if select menus are buggy on some clients
  if (interaction.isButton() && interaction.customId.startsWith('cfg:set:')) {
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.reply({ content: 'Nu ai acces.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split(':'); // cfg:set:channel:audit OR cfg:set:role:admin
    const kind = parts[2];
    const key = parts[3];
    if (kind === 'channel') {
      await interaction.showModal(setIdModal(`modal:cfg:set_channel:${key}`, `Set ${key.toUpperCase()} channel ID`, 'Channel ID (Copy ID)', 'Ex: 1452095867573239891'));
      return;
    }
    if (kind === 'role') {
      await interaction.showModal(setIdModal(`modal:cfg:set_role:${key}`, `Set ${key.toUpperCase()} role ID`, 'Role ID (Copy ID)', 'Ex: 1446223790014206075'));
      return;
    }
  }

  // Config orgs: buttons
  if (interaction.isButton() && interaction.customId === 'cfg:org:create') {
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.reply({ content: 'Nu ai acces.', ephemeral: true });
      return;
    }
    await interaction.showModal(createOrgModal());
    return;
  }

  if (interaction.isButton() && interaction.customId === 'cfg:org:delete') {
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.reply({ content: 'Nu ai acces.', ephemeral: true });
      return;
    }
    await interaction.showModal(deleteOrgModal());
    return;
  }

  // Config orgs: pick org to edit
  if (interaction.isStringSelectMenu() && interaction.customId === 'cfg:org:pick') {
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.reply({ content: 'Nu ai acces.', ephemeral: true });
      return;
    }
    const orgId = interaction.values[0];
    const org = getOrgById(db, orgId);
    await interaction.update(configOrgDetailPanel({ db, ctx, org }));
    return;
  }

  // Org detail: add rank
  if (interaction.isButton() && interaction.customId.startsWith('cfg:org:addrank:')) {
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.reply({ content: 'Nu ai acces.', ephemeral: true });
      return;
    }
    const orgId = interaction.customId.split(':').pop();
    await interaction.showModal(addRankModal(orgId));
    return;
  }

  // (Rank mapping uses Copy ID via modal; no RoleSelect flows.)

  // Org picker selection (admin)
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('fmenu:pickorg:')) {
    const orgId = interaction.values[0];
    const org = getOrgById(db, orgId);
    await interaction.update(orgPanel({ db, ctx, org }));
    return;
  }

  // Org section select (scoped)
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('fmenu:select:org:')) {
    const orgId = interaction.customId.split(':').pop();
    const org = getOrgById(db, orgId);
    const v = interaction.values[0];
    if (v === 'org:roster') {
      await interaction.update(rosterPanel({ db, ctx, org, page: 0 }));
      return;
    }
    if (v === 'org:actions') {
      await interaction.update(orgActionsPanel({ db, ctx, org }));
      return;
    }
    if (v === 'org:cooldowns') {
      await interaction.update(cooldownsPanel({ db, ctx, org, page: 0 }));
      return;
    }
    if (v === 'org:search') {
      await interaction.showModal(searchModal(orgId));
      return;
    }
    if (v === 'org:falert') {
      if (!canFalert(ctx)) {
        await interaction.reply({ content: 'Nu ai acces la Falert.', ephemeral: true });
        return;
      }
      await interaction.showModal(falertModal());
      return;
    }
  }

  // Roster pagination
  if (interaction.isButton() && interaction.customId.startsWith('org:roster:')) {
    const parts = interaction.customId.split(':');
    const orgId = parts[2];
    const page = parseInt(parts[3] || '0', 10);
    const org = getOrgById(db, orgId);
    await interaction.update(rosterPanel({ db, ctx, org, page }));
    return;
  }

  // Cooldowns pagination
  if (interaction.isButton() && interaction.customId.startsWith('org:cooldowns:')) {
    const parts = interaction.customId.split(':');
    const orgId = parts[2];
    const page = parseInt(parts[3] || '0', 10);
    const org = getOrgById(db, orgId);
    await interaction.update(cooldownsPanel({ db, ctx, org, page }));
    return;
  }

  // Action buttons
  if (interaction.isButton() && interaction.customId.startsWith('org:btn:')) {
    const [, , action, orgId] = interaction.customId.split(':');
    const org = getOrgById(db, orgId);
    if (!org) {
      await interaction.reply({ content: 'Org invalid.', ephemeral: true });
      return;
    }
    if (!canManageMembers(ctx, org)) {
      await interaction.reply({ content: 'Nu ai acces la aceasta actiune.', ephemeral: true });
      return;
    }
    if (action === 'add') {
      await interaction.showModal(addMemberModal(orgId));
      return;
    }
    if (action === 'rem') {
      await interaction.showModal(removeMemberModal(orgId, false));
      return;
    }
    if (action === 'pk') {
      await interaction.showModal(removeMemberModal(orgId, true));
      return;
    }
  }
}

export async function handleModalSubmit({ client, db, interaction }) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const ctx = getActorContext(db, member, interaction.guild.ownerId);

  // ----- Config modals -----
  if (interaction.customId.startsWith('modal:cfg:set_channel:')) {
    await interaction.deferReply({ ephemeral: true });
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    const key = interaction.customId.split(':').pop();
    const val = (interaction.fields.getTextInputValue('id') || '').trim();
    const m = val.match(/\d{17,20}/);
    if (!m) {
      await interaction.editReply('ID invalid. Foloseste Copy ID din Discord.');
      return;
    }
    const map = { audit: 'AUDIT_CHANNEL_ID', alert: 'ALERT_CHANNEL_ID', warn: 'WARN_CHANNEL_ID', error: 'ERROR_CHANNEL_ID' };
    if (map[key]) setSetting(db, map[key], m[0]);
    await interaction.editReply({ content: '✅ Salvat.', ephemeral: true });
    return;
  }

  if (interaction.customId.startsWith('modal:cfg:set_role:')) {
    await interaction.deferReply({ ephemeral: true });
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    const key = interaction.customId.split(':').pop();
    const val = (interaction.fields.getTextInputValue('id') || '').trim();
    const m = val.match(/\d{17,20}/);
    if (!m) {
      await interaction.editReply('ID invalid. Foloseste Copy ID din Discord.');
      return;
    }
    const map = { admin: 'ROLE_ADMIN_ID', supervisor: 'ROLE_SUPERVISOR_ID', warn: 'ROLE_WARN_MANAGER_ID', pk: 'ROLE_PK_ID', ban: 'ROLE_BAN_ID' };
    if (map[key]) setSetting(db, map[key], m[0]);
    await interaction.editReply({ content: '✅ Salvat.', ephemeral: true });
    return;
  }
  if (interaction.customId === 'modal:cfg:create_org') {
    await interaction.deferReply({ ephemeral: true });
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    const orgId = interaction.fields.getTextInputValue('org_id').trim().toLowerCase();
    const name = interaction.fields.getTextInputValue('name').trim();
    const type = interaction.fields.getTextInputValue('type').trim().toUpperCase();
    const baseRoleRaw = (interaction.fields.getTextInputValue('base_role_id') || '').trim();
    const baseRoleMatch = baseRoleRaw.match(/[0-9]{17,20}/);
    const baseRoleId = baseRoleMatch ? baseRoleMatch[0] : null;
    if (!/^[a-z0-9_-]{2,32}$/.test(orgId)) {
      await interaction.editReply('Org ID invalid. Foloseste doar litere mici, cifre, _ sau - (2-32).');
      return;
    }
    if (!['MAFIA','LEGAL'].includes(type)) {
      await interaction.editReply('Type invalid. Scrie MAFIA sau LEGAL.');
      return;
    }
    upsertOrg(db, { org_id: orgId, name, type, base_role_id: baseRoleId, is_active: 1 });
    addAudit(db, 'CONFIG_CREATE_ORG', interaction.user.id, null, orgId, { name, type, base_role_id: baseRoleId });
    await interaction.editReply({ content: `✅ Organizatia **${name}** a fost creata.`, ephemeral: true });
    return;
  }

  if (interaction.customId === 'modal:cfg:delete_org') {
    await interaction.deferReply({ ephemeral: true });
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    const orgId = interaction.fields.getTextInputValue('org_id').trim();
    const org = getOrgById(db, orgId);
    if (!org) {
      await interaction.editReply('Org ID inexistent.');
      return;
    }
    deleteOrg(db, orgId);
    addAudit(db, 'CONFIG_DELETE_ORG', interaction.user.id, null, orgId, { name: org.name });
    await interaction.editReply({ content: `✅ Organizatia **${org.name}** a fost stearsa.`, ephemeral: true });
    return;
  }

  if (interaction.customId.startsWith('modal:cfg:addrank:')) {
    await interaction.deferReply({ ephemeral: true });
    if (!(ctx.isAdmin || ctx.isSupervisor)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    const orgId = interaction.customId.split(':').pop();
    const org = getOrgById(db, orgId);
    if (!org) {
      await interaction.editReply('Org invalid.');
      return;
    }
    const rankKey = interaction.fields.getTextInputValue('rank_key').trim().toUpperCase();
    const levelRaw = interaction.fields.getTextInputValue('level').trim();
    const level = Number(levelRaw);
    if (!/^[A-Z0-9_]{2,24}$/.test(rankKey)) {
      await interaction.editReply('Rank key invalid. Exemplu: LEADER, COLEADER, MEMBER, CHIEF, HR, DIRECTOR, DEPUTY');
      return;
    }
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      await interaction.editReply('Level invalid. Foloseste un numar intreg 0-100 (mai mare = mai sus).');
      return;
    }
    const roleRaw = (interaction.fields.getTextInputValue('role_id') || '').trim();
    const roleMatch = roleRaw.match(/[0-9]{17,20}/);
    if (!roleMatch) {
      await interaction.editReply('Role ID invalid. Foloseste Copy ID din Discord (trebuie pus obligatoriu).');
      return;
    }
    upsertOrgRank(db, { org_id: orgId, rank_key: rankKey, role_id: roleMatch[0], level });
    addAudit(db, 'CONFIG_UPSERT_RANK', interaction.user.id, null, orgId, { org_id: orgId, rank_key: rankKey, level, role_id: roleMatch[0] });
    await interaction.editReply({ content: '✅ Rank mapping salvat.', ephemeral: true });
    return;
  }

  if (interaction.customId.startsWith('modal:add:')) {
    await interaction.deferReply({ ephemeral: true });
    const orgId = interaction.customId.split(':').pop();
    const org = getOrgById(db, orgId);
    const target = parseUserId(interaction.fields.getTextInputValue('user'));
    if (!target) {
      await interaction.editReply('User invalid. Foloseste mention sau ID.');
      return;
    }
    if (!canManageMembers(ctx, org)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    try {
      await addMemberToOrg({ db, guild: interaction.guild, actor: interaction.user, targetUserId: target, org });
      await interaction.editReply(`✅ Added <@${target}> in **${org.name}**.`);
    } catch (e) {
      await interaction.editReply(`❌ ${e.message}`);
    }
    return;
  }

  if (interaction.customId.startsWith('modal:rem:')) {
    await interaction.deferReply({ ephemeral: true });
    const parts = interaction.customId.split(':');
    const orgId = parts[2];
    const pk = parts[3] === '1';
    const org = getOrgById(db, orgId);
    const target = parseUserId(interaction.fields.getTextInputValue('user'));
    if (!target) {
      await interaction.editReply('User invalid. Foloseste mention sau ID.');
      return;
    }
    if (!canManageMembers(ctx, org)) {
      await interaction.editReply('Nu ai acces.');
      return;
    }
    try {
      await removeMemberFromOrg({ db, guild: interaction.guild, actor: interaction.user, targetUserId: target, org, withPk: pk });
      await interaction.editReply(`✅ Removed <@${target}> din **${org.name}**${pk ? ' (PK cooldown)' : ''}.`);
    } catch (e) {
      await interaction.editReply(`❌ ${e.message}`);
    }
    return;
  }

  if (interaction.customId.startsWith('modal:search:')) {
    await interaction.deferReply({ ephemeral: true });
    const orgId = interaction.customId.split(':').pop();
    const org = getOrgById(db, orgId);
    const target = parseUserId(interaction.fields.getTextInputValue('user'));
    if (!target) {
      await interaction.editReply('User invalid.');
      return;
    }
    const view = buildSearchResultEmbed({ db, ctx, org, targetUserId: target });
    await interaction.editReply(view);
    return;
  }

  if (interaction.customId === 'modal:falert') {
    await interaction.deferReply({ ephemeral: true });
    const locatie = interaction.fields.getTextInputValue('locatie');
    const detalii = interaction.fields.getTextInputValue('detalii') || '';
    if (!canFalert(ctx)) {
      await interaction.editReply('Nu ai acces la Falert.');
      return;
    }
    const res = await sendFalert({ client, db, interaction, actor: interaction.user, locatie, detalii, ctx });
    await interaction.editReply(res);
  }
}

function orgPickerPanel({ db, ctx, type }) {
  const orgs = listOrgs(db, type);
  const embed = new EmbedBuilder()
    .setColor(type === 'MAFIA' ? COLORS.MAFIA : COLORS.LSPD)
    .setTitle(type === 'MAFIA' ? '🕶️ MAFIA — Select Org' : '🚓 LEGAL — Select Org')
    .setDescription('Alege organizatia pe care vrei sa o administrezi.');

  const select = new StringSelectMenuBuilder()
    .setCustomId(`fmenu:pickorg:${type}`)
    .setPlaceholder('Alege organizatia...')
    .addOptions(orgs.slice(0, 25).map(o => ({ label: o.name, value: o.org_id })));

  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back)] };
}

function orgPanel({ db, ctx, org }) {
  // If admin: create a temporary ctx scoped to org for rendering
  const scopedCtx = (ctx.isAdmin || ctx.isSupervisor) ? { ...ctx, org, rankKey: org.type === 'MAFIA' ? 'LEADER' : 'CHIEF' } : ctx;
  return fmenuRootPanel({ ctx: scopedCtx });
}

function orgActionsPanel({ db, ctx, org }) {
  const embed = new EmbedBuilder()
    .setColor(orgColor(org))
    .setTitle(`⚙️ Actions — ${org.name}`)
    .setDescription('Alege o actiune.');

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`org:btn:add:${org.org_id}`).setLabel('➕ Add Member').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`org:btn:rem:${org.org_id}`).setLabel('➖ Remove').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`org:btn:pk:${org.org_id}`).setLabel('💀 Remove (PK)').setStyle(ButtonStyle.Danger)
  );
  const back = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row1, back] };
}

function rosterPanel({ db, ctx, org, page = 0 }) {
  const perPage = 15;
  const all = listMembershipsByOrg(db, org.org_id);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = all.slice(p * perPage, p * perPage + perPage);

  const embed = new EmbedBuilder()
    .setColor(orgColor(org))
    .setTitle(`📋 Roster — ${org.name}`)
    .setDescription(`Total: **${total}** • Page **${p + 1}/${pages}**`);

  const lines = slice.map((m, i) => `${p * perPage + i + 1}) <@${m.user_id}> — **${m.rank_key}**`);
  embed.addFields({ name: 'Members', value: lines.length ? lines.join('\n') : '—', inline: false });

  const prev = new ButtonBuilder().setCustomId(`org:roster:${org.org_id}:${Math.max(0, p - 1)}`).setLabel('⬅️ Prev').setStyle(ButtonStyle.Secondary).setDisabled(p === 0);
  const next = new ButtonBuilder().setCustomId(`org:roster:${org.org_id}:${Math.min(pages - 1, p + 1)}`).setLabel('➡️ Next').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1);
  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(prev, next, back)] };
}

function cooldownsPanel({ db, ctx, org, page = 0 }) {
  const perPage = 15;
  const all = listCooldownsByOrg(db, org.org_id);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = all.slice(p * perPage, p * perPage + perPage);

  const embed = new EmbedBuilder()
    .setColor(COLORS.COOLDOWN)
    .setTitle(`⏳ Cooldowns — ${org.name}`)
    .setDescription(`Total: **${total}** • Page **${p + 1}/${pages}**`);

  const lines = slice.map((c, i) => `${p * perPage + i + 1}) <@${c.user_id}> — **${c.type}** • expires: ${c.expires_at || '—'}`);
  embed.addFields({ name: 'Cooldowns', value: lines.length ? lines.join('\n') : '—', inline: false });

  const prev = new ButtonBuilder().setCustomId(`org:cooldowns:${org.org_id}:${Math.max(0, p - 1)}`).setLabel('⬅️ Prev').setStyle(ButtonStyle.Secondary).setDisabled(p === 0);
  const next = new ButtonBuilder().setCustomId(`org:cooldowns:${org.org_id}:${Math.min(pages - 1, p + 1)}`).setLabel('➡️ Next').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1);
  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(prev, next, back)] };
}

function globalOverviewPanel({ db, ctx }) {
  const orgCounts = countOrgsByType(db);
  const memberCounts = countMembersByOrgType(db);
  const stats = { pk: countByCooldown(db, 'PK'), ban: countByCooldown(db, 'BAN'), lockdowns: countLockdowns(db) };
  const embed = new EmbedBuilder()
    .setColor(COLORS.GLOBAL)
    .setTitle('🌍 Global Overview')
    .addFields(
      { name: 'Orgs', value: `MAFIA: **${orgCounts.MAFIA}**\nLEGAL: **${orgCounts.LEGAL}**\nTOTAL: **${orgCounts.TOTAL}**`, inline: true },
      { name: 'Members', value: `MAFIA: **${memberCounts.MAFIA}**\nLEGAL: **${memberCounts.LEGAL}**\nTOTAL: **${memberCounts.TOTAL}**`, inline: true },
      { name: 'Cooldown PK', value: String(stats.pk), inline: true },
      { name: 'Ban Orgs', value: String(stats.ban), inline: true },
      { name: 'Lockdowns', value: String(stats.lockdowns), inline: true }
    );
  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(back)] };
}

function configPanel({ db, ctx }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.GLOBAL)
    .setTitle('⚙️ Config')
    .setDescription('Seteaza canale, roluri si organizatii direct din Discord. (Ephemeral)')
    .addFields(
      { name: 'Audit Channel', value: fmtId(getSetting(db, 'AUDIT_CHANNEL_ID', '')), inline: true },
      { name: 'Alert Channel', value: fmtId(getSetting(db, 'ALERT_CHANNEL_ID', '')), inline: true },
      { name: 'Warn Channel', value: fmtId(getSetting(db, 'WARN_CHANNEL_ID', '')), inline: true },
      { name: 'Admin Role', value: fmtId(getSetting(db, 'ROLE_ADMIN_ID', '')), inline: true },
      { name: 'Supervisor Role', value: fmtId(getSetting(db, 'ROLE_SUPERVISOR_ID', '')), inline: true },
      { name: 'PK Role', value: fmtId(getSetting(db, 'ROLE_PK_ID', '')), inline: true },
      { name: 'Ban Role', value: fmtId(getSetting(db, 'ROLE_BAN_ID', '')), inline: true }
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId('fmenu:select:config')
    .setPlaceholder('Alege o sectiune...')
    .addOptions(
      { label: 'Channels', value: 'cfg:channels', description: 'Seteaza canalele pentru audit/alerts/warns' },
      { label: 'Access Roles', value: 'cfg:roles', description: 'Seteaza rolurile pentru Admin/Supervisor/PK/Ban' },
      { label: 'Organizations', value: 'cfg:orgs', description: 'Creeaza/sterge orgs + rank mapping' },
      { label: 'Rate Limits', value: 'cfg:ratelimits', description: 'Limite actiuni (in lucru)' }
    );

  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(back)] };
}

function configChannelsPanel({ db }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.GLOBAL)
    .setTitle('⚙️ Config — Channels')
    .setDescription('Paste ID-urile canalelor (Copy ID). Metoda asta e 100% stabila si nu loveste limitele Discord UI.')
    .addFields(
      { name: 'AUDIT_CHANNEL_ID', value: fmtChannel(getSetting(db, 'AUDIT_CHANNEL_ID', '')), inline: false },
      { name: 'ALERT_CHANNEL_ID', value: fmtChannel(getSetting(db, 'ALERT_CHANNEL_ID', '')), inline: false },
      { name: 'WARN_CHANNEL_ID', value: fmtChannel(getSetting(db, 'WARN_CHANNEL_ID', '')), inline: false },
      { name: 'ERROR_CHANNEL_ID', value: fmtChannel(getSetting(db, 'ERROR_CHANNEL_ID', '')), inline: false }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg:set:channel:audit').setLabel('✏️ Audit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:channel:alert').setLabel('✏️ Alert').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:channel:warn').setLabel('✏️ Warn').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:channel:error').setLabel('✏️ Error').setStyle(ButtonStyle.Secondary)
  );
  const back = new ButtonBuilder().setCustomId('global:config:back').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [row, new ActionRowBuilder().addComponents(back)] };
}

function configRolesPanel({ db }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.GLOBAL)
    .setTitle('⚙️ Config — Access Roles')
    .setDescription('Paste ID-urile rolurilor (Copy ID). Metoda asta e stabila si usor de folosit.')
    .addFields(
      { name: 'ROLE_ADMIN_ID', value: fmtRole(getSetting(db, 'ROLE_ADMIN_ID', '')), inline: false },
      { name: 'ROLE_SUPERVISOR_ID', value: fmtRole(getSetting(db, 'ROLE_SUPERVISOR_ID', '')), inline: false },
      { name: 'ROLE_WARN_MANAGER_ID', value: fmtRole(getSetting(db, 'ROLE_WARN_MANAGER_ID', '')), inline: false },
      { name: 'ROLE_PK_ID', value: fmtRole(getSetting(db, 'ROLE_PK_ID', '')), inline: false },
      { name: 'ROLE_BAN_ID', value: fmtRole(getSetting(db, 'ROLE_BAN_ID', '')), inline: false }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg:set:role:admin').setLabel('✏️ Admin').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:role:supervisor').setLabel('✏️ Supervisor').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:role:warn').setLabel('✏️ Warn').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:role:pk').setLabel('✏️ PK').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cfg:set:role:ban').setLabel('✏️ Ban').setStyle(ButtonStyle.Secondary)
  );

  const back = new ButtonBuilder().setCustomId('global:config:back').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [row, new ActionRowBuilder().addComponents(back)] };
}

function configOrgsPanel({ db }) {
  const orgs = listOrgs(db);
  const embed = new EmbedBuilder()
    .setColor(COLORS.GLOBAL)
    .setTitle('⚙️ Config — Organizations')
    .setDescription('Creeaza/sterge organizatii si configureaza rank mapping (roluri).')
    .addFields({ name: 'Total orgs', value: String(orgs.length), inline: true });

  const options = orgs.slice(0, 25).map(o => ({ label: `${o.name} (${o.type})`, value: o.org_id }));
  const select = new StringSelectMenuBuilder().setCustomId('cfg:org:pick').setPlaceholder('Alege organizatia pentru edit...');
  if (options.length) select.addOptions(options);

  const row1 = new ActionRowBuilder();
  if (options.length) row1.addComponents(select);

  const btns = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg:org:create').setLabel('➕ Create Org').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cfg:org:delete').setLabel('🗑️ Delete Org').setStyle(ButtonStyle.Danger)
  );
  const back = new ButtonBuilder().setCustomId('global:config:back').setLabel('Back').setStyle(ButtonStyle.Secondary);
  const comps = [];
  if (options.length) comps.push(row1);
  comps.push(btns);
  comps.push(new ActionRowBuilder().addComponents(back));
  return { embeds: [embed], components: comps };
}

function configOrgDetailPanel({ db, org }) {
  const ranks = org ? db.prepare('SELECT rank_key, role_id, level FROM org_ranks WHERE org_id=? ORDER BY level DESC').all(org.org_id) : [];
  const embed = new EmbedBuilder()
    .setColor(org ? orgColor(org) : COLORS.GLOBAL)
    .setTitle(`🏷️ Org Details — ${org?.name || 'Unknown'}`)
    .setDescription(`Type: **${org?.type || '—'}**\nBase role: ${fmtRole(org?.base_role_id || '')}`)
    .addFields({ name: 'Ranks', value: ranks.length ? ranks.map(r => `• **${r.rank_key}** (lvl ${r.level}) → ${fmtRole(r.role_id)}`).join('\n') : '—', inline: false });

  const addRankBtn = new ButtonBuilder().setCustomId(`cfg:org:addrank:${org.org_id}`).setLabel('➕ Add/Update Rank').setStyle(ButtonStyle.Primary);
  const back = new ButtonBuilder().setCustomId('cfg:org:back:list').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(addRankBtn), new ActionRowBuilder().addComponents(back)] };
}

async function diagnosticsPanel({ db, ctx, guild }) {
  const me = guild.members.me;
  const perms = me?.permissions;
  const manageRoles = perms?.has('ManageRoles') || false;
  const manageGuild = perms?.has('ManageGuild') || false;
  const viewChannels = perms?.has('ViewChannel') || false;

  const roleAdmin = getSetting(db, 'ROLE_ADMIN_ID', '');
  const roleSup = getSetting(db, 'ROLE_SUPERVISOR_ID', '');
  const pkRole = getSetting(db, 'ROLE_PK_ID', '');
  const banRole = getSetting(db, 'ROLE_BAN_ID', '');

  const topPos = me?.roles?.highest?.position ?? 0;
  const rolePos = (rid) => (rid && guild.roles.cache.get(rid) ? guild.roles.cache.get(rid).position : null);

  const embed = new EmbedBuilder()
    .setColor(COLORS.GLOBAL)
    .setTitle('🩺 Diagnostics')
    .setDescription('Check rapid: permisiuni, config, ierarhie roluri.')
    .addFields(
      { name: 'Bot perms', value: `ViewChannel: ${viewChannels ? '✅' : '❌'}\nManageRoles: ${manageRoles ? '✅' : '❌'}\nManageGuild: ${manageGuild ? '✅' : '❌'}`, inline: true },
      { name: 'Channels set', value: `Audit: ${getSetting(db,'AUDIT_CHANNEL_ID','') ? '✅' : '❌'}\nAlert: ${getSetting(db,'ALERT_CHANNEL_ID','') ? '✅' : '❌'}\nWarn: ${getSetting(db,'WARN_CHANNEL_ID','') ? '✅' : '❌'}`, inline: true },
      { name: 'Access roles set', value: `Admin: ${roleAdmin ? '✅' : '❌'}\nSupervisor: ${roleSup ? '✅' : '❌'}`, inline: true },
      { name: 'Cooldown roles set', value: `PK: ${pkRole ? '✅' : '❌'}\nBAN: ${banRole ? '✅' : '❌'}`, inline: true },
      { name: 'Role hierarchy', value: `Bot top role position: **${topPos}**\nAdmin role position: **${rolePos(roleAdmin) ?? '—'}**\nPK role position: **${rolePos(pkRole) ?? '—'}**\nBAN role position: **${rolePos(banRole) ?? '—'}**\n\n✅ Bot must be ABOVE roles it edits.`, inline: false }
    );
  const back = new ButtonBuilder().setCustomId('fmenu:back:root').setLabel('Back').setStyle(ButtonStyle.Secondary);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(back)] };
}

function createOrgModal() {
  return new ModalBuilder()
    .setCustomId('modal:cfg:create_org')
    .setTitle('➕ Create Organization')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('org_id').setLabel('Org ID (slug, ex: ballas)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Name (ex: Ballas)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('type').setLabel('Type: MAFIA or LEGAL').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('base_role_id').setLabel('Base role ID (optional)').setStyle(TextInputStyle.Short).setRequired(false)
      )
    );
}

function setIdModal(customId, title, label, placeholder) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('id')
          .setLabel(label)
          .setPlaceholder(placeholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

function deleteOrgModal() {
  return new ModalBuilder()
    .setCustomId('modal:cfg:delete_org')
    .setTitle('🗑️ Delete Organization')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('org_id').setLabel('Org ID to delete').setStyle(TextInputStyle.Short).setRequired(true)
    ));
}

function addRankModal(orgId) {
  return new ModalBuilder()
    .setCustomId(`modal:cfg:addrank:${orgId}`)
    .setTitle('➕ Add/Update Rank Mapping')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rank_key').setLabel('Rank key (ex: LEADER, COLEADER, MEMBER)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('level').setLabel('Level (0-100, mai mare = mai sus)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('role_id').setLabel('Role ID (optional - Copy ID)').setStyle(TextInputStyle.Short).setRequired(false)
      )
    );
}

function addMemberModal(orgId) {
  return new ModalBuilder()
    .setCustomId(`modal:add:${orgId}`)
    .setTitle('➕ Add Member')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('user').setLabel('User (mention or ID)').setStyle(TextInputStyle.Short).setRequired(true)
    ));
}

function removeMemberModal(orgId, pk) {
  return new ModalBuilder()
    .setCustomId(`modal:rem:${orgId}:${pk ? '1' : '0'}`)
    .setTitle(pk ? '💀 Remove (PK)' : '➖ Remove')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('user').setLabel('User (mention or ID)').setStyle(TextInputStyle.Short).setRequired(true)
    ));
}

function searchModal(orgId) {
  return new ModalBuilder()
    .setCustomId(`modal:search:${orgId}`)
    .setTitle('🔎 Search Player')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('user').setLabel('User (mention or ID)').setStyle(TextInputStyle.Short).setRequired(true)
    ));
}

function falertModal() {
  return new ModalBuilder()
    .setCustomId('modal:falert')
    .setTitle('🚨 Falert')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('locatie').setLabel('Locatie').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('detalii').setLabel('Detalii (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false)
      )
    );
}

function parseUserId(input) {
  if (!input) return null;
  const m = input.match(/\d{17,20}/);
  return m ? m[0] : null;
}

function fmtId(id) {
  return id ? `\`${id}\`` : '—';
}

function fmtRole(roleId) {
  return roleId ? `<@&${roleId}> (\`${roleId}\`)` : '—';
}

function fmtChannel(channelId) {
  return channelId ? `<#${channelId}> (\`${channelId}\`)` : '—';
}

function buildSearchResultEmbed({ db, ctx, org, targetUserId }) {
  const cd = getCooldown(db, targetUserId);
  const mem = getMembership(db, targetUserId);
  const last = getLastOrg(db, targetUserId);

  const isPriv = ctx.isAdmin || ctx.isSupervisor;

  const embed = new EmbedBuilder()
    .setColor(isPriv ? COLORS.GLOBAL : orgColor(org))
    .setTitle(`🔎 Search — <@${targetUserId}>`);

  let status = 'FREE';
  if (mem) status = 'IN_ORG';
  if (cd) status = cd.type === 'PK' ? 'COOLDOWN_PK' : 'COOLDOWN_BAN';

  embed.addFields(
    { name: 'Status', value: status, inline: true },
    { name: 'Expires', value: cd?.expires_at || '—', inline: true },
    { name: 'Last time in org', value: last?.last_in_org_at || '—', inline: false }
  );

  if (isPriv) {
    embed.addFields(
      { name: 'Org', value: mem?.org_id || '—', inline: true },
      { name: 'Rank', value: mem?.rank_key || '—', inline: true }
    );
  } else {
    embed.setFooter({ text: 'Limited view' });
  }

  return { embeds: [embed], ephemeral: true };
}

async function computeQuickStats(db) {
  return { pk: countByCooldown(db, 'PK'), ban: countByCooldown(db, 'BAN'), lockdowns: countLockdowns(db) };
}

function countByCooldown(db, type) {
  return db.prepare('SELECT COUNT(1) as c FROM cooldowns WHERE type=?').get(type).c;
}

function countLockdowns(db) {
  return db.prepare('SELECT COUNT(1) as c FROM lockdowns').get().c;
}
