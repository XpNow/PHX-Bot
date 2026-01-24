import crypto from "crypto";
import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} from "discord.js";
import { openDb, ensureSchema, getSetting, setSetting, getGlobal, setGlobal } from "../db/db.js";
import * as repo from "../db/repo.js";
import { isOwner, hasRole, parseUserIds, humanKind } from "../util/access.js";
import { makeEmbed, btn, rowsFromButtons, safeComponents, select, modal, input } from "../ui/ui.js";
import { COLORS } from "../ui/theme.js";

const PK_MS = 3 * 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const WARN_MAX = 3;

function now() { return Date.now(); }

let sharedDb = null;

function getDb() {
  if (!sharedDb) {
    sharedDb = openDb();
    ensureSchema(sharedDb);
  }
  return sharedDb;
}

function getCtx(interaction) {
  const db = getDb();

  const guild = interaction.guild;
  const member = interaction.member;
  const uid = interaction.user.id;

  const settings = {
    audit: getSetting(db, "audit_channel_id"),
    alert: getSetting(db, "alert_channel_id"),
    warn: getSetting(db, "warn_channel_id"),
    botChannel: getSetting(db, "bot_channel_id"),
    adminRole: getSetting(db, "admin_role_id"),
    supervisorRole: getSetting(db, "supervisor_role_id"),
    configRole: getSetting(db, "config_role_id"),
    pkRole: getSetting(db, "pk_role_id"),
    banRole: getSetting(db, "ban_role_id"),
  };

  const perms = {
    owner: isOwner(guild, uid),
    admin: hasRole(member, settings.adminRole),
    supervisor: hasRole(member, settings.supervisorRole),
    configManager: hasRole(member, settings.configRole)
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
  const payload = { embeds: [emb], components: safeComponents(components), flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    return interaction.update(payload);
  }
  return interaction.reply(payload);
}

function formatTs(expiresAt) {
  if (!expiresAt) return "—";
  return `<t:${Math.floor(expiresAt / 1000)}:f>`;
}

function parseYesNo(value) {
  const v = (value || "").trim().toUpperCase();
  if (["DA", "YES", "Y", "TRUE"].includes(v)) return true;
  if (["NU", "NO", "N", "FALSE"].includes(v)) return false;
  return null;
}

function parseDurationMs(input) {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  const m = raw.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60 * 1000, min: 60 * 1000, mins: 60 * 1000, minute: 60 * 1000, minutes: 60 * 1000,
    h: 60 * 60 * 1000, hr: 60 * 60 * 1000, hrs: 60 * 60 * 1000, hour: 60 * 60 * 1000, hours: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, days: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000, months: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000, year: 365 * 24 * 60 * 60 * 1000, years: 365 * 24 * 60 * 60 * 1000
  }[unit];
  return mult ? n * mult : null;
}

async function fetchMembersWithRetry(guild, label) {
  try {
    const members = await guild.members.fetch();
    return { members, retryMs: 0 };
  } catch (err) {
    const retryMs = Number(err?.retry_after || err?.retryAfter || 0) * 1000;
    if (retryMs > 0) {
      console.warn(`[${label}] rate limited, retrying after ${retryMs}ms`);
      await new Promise(resolve => setTimeout(resolve, retryMs));
      try {
        const members = await guild.members.fetch();
        return { members, retryMs };
      } catch (retryErr) {
        console.error(`[${label}] fetch members failed after retry:`, retryErr);
        return { members: null, retryMs };
      }
    }
    console.error(`[${label}] fetch members failed:`, err);
    return { members: null, retryMs: 0 };
  }
}

function buildWarnEmbed({ orgName, orgRoleId, reason, dreptPlata, sanctiune, expiresAt, totalWarn, warnId }) {
  const lines = [
    `Organizație: ${orgRoleId ? `<@&${orgRoleId}>` : (orgName || "—")}`,
    `Motiv: ${reason || "—"}`,
    `DREPT PLATA: ${dreptPlata ? "DA" : "NU"}`,
    `SANCTIUNEA OFERITA: ${sanctiune || "—"} ✅`,
    `Expiră: ${expiresAt ? formatTs(expiresAt) : "—"}`,
    `TOTAL WARN: ${totalWarn}`,
    "Status: ✅ VALIDĂ"
  ];
  const emb = makeEmbed("⚠️ WARN", lines.join("\n"));
  if (warnId) emb.setFooter({ text: `WARN ID: ${warnId}` });
  return emb;
}

function generateWarnId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
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

function getOrgRank(member, org) {
  if (!member || !org) return "NONE";
  if (org.leader_role_id && member.roles.cache.has(org.leader_role_id)) return "LEADER";
  if (org.co_leader_role_id && member.roles.cache.has(org.co_leader_role_id)) return "COLEADER";
  if (org.member_role_id && member.roles.cache.has(org.member_role_id)) return "MEMBER";
  return "NONE";
}

function roleCheck(ctx, roleId, label) {
  if (!roleId) return { ok: false, msg: `Rolul ${label} nu este setat.` };
  const role = ctx.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, msg: `Rolul ${label} nu a fost găsit în guild.` };
  const botMember = ctx.guild.members.me;
  if (!botMember) return { ok: false, msg: "Nu pot valida ierarhia rolurilor botului." };
  if (botMember.roles.highest.position <= role.position) {
    return { ok: false, msg: `Botul nu are ierarhie pentru rolul ${label} (trebuie să fie deasupra).` };
  }
  return { ok: true, role };
}

function canManageTargetRank(ctx, org, targetMember) {
  if (ctx.perms.staff) return { ok: true };
  const actorRank = getOrgRank(ctx.member, org);
  const targetRank = getOrgRank(targetMember, org);

  if (actorRank === "LEADER") {
    if (targetRank === "LEADER") return { ok: false, msg: "Nu poți modifica liderul organizației." };
    return { ok: true };
  }
  if (actorRank === "COLEADER") {
    if (targetRank !== "MEMBER") return { ok: false, msg: "Nu poți modifica liderul sau co-liderul." };
    return { ok: true };
  }
  return { ok: false, msg: "Nu ai permisiuni în această organizație." };
}

function canSetRank(ctx, org, desiredRank, targetMember) {
  if (!["LEADER", "COLEADER", "MEMBER"].includes(desiredRank)) {
    return { ok: false, msg: "Rank invalid (LEADER/COLEADER/MEMBER)." };
  }
  if (desiredRank === "LEADER" && !ctx.perms.staff) {
    if (targetMember?.id === ctx.uid) {
      return { ok: false, msg: "Nu îți poți seta singur rolul de Leader." };
    }
    const actorRank = getOrgRank(ctx.member, org);
    if (actorRank !== "LEADER") {
      return { ok: false, msg: "Doar liderul poate alege succesorul." };
    }
  }
  if (desiredRank === "COLEADER") {
    if (!org.co_leader_role_id) return { ok: false, msg: "Rolul de Co-Leader nu este setat pentru această organizație." };
    const actorRank = getOrgRank(ctx.member, org);
    if (!ctx.perms.staff && actorRank !== "LEADER") {
      return { ok: false, msg: "Doar liderul poate seta Co-Leader." };
    }
  }
  if (desiredRank === "MEMBER") {
    const targetRank = getOrgRank(targetMember, org);
    if (targetRank === "LEADER" && !ctx.perms.staff) {
      return { ok: false, msg: "Nu poți retrograda liderul organizației." };
    }
    if (targetRank === "COLEADER") {
      const actorRank = getOrgRank(ctx.member, org);
      if (!ctx.perms.staff && actorRank !== "LEADER") {
        return { ok: false, msg: "Doar liderul poate retrograda Co-Leader." };
      }
    }
  }
  return { ok: true };
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

function requireConfigManager(ctx) {
  return ctx.perms.owner || ctx.perms.configManager;
}

function requireSupervisorOrOwner(ctx) {
  return ctx.perms.owner || ctx.perms.supervisor;
}

function requireCreateOrg(ctx) {
  return ctx.perms.owner || ctx.perms.admin || ctx.perms.supervisor;
}

function resolveManageableOrgs(ctx) {
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

  const options = manageable.map(m => ({
    label: `${m.org.name} (${humanKind(m.org.kind)})`,
    value: String(m.org.id),
    description: "Deschide meniul organizației"
  }));

  const emb = makeEmbed("FMenu — Selectează organizația", "Ai acces la mai multe organizații. Alege una pentru a continua.");
  const menu = select("fmenu:pickorg", "Selectează organizația…", options);
  const row = new ActionRowBuilder().addComponents(menu);
  return sendEphemeral(interaction, emb.data.title, emb.data.description, [row]);
}

async function orgPanelView(interaction, ctx, orgId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    return sendEphemeral(interaction, "Eroare", "Organizația nu a fost găsită (posibil coruptă).");
  }

  const manageable = resolveManageableOrgs(ctx).find(m => m.org.id === orgId);
  if (!manageable && !ctx.perms.staff) {
    return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai acces la această organizație.");
  }

  const counts = repo.listMembersByOrg(ctx.db, orgId).length;
  const emb = makeEmbed(
    `FMenu — ${org.name}`,
    `Tip: **${humanKind(org.kind)}**\nMembri înregistrați (DB): **${counts}**\n\nAlege o acțiune:`
  );

  const actorRank = getOrgRank(ctx.member, org);
  const canSetRanks = ctx.perms.staff || actorRank === "LEADER";
  const buttons = [
    btn(`org:${orgId}:remove_pk`, "Remove (PK)", ButtonStyle.Danger, "💀"),
    btn(`org:${orgId}:add`, "Add membru", ButtonStyle.Success, "➕"),
    btn(`org:${orgId}:remove`, "Remove membru", ButtonStyle.Secondary, "➖"),
    btn(`org:${orgId}:roster`, "Roster", ButtonStyle.Secondary, "📋"),
    btn(`org:${orgId}:search`, "Search", ButtonStyle.Secondary, "🔎"),
    canSetRanks ? btn(`org:${orgId}:setrank`, "Set rank", ButtonStyle.Secondary, "🪪") : null,
    btn(`org:${orgId}:cooldowns`, "Cooldowns", ButtonStyle.Secondary, "⏳"),
    btn(`fmenu:back`, "Back", ButtonStyle.Secondary, "⬅️"),
  ];

  const rows = rowsFromButtons(buttons.filter(Boolean));
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rows);
}

async function showModalSafe(interaction, m) {
  try {
    return await interaction.showModal(m);
  } catch (e) {
    console.error("showModal failed:", e);
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "A apărut o eroare internă. Încearcă din nou.", flags: MessageFlags.Ephemeral });
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
  const emb = makeEmbed("Config — Roluri", "Owner/Config. Setează rolurile de acces.");
  const lines = [
    `Admin: ${ctx.settings.adminRole ? `<@&${ctx.settings.adminRole}>` : "(unset)"}`,
    `Supervisor: ${ctx.settings.supervisorRole ? `<@&${ctx.settings.supervisorRole}>` : "(unset)"}`,
    `Config: ${ctx.settings.configRole ? `<@&${ctx.settings.configRole}>` : "(unset)"}`,
    `PK Role: ${ctx.settings.pkRole ? `<@&${ctx.settings.pkRole}>` : "(unset)"}`,
    `Ban Role: ${ctx.settings.banRole ? `<@&${ctx.settings.banRole}>` : "(unset)"}`
  ];
  emb.setDescription(emb.data.description + "\n\n" + lines.join("\n"));

  const buttons = [
    btn("famenu:setrole:admin", "Set Admin", ButtonStyle.Secondary),
    btn("famenu:setrole:supervisor", "Set Supervisor", ButtonStyle.Secondary),
    btn("famenu:setrole:config", "Set Config", ButtonStyle.Secondary),
    btn("famenu:setrole:pk", "Set PK", ButtonStyle.Secondary),
    btn("famenu:setrole:ban", "Set Ban", ButtonStyle.Secondary),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function configIssues(ctx) {
  const issues = [];
  const channelChecks = [
    ["audit", ctx.settings.audit],
    ["alert", ctx.settings.alert],
    ["warn", ctx.settings.warn],
    ["bot", ctx.settings.botChannel]
  ];
  for (const [label, id] of channelChecks) {
    if (!id) {
      issues.push(`Canal ${label}: lipsă`);
      continue;
    }
    const channel = ctx.guild.channels.cache.get(id);
    if (!channel) issues.push(`Canal ${label}: nu a fost găsit`);
  }

  const roleChecks = [
    ["admin", ctx.settings.adminRole],
    ["supervisor", ctx.settings.supervisorRole],
    ["pk", ctx.settings.pkRole],
    ["ban", ctx.settings.banRole]
  ];
  for (const [label, id] of roleChecks) {
    if (!id) {
      issues.push(`Rol ${label}: lipsă`);
      continue;
    }
    const role = ctx.guild.roles.cache.get(id);
    if (!role) issues.push(`Rol ${label}: nu a fost găsit`);
  }

  return issues;
}

function configChannelsView(ctx) {
  const emb = makeEmbed("Config — Canale", "Owner/Config. Setează canalele botului.");
  const lines = [
    `Audit: ${ctx.settings.audit ? `<#${ctx.settings.audit}>` : "(unset)"}`,
    `Alert: ${ctx.settings.alert ? `<#${ctx.settings.alert}>` : "(unset)"}`,
    `Warn: ${ctx.settings.warn ? `<#${ctx.settings.warn}>` : "(unset)"}`,
    `Bot Channel: ${ctx.settings.botChannel ? `<#${ctx.settings.botChannel}>` : "(unset)"}`
  ];
  emb.setDescription(emb.data.description + "\n\n" + lines.join("\n"));

  const buttons = [
    btn("famenu:setchannel:audit", "Set Audit", ButtonStyle.Secondary),
    btn("famenu:setchannel:alert", "Set Alert", ButtonStyle.Secondary),
    btn("famenu:setchannel:warn", "Set Warn", ButtonStyle.Secondary),
    btn("famenu:setchannel:bot", "Set Bot Channel", ButtonStyle.Secondary),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function configRateLimitView(ctx) {
  const emb = makeEmbed("Config — Rate limit", "Owner/Config. Limitează acțiunile pe minut.");
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
  const emb = makeEmbed("FAMenu — Admin", `Organizații: **${c.orgs}** · Membri DB: **${c.members}** · PK: **${c.pk}** · Ban: **${c.bans}**\n\nAlege un modul:`);
  const buttons = [
    btn("famenu:orgs", "Organizații", ButtonStyle.Primary, "🏛️"),
    btn("famenu:config", "Config", ButtonStyle.Secondary, "⚙️"),
    btn("famenu:diag", "Diagnostic", ButtonStyle.Secondary, "🩺"),
    requireSupervisorOrOwner(ctx) ? btn("famenu:warns", "Warns", ButtonStyle.Secondary, "⚠️") : null,
    requireSupervisorOrOwner(ctx) ? btn("famenu:cooldowns", "Cooldowns", ButtonStyle.Secondary, "⏳") : null
  ];
  const rows = rowsFromButtons(buttons.filter(Boolean));
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rows);
}

async function famenuConfig(interaction, ctx) {
  if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config poate modifica configurările.");
  const issues = configIssues(ctx);
  const desc = [
    "Setează roluri, canale și rate limit.",
    issues.length ? `\n⚠️ Probleme detectate:\n- ${issues.join("\n- ")}` : "\n✅ Configurarea pare completă."
  ].join("\n");
  const emb = makeEmbed("Config — Sistem", desc);
  const buttons = [
    btn("famenu:config:roles", "Roluri de acces", ButtonStyle.Secondary, "🔐"),
    btn("famenu:config:channels", "Canale", ButtonStyle.Secondary, "📣"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️"),
  ];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function famenuOrgs(interaction, ctx) {
  if (!ctx.perms.staff) return sendEphemeral(interaction, "⛔ Acces refuzat", "Nu ai acces.");
  const orgs = repo.listOrgs(ctx.db);
  const desc = orgs.length
    ? orgs.map(o => `• **${o.name}** · ${humanKind(o.kind)} · ID: \`${o.id}\``).join("\n")
    : "Nu există organizații încă.";
  const emb = makeEmbed("Organizații", desc);

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
    config: "config_role_id",
    pk: "pk_role_id",
    ban: "ban_role_id",
  };
  const key = map[which];
  return modal(`famenu:setrole_modal:${which}`, "Set Role ID", [
    input("role_id", "Role ID ", undefined, true, "Ex: 123... sau @Rol")
  ]);
}

function setChannelModal(which) {
  return modal(`famenu:setchannel_modal:${which}`, "Set Channel ID", [
    input("channel_id", "Channel ID ", undefined, true, "Ex: 123... sau #canal")
  ]);
}


function warnAddModal() {
  return modal("famenu:warn_add_modal", "Adaugă warn", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv", undefined, true, "Ex: 2 Mafii la bătaie"),
    input("drept_plata", "DREPT PLATA (DA/NU)", undefined, true, "DA / NU"),
  ]);
}

function warnsView(ctx) {
  const emb = makeEmbed("Warns", "Gestionare warn-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:warn_add", "Adaugă warn", ButtonStyle.Primary, "➕"),
    btn("famenu:warn_remove", "Șterge warn", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:warn_list", "Listă active", ButtonStyle.Secondary, "📋"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownsAdminView(ctx) {
  const emb = makeEmbed("Cooldowns", "Gestionează cooldown-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:cooldown_add", "Adaugă cooldown", ButtonStyle.Primary, "➕"),
    btn("famenu:cooldown_remove", "Șterge cooldown", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownAddModal() {
  return modal("famenu:cooldown_add_modal", "Adaugă cooldown", [
    input("user", "User ID", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN"),
    input("duration", "Durată (ex: 30s, 10m, 1d, 1y)", undefined, true, "30s / 10m / 1d")
  ]);
}

function cooldownRemoveModal() {
  return modal("famenu:cooldown_remove_modal", "Șterge cooldown", [
    input("user", "User ID", undefined, true, "Ex: 123..."),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN")
  ]);
}

function warnAddModalForm() {
  return modal("famenu:warn_add_modal", "Adaugă warn", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv", undefined, true, "Ex: 2 Mafii la bătaie"),
    input("drept_plata", "DREPT PLATA (DA/NU)", undefined, true, "DA / NU"),
    input("sanctiune", "SANCTIUNEA OFERITA", undefined, true, "1/3 Mafia Warn")
  ]);
}

function warnRemoveModal() {
  return modal("famenu:warn_remove_modal", "Șterge warn", [
    input("warn_id", "Warn ID", undefined, true, "Ex: UUID"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: anulare")
  ]);
}

function warnAddModalForm() {
  return modal("famenu:warn_add_modal", "Adaugă warn", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv", undefined, true, "Ex: 2 Mafii la bătaie"),
    input("drept_plata", "DREPT PLATA (DA/NU)", undefined, true, "DA / NU"),
    input("sanctiune", "SANCTIUNEA OFERITA", undefined, true, "1/3 Mafia Warn")
  ]);
}

function warnRemoveModal() {
  return modal("famenu:warn_remove_modal", "Șterge warn", [
    input("warn_id", "Warn ID", undefined, true, "Ex: UUID"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: anulare")
  ]);
}

function warnsView(ctx) {
  const emb = makeEmbed("Warns", "Gestionare warn-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:warn_add", "Adaugă warn", ButtonStyle.Primary, "➕"),
    btn("famenu:warn_remove", "Șterge warn", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:warn_list", "Listă active", ButtonStyle.Secondary, "📋"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownsAdminView(ctx) {
  const emb = makeEmbed("Cooldowns", "Gestionează cooldown-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:cooldown_add", "Adaugă cooldown", ButtonStyle.Primary, "➕"),
    btn("famenu:cooldown_remove", "Șterge cooldown", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownAddModal() {
  return modal("famenu:cooldown_add_modal", "Adaugă cooldown", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN"),
    input("duration", "Durată (ex: 30s, 10m, 1d, 1y)", undefined, true, "30s / 10m / 1d")
  ]);
}

function cooldownRemoveModal() {
  return modal("famenu:cooldown_remove_modal", "Șterge cooldown", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN")
  ]);
}

function warnAddModalForm() {
  return modal("famenu:warn_add_modal", "Adaugă warn", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv", undefined, true, "Ex: 2 Mafii la bătaie"),
    input("drept_plata", "DREPT PLATA (DA/NU)", undefined, true, "DA / NU"),
    input("sanctiune", "SANCTIUNEA OFERITA", undefined, true, "1/3 Mafia Warn")
  ]);
}

function warnRemoveModal() {
  return modal("famenu:warn_remove_modal", "Șterge warn", [
    input("warn_id", "Warn ID", undefined, true, "Ex: UUID"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: anulare")
  ]);
}

function warnsView(ctx) {
  const emb = makeEmbed("Warns", "Gestionare warn-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:warn_add", "Adaugă warn", ButtonStyle.Primary, "➕"),
    btn("famenu:warn_remove", "Șterge warn", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:warn_list", "Listă active", ButtonStyle.Secondary, "📋"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownsAdminView(ctx) {
  const emb = makeEmbed("Cooldowns", "Gestionează cooldown-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:cooldown_add", "Adaugă cooldown", ButtonStyle.Primary, "➕"),
    btn("famenu:cooldown_remove", "Șterge cooldown", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownAddModal() {
  return modal("famenu:cooldown_add_modal", "Adaugă cooldown", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN"),
    input("duration", "Durată (ex: 30s, 10m, 1d, 1y)", undefined, true, "30s / 10m / 1d")
  ]);
}

function cooldownRemoveModal() {
  return modal("famenu:cooldown_remove_modal", "Șterge cooldown", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN")
  ]);
}

function warnAddModalForm() {
  return modal("famenu:warn_add_modal", "Adaugă warn", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv", undefined, true, "Ex: 2 Mafii la bătaie"),
    input("drept_plata", "DREPT PLATA (DA/NU)", undefined, true, "DA / NU"),
    input("sanctiune", "SANCTIUNEA OFERITA", undefined, true, "1/3 Mafia Warn")
  ]);
}

function warnRemoveModal() {
  return modal("famenu:warn_remove_modal", "Șterge warn", [
    input("warn_id", "Warn ID", undefined, true, "Ex: UUID"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: anulare")
  ]);
}

function warnsView(ctx) {
  const emb = makeEmbed("Warns", "Gestionare warn-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:warn_add", "Adaugă warn", ButtonStyle.Primary, "➕"),
    btn("famenu:warn_remove", "Șterge warn", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:warn_list", "Listă active", ButtonStyle.Secondary, "📋"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownsAdminView(ctx) {
  const emb = makeEmbed("Cooldowns", "Gestionează cooldown-uri (Supervisor/Owner).");
  const buttons = [
    btn("famenu:cooldown_add", "Adaugă cooldown", ButtonStyle.Primary, "➕"),
    btn("famenu:cooldown_remove", "Șterge cooldown", ButtonStyle.Secondary, "🗑️"),
    btn("famenu:back", "Back", ButtonStyle.Secondary, "⬅️")
  ];
  return { emb, rows: rowsFromButtons(buttons) };
}

function cooldownAddModal() {
  return modal("famenu:cooldown_add_modal", "Adaugă cooldown", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN"),
    input("duration", "Durată (ex: 30s, 10m, 1d, 1y)", undefined, true, "30s / 10m / 1d")
  ]);
}

function cooldownRemoveModal() {
  return modal("famenu:cooldown_remove_modal", "Șterge cooldown", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("kind", "Tip (PK/BAN)", undefined, true, "PK sau BAN")
  ]);
}

function deleteOrgModal() {
  return modal("famenu:deleteorg_modal", "Delete organizatie", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
    input("reason", "Motiv (opțional)", undefined, false, "Ex: desființare")
  ]);
}

function addMembersModal(orgId) {
  return modal(`org:${orgId}:add_modal`, "Add membri", [
    input("users", "User ID-uri (multi-line)", 2, true, "Ex:\n123...\n@Player"),
  ]);
}
function removeMembersModal(orgId, pk) {
  return modal(`org:${orgId}:${pk?'remove_pk':'remove'}_modal`, pk ? "Remove (PK)" : "Remove", [
    input("users", "User ID-uri (multi-line)", 2, true, "Ex:\n123...\n@Player"),
  ]);
}
function searchModal(orgId) {
  return modal(`org:${orgId}:search_modal`, "Search player", [
    input("user", "User ID", undefined, true, "Ex: 123... / @Player"),
  ]);
}

function reconcileOrgModal() {
  return modal("famenu:reconcile_org_modal", "Reconcile organizație", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
  ]);
}

function setRankModal(orgId) {
  return modal(`org:${orgId}:setrank_modal`, "Setează rank", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("rank", "Rank (LEADER/COLEADER/MEMBER)", undefined, true, "Ex: COLEADER")
  ]);
}

function reconcileOrgModal() {
  return modal("famenu:reconcile_org_modal", "Reconcile organizație", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
  ]);
}

function setRankModal(orgId) {
  return modal(`org:${orgId}:setrank_modal`, "Setează rank", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("rank", "Rank (LEADER/COLEADER/MEMBER)", undefined, true, "Ex: COLEADER")
  ]);
}

function reconcileOrgModal() {
  return modal("famenu:reconcile_org_modal", "Reconcile organizație", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
  ]);
}

function setRankModal(orgId) {
  return modal(`org:${orgId}:setrank_modal`, "Setează rank", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("rank", "Rank (LEADER/COLEADER/MEMBER)", undefined, true, "Ex: COLEADER")
  ]);
}

function reconcileOrgModal() {
  return modal("famenu:reconcile_org_modal", "Reconcile organizație", [
    input("org_id", "Org ID", undefined, true, "ID din lista Organizații"),
  ]);
}

function setRankModal(orgId) {
  return modal(`org:${orgId}:setrank_modal`, "Setează rank", [
    input("user", "User ID sau @mention", undefined, true, "Ex: 123... / @Player"),
    input("rank", "Rank (LEADER/COLEADER/MEMBER)", undefined, true, "Ex: COLEADER")
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
  const illegalOrgs = repo.listOrgs(ctx.db).filter(org => org.kind === "ILLEGAL");
  const hasIllegalRole = illegalOrgs.some(org => hasRole(ctx.member, org.member_role_id));
  if (!hasIllegalRole && !ctx.perms.staff) {
    return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar membrii organizațiilor ILLEGAL pot folosi /falert.");
  }
  // ping in alert channel
  const alertChId = ctx.settings.alert;
  if (!alertChId) return sendEphemeral(interaction, "Config lipsă", "Alert channel nu este setat în /famenu → Config → Canale.");
  const ch = await ctx.guild.channels.fetch(alertChId).catch((err)=> {
    console.error("[FALERT] fetch channel failed:", err);
    return null;
  });
  if (!ch || !ch.isTextBased()) return sendEphemeral(interaction, "Eroare", "Nu pot accesa alert channel. Verifică ID-ul/perms.");

  const orgs = illegalOrgs;
  if (!orgs.length) {
    return sendEphemeral(interaction, "Fără organizații ILLEGAL", "Nu există organizații ILLEGAL configurate pentru alertă.");
  }

  const roleIds = [...new Set(orgs.map(org => org.member_role_id).filter(Boolean))];
  if (!roleIds.length) {
    return sendEphemeral(interaction, "Roluri lipsă", "Organizațiile ILLEGAL nu au roluri configurate pentru ping.");
  }

  setGlobal(ctx.db, "falert_last_ts", String(now()));
  // ping roles: use member_role_id for all orgs
  const pings = roleIds.map(roleId => `<@&${roleId}>`).join(" ");
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

  const orgs = repo.listOrgs(ctx.db);
  const discordMembers = members.filter(m => m.roles.cache.has(org.member_role_id));
  const discordIds = new Set(discordMembers.map(m => m.id));
  const dbMembers = repo.listMembersByOrg(ctx.db, orgId);
  const dbIds = new Set(dbMembers.map(m => m.user_id));

  let added = 0;
  let removed = 0;
  const multiOrg = [];

  for (const m of discordMembers.values()) {
    if (!dbIds.has(m.id)) {
      repo.upsertMembership(ctx.db, m.id, orgId, "MEMBER");
      added++;
    }
    const otherOrgs = orgs
      .filter(o => o.id !== org.id && o.member_role_id && m.roles.cache.has(o.member_role_id))
      .map(o => o.name);
    if (otherOrgs.length) {
      multiOrg.push(`<@${m.id}> → ${otherOrgs.join(", ")}`);
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
  if (multiOrg.length) {
    const sample = multiOrg.slice(0, 8).join("\n");
    const extra = multiOrg.length > 8 ? `\n...și încă ${multiOrg.length - 8}` : "";
    await audit(ctx, "Avertisment org-uri multiple", `Org: **${org.name}**\nDetectați membri cu roluri multiple (nu s-a făcut auto-fix):\n${sample}${extra}`);
  }

  return { ok:true, added, removed, org };
}

async function sendWarnMessage(ctx, embed) {
  const warnChannelId = ctx.settings.warn;
  if (!warnChannelId) return { ok:false, msg:"Warn channel nu este setat." };
  try {
    const ch = await ctx.guild.channels.fetch(warnChannelId);
    if (!ch || !ch.isTextBased()) {
      console.error("[WARN] Invalid warn channel:", warnChannelId);
      return { ok:false, msg:"Warn channel invalid." };
    }
    const msg = await ch.send({ embeds: [embed] });
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
        await audit(ctx, "Reconcile PK", `User: <@${m.id}> | PK creat (manual role detectat) | Expiră: ${formatTs(expiresAt)} | De: <@${ctx.uid}>`);
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
        await audit(ctx, "Reconcile BAN", `User: <@${m.id}> | BAN creat (manual role detectat) | Expiră: ${formatTs(expiresAt)} | De: <@${ctx.uid}>`);
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
  // remove org roles (member/leader/co-leader)
  const org = repo.getOrg(ctx.db, orgId);
  if (org) {
    const canManage = canManageTargetRank(ctx, org, targetMember);
    if (!canManage.ok) return { ok:false, msg: canManage.msg };
    const roleIds = [org.member_role_id, org.leader_role_id, org.co_leader_role_id].filter(Boolean);
    for (const roleId of roleIds) {
      if (!targetMember.roles.cache.has(roleId)) continue;
      const check = roleCheck(ctx, roleId, "organizație");
      if (!check.ok) return { ok:false, msg: check.msg };
      const removed = await safeRoleRemove(targetMember, roleId, `PK remove org role ${roleId} for ${targetMember.id}`);
      if (!removed) return { ok:false, msg:"Nu pot elimina rolurile organizației (permisiuni lipsă)." };
    }
  } else {
    console.error(`[PK] Org not found for orgId ${orgId}`);
  }
  const expiresAt = now() + PK_MS;
  repo.upsertCooldown(ctx.db, targetMember.id, "PK", expiresAt, orgId, now());
  repo.removeMembership(ctx.db, targetMember.id);
  repo.upsertLastOrgState(ctx.db, targetMember.id, orgId, now(), byUserId);

  const addedPk = await safeRoleAdd(targetMember, pkRole, `Apply PK for ${targetMember.id}`);
  if (!addedPk) return { ok:false, msg:"Nu pot aplica rolul PK (permisiuni lipsă)." };
  await audit(ctx, "Remove cu PK", `User: <@${targetMember.id}> | Org: **${org?.name ?? orgId}** | Expiră: ${formatTs(expiresAt)} | De: <@${byUserId}>`);
  return { ok:true };
}

async function removeFromOrg(ctx, targetMember, orgId, byUserId) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[REMOVE] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }
  const canManage = canManageTargetRank(ctx, org, targetMember);
  if (!canManage.ok) return { ok:false, msg: canManage.msg };
  const orgRoleCheck = roleCheck(ctx, org.member_role_id, "membru");
  if (!orgRoleCheck.ok) return { ok:false, msg: orgRoleCheck.msg };
  const removed = await safeRoleRemove(targetMember, org.member_role_id, `Remove org role for ${targetMember.id}`);
  if (!removed) return { ok:false, msg:"Nu pot elimina rolul organizației (permisiuni lipsă)." };
  repo.removeMembership(ctx.db, targetMember.id);
  repo.upsertLastOrgState(ctx.db, targetMember.id, orgId, now(), byUserId);
  await audit(ctx, "Membru scos", `User: <@${targetMember.id}> | Org: **${org.name}** | De: <@${byUserId}>`);
  return { ok:true };
}

async function addToOrg(ctx, targetMember, orgId, role) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[ADD] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }

  const orgs = repo.listOrgs(ctx.db);
  const otherOrgRoles = orgs
    .filter(o => o.id !== org.id && o.member_role_id && targetMember.roles.cache.has(o.member_role_id))
    .map(o => o.name);
  if (otherOrgRoles.length && !ctx.perms.staff) {
    return { ok:false, msg:`Userul are deja rol(uri) de organizație: ${otherOrgRoles.join(", ")}.` };
  }
  if (otherOrgRoles.length && ctx.perms.staff) {
    await audit(ctx, "Avertisment organizații multiple", `User: <@${targetMember.id}> | Org țintă: **${org.name}** | Alte org-uri: ${otherOrgRoles.join(", ")}`);
  }

  const existing = repo.getMembership(ctx.db, targetMember.id);
  if (existing) {
    if (existing.org_id === orgId) {
      return { ok:false, msg:"Userul este deja în această organizație." };
    }
    const existingOrg = repo.getOrg(ctx.db, existing.org_id);
    return { ok:false, msg:`Userul este deja într-o altă organizație (${existingOrg?.name ?? existing.org_id}).` };
  }

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

  const orgRoleCheck = roleCheck(ctx, org.member_role_id, "membru");
  if (!orgRoleCheck.ok) return { ok:false, msg: orgRoleCheck.msg };
  const added = await safeRoleAdd(targetMember, org.member_role_id, `Add org role for ${targetMember.id}`);
  if (!added) return { ok:false, msg:"Nu pot adăuga rolul organizației (permisiuni lipsă)." };
  repo.upsertMembership(ctx.db, targetMember.id, orgId, role || "MEMBER");
  await audit(ctx, "Membru adăugat", `User: <@${targetMember.id}> | Org: **${org.name}** | De: <@${ctx.uid}>`);
  return { ok:true };
}

async function setMemberRank(ctx, targetMember, orgId, desiredRank) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    console.error(`[RANK] Org not found for orgId ${orgId}`);
    return { ok:false, msg:"Organizația nu există." };
  }
  if (!ctx.perms.staff && getOrgRank(ctx.member, org) !== "LEADER") {
    return { ok:false, msg:"Doar liderul poate schimba rank-urile în organizație." };
  }
  const rankCheck = canSetRank(ctx, org, desiredRank, targetMember);
  if (!rankCheck.ok) return { ok:false, msg: rankCheck.msg };

  const memberRoleCheck = roleCheck(ctx, org.member_role_id, "membru");
  if (!memberRoleCheck.ok) return { ok:false, msg: memberRoleCheck.msg };
  if (!targetMember.roles.cache.has(org.member_role_id)) {
    const addedMember = await safeRoleAdd(targetMember, org.member_role_id, `Ensure org role for ${targetMember.id}`);
    if (!addedMember) return { ok:false, msg:"Nu pot adăuga rolul organizației (permisiuni lipsă)." };
    repo.upsertMembership(ctx.db, targetMember.id, orgId, "MEMBER");
  }

  const leaderRoleCheck = org.leader_role_id ? roleCheck(ctx, org.leader_role_id, "leader") : null;
  const coLeaderRoleCheck = org.co_leader_role_id ? roleCheck(ctx, org.co_leader_role_id, "co-leader") : null;
  if (org.leader_role_id && !leaderRoleCheck?.ok) return { ok:false, msg: leaderRoleCheck.msg };
  if (org.co_leader_role_id && !coLeaderRoleCheck?.ok) return { ok:false, msg: coLeaderRoleCheck.msg };

  if (desiredRank === "LEADER") {
    if (org.co_leader_role_id) {
      await safeRoleRemove(targetMember, org.co_leader_role_id, `Unset co-leader for ${targetMember.id}`);
    }
    const added = await safeRoleAdd(targetMember, org.leader_role_id, `Set leader for ${targetMember.id}`);
    if (!added) return { ok:false, msg:"Nu pot seta rolul de Leader (permisiuni lipsă)." };
  } else if (desiredRank === "COLEADER") {
    if (!org.co_leader_role_id) return { ok:false, msg:"Rolul de Co-Leader nu este setat." };
    if (org.leader_role_id) {
      await safeRoleRemove(targetMember, org.leader_role_id, `Unset leader for ${targetMember.id}`);
    }
    const added = await safeRoleAdd(targetMember, org.co_leader_role_id, `Set co-leader for ${targetMember.id}`);
    if (!added) return { ok:false, msg:"Nu pot seta rolul de Co-Leader (permisiuni lipsă)." };
  } else {
    if (org.leader_role_id) {
      await safeRoleRemove(targetMember, org.leader_role_id, `Unset leader for ${targetMember.id}`);
    }
    if (org.co_leader_role_id) {
      await safeRoleRemove(targetMember, org.co_leader_role_id, `Unset co-leader for ${targetMember.id}`);
    }
  }

  await audit(ctx, "Update rank", `User: <@${targetMember.id}> | Org: **${org.name}** | Rank: **${desiredRank}** | De: <@${ctx.uid}>`);
  return { ok:true };
}

async function rosterView(interaction, ctx, orgId, useEditReply = false) {
  const org = repo.getOrg(ctx.db, orgId);
  if (!org) {
    const emb = makeEmbed("Eroare", "Organizația nu există.");
    return useEditReply ? interaction.editReply({ embeds: [emb] }) : sendEphemeral(interaction, emb.data.title, emb.data.description);
  }
  const { members, retryMs } = await fetchMembersWithRetry(ctx.guild, "ROSTER");
  if (!members) {
    const reason = retryMs > 0
      ? `Discord rate limit. Încearcă din nou în ~${Math.ceil(retryMs / 1000)}s.`
      : "Nu pot prelua membrii guild-ului.";
    const emb = makeEmbed("Eroare", reason);
    return useEditReply ? interaction.editReply({ embeds: [emb] }) : sendEphemeral(interaction, emb.data.title, emb.data.description);
  }
  const leaderRole = org.leader_role_id ? ctx.guild.roles.cache.get(org.leader_role_id) : null;
  const coLeaderRole = org.co_leader_role_id ? ctx.guild.roles.cache.get(org.co_leader_role_id) : null;
  const memberRole = org.member_role_id ? ctx.guild.roles.cache.get(org.member_role_id) : null;
  const orgMembers = members.filter(m => m.roles.cache.has(org.member_role_id));

  const entries = [];
  for (const m of orgMembers.values()) {
    let label = memberRole?.name || "Membru";
    if (org.leader_role_id && m.roles.cache.has(org.leader_role_id)) label = leaderRole?.name || "Leader";
    else if (org.co_leader_role_id && m.roles.cache.has(org.co_leader_role_id)) label = coLeaderRole?.name || "Co-Leader";
    entries.push({ id: m.id, label, order: label === (leaderRole?.name || "Leader") ? 0 : label === (coLeaderRole?.name || "Co-Leader") ? 1 : 2 });
  }
  entries.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const lines = entries.map(e => `• <@${e.id}> — **${e.label}**`);
  const shown = lines.slice(0, 50);
  const extra = lines.length > 50 ? `\n... și încă ${lines.length - 50} membri` : "";
  const desc = shown.length ? `${shown.join("\n")}${extra}` : "Nu există membri în organizație.";
  const emb = makeEmbed(`Roster — ${org.name}`, desc);
  const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];
  if (useEditReply) {
    return interaction.editReply({ embeds: [emb], components: rowsFromButtons(buttons) });
  }
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function cooldownsView(interaction, ctx, orgId) {
  const pk = repo.listCooldowns(ctx.db, "PK").filter(r => r.expires_at > now());
  const ban = repo.listCooldowns(ctx.db, "BAN").filter(r => r.expires_at > now());
  const emb = makeEmbed("Cooldowns", `PK activi: **${pk.length}**\nBAN activi: **${ban.length}**`);
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

  const emb = makeEmbed("Search", lines.join("\n"));
  const buttons = [btn(`org:${orgId}:back`, "Back", ButtonStyle.Secondary, "⬅️")];
  return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons(buttons));
}

async function handleModal(interaction, ctx) {
  const id = interaction.customId;

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
    const memberCheck = roleCheck(ctx, member_role_id, "membru");
    if (!memberCheck.ok) return sendEphemeral(interaction, "Eroare", memberCheck.msg);
    const leaderCheck = roleCheck(ctx, leader_role_id, "leader");
    if (!leaderCheck.ok) return sendEphemeral(interaction, "Eroare", leaderCheck.msg);
    if (co_leader_role_id) {
      const coCheck = roleCheck(ctx, co_leader_role_id, "co-leader");
      if (!coCheck.ok) return sendEphemeral(interaction, "Eroare", coCheck.msg);
    }
    const orgId = repo.createOrg(ctx.db, { name, kind, member_role_id, leader_role_id, co_leader_role_id: co_leader_role_id || null });
    await audit(ctx, "Create organizatie", `Org: **${name}** (${humanKind(kind)}) | ID: \`${orgId}\` | De catre: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Creat", `Organizația **${name}** a fost creată. (ID: \`${orgId}\`)`);
  }

  if (id.startsWith("famenu:setrole_modal:")) {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config poate schimba rolurile.");
    const which = id.split(":")[2];
    const roleId = interaction.fields.getTextInputValue("role_id")?.replace(/[<@&#>]/g,"").trim();
    const map = {
      admin: "admin_role_id",
      supervisor: "supervisor_role_id",
      config: "config_role_id",
      pk: "pk_role_id",
      ban: "ban_role_id",
    };
    const key = map[which];
    if (!key || !roleId) return sendEphemeral(interaction, "Eroare", "Role ID invalid.");
    const check = roleCheck(ctx, roleId, which);
    if (!check.ok) return sendEphemeral(interaction, "Eroare", check.msg);
    setSetting(ctx.db, key, roleId);
    await audit(ctx, "Config update", `Set **${key}** = \`${roleId}\` | De catre: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Salvat", "Rolul a fost setat.");
  }

  if (id.startsWith("famenu:setchannel_modal:")) {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config poate schimba canalele.");
    const which = id.split(":")[2];
    const channelId = interaction.fields.getTextInputValue("channel_id")?.replace(/[<#>]/g,"").trim();
    const map = { audit: "audit_channel_id", alert: "alert_channel_id", warn: "warn_channel_id", bot: "bot_channel_id" };
    const key = map[which];
    if (!key || !channelId) return sendEphemeral(interaction, "Eroare", "Channel ID invalid.");
    const channel = ctx.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return sendEphemeral(interaction, "Eroare", "Canal invalid sau nu este text.");
    setSetting(ctx.db, key, channelId);
    await audit(ctx, "Config update", `Set **${key}** = \`${channelId}\` | De catre: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Salvat", "Canalul a fost setat.");
  }

  if (id === "famenu:setratelimit_modal") {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config poate schimba rate limit.");
    const v = interaction.fields.getTextInputValue("value")?.trim();
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 200) return sendEphemeral(interaction, "Eroare", "Valoare invalidă (1-200).");
    setSetting(ctx.db, "rate_limit_per_min", String(n));
    await audit(ctx, "Config update", `Set **rate_limit_per_min** = \`${n}\` | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Salvat", `Rate limit setat la ${n}/min.`);
  }

  if (id === "famenu:deleteorg_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot șterge organizații.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const orgId = Number(interaction.fields.getTextInputValue("org_id")?.trim());
    const reason = interaction.fields.getTextInputValue("reason")?.trim();
    const org = repo.getOrg(ctx.db, orgId);
    if (!org) return interaction.editReply({ embeds: [makeEmbed("Eroare", "Org ID invalid.")] });
    if (!ctx.settings.pkRole) {
      return interaction.editReply({ embeds: [makeEmbed("Config lipsă", "PK role nu este setat. Setează-l în /famenu → Config → Roluri.")] });
    }

    // Put everyone in PK cooldown 3 days on delete
    const { members, retryMs } = await fetchMembersWithRetry(ctx.guild, "DELETE ORG");
    if (!members) {
      const msg = retryMs > 0
        ? `Discord rate limit. Încearcă din nou în ~${Math.ceil(retryMs / 1000)}s.`
        : "Nu pot prelua membrii guild-ului pentru PK.";
      return interaction.editReply({ embeds: [makeEmbed("Eroare", msg)] });
    }
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
    return interaction.editReply({ embeds: [makeEmbed("Șters", `Organizația **${org.name}** a fost ștearsă. Membrii au primit PK 3 zile.`)] });
  }

  if (id === "famenu:reconcile_org_modal") {
    if (!requireStaff(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar staff poate folosi această acțiune.");
    const orgId = Number(interaction.fields.getTextInputValue("org_id")?.trim());
    if (!orgId) return sendEphemeral(interaction, "Eroare", "Org ID invalid.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { members, retryMs } = await fetchMembersWithRetry(ctx.guild, "RECONCILE ORG");
    if (!members) {
      const msg = retryMs > 0
        ? `Discord rate limit. Încearcă din nou în ~${Math.ceil(retryMs / 1000)}s.`
        : "Nu pot prelua membrii guild-ului.";
      return interaction.editReply({ embeds: [makeEmbed("Eroare", msg)] });
    }
    const res = await reconcileOrg(ctx, orgId, members);
    if (!res.ok) return interaction.editReply({ embeds: [makeEmbed("Eroare", res.msg || "Reconcile eșuat.")] });
    const summary = `Org: **${res.org.name}**\nAdded: **${res.added}**\nRemoved: **${res.removed}**`;
    return interaction.editReply({ embeds: [makeEmbed("Reconcile org", summary)] });
  }

  if (id === "famenu:warn_add_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona warn-uri.");
    const orgId = Number(interaction.fields.getTextInputValue("org_id")?.trim());
    const reason = interaction.fields.getTextInputValue("reason")?.trim();
    const dreptPlataRaw = interaction.fields.getTextInputValue("drept_plata")?.trim();
    const sanctiune = interaction.fields.getTextInputValue("sanctiune")?.trim();
    const dreptPlata = parseYesNo(dreptPlataRaw);
    if (!orgId) return sendEphemeral(interaction, "Eroare", "Org ID invalid.");
    if (!reason) return sendEphemeral(interaction, "Eroare", "Motivul este obligatoriu.");
    if (dreptPlata === null) return sendEphemeral(interaction, "Eroare", "DREPT PLATA trebuie să fie DA/NU.");
    if (!sanctiune) return sendEphemeral(interaction, "Eroare", "Sanctiunea este obligatorie.");
    if (!ctx.settings.warn) return sendEphemeral(interaction, "Config lipsă", "Warn channel nu este setat în /famenu → Config → Canale.");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const warnId = generateWarnId();
    const createdAt = now();
    const expiresAt = createdAt + 90 * 24 * 60 * 60 * 1000;
    const org = repo.getOrg(ctx.db, orgId);
    if (!org) return interaction.editReply({ embeds: [makeEmbed("Eroare", "Org ID invalid.")] });
    const activeWarns = repo.listWarnsByStatus(ctx.db, "ACTIVE", 100).filter(w => {
      try {
        const payload = JSON.parse(w.payload_json || "{}");
        return Number(w.org_id) === orgId;
      } catch {
        return false;
      }
    });
    const totalWarn = `${Math.min(activeWarns.length + 1, WARN_MAX)}/${WARN_MAX}`;
    const payload = {
      org_id: orgId,
      org_name: org.name,
      org_role_id: org.member_role_id,
      reason,
      drept_plata: dreptPlata,
      sanctiune,
      expira_90: true,
      created_by: ctx.uid,
      total_warn: totalWarn
    };

    repo.createWarn(ctx.db, {
      warn_id: warnId,
      org_id: orgId,
      message_id: null,
      created_by: ctx.uid,
      created_at: createdAt,
      expires_at: expiresAt,
      status: "ACTIVE",
      payload_json: JSON.stringify(payload)
    });

    const warnEmbed = buildWarnEmbed({
      orgName: org.name,
      orgRoleId: org.member_role_id,
      reason,
      dreptPlata,
      sanctiune,
      expiresAt,
      totalWarn,
      warnId
    });
    const msgRes = await sendWarnMessage(ctx, warnEmbed);
    if (!msgRes.ok) return interaction.editReply({ embeds: [makeEmbed("Eroare", msgRes.msg || "Nu pot trimite warn.")] });
    repo.updateWarnMessageId(ctx.db, warnId, msgRes.messageId);
    await audit(ctx, "Warn aplicat", `Organizație: **${org.name}** | Warn ID: \`${warnId}\` | Expiră: ${formatTs(expiresAt)} | De: <@${ctx.uid}>`);
    return interaction.editReply({ embeds: [makeEmbed("Warn creat", `Warn \`${warnId}\` pentru **${org.name}** (expiră ${formatTs(expiresAt)}).`)] });
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
          const eb = new EmbedBuilder(embed?.data ?? {});
          const nextDesc = setWarnStatusLine(eb.data.description || "", "Status: ✅ ȘTEARSĂ");
          eb.setDescription(nextDesc)
            .setColor(COLORS.ERROR)
            .setFooter({ text: `ȘTERS • ${reason || "fără motiv"}` });
          await msg.edit({ embeds: [eb] }).catch((err)=> {
            console.error("[WARN] edit message failed:", err);
          });
        }
      }
    }

    await audit(ctx, "Warn șters", `Warn ID: \`${warnId}\` | De: <@${ctx.uid}> | Motiv: ${reason || "-"}`);
    return sendEphemeral(interaction, "Warn șters", `Warn \`${warnId}\` a fost marcat ca REMOVED.`);
  }

  if (id === "famenu:cooldown_add_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona cooldown-uri.");
    const userId = parseUserIds(interaction.fields.getTextInputValue("user"))[0];
    const kindRaw = interaction.fields.getTextInputValue("kind")?.trim().toUpperCase();
    const durationRaw = interaction.fields.getTextInputValue("duration")?.trim();
    if (!userId) return sendEphemeral(interaction, "Eroare", "User ID invalid.");
    if (!["PK", "BAN"].includes(kindRaw)) return sendEphemeral(interaction, "Eroare", "Tip invalid (PK/BAN).");
    const existing = repo.getCooldown(ctx.db, userId, kindRaw);
    if (existing && existing.expires_at > now()) {
      return sendEphemeral(interaction, "Eroare", "Userul are deja un cooldown activ pentru acest tip.");
    }
    const roleId = kindRaw === "PK" ? ctx.settings.pkRole : ctx.settings.banRole;
    if (!roleId) return sendEphemeral(interaction, "Config lipsă", `Rolul ${kindRaw} nu este setat în /famenu → Config → Roluri.`);
    const roleCheckRes = roleCheck(ctx, roleId, kindRaw.toLowerCase());
    if (!roleCheckRes.ok) return sendEphemeral(interaction, "Eroare", roleCheckRes.msg);
    const durationMs = parseDurationMs(durationRaw);
    if (!durationMs) return sendEphemeral(interaction, "Eroare", "Durată invalidă (ex: 30s, 10m, 1d, 1y).");
    const expiresAt = now() + durationMs;
    repo.upsertCooldown(ctx.db, userId, kindRaw, expiresAt, null, now());
    const member = await ctx.guild.members.fetch(userId).catch(()=>null);
    if (member) {
      const added = await safeRoleAdd(member, roleId, `Cooldown add ${kindRaw} for ${userId}`);
      if (!added) return sendEphemeral(interaction, "Eroare", "Nu pot aplica rolul cooldown (permisiuni lipsă).");
    }
    await audit(ctx, "Cooldown aplicat", `User: <@${userId}> | Tip: **${kindRaw}** | Expiră: ${formatTs(expiresAt)} | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Cooldown aplicat", `User: <@${userId}> | Tip: **${kindRaw}** | Expiră: ${formatTs(expiresAt)}`);
  }

  if (id === "famenu:cooldown_remove_modal") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona cooldown-uri.");
    const userId = parseUserIds(interaction.fields.getTextInputValue("user"))[0];
    const kindRaw = interaction.fields.getTextInputValue("kind")?.trim().toUpperCase();
    if (!userId) return sendEphemeral(interaction, "Eroare", "User ID invalid.");
    if (!["PK", "BAN"].includes(kindRaw)) return sendEphemeral(interaction, "Eroare", "Tip invalid (PK/BAN).");
    const existing = repo.getCooldown(ctx.db, userId, kindRaw);
    if (!existing || existing.expires_at <= now()) {
      return sendEphemeral(interaction, "Eroare", "Nu există un cooldown activ pentru acest user.");
    }
    const roleId = kindRaw === "PK" ? ctx.settings.pkRole : ctx.settings.banRole;
    if (!roleId) return sendEphemeral(interaction, "Config lipsă", `Rolul ${kindRaw} nu este setat în /famenu → Config → Roluri.`);
    const roleCheckRes = roleCheck(ctx, roleId, kindRaw.toLowerCase());
    if (!roleCheckRes.ok) return sendEphemeral(interaction, "Eroare", roleCheckRes.msg);
    const member = await ctx.guild.members.fetch(userId).catch(()=>null);
    if (member) {
      const removed = await safeRoleRemove(member, roleId, `Cooldown remove ${kindRaw} for ${userId}`);
      if (!removed) {
        return sendEphemeral(interaction, "Eroare", "Nu pot elimina rolul cooldown (permisiuni lipsă).");
      }
    }
    repo.clearCooldown(ctx.db, userId, kindRaw);
    await audit(ctx, "Cooldown șters", `User: <@${userId}> | Tip: **${kindRaw}** | De: <@${ctx.uid}>`);
    return sendEphemeral(interaction, "Cooldown șters", `User: <@${userId}> | Tip: **${kindRaw}**`);
  }

  // org add/remove/search
  if (id.endsWith(":add_modal")) {
    const orgId = Number(id.split(":")[1]);
    const users = parseUserIds(interaction.fields.getTextInputValue("users"));
    if (!users.length) return sendEphemeral(interaction, "Eroare", "Nu am găsit User ID-uri valide.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let ok=0, bad=0;
    const errors = [];
    for (const uid of users) {
      const m = await ctx.guild.members.fetch(uid).catch((err)=> {
        console.error(`[ADD] fetch member failed for ${uid}:`, err);
        return null;
      });
      if (!m) { bad++; errors.push("Nu pot găsi userul în guild."); continue; }
      const res = await addToOrg(ctx, m, orgId, "MEMBER");
      if (res.ok) ok++;
      else {
        bad++;
        if (res.msg) errors.push(res.msg);
      }
    }
    const note = bad > 0 && errors.length ? `\nMotiv principal: ${errors[0]}` : "";
    return interaction.editReply({ embeds: [makeEmbed("Rezultat", `Adăugați: **${ok}** | Eșuați: **${bad}**${note}`)] });
  }

  if (id.endsWith(":remove_modal") || id.endsWith(":remove_pk_modal")) {
    const parts = id.split(":");
    const orgId = Number(parts[1]);
    const pk = id.includes("remove_pk_modal");
    const users = parseUserIds(interaction.fields.getTextInputValue("users"));
    if (!users.length) return sendEphemeral(interaction, "Eroare", "Nu am găsit User ID-uri valide.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let ok=0, bad=0;
    const errors = [];
    for (const uid of users) {
      const m = await ctx.guild.members.fetch(uid).catch((err)=> {
        console.error(`[REMOVE] fetch member failed for ${uid}:`, err);
        return null;
      });
      if (!m) { bad++; errors.push("Nu pot găsi userul în guild."); continue; }
      const res = pk ? await applyPk(ctx, m, orgId, ctx.uid) : await removeFromOrg(ctx, m, orgId, ctx.uid);
      if (res.ok) ok++;
      else {
        bad++;
        if (res.msg) errors.push(res.msg);
      }
    }
    const note = bad > 0 && errors.length ? `\nMotiv principal: ${errors[0]}` : "";
    return interaction.editReply({ embeds: [makeEmbed("Rezultat", `Procesați: **${ok}** | Eșuați: **${bad}**${note}`)] });
  }

  if (id.endsWith(":search_modal")) {
    const orgId = Number(id.split(":")[1]);
    const user = parseUserIds(interaction.fields.getTextInputValue("user"))[0];
    if (!user) return sendEphemeral(interaction, "Eroare", "User ID invalid.");
    return searchResult(interaction, ctx, orgId, user);
  }

  if (id.endsWith(":setrank_modal")) {
    const orgId = Number(id.split(":")[1]);
    const user = parseUserIds(interaction.fields.getTextInputValue("user"))[0];
    const rankRaw = interaction.fields.getTextInputValue("rank")?.trim().toUpperCase();
    if (!user) return sendEphemeral(interaction, "Eroare", "User ID invalid.");
    if (!rankRaw) return sendEphemeral(interaction, "Eroare", "Rank invalid.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await ctx.guild.members.fetch(user).catch((err) => {
      console.error(`[RANK] fetch member failed for ${user}:`, err);
      return null;
    });
    if (!member) return interaction.editReply({ embeds: [makeEmbed("Eroare", "Nu pot găsi userul în guild.")] });
    const res = await setMemberRank(ctx, member, orgId, rankRaw);
    if (!res.ok) return interaction.editReply({ embeds: [makeEmbed("Eroare", res.msg || "Setarea rank-ului a eșuat.")] });
    return interaction.editReply({ embeds: [makeEmbed("Rank actualizat", `User: <@${user}> | Rank: **${rankRaw}**`)] });
  }

  return sendEphemeral(interaction, "Eroare", "Modal necunoscut.");
}

async function handleComponent(interaction, ctx) {
  const id = interaction.customId;

  if (interaction.isStringSelectMenu()) {
    if (id === "fmenu:pickorg") {
      const orgId = Number(interaction.values[0]);
      return orgPanelView(interaction, ctx, orgId);
    }
  }

  if (!interaction.isButton()) return;

  if (id.startsWith("fmenu:open:")) {
    const orgId = Number(id.split(":")[2]);
    return orgPanelView(interaction, ctx, orgId);
  }

  if (id === "fmenu:back") return fmenuHome(interaction, ctx);
  if (id === "famenu:back") return famenuHome(interaction, ctx);

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
  if (id === "famenu:cooldowns") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona cooldown-uri.");
    const view = cooldownsAdminView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }

  if (id === "famenu:config:roles") {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config.");
    const view = configAccessRolesView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }
  if (id === "famenu:config:channels") {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config.");
    const view = configChannelsView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }
  if (id === "famenu:config:ratelimit") {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config.");
    const view = configRateLimitView(ctx);
    return sendEphemeral(interaction, view.emb.data.title, view.emb.data.description, view.rows);
  }

  if (id === "famenu:reconcile_global") {
    if (!requireStaff(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar staff poate folosi această acțiune.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { members, retryMs } = await fetchMembersWithRetry(ctx.guild, "RECONCILE GLOBAL");
    if (!members) {
      const msg = retryMs > 0
        ? `Discord rate limit. Încearcă din nou în ~${Math.ceil(retryMs / 1000)}s.`
        : "Nu pot prelua membrii guild-ului.";
      return interaction.editReply({ embeds: [makeEmbed("Eroare", msg)] });
    }
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
    return showModalSafe(interaction, warnAddModalForm());
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
        const orgLabel = payload.org_role_id ? `<@&${payload.org_role_id}>` : (payload.org_name || `Org ${w.org_id || "-"}`);
        const exp = w.expires_at ? formatTs(w.expires_at) : "—";
        return `• \`${w.warn_id}\` | ${orgLabel} | Expiră: ${exp}`;
      }).join("\n")
      : "Nu există warn-uri active.";
    const emb = makeEmbed("⚠️ Warns active", desc);
    return sendEphemeral(interaction, emb.data.title, emb.data.description, rowsFromButtons([btn("famenu:back","Back",ButtonStyle.Secondary,"⬅️")]));
  }
  if (id === "famenu:cooldown_add") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona cooldown-uri.");
    return showModalSafe(interaction, cooldownAddModal());
  }
  if (id === "famenu:cooldown_remove") {
    if (!requireSupervisorOrOwner(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar supervisor/owner pot gestiona cooldown-uri.");
    return showModalSafe(interaction, cooldownRemoveModal());
  }

  if (id.startsWith("famenu:setrole:")) {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config.");
    const which = id.split(":")[2];
    return showModalSafe(interaction, setRoleModal(which));
  }
  if (id.startsWith("famenu:setchannel:")) {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config.");
    const which = id.split(":")[2];
    return showModalSafe(interaction, setChannelModal(which));
  }
  if (id === "famenu:setratelimit") {
    if (!requireConfigManager(ctx)) return sendEphemeral(interaction, "⛔ Acces refuzat", "Doar owner sau rolul de config.");
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

  if (id.startsWith("org:")) {
    const parts = id.split(":");
    const orgId = Number(parts[1]);
    const action = parts[2];

    if (action === "back") return orgPanelView(interaction, ctx, orgId);
    if (action === "add") return showModalSafe(interaction, addMembersModal(orgId));
    if (action === "remove") return showModalSafe(interaction, removeMembersModal(orgId, false));
    if (action === "remove_pk") return showModalSafe(interaction, removeMembersModal(orgId, true));
    if (action === "roster") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return rosterView(interaction, ctx, orgId, true);
    }
    if (action === "cooldowns") return cooldownsView(interaction, ctx, orgId);
    if (action === "search") return showModalSafe(interaction, searchModal(orgId));
    if (action === "setrank") return showModalSafe(interaction, setRankModal(orgId));
  }

  return sendEphemeral(interaction, "Eroare", "Acțiune necunoscută.");
}

export async function handleInteraction(interaction, client) {
  const ctx = getCtx(interaction);

  if (ctx.settings.botChannel && interaction.channelId && interaction.channelId !== ctx.settings.botChannel) {
    return sendEphemeral(interaction, "Canal restricționat", `Folosește botul doar în <#${ctx.settings.botChannel}>.`);
  }

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
}
