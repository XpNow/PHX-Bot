import crypto from "crypto";
import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";
import { openDb, ensureSchema, getSetting, setSetting, getGlobal, setGlobal } from "../db/db.js";
import * as repo from "../db/repo.js";
import { isOwner, hasRole, parseUserIds, humanKind } from "../util/access.js";
import { makeEmbed, btn, rowsFromButtons, safeComponents, select, modal, input } from "../ui/ui.js";

const PK_MS = 3 * 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function now() { return Date.now(); }

function getCtx(interaction) {
  const db = openDb();
  ensureSchema(db);

  const guild = interaction.guild;
  const member = interaction.member;
  const uid = interaction.user.id;

  const settings = {
    audit: getSetting(db, "audit_channel_id"),
    alert: getSetting(db, "alert_channel_id"),
    warn: getSetting(db, "warn_channel_id"),
    adminRole: getSetting(db, "admin_role_id"),
    supervisorRole: getSetting(db, "supervisor_role_id"),
    pkRole: getSetting(db, "pk_role_id"),
    banRole: getSetting(db, "ban_role_id"),
    rateLimitPerMin: Number(getSetting(db, "rate_limit_per_min") || "20") || 20
  };

  const perms = {
    owner: isOwner(guild, uid),
    admin: hasRole(member, settings.adminRole),
    supervisor: hasRole(member, settings.supervisorRole)
  };
  perms.staff = perms.owner || perms.admin || perms.supervisor;

  return { db, settings, perms, guild, member, uid };
}

async function audit(ctx, title, desc) {
  const channelId = ctx.settings.audit;
  if (!channelId) return;
  try {
    const ch = await ctx.guild.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      console.error("[AUDIT] Invalid audit channel:", channelId);
      return;
    }
    const emb = makeEmbed(title, desc);
    await ch.send({ embeds: [emb] });
  } catch (err) {
    console.error("[AUDIT] Failed to send audit log:", err);
  }
}

async function sendEphemeral(interaction, title, desc, components=[]) {
  const emb = makeEmbed(title, desc);
  const payload = { embeds: [emb], components: safeComponents(components), ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function safeRoleAdd(member, roleId, context) {
  if (!roleId) return false;
  try {
    await member.roles.add(roleId);
    return true;
  } catch (err) {
    console.error(`[ROLE ADD] ${context} (role ${roleId})`, err);
    return false;
  }
}

async function safeRoleRemove(member, roleId, context) {
  if (!roleId) return false;
  try {
    await member.roles.remove(roleId);
    return true;
  } catch (err) {
    console.error(`[ROLE REMOVE] ${context} (role ${roleId})`, err);
    return false;
  }
}

function requireStaff(ctx) {
  if (!ctx.perms.staff) return false;
  return true;
}

function requireOwner(ctx) {
  return ctx.perms.owner;
}

function requireSupervisorOrOwner(ctx) {
  return ctx.perms.owner || ctx.perms.supervisor;
}

function requireCreateOrg(ctx) {
  // owner or admin or supervisor
  return ctx.perms.owner || ctx.perms.admin || ctx.perms.supervisor;
}

function resolveManageableOrgs(ctx) {
  // user can manage org if they have org.member_role_id AND (leader_role OR co_leader_role)
  const orgs = repo.listOrgs(ctx.db);
  const manageable = [];
  for (const o of orgs) {
    const hasMemberRole = hasRole(ctx.member, o.member_role_id);
    const isLeader = hasRole(ctx.member, o.leader_role_id);
    const isCo = o.co_leader_role_id ? hasRole(ctx.member, o.co_leader_role_id) : false;
    if (hasMemberRole && (isLeader || isCo)) {
      manageable.push({ org: o, role: isLeader ? "LEADER" : "COLEADER" });
    }
  }
  return manageable;
}

async function fmenuHome(interaction, ctx) {
  const manageable = resolveManageableOrgs(ctx);

  if (manageable.length === 0) {
    const orgs = repo.listOrgs(ctx.db);
    const hasMemberRole = orgs.some(o => hasRole(ctx.member, o.member_role_id));
    if (hasMemberRole) {
      return sendEphemeral(
        interaction,
        "⛔ Nu ai permisiuni",
        "⛔ Nu ai permisiuni de Lider/Co-Lider pentru a folosi /fmenu."
      );
    }
    // Owner/staff hint to use /famenu for config, otherwise deny
    if (ctx.perms.staff) {
      return sendEphemeral(
        interaction,
        "Nu ai rol de organizație",
        "Nu ești setat într-o organizație încă. Pentru configurare (organizații, roluri, canale) folosește **/famenu**."
      );
    }
    return sendEphemeral(
      interaction,
      "⛔ Nu ai permisiuni",
      "Ai nevoie de rolurile de **Lider** sau **Co-Lider** (și rolul organizației) ca să folosești **/fmenu**."
    );
  }

  if (manageable.length === 1) {
    return orgPanelView(interaction, ctx, manageable[0].org.id);
  }

  // Multiple orgs: show select
  const options = manageable.map(m => ({
    label: `${m.org.name} (${humanKind(m.org.kind)})`,
    value: String(m.org.id),
    description: "Deschide meniul organizației"
  }));

  const emb = makeEmbed("Alege organizația", "Ai acces la mai multe organizații. Selectează una:");
  const menu = select("fmenu:pickorg", "Selectează organizația…", options);
  const row = new ActionRowBuilder().addComponents(menu);
  return sendEphemeral(interaction, emb.data.title, emb.data.description, [row]);
}

async function orgPanelView(interaction, ctx, orgId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    return sendEphemeral(interaction, "Eroare", "Organizația nu a fost găsită (posibil coruptă).");
  }

  // permission: must be staff or leader/co-leader with proper roles
  const manageable = resolveManageableOrgs(ctx).find(m => m.org.id === orgId);
  if (!manageable && !ctx.perms.staff) {
    return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai acces la această organizație.");
  }

  const counts = repo.listMembersByOrg(ctx.db, orgId).length;
  const emb = makeEmbed(
    `📌 ${org.name} — ${humanKind(org.kind)}`,
    `Membri înregistrați (DB): **${counts}**\n\nAlege o acțiune rapidă:`
  );

  const buttons = [
    btn(`org:${orgId}:remove_pk`, "Remove (PK)", ButtonStyle.Danger, "💀"),
    btn(`org:${orgId}:add`, "Add membru", ButtonStyle.Success, "➕"),
    btn(`org:${orgId}:remove`, "Remove membru", ButtonStyle.Secondary, "➖"),
    btn(`org:${orgId}:roster`, "Roster", ButtonStyle.Secondary, "📋"),
    btn(`org:${orgId}:search`, "Search", ButtonStyle.Secondary, "🔎"),
    btn(`org:${orgId}:cooldowns`, "Cooldowns", ButtonStyle.Secondary, "⏳"),
    btn(`fmenu:back`, "Back", ButtonStyle.Secondary, "⬅️"),
  ];

  const rows = rowsFromButtons(buttons);
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rows);
}

async function showModalSafe(interaction, m) {
  // For button/select interactions: must NOT deferUpdate before showing modal
  try {
    return await interaction.showModal(m);
  } catch (e) {
    // fallback
    console.error("showModal failed:", e);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "A apărut o eroare internă. Încearcă din nou.", ephemeral: true });
      } catch {}
    }
  }
}

function orgCreateModal() {
  return modal("famenu:createorg", "Create organizatie", [
    input("name", "Nume organizație", undefined, true, "Ex: Ballas / LSPD"),
    input("kind", "Tip (ILLEGAL sau LEGAL)", undefined, true, "ILLEGAL / LEGAL"),
    input("member_role_id", "Member role ID (rolul organizației)", undefined, true, "Rolul Ballas / LSPD"),
    input("leader_role_id", "Leader role ID", undefined, true, "Ex: Leader Organizatie / Chestor"),
    input("co_leader_role_id", "Co-Leader role ID (opțional)", undefined, false, "Ex: Co-Lider / HR"),
  ]);
}

function configAccessRolesView(ctx) {
  const emb = makeEmbed("🔐 Roluri de acces", "Owner only. Setează rolurile care controlează accesul botului.");
  const lines = [
    `Admin: ${ctx.settings.adminRole ? `<@&${ctx.settings.adminRole}>` : "(unset)"}`,
    `Supervisor: ${ctx.settings.supervisorRole ? `<@&${ctx.settings.supervisorRole}>` : "(unset)"}`,
    `PK Role: ${ctx.settings.pkRole ? `<@&${ctx.settings.pkRole}>` : "(unset)"}`,
    `Ban Role: ${ctx.settings.banRole ? `<@&${ctx.settings.banRole}>` : "(unset)"}`
  ];
  emb.setDescription(emb.data.description + "\n\n" + lines.join("\n"));

  const buttons = [
    btn("famenu:setrole:admin", "Set Admin", ButtonStyle.Secondary),
    btn("famenu:setrole:supervisor", "Set Supervisor", ButtonStyle.Secondary),
    btn("famenu:setrole:pk", "Set PK", ButtonStyle.Secondary),
    btn("famenu:setrole:ban", "Set Ban", ButtonStyle.Secondary),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function configChannelsView(ctx) {
  const emb = makeEmbed("📣 Canale", "Owner only. Setează unde trimite botul loguri/alerte.");
  const lines = [
    `Audit: ${ctx.settings.audit ? `<#${ctx.settings.audit}>` : "(unset)"}`,
    `Alert: ${ctx.settings.alert ? `<#${ctx.settings.alert}>` : "(unset)"}`,
    `Warn: ${ctx.settings.warn ? `<#${ctx.settings.warn}>` : "(unset)"}`
  ];
  emb.setDescription(emb.data.description + "\n\n" + lines.join("\n"));

  const buttons = [
    btn("famenu:setchannel:audit", "Set Audit", ButtonStyle.Secondary),
    btn("famenu:setchannel:alert", "Set Alert", ButtonStyle.Secondary),
    btn("famenu:setchannel:warn", "Set Warn", ButtonStyle.Secondary),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function configRateLimitView(ctx) {
  const emb = makeEmbed("⏱️ Rate limit", "Owner only. Limitează acțiunile pe minut (anti-abuz).");
  emb.setDescription(`${emb.data.description}\n\nAcum: **${ctx.settings.rateLimitPerMin}/min**`);
  const buttons = [
    btn("famenu:setratelimit", "Schimbă limită", ButtonStyle.Secondary),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

async function famenuHome(interaction, ctx) {
  if (!ctx.perms.staff) {
    return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar Owner/Admin/Supervisor pot folosi /famenu.");
  }
  const c = repo.counts(ctx.db);
  const emb = makeEmbed("🛠️ Admin Hub", `Organizații: **${c.orgs}** | Membri DB: **${c.members}** | PK: **${c.pk}** | Ban: **${c.bans}**\n\nAlege ce vrei să gestionezi:`);
  const buttons = [
    btn("famenu:orgs", "Organizații", ButtonStyle.Primary, "🏛️"),
    btn("famenu:config", "Config", ButtonStyle.Secondary, "⚙️"),
    btn("famenu:diag", "Diagnostic", ButtonStyle.Secondary, "🩺"),
    requireSupervisorOrOwner(ctx) ? btn("famenu:warns", "Warns", ButtonStyle.Secondary, "⚠️") : null
  ];
  const rows = rowsFromButtons(buttons.filter(Boolean));
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rows);
}

async function famenuConfig(interaction, ctx) {
  if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul poate modifica configurările.");
  const emb = makeEmbed("⚙️ Config", "Setează roluri, canale și rate limit.");
  const buttons = [
    btn("famenu:config:roles", "Roluri de acces", ButtonStyle.Secondary, "🔐"),
    btn("famenu:config:channels", "Canale", ButtonStyle.Secondary, "📣"),
    btn("famenu:config:ratelimit", "Rate limit", ButtonStyle.Secondary, "⏱️"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function famenuOrgs(interaction, ctx) {
  if (!ctx.perms.staff) return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai acces.");
  const orgs = repo.listOrgs(ctx.db);
  const desc = orgs.length
    ? orgs.map(o => `• **${o.name}** (${humanKind(o.kind)}) — ID: \`${o.id}\``).join("\n")
    : "Nu există organizații încă.";
  const emb = makeEmbed("🏛️ Organizații", desc);

  const buttons = [
    requireCreateOrg(ctx) ? btn("famenu:createorg", "Create", ButtonStyle.Success, "➕") : null,
    requireSupervisorOrOwner(ctx) ? btn("famenu:deleteorg", "Delete", ButtonStyle.Danger, "🗑️") : null,
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons.filter(Boolean)));
}

function setRoleModal(which) {
  const map = {
    admin: "admin_role_id",
    supervisor: "supervisor_role_id",
    pk: "pk_role_id",
    ban: "ban_role_id",
  };
  const key = map[which];
  return modal(`famenu:setrole_modal:${which}`, "Set Role ID", [
    input("role_id", "Role ID (sau mention @Rol)", undefined, true, "Ex: 123... sau @Rol")
  ]);
}

function setChannelModal(which) {
  return modal(`famenu:setchannel_modal:${which}`, "Set Channel ID", [
    input("channel_id", "Channel ID (sau mention #canal)", undefined, true, "Ex: 123... sau #canal")
  ]);
}

function setRateLimitModal() {
  return modal("famenu:setratelimit_modal", "Set rate limit", [
    input("value", "Acțiuni per minut", undefined, true, "Ex: 20")
  ]);
}

function warnAddModal() {
  return modal("famenu:warn_add_modal", "Adaugă warn", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("days", "Durata (zile)", undefined, true, "Ex: 7"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: abateri")
  ]);
}

function warnRemoveModal() {
  return modal("famenu:warn_remove_modal", "Șterge warn", [
    input("warn_id", "Warn ID", undefined, true, "Ex: UUID"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: anulare")
  ]);
}

function warnsView(ctx) {
  const emb = makeEmbed("⚠️ Warns", "Adaugă/șterge warn-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:warn_add", "Adaugă warn", ButtonStyle.Primary, "➕"),
    btn("famenu:warn_remove", "Șterge warn", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:warn_list", "Listă active", ButtonStyle.Secondary, "📋"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function deleteOrgModal() {
  return modal("famenu:deleteorg_modal", "Delete organizatie", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: desființare")
  ]);
}

function addMembersModal(orgId) {
  return modal(`org:${orgId}:add_modal`, "Add membri", [
    input("users", "User ID-uri sau @mention (multi-line)", 2, true, "Ex:\n123...\n@Player"),
  ]);
}
function removeMembersModal(orgId, pk) {
  return modal(`org:${orgId}:${pk?'remove_pk':'remove'}_modal`, pk ? "Remove (PK)" : "Remove", [
    input("users", "User ID-uri sau @mention (multi-line)", 2, true, "Ex:\n123...\n@Player"),
  ]);
}
function searchModal(orgId) {
  return modal(`org:${orgId}:search_modal`, "Search player", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
  ]);
}

function reconcileOrgModal() {
  return modal("famenu:reconcile_org_modal", "Reconcile organizație", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
  ]);
}

async function handleFalert(interaction, ctx) {
  const loc = interaction.options.getString("locatie", true);
  const last = Number(getGlobal(ctx.db, "falert_last_ts") || "0");
  const left = last + ALERT_COOLDOWN_MS - now();
  if (left > 0) {
    const mins = Math.ceil(left / 60000);
    return sendEphemeral(interaction, "⏳ Cooldown global", `Comanda e pe cooldown. Mai încearcă în ~${mins} minute.`);
  }
  setGlobal(ctx.db, "falert_last_ts", String(now()));

  // ping in alert channel
  const alertChId = ctx.settings.alert;
  if (!alertChId) return sendEphemeral(interaction, "Config lipsă", "Alert channel nu este setat în /famenu → Config → Canale.");
  const ch = await ctx.guild.channels.fetch(alertChId).catch((err)=> {
    console.error("[FALERT] fetch channel failed:", err);
    return null;
  });
  if (!ch || !ch.isTextBased()) return sendEphemeral(interaction, "Eroare", "Nu pot accesa alert channel. Verifică ID-ul/perms.");

  const orgs = repo.listOrgs(ctx.db);
  // ping roles: use member_role_id for all orgs
  const pings = orgs.map(o => `<@&${o.member_role_id}>`).join(" ");
  try {
    await ch.send(`🚨 **ALERTĂ RAZIE**: ${loc}\n${pings}\n${pings}`);
  } catch (err) {
    console.error("[FALERT] send failed:", err);
    return sendEphemeral(interaction, "Eroare", "Nu pot trimite alerta. Verifică permisiunile botului.");
  }
  await audit(ctx, "ALERTĂ RAZIE", `Locație: ${loc}\nDe: <@${ctx.uid}>`);
  return sendEphemeral(interaction, "Trimis", `Alerta a fost trimisă în <#${alertChId}>.`);
}

async function reconcileOrg(ctx, orgId, members) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) return { ok:false, msg:"Organizația nu există." };
  if (!members) return { ok:false, msg:"Nu pot prelua membrii guild-ului." };

  const discordMembers = members.filter(m => m.roles.cache.has(org.member_role_id));
  const discordIds = new Set(discordMembers.map(m => m.id));
  const dbMembers = repo.listMembersByOrg(ctx.db, orgId);
  const dbIds = new Set(dbMembers.map(m => m.user_id));

  let added = 0;
  let removed = 0;

  for (const m of discordMembers.values()) {
    if (!dbIds.has(m.id)) {
      repo.upsertMembership(ctx.db, m.id, orgId, "MEMBER");
      added++;
    }
  }
  for (const row of dbMembers) {
    if (!discordIds.has(row.user_id)) {
      repo.removeMembership(ctx.db, row.user_id);
      repo.upsertLastOrgState(ctx.db, row.user_id, orgId, now(), "RECONCILE");
      removed++;
    }
  }

  if (added || removed) {
    await audit(ctx, "Reconcile organizație", `Org: **${org.name}** | Added: **${added}** | Removed: **${removed}** | De: <@${ctx.uid}>`);
  }

  return { ok:true, added, removed, org };
}

async function sendWarnMessage(ctx, userId, warnId, reason, expiresAt) {
  const warnChannelId = ctx.settings.warn;
  if (!warnChannelId) return { ok:false, msg:"Warn channel nu este setat." };
  try {
    const ch = await ctx.guild.channels.fetch(warnChannelId);
    if (!ch || !ch.isTextBased()) {
      console.error("[WARN] Invalid warn channel:", warnChannelId);
      return { ok:false, msg:"Warn channel invalid." };
    }
    const desc = [
      `User: <@${userId}>`,
      `Motiv: ${reason || "—"}`,
      `Warn ID: \`${warnId}\``,
      `Expiră: <t:${Math.floor(expiresAt/1000)}:R>`
    ].join("\n");
    const emb = makeEmbed("⚠️ WARN", desc);
    const msg = await ch.send({ embeds: [emb] });
    return { ok:true, messageId: msg.id };
  } catch (err) {
    console.error("[WARN] send failed:", err);
    return { ok:false, msg:"Nu pot trimite mesaj în warn channel." };
  }
}

async function reconcileCooldownRoles(ctx, members) {
  if (!members) return { ok:false, msg:"Nu pot prelua membrii guild-ului." };
  const nowTs = now();
  const pkRole = ctx.settings.pkRole;
  const banRole = ctx.settings.banRole;
  const BAN_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;

  let pkAdded = 0;
  let pkRemoved = 0;
  let banAdded = 0;
  let banRemoved = 0;

  const pkRows = repo.listCooldowns(ctx.db, "PK");
  const banRows = repo.listCooldowns(ctx.db, "BAN");
  const pkMap = new Map(pkRows.map(r => [r.user_id, r]));
  const banMap = new Map(banRows.map(r => [r.user_id, r]));

  for (const row of pkRows) {
    const member = members.get(row.user_id);
    if (row.expires_at <= nowTs) {
      if (member && pkRole && member.roles.cache.has(pkRole)) {
        const removed = await safeRoleRemove(member, pkRole, `PK expired cleanup for ${row.user_id}`);
        if (removed) pkRemoved++;
      }
      repo.clearCooldown(ctx.db, row.user_id, "PK");
      continue;
    }
    if (member && pkRole && !member.roles.cache.has(pkRole)) {
      const added = await safeRoleAdd(member, pkRole, `PK reconcile for ${row.user_id}`);
      if (added) pkAdded++;
    }
  }

  for (const row of banRows) {
    const member = members.get(row.user_id);
    if (row.expires_at <= nowTs) {
      if (member && banRole && member.roles.cache.has(banRole)) {
        const removed = await safeRoleRemove(member, banRole, `BAN expired cleanup for ${row.user_id}`);
        if (removed) banRemoved++;
      }
      repo.clearCooldown(ctx.db, row.user_id, "BAN");
      continue;
    }
    if (member && banRole && !member.roles.cache.has(banRole)) {
      const added = await safeRoleAdd(member, banRole, `BAN reconcile for ${row.user_id}`);
      if (added) banAdded++;
    }
  }

  if (pkRole) {
    const membersWithPk = members.filter(m => m.roles.cache.has(pkRole));
    for (const m of membersWithPk.values()) {
      if (!pkMap.has(m.id)) {
        const expiresAt = nowTs + PK_MS;
        repo.upsertCooldown(ctx.db, m.id, "PK", expiresAt, null, nowTs);
        pkMap.set(m.id, { user_id: m.id });
        pkAdded++;
        await audit(ctx, "Reconcile PK", `User: <@${m.id}> | PK creat (manual role detectat) | Expiră: <t:${Math.floor(expiresAt/1000)}:R> | De: <@${ctx.uid}>`);
      }
    }
  }

  if (banRole) {
    const membersWithBan = members.filter(m => m.roles.cache.has(banRole));
    for (const m of membersWithBan.values()) {
      if (!banMap.has(m.id)) {
        const expiresAt = nowTs + BAN_MS_DEFAULT;
        repo.upsertCooldown(ctx.db, m.id, "BAN", expiresAt, null, nowTs);
        banMap.set(m.id, { user_id: m.id });
        banAdded++;
        await audit(ctx, "Reconcile BAN", `User: <@${m.id}> | BAN creat (manual role detectat) | Expiră: <t:${Math.floor(expiresAt/1000)}:R> | De: <@${ctx.uid}>`);
      }
    }
  }

  if (pkAdded || pkRemoved || banAdded || banRemoved) {
    await audit(ctx, "Reconcile cooldowns", `PK: +${pkAdded}/-${pkRemoved} | BAN: +${banAdded}/-${banRemoved} | De: <@${ctx.uid}>`);
  }

  return { ok:true, pkAdded, pkRemoved, banAdded, banRemoved };
}

async function applyPk(ctx, targetMember, orgId, byUserId) {
  const pkRole = ctx.settings.pkRole;
  if (!pkRole) {
    console.error("[PK] pk_role_id missing in settings");
    return { ok:false, msg:"PK role nu este setat." };
  }
  // remove org member role
  const org = repo.getOrg(ctx.db, orgId);
  if (org) {
    const removed = await safeRoleRemove(targetMember, org.member_role_id, `PK remove org role for ${targetMember.id}`);
    if (!removed) return { ok:false, msg:"Nu pot elimina rolul organizației (permisiuni lipsă)." };
  } else {
    console.error(`[PK] Org not found for orgId ${orgId}`);
  }
  const expiresAt = now() + PK_MS;
  repo.upsertCooldown(ctx.db, targetMember.id, "PK", expiresAt, orgId, now());
  repo.removeMembership(ctx.db, targetMember.id);
  repo.upsertLastOrgState(ctx.db, targetMember.id, orgId, now(), byUserId);

  const addedPk = await safeRoleAdd(targetMember, pkRole, `Apply PK for ${targetMember.id}`);
  if (!addedPk) return { ok:false, msg:"Nu pot aplica rolul PK (permisiuni lipsă)." };
  await audit(ctx, "Remove (PK)", `User: <@${targetMember.id}> | Org: **${org?.name ?? orgId}** | De: <@${byUserId}> | Expiră: <t:${Math.floor(expiresAt/1000)}:R>`);
  return { ok:true };
}

async function removeFromOrg(ctx, targetMember, orgId, byUserId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[REMOVE] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }
  const removed = await safeRoleRemove(targetMember, org.member_role_id, `Remove org role for ${targetMember.id}`);
  if (!removed) return { ok:false, msg:"Nu pot elimina rolul organizației (permisiuni lipsă)." };
  repo.removeMembership(ctx.db, targetMember.id);
  repo.upsertLastOrgState(ctx.db, targetMember.id, orgId, now(), byUserId);
  await audit(ctx, "Remove membru", `User: <@${targetMember.id}> | Org: **${org.name}** | De: <@${byUserId}>`);
  return { ok:true };
}

async function addToOrg(ctx, targetMember, orgId, role) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[ADD] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }

  // block if cooldown active
  const pk = repo.getCooldown(ctx.db, targetMember.id, "PK");
  const ban = repo.getCooldown(ctx.db, targetMember.id, "BAN");
  if (ban && ban.expires_at > now()) {
    console.error(`[ADD] User ${targetMember.id} blocked by BAN cooldown`);
    return { ok:false, msg:"Userul este banat de la organizații (BAN)."};
  }
  if (pk && pk.expires_at > now()) {
    console.error(`[ADD] User ${targetMember.id} blocked by PK cooldown`);
    return { ok:false, msg:"Userul este în cooldown (PK)."};
  }

  // Remove pk role if present (cleanup)
  if (ctx.settings.pkRole) await safeRoleRemove(targetMember, ctx.settings.pkRole, `Cleanup PK for ${targetMember.id}`);
  if (ctx.settings.banRole) await safeRoleRemove(targetMember, ctx.settings.banRole, `Cleanup BAN for ${targetMember.id}`);

  const added = await safeRoleAdd(targetMember, org.member_role_id, `Add org role for ${targetMember.id}`);
  if (!added) return { ok:false, msg:"Nu pot adăuga rolul organizației (permisiuni lipsă)." };
  repo.upsertMembership(ctx.db, targetMember.id, orgId, role || "MEMBER");
  await audit(ctx, "Add membru", `User: <@${targetMember.id}> | Org: **${org.name}** | De: <@${ctx.uid}>`);
  return { ok:true };
}

async function rosterView(interaction, ctx, orgId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) return sendEphemeral(interaction, "Eroare", "Organizația nu există.");
  const members = await ctx.guild.members.fetch().catch((err)=> {
    console.error("[ROSTER] fetch members failed:", err);
    return null;
  });
  if (!members) return sendEphemeral(interaction, "Eroare", "Nu pot prelua membrii guild-ului.");
  let count = 0;
  if (members) {
    count = members.filter(m => m.roles.cache.has(org.member_role_id)).size;
  }
  const emb = makeEmbed(`📋 Roster — ${org.name}`, `Membri cu rolul organizației: **${count}**`);
  const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function cooldownsView(interaction, ctx, orgId) {
  const pk = repo.listCooldowns(ctx.db, "PK").filter(r => r.expires_at > now());
  const ban = repo.listCooldowns(ctx.db, "BAN").filter(r => r.expires_at > now());
  const emb = makeEmbed("⏳ Cooldowns", `PK activi: **${pk.length}**\nBAN activi: **${ban.length}**`);
  const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function searchResult(interaction, ctx, orgId, userId) {
  const target = await ctx.guild.members.fetch(userId).catch(()=>null);
  const pk = repo.getCooldown(ctx.db, userId, "PK");
  const ban = repo.getCooldown(ctx.db, userId, "BAN");
  const member = repo.getMembership(ctx.db, userId);
  const last = repo.getLastOrgState(ctx.db, userId);

  const lines = [];
  lines.push(`User: ${target ? `<@${userId}>` : `\`${userId}\``}`);
  if (ban && ban.expires_at > now()) lines.push(`Status: **BAN** (expiră <t:${Math.floor(ban.expires_at/1000)}:R>)`);
  else if (pk && pk.expires_at > now()) lines.push(`Status: **PK cooldown** (expiră <t:${Math.floor(pk.expires_at/1000)}:R>)`);
  else lines.push("Status: **Free**");
  if (member) {
    lines.push(`În organizație: **Da**`);
  } else {
    lines.push("În organizație: **Nu**");
  }
  if (last?.last_left_at) {
    lines.push(`Ultima plecare din org: <t:${Math.floor(last.last_left_at/1000)}:R>`);
  } else {
    lines.push("Ultima plecare din org: —");
  }

  // Leaders should not see org name. Admins may later.
  if (ctx.perms.staff) {
    if (member) {
      const org = repo.getOrg(ctx.db, member.org_id);
      lines.push(`Org curentă: **${org?.name ?? member.org_id}**`);
    }
    if (last?.last_org_id) {
      const lastOrg = repo.getOrg(ctx.db, last.last_org_id);
      lines.push(`Ultima org: **${lastOrg?.name ?? last.last_org_id}**`);
    }
    if (last?.last_removed_by) {
      lines.push(`Scos de: <@${last.last_removed_by}>`);
    }
  }

  const emb = makeEmbed("🔎 Search", lines.join("\n"));
  const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function handleModal(interaction, ctx) {
  const id = interaction.customId;

  // famenu create org
  if (id === "famenu:createorg") {
    if (!requireCreateOrg(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai permisiuni să creezi organizații.");
    const name = interaction.fields.getTextInputValue("name")?.trim();
    const kindRaw = interaction.fields.getTextInputValue("kind")?.trim().toUpperCase();
    const kind = (kindRaw === "LEGAL") ? "LEGAL" : "ILLEGAL";
    const member_role_id = interaction.fields.getTextInputValue("member_role_id")?.replace(/[<@&#>]/g,"").trim();
    const leader_role_id = interaction.fields.getTextInputValue("leader_role_id")?.replace(/[<@&#>]/g,"").trim();
    const co_leader_role_id = interaction.fields.getTextInputValue("co_leader_role_id")?.replace(/[<@&#>]/g,"").trim();

    if (!name || !member_role_id || !leader_role_id) {
      return sendEphemeral(interaction, "Eroare", "Completează câmpurile obligatorii (Name, Member Role ID, Leader Role ID).");
    }
    const orgId = repo.createOrg(ctx.db, { name, kind, member_role_id, leader_role_id, co_leader_role_id: co_leader_role_id || null });
    await audit(ctx, "Create organizatie", `Org: **${name}** (${humanKind(kind)}) | ID: \`${orgId}\` | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Creat", `Organizația **${name}** a fost creată. (ID: \`${orgId}\`)`);
  }

  if (id.startsWith("famenu:setrole_modal:")) {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul poate schimba rolurile.");
    const which = id.split(":")[2];
    const roleId = interaction.fields.getTextInputValue("role_id")?.replace(/[<@&#>]/g,"").trim();
    const map = {
      admin: "admin_role_id",
      supervisor: "supervisor_role_id",
      pk: "pk_role_id",
      ban: "ban_role_id",
    };
    const key = map[which];
    if (!key || !roleId) return sendEphemeral(interaction, "Eroare", "Role ID invalid.");
    setSetting(ctx.db, key, roleId);
    await audit(ctx, "Config update", `Set **${key}** = \`${roleId}\` | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Salvat", "Rolul a fost setat.");
  }

  if (id.startsWith("famenu:setchannel_modal:")) {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul poate schimba canalele.");
    const which = id.split(":")[2];
    const channelId = interaction.fields.getTextInputValue("channel_id")?.replace(/[<#>]/g,"").trim();
    const map = { audit: "audit_channel_id", alert: "alert_channel_id", warn: "warn_channel_id" };
    const key = map[which];
    if (!key || !channelId) return sendEphemeral(interaction, "Eroare", "Channel ID invalid.");
    setSetting(ctx.db, key, channelId);
    await audit(ctx, "Config update", `Set **${key}** = \`${channelId}\` | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Salvat", "Canalul a fost setat.");
  }

  if (id === "famenu:setratelimit_modal") {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul poate schimba rate limit.");
    const v = interaction.fields.getTextInputValue("value")?.trim();
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 200) return sendEphemeral(interaction, "Eroare", "Valoare invalidă (1-200).");
    setSetting(ctx.db, "rate_limit_per_min", String(n));
    await audit(ctx, "Config update", `Set **rate_limit_per_min** = \`${n}\` | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Salvat", `Rate limit setat la ${n}/min.`);
  }

  if (id === "famenu:deleteorg_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot șterge organizații.");
    const orgId = Number(interaction.fields.getTextInputValue("org_id")?.trim());
    const reason = interaction.fields.getTextInputValue("reason")?.trim();
    const org = repo.getOrg(ctx.db, orgId);
    if (!org) return sendEphemeral(interaction, "Eroare", "Org ID invalid.");
    if (!ctx.settings.pkRole) {
      return sendEphemeral(interaction, "Config lipsă", "PK role nu este setat. Setează-l în /famenu → Config → Roluri.");
    }

    // Put everyone in PK cooldown 3 days on delete
    const members = await ctx.guild.members.fetch().catch((err)=> {
      console.error("[DELETE ORG] fetch members failed:", err);
      return null;
    });
    if (!members) return sendEphemeral(interaction, "Eroare", "Nu pot prelua membrii guild-ului pentru PK.");
    {
      const orgMembers = members.filter(m =>
        m.roles.cache.has(org.member_role_id) ||
        m.roles.cache.has(org.leader_role_id) ||
        (org.co_leader_role_id && m.roles.cache.has(org.co_leader_role_id))
      );
      let ok = 0;
      let bad = 0;
      for (const m of orgMembers.values()) {
        const res = await applyPk(ctx, m, orgId, ctx.uid);
        res.ok ? ok++ : bad++;
      }
      if (bad > 0) {
        console.error(`[DELETE ORG] PK apply failed for ${bad} members in org ${orgId}`);
      }
    }
    repo.deleteOrg(ctx.db, orgId);
    await audit(ctx, "Delete organizatie", `Org: **${org.name}** | ID: \`${orgId}\` | De: <@${ctx.uid}>\nMotiv: ${reason || "-"}\n(Toți membrii au primit PK 3 zile)`);
    return sendEphemeral(interaction, "Șters", `Organizația **${org.name}** a fost ștearsă. Membrii au primit PK 3 zile.`);
  }

  if (id === "famenu:reconcile_org_modal") {
    if (!requireStaff(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar staff poate folosi această acțiune.");
    const orgId = Number(interaction.fields.getTextInputValue("org_id")?.trim());
    if (!orgId) return sendEphemeral(interaction, "Eroare", "Org ID invalid.");
    await interaction.deferReply({ ephemeral: true });
    const members = await ctx.guild.members.fetch().catch((err)=> {
      console.error("[RECONCILE ORG] fetch members failed:", err);
      return null;
    });
    if (!members) return interaction.editReply({ embeds: [makeEmbed("Eroare", "Nu pot prelua membrii guild-ului.")] });
    const res = await reconcileOrg(ctx, orgId, members);
    if (!res.ok) return interaction.editReply({ embeds: [makeEmbed("Eroare", res.msg || "Reconcile eșuat.")] });
    const summary = `Org: **${res.org.name}**\nAdded: **${res.added}**\nRemoved: **${res.removed}**`;
    return interaction.editReply({ embeds: [makeEmbed("Reconcile org", summary)] });
  }

  if (id === "famenu:warn_add_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    const userId = parseUserIds(interaction.fields.getTextInputValue("user"))[0];
    const daysRaw = interaction.fields.getTextInputValue("days")?.trim();
    const reason = interaction.fields.getTextInputValue("reason")?.trim();
    const days = Number(daysRaw);
    if (!userId) return sendEphemeral(interaction, "Eroare", "User ID invalid.");
    if (!Number.isFinite(days) || days < 1 || days > 90) return sendEphemeral(interaction, "Eroare", "Durata invalidă (1-90 zile).");
    if (!ctx.settings.warn) return sendEphemeral(interaction, "Config lipsă", "Warn channel nu este setat în /famenu → Config → Canale.");

    await interaction.deferReply({ ephemeral: true });
    const warnId = crypto.randomUUID();
    const createdAt = now();
    const expiresAt = createdAt + days * 24 * 60 * 60 * 1000;
    const payload = { user_id: userId, reason: reason || "", created_by: ctx.uid, days };

    repo.createWarn(ctx.db, {
      warn_id: warnId,
      org_id: null,
      message_id: null,
      created_by: ctx.uid,
      created_at: createdAt,
      expires_at: expiresAt,
      status: "ACTIVE",
      payload_json: JSON.stringify(payload)
    });

    const msgRes = await sendWarnMessage(ctx, userId, warnId, reason, expiresAt);
    if (!msgRes.ok) return interaction.editReply({ embeds: [makeEmbed("Eroare", msgRes.msg || "Nu pot trimite warn.")] });
    repo.updateWarnMessageId(ctx.db, warnId, msgRes.messageId);
    await audit(ctx, "Warn add", `Warn ID: \`${warnId}\` | User: <@${userId}> | De: <@${ctx.uid}> | Expiră: <t:${Math.floor(expiresAt/1000)}:R>`);
    return interaction.editReply({ embeds: [makeEmbed("Warn creat", `Warn ID: \`${warnId}\` pentru <@${userId}> (expiră <t:${Math.floor(expiresAt/1000)}:R>).`)] });
  }

  if (id === "famenu:warn_remove_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    const warnId = interaction.fields.getTextInputValue("warn_id")?.trim();
    const reason = interaction.fields.getTextInputValue("reason")?.trim();
    if (!warnId) return sendEphemeral(interaction, "Eroare", "Warn ID invalid.");
    const warn = repo.getWarn(ctx.db, warnId);
    if (!warn) return sendEphemeral(interaction, "Eroare", "Warn ID inexistent.");
    repo.setWarnStatus(ctx.db, warnId, "REMOVED");

    if (warn.message_id && ctx.settings.warn) {
      const ch = await ctx.guild.channels.fetch(ctx.settings.warn).catch(()=>null);
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(warn.message_id).catch(()=>null);
        if (msg) {
          const embed = msg.embeds?.[0];
          const eb = new EmbedBuilder(embed?.data ?? {})
            .setFooter({ text: `STATUS: REMOVED • ${reason || "fără motiv"}` });
          await msg.edit({ embeds: [eb] }).catch((err)=> {
            console.error("[WARN] edit message failed:", err);
          });
        }
      }
    }

    await audit(ctx, "Warn remove", `Warn ID: \`${warnId}\` | De: <@${ctx.uid}> | Motiv: ${reason || "-"}`);
    return sendEphemeral(interaction, "Warn șters", `Warn \`${warnId}\` a fost marcat ca REMOVED.`);
  }

  // org add/remove/search
  if (id.endsWith(":add_modal")) {
    const orgId = Number(id.split(":")[1]);
    const users = parseUserIds(interaction.fields.getTextInputValue("users"));
    if (!users.length) return sendEphemeral(interaction, "Eroare", "Nu am găsit User ID-uri valide.");
    await interaction.deferReply({ ephemeral: true });

    let ok=0, bad=0;
    for (const uid of users) {
      const m = await ctx.guild.members.fetch(uid).catch((err)=> {
        console.error(`[ADD] fetch member failed for ${uid}:`, err);
        return null;
      });
      if (!m) { bad++; continue; }
      const res = await addToOrg(ctx, m, orgId, "MEMBER");
      res.ok ? ok++ : bad++;
    }
    const note = bad > 0 ? "\nUnele acțiuni au eșuat. Verifică permisiunile botului și rolurile." : "";
    return interaction.editReply({ embeds: [makeEmbed("Done", `Adăugați: **${ok}** | Eșuați: **${bad}**${note}`)] });
  }

  if (id.endsWith(":remove_modal") || id.endsWith(":remove_pk_modal")) {
    const parts = id.split(":");
    const orgId = Number(parts[1]);
    const pk = id.includes("remove_pk_modal");
    const users = parseUserIds(interaction.fields.getTextInputValue("users"));
    if (!users.length) return sendEphemeral(interaction, "Eroare", "Nu am găsit User ID-uri valide.");
    await interaction.deferReply({ ephemeral: true });
    let ok=0, bad=0;
    for (const uid of users) {
      const m = await ctx.guild.members.fetch(uid).catch((err)=> {
        console.error(`[REMOVE] fetch member failed for ${uid}:`, err);
        return null;
      });
      if (!m) { bad++; continue; }
      const res = pk ? await applyPk(ctx, m, orgId, ctx.uid) : await removeFromOrg(ctx, m, orgId, ctx.uid);
      res.ok ? ok++ : bad++;
    }
    const note = bad > 0 ? "\nUnele acțiuni au eșuat. Verifică permisiunile botului și rolurile." : "";
    return interaction.editReply({ embeds: [makeEmbed("Done", `Procesați: **${ok}** | Eșuați: **${bad}**${note}`)] });
  }

  if (id.endsWith(":search_modal")) {
    const orgId = Number(id.split(":")[1]);
    const user = parseUserIds(interaction.fields.getTextInputValue("user"))[0];
    if (!user) return sendEphemeral(interaction, "Eroare", "User ID invalid.");
    return searchResult(interaction, ctx, orgId, user);
  }

  return sendEphemeral(interaction, "Eroare", "Modal necunoscut.");
}

async function handleComponent(interaction, ctx) {
  const id = interaction.customId;

  // selects
  if (interaction.isStringSelectMenu()) {
    if (id === "fmenu:pickorg") {
      const orgId = Number(interaction.values[0]);
      return orgPanelView(interaction, ctx, orgId);
    }
  }

  if (!interaction.isButton()) return;

  if (id === "fmenu:back") return fmenuHome(interaction, ctx);
  if (id === "famenu:back") return famenuHome(interaction, ctx);

  // famenu nav
  if (id === "famenu:config") return famenuConfig(interaction, ctx);
  if (id === "famenu:orgs") return famenuOrgs(interaction, ctx);
  if (id === "famenu:diag") {
    const emb = makeEmbed("🩺 Diagnostic", "Reconciliază manual rolurile cu DB și verifică starea sistemului.");
    const buttons = [
      btn("famenu:reconcile_global", "Reconcile global", ButtonStyle.Primary, "🧩"),
      btn("famenu:reconcile_org", "Reconcile org", ButtonStyle.Secondary, "🏛️"),
      btn("famenu:back","Back",ButtonStyle.Secondary,"⬅️")
    ];
    return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
  }
  if (id === "famenu:warns") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    const view = warnsView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }

  if (id === "famenu:config:roles") {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul.");
    const view = configAccessRolesView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }
  if (id === "famenu:config:channels") {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul.");
    const view = configChannelsView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }
  if (id === "famenu:config:ratelimit") {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul.");
    const view = configRateLimitView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }

  if (id === "famenu:reconcile_global") {
    if (!requireStaff(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar staff poate folosi această acțiune.");
    await interaction.deferReply({ ephemeral: true });
    const members = await ctx.guild.members.fetch().catch((err)=> {
      console.error("[RECONCILE GLOBAL] fetch members failed:", err);
      return null;
    });
    if (!members) return interaction.editReply({ embeds: [makeEmbed("Eroare", "Nu pot prelua membrii guild-ului.")] });
    let added = 0;
    let removed = 0;
    for (const org of repo.listOrgs(ctx.db)) {
      const res = await reconcileOrg(ctx, org.id, members);
      if (res.ok) {
        added += res.added;
        removed += res.removed;
      }
    }
    const cdRes = await reconcileCooldownRoles(ctx, members);
    const summary = [
      `Organizații: +${added}/-${removed}`,
      cdRes.ok ? `Cooldowns: PK +${cdRes.pkAdded}/-${cdRes.pkRemoved} | BAN +${cdRes.banAdded}/-${cdRes.banRemoved}` : "Cooldowns: eroare"
    ].join("\n");
    return interaction.editReply({ embeds: [makeEmbed("Reconcile global", summary)] });
  }
  if (id === "famenu:reconcile_org") {
    if (!requireStaff(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar staff poate folosi această acțiune.");
    return showModalSafe(interaction, reconcileOrgModal());
  }

  if (id === "famenu:warn_add") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    return showModalSafe(interaction, warnAddModal());
  }
  if (id === "famenu:warn_remove") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    return showModalSafe(interaction, warnRemoveModal());
  }
  if (id === "famenu:warn_list") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    const warns = repo.listWarnsByStatus(ctx.db, "ACTIVE", 10);
    const desc = warns.length
      ? warns.map(w => {
        let payload = {};
        try { payload = JSON.parse(w.payload_json); } catch {}
        const userId = payload.user_id ? `<@${payload.user_id}>` : "—";
        const exp = w.expires_at ? `<t:${Math.floor(w.expires_at/1000)}:R>` : "—";
        return `• \`${w.warn_id}\` | ${userId} | Expiră: ${exp}`;
      }).join("\n")
      : "Nu există warn-uri active.";
    const emb = makeEmbed("⚠️ Warns active", desc);
    return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons([btn("famenu:back","Back",ButtonStyle.Secondary,"⬅️")]));
  }

  if (id.startsWith("famenu:setrole:")) {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul.");
    const which = id.split(":")[2];
    return showModalSafe(interaction, setRoleModal(which));
  }
  if (id.startsWith("famenu:setchannel:")) {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul.");
    const which = id.split(":")[2];
    return showModalSafe(interaction, setChannelModal(which));
  }
  if (id === "famenu:setratelimit") {
    if (!requireOwner(ctx)) return sendEphemeral(interaction, "⛔ Owner only", "Doar ownerul.");
    return showModalSafe(interaction, setRateLimitModal());
  }

  if (id === "famenu:createorg") {
    if (!requireCreateOrg(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai permisiuni.");
    return showModalSafe(interaction, orgCreateModal());
  }
  if (id === "famenu:deleteorg") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner.");
    return showModalSafe(interaction, deleteOrgModal());
  }

  // org actions
  if (id.startsWith("org:")) {
    const parts = id.split(":");
    const orgId = Number(parts[1]);
    const action = parts[2];

    if (action === "back") return orgPanelView(interaction, ctx, orgId);
    if (action === "add") return showModalSafe(interaction, addMembersModal(orgId));
    if (action === "remove") return showModalSafe(interaction, removeMembersModal(orgId, false));
    if (action === "remove_pk") return showModalSafe(interaction, removeMembersModal(orgId, true));
    if (action === "roster") return rosterView(interaction, ctx, orgId);
    if (action === "cooldowns") return cooldownsView(interaction, ctx, orgId);
    if (action === "search") return showModalSafe(interaction, searchModal(orgId));
  }

  return sendEphemeral(interaction, "Eroare", "Acțiune necunoscută.");
}

export async function handleInteraction(interaction, client) {
  const ctx = getCtx(interaction);

  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "fmenu") {
        await fmenuHome(interaction, ctx);
        return;
      }
      if (interaction.commandName === "famenu") {
        await famenuHome(interaction, ctx);
        return;
      }
      if (interaction.commandName === "falert") {
        await handleFalert(interaction, ctx);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      await handleModal(interaction, ctx);
      return;
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await handleComponent(interaction, ctx);
      return;
    }

  } finally {
    ctx.db.close();
  }
}
